# Ecosystem map — interface specification

The European human–AI collaboration map published at `/map/`. This document is
the reference for anyone changing `assets/map/eu-hai-map.html` or
`scripts/build-map-data.py`: what the interface is meant to do, how each part
works, and which properties a change must not break.

Companion documents: [`CONTRIBUTING.md`][contrib] in the data repository (how to
add or fix an entity) and [`SPECIFICATIONS.md`][specs] (the data model and the
editing app, of which this page is a read-only consumer).

[contrib]: https://github.com/marota/eu-hai-collab-map/blob/main/CONTRIBUTING.md
[specs]: https://github.com/marota/eu-hai-collab-map/blob/main/SPECIFICATIONS.md

---

## 1. Purpose and scope

The map answers one question: **who works, across Europe, on human–AI
collaboration for decision-making in industrial and critical systems, and how
are they connected?**

It is a *reading* surface, not an editing one. Curation happens in the data
repository through pull requests; this page renders a snapshot.

Three design commitments follow from that, and they constrain everything below.

- **Legibility over completeness of display.** Four hundred-odd entities cannot all be read
  at once. Every feature — filters, period, feed, counters — exists to let a
  reader carve out a subset small enough to actually read.
- **Traversal over search.** The interesting structure is relational: which team
  sits in which consortium, who built which benchmark. Cards are navigable, and
  the neighbourhood of a selection is highlighted on the map.
- **No dependencies.** The page loads three local files and nothing else. No
  CDN, no tiles, no fonts, no analytics. It works offline, from `file://`, and
  will still work when today's map libraries are gone.

**Non-goals.** Editing, authentication, server round-trips, real-time data,
routing, and anything requiring a network at view time.

---

## 2. Architecture

| File | Size | Role |
|---|---|---|
| `assets/map/eu-hai-map.html` | ~1 800 lines | The whole interface: markup, CSS, logic. Hand-written, no build step. |
| `assets/map/hai-data.js` | ~950 kB | **Generated.** The entity payload plus the label vocabulary. |
| `assets/map/europe-geo.js` | ~49 kB | Natural Earth country outlines, pre-projected. Regenerable, rarely changes. |

Both data files assign to `window` (`HAI_DATA`, `HAI_GEO`) and are loaded with
plain `<script src>` before the inline module. The page is a single document
with no imports, so it can be opened directly from disk.

The site embeds it in an `<iframe>` from [`map.md`](../map.md); the same file is
also the full-screen version. There is no separate build for the two.

---

## 3. Data pipeline

```
eu-hai-collab-map/data/**.yml   ← source of truth, PR-reviewed, CI-validated
        │
        │  scripts/build-map-data.py --source <checkout>
        ▼
assets/map/hai-data.js          ← generated, committed, never hand-edited
        │
        ▼
assets/map/eu-hai-map.html      ← reads window.HAI_DATA
```

Regenerating:

```bash
git clone https://github.com/marota/eu-hai-collab-map.git ../eu-hai-collab-map
python3 scripts/build-map-data.py --source ../eu-hai-collab-map
```

The source path also comes from `$EU_HAI_MAP_REPO` or a few conventional
sibling locations. The only dependency is PyYAML. The generator prints a summary
— entities per layer, entities without coordinates, longest description — so a
regression is visible at a glance. **Output is byte-stable across runs**, so a
no-op regeneration produces an empty diff.

### 3.1 What the generator must preserve

These are load-bearing. A change that breaks one of them silently moves or
recolours markers, which readers will not notice as a bug.

1. **Marker geometry and colour are derived exactly as the legacy
   `sync_html_map.py` derived them.** The `SECTOR`, `APPROACH` and `INFRA_KIND`
   tables are copied verbatim and must stay that way. Regeneration after a data
   change should alter only the entities that changed.
2. **`digital_twins` is never mapped to `simulation`.** The compute / cluster /
   simulation codes are infrastructure categories and come only from the
   infrastructure layer. Otherwise every operator using digital twins would
   wrongly appear under the research-infrastructure filters.
3. **Descriptions are not truncated.** The predecessor capped them at 300
   characters, cutting 29 English and 39 French descriptions mid-word. Paragraph
   breaks are preserved; wrapped lines are re-joined.
