---
layout: page
title: Projects
permalink: /projects/
prose_class: prose--wide
eyebrow: Code and protocols
deck: >-
  Working code, evaluation protocols and open competitions behind the arguments
  in the series.
---

These pages describe **what is measured and how**, independently of whether the
code itself is public. For evaluation work, the protocol is the contribution: a
reader should be able to judge the method, reproduce the reasoning, and see where
it stops being valid.

## Projects I develop

Built by me, and opened to the community where the code allows it.

<ul class="cards">
  <li>
    <a class="card" href="{{ '/projects/co-study4grid/' | relative_url }}">
      <h3 class="card__title">Co-Study4Grid</h3>
      <p class="card__text">A study environment for human–AI joint decision-making on a power grid. Open source, MPL-2.0, contributed to AI4RealNet.</p>
      <span class="card__cta">Read the protocol <span aria-hidden="true">→</span></span>
    </a>
  </li>
  <li>
    <a class="card" href="{{ '/projects/personal-agent-harness/' | relative_url }}">
      <h3 class="card__title">Personal Agent Harness</h3>
      <p class="card__text">A two-agent rig running fully offline — one model plans and verifies, one executes.</p>
      <span class="card__cta">Read the protocol <span aria-hidden="true">→</span></span>
    </a>
  </li>
  <li>
    <a class="card" href="{{ '/projects/ambient-ai-scribe/' | relative_url }}">
      <h3 class="card__title">Ambient AI Scribe</h3>
      <p class="card__text">A shift handover turned into an annotated, seekable timeline — 100% local, flags and proposes, never silently corrects.</p>
      <span class="card__cta">Read the protocol <span aria-hidden="true">→</span></span>
    </a>
  </li>
  <li>
    <a class="card" href="https://github.com/marota/eu-hai-collab-map">
      <h3 class="card__title">EU Human-AI Collaboration Map</h3>
      <p class="card__text">An open, contributable map of the European ecosystem — teams, projects, infrastructure, frameworks and commons.</p>
      <span class="card__cta">See the map <span aria-hidden="true">→</span></span>
    </a>
  </li>
</ul>

## Collective environments

Open evaluation environments I have designed or co-maintained **with others** —
these belong to their communities, not to me.

- **[Grid2op](https://github.com/Grid2op)** — the reinforcement learning environment
  and evaluation infrastructure behind the L2RPN challenge series, including
  *L2RPN with Trust*, which scores agents on raising an alert when their own
  confidence in handling an upcoming contingency is low. Stewarded under
  [LF Energy](https://lfenergy.org/).
- **[LIPS](https://github.com/IRT-SystemX/LIPS)** — a multi-domain benchmark suite
  for developing and evaluating AI physical simulators (NeurIPS 2022), with
  IRT SystemX.
- **[InteractiveAI](https://github.com/IRT-SystemX/InteractiveAI)** — a bidirectional
  multi-domain operator assistant framework, with IRT SystemX.

## Open challenges

Competitions are how a protocol gets stress-tested by people who did not write
it. These are the campaigns this work has been built around.

- **[L2RPN](https://l2rpn.chalearn.org/)** — *Learning to Run a Power Network.* An
  international competition series run since 2019 on Grid2op, hosted at NeurIPS,
  IJCNN and WCCI. Successive editions moved the target from raw performance to
  robustness, and then to **L2RPN with Trust**, which scores an agent on whether
  it raises an alert when its own confidence is low — an explicit attempt to make
  calibrated self-doubt a measured quantity rather than a claimed one.
- **[AI4RealNet](https://ai4realnet.eu/)** — the Horizon Europe consortium on
  trustworthy AI across power, rail and air traffic. Its **Sim2Real Challenge**
  (2026, led by RTE and TenneT, hosted on
  [Codabench](https://www.codabench.org/)) scores AI assistants for real-time
  congestion management on their ability to hold up under real-world operating
  conditions rather than in simulation alone.
<!-- TODO: AINETUS — completer une fois le nom exact et le perimetre confirmes
     (nom officiel, domaine, annees, organisateurs, lien). Voir note dans la
     conversation : reference non verifiable en l'etat. -->

A wider view of the European landscape these sit in — who works on what, where —
is on the [ecosystem map]({{ '/map/' | relative_url }}).
