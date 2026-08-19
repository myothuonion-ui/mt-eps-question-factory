# MT EPS Question Factory — Controller Agent Architecture

## Goal

One teacher action should be enough for the normal workflow:

```text
Answered Google Forms score/result link
        ↓
BUILD 40Q
        ↓
40 fresh EPS-TOPIK questions
Reading 20 → Listening 20
```

The agents are deterministic workflow workers, not free-running autonomous agents. The Controller owns state, order, progress, fallback and final save.

## Agent order

1. **Controller Agent** — starts the job, hands work to workers, saves final output.
2. **Form Agent** — extracts questions, choices, answer evidence, images, section headings and YouTube sources.
3. **Structure Agent** — determines the actual Reading/Listening order from Form evidence and builds the 40-slot plan.
4. **Media Agent** — groups unique videos, checks captions, downloads/cache media when needed, creates clips/TTS.
5. **Alignment Agent** — maps each Listening question to the best timestamp/transcript with confidence and fallback evidence.
6. **Generator Agent** — creates fresh questions in batches using the source pattern/context.
7. **QA Agent** — validates structure, answer, chapter, section, audio and duplicates.
8. **Controller Agent** — saves the complete 40Q set. Review is optional afterward.

## Section rules

The source Form is expected to contain Reading first and Listening after the YouTube/listening source. The parser therefore uses evidence in this order:

1. explicit `읽기` / Reading and `듣기` / Listening section headings
2. actual DOM order
3. YouTube position as a section boundary clue
4. EPS fallback only when structural evidence is incomplete: Reading Q1–Q20 → Listening Q21–Q40

A YouTube iframe must never cause earlier Reading questions to be reclassified as Listening merely because the URL exists globally on the page.

## Hybrid Listening pipeline

For every unique YouTube URL:

```text
caption/subtitle timestamps
        ↓
Gemini video semantic/timestamp alignment when available
        ↓
confidence check
        ↓
local yt-dlp audio + optional Whisper fallback when needed
        ↓
question ↔ timestamp/transcript match
        ↓
FFmpeg exact clip
        ↓
grounded transcript/TTS fallback if clip is unavailable
```

The same video analysis is cached and reused by every related Listening question. It must not be downloaded/analyzed once per question.

## Provider responsibilities

- **Gemini** — Form/image/video understanding, semantic timestamp alignment, optional generation/verification.
- **GLM 5.2 / OpenAI-compatible** — fresh question generation and fallback generation.
- **yt-dlp** — captions/audio acquisition. The app can bootstrap a local binary into `data/tools`.
- **Whisper** — optional Korean transcription fallback.
- **FFmpeg** — exact clip cutting, resampling and loudness normalization.
- **Cloudflare** — configured for future/image question generation; it is not required for text/listening-only sets.

## Failure policy

A single optional tool/provider failure should not destroy the full job:

- Gemini quota failure → use captions/local transcription and GLM generation when configured.
- No captions → Gemini video or Whisper fallback.
- No Whisper → use available captions/Gemini transcript or conservative fallback.
- Source clip unavailable → grounded/generated TTS fallback.
- QA problem → attach a flag and finish 40/40; teacher review stays optional.

Only failures that make it impossible to create a valid question payload should stop the job.

## Progress model

Every job exposes:

- overall percent
- current Agent
- current Q number/stage
- current AI provider
- provider fallback count
- source summary: references, Reading, Listening, answers, YouTube
- per-question timestamped logs

The UI should make it obvious what is happening without requiring the teacher to open terminal logs.

## Output rule

The generated set is fresh content. Source questions teach structure, difficulty and context; they are not simply copied.

Final lifecycle:

```text
Source → Agent Analysis → Fresh 40Q → QA → 40/40 complete → Optional Review → Local Bank → later Student App
```