4. **Entities without coordinates are kept**, flagged `geo: false`, not dropped.

### 3.2 Layers

Counts are a snapshot (3 September 2026) and move with every upstream
regeneration; the shape of the table is what is normative, not the figures.

| Layer | Count | Marker | Origin |
|---|---:|---|---|
| Projects & programmes | 111 | large circle | `data/projects/` |
| Teams | 264 | small circle | `data/teams/` + infrastructure with no matching team |
| Commons | 25 | dashed circle | `data/commons/` |
| Frameworks | 45 | square | `data/frameworks/` |
| Links | 295 | curved edge | `data/edges.yml` |

**Infrastructure has no layer of its own**, by design. Of its 41 entries, 23
describe a facility run by a team already on the map: they enrich that team's
card with operator, access model and capacity, and add their infrastructure
domain code to its marker, without creating a duplicate pin. The other 18 are
rendered as team markers. This keeps "who is doing the work" and "what they run
it on" in one place.

### 3.3 Entity fields

Common to every layer:

`id` · `name` · `city` · `country` · `lat` · `lon` · `domain` (lead, drives
colour when single) · `domains[]` (drives the pie slices and the filters) ·
`url` · `desc` / `desc_fr` / `desc_en` · `focus[]` (raw focus-area keys) ·
`status` · `tier` · `timeline{start,end,milestones[]}` · `dateConf` ·
`dateHost` · `links{papers[], linkedin, twitter, docs, official}` ·
`prov{by,on,upd,src,conf}` · `geo` (only when false).

`dateConf` and `dateHost` are derived, not authored: the generator parses them
out of the provenance note (§10).

Per layer, additionally:

- **Projects** — `kind`, `when` (compact span for tooltip and print), `budget`
  (legacy alias), `funding{source,call,grant,eur,url}`,
  `consortium[{org,role,country,ref}]`, `demos[]`, `delivs[]`.
- **Teams** — `type`, `affiliation{org,parent,url}`, `facilities[]`,
  `infra{kind,operator,access,capacity,hosts[]}` when an infrastructure entry
  merged in.
- **Frameworks** — `kind`, `subSection`, `jurisdiction`, `issuer{org,url}`,
  `legal`, `adopted`, `appliesTo[]`, `refs[]`, `createdBy[]`, `usedBy[]`.
- **Commons** — `kind`, `subSection`, `license`, `maintainer{org,url}`, `repo`,
  `size`, `createdBy[]`, `usedBy[]`.

`consortium[].ref` is dropped when it does not resolve to a known entity, so the
card never renders a dead link.

### 3.4 Vocabulary

`DATA.TAXO` carries English and French labels for every controlled value:
`focus`, `type`, `kind`, `status`, `tier`, `access`, `legal`, `role`,
`jurisdiction`, `confidence`. English comes from `data/taxonomy.yml`; French is
a hand-written table in the generator. An unmapped key falls back to its
de-underscored form, so a new vocabulary entry degrades to readable text rather
than breaking.

### 3.5 Freshness

`DATA.AS_OF` is one ISO date: the most recent `provenance.last_updated` /
`provenance.added_on` across every entity in every layer. It is the only
data-derived (not wall-clock) notion of "now" the page has, and it drives two
things — the period filter's upper bound and its freshness bubble (§10.0).

---

## 4. Visual language

### 4.1 Projection and basemap

Lambert azimuthal equal-area, λ₀ = 10°E, φ₁ = 52°N, onto a 1000 × 710 canvas.
Equal-area matters: the map compares *densities* of activity, and a Mercator
would inflate the Nordics against Iberia and Italy.

Geometry is pre-projected in `europe-geo.js`, so the runtime does one
trigonometric pass over the entity coordinates and nothing else. Twenty capital
labels give orientation without a label layer.

### 4.2 Markers

**Shape encodes the layer, colour encodes the domain.** They are independent
channels, and they must stay independent.

| Layer | Radius | Shape |
|---|---:|---|
| Project | 8.5 | circle |
| Commons | 7.5 | circle, dashed stroke |
| Framework | 6 | rounded square |
| Team | 4.5 | circle, thinner stroke |

