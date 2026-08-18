import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { importGoogleFormViewScore } from './server/formParser.js';
import { importFiles, type UploadedFile } from './server/fileImporter.js';
import { buildStructureOnly, complete40QuestionSet } from './server/blueprint.js';
import { activeAiProviderName, generateQuestion } from './server/providers/aiProvider.js';
import { qaQuestion } from './server/qa.js';
import { activeTtsProviderName, generateListeningAudio } from './server/tts.js';
import { analyzeYoutube, commandAvailable, cutAudioSegment } from './server/mediaProcessor.js';
import { getProviderSettings, saveProviderSettings } from './server/providerSettings.js';
import { createGenerationJob, failGenerationJob, finishGenerationJob, getGenerationJob, reportGenerationProgress } from './server/jobManager.js';
import {
  addRevision,
  dataRoot,
  getSet,
  listBank,
  listImports,
  listRevisions,
  listSets,
  listVoiceProfiles,
  publishSet,
  saveImport,
  saveSet,
  saveVoiceProfile
} from './server/store.js';
import type { ExamSet, ImportAnalysis, NormalizedQuestion, VoiceProfile } from './src/shared/types.js';

const APP_VERSION = '0.3.0';
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024, files: 30 } });
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use('/local-files', express.static(dataRoot(), { fallthrough: false }));

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'MT EPS Question Factory', version: APP_VERSION, localMode: true }));

app.get('/api/system/status', async (_req, res) => {
  const [ffmpeg, ytdlp, whisper] = await Promise.all([
    commandAvailable('ffmpeg', ['-version']),
    commandAvailable('yt-dlp'),
    commandAvailable('whisper', ['--help'])
  ]);
  res.json({
    ok: true,
    status: {
      version: APP_VERSION,
      localMode: true,
      aiProvider: activeAiProviderName(),
      ttsProvider: activeTtsProviderName(),
      providers: getProviderSettings(),
      tools: { ffmpeg, ytdlp, whisper }
    }
  });
});

