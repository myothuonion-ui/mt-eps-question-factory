import { randomUUID } from 'node:crypto';
import type { ExamSet, ExamSlot, ImportAnalysis, NormalizedQuestion, QuestionType } from '../src/shared/types.js';
import { generateQuestionBatch, type GenerationSpec } from './providers/aiProvider.js';
import { finalizeListeningSlots, prepareListeningReferences } from './listeningPipeline.js';
import { runQaForSet } from './qa.js';
import { getProviderSettings } from './providerSettings.js';
import type { ProgressEvent } from './jobManager.js';

function defaultReadingType(slot: number): QuestionType {
  const index = slot - 20;
  if (index <= 5) return 'vocabulary';
  if (index <= 10) return 'blank';
  if (index <= 14) return 'grammar';
  return 'reading';
}

export function createBlueprint(analysis?: ImportAnalysis | null, includeImportedQuestions = true): ExamSlot[] {
  const ordered = [...(analysis?.questions ?? [])].sort((a, b) => a.sourceOrder - b.sourceOrder);
  return Array.from({ length: 40 }, (_, index) => {
    const slot = index + 1;
    const source = ordered[index] ?? null;
    const section = slot <= 20 ? 'listening' : 'reading';
    const expectedType: QuestionType = source?.type && source.type !== 'unknown'
      ? source.type
      : section === 'listening' ? 'listening' : defaultReadingType(slot);
    const patternId = `${section === 'listening' ? 'L' : 'R'}${String(section === 'listening' ? slot : slot - 20).padStart(2, '0')}`;
    const imported = includeImportedQuestions && source
      ? { ...source, patternId, origin: source.origin ?? 'imported' as const, reviewState: source.reviewState ?? 'not_reviewed' as const, revision: source.revision ?? 1 }
      : null;
    return { slot, section, patternId, expectedType, question: imported, generationRequired: !imported } satisfies ExamSlot;
  });
}

function chapterForSlot(slot: number, analysis: ImportAnalysis) {
  const selected = (analysis.generationChapters ?? []).filter(chapter => Number.isInteger(chapter) && chapter >= 1 && chapter <= 60);
  if (selected.length) return selected[(slot - 1) % selected.length];
  const sourceChapter = analysis.questions.find(question => question.sourceOrder === slot)?.chapter.chapter;
  if (sourceChapter) return sourceChapter;
  const known = analysis.questions.map(question => question.chapter.chapter).filter((value): value is number => !!value);
  if (known.length) return known[(slot - 1) % known.length];
  return ((slot - 1) % 60) + 1;
}

function examplesFor(slot: ExamSlot, questions: NormalizedQuestion[]) {
  const exact = questions.find(q => q.sourceOrder === slot.slot);
  const sameType = questions.filter(q => q.type === slot.expectedType);
  const sameSection = questions.filter(q => slot.section === 'listening' ? q.type === 'listening' : q.type !== 'listening');
  return [exact, ...sameType, ...sameSection]
    .filter((q): q is NormalizedQuestion => !!q)
    .filter((q, i, arr) => arr.findIndex(item => item.id === q.id) === i)
    .slice(0, 5);
}

type Reporter = (event: ProgressEvent) => void;

