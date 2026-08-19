import { randomUUID } from 'node:crypto';
import type { AudioAsset, ExamSlot, MediaAnalysis, MediaSegment, NormalizedQuestion } from '../src/shared/types.js';
import { analyzeYoutube, cutAudioSegment, downloadYoutubeAudio, extractYoutubeCaptions } from './mediaProcessor.js';
import { alignQuestionsWithYoutube, type VideoAlignment } from './geminiVideo.js';
import { listVoiceProfiles } from './store.js';
import { generateListeningAudio } from './tts.js';

const youtubeCache = new Map<string, MediaAnalysis>();
const captionCache = new Map<string, MediaSegment[]>();
const audioPathCache = new Map<string, string>();

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

function questionTarget(question: NormalizedQuestion) {
  return [question.stem, question.correctAnswerIndex !== null ? question.options[question.correctAnswerIndex] : '', ...question.options].join(' ');
}

function transcriptForRange(segments: MediaSegment[], start: number, end: number) {
  return segments
    .filter(item => item.end >= start && item.start <= end && item.text?.trim())
    .map(item => item.text!.trim())
    .filter((text, index, arr) => arr[index - 1] !== text)
    .join(' ')
    .trim();
}

function bestSegment(question: NormalizedQuestion, segments: MediaSegment[]): { segment: MediaSegment | null; guessed: boolean } {
  if (!segments.length) return { segment: null, guessed: false };
  const target = questionTarget(question);
  const withText = segments.filter(segment => segment.text?.trim());
  if (withText.length) {
    const ranked = withText.map(segment => ({ segment, score: textSimilarity(target, segment.text ?? '') })).sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    const index = segments.findIndex(item => item.id === winner.segment.id);
    const before = segments[Math.max(0, index - 1)];
    const after = segments[Math.min(segments.length - 1, index + 1)];
    const start = Math.max(0, before?.start ?? winner.segment.start);
    const end = Math.min((after?.end ?? winner.segment.end), start + 45);
    const transcript = transcriptForRange(segments, start, end);
    return { segment: { ...winner.segment, start, end, text: transcript || winner.segment.text, score: winner.score }, guessed: winner.score < 0.08 };
  }
  const candidates = segments.filter(segment => segment.end - segment.start >= 5 && segment.end - segment.start <= 45);
  const chosen = candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] ?? segments[0];
  return { segment: chosen, guessed: true };
}

async function cachedYoutube(url: string) {
  let media = youtubeCache.get(url);
  if (!media) {
    media = await analyzeYoutube(url);
    youtubeCache.set(url, media);
    audioPathCache.set(url, media.audioPath);
  }
  return media;
}

async function cachedCaptions(url: string) {
  if (captionCache.has(url)) return captionCache.get(url)!;
  const captions = await extractYoutubeCaptions(url);
  captionCache.set(url, captions);
  return captions;
}

async function cachedAudioPath(url: string) {
  const existing = audioPathCache.get(url);
  if (existing) return existing;
  const path = await downloadYoutubeAudio(url);
  audioPathCache.set(url, path);
  return path;
}

function shortError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/HTTP 429|quota|RESOURCE_EXHAUSTED/i.test(text)) return 'Gemini video quota reached; continuing with captions/Whisper fallback.';
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export type PreparedListeningReference = {
  sourceUrl: string;
  transcript: string | null;
  audioAsset: AudioAsset | null;
  flags: string[];
};

type HybridReporter = (question: number | null, message: string, level?: 'info' | 'warn' | 'success') => void;

function youtubeFor(question: NormalizedQuestion) {
  return question.media.find(media => media.kind === 'youtube')?.url ?? null;
}

function validAlignment(alignment: VideoAlignment | undefined) {
  return !!alignment && alignment.end > alignment.start && alignment.end - alignment.start <= 60 && alignment.confidence >= 0.55;
}

