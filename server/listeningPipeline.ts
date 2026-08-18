import { randomUUID } from 'node:crypto';
import type { AudioAsset, ExamSlot, MediaAnalysis, MediaSegment, NormalizedQuestion } from '../src/shared/types.js';
import { analyzeYoutube, cutAudioSegment } from './mediaProcessor.js';
import { listVoiceProfiles } from './store.js';
import { generateListeningAudio } from './tts.js';

const youtubeCache = new Map<string, MediaAnalysis>();

function grams(text: string) {
  const value = text.toLowerCase().replace(/\s+/g, '').replace(/[^0-9a-z가-힣]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
  return out;
}

function textSimilarity(a: string, b: string) {
  const aa = grams(a); const bb = grams(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0; for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

function bestSegment(question: NormalizedQuestion, analysis: MediaAnalysis): { segment: MediaSegment | null; guessed: boolean } {
  if (!analysis.segments.length) return { segment: null, guessed: false };
  const target = [question.stem, question.correctAnswerIndex !== null ? question.options[question.correctAnswerIndex] : '', ...question.options].join(' ');
  const withText = analysis.segments.filter(segment => segment.text?.trim());
  if (withText.length) {
    const ranked = withText.map(segment => ({ segment, score: textSimilarity(target, segment.text ?? '') })).sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    const index = analysis.segments.findIndex(item => item.id === winner.segment.id);
    const before = analysis.segments[Math.max(0, index - 1)];
    const after = analysis.segments[Math.min(analysis.segments.length - 1, index + 1)];
    const start = Math.max(0, before?.start ?? winner.segment.start);
    const end = Math.min((after?.end ?? winner.segment.end), start + 45);
    const transcript = analysis.segments
      .filter(item => item.end >= start && item.start <= end && item.text?.trim())
      .map(item => item.text!.trim())
      .join(' ');
    return { segment: { ...winner.segment, start, end, text: transcript || winner.segment.text, score: winner.score }, guessed: winner.score < 0.08 };
  }
  const candidates = analysis.segments.filter(segment => segment.end - segment.start >= 5 && segment.end - segment.start <= 45);
  const chosen = candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] ?? analysis.segments[0];
  return { segment: chosen, guessed: true };
}

async function cachedYoutube(url: string) {
  let media = youtubeCache.get(url);
  if (!media) {
    media = await analyzeYoutube(url);
    youtubeCache.set(url, media);
  }
  return media;
}

export type PreparedListeningReference = {
  sourceUrl: string;
  transcript: string | null;
  audioAsset: AudioAsset | null;
  flags: string[];
};

export async function prepareListeningReference(reference: NormalizedQuestion): Promise<PreparedListeningReference | null> {
  const youtube = reference.media.find(media => media.kind === 'youtube')?.url;
  if (!youtube) return null;
  try {
    const media = await cachedYoutube(youtube);
    const match = bestSegment(reference, media);
    if (!match.segment) return { sourceUrl: youtube, transcript: null, audioAsset: null, flags: ['YOUTUBE_SEGMENT_NOT_FOUND'] };
    const clip = await cutAudioSegment(media.audioPath, match.segment.start, match.segment.end);
    const audioAsset: AudioAsset = {
      id: `AUD-${randomUUID()}`,
      url: clip.url,
      localPath: clip.localPath,
      durationSeconds: match.segment.end - match.segment.start,
      source: 'youtube'
    };
    return {
      sourceUrl: youtube,
      transcript: match.segment.text?.trim() || null,
      audioAsset,
      flags: [
        ...(match.guessed ? ['YOUTUBE_SEGMENT_GUESSED'] : []),
        ...(!match.segment.text?.trim() ? ['YOUTUBE_TRANSCRIPT_UNAVAILABLE'] : [])
      ]
    };
  } catch (error) {
    return {
      sourceUrl: youtube,
      transcript: null,
      audioAsset: null,
      flags: [`YOUTUBE_PREPARE_PENDING:${error instanceof Error ? error.message : 'unknown'}`]
    };
  }
}

export async function finalizeListeningSlots(slots: ExamSlot[]) {
  const profiles = await listVoiceProfiles();
  const profile = profiles[0];

  for (const slot of slots) {
    const question = slot.question;
    if (!question || slot.section !== 'listening' || question.audioAsset) continue;
    const youtube = question.media.find(media => media.kind === 'youtube')?.url;
    if (youtube) {
      try {
        const media = await cachedYoutube(youtube);
        const match = bestSegment(question, media);
        if (!match.segment) throw new Error('No useful audio segment was detected.');
        const clip = await cutAudioSegment(media.audioPath, match.segment.start, match.segment.end);
        question.audioAsset = {
          id: `AUD-${randomUUID()}`,
          url: clip.url,
          localPath: clip.localPath,
          durationSeconds: match.segment.end - match.segment.start,
          source: 'youtube'
        };
        if (match.guessed) question.qaFlags = [...new Set([...question.qaFlags, 'YOUTUBE_SEGMENT_GUESSED'])];
      } catch (error) {
        question.qaFlags = [...new Set([...question.qaFlags, `YOUTUBE_AUDIO_PENDING:${error instanceof Error ? error.message : 'unknown'}`])];
      }
      continue;
    }

    if (question.listeningScript?.length && profile) {
      try {
        question.audioAsset = await generateListeningAudio(question, profile);
      } catch (error) {
        question.qaFlags = [...new Set([...question.qaFlags, `TTS_AUDIO_PENDING:${error instanceof Error ? error.message : 'unknown'}`])];
      }
    } else {
      question.qaFlags = [...new Set([...question.qaFlags, 'LISTENING_AUDIO_SOURCE_MISSING'])];
    }
  }
  return slots;
}
