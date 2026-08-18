import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { importGoogleFormViewScore } from './server/formParser.js';
import type { ExamSet, ExamSlot, NormalizedQuestion } from './src/shared/types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'MT EPS Question Factory', version: '0.1.0' }));

const importSchema = z.object({ url: z.string().url() });
app.post('/api/import/google-form', async (req, res) => {
  try {
    const { url } = importSchema.parse(req.body);
    const analysis = await importGoogleFormViewScore(url);
    res.json({ ok: true, analysis });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown import error';
    res.status(400).json({ ok: false, error: message });
  }
});

const buildSchema = z.object({ questions: z.array(z.any()).max(500) });
app.post('/api/exam/build-40', (req, res) => {
  try {
    const { questions } = buildSchema.parse(req.body) as { questions: NormalizedQuestion[] };
    const ordered = [...questions].sort((a, b) => a.sourceOrder - b.sourceOrder).slice(0, 40);
    const slots: ExamSlot[] = Array.from({ length: 40 }, (_, i) => {
      const slot = i + 1;
      return {
        slot,
        section: slot <= 20 ? 'listening' : 'reading',
        question: ordered[i] ?? null,
        generationRequired: !ordered[i]
      };
    });
    const set: ExamSet = {
      id: `SET-${Date.now()}`,
      createdAt: new Date().toISOString(),
      slots,
      complete: slots.every(slot => !!slot.question),
      reviewOptional: true
    };
    res.json({ ok: true, set });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown set build error';
    res.status(400).json({ ok: false, error: message });
  }
});

const port = Number(process.env.PORT ?? 8787);
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(currentDir));
  app.get('*', (_req, res) => res.sendFile(path.join(currentDir, 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(port, '0.0.0.0', () => {
  console.log(`MT EPS Question Factory running on http://127.0.0.1:${port}`);
});
