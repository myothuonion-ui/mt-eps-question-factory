# MT EPS Question Factory

Standalone teacher-side EPS-TOPIK content production system.

## Workflow

Source import -> analysis -> question extraction -> Chapter 1-60 classification -> pattern analysis -> 40-question set build -> listening/audio -> QA -> optional teacher review -> verified bank -> later Student App.

## Review policy

Review is **not a blocking gate**. The system should finish the complete 40-question set first. Teacher review is optional and can happen afterwards. Any question must be easy to edit, regenerate, or regenerate audio-only without rebuilding the full set.

## Stage 1

- Google Forms `viewscore` importer
- Detect questions, options, answer markers, images and YouTube/media links
- Normalize imported source into stable JSON
- Classify question type and likely Chapter 1-60
- Build a full 40-question set without waiting for review
- Keep provenance, QA flags and optional review metadata

This repository is separate from the existing MT EPS TOPIK admin app.
