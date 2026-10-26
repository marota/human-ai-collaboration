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

- **Legibility over completeness of display.** Four hundred-odd entities
  cannot all be read at once. Every feature — filters, period, feed, counters
  — exists to let a reader carve out a subset small enough to actually read.
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
| `assets/map/eu-hai-map.html` | ~2 000 lines | The whole interface: markup, CSS, logic. Hand-written, no build step. |
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

Counts are a snapshot (26 October 2026) and move with every upstream
regeneration; the shape of the table is what is normative, not the figures.

| Layer | Count | Marker | Origin |
|---|---:|---|---|
| Projects & programmes | 115 | large circle | `data/projects/` |
| Teams | 274 | small circle | `data/teams/` + infrastructure with no matching team |
| Commons | 26 | dashed circle | `data/commons/` |
| Frameworks | 45 | square | `data/frameworks/` |
| Links | 303 | curved edge | `data/edges.yml` |

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
things — the period filter's upper bound and its freshness bubble (§10).

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

**The selection fan is attenuated, not just drawn.** Selecting a
twenty-partner project used to put twenty full-strength curves across the whole
map — ink rather than information, since which places are involved is already
legible from the neighbour markers, and the lines only have to carry the fact of
the connection. `styleHotEdges()` applies two attenuations: the wider the fan the
lighter and thinner each line (from 0.85 opacity at four neighbours or fewer down
to 0.40 at sixteen or more), and the longer a line the lighter still, since the
long ones are the ones crossing everything else.

**One relationship can always be isolated.** Pointing at a partner — its marker
on the map, or its row in the card, which is where the names are read — brings
that single edge to full strength and drops the rest of the fan to a trace.
`peek()` drives both the marker halo and the edge emphasis, so hovering anywhere
that names an entity does the same thing.

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

**A collapsed column leaves the grid, so the tracks have to leave with it.**
Hiding the sidebar is `display:none`, which stops it being a grid item — every
remaining item then shifts one track to the left. Keeping a `0`-width stub for
the collapsed column therefore does not hold its place: it hands the map the
stub and the feed the map's track, and the map disappears. `body.sb-hidden`
describes only the columns that are still there (`1fr`, or `1fr 344px` with the
feed open).

**Anything that resizes the stage without resizing the window has to say so.**
Only `resize` refits the map, and collapsing the sidebar or toggling the feed
fires no such event: the map kept the scale and offset of the old rectangle, and
the counters kept measuring against it. `stageResized()` — called right after
those class changes, where reading the new size forces the layout — keeps the
reader's zoom and the same geography centred, re-derives `k0`, and lets
`applyView()` bring the counts back in step (§9.2).

**Every floating cluster carries its own width bound, not just an edge
offset.** `.ctl-tr`, `.ctl-br` and `.ctl-bl` are all `position:absolute` with
an offset from one edge and nothing from the other — a shelf hung from a
single bracket. Nothing about that alone limits how wide the shelf can get,
and because `#stage{overflow:hidden}` clips rather than lets an over-wide
cluster spill onto the map, the failure mode is invisible content, not a
visibly broken layout — which is why it is worth stating as a rule rather
than leaving each cluster's sizing to be re-derived by eye.

The period pill (`.tf`) is the cluster most exposed to this, since its own
content changes shape with state: engaging a range adds a second row (the
*unknown start* toggle and reset, in `.tf-row2`, `hidden` until then), and
the range text itself grows and shrinks with the selection. Two bounds keep
it inside the visible area regardless of state:

- **The pill has its own `max-width`** — 400px on desktop, sized to the
  longer of the two languages' widest realistic row-1 content (label, a full
  four-digit range, the info icon, the slider's fixed 172px) with headroom,
  plus `overflow:hidden` as a second line of defence if a future label ever
  exceeds it. Engaging the filter grows the pill **downward** into row 2,
  never sideways.
- **The cluster (`.ctl-tr`) has its own `max-width` too**, expressed in the
  same 312px/344px the `#app` grid uses for the sidebar and feed columns,
  reacting to `sb-hidden`/`feed-open` the same way the grid does. This gives
  `flex-wrap` an actual width to wrap against: past a certain narrowness — a
  modest window with the feed panel open, say — the button row drops to its
  own line below the pill instead of either row clipping. Scoped to
  `@media (min-width:841px)`, the mobile query's complement, since mobile
  already bounds `.ctl-tr` more simply with `left` and `right` both set.

