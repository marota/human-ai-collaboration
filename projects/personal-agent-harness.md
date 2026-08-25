---
layout: page
title: Personal Agent Harness
permalink: /projects/personal-agent-harness/
prose_class: prose--wide
eyebrow: Project
deck: >-
  A two-agent rig running entirely on my own machine — one model that plans and
  verifies, one that executes — built to keep delegation legible instead of
  magical.
status: "Local setup · scripts and configuration, not a product"
image: /assets/img/projects/personal-agent-harness.svg
image_alt: >-
  Architecture in four lanes. A request reaches an orchestrator model that plans,
  splits and delegates. Each delegated sub-task starts a fresh executor with no
  history on a second model, and only its final summary returns. The
  orchestrator then verifies that summary against the artefacts before
  synthesising an answer. Both models run locally through Ollama. Alongside the
  generic path, the orchestrator can call benchmarked local capabilities.
image_caption: >-
  The two things that make it a harness rather than a chatbot: the verification
  step between summary and answer, and the capability row that lets the
  orchestrator call a benchmarked local tool instead of reasoning from scratch.
---

## The problem

Agent frameworks encourage a particular failure. You ask for something, a swarm
of sub-agents goes away, and a confident summary comes back. The summary reads
well. Whether the tests actually passed, whether the diff does what it claims,
whether the sources exist — none of that is visible in the summary, and checking
it costs more effort than accepting it.

That is [cognitive surrender]({{ '/series/01-from-augmentation-to-cognitive-surrender/' | relative_url }})
with extra steps. The more fluent the report, the less inclined anyone is to
audit it.

This setup is my attempt to run agents daily without falling into that, on
hardware I control, with the delegation boundaries written down rather than
implicit.

## What it does

Two agents, both local, on top of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
and [Ollama](https://ollama.com):

| Agent | Role | Model |
|---|---|---|
| **Orchestrator** | Understands the request, splits it, delegates, **verifies**, synthesises | `qwen3.6` |
| **Executor** | Runs one isolated sub-task and returns a summary | `gemma4` |

The orchestrator does not spawn parallel processes; it uses native delegation.
When it calls `delegate_task`, a fresh sub-agent starts with **no conversation
history** — only the goal and the context it was handed — and only its final
summary comes back. Heavy work never pollutes the main thread.

Everything speaks to Ollama's OpenAI-compatible endpoint on localhost. **No data
leaves the machine.**

## The design choices that matter

Most of the interesting content is in the constraints, not the capabilities.

**"A summary is not proof."** The orchestrator's operating instructions say so
explicitly: re-read the diffs, re-run the tests, cross-check the sources before
concluding. This is the whole reason the rig exists — the verification step is
written into the role rather than left to good intentions.

**Delegation is flat, by configuration.** `max_spawn_depth: 1` means sub-agents
cannot spawn their own sub-agents. Every unit of work is one hop from something
I can inspect. Recursive agent trees are where accountability disappears.

**Sub-agents cannot ask for clarification.** So anything requiring a judgement
call from me is explicitly *not* delegated. The rule for what to hand off is
written down: delegate multi-step reasoning and work that would flood the
context; keep single tool calls, micro-edits, and anything needing my input.

**Context is passed, never assumed.** Because sub-agents start blank, the
instructions forbid references like "fix the bug we discussed" and require
absolute paths, exact error messages, and the success criterion up front. It is
a discipline that turns out to improve my own thinking about the task.

**Bounded parallelism.** Two executors at most, and never two on the same file —
that file gets handled directly after the parallel phase.

### Dedicated capabilities, not just a generic model

The rig is not two raw models with a shell. It also carries **dedicated
capabilities** — specific tools and workflows the orchestrator can call when a
task matches one of them, rather than reasoning its way there from scratch every
time.

Those capabilities were **benchmarked before being wired in**: a tool earns its
place by measurably beating the generic path on the task it claims, not by
sounding useful. The deterministic entity tagger from
[Ambient AI Scribe]({{ '/projects/ambient-ai-scribe/' | relative_url }}), for
instance, is exposed to the harness as a callable skill — it runs in 0.4 seconds
and is exactly reproducible, which no amount of prompting a language model
matches.

The effect compounds in both directions. Any tool or application I build locally
becomes something the agents can invoke agentically, which makes the harness more
capable; and being invoked in real workflows exposes what each tool actually
needs to expose, which makes the tool better. The rig and the toolbox pull each
other forward.

That is also the honest reason this stays personal rather than productised: the
capabilities are worth what the underlying local tools are worth.

## What runs where

- `setup-hermes-agents.sh` — idempotent installer: checks Ollama, Hermes and both
  models, raises the Ollama context window to 65,536 tokens (the 4,096 default is
  far too small and produces silent truncation), configures the primary profile,
  and merges the delegation block without ever overwriting an existing one.
- `SOUL.md` — the orchestrator's role, including the verification duty.
- `config.yaml` — the delegation block: model, concurrency, iteration and timeout
  bounds, spawn depth.
- `install-autostart.sh` / `hermes-ollama-boot.sh` — a macOS LaunchAgent that
  prepares Ollama at login so the rig is warm when I open it.

## Honest limits

- This is a **personal setup, not a product**: shell scripts and configuration
  for one machine, one operating system, one pair of models.
- It is **not an evaluation harness for agents**. Individual capabilities were
  benchmarked before being connected, but the rig does not score the agents
  themselves. Nothing here measures whether the orchestrator's verification
  actually catches what the executor got wrong — which is the obvious next
  question, and the one
  [Co-Study4Grid]({{ '/projects/co-study4grid/' | relative_url }}) poses properly
  for a different task.
- The verification discipline is **stated, not enforced**. A model instructed to
  check its sub-agents can still skip the check. Treating the instruction as a
  guarantee would repeat exactly the mistake this page opens with.
- Keeping both models resident costs roughly 40 GB of VRAM. On a tighter machine
  the executor loads on first delegation instead, at a latency cost.
