# MT EPS Question Factory

Standalone single-user teacher-side EPS-TOPIK question production system.

## Locked workflow

`Source -> Analyze -> Complete all 40 -> Listening/QA -> Optional Review -> Local Question Bank -> later Student App`

Review is **never a blocking gate**. The system finishes the 40-question set first. The teacher can use/save it immediately, or open Optional Review and change only the questions/audio they want.

## v0.2 local factory

- Google Forms `viewscore` / result URL import.
- ZIP, PDF, DOCX, XLSX/XLS, CSV, TXT/Markdown/JSON ingestion.
- Image/audio/video files stored in the local media pool.
- Existing questions normalized into stem + options + answer + media + provenance.
- Question type and Chapter 1-60 heuristic analysis.
- 40-slot blueprint with Listening 1-20 and Reading 21-40.
- Missing slots automatically generated so the pipeline reaches 40/40.
- Pluggable AI providers: `mock`, `gemini`, `openai-compatible`.
- Non-blocking deterministic QA plus possible duplicate detection.
- Per-question edit, choices-only regenerate, full regenerate, explanation/script regenerate.
- Revision history before edits/regeneration.
- Local JSON question bank and saved exam sets under `data/`.
- Voice Profile with narrator/male/female voices, speed and pause settings.
- Windows local-system TTS (no API required) and optional OpenAI-compatible TTS adapter.
- YouTube source audio download through `yt-dlp`.
- Audio conversion/normalization/segmentation through `ffmpeg`/`ffprobe`.
- Optional local Whisper CLI transcription hook.
- Listening audio-only regeneration without rebuilding the question.
- Localhost-only server (`127.0.0.1`).

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:8787`.

The app starts in `AI_PROVIDER=mock`, so the entire UI and 40Q pipeline can be tested before any API key is added.

## Optional local tools for media/listening

Install and place these in PATH when you want their features:

- `ffmpeg` + `ffprobe` — audio conversion, normalization, cutting and assembly.
- `yt-dlp` — download the teacher's YouTube listening sources.
- `whisper` CLI — optional Korean transcription/segment timestamps.

The **Voice & Tools** screen shows whether each tool is ready.

## API provider later

Copy `.env.example` to `.env`. The current code already supports:

- `AI_PROVIDER=gemini` with `GEMINI_API_KEY`.
- `AI_PROVIDER=openai-compatible` with `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.
- `TTS_PROVIDER=local-system` for installed Windows voices.
- `openai-compatible` voice profiles using `TTS_BASE_URL`, `TTS_API_KEY`, `TTS_MODEL`.

No API provider is required to build/test the local factory now.

## Local data

Runtime data is intentionally outside Git:

```text
data/
  imports.json
  sets.json
  revisions.json
  question-bank.json
  voice-profiles.json
  uploads/
  media/
  tts/
```

This repository remains separate from the existing MT EPS TOPIK admin app. The future Student App should read only the final approved/published question bank, not the factory source workspace.
