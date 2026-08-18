import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AudioAsset, ListeningScriptLine, NormalizedQuestion, VoiceProfile } from '../src/shared/types.js';
import { TTS_DIR } from './store.js';
import { commandAvailable } from './mediaProcessor.js';

function run(command: string, args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out.`)); }, timeoutMs);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with exit code ${code}: ${stderr.slice(-1600)}`));
    });
  });
}

function voiceFor(line: ListeningScriptLine, profile: VoiceProfile) {
  return line.speaker === 'male' ? profile.maleVoice : line.speaker === 'female' ? profile.femaleVoice : profile.narratorVoice;
}

async function localSystemLine(text: string, voice: string, speed: number, output: string) {
  if (process.platform !== 'win32') throw new Error('local-system TTS currently requires Windows.');
  const textFile = `${output}.txt`;
  await fs.writeFile(textFile, text, 'utf8');
  const esc = (value: string) => value.replace(/'/g, "''");
  const rate = Math.max(-10, Math.min(10, Math.round((speed - 1) * 10)));
  const select = voice ? `$s.SelectVoice('${esc(voice)}');` : '';
  const script = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ${select} $s.Rate=${rate}; $s.SetOutputToWaveFile('${esc(output)}'); $t=Get-Content -Raw -Encoding UTF8 '${esc(textFile)}'; $s.Speak($t); $s.Dispose();`;
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 5 * 60_000);
  } finally {
    await fs.rm(textFile, { force: true });
  }
}

async function compatibleLine(text: string, voice: string, speed: number, output: string) {
  const base = (process.env.TTS_BASE_URL ?? '').replace(/\/$/, '');
  const key = process.env.TTS_API_KEY ?? '';
  const model = process.env.TTS_MODEL ?? '';
  if (!base || !key || !model) throw new Error('TTS_BASE_URL, TTS_API_KEY and TTS_MODEL are required for openai-compatible TTS.');
  const response = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, voice: voice || 'alloy', input: text, speed, response_format: 'wav' })
  });
  if (!response.ok) throw new Error(`TTS provider failed: HTTP ${response.status} ${await response.text()}`);
  await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
}

async function normalize(input: string, output: string) {
  if (!await commandAvailable('ffmpeg', ['-version'])) {
    await fs.copyFile(input, output);
    return;
  }
  await run('ffmpeg', ['-y', '-i', input, '-ar', '24000', '-ac', '1', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', output]);
}

async function makeSilence(ms: number, output: string) {
  if (!await commandAvailable('ffmpeg', ['-version'])) throw new Error('ffmpeg is required for multi-speaker pause assembly.');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(Math.max(0.05, ms / 1000)), '-c:a', 'pcm_s16le', output]);
}

async function concatWav(inputs: string[], output: string) {
  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], output);
    return;
  }
  if (!await commandAvailable('ffmpeg', ['-version'])) throw new Error('ffmpeg is required to assemble multi-speaker listening audio.');
  const list = path.join(TTS_DIR, `concat-${randomUUID()}.txt`);
  const body = inputs.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(list, body, 'utf8');
  try {
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', output]);
  } finally {
    await fs.rm(list, { force: true });
  }
}

export function activeTtsProviderName() {
  return (process.env.TTS_PROVIDER ?? 'local-system').toLowerCase();
}

export async function generateListeningAudio(question: NormalizedQuestion, profile: VoiceProfile): Promise<AudioAsset> {
  if (!question.listeningScript?.length) throw new Error('This question has no listening script.');
  await fs.mkdir(TTS_DIR, { recursive: true });
  const provider = profile.provider || activeTtsProviderName();
  const pieces: string[] = [];
  const cleanup: string[] = [];
  try {
    for (let index = 0; index < question.listeningScript.length; index += 1) {
      const line = question.listeningScript[index];
      const raw = path.join(TTS_DIR, `raw-${randomUUID()}.wav`);
      const normalized = path.join(TTS_DIR, `line-${randomUUID()}.wav`);
      cleanup.push(raw, normalized);
      if (provider === 'openai-compatible') await compatibleLine(line.text, voiceFor(line, profile), profile.speed, raw);
      else await localSystemLine(line.text, voiceFor(line, profile), profile.speed, raw);
      await normalize(raw, normalized);
      pieces.push(normalized);
      if (index < question.listeningScript.length - 1) {
        const pause = path.join(TTS_DIR, `pause-${randomUUID()}.wav`);
        cleanup.push(pause);
        await makeSilence(profile.speakerPauseMs, pause);
        pieces.push(pause);
      }
    }
    const finalName = `listening-${question.id}-${Date.now()}.wav`;
    const finalPath = path.join(TTS_DIR, finalName);
    await concatWav(pieces, finalPath);
    return {
      id: `AUD-${randomUUID()}`,
      url: `/local-files/tts/${encodeURIComponent(finalName)}`,
      localPath: finalPath,
      source: 'tts'
    };
  } finally {
    await Promise.all(cleanup.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
  }
}
