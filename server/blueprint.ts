import { randomUUID } from 'node:crypto';
import type { ExamSection, ExamSet, ExamSlot, ImportAnalysis, NormalizedQuestion, QuestionType } from '../src/shared/types.js';
import { generateQuestionBatch, type GenerationSpec } from './providers/aiProvider.js';
import { finalizeListeningSlots, prepareListeningReferences } from './listeningPipeline.js';
import { runQaForSet } from './qa.js';
import { runSemanticQaAgent } from './agents/semanticQaAgent.js';
import { getProviderSettings } from './providerSettings.js';
import type { ProgressEvent } from './jobManager.js';

function defaultReadingType(readingIndex: number): QuestionType {
  if (readingIndex <= 5) return 'vocabulary';
  if (readingIndex <= 10) return 'blank';
  if (readingIndex <= 14) return 'grammar';
  return 'reading';
}

function standardSectionPlan(): ExamSection[] {
  return Array.from({ length: 40 }, (_, index) => index < 20 ? 'reading' : 'listening');
}

function resolvedSectionPlan(analysis?: ImportAnalysis | null) {
  const plan = analysis?.sectionPlan?.slice(0, 40) ?? [];
  if (plan.length === 40 && plan.every(section => section === 'reading' || section === 'listening')) return plan;
  return standardSectionPlan();
}