A multi-domain entity is drawn as **equal pie slices**, one per domain (vertical
bands for the square). This is deliberately not a "primary domain plus badges":
an entity working across energy and rail is not primarily either, and the
reader should see the split at marker size.

Seventeen domain colours in three filter groups:

- **Industrial** — energy, aviation, rail, transport, telecom, utility, health,
  manufacturing, maritime, nuclear, defence
- **Research focus** — human factors, XAI, multi-agent/other
- **Research infrastructure** — compute, AI networks, socio-technical simulation

Draw order is `team → commons → framework → project`, so the large, sparse
markers sit above the dense small ones.

Co-located entities are **jittered** by 0.18° on a circle, per layer group, so a
city with eight labs shows eight markers rather than one. This is applied once,
before projection, and is therefore stable across sessions.

### 4.3 Edges

Quadratic curves, offset perpendicular to the chord by `min(34, 0.14 × length)`
so that reciprocal links do not overlap. Colour follows the source entity's lead
domain. Consortium links are solid; "used by" links are dashed.

**Adjacency and geometry are separate.** `relate()` always records the
relationship in the `neighbors` map — which drives card navigation and
neighbourhood highlighting — but only pushes a drawable edge when both ends have
coordinates. An entity off the map still participates in the graph.

Consortium links are drawn from `edges.yml`; created/used links come from the
commons and framework cross-references.

### 4.4 Zoom thresholds

| Level | Effect |
|---|---|
| `k₀ × 0.7` | minimum zoom |
| `k₀ × 1.22` | fit-to-view default |
| `k₀ × 1.7` | capital labels appear |
| `k₀ × 3.2` | minimum level when flying to a selected entity |
| `k₀ × 4.2` | marker labels appear |
| `k₀ × 30` | maximum zoom |

`k₀` is the scale that fits the whole canvas, so thresholds are relative to the
viewport and behave the same on a phone and a wide monitor. Markers are drawn at
constant screen size by counter-scaling each one by `1/k`; the counter-scale
pass is skipped when `k` moved less than 0.1 %, which keeps panning free of
layout work.

---

## 5. Layout

Three columns in a CSS grid, `312px | 1fr | 344px`:

- **Left — controls.** Identity, counters, search, starting views, layer
  toggles, domain filters, links toggle, off-the-map list, My map, help.
- **Centre — the map.** Floating control clusters at the four corners; the
  top-right cluster holds the period slider and the mode pills.
- **Right — the feed.** Optional; collapses to zero columns when hidden.

Below 840 px the sidebar and the feed become overlay drawers, the top-right
cluster wraps to two rows, and the detail panel docks to the bottom of the
screen.

**All controls the reader acts on live in the top-right cluster.** Filters that
configure the view live in the left panel. That split is the reason the period
slider was moved out of the bottom bar: there should be one place to look for
interactions.

**The period pill has a fixed width budget, on purpose — and the cluster
around it does too.** `.ctl-tr` is absolutely positioned with `right` but no
`left`, so nothing stops an unconstrained child from growing leftward — past
the sidebar's edge and into `#stage`'s `overflow:hidden`, where it is clipped
rather than overlapping anything. That happened twice, at two different
layers of the same box:

1. The pill grew a second batch of content (the *unknown start* toggle and
   the reset button) onto its one row only once a range was picked, and the
   wider pill clipped behind the sidebar. Fixed structurally: the pill is two
   flex rows (`.tf-row`, always the slider; `.tf-row2`, the toggle and reset,
   `hidden` until engaged) under a column with a `max-width`, so engaging the
   filter grows the pill **downward**, never sideways.
2. That `max-width` was first set to 320px, guessed rather than measured —
   about 50px short of what "PERIOD" + a full four-digit range + the info
   icon + the slider's fixed 172px actually need in the longer of the two
   languages. Short by that much, the one child that cannot shrink (the
   172px slider) visibly overflowed the pill's own rounded border on a wide
   range. Fixed by measuring row 1's real content instead of estimating it
   (`min(400px, calc(100vw - 28px))`, `overflow:hidden` as a second line of
   defence if some future label ever exceeds it again).