Anything added to either row of the pill shares the pill's budget; anything
added to the cluster shares the cluster's.

---

## 6. Filtering

There is exactly one filter predicate, `matchesFilters(it, skip)`, and exactly
one visibility function, `visibleSet()`, built on it. `visibleSet()` returns
three sets: `vis` (rendered), `dimmed` (rendered faintly) and `matched` (what
the filters actually select, recorded before the focus override below). Every
counter in the interface reads one of the three. Four independent axes combine
with AND:

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

### 6.1 A control's own count leaves its own axis out

`matchesFilters(it, skip)` takes an axis to ignore, and `scopeItems(skip)`
returns the entities that pass every *other* axis. That parameter exists because
a control's count has to answer "how many would this bring in", which it cannot
do while counting itself: a layer row whose figure collapsed to zero the moment
you switched the layer off would be useless for deciding whether to switch it
back on. So the Commons row skips `layer`, the *unknown start* checkbox skips
`period`, and the period histogram skips `period`.

The consequence to keep in mind when adding a control: **its own toggle must not
move its own number, and every other filter must.** Both halves are load-bearing
— the first makes the number a stable affordance, the second is what stops it
drifting into a corpus constant that contradicts everything around it.

In **My map** mode there are no filter axes: the pins and their neighbours
replace them. `scopeItems()` returns that set instead, so the same counters
describe the map the reader is actually looking at rather than a corpus they
have left behind. The layer and domain controls are inert in this mode; their
counts describe the My map set.

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
   resolves, and followed by `→ <entity name>` when the two differ, which is
   almost always: the row carries the consortium's legal name ("Technische
   Universiteit Delft") while the entity is a named laboratory inside it
10. Funding — source, call, grant, budget in locale-formatted euros
11. Infrastructure — kind, operator, access model, capacity
12. Demonstrators · Deliverables · Facilities hosted · Applies to · Builds on ·
    Publications · Other links
13. Related entities — consortium teams or projects, created, builds on, used by
14. Provenance — who added the entry, when, at what confidence, from what source

The provenance footer is not decoration. The map is a curated snapshot with
uneven certainty, and a reader deciding whether to act on an entry needs to see
that a date is a founding record or an estimate.

**The related-entities counts are deliberately unfiltered**, and are the one
place in the interface where that is right. `relSections()` lists every
neighbour and counts all of them, whatever the filters currently select, because
a consortium has the partners it has — hiding three of seventeen would
misdescribe the entity rather than the view. Clicking a hidden neighbour opens
it, and the focus override (§6) keeps it visible. This is the map's traversal
commitment (§1) winning over its filter state; it is not an instance of the
stale-count problem in §9.1, and should not be "fixed" into a filtered count.

## 9. The feed and the counters

### 9.1 Two readings, and every number says which one it is

There are only two quantities a *live* count on this page may report, and
mixing them is the single most reliable way to make the interface look broken:

| Reading | What it counts | Where it is used |
|---|---|---|
| **In view** | Entities with a marker inside the stage rectangle | the four header tiles, the feed header |
| **Matches the filters** | Entities passing the filter axes (§6), off-map ones included | the caption, the layer rows, the *unknown start* count, the Off-the-map badge |

A third quantity — the **corpus total** — belongs only where the page is
describing itself rather than the current view: the welcome panel's rows, and
the `title` on a count that has narrowed. It must never sit unlabelled next to a
live number.

**This is the rule that was broken, and how.** The layer rows showed
`TOTALS[k]`, a corpus constant, in a panel where every neighbouring number was
live. At the default view the coincidence held — Commons read 25, and 25 did
match the filters — so the row looked like a live count. Two ordinary actions
broke the illusion. Narrowing the period left the rows at 111 / 268 / 25 / 45
while the map emptied. And switching every layer off but Commons put
"Commons 25" two centimetres above a tile reading 24 — which was **in view**,
and for a *different* set again: the tiles merged commons and frameworks into
one "Resources" figure corresponding to no layer row at all. Three numbers,
three meanings, none of them labelled.

The same slip ran through the rest of the panel: the *unknown start* count
("37", all of them teams) and the Off-the-map badge ("11") were corpus
constants too, the latter contradicting the feed button that scrolls to it, and
the period histogram drew all 449 entities whatever the reader had selected.

The fixes are structural rather than cosmetic:

