---
layout: page
title: Ambient AI Scribe
permalink: /projects/ambient-ai-scribe/
prose_class: prose--wide
eyebrow: Project
deck: >-
  Turning a control-room shift handover into an annotated, seekable timeline —
  entirely on one machine, with a system that flags and proposes but never
  silently corrects.
status: "Private repository · this page is the public deliverable"
image: /assets/img/projects/ambient-ai-scribe-pipeline.svg
image_class: figure--paper
image_alt: >-
  Pipeline diagram in five stages: media ingestion; ASR with diarisation and
  word-level alignment; deterministic entity detection against a domain
  taxonomy; moment extraction with a local LLM; outputs and an interactive
  timeline. A human annotation loop feeds corrections back to bias later
  transcriptions.
image_caption: >-
  Five stages, about five minutes for a twenty-minute handover. The loop at the
  bottom is the point: confirmed human corrections bias the next run.
---

*Private repository. What follows is the method, which is what transfers.*

## The problem

A shift handover is where the state of a critical system is transferred between
two humans: what is out of service, what is being watched, what nearly happened.
Every control room runs on them — grid dispatching, air traffic, rail, water,
process plants. They are spoken, they are dense with proper nouns that carry the
meaning — asset names, identifiers, thresholds — and almost none of it is written
down in a form anyone can search afterwards.

The obvious move is to transcribe it. The trap is that a transcript of a
safety-critical conversation is only useful if you know **which parts of it to
distrust**. A 5% word error rate spread evenly across filler words is harmless;
the same rate concentrated on asset names is a hazard. Word error rate, the
field's default metric, cannot tell those two situations apart.

## What it does

The pipeline takes the raw audio or video of a handover and produces a
self-contained interactive timeline: a chronological frieze of salient moments, a
continuous transcript with karaoke-style playback, a map of the sites mentioned,
and a printable one-page handover sheet. Every timestamp seeks the source media
at the word.

It runs **entirely on one Mac** — no external API, no data leaving the machine.

| Stage | What runs | Time |
|---|---|---|
| Media preparation | ffmpeg → 16 kHz WAV, video → seekable mp4 | ~1 s |
| ASR + diarisation | whisper.cpp on Metal (×20 real time) + pyannote (×26) | ~2 min |
| Word alignment *(optional)* | wav2vec2 forced alignment (×80) | ~19 s |
| Entity detection | deterministic passes against the domain taxonomy | **0.4 s** |
| Moment extraction | qwen3:8b via Ollama, five calls | ~2 min 40 |
| Timeline render | self-contained HTML | 8 ms |
| **Core pipeline** | | **≈ 5 min for a twenty-minute handover** |

## The design rule: flag and propose, never silently correct

This is the whole point, and it is the same argument as
[Part 08]({{ '/series/08-explainable-ai-is-not-enough/' | relative_url }}) of the
series — a tool should leave the expert sharper, not more dependent.

The system **never decides alone**. It colours what it is unsure of, offers
clickable candidates, and waits. Concretely, on a twenty-minute handover: some
250 entities detected, a little over 100 matched against the gazetteer, about 50
proposed as candidates and 65 left for a human to categorise — in 0.4 seconds.

The audio re-listening step follows the same discipline. ASR systematically
reshapes unfamiliar proper nouns into common words that sound similar — a site
name becomes an ordinary noun, an identifier becomes a plausible neighbour —
which means the gazetteer is then matching against already-hallucinated text. A second model re-listens to the doubtful spans with the gazetteer in
context, and it recovers real cases. But it **only applies a correction when
corroborated** by taxonomy consensus or a gazetteer site; otherwise it proposes.
Ear and text-based candidates turn out to win *different* cases, which is
precisely why neither is allowed to auto-apply.

Confirmed human corrections flow into `annotations.jsonl`, then into the bias
vocabulary for the next transcription. The operator's expertise accumulates in
the system instead of being spent re-fixing the same name every week.

## What it measures

The project began as an honest ASR bench and kept that discipline. Beyond the
standard metrics, two were added because a control room needs them and the usual
benchmarks do not pose them:

| Metric | What it captures |
|---|---|
| WER / CER, micro-aggregated, 95% bootstrap CI | The baseline, per corpus |
| Recall and rank per entity class | Whether the *right* words were caught, not just most words |
| **Unflagged error rate** | Errors the system did **not** mark as doubtful — the ones the operator had to catch unaided. The failure mode that matters. |
| **Validation budget** | How many items the system actually puts in front of a human, and at what precision cost. The useful ceiling of 20–40 items per handover comes from the cost of attention at the end of a shift, not from taste. |
| Variance bounds over N runs | Whether a result is real or a lucky seed |

A separate, dependency-free scoring layer exists so a third party can check the
numbers: it reads published hypotheses and re-scores them without the engine, the
LLM, or any private data. Every result carries a mandatory provenance block.

## What I found

Including the results that did not go the way I wanted — those are the ones worth
publishing.

- **On clean, varied speech** (500 clips, 57 min, 203 speakers), the leading
  systems are at statistical parity around **4.6% WER**. Fine-tuning on the
  target language is the real lever, not model size.
- **"Can we halve the error rate?" — no.** LLM post-correction moved WER by
  essentially zero (4.67 → 4.66%). Part of the remaining error is label noise in
  the reference corpora, so 0% is not even the target.
- **Real meetings are about three times harder** than clean read speech
  (~16–18% versus ~4.6%). Benchmarks on read speech systematically overstate what
  you will get in an operational room.
- **A plausible combination made things worse.** VAD plus vocabulary biasing plus
  LLM post-correction degraded WER from 18.2% to 22.3%. The one real gain from
  vocabulary biasing — better proper nouns — is *invisible to WER* while being
  the thing that actually matters operationally. A metric that hides your only
  improvement is the wrong metric.
- **No audio-native model displaced the pairing** of whisper as the backbone plus
  a local LLM as an on-demand resolver, across five candidates evaluated.

## Data governance

Recordings of operators are personal data, and handover content is
operationally sensitive. The architecture is the safeguard, not a policy
document:

- **Nothing leaves the machine.** No external API at any stage — ASR,
  diarisation, entity work and moment extraction all run locally.
- **Private inputs are never versioned.** Handover audio and video, the
  operational taxonomy, and every artefact derived from private audio —
  transcripts, moments, annotations, re-encoded media — are gitignored by
  construction. Only code, documentation and results on public corpora are
  committed.
- **Identities are handled outside the repository.** The lists used to strip real
  names, single-person role designations and excluded phrases are local files,
  explicitly gitignored.
- **Measurement output is aggregated by default.** The evaluation harness emits
  counts and rates; the underlying surfaces and corrections are only written with
  an explicit flag, to a path outside the repository, and are never versioned.
- **Credentials are read from a local file**, never written into the repository.

## Limitations

- The reference for real-meeting WER is **agreement with another tool's
  transcript**, not human ground truth. It bounds disagreement, not correctness.
- Diarisation **undercounts speakers** unless the expected count is supplied.
- The optional audio-correction pass costs roughly **an hour** for a
  twenty-minute handover. It is deliberately asynchronous and off the critical
  path, but it is not something to promise in a live setting.
- Long-format ASR needed a specific fix — without disabling conditioning on
  previous text, whisper.cpp loops and truncates on long files. Worth knowing
  before trusting any long-form transcript.
- Everything here is measured on **one language, one domain, one room**. The
  method transfers; the entity layer does not, because it is only as good as the
  domain taxonomy behind it — that has to be rebuilt for each setting.
