import { randomUUID } from 'node:crypto';
import type { ExamSet, ExamSlot, ImportAnalysis, NormalizedQuestion, QuestionType } from '../src/shared/types.js';
import { generateQuestion } from './providers/aiProvider.js';
import { finalizeListeningSlots } from './listeningPipeline.js';
import { runQaForSet } from './qa.js';

function defaultReadingType(slot: number): QuestionType {
  const index = slot - 20;
  if (index <= 5) return 'vocabulary';
  if (index <= 10) return 'blank';
  if (index <= 14) return 'grammar';
  return 'reading';
}

export function createBlueprint(analysis?: ImportAnalysis | null): ExamSlot[] {
  const ordered = [...(analysis?.questions ?? [])].sort((a, b) => a.sourceOrder - b.sourceOrder);
  return Array.from({ length: 40 }, (_, index) => {
    const slot = index + 1;
    const source = ordered[index] ?? null;
    const section = slot <= 20 ? 'listening' : 'reading';
    const expectedType: QuestionType = source?.type && source.type !== 'unknown'
      ? source.type
      : section === 'listening' ? 'listening' : defaultReadingType(slot);
    return {
      slot,
      section,
      patternId: `${section === 'listening' ? 'L' : 'R'}${String(section === 'listening' ? slot : slot - 20).padStart(2, '0')}`,
      expectedType,
      question: source ? { ...source, patternId: `${section === 'listening' ? 'L' : 'R'}${String(section === 'listening' ? slot : slot - 20).padStart(2, '0')}`, origin: source.origin ?? 'imported', reviewState: source.reviewState ?? 'not_reviewed', revision: source.revision ?? 1 } : null,
      generationRequired: !source
    } satisfies ExamSlot;
  });
}

function chapterForSlot(slot: number, questions: NormalizedQuestion[]) {
  const sourceChapter = questions.find(question => question.sourceOrder === slot)?.chapter.chapter;
  if (sourceChapter) return sourceChapter;
  const known = questions.map(question => question.chapter.chapter).filter((value): value is number => !!value);
  if (known.length) return known[(slot - 1) % known.length];
  return ((slot - 1) % 60) + 1;
}

function examplesFor(slot: ExamSlot, questions: NormalizedQuestion[]) {
  const sameType = questions.filter(q => q.type === slot.expectedType);
  const sameSection = questions.filter(q => slot.section === 'listening' ? q.type === 'listening' : q.type !== 'listening');
  return [...sameType, ...sameSection].filter((q, i, arr) => arr.findIndex(item => item.id === q.id) === i).slice(0, 5);
}

export async function complete40QuestionSet(analysis: ImportAnalysis, name?: string): Promise<ExamSet> {
  const slots = createBlueprint(analysis);
  for (const slot of slots) {
    if (slot.question) continue;
    const chapter = chapterForSlot(slot.slot, analysis.questions);
    const question = await generateQuestion({
      slot: slot.slot,
      section: slot.section,
      expectedType: slot.expectedType,
      patternId: slot.patternId,
      chapter,
      sourceExamples: examplesFor(slot, analysis.questions)
    });
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
  const slots = createBlueprint(analysis);
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