- **One tile per layer.** Projects, Teams, Commons, Frameworks. Every headline
  figure now traces to exactly one row in the Layers section, and each tile
  carries its own reconciliation on hover — "24 in view · 25 match the filters"
  — so the reader never has to work out which of the caption's eleven off-map
  entities were commons.
- **Countries leads the caption instead of taking a fifth tile.** It is not a
  layer and has no control, and five tiles at 312 px clip "FRAMEWORKS".
- **Every live count is recomputed in `refresh()`**, from the same predicate.
- **A layer row splits its figure where the map cannot follow it.** See §9.1.1.

### 9.1.1 The placeless half of a layer

One reading of the panel still contradicted itself after the fixes above, and it
was reported twice. Narrowed to 1945–2011, the Frameworks row read **30** while
the tile two centimetres above it read **23** — both correct, both labelled
"Frameworks", and the caption's single "(7 off the map)" never said *which*
layer owned the seven. The reader was left to attribute the gap by hovering.

The two figures part company only where a layer holds entities with no
coordinates (§3.1, point 4): international standards — ISO, IEC, IEEE, SAE — and
one non-EU commons. They match the filters and they keep a card, so the row
counts them; they have no marker, so the tile never can.

So the row now splits at exactly that seam — `23+7`, the second half dimmed —
and the parts say what the whole could not: twenty-three you can see, seven you
cannot, thirty in all. Both halves are viewport-independent, so the row stays a
filter control: panning and zooming move the tile, never the row.

The suffix appears **only when there is something to explain**. A layer whose
matches are all placed renders a bare number, or the split degrades into
decoration on every row and stops being read at all. Projects and teams are
always fully placed, so in practice it is the Commons and Frameworks rows that
ever carry one.

### 9.2 Counters follow the viewport

The four header tiles count **what is on screen**, not what matches the filters.
Zooming into central Europe changes them. The number matching the filters is
shown underneath as a caption, so both readings are available and neither is
ambiguous.

`updateInView()` projects each visible entity to screen coordinates and tests it
against the stage rectangle with a 10 px margin. It is called from `refresh()`
and, debounced at 90 ms, from `applyView()` — so panning and zooming update the
counts without running per frame.

When the stage measures zero — a hidden pane, printing — every placed marker is
counted rather than none.

**The gap has three causes, and all three are named.** "In view" counts markers
inside the stage rectangle, so it falls short of "match the filters" for two
quite different reasons: entities whose marker is simply outside the current pan
and zoom, and entities with no coordinates at all (§3.1, point 4), which can
never be "in view" because there is no marker to be on- or off-screen.
`updateInView()` tallies both — `state.offScreen` and `state.offMapMatch` — and
the caption names them, so the numbers reconcile at any zoom: "449 match the
filters (54 off screen, 11 off the map)".

The third cause runs the other way, and makes the tiles *exceed* the match
count: the focused entity is never hidden by a filter change (invariant 6), so
an open card can be on screen while matching nothing. `visibleSet()` records
`matched` before adding it, `state.matchCount` counts that set — so "N match the
filters" can no longer be contradicted by the filters themselves — and the
surplus is named as its own term, `state.keptOpen`: "in view · 0 match the
filters (plus the open card)". Left unnamed it reads as an off-by-one, which is
exactly what the caption exists to prevent.

**My map is not a filter state**, so the caption does not claim to be one there:
it reads "in view · 5 on your map". The previous wording announced how many
entities matched filters that mode had already replaced.

Naming only the off-map part, as an earlier version did, reads as though it
accounts for the whole difference — which it does at the default fit, where every
placed marker is on screen, and stops being true the moment the reader zooms in.
A reader who then sees "434" become "380" against an unchanged "11 off the map"
has been handed an arithmetic problem with a missing term.

### 9.3 The feed

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
it repeats the reconciliation from §9.2 there too rather than trusting the
sidebar caption to be noticed: **"IN VIEW 384 + 54 off screen + 11 off the
map"**. Each part is a button, and each has its own remedy: `#fd-offscreen`
fits the view so the off-screen markers come in, `#fd-offmap` reveals the
sidebar and scrolls the **Off the map** section into view. Reconciling the
numbers by reading a caption in a different corner of the page asks more of the
reader than restating the gap next to the number that prompted the question in
the first place.

