---
layout: page
title: Co-Study4Grid
permalink: /projects/co-study4grid/
prose_class: prose--wide
eyebrow: Project
deck: >-
  A study environment for human-AI joint decision-making on a power grid — where
  the recommender is pluggable and every operator interaction is logged.
status: "Public repository · MPL-2.0"
image: /assets/img/projects/co-study4grid-study.jpg
image_alt: >-
  The Co-Study4Grid interface. A left panel shows the selected contingency, the
  resulting N-1 overload, and a feed of suggested remedial actions each labelled
  with the line loading it would achieve. The main view is a transmission network
  across the French-Spanish border, with flows coloured green and red and the
  contingency highlighted in yellow.
image_caption: >-
  A study in progress on the French-Spanish border: one contingency, one
  resulting overload, and the ranked remedial actions the operator can inspect,
  simulate and triage.
---

[github.com/marota/Co-Study4Grid](https://github.com/marota/Co-Study4Grid)

## The problem

Most evaluations of AI decision support score the *model*: does the recommender
find a good remedial action? That measures the wrong thing. What matters in a
control room is the joint outcome — whether the operator, working with the
assistant, reaches a better decision than either would alone, and whether their
own expertise grows or erodes in the process.

To measure that, you need an environment where a real expert task can be run
end-to-end, where the AI component can be swapped without changing anything
else, and where what the human actually did is recorded rather than inferred.

## What it does

Co-Study4Grid is a full-stack application for contingency (N-1) analysis on a
power network. An operator selects a contingency, the system detects resulting
overloads, and prioritised remedial actions are streamed for the operator to
inspect, simulate, combine, and triage — topology changes, phase-shifting
transformer adjustments, renewable curtailment, load shedding, and redispatch.

Four synchronised views (network, contingency, remedial action, overflow
analysis) render as interactive network-area diagrams, with drill-down to
single-line diagrams. Actions appear as pins on the network, coloured by the
operator's own triage decisions.

The backend is Python and FastAPI, using pypowsybl for simulation and load flow;
the frontend is React and TypeScript.

## Supportive by design, not substitutive

The tool deliberately follows the *supportive framework mindset* from the
AI4RealNet project: **empowering and supporting the user in developing their
expertise rather than automating it**. This is the distinction drawn in
[Part 08]({{ '/series/08-explainable-ai-is-not-enough/' | relative_url }}) of the
series — same accuracy on a one-time benchmark, opposite effect on the expert
over time.

### Make a first guess, then ask

The most important mechanism is also the smallest one on screen. Before the
operator can call on the assistant, the interface invites them to **commit to
their own hypothesis and proposed action** — *Make a first guess* sits above
*Analyze & Suggest*, not after it.

<figure class="figure figure--narrow">
  <img src="{{ '/assets/img/projects/co-study4grid-first-guess.png' | relative_url }}"
       alt="The Simulated Actions panel. A prominent dashed button reading 'Make a first guess' appears above the 'Analyze & Suggest' button, which fetches AI suggestions.">
  <figcaption>The operator states a hypothesis before the assistant is allowed to answer.</figcaption>
</figure>

This ordering is deliberate. Asking the expert to reason first mobilises their
cognitive engagement and exercises the judgment that would otherwise atrophy —
directly countering the erosion of persistence described in
[Part 02]({{ '/series/02-when-new-learners-lean-on-ai/' | relative_url }}), where
the harm fell on those who asked the AI to solve the problem, and not on those
who used it for hints. It also gives the study a baseline it could not otherwise
have: what the operator would have done unaided, recorded before the
recommendation could anchor them.

The rest of the design follows the same logic:

- The workflow is **two-step**: overloads are detected first, and suggestions are
  streamed only *after* the operator selects which ones to address. The operator
  frames the problem; the AI does not.
- Actions are **inspectable before they are accepted** — click to see the
  post-action diagram, the affected lines, and the impacted assets.
- The **overflow graph is exposed**, not just the verdict: constrained path,
  red-loop, overloads, hubs, production and consumption nodes are all
  individually toggleable layers.
- Triage is **the operator's**, recorded explicitly as selected or rejected.

## What it makes measurable

The point of the harness is that the interesting quantities are recorded rather
than reconstructed after the fact.

| What is captured | How | Why it matters |
|---|---|---|
| The operator's own first guess | Recorded before any suggestion is shown | An unanchored baseline: what the expert would have done alone |
| Every UI interaction | `interaction_log.json`, with correlation IDs | Reconstructs the decision path, not just the outcome |
| Which recommender was active | Session state records the active model | Lets the same task be run against different AI behaviours |
| Operator triage | Explicit select / reject per action | Separates what the AI proposed from what the human accepted |
| Full analysis state | Timestamped session export | Config, contingency, combined pairs, loading ratios |
| Timed performance | Game mode exports `game_session.json` | Scored runs under time pressure, for Codabench |

Because the recommender is a pluggable contract, the *same* operator task can be
re-run against a different AI without touching the interface — three baselines
ship with the codebase (Expert, Random, Random-Overflow). That is what makes the
comparison a study of the partnership rather than a benchmark of the model.

## Reproducibility

- **Interaction log** is replay-ready and suitable for deterministic browser
  automation, so a recorded human session can be re-executed.
- **Sessions** export complete state to timestamped folders and reload.
- **Scenario families** are fixed: a pan-European reference set derived from
  PyPSA-EUR, and a France THT set of 656 N-1 scenarios on real French
  transmission, graded easy / medium / hard.
- **Deployment** is a single Docker container serving frontend and backend
  same-origin, also published as a HuggingFace Space.

## Limitations

- The environment measures a **single operator at a workstation**. Real control
  rooms are collective, and the handovers and cross-checks between operators —
  where much of the actual safety margin lives — are outside its scope.
- Game mode imposes **time pressure and an action budget** (≤3 actions per
  study). That makes runs comparable and scorable, but it is not the tempo of a
  real shift.
- Sessions are **short**. The erosion effects discussed in
  [Part 01]({{ '/series/01-from-augmentation-to-cognitive-surrender/' | relative_url }})
  and [Part 02]({{ '/series/02-when-new-learners-lean-on-ai/' | relative_url }})
  play out over much longer horizons than a single study.
- Simulation is **AC with DC fallback** on convergence failure; scenarios where
  that fallback engages are not physically equivalent to the ones where it does
  not.

## References

- **Marot, A., Donnot, B., et al.** — *Expert system for topological remedial action
  discovery in smart grids.* MEDPOWER, 2018.
- **Marot, A., Rozier, A., et al.** — *Towards an AI assistant for human grid
  operators.* HHAI, Amsterdam, 2022.
- **Marot, A., Donnot, B., et al.** — *Superposition Theorem for Flexible Grids.*
  IEEE Transactions on Power Systems, 2025.
- **Leyli-abadi, M., Bessa, R., et al.** — *A Conceptual Framework for AI-based
  Decision Systems in Critical Infrastructures.* AI4RealNet, 2025.
- **Wäfler, T., Hamouche, S., et al.** — *The Supportive AI Framework: From
  Recommending to Supporting.* Lecture Notes in Computer Science, Springer,
  AI4RealNet, 2025.