export async function complete40QuestionSet(analysis: ImportAnalysis, name?: string, report?: Reporter): Promise<ExamSet> {
  const slots = createBlueprint(analysis, false);
  const specs: GenerationSpec[] = [];
  report?.({ stage: 'prepare', percent: 2, question: null, completedQuestions: 0, message: `Preparing 40 slots from ${analysis.questions.length} analyzed source questions.` });

  const listeningReferences = analysis.questions
    .filter(question => question.sourceOrder <= 20)
    .filter(question => question.media?.some(item => item.kind === 'youtube'));
  const uniqueYoutubeCount = new Set(listeningReferences.flatMap(question => question.media.filter(item => item.kind === 'youtube').map(item => item.url))).size;
  const preparedByReference = listeningReferences.length
    ? await prepareListeningReferences(listeningReferences, (question, message, level = 'info') => {
        report?.({
          stage: 'prepare',
          percent: 3 + ((question ?? 1) / 20) * 7,
          question,
          completedQuestions: 0,
          level,
          message
        });
      })
    : new Map();

  if (listeningReferences.length) {
    report?.({
      stage: 'prepare',
      percent: 10,
      question: null,
      completedQuestions: 0,
      level: 'success',
      message: `Hybrid listening preparation finished for ${uniqueYoutubeCount} unique YouTube source(s); cached results will be reused across Q1–Q20.`
    });
  }

  for (const slot of slots) {
    const chapter = chapterForSlot(slot.slot, analysis);
    const reference = analysis.questions.find(item => item.sourceOrder === slot.slot);
    const hasOwnedMedia = slot.section === 'listening' && !!reference?.media?.some(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video');
    report?.({ stage: 'prepare', percent: 10, question: slot.slot, completedQuestions: 0, message: `Q${slot.slot}: pattern ${slot.patternId}, Chapter ${chapter}, ${slot.expectedType}.` });
    const prepared = reference ? preparedByReference.get(reference.id) ?? null : null;
    specs.push({
      slot: slot.slot,
      section: slot.section,
      expectedType: slot.expectedType,
      patternId: slot.patternId,
      chapter,
      sourceExamples: examplesFor(slot, analysis.questions),
      listeningContext: prepared?.transcript ?? null,
      mediaConstrained: hasOwnedMedia
    });
  }

  const batchSize = getProviderSettings().batchSize;
  let completed = 0;
  for (let start = 0; start < specs.length; start += batchSize) {
    const batch = specs.slice(start, start + batchSize);
    const qStart = batch[0].slot;
    const qEnd = batch[batch.length - 1].slot;
    report?.({ stage: 'generation', percent: 10 + (completed / 40) * 60, question: qStart, completedQuestions: completed, message: `Generating Q${qStart}–Q${qEnd} as one API batch (${Math.ceil((start + 1) / batchSize)}/${Math.ceil(40 / batchSize)}).` });
    const generated = await generateQuestionBatch(batch, attempt => {
      report?.({
        stage: 'generation',
        percent: 10 + (completed / 40) * 60,
        question: qStart,
        completedQuestions: completed,
        provider: attempt.provider,
        fallback: attempt.fallback,
        level: attempt.level,
        message: attempt.message
      });
    });

    for (let i = 0; i < generated.length; i += 1) {
      const question = generated[i];
      const spec = batch[i];
      const slot = slots[spec.slot - 1];
      const reference = analysis.questions.find(item => item.sourceOrder === spec.slot);
      const prepared = reference ? preparedByReference.get(reference.id) ?? null : null;
      if (slot.section === 'listening' && reference?.media?.length) {
        question.media = reference.media.filter(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video');
        question.provenance.sourceQuestionId = reference.id;
        question.provenance.sourceUrl = reference.provenance.sourceUrl;
        question.provenance.sourceTitle = reference.provenance.sourceTitle;
        if (prepared?.audioAsset) question.audioAsset = prepared.audioAsset;
        if (prepared?.flags.length) question.qaFlags = [...new Set([...question.qaFlags, ...prepared.flags])];
        if (!question.listeningScript?.length && prepared?.transcript) {
          question.listeningScript = [{ speaker: 'narrator', text: prepared.transcript.slice(0, 1800) }];
          question.qaFlags = [...new Set([...question.qaFlags, 'TTS_FALLBACK_SCRIPT_FROM_SOURCE_TRANSCRIPT'])];
        }
      }
      slot.question = question;
      slot.generationRequired = false;
      completed += 1;
      report?.({ stage: 'generation', percent: 10 + (completed / 40) * 60, question: spec.slot, completedQuestions: completed, provider: question.generatedBy ?? 'unknown', level: 'success', message: `Q${spec.slot}: generated successfully with ${question.generatedBy ?? 'AI'}.` });
    }
  }

  report?.({ stage: 'listening', percent: 72, question: 1, completedQuestions: 40, message: 'Finalizing listening audio for Q1–Q20. Prepared source clips are reused; TTS is fallback only.' });
  await finalizeListeningSlots(slots, (question, message, level = 'info') => {
    const percent = 72 + (Math.min(20, Math.max(1, question)) / 20) * 15;
    report?.({ stage: 'listening', percent, question, completedQuestions: 40, level, message });
  });

  report?.({ stage: 'qa', percent: 88, question: null, completedQuestions: 40, message: 'Running answer, structure and duplicate QA across all 40 questions.' });
  const qaSlots = runQaForSet(slots);
  qaSlots.forEach((slot, index) => {
    report?.({ stage: 'qa', percent: 88 + ((index + 1) / 40) * 8, question: slot.slot, completedQuestions: 40, level: slot.question?.qa?.passed ? 'success' : 'warn', message: `Q${slot.slot}: QA ${slot.question?.qa?.score ?? 0}%${slot.question?.qaFlags?.length ? ` · ${slot.question.qaFlags.join(', ')}` : ''}.` });
  });

  return {
    id: `SET-${Date.now()}-${randomUUID().slice(0, 6)}`,
    name: name?.trim() || `EPS 40Q ${new Date().toLocaleDateString('en-CA')}`,
    sourceImportId: analysis.id ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    slots: qaSlots,
    complete: qaSlots.every(slot => !!slot.question),
    qaCompleted: true,
    published: false,
    reviewOptional: true
  };
}

export function buildStructureOnly(analysis: ImportAnalysis): ExamSet {
  const slots = createBlueprint(analysis, true);
  return {
    id: `SET-${Date.now()}-${randomUUID().slice(0, 6)}`,
    sourceImportId: analysis.id ?? null,
    createdAt: new Date().toISOString(),
    slots,
    complete: slots.every(slot => !!slot.question),
    qaCompleted: false,
    published: false,
    reviewOptional: true
  };
}