**A button that promises a number has to land on that number.** `#fd-offmap`
says "+ 1 off the map" and scrolls to a section whose badge used to read 11 —
the count of every off-map entity, filters ignored — with eleven rows to match.
The badge is now `state.offMapMatch`, the same figure the button quotes. The
entities that do not match stay listed and stay clickable, because reaching them
is what the section is for, but they are dimmed (`.pin-item.out`): badge and
list then agree by inspection rather than by arithmetic the reader has to do.

Hiding the feed reverts to the floating detail panel with the same card. The
choice persists.

Rendering is keyed on `ids + focus + language + pins`; an identical key skips
the DOM write, so panning across unchanged content costs nothing.

---

## 10. Period filter

A two-handle slider from **1945 to the data's own freshness date** with a
per-year histogram of how many dated entities were running that year — the
growth curve of the field, read directly.

**The histogram is drawn from the filtered set, not the corpus** (§6.1): it
skips the period axis, which it is the control for, and follows layer and domain
like everything else. It is the backdrop the reader sizes the handles against,
so drawing all 449 entities while they have narrowed to Commons would have them
selecting from a population that is not on the map. Bars are normalised to the
*filtered* peak rather than a fixed corpus peak — a 25-entity layer would
otherwise draw a flat line one pixel high, and it is the curve's shape that is
being read, not its height against other filter states.

**Semantics.** A dated entity is kept when its span overlaps the selection. No
recorded end means "still running", so it stays visible for any range reaching
its start.

**The axis stops at "now", not at the furthest funded end-date.** `YMAX` used
to be `Math.max(...YEARS)` — the latest year appearing anywhere in the data,
start or end. Several Horizon Europe projects are funded through 2030–2032, so
the axis stretched a decade past the present to show almost nothing: a thin
tail of "still running" bars for grants that have not been lived yet.

The generator instead computes `AS_OF` (§3.5), the most recent
`provenance.upd` / `provenance.on` across every entity — a freshness date
derived entirely from the data, not from wall-clock generation time. Deriving
it from `date.today()` would put a changing timestamp in a generated file and
break the "regenerating without a source change produces an empty diff"
invariant (§16, first item); `AS_OF` only moves when an entity's own
provenance actually does. The map reads its year as `YMAX`, clamped so it can
never fall below the latest known **start** year (an entity whose own start is
after `AS_OF`'s year would otherwise become permanently unreachable — not a
case in the current data, but a real risk if ever a future-dated entity were
added right after a stale `AS_OF`).

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

**Its count is the set it actually governs**, computed across every axis but the
period (§6.1). All 37 undated entities are teams, so a reader filtered to
Commons needs to see 0 there, not 37 — a figure that would name a set the
checkbox beside it cannot change. Zero is also a useful signal in its own right:
the switch has nothing to do in the current view.

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

It also matches a team's `affiliation.org` and `affiliation.parent`, because the
name a reader knows is often the institution's, not the group's — "Deutsches
Zentrum für Luft- und Raumfahrt" finds the DLR team whose own name says only
"DLR". **Ranking carries this feature, not the widening.** Own-name and city
matches rank ahead of affiliation-only ones, and the sort is stable; without
that, a query like "universit" fills all eight slots with teams whose *parent*
matches and evicts the ones actually called that. A row matched only through its
affiliation appends that string after the city, so the reader can see why it is
in the list.

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
10. The page never makes a network request — at load, or under any interaction
    but one. The one is the Chat pill of §18: every reader sees it, and nothing
    behind it exists until it is pressed. The first press, or `?chat=1`, fetches
    `hai-chat.js` from beside the page, and from then on the chat talks to its
    server (§18.6). A reader who never presses it gets the page's three local
    files and nothing else.
11. No floating cluster (`.ctl-tr`, `.ctl-br`, `.ctl-bl`) or its content can
    grow past `#stage`'s visible area — each carries an explicit width bound
    rather than relying on its content staying small (§5).
12. The counters reconcile at every zoom level: in view + off screen + off the
    map equals the number matching the filters, plus the open card when the
    filters exclude it. A gap the reader can see must be a gap the interface
    names (§9.2).
13. **No count is a corpus constant unless it is labelled as one.** Every figure
    the interface shows next to a live one is recomputed in `refresh()` from
    `matchesFilters()` — header tiles, layer rows, the *unknown start* count,
    the Off-the-map badge, the period histogram. The corpus totals survive in
    exactly two places: the welcome panel, which describes the map rather than
    the view, and the `title` of a count that has narrowed (§6.1, §9.1).
