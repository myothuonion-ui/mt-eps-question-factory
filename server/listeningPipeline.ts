import { randomUUID } from 'node:crypto';
import type { AgentName, AudioAsset, ExamSlot, MediaAnalysis, MediaSegment, NormalizedQuestion } from '../src/shared/types.js';
import { analyzeYoutube, cutAudioSegment, downloadYoutubeAudio, extractYoutubeCaptions } from './mediaProcessor.js';
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

function weightedQuestionSimilarity(question: NormalizedQuestion, transcript: string) {
  const answer = question.correctAnswerIndex !== null ? question.options[question.correctAnswerIndex] ?? '' : '';
  const answerScore = textSimilarity(answer, transcript);
  const stemScore = textSimilarity(question.stem, transcript);
  const optionScore = Math.max(0, ...question.options.map(option => textSimilarity(option, transcript)));
  // In EPS listening items the spoken wording often overlaps the correct option more than the question stem.
  return (answerScore * 0.58) + (stemScore * 0.24) + (optionScore * 0.18);
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

type LocalAlignment = {
  segment: MediaSegment | null;
  confidence: number;
  guessed: boolean;
  method: 'caption-text' | 'whisper-text' | 'ordered-fallback';
};

function buildCandidateWindows(segments: MediaSegment[]) {
  if (!segments.length) return [] as MediaSegment[];
  const out: MediaSegment[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    const startIndex = Math.max(0, index - 1);
    for (let endIndex = index; endIndex <= Math.min(segments.length - 1, index + 3); endIndex += 1) {
      const first = segments[startIndex];
      const last = segments[endIndex];
      const start = Math.max(0, first.start);
      const end = Math.min(last.end, start + 45);
      if (end <= start || end - start < 2) continue;
      const text = transcriptForRange(segments, start, end);
      out.push({
        id: `WIN-${startIndex}-${endIndex}`,
        start,
        end,
        text: text || current.text || '',
        score: 0
      });
    }
  }
  const deduped = new Map<string, MediaSegment>();
  for (const segment of out) deduped.set(`${segment.start.toFixed(2)}:${segment.end.toFixed(2)}`, segment);
  return [...deduped.values()];
}

function localAlignQuestions(questions: NormalizedQuestion[], segments: MediaSegment[], source: 'caption' | 'whisper') {
  const result = new Map<string, LocalAlignment>();
  if (!questions.length || !segments.length) return result;
  const orderedQuestions = [...questions].sort((a, b) => a.sourceOrder - b.sourceOrder);
  const windows = buildCandidateWindows(segments);
  if (!windows.length) return result;
  const videoStart = Math.min(...segments.map(segment => segment.start));
  const videoEnd = Math.max(...segments.map(segment => segment.end));
  const duration = Math.max(1, videoEnd - videoStart);
  let previousStart = videoStart - 1;

  for (let qIndex = 0; qIndex < orderedQuestions.length; qIndex += 1) {
    const question = orderedQuestions[qIndex];
    const expectedCenter = videoStart + duration * ((qIndex + 0.5) / orderedQuestions.length);
    const monotonic = windows.filter(window => window.start >= previousStart - 1.5);
    const pool = monotonic.length ? monotonic : windows;
    const ranked = pool.map(window => {
      const lexical = weightedQuestionSimilarity(question, window.text ?? '');
      const center = (window.start + window.end) / 2;
      const position = Math.max(0, 1 - Math.abs(center - expectedCenter) / Math.max(1, duration * 0.45));
      const reusePenalty = window.start < previousStart + 1 ? 0.07 : 0;
      const combined = (lexical * 0.84) + (position * 0.16) - reusePenalty;
      return { window, lexical, position, combined };
    }).sort((a, b) => b.combined - a.combined);
    const winner = ranked[0];
    if (!winner) continue;

    const lexicalEnough = winner.lexical >= 0.035;
    const confidence = lexicalEnough
      ? Math.min(0.97, 0.55 + winner.lexical * 2.2 + winner.position * 0.12)
      : Math.min(0.54, 0.28 + winner.position * 0.24);
    const guessed = !lexicalEnough;
    const segment: MediaSegment = {
      ...winner.window,
      id: `SEG-${randomUUID()}`,
      score: confidence
    };
    result.set(question.id, {
      segment,
      confidence,
      guessed,
      method: guessed ? 'ordered-fallback' : source === 'caption' ? 'caption-text' : 'whisper-text'
    });
    previousStart = Math.max(previousStart, segment.start);
  }
  return result;
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
  const downloaded = await downloadYoutubeAudio(url);
  audioPathCache.set(url, downloaded);
  return downloaded;
}

function shortError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export type PreparedListeningReference = {
  sourceUrl: string;
  transcript: string | null;
  audioAsset: AudioAsset | null;
  flags: string[];
};

type HybridReporter = (question: number | null, message: string, level?: 'info' | 'warn' | 'success', agent?: AgentName) => void;

function youtubeFor(question: NormalizedQuestion) {
  return question.media.find(media => media.kind === 'youtube')?.url ?? null;
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
    const orderedQuestions = [...questions].sort((a, b) => a.sourceOrder - b.sourceOrder);
    report?.(orderedQuestions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: local-only analysis for ${orderedQuestions.length} Listening question(s). No AI video request will be used.`, 'info', 'Media Agent');

    let captions: MediaSegment[] = [];
    try {
      captions = await cachedCaptions(url);
      report?.(
        orderedQuestions[0]?.sourceOrder ?? null,
        captions.length ? `YouTube ${videoIndex}/${groups.size}: ${captions.length} timestamped caption segment(s) found with yt-dlp.` : `YouTube ${videoIndex}/${groups.size}: no usable captions; downloading audio for Whisper fallback.`,
        captions.length ? 'success' : 'warn',
        'Media Agent'
      );
    } catch (error) {
      report?.(orderedQuestions[0]?.sourceOrder ?? null, `Caption check skipped · ${shortError(error)}`, 'warn', 'Media Agent');
    }

    let localMatches = captions.length ? localAlignQuestions(orderedQuestions, captions, 'caption') : new Map<string, LocalAlignment>();
    const lowCaptionConfidence = orderedQuestions.some(question => {
      const match = localMatches.get(question.id);
      return !match || match.guessed || match.confidence < 0.55;
    });

    let fallbackMedia: MediaAnalysis | null = null;
    if (!captions.length || lowCaptionConfidence) {
      try {
        report?.(orderedQuestions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: preparing local audio + Whisper transcript because captions are missing/uncertain.`, 'info', 'Media Agent');
        fallbackMedia = await cachedYoutube(url);
        if (fallbackMedia.transcriptAvailable && fallbackMedia.segments.some(segment => segment.text?.trim())) {
          const whisperMatches = localAlignQuestions(orderedQuestions, fallbackMedia.segments, 'whisper');
          for (const question of orderedQuestions) {
            const captionMatch = localMatches.get(question.id);
            const whisperMatch = whisperMatches.get(question.id);
            if (!captionMatch || captionMatch.guessed || (whisperMatch && whisperMatch.confidence > captionMatch.confidence + 0.04)) {
              if (whisperMatch) localMatches.set(question.id, whisperMatch);
            }
          }
          report?.(orderedQuestions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: Whisper/local timestamp matching completed.`, 'success', 'Alignment Agent');
        } else {
          report?.(orderedQuestions[0]?.sourceOrder ?? null, `YouTube ${videoIndex}/${groups.size}: Whisper transcript unavailable; ordered audio fallback will be used where necessary.`, 'warn', 'Alignment Agent');
        }
      } catch (error) {
        report?.(orderedQuestions[0]?.sourceOrder ?? null, `Local audio/Whisper fallback unavailable · ${shortError(error)}`, 'warn', 'Media Agent');
      }
    }

    if (!localMatches.size && fallbackMedia?.segments.length) {
      localMatches = localAlignQuestions(orderedQuestions, fallbackMedia.segments, fallbackMedia.transcriptAvailable ? 'whisper' : 'caption');
    }

    for (const reference of orderedQuestions) {
      const flags: string[] = [];
      let chosen = localMatches.get(reference.id)?.segment ?? null;
      let transcript = chosen?.text?.trim() ?? '';
      const localMatch = localMatches.get(reference.id);

      if (localMatch?.method === 'caption-text') {
        flags.push('LOCAL_CAPTION_TIMESTAMP_MATCH');
        report?.(reference.sourceOrder, `Q${reference.sourceOrder}: locally matched from captions at ${Math.round(chosen!.start)}s–${Math.round(chosen!.end)}s (${Math.round(localMatch.confidence * 100)}%).`, 'success', 'Alignment Agent');
      } else if (localMatch?.method === 'whisper-text') {
        flags.push('LOCAL_WHISPER_TIMESTAMP_MATCH');
        report?.(reference.sourceOrder, `Q${reference.sourceOrder}: locally matched from Whisper at ${Math.round(chosen!.start)}s–${Math.round(chosen!.end)}s (${Math.round(localMatch.confidence * 100)}%).`, 'success', 'Alignment Agent');
      } else if (localMatch?.method === 'ordered-fallback') {
        flags.push('LOCAL_ORDERED_TIMESTAMP_FALLBACK');
        report?.(reference.sourceOrder, `Q${reference.sourceOrder}: low text overlap; source order was used as a local timestamp fallback.`, 'warn', 'Alignment Agent');
      }

      if (!chosen && fallbackMedia?.segments.length) {
        const fallback = bestSegment(reference, fallbackMedia.segments);
        chosen = fallback.segment;
        transcript = chosen?.text?.trim() ?? '';
        flags.push(fallbackMedia.transcriptAvailable ? 'LOCAL_WHISPER_FALLBACK' : 'LOCAL_AUDIO_FALLBACK');
        if (fallback.guessed) flags.push('YOUTUBE_SEGMENT_GUESSED');
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
          report?.(reference.sourceOrder, `Q${reference.sourceOrder}: exact source audio clip ready (${Math.round(chosen.end - chosen.start)}s).`, 'success', 'Media Agent');
        } catch (error) {
          flags.push(`SOURCE_AUDIO_NOT_READY:${shortError(error)}`);
          report?.(reference.sourceOrder, `Q${reference.sourceOrder}: source clip unavailable; transcript/TTS fallback remains available · ${shortError(error)}`, 'warn', 'Media Agent');
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
  report?: (question: number, message: string, level?: 'info' | 'warn' | 'success', agent?: AgentName) => void
) {
  const profiles = await listVoiceProfiles();
  const profile = profiles[0];

  for (const slot of slots) {
    const question = slot.question;
    if (!question || slot.section !== 'listening') continue;
    if (question.audioAsset) {
      report?.(slot.slot, `Q${slot.slot}: source listening clip already prepared.`, 'success', 'Media Agent');
      continue;
    }

    const youtube = youtubeFor(question);
    if (youtube) {
      report?.(slot.slot, `Q${slot.slot}: source clip missing; retrying local YouTube audio match.`, 'info', 'Media Agent');
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
        report?.(slot.slot, `Q${slot.slot}: YouTube listening clip ready (${Math.round(match.segment.end - match.segment.start)}s).`, match.guessed ? 'warn' : 'success', 'Media Agent');
        continue;
      } catch (error) {
        const text = shortError(error);
        question.qaFlags = [...new Set([...question.qaFlags, `YOUTUBE_AUDIO_PENDING:${text}`])];
        report?.(slot.slot, `Q${slot.slot}: source audio retry failed; using TTS fallback when a grounded/generated script exists · ${text}`, 'warn', 'Media Agent');
      }
    }

    if (question.listeningScript?.length && profile) {
      report?.(slot.slot, `Q${slot.slot}: generating TTS fallback audio.`, 'info', 'Media Agent');
      try {
        question.audioAsset = await generateListeningAudio(question, profile);
        report?.(slot.slot, `Q${slot.slot}: TTS audio ready.`, 'success', 'Media Agent');
      } catch (error) {
        const text = shortError(error);
        question.qaFlags = [...new Set([...question.qaFlags, `TTS_AUDIO_PENDING:${text}`])];
        report?.(slot.slot, `Q${slot.slot}: TTS audio pending · ${text}`, 'warn', 'Media Agent');
      }
    } else {
      question.qaFlags = [...new Set([...question.qaFlags, 'LISTENING_AUDIO_SOURCE_MISSING'])];
      report?.(slot.slot, `Q${slot.slot}: no usable source clip or listening script found.`, 'warn', 'Media Agent');
    }
  }
  return slots;
}
