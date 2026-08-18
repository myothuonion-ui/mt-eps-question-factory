import type { ExamSlot, NormalizedQuestion, QaResult } from '../src/shared/types.js';

function tokens(text: string) {
  return new Set(text.toLowerCase().replace(/[^0-9a-z가-힣\s]/g, ' ').split(/\s+/).filter(Boolean));
}

function similarity(a: string, b: string) {
  const aa = tokens(a);
  const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

function basicQa(question: NormalizedQuestion): QaResult {
  const checks: Record<string, boolean> = {
    stem: question.stem.trim().length >= 3,
    fourOptions: question.options.length === 4,
    nonEmptyOptions: question.options.length === 4 && question.options.every(option => option.trim().length > 0),
    uniqueOptions: new Set(question.options.map(option => option.trim())).size === question.options.length,
    answer: question.correctAnswerIndex !== null && question.correctAnswerIndex >= 0 && question.correctAnswerIndex < question.options.length,
    chapter: !!question.chapter.chapter && question.chapter.chapter >= 1 && question.chapter.chapter <= 60,
    listeningScript: question.type !== 'listening' || !!question.listeningScript?.length || question.media.some(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video'),
    audioReady: question.type !== 'listening' || !!question.audioAsset
  };
  const flags = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => `QA_${name.toUpperCase()}`);
  const score = Math.round((Object.values(checks).filter(Boolean).length / Object.keys(checks).length) * 100);
  return { passed: flags.length === 0, score, flags, checks };
}

export function runQaForSet(slots: ExamSlot[]) {
  const populated = slots.flatMap(slot => slot.question ? [slot.question] : []);
  return slots.map(slot => {
    if (!slot.question) return slot;
    const qa = basicQa(slot.question);
    const duplicate = populated.some(other => other.id !== slot.question!.id && similarity(`${slot.question!.stem} ${slot.question!.options.join(' ')}`, `${other.stem} ${other.options.join(' ')}`) >= 0.86);
    const flags = [...qa.flags, ...(duplicate ? ['QA_POSSIBLE_DUPLICATE'] : [])];
    const merged = {
      ...qa,
      passed: qa.passed && !duplicate,
      score: Math.max(0, qa.score - (duplicate ? 15 : 0)),
      flags,
      checks: { ...qa.checks, duplicateFree: !duplicate }
    };
    return {
      ...slot,
      question: {
        ...slot.question,
        qa: merged,
        qaFlags: [...new Set([...(slot.question.qaFlags ?? []), ...flags])]
      }
    };
  });
}

export function qaQuestion(question: NormalizedQuestion, peers: NormalizedQuestion[] = []) {
  const qa = basicQa(question);
  const duplicate = peers.some(other => other.id !== question.id && similarity(`${question.stem} ${question.options.join(' ')}`, `${other.stem} ${other.options.join(' ')}`) >= 0.86);
  const flags = [...qa.flags, ...(duplicate ? ['QA_POSSIBLE_DUPLICATE'] : [])];
  return {
    ...question,
    qa: { ...qa, passed: qa.passed && !duplicate, flags, checks: { ...qa.checks, duplicateFree: !duplicate } },
    qaFlags: [...new Set([...(question.qaFlags ?? []), ...flags])]
  };
}