export async function prepareListeningReferences(references: NormalizedQuestion[], report?: HybridReporter) {
  const result = new Map<string, PreparedListeningReference>();
  const groups = new Map<string, NormalizedQuestion[]>();
  for (const reference of references) {
    const url = youtubeFor(reference);
    if (!url) continue;
    groups.set(url, [...(groups.get(url) ?? []), reference]);
  }

  let videoIndex = 0;
  for (const [url, questions] of groups) {
    videoIndex += 1;
    report?.(questions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: checking captions for ${questions.length} listening question(s).`, 'info');
    let captions: MediaSegment[] = [];
    try {
      captions = await cachedCaptions(url);
      report?.(questions[0]?.sourceOrder ?? null, captions.length
        ? `YouTube ${videoIndex}/${groups.size}: ${captions.length} caption segments found.`
        : `YouTube ${videoIndex}/${groups.size}: no usable captions; semantic/fallback analysis will continue.`, captions.length ? 'success' : 'warn');
    } catch (error) {
      report?.(questions[0]?.sourceOrder ?? null, `Caption check skipped · ${shortError(error)}`, 'warn');
    }

    let alignments: VideoAlignment[] = [];
    try {
      report?.(questions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: Gemini semantic timestamp alignment (one request for this video).`, 'info');
      alignments = await alignQuestionsWithYoutube(url, questions);
      if (alignments.length) report?.(questions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: Gemini returned ${alignments.length} question timestamp match(es).`, 'success');
    } catch (error) {
      report?.(questions[0]?.sourceOrder ?? null, shortError(error), 'warn');
    }

    let fallbackMedia: MediaAnalysis | null = null;
    const alignmentById = new Map(alignments.map(item => [item.questionId, item]));

    for (const reference of questions) {
      const flags: string[] = [];
      const alignment = alignmentById.get(reference.id);
      const captionMatch = captions.length ? bestSegment(reference, captions) : { segment: null, guessed: false };
      let chosen: MediaSegment | null = null;
      let transcript = '';

      if (validAlignment(alignment)) {
        const aligned = alignment!;
        const captionTranscript = transcriptForRange(captions, aligned.start, aligned.end);
        chosen = {
          id: `SEG-${randomUUID()}`,
          start: Math.max(0, aligned.start),
          end: Math.min(aligned.end, aligned.start + 60),
          text: captionTranscript || aligned.transcript,
          score: aligned.confidence
        };
        transcript = chosen.text?.trim() ?? '';
        flags.push('HYBRID_GEMINI_VIDEO_MATCH');
        if (aligned.confidence < 0.75) flags.push('YOUTUBE_ALIGNMENT_MEDIUM_CONFIDENCE');
      } else if (captionMatch.segment && !captionMatch.guessed) {
        chosen = captionMatch.segment;
        transcript = chosen.text?.trim() ?? '';
        flags.push('HYBRID_CAPTION_MATCH');
      } else {
        report?.(reference.sourceOrder, `Q${reference.sourceOrder}: captions/Gemini were not confident; trying downloaded audio + Whisper fallback.`, 'warn');
        try {
          fallbackMedia ??= await cachedYoutube(url);
          const fallback = bestSegment(reference, fallbackMedia.segments);
          chosen = fallback.segment;
          transcript = fallback.segment?.text?.trim() ?? '';
          flags.push(fallbackMedia.transcriptAvailable ? 'HYBRID_WHISPER_FALLBACK' : 'HYBRID_AUDIO_FALLBACK');
          if (fallback.guessed) flags.push('YOUTUBE_SEGMENT_GUESSED');
        } catch (error) {
          flags.push(`YOUTUBE_FALLBACK_PENDING:${shortError(error)}`);
        }
      }

      let audioAsset: AudioAsset | null = null;
      if (chosen && chosen.end > chosen.start) {
        try {
          const audioPath = fallbackMedia?.audioPath ?? await cachedAudioPath(url);
          const clip = await cutAudioSegment(audioPath, chosen.start, chosen.end);
          audioAsset = {
            id: `AUD-${randomUUID()}`,
            url: clip.url,
            localPath: clip.localPath,
            durationSeconds: chosen.end - chosen.start,
            source: 'youtube'
          };
          report?.(reference.sourceOrder, `Q${reference.sourceOrder}: source clip ready ${Math.round(chosen.start)}s–${Math.round(chosen.end)}s.`, 'success');
        } catch (error) {
          flags.push(`SOURCE_AUDIO_NOT_READY:${shortError(error)}`);
          report?.(reference.sourceOrder, `Q${reference.sourceOrder}: source clip unavailable; fresh TTS can be used instead · ${shortError(error)}`, 'warn');
        }
      } else {
        flags.push('YOUTUBE_SEGMENT_NOT_FOUND');
      }

      if (!transcript) flags.push('YOUTUBE_TRANSCRIPT_UNAVAILABLE');
      result.set(reference.id, { sourceUrl: url, transcript: transcript || null, audioAsset, flags });
    }
  }
  return result;
}

export async function prepareListeningReference(reference: NormalizedQuestion): Promise<PreparedListeningReference | null> {
  const prepared = await prepareListeningReferences([reference]);
  return prepared.get(reference.id) ?? null;
}

export async function finalizeListeningSlots(
  slots: ExamSlot[],
  report?: (question: number, message: string, level?: 'info' | 'warn' | 'success') => void
) {
  const profiles = await listVoiceProfiles();
  const profile = profiles[0];

  for (const slot of slots) {
    const question = slot.question;
    if (!question || slot.section !== 'listening') continue;
    if (question.audioAsset) {
      report?.(slot.slot, `Q${slot.slot}: source listening clip already prepared.`, 'success');
      continue;
    }

    const youtube = youtubeFor(question);
    if (youtube) {
      report?.(slot.slot, `Q${slot.slot}: source clip missing; retrying local YouTube audio match.`, 'info');
      try {
        const media = await cachedYoutube(youtube);
        const match = bestSegment(question, media.segments);
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
        report?.(slot.slot, `Q${slot.slot}: YouTube listening clip ready (${Math.round(match.segment.end - match.segment.start)}s).`, match.guessed ? 'warn' : 'success');
        continue;
      } catch (error) {
        const text = shortError(error);
        question.qaFlags = [...new Set([...question.qaFlags, `YOUTUBE_AUDIO_PENDING:${text}`])];
        report?.(slot.slot, `Q${slot.slot}: source audio retry failed; using TTS fallback when a script exists · ${text}`, 'warn');
      }
    }

    if (question.listeningScript?.length && profile) {
      report?.(slot.slot, `Q${slot.slot}: generating TTS listening audio.`, 'info');
      try {
        question.audioAsset = await generateListeningAudio(question, profile);
        report?.(slot.slot, `Q${slot.slot}: TTS audio ready.`, 'success');
      } catch (error) {
        const text = shortError(error);
        question.qaFlags = [...new Set([...question.qaFlags, `TTS_AUDIO_PENDING:${text}`])];
        report?.(slot.slot, `Q${slot.slot}: TTS audio pending · ${text}`, 'warn');
      }
    } else {
      question.qaFlags = [...new Set([...question.qaFlags, 'LISTENING_AUDIO_SOURCE_MISSING'])];
      report?.(slot.slot, `Q${slot.slot}: no usable source clip or generated listening script found.`, 'warn');
    }
  }
  return slots;
}
