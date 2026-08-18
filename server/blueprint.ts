import { randomUUID } from 'node:crypto';
import type { ExamSet, ExamSlot, ImportAnalysis, NormalizedQuestion, QuestionType } from '../src/shared/types.js';
import { generateQuestion } from './providers/aiProvider.js';
import { finalizeListeningSlots, prepareListeningReference } from './listeningPipeline.js';
import { runQaForSet } from './qa.js';

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

export async function complete40QuestionSet(analysis: ImportAnalysis, name?: string): Promise<ExamSet> {
  const slots = createBlueprint(analysis, false);
  for (const slot of slots) {
    const chapter = chapterForSlot(slot.slot, analysis);
    const reference = analysis.questions.find(item => item.sourceOrder === slot.slot);
    const hasOwnedMedia = slot.section === 'listening' && !!reference?.media?.some(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video');
    const prepared = hasOwnedMedia && reference ? await prepareListeningReference(reference) : null;

    const question = await generateQuestion({
      slot: slot.slot,
      section: slot.section,
      expectedType: slot.expectedType,
      patternId: slot.patternId,
      chapter,
      sourceExamples: examplesFor(slot, analysis.questions),
      listeningContext: prepared?.transcript ?? null,
      mediaConstrained: hasOwnedMedia
    });

    if (slot.section === 'listening' && reference?.media?.length) {
      question.media = reference.media.filter(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video');
      question.provenance.sourceQuestionId = reference.id;
      question.provenance.sourceUrl = reference.provenance.sourceUrl;
      question.provenance.sourceTitle = reference.provenance.sourceTitle;
      if (prepared?.audioAsset) question.audioAsset = prepared.audioAsset;
      if (prepared?.flags.length) question.qaFlags = [...new Set([...question.qaFlags, ...prepared.flags])];
    }

    slot.question = question;
    slot.generationRequired = false;
  }

  await finalizeListeningSlots(slots);
  const qaSlots = runQaForSet(slots);
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
