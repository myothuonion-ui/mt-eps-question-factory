import type { ImportAnalysis } from '../../src/shared/types.js';
import type { ProgressEvent } from '../jobManager.js';
import { complete40QuestionSet } from '../blueprint.js';
import { saveImport, saveSet } from '../store.js';
import { runFormAgent } from './formAgent.js';
import { runStructureAgent } from './structureAgent.js';

export type ControllerResult = {
  analysis: ImportAnalysis;
  setId: string;
};

export async function runControllerAgent(
  url: string,
  name?: string,
  report?: (event: ProgressEvent) => void
): Promise<ControllerResult> {
  report?.({
    stage: 'form', agent: 'Controller Agent', percent: 1, question: null,
    message: 'Controller Agent started. Order: Form → Structure → Media/Alignment → Generator → QA → Save.'
  });

  const parsed = await runFormAgent(url, report);
  const { analysis: structured, summary } = runStructureAgent(parsed, report);
  const savedImport = await saveImport({
    ...structured,
    questions: structured.questions.map(question => ({
      ...question,
      origin: 'imported' as const,
      revision: question.revision ?? 1,
      reviewState: question.reviewState ?? 'not_reviewed' as const
    }))
  });

  report?.({
    stage: 'structure', agent: 'Controller Agent', percent: 18, question: null,
    importId: savedImport.id ?? null, summary,
    message: `Source snapshot saved locally. Controller is handing Reading/Listening plan to Media, Alignment and Generator agents.`
  });

  const set = await complete40QuestionSet(savedImport, name, report);
  report?.({
    stage: 'save', agent: 'Controller Agent', percent: 98, question: null, completedQuestions: 40,
    message: 'All agents finished. Saving the complete 40-question set locally; review remains optional.'
  });
  const savedSet = await saveSet(set);
  report?.({
    stage: 'done', agent: 'Controller Agent', percent: 100, question: null, completedQuestions: 40, level: 'success',
    message: `40/40 complete: Reading 20 + Listening 20. Set ${savedSet.id} is ready.`
  });
  return { analysis: savedImport, setId: savedSet.id };
}