app.get('/api/settings/providers', (_req, res) => res.json({ ok: true, settings: getProviderSettings() }));
const providerSettingsSchema = z.object({
  order: z.enum(['gemini-glm', 'glm-gemini', 'gemini', 'glm', 'mock']).optional(),
  batchSize: z.number().int().min(1).max(8).optional(),
  geminiApiKey: z.string().max(5000).optional(),
  geminiModel: z.string().max(200).optional(),
  glmApiKey: z.string().max(5000).optional(),
  glmBaseUrl: z.string().max(1000).optional(),
  glmModel: z.string().max(300).optional(),
  cloudflareApiToken: z.string().max(5000).optional(),
  cloudflareAccountId: z.string().max(300).optional(),
  cloudflareImageModel: z.string().max(500).optional()
});
app.put('/api/settings/providers', async (req, res) => {
  try {
    const input = providerSettingsSchema.parse(req.body);
    const settings = await saveProviderSettings(input);
    res.json({ ok: true, settings });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

const importSchema = z.object({ url: z.string().url() });
app.post('/api/import/google-form', async (req, res) => {
  try {
    const { url } = importSchema.parse(req.body);
    const analysis = await importGoogleFormViewScore(url);
    const saved = await saveImport({
      ...analysis,
      questions: analysis.questions.map(question => ({
        ...question,
        origin: 'imported',
        revision: question.revision ?? 1,
        reviewState: question.reviewState ?? 'not_reviewed'
      }))
    });
    res.json({ ok: true, analysis: saved });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.post('/api/import/files', upload.array('files', 30), async (req, res) => {
  try {
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) throw new Error('Choose at least one file.');
    const analysis = await importFiles(files.map(file => ({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      buffer: file.buffer
    } satisfies UploadedFile)));
    const saved = await saveImport(analysis);
    res.json({ ok: true, analysis: saved });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.get('/api/imports', async (_req, res) => res.json({ ok: true, imports: await listImports() }));

const analysisSchema = z.object({ analysis: z.any(), name: z.string().max(160).optional() });
app.post('/api/exam/build-40', async (req, res) => {
  try {
    const payload = analysisSchema.parse(req.body) as { analysis: ImportAnalysis; name?: string };
    const set = await saveSet(buildStructureOnly(payload.analysis));
    res.json({ ok: true, set });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

// Synchronous endpoint kept for CI/smoke testing and compatibility.
app.post('/api/exam/complete-40', async (req, res) => {
  try {
    const payload = analysisSchema.parse(req.body) as { analysis: ImportAnalysis; name?: string };
    const set = await complete40QuestionSet(payload.analysis, payload.name);
    const saved = await saveSet(set);
    res.json({ ok: true, set: saved });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

// UI uses a background job so progress, current question and provider fallback are visible live.
app.post('/api/exam/generate-40-job', (req, res) => {
  try {
    const payload = analysisSchema.parse(req.body) as { analysis: ImportAnalysis; name?: string };
    const job = createGenerationJob();
    res.status(202).json({ ok: true, job });
    void (async () => {
      try {
        reportGenerationProgress(job.id, { stage: 'prepare', percent: 1, question: null, message: 'Generation job started.' });
        const set = await complete40QuestionSet(payload.analysis, payload.name, event => reportGenerationProgress(job.id, event));
        reportGenerationProgress(job.id, { stage: 'save', percent: 98, question: null, completedQuestions: 40, message: 'Saving completed 40Q set locally.' });
        const saved = await saveSet(set);
        reportGenerationProgress(job.id, { stage: 'done', percent: 100, question: null, completedQuestions: 40, level: 'success', message: `40/40 complete. Set ${saved.id} is ready; review is optional.` });
        finishGenerationJob(job.id, saved.id);
      } catch (error) {
        failGenerationJob(job.id, message(error));
      }
    })();
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = getGenerationJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Generation job not found.' });
  res.json({ ok: true, job });
});

app.get('/api/sets', async (_req, res) => res.json({ ok: true, sets: await listSets() }));
app.get('/api/sets/:setId', async (req, res) => {
  const set = await getSet(req.params.setId);
  if (!set) return res.status(404).json({ ok: false, error: 'Set not found.' });
  res.json({ ok: true, set });
});

function findQuestion(set: ExamSet, questionId: string) {
  const slot = set.slots.find(item => item.question?.id === questionId);
  if (!slot?.question) throw new Error('Question not found in this set.');
  return { slot, question: slot.question };
}

const editSchema = z.object({
  stem: z.string().min(1).max(8000).optional(),
  options: z.array(z.string().max(3000)).length(4).optional(),
  correctAnswerIndex: z.number().int().min(0).max(3).nullable().optional(),
  explanation: z.string().max(12000).nullable().optional(),
  chapter: z.number().int().min(1).max(60).optional(),
  reviewState: z.enum(['not_reviewed', 'edited', 'approved', 'rejected']).optional()
});

app.patch('/api/sets/:setId/questions/:questionId', async (req, res) => {
  try {
    const patch = editSchema.parse(req.body);
    const set = await getSet(req.params.setId);
    if (!set) throw new Error('Set not found.');
    const { slot, question } = findQuestion(set, req.params.questionId);
    await addRevision(set.id, question, 'manual-edit');
    const peers = set.slots.flatMap(item => item.question ? [item.question] : []);
    const next: NormalizedQuestion = qaQuestion({
      ...question,
      ...patch,
      chapter: patch.chapter ? { chapter: patch.chapter, title: null, confidence: 1, reason: 'Teacher selected chapter' } : question.chapter,
      revision: (question.revision ?? 1) + 1,
      reviewState: patch.reviewState ?? 'edited'
    }, peers);
    slot.question = next;
    const saved = await saveSet({ ...set, qaCompleted: true });
    res.json({ ok: true, set: saved, question: next });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

const regenSchema = z.object({ mode: z.enum(['entire', 'choices', 'explanation', 'script']).default('entire') });
app.post('/api/sets/:setId/questions/:questionId/regenerate', async (req, res) => {
  try {
    const { mode } = regenSchema.parse(req.body);
    const set = await getSet(req.params.setId);
    if (!set) throw new Error('Set not found.');
    const { slot, question } = findQuestion(set, req.params.questionId);
    await addRevision(set.id, question, `regenerate-${mode}`);
    const peers = set.slots.flatMap(item => item.question ? [item.question] : []);
    const chapter = question.chapter.chapter ?? ((slot.slot - 1) % 60) + 1;
    const generated = await generateQuestion({
      slot: slot.slot,
      section: slot.section,
      expectedType: slot.expectedType,
      patternId: slot.patternId,
      chapter,
      sourceExamples: peers.filter(item => item.id !== question.id).slice(0, 5),
      preserveQuestion: question,
      mode
    });
    const next = qaQuestion({ ...generated, audioAsset: mode === 'script' || mode === 'entire' ? null : generated.audioAsset }, peers);
    slot.question = next;
    const saved = await saveSet({ ...set, qaCompleted: true });
    res.json({ ok: true, set: saved, question: next });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.get('/api/sets/:setId/questions/:questionId/revisions', async (req, res) => {
  res.json({ ok: true, revisions: await listRevisions(req.params.setId, req.params.questionId) });
});

const audioSchema = z.object({ profileId: z.string().default('mt-eps-standard') });
app.post('/api/sets/:setId/questions/:questionId/audio', async (req, res) => {
  try {
    const { profileId } = audioSchema.parse(req.body);
    const set = await getSet(req.params.setId);
    if (!set) throw new Error('Set not found.');
    const { slot, question } = findQuestion(set, req.params.questionId);
    const profile = (await listVoiceProfiles()).find(item => item.id === profileId);
    if (!profile) throw new Error('Voice profile not found.');
    await addRevision(set.id, question, 'audio-regenerate');
    const audioAsset = await generateListeningAudio(question, profile);
    slot.question = { ...question, audioAsset, revision: (question.revision ?? 1) + 1 };
    const saved = await saveSet(set);
    res.json({ ok: true, set: saved, audioAsset });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.post('/api/sets/:setId/publish', async (req, res) => {
  try {
    const set = await getSet(req.params.setId);
    if (!set) throw new Error('Set not found.');
    if (!set.complete) throw new Error('Only complete 40-question sets can be placed in the local verified bank.');
    const saved = await publishSet(set);
    res.json({ ok: true, set: saved });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.get('/api/bank', async (_req, res) => res.json({ ok: true, questions: await listBank() }));

app.get('/api/voice-profiles', async (_req, res) => res.json({ ok: true, profiles: await listVoiceProfiles() }));
const voiceSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(160),
  narratorVoice: z.string().max(200),
  maleVoice: z.string().max(200),
  femaleVoice: z.string().max(200),
  speed: z.number().min(0.5).max(2),
  pitch: z.number().min(-10).max(10),
  sentencePauseMs: z.number().int().min(0).max(5000),
  speakerPauseMs: z.number().int().min(0).max(5000),
  questionPauseMs: z.number().int().min(0).max(8000),
  provider: z.enum(['local-system', 'openai-compatible']),
  createdAt: z.string().optional()
});
app.put('/api/voice-profiles/:profileId', async (req, res) => {
  try {
    const payload = voiceSchema.parse({ ...req.body, id: req.params.profileId }) as Omit<VoiceProfile, 'updatedAt'>;
    const profile = await saveVoiceProfile(payload);
    res.json({ ok: true, profile });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.post('/api/media/youtube/analyze', async (req, res) => {
  try {
    const { url } = importSchema.parse(req.body);
    const analysis = await analyzeYoutube(url);
    res.json({ ok: true, analysis });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

const cutSchema = z.object({ audioPath: z.string(), start: z.number().min(0), end: z.number().positive() });
app.post('/api/media/cut', async (req, res) => {
  try {
    const { audioPath, start, end } = cutSchema.parse(req.body);
    const resolved = path.resolve(audioPath);
    if (!resolved.startsWith(path.resolve(dataRoot()))) throw new Error('Audio path must be inside the local factory data directory.');
    const clip = await cutAudioSegment(resolved, start, end);
    res.json({ ok: true, clip });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

const port = Number(process.env.PORT ?? 8787);
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(currentDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/local-files/')) return next();
    return res.sendFile(path.join(currentDir, 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(port, '127.0.0.1', () => {
  console.log(`MT EPS Question Factory v${APP_VERSION} running locally at http://127.0.0.1:${port}`);
});
