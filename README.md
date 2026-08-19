# MT EPS Question Factory

Standalone single-user teacher-side EPS-TOPIK question production system.

## Normal workflow — one link, one button

```text
Answered Google Forms score/result link
        ↓
BUILD 40Q
        ↓
Controller Agent
        ↓
Form Agent → Structure Agent → Media/Alignment Agents → Generator Agent → QA Agent
        ↓
Reading 20 → Listening 20
        ↓
40/40 complete
        ↓
Optional Review / Local Question Bank
```

The teacher does not have to open the Listening Studio or manually split YouTube audio during normal use. Review is **never a blocking gate**. The system completes all 40 questions first; review/edit/regenerate/audio-only actions remain available afterward.

## v0.5 Controller Agent pipeline

### Form Agent

- Fetches the answered Google Forms `viewscore` / result page.
- Reads the actual DOM order instead of assuming question order from type alone.
- Extracts question stem, four choices, answer evidence, images and YouTube links.
- Runs a second `data-params` recovery pass when normal Google Forms blocks are incomplete.
- Detects `읽기` / Reading and `듣기` / Listening section headings.
- Uses YouTube placement as secondary structural evidence when headings are unavailable.

### Structure Agent

- Treats the detected Form order as the primary source of truth.
- Target EPS set is **Reading 20 first, then Listening 20**.
- Keeps structural warnings instead of silently guessing when source extraction is incomplete.
- Creates R01–R20 and L01–L20 pattern slots while retaining Q1–Q40 display order.

### Media + Alignment Agents

A unique YouTube source is analyzed once and cached for all related Listening questions:

```text
YouTube
  ↓
Timestamped captions first
  ↓
Gemini video/timestamp alignment when configured
  ↓
Low confidence / no captions?
  ↓
yt-dlp audio + optional Whisper fallback
  ↓
FFmpeg exact source clip
  ↓
Grounded transcript/TTS fallback if a source clip cannot be produced
```

`yt-dlp` is automatically bootstrapped into the local `data/tools` directory when it is not already in PATH. Whisper remains optional. FFmpeg is used for exact source clipping and normalization.

### Generator Agent

- Generates fresh questions from source pattern/context rather than copying the source wording.
- Batched requests reduce API usage.
- Gemini and GLM/OpenAI-compatible provider priority/fallback is configurable in the app UI.
- Listening generation receives the matched transcript/context when available.
- Exactly four choices and one answer are required by the generator schema.

### QA Agent

Checks each completed question for:

- non-empty stem
- exactly four unique choices
- valid answer index
- valid Chapter 1–60 assignment
- Reading/Listening section consistency
- Listening script/source and audio readiness
- possible duplicate similarity

QA flags do not stop the factory from completing the 40-question set. The teacher can optionally review flagged items afterward.

## Local API settings

The local app UI supports:

- Gemini API key + model
- GLM 5.2 / NVIDIA OpenAI-compatible key + base URL + model
- Gemini → GLM or GLM → Gemini fallback
- Cloudflare account/token/image-model configuration
- generation batch size

Keys are saved only in the local `.env` file. They do not need to be pasted into chat or committed to Git.

## Other source inputs

The existing advanced factory also keeps support for:

- ZIP
- PDF
- DOCX
- XLSX/XLS
- CSV
- TXT / Markdown / JSON
- images
- audio/video files

The primary workflow for the current project is the answered Google Form one-click Controller pipeline.

## Run on Windows

Download/extract the repository and double-click:

```text
Start-Question-Factory.bat
```

Or run manually:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:8787`.

## Local data

Runtime data stays outside Git:

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
  tools/
```

The Question Factory remains separate from the existing MT EPS TOPIK admin/student apps. A future Student App should read only the final published/approved question bank, not the teacher source workspace.
