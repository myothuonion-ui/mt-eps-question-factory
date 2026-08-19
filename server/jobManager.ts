import { randomUUID } from 'node:crypto';
import type { AgentName, GenerationJob, GenerationJobLog, GenerationJobStage, GenerationJobSummary } from '../src/shared/types.js';

const jobs = new Map<string, GenerationJob>();

export type ProgressEvent = {
  stage: GenerationJobStage;
  agent?: AgentName;
  percent?: number;
  question?: number | null;
  completedQuestions?: number;
  provider?: string;
  fallback?: boolean;
  level?: GenerationJobLog['level'];
  summary?: GenerationJobSummary;
  importId?: string | null;
  message: string;
};

export function createGenerationJob() {
  const now = new Date().toISOString();
  const job: GenerationJob = {
    id: `JOB-${randomUUID()}`,
    status: 'queued',
    percent: 0,
    stage: 'queued',
    currentAgent: 'Controller Agent',
    currentQuestion: null,
    completedQuestions: 0,
    totalQuestions: 40,
    provider: 'pending',
    fallbackCount: 0,
    summary: null,
    createdAt: now,
    updatedAt: now,
    logs: []
  };
  jobs.set(job.id, job);
  return structuredClone(job);
}

export function getGenerationJob(id: string) {
  const job = jobs.get(id);
  return job ? structuredClone(job) : null;
}

export function reportGenerationProgress(id: string, event: ProgressEvent) {
  const job = jobs.get(id);
  if (!job) return;
  const now = new Date().toISOString();
  job.status = event.stage === 'error' ? 'failed' : event.stage === 'done' ? 'completed' : 'running';
  job.stage = event.stage;
  if (event.agent) job.currentAgent = event.agent;
  if (event.percent !== undefined) job.percent = Math.max(job.percent, Math.min(100, Math.round(event.percent)));
  if (event.question !== undefined) job.currentQuestion = event.question;
  if (event.completedQuestions !== undefined) job.completedQuestions = event.completedQuestions;
  if (event.provider) job.provider = event.provider;
  if (event.summary) job.summary = event.summary;
  if (event.importId !== undefined) job.importId = event.importId;
  if (event.fallback && event.level === 'warn') job.fallbackCount += 1;
  job.updatedAt = now;
  const log: GenerationJobLog = {
    id: `LOG-${randomUUID()}`,
    at: now,
    level: event.level ?? (event.stage === 'error' ? 'error' : event.stage === 'done' ? 'success' : 'info'),
    stage: event.stage,
    agent: event.agent ?? job.currentAgent,
    question: event.question ?? null,
    message: event.message
  };
  job.logs.push(log);
  if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
}

export function finishGenerationJob(id: string, setId: string) {
  const job = jobs.get(id);
  if (!job) return;
  job.setId = setId;
  job.status = 'completed';
  job.stage = 'done';
  job.currentAgent = 'Controller Agent';
  job.percent = 100;
  job.completedQuestions = 40;
  job.currentQuestion = null;
  job.updatedAt = new Date().toISOString();
}

export function failGenerationJob(id: string, error: string) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.stage = 'error';
  job.currentAgent = 'Controller Agent';
  job.error = error;
  job.updatedAt = new Date().toISOString();
  reportGenerationProgress(id, { stage: 'error', agent: 'Controller Agent', percent: job.percent, question: job.currentQuestion, level: 'error', message: error });
}