14. **Every headline figure traces to one control.** A tile that aggregates two
    layers has no row a reader can check it against, which is how "Commons 25"
    and "Resources 24" came to sit two centimetres apart (§9.1).
15. **Where a layer row and its tile must differ, the row says why.** The two
    read different quantities, and they diverge by exactly the layer's placeless
    entities. That difference is shown in the row itself rather than left to a
    caption that names a total without attributing it (§9.1.1).
16. **The chat proposes; it never writes.** Nothing said to it can change the
    map, this repository or the data repository. Its only output besides prose
    is a GitHub issue awaiting review, opened by an explicit click on a body the
    contributor has read (§18).
17. **The chat answers from the payload or says it cannot.** Its context is
    `hai-data.js` — the same file the page draws — and figures counted from it.
    An entity it has not been shown is one it must decline to describe (§18.2).

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
all enumerate the four current layers. It also needs a header tile — one per
layer, no aggregates (invariant 14) — whose `<strong>` id is `st-<kind>`, since
`renderStats()` and `updateLayerCounts()` address the tiles by kind rather than
by a hand-written list. Five tiles do not fit the 312 px sidebar at a legible
label size, so a fifth layer means rethinking that row, not squeezing it.

**A new counter or filter control.** Two rules, both in §6.1 and §9.1: compute
it from `matchesFilters()` / `scopeItems()` rather than from `items` or
`TOTALS`, passing its own axis as `skip`; and update it from `refresh()`, not
only from its own render function — `renderTime()` and `renderNoGeo()` run on
language and preset changes, which is not when the filters move.

---

## 18. The chat column

The map is a reading surface, and §1 says editing, authentication and server
round-trips are non-goals. §18 is the one place that line is crossed, and the
way it is crossed is the design: the chat is **behind a pill, not in the page**.
Every reader sees the pill; none of the chat's code, markup or requests exists
until it is pressed. Behind it is a model running on the curator's own machine —
reached from that machine directly, and from the published map through a tunnel
(§18.6).

Three things it does:

- answers questions about the map from the payload the page itself draws;
- takes a proposal — something missing, something wrong — and turns it into a
  draft card the contributor corrects **on the spot**, while they are still
  there to answer;
- opens a GitHub issue with that draft for a maintainer to review.

It never writes to the map (invariant 16). The data repository's
[`CONTRIBUTING.md`][contrib] already describes this route — *"open a GitHub
issue… the maintainers (or AI suggestions reviewed by maintainers) will turn it
into a PR"* — and the chat is an implementation of it, not a new authority.

### 18.1 How it attaches

```
eu-hai-map.html       the Chat pill, in the markup, for every reader
    │                          │ first press, or ?chat=1
    │  (nothing else until)    ▼
    │                 window.HAI_CHAT_HOST + one <script>
    ▼                          ▼
window.HAI_DATA       assets/map/hai-chat.js — markup, styles, every fetch
                               │
               ┌───────────────┴───────────────┐
     a page on this machine            the published map
          same origin            https://…ts.net:8443 (Tailscale Funnel)
               └───────────────┬───────────────┘
                               ▼
                    chat/server.py  (127.0.0.1)
                          │        │
                          ▼        ▼
                       Ollama    gh issue create
```

The page's own contribution is the pill in its markup — labelled through the
dictionary like the pills beside it — and a dozen lines at the end of its
script: on the first press, publish one object of host functions
(`openEntity`, `esc`, `toast`, `byId`, `lang()`, the taxonomy) and append a
`<script>`. `hai-chat.js` adopts the pill rather than adding one. There is no
`fetch(` in `eu-hai-map.html`, no fourth `<script>` tag in its markup, and
nothing behind the pill in its DOM until it is pressed — so §1's three-file
reading, §2's single-document contract and invariant 10 describe the file as
every reader receives it who never presses the pill. The chat column is 380 px. When the feed is open too, the two share it rather than one
replacing the other: the right column becomes two grid rows, the feed above and
the chat below, and the sidebar and stage span both. They answer the same
question from two directions — what is in view, and what about it — so taking
the feed away to make room for the chat removed the thing the chat talks about.
Below 840 px, where both are drawers over the map, the halves are top and
bottom of the drawer.

**The server also serves the map**, so on the curator's machine the map and
the API share an origin and running the chat is one command:

```bash
python3 chat/server.py            # then open the URL it prints
```