3. Even at the right budget, `.ctl-tr` itself still had no upper bound, so a
   narrow-enough window with the feed panel open (which shrinks `#stage` by
   344px) could still leave less room than the pill's ~370px minimum needs —
   clipping its *left* portion (the label and the start of the range) rather
   than overflowing its right one. Fixed by giving `.ctl-tr` a real
   `max-width`, expressed with the same 312px/344px the `#app` grid already
   uses for the sidebar and feed columns and reacting to `sb-hidden` /
   `feed-open` the same way the grid does, so the cluster's own `flex-wrap`
   has an actual width to wrap against and drops the buttons onto their own
   line rather than letting anything clip.

Anything added to either row of the pill shares the same fixed-width budget;
anything added to the cluster shares the same wrap-safe bound.

---

## 6. Filtering

There is exactly one visibility predicate, `visibleSet()`, and it returns two
sets: `vis` (rendered) and `dimmed` (rendered faintly). Everything else reads
from it. Four independent axes combine with AND:

1. **Layer** — four toggles.
2. **Domain** — 17 checkboxes. An entity survives if *any* of its domains is
   checked, so a multi-domain marker stays visible until all of its domains are
   unchecked.
3. **Period** — see §10.
4. **My map** — when on, replaces the above entirely: only pins and their
   immediate neighbours, the neighbours dimmed.

The focused entity is always re-added to `vis` and un-dimmed, along with any of
its visible neighbours. A card can therefore stay open on an entity that the
filters would otherwise hide, which is what a reader expects when they narrow a
filter while reading.

**Starting views** are named domain presets (Overview, Energy & grids,
Aviation & ATM, Health, Human factors & XAI, Simulation & infrastructure). They
reset the layers, the period and My map, so a preset is a clean slate rather
than a modifier on the current state.

---

## 7. Selection and navigation

One selection at a time, `state.focusId`.

Selecting an entity: opens its card, highlights its marker, dims everything that
is not a neighbour, draws its edges at full strength, and — unless suppressed —
flies the map to it at a minimum of `k₀ × 3.2`.

`openEntity(id, {fly:false})` suppresses the fly. The feed uses it: clicking a
row should not move the map under the reader's cursor.

**Traversal is the point.** Every related entity in a card is a button that
opens that entity's card. A breadcrumb keeps the last three steps and a back
button walks the history, so a reader can follow a consortium out and come back.

Clicking empty map closes the card. Escape closes, in priority order: tour,
welcome, card, drawer.

---

## 8. The card

One function, `cardHtml(it)`, renders the body; `bindCard()` wires it. The
floating panel and the feed use the same output, so they cannot drift.

Section order, each omitted when empty:

1. Layer eyebrow with glyph, name, `city, country · span`
2. Tags — kind or type, status, tier
3. Domain badges with colour dots
4. Description, paragraphs preserved
5. Pin / Visit website
6. Facts grid — affiliation, parent, jurisdiction, issuing body, legal status,
   adoption, licence, maintainer, repository, reach
7. Focus areas, as chips
8. Timeline — span, then milestones on a rule
9. Consortium — organisation, role, country; clickable when the reference
   resolves
10. Funding — source, call, grant, budget in locale-formatted euros
11. Infrastructure — kind, operator, access model, capacity
12. Demonstrators · Deliverables · Facilities hosted · Applies to · Builds on ·
    Publications · Other links
13. Related entities — consortium teams or projects, created, builds on, used by
14. Provenance — who added the entry, when, at what confidence, from what source

The provenance footer is not decoration. The map is a curated snapshot with
uneven certainty, and a reader deciding whether to act on an entry needs to see
that a date is a founding record or an estimate.

---

## 9. The feed and the counters

### 9.1 Counters follow the viewport

The four counters in the left panel count **what is on screen**, not what
matches the filters. Zooming into central Europe changes them. The number
matching the filters is shown underneath as a caption, so both readings are
available and neither is ambiguous.

