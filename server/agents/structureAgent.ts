import type { ExamSection, GenerationJobSummary, ImportAnalysis } from '../../src/shared/types.js';
import type { ProgressEvent } from '../jobManager.js';

function transitions(plan: ExamSection[]) {
  return plan.filter((section, index) => index === 0 || section !== plan[index - 1]);
}

function makeStandardPlan(): ExamSection[] {
  return Array.from({ length: 40 }, (_, index) => index < 20 ? 'reading' : 'listening');
}

export function runStructureAgent(input: ImportAnalysis, report?: (event: ProgressEvent) => void): { analysis: ImportAnalysis; summary: GenerationJobSummary } {
  const analysis: ImportAnalysis = structuredClone(input);
  const ordered = [...analysis.questions].sort((a, b) => a.sourceOrder - b.sourceOrder);
  const detectedPlan = ordered.slice(0, 40).map(question => question.section).filter((section): section is ExamSection => section === 'reading' || section === 'listening');
  const detectedTransitions = transitions(detectedPlan);
  const detectedReading = ordered.filter(question => question.section === 'reading').length;
  const detectedListening = ordered.filter(question => question.section === 'listening').length;

  report?.({
    stage: 'structure', agent: 'Structure Agent', percent: 14, question: null,
    message: `Checking actual Form order. Detected section flow: ${detectedTransitions.length ? detectedTransitions.join(' → ') : 'unknown'}.`
  });

  let sectionPlan = analysis.sectionPlan?.slice(0, 40) ?? [];
  const trustworthy = sectionPlan.length === 40 && sectionPlan.filter(section => section === 'reading').length === 20 && sectionPlan.filter(section => section === 'listening').length === 20;

  if (!trustworthy) {
    // EPS-TOPIK target is 20 Reading + 20 Listening. The source Form supplied by the teacher is Reading first,
    // followed by the listening video/source and Listening questions. This is used only when structural recovery
    // cannot prove all 40 positions from headings/DOM order.
    sectionPlan = makeStandardPlan();
    report?.({
      stage: 'structure', agent: 'Structure Agent', percent: 16, question: null, level: 'warn',
      message: `Source section counts were Reading ${detectedReading} / Listening ${detectedListening}; normalizing the final blueprint to Reading 20 → Listening 20 while keeping source-order evidence and flags.`
    });
  } else {
    report?.({
      stage: 'structure', agent: 'Structure Agent', percent: 16, question: null, level: 'success',
      message: 'Verified 40-slot source structure: Reading 20 → Listening 20.'
    });
  }

  analysis.sectionPlan = sectionPlan;
  ordered.forEach((question, index) => {
    if (index >= 40) return;
    const expected = sectionPlan[index];
    if (question.section !== expected) {
      question.qaFlags = [...new Set([...question.qaFlags, `STRUCTURE_AGENT_SECTION:${question.section ?? 'unknown'}→${expected}`])];
      question.section = expected;
      question.sectionLabel = question.sectionLabel || 'Structure Agent normalized EPS order';
      question.sectionConfidence = Math.max(question.sectionConfidence ?? 0, trustworthy ? 0.9 : 0.65);
    }
    if (expected === 'listening') question.type = 'listening';
    if (expected === 'reading' && question.type === 'listening') question.type = 'reading';
  });
  analysis.questions = ordered;
  analysis.counts.reading = ordered.filter(question => question.section === 'reading').length;
  analysis.counts.listening = ordered.filter(question => question.section === 'listening').length;

  const summary: GenerationJobSummary = {
    references: analysis.counts.questions,
    reading: 20,
    listening: 20,
    youtube: analysis.counts.youtube,
    answers: analysis.counts.answersDetected,
    sectionOrder: ['reading', 'listening'],
    sectionSource: trustworthy ? analysis.diagnostics?.sectionSource ?? 'Form structure' : 'Structure Agent normalized 20+20'
  };

  report?.({
    stage: 'structure', agent: 'Structure Agent', percent: 18, question: null, level: 'success', summary,
    message: `Blueprint locked: Reading Q1–Q20, then Listening Q21–Q40. YouTube placement is used to attach the listening source, not to reclassify earlier Reading questions.`
  });
  return { analysis, summary };
}
