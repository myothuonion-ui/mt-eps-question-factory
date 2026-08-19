import { importGoogleFormViewScore } from '../formParser.js';
import type { ImportAnalysis } from '../../src/shared/types.js';
import type { ProgressEvent } from '../jobManager.js';

export async function runFormAgent(url: string, report?: (event: ProgressEvent) => void): Promise<ImportAnalysis> {
  report?.({
    stage: 'form', agent: 'Form Agent', percent: 2, question: null,
    message: 'Fetching the answered Google Form score page and reading DOM order, question blocks, answers, images and embedded YouTube sources.'
  });
  const analysis = await importGoogleFormViewScore(url);
  report?.({
    stage: 'form', agent: 'Form Agent', percent: 12, question: null, level: 'success',
    message: `Form parsed: ${analysis.counts.questions} question reference(s), ${analysis.counts.answersDetected} answer(s), ${analysis.counts.youtube} YouTube source(s), ${analysis.counts.images} image(s).`
  });
  for (const warning of analysis.diagnostics?.warnings ?? []) {
    report?.({ stage: 'form', agent: 'Form Agent', percent: 12, question: null, level: 'warn', message: warning });
  }
  return analysis;
}
