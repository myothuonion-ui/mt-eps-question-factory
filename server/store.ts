import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExamSet, ImportAnalysis, NormalizedQuestion, QuestionRevision, VoiceProfile } from '../src/shared/types.js';

const DATA_ROOT = path.resolve(process.env.FACTORY_DATA_DIR ?? path.join(process.cwd(), 'data'));
export const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
export const MEDIA_DIR = path.join(DATA_ROOT, 'media');
export const TTS_DIR = path.join(DATA_ROOT, 'tts');

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(DATA_ROOT, { recursive: true }),
    fs.mkdir(UPLOAD_DIR, { recursive: true }),
    fs.mkdir(MEDIA_DIR, { recursive: true }),
    fs.mkdir(TTS_DIR, { recursive: true })
  ]);
}

async function readCollection<T>(name: string): Promise<T[]> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(path.join(DATA_ROOT, `${name}.json`), 'utf8');
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeCollection<T>(name: string, value: T[]) {
  await ensureDirs();
  const target = path.join(DATA_ROOT, `${name}.json`);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, target);
}

export async function saveImport(analysis: ImportAnalysis) {
  const items = await readCollection<ImportAnalysis>('imports');
  const id = analysis.id ?? `IMP-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const saved = { ...analysis, id };
  items.unshift(saved);
  await writeCollection('imports', items.slice(0, 200));
  return saved;
}

export async function listImports() {
  return readCollection<ImportAnalysis>('imports');
}

export async function saveSet(set: ExamSet) {
  const items = await readCollection<ExamSet>('sets');
  const index = items.findIndex(item => item.id === set.id);
  const saved = { ...set, updatedAt: new Date().toISOString() };
  if (index >= 0) items[index] = saved;
  else items.unshift(saved);
  await writeCollection('sets', items.slice(0, 200));
  return saved;
}

export async function getSet(setId: string) {
  return (await readCollection<ExamSet>('sets')).find(item => item.id === setId) ?? null;
}

export async function listSets() {
  return readCollection<ExamSet>('sets');
}

export async function addRevision(setId: string, question: NormalizedQuestion, reason: string) {
  const items = await readCollection<QuestionRevision>('revisions');
  const revision: QuestionRevision = {
    id: `REV-${randomUUID()}`,
    setId,
    questionId: question.id,
    createdAt: new Date().toISOString(),
    reason,
    snapshot: structuredClone(question)
  };
  items.unshift(revision);
  await writeCollection('revisions', items.slice(0, 5000));
  return revision;
}

export async function listRevisions(setId: string, questionId: string) {
  return (await readCollection<QuestionRevision>('revisions'))
    .filter(item => item.setId === setId && item.questionId === questionId);
}

export async function publishSet(set: ExamSet) {
  const bank = await readCollection<NormalizedQuestion>('question-bank');
  const existing = new Map(bank.map(item => [item.id, item]));
  for (const slot of set.slots) {
    if (slot.question) existing.set(slot.question.id, { ...slot.question, reviewState: slot.question.reviewState ?? 'not_reviewed' });
  }
  await writeCollection('question-bank', [...existing.values()]);
  return saveSet({ ...set, published: true });
}

export async function listBank() {
  return readCollection<NormalizedQuestion>('question-bank');
}

export async function saveVoiceProfile(profile: Omit<VoiceProfile, 'createdAt' | 'updatedAt'> & Partial<Pick<VoiceProfile, 'createdAt'>>) {
  const items = await readCollection<VoiceProfile>('voice-profiles');
  const now = new Date().toISOString();
  const index = items.findIndex(item => item.id === profile.id);
  const saved: VoiceProfile = {
    ...profile,
    createdAt: profile.createdAt ?? (index >= 0 ? items[index].createdAt : now),
    updatedAt: now
  };
  if (index >= 0) items[index] = saved;
  else items.unshift(saved);
  await writeCollection('voice-profiles', items);
  return saved;
}

export async function listVoiceProfiles() {
  const items = await readCollection<VoiceProfile>('voice-profiles');
  if (items.length) return items;
  const now = new Date().toISOString();
  const initial: VoiceProfile = {
    id: 'mt-eps-standard',
    name: 'MT EPS Standard Voice',
    narratorVoice: '',
    maleVoice: '',
    femaleVoice: '',
    speed: 0.94,
    pitch: 0,
    sentencePauseMs: 420,
    speakerPauseMs: 520,
    questionPauseMs: 700,
    provider: 'local-system',
    createdAt: now,
    updatedAt: now
  };
  await writeCollection('voice-profiles', [initial]);
  return [initial];
}

export function dataRoot() {
  return DATA_ROOT;
}