export function createBlueprint(analysis?: ImportAnalysis | null, includeImportedQuestions = true): ExamSlot[] {
  const ordered = [...(analysis?.questions ?? [])].sort((a, b) => a.sourceOrder - b.sourceOrder);
  const plan = resolvedSectionPlan(analysis);
  let readingIndex = 0;
  let listeningIndex = 0;

  return Array.from({ length: 40 }, (_, index) => {
    const slot = index + 1;
    const source = ordered[index] ?? null;
    const section = plan[index];
    if (section === 'reading') readingIndex += 1;
    else listeningIndex += 1;
    const sectionIndex = section === 'reading' ? readingIndex : listeningIndex;
    const expectedType: QuestionType = section === 'listening'
      ? 'listening'
      : source?.type && !['unknown', 'listening'].includes(source.type)
        ? source.type
        : defaultReadingType(sectionIndex);
    const patternId = `${section === 'listening' ? 'L' : 'R'}${String(sectionIndex).padStart(2, '0')}`;
    const imported = includeImportedQuestions && source
      ? {
          ...source,
          section,
          type: expectedType,
          patternId,
          origin: source.origin ?? 'imported' as const,
          reviewState: source.reviewState ?? 'not_reviewed' as const,
          revision: source.revision ?? 1
        }
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
  const sameSection = questions.filter(q => (q.section ?? (q.type === 'listening' ? 'listening' : 'reading')) === slot.section);
  return [exact, ...sameType, ...sameSection]
    .filter((q): q is NormalizedQuestion => !!q)
    .filter((q, i, arr) => arr.findIndex(item => item.id === q.id) === i)
    .slice(0, 5);
}

type Reporter = (event: ProgressEvent) => void;

export async function complete40QuestionSet(analysis: ImportAnalysis, name?: string, report?: Reporter): Promise<ExamSet> {
  const slots = createBlueprint(analysis, false);
  const specs: GenerationSpec[] = [];
  report?.({
    stage: 'prepare', agent: 'Controller Agent', percent: 19, question: null, completedQuestions: 0,
    message: `Preparing 40 slots from ${analysis.questions.length} source reference(s): Reading ${slots.filter(s => s.section === 'reading').length} → Listening ${slots.filter(s => s.section === 'listening').length}.`
  });

  const listeningReferences = analysis.questions
    .filter(question => (question.section ?? (question.type === 'listening' ? 'listening' : 'reading')) === 'listening')
    .filter(question => question.media?.some(item => item.kind === 'youtube'));
  const uniqueYoutubeCount = new Set(listeningReferences.flatMap(question => question.media.filter(item => item.kind === 'youtube').map(item => item.url))).size;

  const preparedByReference = listeningReferences.length
    ? await prepareListeningReferences(listeningReferences, (question, message, level = 'info', agent = 'Media Agent') => {
        report?.({
          stage: 'prepare', agent, percent: 20 + ((Math.max(1, question ?? 21) - 20) / 20) * 20,
          question, completedQuestions: 0, level, message
        });
      })
    : new Map();

  if (listeningReferences.length) {
    report?.({
      stage: 'prepare', agent: 'Media Agent', percent: 40, question: null, completedQuestions: 0, level: 'success',
      message: `Listening preparation finished for ${uniqueYoutubeCount} unique YouTube source(s). Video/caption results are cached and reused across Listening questions.`
    });
  } else {
    report?.({
      stage: 'prepare', agent: 'Media Agent', percent: 40, question: null, completedQuestions: 0, level: 'warn',
      message: 'No per-question YouTube source was attached after Form analysis. Listening questions will use generated scripts/TTS and keep a QA flag for missing source grounding.'
    });
  }

  for (const slot of slots) {
    const chapter = chapterForSlot(slot.slot, analysis);
    const reference = analysis.questions.find(item => item.sourceOrder === slot.slot);
    const hasOwnedMedia = slot.section === 'listening' && !!reference?.media?.some(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video');
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
    report?.({
      stage: 'generation', agent: 'Generator Agent', percent: 41 + (completed / 40) * 35,
      question: qStart, completedQuestions: completed,
      message: `Generating Q${qStart}–Q${qEnd} as one API batch (${Math.floor(start / batchSize) + 1}/${Math.ceil(40 / batchSize)}).`
    });
    const generated = await generateQuestionBatch(batch, attempt => {
      report?.({
        stage: 'generation', agent: 'Generator Agent', percent: 41 + (completed / 40) * 35,
        question: qStart, completedQuestions: completed, provider: attempt.provider,
        fallback: attempt.fallback, level: attempt.level, message: attempt.message
      });
    });

    for (let i = 0; i < generated.length; i += 1) {
      const question = generated[i];
      const spec = batch[i];
      const slot = slots[spec.slot - 1];
      const reference = analysis.questions.find(item => item.sourceOrder === spec.slot);
      const prepared = reference ? preparedByReference.get(reference.id) ?? null : null;
      question.section = slot.section;
      question.type = slot.expectedType;
      if (slot.section === 'listening' && reference?.media?.length) {
        question.media = reference.media.filter(item => item.kind === 'youtube' || item.kind === 'audio' || item.kind === 'video');
        question.provenance.sourceQuestionId = reference.id;
        question.provenance.sourceUrl = reference.provenance.sourceUrl;
        question.provenance.sourceTitle = reference.provenance.sourceTitle;
        if (prepared?.audioAsset) question.audioAsset = prepared.audioAsset;
        if (prepared?.transcript && !question.listeningScript?.length) {
          question.listeningScript = [{ speaker: 'narrator', text: prepared.transcript }];
          question.qaFlags = [...new Set([...question.qaFlags, 'GROUNDED_TRANSCRIPT_TTS_FALLBACK'])];
        }
        if (prepared?.flags.length) question.qaFlags = [...new Set([...question.qaFlags, ...prepared.flags])];
      }
      slot.question = question;
      slot.generationRequired = false;
      completed += 1;
      report?.({
        stage: 'generation', agent: 'Generator Agent', percent: 41 + (completed / 40) * 35,
        question: spec.slot, completedQuestions: completed, provider: question.generatedBy ?? 'unknown', level: 'success',
        message: `Q${spec.slot} ${slot.section === 'reading' ? 'Reading' : 'Listening'}: generated with ${question.generatedBy ?? 'AI'}.`
      });
    }
  }

  const listeningSlots = slots.filter(slot => slot.section === 'listening');
  report?.({
    stage: 'listening', agent: 'Media Agent', percent: 78, question: listeningSlots[0]?.slot ?? null, completedQuestions: 40,
    message: `Finalizing audio for ${listeningSlots.length} Listening question(s). Prepared source clips are preferred; grounded TTS is fallback.`
  });
  let audioProgress = 0;
  await finalizeListeningSlots(slots, (question, message, level = 'info', agent = 'Media Agent') => {
    audioProgress += level === 'success' ? 1 : 0;
    const percent = 78 + (Math.min(listeningSlots.length, Math.max(1, audioProgress || 1)) / Math.max(1, listeningSlots.length)) * 10;
    report?.({ stage: 'listening', agent, percent, question, completedQuestions: 40, level, message });
  });

  report?.({
    stage: 'qa', agent: 'QA Agent', percent: 89, question: null, completedQuestions: 40,
    message: 'Running independent semantic QA: correct answer, ambiguity, Korean naturalness, section fit and explanation consistency.'
  });
  const semanticSlots = await runSemanticQaAgent(slots, event => {
    report?.({ ...event, percent: Math.max(89, Math.min(94, event.percent ?? 92)), completedQuestions: 40 });
  });

  report?.({
    stage: 'qa', agent: 'QA Agent', percent: 95, question: null, completedQuestions: 40,
    message: 'Running deterministic final checks: four choices, answer index, chapter, section/type, audio readiness and duplicate similarity.'
  });
  const qaSlots = runQaForSet(semanticSlots);
  qaSlots.forEach((slot, index) => {
    report?.({
      stage: 'qa', agent: 'QA Agent', percent: 95 + ((index + 1) / 40) * 3,
      question: slot.slot, completedQuestions: 40,
      level: slot.question?.qa?.passed ? 'success' : 'warn',
      message: `Q${slot.slot}: final QA ${slot.question?.qa?.score ?? 0}%${slot.question?.qaFlags?.length ? ` · ${slot.question.qaFlags.join(', ')}` : ''}.`
    });
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