`updateInView()` projects each visible entity to screen coordinates and tests it
against the stage rectangle with a 10 px margin. It is called from `refresh()`
and, debounced at 90 ms, from `applyView()` — so panning and zooming update the
counts without running per frame.

When the stage measures zero — a hidden pane, printing — every placed marker is
counted rather than none.

**Off-map entities widen the gap on their own.** An entity with no coordinates
(§3.1, point 4) can never be "in view" — there is no marker to be on- or
off-screen — but it still matches the filters, so it counts toward the caption
without ever counting toward the four tiles. Reading the gap between "in view"
and "match the filters" as pan/zoom alone would be wrong whenever any of those
entities pass the current filters. `updateInView()` tallies them separately as
`state.offMapMatch`, and the caption names the count explicitly — "445 match the
filters (11 of them off the map)" — rather than leaving the reader to do the
arithmetic.

### 9.2 The feed

A column listing the entities in view, sorted by layer then name, with a count
in the header. It exists because a map shows *where* but not *what*: at any zoom
where the markers are dense, the reader cannot read the names.

- **Marker → feed.** Selecting on the map expands that entity's card in the
  column and scrolls it to centre.
- **Feed → map.** Clicking a row expands its card and highlights the marker,
  **without moving the view**. Clicking the open row collapses it.
- Hovering a row shows a soft halo on the corresponding marker.
- A selected entity with no coordinates is prepended to the list, so the off-map
  entities remain reachable.

The header count (`#fd-count`) sits right where a reader's eye lands first, so
it repeats the off-map reconciliation from §9.1 there too rather than trusting
the sidebar caption to be noticed: **"IN VIEW 434 + 11 off the map"**, the second
part a button (`#fd-offmap`) that reveals the sidebar and scrolls the **Off the
map** section into view. Reconciling the two numbers by reading a caption in a
different corner of the page asks more of the reader than restating the gap
next to the number that prompted the question in the first place.

Hiding the feed reverts to the floating detail panel with the same card. The
choice persists.

Rendering is keyed on `ids + focus + language + pins`; an identical key skips
the DOM write, so panning across unchanged content costs nothing.

---

## 10. Period filter

A two-handle slider from **1945 to the data's own freshness date** (§10.0) with
a per-year histogram of how many dated entities were running that year — the
growth curve of the field, read directly.

**Semantics.** A dated entity is kept when its span overlaps the selection. No
recorded end means "still running", so it stays visible for any range reaching
its start.

### 10.0 The axis stops at "now", not at the furthest funded end-date

`YMAX` used to be `Math.max(...YEARS)` — the latest year appearing anywhere in
the data, start or end. Several Horizon Europe projects are funded through
2030–2032, so the axis stretched a decade past the present to show almost
nothing: a thin tail of "still running" bars for grants that have not been
lived yet.

The generator instead computes `AS_OF`, the most recent `provenance.upd` /
`provenance.on` across every entity — a freshness date derived entirely from
the data, not from wall-clock generation time. Deriving it from `date.today()`
would put a changing timestamp in a generated file and break the "regenerating
without a source change produces an empty diff" invariant (§16, first item);
`AS_OF` only
moves when an entity's own provenance actually does. The map reads its year as
`YMAX`, clamped so it can never fall below the latest known **start** year (an
entity whose own start is after `AS_OF`'s year would otherwise become
permanently unreachable — not a case in the current data, but a real risk if
ever a future-dated entity were added right after a stale `AS_OF`).

This does not hide any currently-active entity: a project funded through 2032
still matches every range up to today, since its end (2032) satisfies `e >= a`
for any `a` the slider can reach. Only the empty decade of future bars
disappears from the histogram and the draggable range.

A small **ⓘ** button next to the range label — `#tf-asof` — surfaces `AS_OF`
directly: a `title` for hover, and a `toast()` on click so the same sentence
reaches touch devices, which do not hover. This is the map's only freshness
indicator; there is no separate "last updated" banner elsewhere in the page.

### 10.1 Entities whose start is unknown

Two facts bracket an entity whose own start date could not be established, and
between them the filter is tri-state rather than binary.

- **It exists today.** Everything on the map is a live entry, so it is
  *certainly* present from `PRESENT_FROM` (2020) onwards.