It binds to the loopback interface, and it can open issues as whoever `gh` is
logged in as. It serves `assets/map/` and the API to this machine, and only the
API through the tunnel (§18.6). A Jekyll dev server on another port can reach
it with `?chat=1&chatapi=http://127.0.0.1:8765` — a loopback address only, and
only from a page served on this machine.

### 18.2 What the model is allowed to know

`chat/hai_data.py` reads `assets/map/hai-data.js` — not the data repository, not
a second copy. The chat therefore cannot answer from something the reader cannot
see on the map, and a regenerated payload moves both in the same commit.

Each turn the model gets three things and nothing else: standing instructions,
**figures counted in Python**, and the **full records of the entities lexical
retrieval ranked for the question**.

The figures are what retrieval cannot do. A model cannot count 450 records it
has not been shown and will estimate if asked, so totals per layer, per country
and per domain are counted and handed over. The same applies to any question
about the corpus as a whole: no card contains the word "oldest", so a lexical
search for *quel est le projet le plus ancien* returns noise, and a model held
to its cards concludes — as this one did — that the map holds no dates at all,
while the period filter of §10 is built on them. A question about when things
began therefore also carries the ends of the timeline, computed under §10.1's
rule: an entity whose recorded year is only its host institution's founding is
left out of "earliest" and counted separately, so a university's 1923 can never
be reported as its lab's. Those rows are written as `[Name](#id)` links,
because a model copies the shape it is given. Those records are the only ids it may link, which is what makes
`[Name](#id)` a card-opener rather than a guess; the renderer drops any link
whose id is not in `byId`, so an invented one degrades to plain text.

The catalogue of every id can be put back in the system prompt with
`HAI_CHAT_CATALOGUE=1`. It is off by default because a 12-billion-parameter
model handed 7 000 tokens of list answers a one-line question by reciting it.

Two models, by default two tags already on the machine: a fast one for the
conversation (`HAI_CHAT_MODEL`) and a stronger one for drafting a card
(`HAI_DRAFT_MODEL`), which is one call, structured, and read by a human
afterwards. Reasoning is switched **off** — Ollama returns it in a field of its
own, so left on it consumes the token budget before the visible answer starts.
`HAI_CHAT_NUM_PREDICT` caps the answer; without a cap a local model will
enumerate the corpus for ten minutes.

### 18.3 The proposal flow

1. **Intent.** The model opens a proposal by emitting `[PROPOSE:add:<layer>]` or
   `[PROPOSE:fix:<id>]` as the first line of its reply; the server strips it and
   sends an event. A small model forgets, so the reader's own words are a
   backstop (`sniff_intent`). Both only ever *open* a panel the reader can
   close.
2. **The reference.** The contributor gives the page that documents the entity.
   The server fetches it once, says whether it loaded and whether the name
   actually appears on it, and keeps the text for the drafter. Only globally
   routable addresses are fetched, checked on the socket for every hop of every
   redirect: a box that fetches any URL must not become a way to read the
   network the server sits on (§18.6).
   The URL becomes `provenance.source`, and the verdict sets the default
   `provenance.confidence`.
3. **The draft.** One constrained call: Ollama is handed a JSON schema built
   from the same field table that renders the form, so the answer cannot be
   prose, a fence or a field that does not exist. The facts a documentation page
   always states are *required* in that schema — organisation, city, country,
   kind, focus — because a merely optional field comes back empty and the
   contributor inherits the work the draft was meant to save. Coordinates are
   not in the schema at all: they are looked up from a city the map already
   covers, and a guessed latitude puts a marker in a field.
4. **The editable card.** The form is generated from `cards._spec(layer)`:
   required fields first, rarely-needed ones folded away, vocabularies as
   checkboxes and selects so no code can be invented, the YAML visible, and —
   for a correction — a before/after table of what moved. Every edit
   re-validates on the server against the upstream schemas' rules. This step is
   the point of the feature: the contributor is here now, and what they can
   correct in thirty seconds is worth more than what a maintainer reconstructs
   in a week.
5. **The issue.** The contributor reads the exact body first, then clicks once.
   It carries the YAML, the file it would become in the data repository, the
   reference and its verdict, the diff, the failed checks if any, the
   conversation folded away, and the review bar from `CONTRIBUTING.md`. It says
   in as many words that nothing has been changed on the map.

### 18.4 What it is not

