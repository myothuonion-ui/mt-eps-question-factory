import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { parseQuestionsFromText } from './textParser.js';
import { UPLOAD_DIR } from './store.js';
import type { ImportAnalysis, MediaRef, NormalizedQuestion } from '../src/shared/types.js';

export type UploadedFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

type ParsedSource = {
  questions: NormalizedQuestion[];
  media: MediaRef[];
};

function extension(name: string) {
  return path.extname(name).toLowerCase();
}

function safeName(name: string) {
  return path.basename(name).replace(/[^0-9A-Za-z가-힣._-]+/g, '_').slice(0, 140) || `file-${randomUUID()}`;
}

async function persistBuffer(name: string, buffer: Buffer) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const fileName = `${Date.now()}-${randomUUID().slice(0, 6)}-${safeName(name)}`;
  const full = path.join(UPLOAD_DIR, fileName);
  await fs.writeFile(full, buffer);
  return { full, url: `/local-files/uploads/${encodeURIComponent(fileName)}` };
}

function mediaKind(name: string): MediaRef['kind'] | null {
  const ext = extension(name);
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video';
  return null;
}

async function textFromSpreadsheet(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return workbook.SheetNames.map(name => {
    const sheet = workbook.Sheets[name];
    return `\n${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
  }).join('\n');
}

async function parseBuffer(name: string, buffer: Buffer, sourcePrefix: string): Promise<ParsedSource> {
  const ext = extension(name);
  const title = safeName(name);
  const sourceUrl = `${sourcePrefix}/${encodeURIComponent(title)}`;
  const kind = mediaKind(name);
  if (kind) {
    const saved = await persistBuffer(name, buffer);
    return { questions: [], media: [{ kind, url: saved.url, localPath: saved.full, label: title }] };
  }

  if (ext === '.zip') {
    const zip = await JSZip.loadAsync(buffer);
    const allQuestions: NormalizedQuestion[] = [];
    const allMedia: MediaRef[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const entryName = safeName(entry.name);
      const bytes = Buffer.from(await entry.async('uint8array'));
      const parsed = await parseBuffer(entryName, bytes, `${sourceUrl}/zip`);
      allQuestions.push(...parsed.questions);
      allMedia.push(...parsed.media);
    }
    return { questions: allQuestions, media: allMedia };
  }

  let text = '';
  if (ext === '.pdf') {
    const parsed = await pdfParse(buffer);
    text = parsed.text ?? '';
  } else if (ext === '.docx') {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    text = ext === '.csv' ? buffer.toString('utf8') : await textFromSpreadsheet(buffer);
  } else if (['.txt', '.md', '.json'].includes(ext) || !ext) {
    text = buffer.toString('utf8');
  } else {
    const saved = await persistBuffer(name, buffer);
    return { questions: [], media: [{ kind: 'link', url: saved.url, localPath: saved.full, label: title }] };
  }

  return {
    questions: parseQuestionsFromText(text, sourceUrl, title),
    media: []
  };
}

export async function importFiles(files: UploadedFile[]): Promise<ImportAnalysis> {
  const id = `IMP-FILE-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const questions: NormalizedQuestion[] = [];
  const mediaPool: MediaRef[] = [];
  for (const file of files) {
    const parsed = await parseBuffer(file.originalname, file.buffer, `local://import/${id}`);
    questions.push(...parsed.questions);
    mediaPool.push(...parsed.media);
  }
  questions.forEach((question, index) => { question.sourceOrder = index + 1; question.provenance.sourceId = id; });
  const images = mediaPool.filter(item => item.kind === 'image').length + questions.flatMap(q => q.media).filter(item => item.kind === 'image').length;
  const youtube = questions.flatMap(q => q.media).filter(item => item.kind === 'youtube').length;
  return {
    id,
    sourceUrl: `local://import/${id}`,
    sourceTitle: files.length === 1 ? files[0].originalname : `${files.length} local files`,
    importedAt: new Date().toISOString(),
    mediaPool,
    counts: {
      questions: questions.length,
      listening: questions.filter(q => q.type === 'listening').length,
      reading: questions.filter(q => q.type !== 'listening').length,
      images,
      youtube,
      answersDetected: questions.filter(q => q.correctAnswerIndex !== null).length
    },
    questions
  };
}