- **It cannot predate its host.** Where the only year on record is the founding
  year of the institution that hosts the work, that year is a hard **lower
  bound** — a human-machine teaming department cannot have started before the
  institute that houses it.

| Range | Known start | Unknown start |
|---|---|---|
| Reaching 2020 or later | overlap test | **solid** — certainly present |
| Between the host's founding year and 2020 | overlap test | **dimmed** — possible, not established |
| Before the host's founding year | overlap test | **hidden** — impossible |

`periodState()` returns `in` / `soft` / `out`. `soft` puts the entity in `vis`
*and* in `dimmed`, and the feed replaces its location with "possibly". An entity
with no year at all has no lower bound, so it stays `soft` however far back the
range goes. The *unknown start* checkbox removes the whole set for a reader who
wants only established dates.

### 10.2 What counts as an unknown start

The generator distinguishes three cases from the provenance note, which the
dating pass wrote as `timeline.start (high|medium|low): <evidence>`:

| Case | Emitted | Filtering |
|---|---|---|
| No `timeline.start` at all | — | vague, no lower bound |
| Note admits the sub-unit's own date was not found | `dateHost: true` | vague, host year is the lower bound |
| Note estimates *this entry's* start (`Estimate: MAHALO started 2020`) | `dateConf` only | normal — hidden before its year |

*TNO — Human-Machine Teaming* carries 1949 because TNO Soesterberg dates from
1949; the HMT department does not. The year stays in the data, where it is true
and sourced, and serves as the lower bound — but the map never draws it as the
start of the work. On the card an approximate start renders as `≈ 1949` with a
caption stating exactly how the map treats it.

### 10.3 How far the dates were established

The three tiers of evidence are not equally strong, and the map should not
flatten them:

- **Proven from the graph.** If an entity sits in a consortium whose project
  started in 2018, it existed in 2018. This bounds the start from *above* only,
  and settles just four of the vague entries — a link to a 2020 project says
  nothing about when a decades-old institute began.
- **Researched.** A handful were resolved individually: PowSyBl 2018, Italgas
  2017 (not the 1837 company), Energinet 2023, Vitens 2010, Inserm AI Health
  2021-12, Thames Water 2026, IFAC TC 4.1 1982.
- **Judged from the nature of the entry.** Standing institutes and university
  departments are pre-2020 with near-certainty; a named modern programme inside
  an old institution is not. Three remain genuinely open — ČEPS Grid AI &
  Ethics, Transelectrica Smart Grid / SCADA, Uisce Éireann Leakage AI — and are
  treated as pre-2020, which may be wrong for them.

**The 1945 floor.** A handful of corporate laboratories and universities predate
it — Philips 1914, the ASEA and Siemens laboratories 1916, Radboud 1923 — and
stretching the axis to the oldest founding year would make the useful range
unusable. The axis stops at 1945; those entities stay included in any range that
reaches the floor.

**Interaction.** Drag a handle, or click the track — outside the selection the
handle on that side is grabbed, which is what lets a range collapsed to a single
year be reopened in either direction. Keyboard: arrows ±1, PageUp/PageDown ±5,
Home/End to the bounds, with `role="slider"` and a live `aria-valuenow`.

---

## 11. Search, pins, sharing, print

**Search** matches name or city, diacritic-insensitive, from two characters, and
groups results by layer with at most eight per layer. Arrow keys and Enter
select. It searches all entities, including those with no coordinates.

**Pins** ("My map") are a reader's own selection, held in `localStorage` and
listed in the sidebar. My map mode shows only pins and their neighbours.

**Sharing** encodes the full view state in the URL fragment; **print** produces
a text sheet of the pinned entities, or of everything visible when nothing is
pinned, with descriptions and links.

---

## 12. Bilingual model

The switch changes the interface **and** the content. Entity descriptions exist
in both languages in the data (`desc_fr` / `desc_en`, falling back to `desc`),
and every controlled vocabulary value has both labels in `DATA.TAXO`.

`applyLang()` re-renders every dynamic surface: presets, layer rows, domain
groups, legend, pins, off-the-map list, period control, the open card. A missing
French key falls back to English rather than showing the raw key.