No authentication, no accounts, no write access, no telemetry, and no model
anywhere but the curator's machine — the tunnel carries requests, it runs
nothing. The server holds no state between requests beyond the payload it
reloads when the file changes and the counts behind §18.6's ceilings; the
conversation lives in the reader's `localStorage` and nowhere else. `HAI_CHAT_DRY_RUN=1` runs the whole flow and posts nothing, which is how
the tests exercise it.

### 18.5 Where the code is

| Path | Role |
|---|---|
| `assets/map/eu-hai-map.html` | the Chat pill, and a dozen lines that load the chat on its first press |
| `assets/map/hai-chat.js` | the column: markup, styles, the form, every fetch, where the server is |
| `chat/server.py` | the server, stdlib only; the map to this machine, the API to both |
| `chat/hai_data.py` | the payload, retrieval, the figures, the gazetteer |
| `chat/cards.py` | the field table, the checks, the YAML |
| `chat/prompts.py` | the two prompts, the grammar, intent |
| `chat/reference.py` | fetching and confirming a reference |
| `chat/issues.py` | the issue body, and `gh issue create` |
| `tests/chat/*.py` | the server side, with no model running |
| `tests/chat/test_public.py` | what a visitor can and cannot reach (§18.6) |
| `tests/interface/chat.spec.js` | the column, against a stubbed server, and from the published origin |

### 18.6 The published map

The map on GitHub Pages carries the same pill, and pressing it reaches the
curator's machine. `hai-chat.js` served from any origin but this machine's talks
to `https://mac.tail9919aa.ts.net:8443`, which Tailscale Funnel forwards to
`chat/server.py` on loopback; the server itself is never bound wider. When the
machine is off or the server down, the column says so in the reader's language,
with no command to run — the map is unaffected, and nothing was requested
before the press.

On that machine the server is a launchd agent (`chat/service.sh`), restarted
within seconds if it stops and started at login. It runs from a worktree of its
own, detached at `origin/main`, so the published chat answers from the payload
the published map draws (invariant 17) rather than from the working checkout;
a merge reaches it when the service is updated.

A request through the tunnel is a **visitor's**, held to rules the curator's are
not:

| | Curator (this machine) | Visitor (through the tunnel) |
|---|---|---|
| Files | `assets/map/` only | none — the API and nothing else |
| Cross-origin callers | loopback origins | `https://marota.github.io` (`HAI_CHAT_ORIGINS`) |
| Ceilings, per address | none | 20 chat turns / 10 min · 6 drafts / hour · 12 references / 10 min · 3 issues / day |
| Ceilings, all visitors | none | 20 issues / day (`HAI_CHAT_ISSUES_PER_DAY`) |
| At once | — | 2 conversations, 1 draft; past that "busy" (503), not a queue |
| Request size | 1 MB | 64 KB; the last 12 turns are read, none over 4 000 characters |
| `/api/health` | everything | whether it can answer and send — no model inventory, address or account |
| An issue | as written | says a visitor opened it; `@` and `#` inert outside code blocks; the conversation in a code block; `force` refused |

**Telling a visitor apart.** The tunnel connects from loopback, so the socket
cannot. A request is the curator's only if its `Host` is a loopback name *and*
it carries no proxy header (`X-Forwarded-For`, `X-Forwarded-Host`,
`Forwarded`, `Tailscale-Funnel-Request`); anything else, including anything
ambiguous, is a visitor's — it fails closed. Visitors are counted by the last
`X-Forwarded-For` entry, which the tunnel wrote, not by one they can write.

**References.** `/api/reference` fetches a URL on a visitor's behalf from inside
the curator's network, so it fetches only from globally routable addresses. That
is an allow-list on purpose: the block-list it replaced (`is_private`,
`is_loopback`, …) let `100.64.0.0/10` through — where Tailscale numbers every
machine on the curator's tailnet — and a reference to the machine's own
tailnet name returned a private service's page. The check is made on the
socket, after it connects and before TLS, for every hop of every redirect, so
neither a redirect nor a second DNS answer can point it inward; a redirect off
the web is refused, and no proxy from the environment stands in between.

**What the published page will not do.** `?chatapi=` is ignored on any origin
but this machine's: on the published map a crafted link would otherwise send a
visitor's words, and their proposal, wherever it named. A page on the published
origin never calls `127.0.0.1`, so a visitor is never asked whether a website
may reach their own network.

A visitor's issue lands under the account `gh` is logged in as, labelled
`via-public-chat` where the repository has that label. Nothing reaches the map
until a maintainer turns it into a pull request (invariant 16) — the same
review the curator's own proposals get.
