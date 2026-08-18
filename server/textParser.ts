import { createHash } from 'node:crypto';
import { classifyChapter, classifyType } from './analyzer.js';
import type { MediaRef, NormalizedQuestion } from '../src/shared/types.js';

function cleanLine(value: string) {
  return value.replace(/\u200b/g, '').replace(/\r/g, '').trim();
}

function stableId(sourceUrl: string, order: number, stem: string) {
  return createHash('sha256').update(`${sourceUrl}|${order}|${stem}`).digest('hex').slice(0, 16);
}

function optionMatch(line: string) {
  const circled = line.match(/^([①②③④⑤])\s*(.+)$/);
  if (circled) return { index: '①②③④⑤'.indexOf(circled[1]), text: circled[2].trim() };
  const numbered = line.match(/^([1-5])\s*[).．]\s*(.+)$/);
  if (numbered) return { index: Number(numbered[1]) - 1, text: numbered[2].trim() };
  return null;
}

function answerIndex(line: string) {
  const match = line.match(/(?:정답|answer|correct)\s*[:：]?\s*([1-4①②③④])/i);
  if (!match) return null;
  return '①②③④'.includes(match[1]) ? '①②③④'.indexOf(match[1]) : Number(match[1]) - 1;
}

export function parseQuestionsFromText(text: string, sourceUrl: string, sourceTitle: string, inheritedMedia: MediaRef[] = []) {
  const lines = text.split('\n').map(cleanLine).filter(Boolean);
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    const startsQuestion = /^\s*(?:문제\s*)?\d{1,3}\s*[.)．번]\s*/.test(line);
    if (startsQuestion && current.length) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);

  const questions: NormalizedQuestion[] = [];
  for (const block of blocks) {
    const optionRows = block.map(optionMatch).filter((item): item is { index: number; text: string } => !!item);
    if (optionRows.length < 2) continue;
    const firstOptionLine = block.findIndex(line => !!optionMatch(line));
    const stemLines = block.slice(0, firstOptionLine >= 0 ? firstOptionLine : block.length)
      .map(line => line.replace(/^\s*(?:문제\s*)?\d{1,3}\s*[.)．번]\s*/, '').trim())
      .filter(Boolean);
    const stem = stemLines.join(' ').trim();
    if (!stem) continue;
    const options = optionRows.sort((a, b) => a.index - b.index).slice(0, 4).map(item => item.text);
    let correctAnswerIndex: number | null = null;
    for (const line of block) {
      const found = answerIndex(line);
      if (found !== null) correctAnswerIndex = found;
    }
    const combined = `${stem} ${options.join(' ')}`;
    const media = [...inheritedMedia];
    const type = classifyType(stem, options.join(' '), media.some(item => item.kind === 'youtube' || item.kind === 'audio'), media.some(item => item.kind === 'image'));
    const chapter = classifyChapter(combined);
    const order = questions.length + 1;
    const qaFlags: string[] = [];
    if (options.length !== 4) qaFlags.push(`OPTIONS_${options.length}`);
    if (correctAnswerIndex === null) qaFlags.push('ANSWER_NOT_DETECTED');
    if (!chapter.chapter || chapter.confidence < 0.6) qaFlags.push('CHAPTER_LOW_CONFIDENCE');
    questions.push({
      id: stableId(sourceUrl, order, stem),
      sourceOrder: order,
      stem,
      options,
      correctAnswerIndex,
      answerEvidence: correctAnswerIndex === null ? null : `Parsed answer ${correctAnswerIndex + 1}`,
      type,
      chapter,
      media,
      qaFlags,
      origin: 'imported',
      revision: 1,
      reviewState: 'not_reviewed',
      provenance: { sourceUrl, sourceTitle }
    });
  }
  return questions;
}