Initial language: `?lang=` → `localStorage` → browser language → English.

---

## 13. Persistence and deep links

### `localStorage`

| Key | Meaning |
|---|---|
| `hai-map-lang` | `fr` / `en` |
| `hai-map-v2-pins` | JSON array of pinned ids |
| `hai-map-v2-feed` | `1` / `0` — feed column shown |
| `hai-map-v2-seen` | welcome screen already shown |
| `hai-map-v2-hint-click` | first-marker hint already shown |
| `hai-map-v2-hint-pin` | first-pin hint already shown |

All reads and writes go through `lsGet` / `lsSet`, which swallow exceptions —
the page must work in a context where storage throws.

### URL

`?lang=fr|en` in the query. View state in the fragment, each part emitted only
when it differs from the default:

| Parameter | Meaning |
|---|---|
| `pins=a,b,c` | pinned ids |
| `e=<id>` | open this card on load |
| `dom=a,b` | checked domains |
| `lay=a,b` | enabled layers |
| `links=1` | full link mesh drawn |
| `my=1` | My map mode |
| `yr=2016,2021` | period range |
| `nd=0` | undated entities excluded |

Unknown ids and codes are filtered out on read, so a stale link degrades to a
sensible view instead of an empty map.

---

## 14. Accessibility

- Semantic landmarks; `data-screen-label` on each region.
- `aria-pressed` on every toggle; `aria-expanded` on feed rows.
- The period handles are `role="slider"` with min, max and current value.
- Counters are in an `aria-live="polite"` region.
- Visible focus ring on all interactive elements.
- `prefers-reduced-motion` disables view animation and feed auto-scroll.
- Full dark mode via `prefers-color-scheme`, on CSS custom properties.
- The map is pannable and zoomable from the keyboard through the zoom buttons;
  every entity is reachable without the map, through search or the feed.

---

## 15. Performance

Budget: a first paint with no network beyond the three local files, and pan/zoom
that stays smooth with several hundred markers and edges.

- Markers and edges are built **once** into static SVG. Filtering toggles
  `display` and classes; it never rebuilds the DOM.
- The per-marker counter-scale pass runs only when the scale actually changed.
- In-view recomputation is debounced at 90 ms.
- Feed rendering is keyed and skipped when the key is unchanged.
- Cards are rendered on demand, one at a time.

---

## 16. Invariants

A change that breaks one of these is a regression even if nothing throws.

1. Regenerating the data without a source change produces an empty diff.
2. Shape means layer; colour means domain. Neither channel encodes anything
   else.
3. An entity without coordinates has no marker but keeps a card, a search
   result, a feed row and its graph edges.
4. A date that is not the entity's own is never drawn as one: an unknown start
   is solid only from 2020, dimmed back to its host's founding year, and hidden
   before it.
5. The floating panel and the feed render the same card from the same function.
6. The focused entity is never hidden by a filter change.
7. Descriptions are never truncated.
8. Every user-visible string goes through `t()` and exists in both languages.
9. Every string interpolated into HTML goes through `esc()`.
10. The page never makes a network request.

---

## 17. Extending it

**A new domain.** Add the colour to `COLORS`, the code to the right group in
`DOM_GROUPS`, the labels to `badge` and `dom` in both languages, and the mapping
to `SECTOR` or `APPROACH` in the generator. Markers and filters follow.

**A new vocabulary value.** Add it to `data/taxonomy.yml` and to the matching
`TAXO` table in the generator. Without the second step it renders de-underscored
rather than breaking.

**A new language.** Add the `I18N` block, the `descriptions.<lang>.yml` file in
the data repository, the third label in the generator's `TAXO` tables, and an
entry in the switch. Everything else is already routed through `t()`.

**A new card section.** Add the field to the generator, then a `dtSec()` call in
`cardHtml()` at the right position, with its label in both `I18N` blocks. It
appears in the panel and the feed at once.

**A new layer** is the expensive one: `KINDS`, `TOTALS`, `MK_R`, the draw order,
`shapeSvg()`, `relSections()`, the legend, the welcome rows and the generator
all enumerate the four current layers.
