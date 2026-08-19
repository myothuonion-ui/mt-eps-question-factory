import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MEDIA_DIR } from './store.js';
import type { MediaAnalysis, MediaSegment } from '../src/shared/types.js';

function run(command: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed with exit code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function commandAvailable(command: string, args = ['--version']) {
  try {
    await run(command, args, 8000);
    return true;
  } catch {
    return false;
  }
}

function assertYoutubeUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (!(host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'))) throw new Error('Only YouTube URLs are accepted by the YouTube media importer.');
  return url.toString();
}

async function findNewest(prefix: string, extensionFilter?: string) {
  const files = await fs.readdir(MEDIA_DIR);
  const matches = files.filter(name => name.startsWith(prefix) && (!extensionFilter || name.endsWith(extensionFilter)));
  if (!matches.length) return null;
  const stats = await Promise.all(matches.map(async name => ({ name, stat: await fs.stat(path.join(MEDIA_DIR, name)) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return path.join(MEDIA_DIR, stats[0].name);
}

function parseClock(value: string) {
  const pieces = value.trim().replace(',', '.').split(':').map(Number);
  if (pieces.some(piece => !Number.isFinite(piece))) return 0;
  if (pieces.length === 3) return pieces[0] * 3600 + pieces[1] * 60 + pieces[2];
  if (pieces.length === 2) return pieces[0] * 60 + pieces[1];
  return pieces[0] ?? 0;
}

function stripVttText(value: string) {
  return value
    .replace(/<\d\d:\d\d(?::\d\d)?\.\d+>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVtt(vtt: string): MediaSegment[] {
  const lines = vtt.replace(/\r/g, '').split('\n');
  const segments: MediaSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const match = line.match(/^([^\s]+)\s+-->\s+([^\s]+)/);
    if (!match) continue;
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    const textLines: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim()) {
      const clean = stripVttText(lines[cursor]);
      if (clean) textLines.push(clean);
      cursor += 1;
    }
    const text = stripVttText(textLines.join(' '));
    if (end > start && text) {
      const previous = segments[segments.length - 1];
      if (previous && previous.text === text && Math.abs(previous.end - start) < 0.6) {
        previous.end = end;
      } else {
        segments.push({ id: `SEG-${randomUUID()}`, start, end, text, speaker: null });
      }
    }
    index = Math.max(index, cursor - 1);
  }
  return segments;
}

export async function extractYoutubeCaptions(rawUrl: string): Promise<MediaSegment[]> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const url = assertYoutubeUrl(rawUrl);
  if (!await commandAvailable('yt-dlp')) return [];
  const prefix = `captions-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const template = path.join(MEDIA_DIR, `${prefix}.%(ext)s`);
  try {
    await run('yt-dlp', [
      '--no-playlist',
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', 'ko.*,ko,en.*,en',
      '--sub-format', 'vtt',
      '-o', template,
      url
    ], 5 * 60_000);
  } catch {
    return [];
  }
  const subtitlePath = await findNewest(prefix, '.vtt');
  if (!subtitlePath) return [];
  try {
    return parseVtt(await fs.readFile(subtitlePath, 'utf8'));
  } catch {
    return [];
  }
}

export async function downloadYoutubeAudio(rawUrl: string) {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const url = assertYoutubeUrl(rawUrl);
  if (!await commandAvailable('yt-dlp')) throw new Error('yt-dlp is not installed or not available in PATH.');
  const prefix = `youtube-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const template = path.join(MEDIA_DIR, `${prefix}.%(ext)s`);
  await run('yt-dlp', ['--no-playlist', '-x', '--audio-format', 'wav', '--audio-quality', '0', '-o', template, url], 30 * 60_000);
  const audioPath = await findNewest(prefix, '.wav');
  if (!audioPath) throw new Error('yt-dlp completed but no WAV file was created.');
  return audioPath;
}

async function durationSeconds(filePath: string) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], 20_000);
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function silenceSegments(filePath: string): Promise<MediaSegment[]> {
  if (!await commandAvailable('ffmpeg', ['-version'])) return [];
  const duration = await durationSeconds(filePath);
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', filePath, '-af', 'silencedetect=noise=-35dB:d=0.65', '-f', 'null', '-'], 20 * 60_000).catch(error => ({ stdout: '', stderr: String(error) }));
  const boundaries = [0];
  for (const match of stderr.matchAll(/silence_end:\s*([0-9.]+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) boundaries.push(value);
  }
  if (duration) boundaries.push(duration);
  const deduped = [...new Set(boundaries.map(value => Math.max(0, Number(value.toFixed(3)))))].sort((a, b) => a - b);
  const segments: MediaSegment[] = [];
  for (let i = 0; i < deduped.length - 1; i += 1) {
    const start = deduped[i];
    const end = deduped[i + 1];
    const length = end - start;
    if (length < 2) continue;
    if (length <= 55) segments.push({ id: `SEG-${randomUUID()}`, start, end });
    else {
      let cursor = start;
      while (cursor < end) {
        const next = Math.min(cursor + 35, end);
        if (next - cursor >= 2) segments.push({ id: `SEG-${randomUUID()}`, start: cursor, end: next });
        cursor = next;
      }
    }
  }
  return segments;
}

async function whisperSegments(filePath: string): Promise<MediaSegment[] | null> {
  if (!await commandAvailable('whisper', ['--help'])) return null;
  const model = process.env.WHISPER_MODEL ?? 'small';
  const base = path.basename(filePath, path.extname(filePath));
  await run('whisper', [filePath, '--model', model, '--language', 'Korean', '--output_format', 'json', '--output_dir', MEDIA_DIR], 60 * 60_000);
  const outputPath = path.join(MEDIA_DIR, `${base}.json`);
  try {
    const json = JSON.parse(await fs.readFile(outputPath, 'utf8')) as any;
    if (!Array.isArray(json?.segments)) return null;
    return json.segments.map((segment: any) => ({
      id: `SEG-${randomUUID()}`,
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: String(segment.text ?? '').trim(),
      speaker: null
    })).filter((segment: MediaSegment) => segment.end > segment.start);
  } catch {
    return null;
  }
}

export async function analyzeYoutube(rawUrl: string): Promise<MediaAnalysis> {
  const audioPath = await downloadYoutubeAudio(rawUrl);
  const transcribed = await whisperSegments(audioPath);
  const fallbackSegments = transcribed?.length ? transcribed : await silenceSegments(audioPath);
  const relative = path.relative(path.dirname(MEDIA_DIR), audioPath).split(path.sep).join('/');
  return {
    id: `MEDIA-${randomUUID()}`,
    sourceUrl: rawUrl,
    audioPath,
    audioUrl: `/local-files/${relative}`,
    transcriptAvailable: !!transcribed?.length,
    segments: fallbackSegments,
    flags: [
      ...(!await commandAvailable('ffmpeg', ['-version']) ? ['FFMPEG_NOT_AVAILABLE'] : []),
      ...(!transcribed?.length ? ['TRANSCRIPT_NOT_AVAILABLE'] : [])
    ]
  };
}

export async function cutAudioSegment(audioPath: string, start: number, end: number) {
  if (!await commandAvailable('ffmpeg', ['-version'])) throw new Error('ffmpeg is required to cut audio segments.');
  if (!(end > start) || start < 0 || end - start > 180) throw new Error('Invalid audio segment range.');
  const fileName = `clip-${Date.now()}-${randomUUID().slice(0, 6)}.wav`;
  const output = path.join(MEDIA_DIR, fileName);
  await run('ffmpeg', ['-y', '-ss', String(start), '-to', String(end), '-i', audioPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', output], 10 * 60_000);
  return { localPath: output, url: `/local-files/media/${encodeURIComponent(fileName)}` };
}
