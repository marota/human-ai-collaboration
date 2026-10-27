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
  <iframe src="{{ '/assets/map/eu-hai-map.html?lang=en' | relative_url }}"
          title="Map of European human–AI collaboration teams and initiatives"
          loading="lazy"></iframe>
</div>

[Open the map full screen →]({{ '/assets/map/eu-hai-map.html?lang=en' | relative_url }})
· [Version française]({{ '/assets/map/eu-hai-map.html?lang=fr' | relative_url }})
· [Source and data on GitHub](https://github.com/marota/eu-hai-collab-map)

**A collaborative map.** Anyone can add to it or correct it. Press **Chat** on
the map, say what is missing or wrong, and the chat helps you turn it into a
proposal that is reviewed in the open before it joins the map —
[how it works](#a-collaborative-map).

The map is bilingual: the **EN / FR** switch in its top-right corner changes the
interface *and* the description of every entity on the map. Your choice is
remembered.

The **Period** slider in the top-right cluster, alongside the other controls,
narrows the map to a range of years, so the landscape can be read as it stood in
2016–2021 rather than all at once. It runs from 1945 to the map's own freshness
date — the ⓘ next to it names that date — rather than out to whichever funded
project happens to end furthest in the future; a project funded through 2032
still shows as present today, the axis just stops stretching to show it.

The histogram behind the slider counts how many dated entities were running
each year — the shape of the field's growth, in effect. An entity is kept when
its span overlaps the selection; no recorded end date means "still running".
Start years were researched for the 199 entities that had none — founding dates
of labs, operators and standards, each recorded in the entry's provenance with
its source and a confidence level. Of those, 23 turned out to have only their
*host institution's* founding year on record rather than their own — that year
becomes a floor, not a start: the entry is shown as certainly present in the
2020s, only possibly so back to the year its host was founded, and never before
it. A further 14 entities carry no date at all and are treated the same way,
with no floor. Both groups are kept by default and can be dropped with the
*undated* checkbox. The few real foundings older than 1945 — Philips, the ASEA
and Siemens laboratories, Radboud University — stay included in any range that
reaches the floor. Narrowed periods travel in the shareable link.

The four counters in the side panel follow the **viewport**: zoom in and they
count what is actually on screen, with the number matching the filters as a
caption. When the two differ, the caption says why, in the two ways they can:
how many markers are simply *off screen* at the current zoom, and how many sit
*off the map* altogether — the international standards under **Off the map**
have no marker to zoom in on. The **Feed** column on the right lists those same
entities, in layer order, and repeats both figures next to its own header, each
one a shortcut: click the off-screen count to zoom back out until they all fit,
or the off-map count to jump straight to the **Off the map** list. Selecting a marker expands its card in the feed and
scrolls it into view;
clicking a row expands the card and highlights the marker without moving the
map. The column can be hidden with the *Feed* pill — the card then opens as a
floating panel instead.

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

<ul class="tiles">
  <li><strong>274</strong><span>Teams</span><em>Research labs, industrial R&amp;D groups, operator R&amp;D teams</em></li>
  <li><strong>115</strong><span>Projects</span><em>Funded projects and programmes — Horizon Europe, SESAR, national</em></li>
  <li><strong>45</strong><span>Frameworks</span><em>Standards, regulations, guidelines, reference models</em></li>
  <li><strong>26</strong><span>Commons</span><em>Open datasets, benchmarks, models, software, communities</em></li>
  <li><strong>303</strong><span>Links</span><em>Which team sits in which project consortium</em></li>
  <li><strong>27</strong><span>Countries</span><em>Europe in the broad sense, including UK, CH and NO</em></li>
</ul>

Infrastructure — testbeds, simulators, control-room labs, compute — is a layer
of its own in the data (41 entries), but it has no markers of its own. Where a
facility is run by a team already on the map, it enriches that team's card with
its operator, access model and capacity; the 18 sites with no team of
their own carry a marker in the Teams layer.

Sixteen entities have no coordinates and so no pin, because none has one place
in Europe to put it: the international standards (ISO 9241-210, IEC 61508,
IEEE 7000, SAE J3016, ARP6983/ED-324, the NIST AI RMF), the founding
human–automation models (Fitts' List, Sheridan &amp; Verplank, Parasuraman,
Sheridan &amp; Wickens, Lee &amp; See on trust, Klein's ten challenges, Endsley's
situation awareness), reference frameworks from outside Europe (Shneiderman's
human-centred AI, STAMP/STPA, value-sensitive design), and one non-European
commons. They are listed under **Off the map** in the side panel, and their
cards read like any other.

Clicking a marker opens a card built from the whole record, not a summary of it:
description, focus areas, timeline and milestones, consortium with each
partner's role and country, funding source and budget, licence and maintainer
for a commons, jurisdiction and issuing body for a framework — and, at the
bottom, who added the entry, when, and with what confidence.

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

## A collaborative map

The map is meant to be completed and corrected by the people it describes — and
by anyone who knows a team, a project, a commons or a framework it is missing,
or an entry it gets wrong. Every contribution is reviewed before it appears, and
the review happens in the open, on GitHub.

### With the chat

Press **Chat** in the map's top-right controls — or *Propose it with the chat*
under the map's title — and say what is missing or wrong, in English or in
French. The chat takes it from there, with you:

1. **The source.** You give the page that documents what you are proposing. The
   chat reads it and tells you whether it actually names it — a page about
   something else is better caught now than in review.
2. **The card.** It drafts the entry from that page, and you correct it on the
   spot: the fields, the vocabulary, the place, and the YAML it will become.
   This is the point of doing it in the chat: you are there to answer, and
   what you fix in thirty seconds would take a maintainer far longer to
   reconstruct.
3. **The issue.** You read the exact GitHub issue it will open, then send it.
   Nothing has changed on the map at that point.
4. **The review.** A maintainer checks the proposal — that it fits the map's
   scope, that a public source backs every claim, that it uses the map's
   vocabulary, that the coordinates point at the right place — and turns it
   into a change to the map's data. The map is regenerated from it.

The chat runs a language model on the maintainer's own machine, not on a cloud
service, and answers from the map's cards and nothing else. When that machine is
off, the chat says so — and an issue opened directly, below, does the same job.

What you type stays private unless you make it a proposal. The server keeps no
record of conversations — only the address a request came from, to apply
per-visitor limits — and your browser keeps the conversation on your side. A
proposal's issue is public, and it includes the conversation it came from: you
see it in full before you send it.

### Directly on GitHub

Open [an issue](https://github.com/marota/human-ai-collaboration/issues/new) on
this site's repository, in your own words, with the page that documents it —
the route the chat automates.

### How a change reaches the map

The data lives in a separate repository, `eu-hai-collab-map`: one YAML file per
entity, validated in CI against a JSON Schema per layer, a controlled vocabulary
and reference-integrity checks. The copy embedded in this site is generated from
those files — never edited by hand. To pull in a change:

```
git clone https://github.com/marota/eu-hai-collab-map.git ../eu-hai-collab-map
python3 scripts/build-map-data.py --source ../eu-hai-collab-map
```

Code is MIT; the data under `data/` is CC BY 4.0.

How the interface itself works — the data pipeline, the visual language, the
filtering model, and the invariants a change must not break — is written up in
the [interface specification](https://github.com/marota/human-ai-collaboration/blob/main/docs/map-interface-spec.md).
