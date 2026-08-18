import { randomUUID } from 'node:crypto';
import type { ExamSlot, MediaAnalysis, MediaSegment, NormalizedQuestion } from '../src/shared/types.js';
import { analyzeYoutube, cutAudioSegment } from './mediaProcessor.js';
import { listVoiceProfiles } from './store.js';
import { generateListeningAudio } from './tts.js';

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
    return { segment: { ...winner.segment, start, end, score: winner.score }, guessed: winner.score < 0.08 };
  }
  const candidates = analysis.segments.filter(segment => segment.end - segment.start >= 5 && segment.end - segment.start <= 45);
  const chosen = candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] ?? analysis.segments[0];
  return { segment: chosen, guessed: true };
}

export async function finalizeListeningSlots(slots: ExamSlot[]) {
  const profiles = await listVoiceProfiles();
  const profile = profiles[0];
  const youtubeCache = new Map<string, MediaAnalysis>();

  for (const slot of slots) {
    const question = slot.question;
    if (!question || slot.section !== 'listening' || question.audioAsset) continue;
    const youtube = question.media.find(media => media.kind === 'youtube')?.url;
    if (youtube) {
      try {
        let media = youtubeCache.get(youtube);
        if (!media) {
          media = await analyzeYoutube(youtube);
          youtubeCache.set(youtube, media);
        }
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
