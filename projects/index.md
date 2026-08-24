---
layout: page
title: Projects
permalink: /projects/
---

Working code and evaluation protocols behind the arguments in the series.

These pages describe **what is measured and how**, independently of whether the
code itself is public. For evaluation work, the protocol is the contribution: a
reader should be able to judge the method, reproduce the reasoning, and see where
it stops being valid.

---

### [hermes-agent-harness]({{ '/projects/hermes-agent-harness/' | relative_url }})
An evaluation harness for LLM-based agents.

### [Ambient AI Scribe]({{ '/projects/ambient-ai-scribe/' | relative_url }})
A speech-to-text pipeline for control-room operations.

---

## Related open environments

Evaluation environments I have designed or co-maintained elsewhere:

- **[Grid2op](https://github.com/Grid2op)** — the reinforcement learning environment
  and evaluation infrastructure behind the L2RPN challenge series, including
  *L2RPN with Trust*, which scores agents on raising an alert when their own
  confidence in handling an upcoming contingency is low.
- **[LIPS](https://github.com/IRT-SystemX/LIPS)** — a multi-domain benchmark suite
  for developing and evaluating AI physical simulators (NeurIPS 2022).
- **[InteractiveAI](https://github.com/IRT-SystemX/InteractiveAI)** — a bidirectional
  multi-domain operator assistant framework.
