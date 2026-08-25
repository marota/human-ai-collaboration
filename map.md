---
layout: page
title: Ecosystem map
permalink: /map/
prose_class: prose--wide
eyebrow: European landscape
deck: >-
  An interactive map of European teams and initiatives working on human-AI
  collaboration for decision-making in industrial and critical systems.
---

<div class="map-frame">
  <iframe src="{{ '/assets/map/eu-hai-map.html' | relative_url }}"
          title="Map of European human–AI collaboration teams and initiatives"
          loading="lazy"></iframe>
</div>

[Open the map full screen →]({{ '/assets/map/eu-hai-map.html' | relative_url }})
· [Source and data on GitHub](https://github.com/marota/eu-hai-collab-map)

## Why map it

The argument running through [the series]({{ '/series/' | relative_url }}) is that
human–AI collaboration in critical systems needs shared capability rather than
isolated projects. That claim is only actionable if the existing landscape is
legible: who is working on this in Europe, on which domain, with what
infrastructure, and under which framework.

This map is the attempt to make that landscape visible — so that gaps and
possible collaborations can be spotted rather than guessed at.

## What is in it

The data is organised into five layers, one YAML file per entity, plus the
consortium relationships between them. The current snapshot holds:

| Layer | Count | What it covers |
|---|---|---|
| Teams | 220 | Research labs, industrial R&D groups, operator R&D teams |
| Projects | 85 | Funded projects and programmes (Horizon Europe, SESAR, national) |
| Frameworks | 28 | Standards, regulations, guidelines, reference models |
| Commons | 21 | Open datasets, benchmarks, models, software, communities |
| Project ↔ team links | 129 | Who is in which consortium |

Infrastructure — testbeds, simulators, control-room labs, compute — is shown as
a derived layer: the teams and projects tagged with a simulation or compute
domain, rather than a separate list.

## Scope

The map is organised around a core and the ecosystem that enables it.

- **Geography** — teams and initiatives based in Europe in the broad sense,
  including the UK, Switzerland and Norway.
- **Core** — human–AI collaboration for *decision-making* in industrial and
  critical systems: manufacturing, energy and power grids, nuclear, transport,
  aviation and ATM, rail, maritime, healthcare operations, water, telecom,
  defence. Decision support, oversight, mixed-initiative, teaming — not full
  automation.
- **Ecosystem** — the enabling context the core relies on: national AI
  programmes, EuroHPC AI-factory infrastructure, networks and associations, and
  broad reference frameworks. Deliberately included so the map reads as a whole,
  but tagged so the core stays distinguishable.

Borderline cases are welcome rather than excluded.

## Contributing

The map is meant to be corrected by the people it describes. Entities are plain
YAML files validated in CI against a JSON Schema per layer, with a controlled
vocabulary and reference-integrity checks.

To add or fix an entry: copy the relevant `data/<layer>/_template.yml`, fill it
in, run `python scripts/validate_data.py`, and open a pull request. The review
bar and the taxonomy are described in the repository's `CONTRIBUTING.md`.

Code is MIT; the data under `data/` is CC BY 4.0.
