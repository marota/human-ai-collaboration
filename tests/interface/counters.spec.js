// §9.1, §9.2 and invariants 12–14 — the counter grammar.
//
// This is the part of the interface the repo has just rewritten, and the spec
// records why: the layer rows showed `TOTALS[k]`, a corpus constant, sitting in
// a panel where every neighbouring number was live. At the default view the
// coincidence held (Commons read 25, and 25 did match the filters), so nothing
// looked wrong until a reader did something ordinary — narrowed the period, or
// switched every layer off but Commons — and was handed three numbers with
// three meanings, none of them labelled.
//
// So the tests below are written around two ideas rather than around functions.
//
// 1. A number must MOVE. Most of these assertions are of the form "narrow an
//    axis, and this figure is no longer the corpus figure". A test that only
//    checked the default view would have passed against the bug.
// 2. An expectation must not come out of the code path it is checking.
//    `derive()` below re-implements §6's predicate, §10.1's period rule, §9.2's
//    stage test and §9.1's caption grammar over the raw item records, so when a
//    count is asserted the expected value was computed independently of
//    `matchesFilters()`, `updateInView()` and `renderStats()`.
//
// Every test opens the page with reduced motion emulated. The map's `setView()`
// animates over 520 ms and re-counts on a 90 ms debounce behind it, so an
// animated fly-to would leave the counters mid-flight; `reduceMotion` makes
// every view change land in one step, which is also the documented a11y path
// (§14), and then `settleCounts()` is enough to reach the final figures.

import { test, expect } from '@playwright/test';
import {
  openMap, snapshot, tiles, layerRows, caption, toggleLayer, setLayers,
  setPeriod, applyPreset, expectCountersReconcile, settleCounts, zoomBy, fitAll,
} from './_map.js';

const KINDS = ['project', 'team', 'commons', 'framework'];

/** Open the map with animation switched off, and wait out the debounced
 *  recount that boot's `fitView()` → `applyView()` always schedules. */
async function open(page, opts = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page, opts);
  await settleCounts(page);
  return page;
}

/** The corpus, read off the generated payload rather than off the page's own
 *  `TOTALS` — the constant an assertion is measured against must not be the
 *  same binding the implementation reads. */
function corpus(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const of = (arr) => arr.length;
    const all = [
      ...D.PROJECTS.map((d) => ['project', d]), ...D.COMMONS.map((d) => ['commons', d]),
      ...D.TEAMS.map((d) => ['team', d]), ...D.FRAMEWORKS.map((d) => ['framework', d]),
    ];
    const yr = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
    const vague = all.filter(([, d]) => {
      const tl = d.timeline || {};
      return !(yr(tl.start) != null || yr(tl.end) != null) || !!d.dateHost;
    });
    return {
      totals: {
        project: of(D.PROJECTS), team: of(D.TEAMS),
        commons: of(D.COMMONS), framework: of(D.FRAMEWORKS),
      },
      all: all.length,
      nogeo: all.filter(([, d]) => d.lat == null || d.lon == null).length,
      nogeoByKind: all.filter(([, d]) => d.lat == null || d.lon == null)
        .reduce((a, [k]) => (a[k] = (a[k] || 0) + 1, a), {}),
      undated: vague.length,
      undatedByKind: vague.reduce((a, [k]) => (a[k] = (a[k] || 0) + 1, a), {}),
    };
  });
}

/** Recompute every figure the counters claim, from the raw item records and the
 *  live view rectangle — §6's three axes, §10.1's unknown-start rule, §9.2's
 *  10 px stage test, and My map's replacement of the axes (§6.1) — rather than
 *  by calling the page's own `matchesFilters()` / `updateInView()`. */
async function derive(page) {
  return page.evaluate(() => {
    const A = state.years.a, B = state.years.b, keepUndated = state.years.undated;
    const narrowed = A > YMIN || B < YMAX;
    const PRESENT = 2020;                          // §10.1's PRESENT_FROM
    const per = (it) => {
      if (!narrowed) return 'in';
      if (it.vague) {
        if (it.y0 != null && B < it.y0) return 'out';   // the host's founding is a floor
        if (B >= PRESENT) return 'in';
        return keepUndated ? 'soft' : 'out';
      }
      const s = it.y0 == null ? -Infinity : it.y0;
      const e = it.y1 == null ? Infinity : it.y1;
      return (s <= B && e >= A) ? 'in' : 'out';
    };
    const pass = (it, skip) =>
      (skip === 'layer' || !!state.layers[it.kind]) &&
      (skip === 'domain' || it.domains.some((d) => state.domains.has(d))) &&
      (skip === 'period' || per(it) !== 'out');

    // My map replaces the axes with the pins and their neighbours, so the scope
    // is rebuilt here from the payload's own relations rather than read off the
    // page's adjacency map.
    const myScope = () => {
      const D = window.HAI_DATA;
      const known = new Set();
      [D.PROJECTS, D.COMMONS, D.TEAMS, D.FRAMEWORKS].forEach((a) => a.forEach((d) => known.add(d.id)));
      const nb = new Map();
      const link = (a, b) => {
        if (!known.has(a) || !known.has(b)) return;
        if (!nb.has(a)) nb.set(a, new Set());
        if (!nb.has(b)) nb.set(b, new Set());
        nb.get(a).add(b); nb.get(b).add(a);
      };
      D.EDGES.forEach((e) => { if (known.has(e.project)) link(e.project, e.team); });
      [...D.COMMONS, ...D.FRAMEWORKS].forEach((a) => {
        (a.createdBy || []).forEach((u) => link(u, a.id));
        (a.usedBy || []).forEach((u) => link(a.id, u));
      });
      const s = new Set();
      state.pins.forEach((id) => { if (known.has(id)) s.add(id); });
      state.pins.forEach((id) => (nb.get(id) || new Set()).forEach((n) => s.add(n)));
      return [...s].map((id) => byId[id]);
    };

    const scope = (skip) => (state.myMap ? myScope() : items.filter((it) => pass(it, skip)));
    const match = scope();                         // what the filters select
    const shown = new Set(match.map((it) => it.id));
    if (state.focusId && byId[state.focusId]) shown.add(state.focusId);   // invariant 6

    const r = document.getElementById('stage').getBoundingClientRect();
    const w = r.width, h = r.height, pad = 10;
    const unmeasured = w < 2 || h < 2;
    const onScreen = (it) => {
      if (unmeasured) return true;                 // hidden pane / print (§9.2)
      const sx = view.x + it.X * view.k, sy = view.y + it.Y * view.k;
      return sx >= -pad && sx <= w + pad && sy >= -pad && sy <= h + pad;
    };

    const zero = () => ({ project: 0, team: 0, commons: 0, framework: 0 });
    const inViewKind = zero(), matchKind = zero(), scopeKind = zero();
    const countries = new Set();
    let inView = 0, offScreen = 0, offMap = 0;
    shown.forEach((id) => {
      const it = byId[id];
      if (!it.geo) { offMap++; return; }
      if (onScreen(it)) {
        inView++; inViewKind[it.kind]++;
        if (it.d.country) countries.add(it.d.country);
      } else offScreen++;
    });
    match.forEach((it) => { matchKind[it.kind]++; });
    scope('layer').forEach((it) => { scopeKind[it.kind]++; });

    // The period control's own backdrop: one bar per year with at least one
    // dated entity running, over the scope that leaves the period axis out.
    const bins = new Array(YMAX - YMIN + 1).fill(0);
    scope('period').forEach((it) => {
      if (!it.dated) return;
      const s = Math.max(YMIN, it.y0 == null ? YMIN : it.y0);
      const e = Math.min(YMAX, it.y1 == null ? YMAX : it.y1);
      for (let y = s; y <= e; y++) bins[y - YMIN]++;
    });
    let bars = 0, lit = 0;
    bins.forEach((c, i) => { if (c) { bars++; if (YMIN + i >= A && YMIN + i <= B) lit++; } });

    return {
      match: match.length, inView, offScreen, offMap,
      keptOpen: shown.size - match.length,
      countries: countries.size, unmeasured,
      inViewKind, matchKind, scopeKind,
      undated: scope('period').filter((it) => it.vague).length,
      offMapMatching: match.filter((it) => !it.geo).length,
      bars, lit, bins, ymin: YMIN, ymax: YMAX,
    };
  });
}

/** The caption §9.1/§9.2 says must be on screen, rebuilt from derived figures:
 *  countries first, then the two readings, then the gap's named terms in the
 *  order off screen, off the map, open card. */
function captionFor(d) {
  const why = [];
  if (d.offScreen) why.push(`${d.offScreen} off screen`);
  if (d.offMap) why.push(`${d.offMap} off the map`);
  if (d.keptOpen) why.push('plus the open card');
  const note = `in view · ${d.match} ${d.match === 1 ? 'matches' : 'match'} the filters`
    + (why.length ? ` (${why.join(', ')})` : '');
  const head = d.countries ? `${d.countries} ${d.countries === 1 ? 'country' : 'countries'} · ` : '';
  return head + note;
}

/** The sidebar counts that are not tiles: the unknown-start figure, the
 *  Off-the-map badge, and the period histogram. */
function panelCounts(page) {
  return page.evaluate(() => ({
    undated: Number(document.getElementById('tf-undated-n').textContent),
    undatedTitle: document.getElementById('tf-undated-n').title,
    nogeo: Number(document.getElementById('nogeo-count').textContent),
    nogeoTitle: document.getElementById('nogeo-count').title,
    nogeoDimmed: document.querySelectorAll('#nogeo-list .pin-item.out').length,
    nogeoRows: document.querySelectorAll('#nogeo-list .pin-item').length,
    bars: document.querySelectorAll('#tf-hist rect').length,
    lit: document.querySelectorAll('#tf-hist rect.on').length,
  }));
}

/** The period histogram's drawn curve: every rendered bar, with the year it
 *  stands for and its height. The heights matter and not only which years
 *  carry a bar: one team on this map has been running since before `YMIN`, so
 *  *some* entity covers every year under almost any filter, and a curve redrawn
 *  over a completely different population keeps the identical bar set. */
function histBars(page) {
  return page.evaluate(() => [...document.querySelectorAll('#tf-hist rect')]
    .map((r) => ({ year: +r.dataset.y, h: Number(r.getAttribute('height')) })));
}

/** The drawn curve has to rank the independently derived per-year population:
 *  a year with more entities running never draws a shorter bar, and two years
 *  holding the same number draw the same bar. Asserted as a ranking rather than
 *  against `renderHist()`'s own `(c/peak)*19` arithmetic, so the expectation
 *  does not come out of the code path it is checking — and non-strictly,
 *  because the 1.1 px floor legitimately flattens the smallest years together. */
function expectCurveRanks(bars, d, because) {
  const bin = (y) => d.bins[y - d.ymin];
  const drawn = new Set(bars.map((b) => b.year));
  d.bins.forEach((c, i) => {
    const y = d.ymin + i;
    expect(drawn.has(y), `${y} ${c ? 'holds ' + c + ' and needs a bar' : 'is empty and must not have one'} — ${because}`)
      .toBe(c > 0);
  });
  const sorted = [...bars].sort((a, b) => bin(a.year) - bin(b.year));
  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1], hi = sorted[i];
    if (bin(lo.year) === bin(hi.year)) {
      expect(hi.h, `${lo.year} and ${hi.year} both hold ${bin(hi.year)} — ${because}`).toBe(lo.h);
    } else {
      expect(hi.h, `${hi.year} holds ${bin(hi.year)} against ${lo.year}'s ${bin(lo.year)} — ${because}`)
        .toBeGreaterThanOrEqual(lo.h);
    }
  }
}

/** `captionFor()` in French. §12 routes every string through `t()`, so the
 *  caption carries the same three named terms in both languages — including the
 *  verb agreement, which is why this is spelled out instead of matched with
 *  `correspond(ent)?`: a pattern that accepts either verb cannot fail when the
 *  agreement branch is deleted. */
function captionForFr(d) {
  const why = [];
  if (d.offScreen) why.push(`${d.offScreen} hors écran`);
  if (d.offMap) why.push(`${d.offMap} hors carte`);
  if (d.keptOpen) why.push('plus la fiche ouverte');
  const note = `dans la vue · ${d.match} ${d.match > 1 ? 'correspondent' : 'correspond'} aux filtres`
    + (why.length ? ` (${why.join(', ')})` : '');
  return (d.countries ? `${d.countries} pays · ` : '') + note;
}

/** The feed header — §9.3 restates §9.2's reconciliation next to the number
 *  that prompts the question, so it is the rendered face of invariant 12. */
function feedHeader(page) {
  return page.evaluate(() => {
    const os = document.getElementById('fd-offscreen'), om = document.getElementById('fd-offmap');
    return {
      count: Number(document.getElementById('fd-count').textContent),
      offScreen: os.hidden ? null : os.textContent,
      offMap: om.hidden ? null : om.textContent,
    };
  });
}

/** Per-tile accessible name and tooltip (§9.1's "own reconciliation on hover"). */
function tileA11y(page) {
  return page.evaluate(() => KINDS.map((k) => {
    const tile = document.getElementById('st-' + k).parentNode;
    return { kind: k, label: tile.querySelector('span').textContent,
      title: tile.title, aria: tile.getAttribute('aria-label') };
  }));
}

/** Zoom about the centre of the stage. `zoomBy()` scales `view.k` with the
 *  translation left alone, which is fine for reconciliation but flings the
 *  content off screen past a factor or two; the tests that need a partially
 *  filled stage zoom the way the reader's wheel does instead. */
async function zoomCentre(page, f) {
  await page.evaluate((factor) => {
    const r = document.getElementById('stage').getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    setView({ k: view.k * factor,
      x: cx - (cx - view.x) * factor, y: cy - (cy - view.y) * factor }, false);
  }, f);
  await settleCounts(page);
}

/** Put the whole map inside the stage, so nothing can be off screen. */
async function showWholeMap(page) {
  await page.evaluate(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    const k = k0 * 0.6;
    setView({ k, x: r.width / 2 - GEO.TX * k, y: r.height / 2 - GEO.TY * k }, false);
  });
  await settleCounts(page);
}

/** Assert the four tiles, the caption, the layer rows, the unknown-start count,
 *  the Off-the-map badge and the histogram all agree with the independently
 *  derived figures. This is invariant 13 in one call: any figure that has
 *  stopped following `matchesFilters()` shows up here. */
async function expectEverythingLive(page, because) {
  const d = await derive(page);
  const [tl, rows, pc, note] = await Promise.all([
    tiles(page), layerRows(page), panelCounts(page), caption(page),
  ]);
  for (const t of tl) {
    expect(t.count, `tile ${t.kind} counts what is in view — ${because}`)
      .toBe(d.inViewKind[t.kind]);
  }
  for (const r of rows) {
    expect(r.count, `layer row ${r.kind} counts what matches the other axes — ${because}`)
      .toBe(d.scopeKind[r.kind]);
  }
  expect(pc.undated, `the unknown-start count follows the other axes — ${because}`).toBe(d.undated);
  expect(pc.nogeo, `the Off-the-map badge is state.offMapMatch — ${because}`).toBe(d.offMap);
  expect(pc.bars, `the histogram is drawn over the filtered scope — ${because}`).toBe(d.bars);
  expect(pc.lit, `the histogram lights the selected years — ${because}`).toBe(d.lit);
  expect(note, `the caption reports what matches the filters — ${because}`).toBe(captionFor(d));
  return d;
}

// ---------------------------------------------------------------------------
// §9.1 — the two readings, and every number saying which one it is
// ---------------------------------------------------------------------------

test.describe('§9.1 two readings', () => {
  test('§9.1 the tiles read "in view" and the caption reads "matches the filters" — and the two differ', async ({ page }) => {
    await open(page);
    await fitAll(page);
    const d = await derive(page);
    const c = await corpus(page);
    // Nothing is filtered, so "matches the filters" is the whole corpus while
    // "in view" can only ever be the placed entities. If these two were the
    // same reading the rewrite would not have been needed.
    expect(d.match).toBe(c.all);
    expect(d.inView).toBe(c.all - c.nogeo);
    expect(d.match).not.toBe(d.inView);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(d.match);
    expect(s.inView).toBe(d.inView);
    expect((await tiles(page)).reduce((a, t) => a + t.count, 0)).toBe(d.inView);
    expect(await caption(page)).toBe(captionFor(d));
  });

  test('§9.1 the layer rows report the match count, so "Commons 25" sits above a tile reading 24', async ({ page }) => {
    // The exact pairing the spec calls out. The gap is not a mistake — one
    // commons has no coordinates — but it only reads as a gap because the row
    // and the tile now report two labelled readings of the same filter state.
    await open(page);
    await fitAll(page);
    const c = await corpus(page);
    const row = (await layerRows(page)).find((r) => r.kind === 'commons');
    const tile = (await tiles(page)).find((t) => t.kind === 'commons');
    expect(row.count).toBe(c.totals.commons);
    expect(tile.count).toBe(c.totals.commons - c.nogeoByKind.commons);
    expect(row.count - tile.count).toBe(c.nogeoByKind.commons);
    expect(tile.title).toBe(`${tile.count} in view · ${row.count} match the filters`);
  });

  test('§9.1 there is no fifth tile: countries leads the caption instead', async ({ page }) => {
    await open(page);
    const shape = await page.evaluate(() => ({
      tiles: [...document.querySelectorAll('.stats > div')].length,
      ids: [...document.querySelectorAll('.stats strong')].map((s) => s.id),
      countryTile: !!document.getElementById('st-country') || !!document.getElementById('st-countries'),
    }));
    expect(shape.tiles).toBe(4);
    expect(shape.ids).toEqual(['st-project', 'st-team', 'st-commons', 'st-framework']);
    expect(shape.countryTile).toBe(false);
    const d = await derive(page);
    expect(await caption(page)).toBe(captionFor(d));
    expect(await caption(page)).toMatch(/^\d+ countries · /);
  });

  test('§9.1 a corpus total appears only in the title of a count that has narrowed', async ({ page }) => {
    await open(page);
    const c = await corpus(page);
    // Nothing narrowed: the rows *are* the corpus totals, so there is no second
    // figure to show and the title stays empty rather than restating them.
    for (const r of await layerRows(page)) {
      expect(r.count).toBe(c.totals[r.kind]);
      expect(r.title).toBe('');
    }
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    for (const r of await layerRows(page)) {
      if (r.count === c.totals[r.kind]) expect(r.title).toBe('');
      else expect(r.title).toBe(`${r.count} of ${c.totals[r.kind]} under the current filters`);
    }
  });

  test('§9.1 / inv 13 the welcome panel keeps the corpus totals while the sidebar has narrowed', async ({ page }) => {
    // The welcome panel is one of the two places a corpus constant is allowed
    // to survive, because it describes the map rather than the current view.
    await open(page);
    const c = await corpus(page);
    await setLayers(page, ['commons']);
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    await page.evaluate(() => openWelcome());
    const wl = await page.evaluate(() =>
      [...document.querySelectorAll('#wl-rows .wl-row .n')].map((n) => Number(n.textContent)));
    expect(wl.slice(0, 4)).toEqual(KINDS.map((k) => c.totals[k]));
    // ...and the live rows next door have not stayed on those numbers.
    const rows = await layerRows(page);
    expect(rows.map((r) => r.count)).not.toEqual(KINDS.map((k) => c.totals[k]));
  });
});

// ---------------------------------------------------------------------------
// Invariant 14 — every headline figure traces to one control
// ---------------------------------------------------------------------------

test.describe('inv 14 one tile per layer', () => {
  test('inv 14 exactly one header tile per layer, addressed as st-<kind>, in layer order', async ({ page }) => {
    await open(page);
    const t = await tiles(page);
    expect(t.map((x) => x.kind)).toEqual(KINDS);
    expect(t.map((x) => x.label)).toEqual(['Projects', 'Teams', 'Commons', 'Frameworks']);
    // No aggregate tile: the "Resources" figure that merged commons and
    // frameworks had no row a reader could check it against.
    expect((await caption(page)) + t.map((x) => x.label).join(' ')).not.toMatch(/Resources/);
    const rows = await layerRows(page);
    expect(rows.map((r) => r.kind)).toEqual(t.map((x) => x.kind));
  });

  test('inv 14 the tiles sum to state.inView across zoom, layer, period and My map states', async ({ page }) => {
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify(['sbb']) } });
    const check = async (because) => {
      await settleCounts(page);
      const s = await snapshot(page);
      const d = await derive(page);
      const t = await tiles(page);
      expect(t.reduce((a, x) => a + x.count, 0), because).toBe(s.inView);
      // The sum on its own is an identity, not a property: `renderStats()`
      // bins `state.inView` by kind, so four tiles addressed by kind cannot
      // help adding up to it. What has to hold in each of these states is that
      // every tile carries the independently derived per-layer in-view figure.
      for (const x of t) {
        expect(x.count, `${because} — tile ${x.kind}`).toBe(d.inViewKind[x.kind]);
      }
    };
    await check('default');
    await zoomBy(page, 3); await check('zoomed in');
    await showWholeMap(page); await check('whole map');
    await setLayers(page, ['commons', 'framework']); await check('two layers');
    await setPeriod(page, 2015, 2018); await check('narrowed period');
    await setLayers(page, []); await check('every layer off');
    await applyPreset(page, 'overview'); await check('preset reset');
    await page.evaluate(() => toggleMyMap()); await check('My map');
  });

  test('inv 14 each tile carries its own reconciliation, and the accessible name keeps the label in front', async ({ page }) => {
    await open(page);
    await fitAll(page);
    const d = await derive(page);
    for (const t of await tileA11y(page)) {
      const v = d.inViewKind[t.kind], m = d.matchKind[t.kind];
      const msg = `${v} in view · ${m} ${m === 1 ? 'matches' : 'match'} the filters`;
      expect(t.title, `tile ${t.kind} tooltip`).toBe(msg);
      // The tiles sit in an aria-live region: a bare tooltip would announce the
      // reconciliation and drop which layer it belonged to.
      expect(t.aria, `tile ${t.kind} accessible name`).toBe(`${t.label} — ${msg}`);
      expect(t.aria.startsWith(t.label + ' —')).toBe(true);
    }
  });

  test('inv 14 / §9.1 n=1 verb agreement in a tile title and in the caption', async ({ page }) => {
    // One commons carries the maritime domain, so this pair of axes selects
    // exactly one entity — the singular branch of both grammars at once.
    await open(page, { hash: '#lay=commons&dom=maritime' });
    const d = await derive(page);
    expect(d.match).toBe(1);
    expect(d.inView).toBe(1);
    const tile = (await tileA11y(page)).find((t) => t.kind === 'commons');
    expect(tile.title).toBe('1 in view · 1 matches the filters');
    expect(tile.aria).toBe('Commons — 1 in view · 1 matches the filters');
    expect(await caption(page)).toBe('1 country · in view · 1 matches the filters');
    // Zero is the other side of the same branch, on a layer with no entities.
    const empty = (await tileA11y(page)).find((t) => t.kind === 'framework');
    expect(empty.title).toBe('0 in view · 0 match the filters');
  });
});

// ---------------------------------------------------------------------------
// Invariant 12 — the counters reconcile at every zoom level
// ---------------------------------------------------------------------------

test.describe('inv 12 reconciliation', () => {
  test('§9.2 / inv 12 in view + off screen + off the map reconciles at every zoom', async ({ page }) => {
    await open(page);
    await showWholeMap(page);
    await expectCountersReconcile(page, 'whole map');
    for (const f of [1.6, 2, 2, 2, 2]) {
      await zoomBy(page, f);
      const d = await derive(page);
      const s = await snapshot(page);
      expect(s.inView, `in view at k=${f}`).toBe(d.inView);
      expect(s.offScreen, `off screen at k=${f}`).toBe(d.offScreen);
      expect(s.offMapMatch, `off the map at k=${f}`).toBe(d.offMap);
      await expectCountersReconcile(page, `zoomed by ${f}`);
      expect(await caption(page)).toBe(captionFor(d));
    }
  });

  test('§9.2 / inv 12 reconciles across a pan grid at one zoom', async ({ page }) => {
    await open(page);
    await zoomBy(page, 2.5);
    const grid = [[-600, -400], [0, -400], [600, -400], [-600, 0], [600, 0], [-600, 400], [0, 400], [600, 400]];
    for (const [dx, dy] of grid) {
      await page.evaluate(([x, y]) => setView({ k: view.k, x: view.x + x, y: view.y + y }, false), [dx, dy]);
      await settleCounts(page);
      const d = await derive(page);
      const s = await snapshot(page);
      expect(s.inView, `in view after pan ${dx},${dy}`).toBe(d.inView);
      expect(s.offScreen, `off screen after pan ${dx},${dy}`).toBe(d.offScreen);
      await expectCountersReconcile(page, `panned ${dx},${dy}`);
    }
  });

  test('§9.2 / inv 12 at the default fit every placed marker is on screen, so only the off-map term appears', async ({ page }) => {
    // The spec's own reasoning: naming only the off-map part reads as though it
    // accounts for the whole difference, "which it does at the default fit".
    await open(page);
    await fitAll(page);
    const c = await corpus(page);
    const s = await snapshot(page);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(c.nogeo);
    expect(s.inView).toBe(c.all - c.nogeo);
    expect(await caption(page)).toMatch(new RegExp(`\\(${c.nogeo} off the map\\)$`));
    await expectCountersReconcile(page, 'default fit');
  });

  test('§9.2 / inv 12 panned right off the map: nothing in view, every placed marker named as off screen', async ({ page }) => {
    await open(page);
    await page.evaluate(() => setView({ k: view.k, x: -99999, y: -99999 }, false));
    await settleCounts(page);
    const c = await corpus(page);
    const s = await snapshot(page);
    expect(s.inView).toBe(0);
    expect(s.offScreen).toBe(c.all - c.nogeo);
    expect(s.matchCount).toBe(c.all);
    // Zero countries, so the caption drops that term entirely rather than
    // leading with "0 countries ·".
    expect(await caption(page))
      .toBe(`in view · ${c.all} match the filters (${c.all - c.nogeo} off screen, ${c.nogeo} off the map)`);
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0]);
    await expectCountersReconcile(page, 'panned off the map');
  });

  test('§9.2 / inv 12 reconciles with each single layer on, and with every layer off', async ({ page }) => {
    await open(page);
    for (const k of KINDS) {
      await setLayers(page, [k]);
      await settleCounts(page);
      const d = await derive(page);
      const s = await snapshot(page);
      expect(s.matchCount, `only ${k} on`).toBe(d.match);
      expect(s.offMapMatch, `off-map with only ${k} on`).toBe(d.offMap);
      await expectCountersReconcile(page, `only the ${k} layer`);
    }
    await setLayers(page, []);
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.inView).toBe(0);
    expect(s.matchCount).toBe(0);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(0);
    await expectCountersReconcile(page, 'every layer off');
  });

  test('§9.2 / inv 12 reconciles with a narrowed period, zoomed in and zoomed out', async ({ page }) => {
    await open(page);
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    await expectCountersReconcile(page, 'narrowed period, default view');
    const wide = await derive(page);
    expect((await snapshot(page)).matchCount).toBe(wide.match);
    await zoomBy(page, 4);
    await expectCountersReconcile(page, 'narrowed period, zoomed in');
    const near = await derive(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(wide.match);          // the filter reading is zoom-invariant
    expect(s.inView).toBe(near.inView);
    expect(s.offScreen).toBe(near.offScreen);
    expect(near.offScreen).toBeGreaterThan(wide.offScreen);
  });

  test('§9.2 / inv 12 the kept-open card is the third term, and it reconciles at every zoom', async ({ page }) => {
    await open(page, { hash: '#e=3ia-saclay' });
    await setLayers(page, []);
    await settleCounts(page);
    for (const f of [1, 2, 0.25, 8]) {
      if (f !== 1) await zoomBy(page, f);
      const d = await derive(page);
      const s = await snapshot(page);
      expect(s.matchCount, `match count at ${f}`).toBe(0);
      expect(s.keptOpen, `kept open at ${f}`).toBe(1);
      expect(s.inView + s.offScreen + s.offMapMatch, `reconciliation at ${f}`)
        .toBe(s.matchCount + s.keptOpen);
      expect(d.keptOpen).toBe(1);
      expect(await caption(page)).toBe(captionFor(d));
    }
  });

  test('§9.2 / inv 12 reconciles in My map mode, including a pin with no coordinates', async ({ page }) => {
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify(['sbb']) } });
    await page.evaluate(() => toggleMyMap());
    await settleCounts(page);
    await expectCountersReconcile(page, 'My map');
    await zoomBy(page, 3);
    await expectCountersReconcile(page, 'My map, zoomed in');

    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify(['iso-9241-210']) } });
    await page.evaluate(() => toggleMyMap());
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.inView).toBe(0);           // a standard with no coordinates has no marker
    expect(s.offMapMatch).toBe(1);
    expect(s.matchCount).toBe(1);
    await expectCountersReconcile(page, 'My map on an off-map pin');
  });

  test('§9.2 / inv 12 the collapsed sidebar widens the stage without breaking the reconciliation', async ({ page }) => {
    await open(page);
    const before = await snapshot(page);
    await zoomCentre(page, 3);
    const narrow = await snapshot(page);
    expect(narrow.offScreen).toBeGreaterThan(0);    // the stage is genuinely too small
    await page.evaluate(() => { document.body.classList.add('sb-hidden'); stageResized(); });
    await settleCounts(page);
    const wide = await derive(page);
    const s = await snapshot(page);
    expect(s.inView).toBe(wide.inView);
    expect(s.offScreen).toBe(wide.offScreen);
    expect(s.matchCount).toBe(before.matchCount);   // the filters did not move
    expect(s.inView).toBeGreaterThan(narrow.inView);  // a wider stage holds more
    await expectCountersReconcile(page, 'sidebar collapsed');
  });
});

// ---------------------------------------------------------------------------
// §9.2 — the stage rectangle's 10 px margin
// ---------------------------------------------------------------------------

test.describe('§9.2 the stage test', () => {
  test('§9.2 the stage rectangle carries a 10 px margin, on every edge', async ({ page }) => {
    // `updateInView()` "tests it against the stage rectangle with a 10 px
    // margin". Nothing used to assert the margin: setting `pad` to 0 still
    // failed two tests, but only because two of the eight pan positions in the
    // grid above happen to leave a marker inside the band — coverage by
    // coincidence, which moves the next time the data does. This parks one
    // known marker at a chosen offset from each edge instead.
    await open(page);
    // Offsets are measured from the edge outwards, with the other axis parked
    // at the centre of the stage so only the edge under test can exclude it.
    const park = (edge, out) => page.evaluate(([e, o]) => {
      const it = items.find((i) => i.geo);
      const r = document.getElementById('stage').getBoundingClientRect();
      const wx = it.X * view.k, wy = it.Y * view.k;
      const mid = { x: r.width / 2 - wx, y: r.height / 2 - wy };
      const at = {
        right: { x: r.width + o - wx, y: mid.y },
        left: { x: -o - wx, y: mid.y },
        bottom: { x: mid.x, y: r.height + o - wy },
        top: { x: mid.x, y: -o - wy },
      }[e];
      setView({ k: view.k, x: at.x, y: at.y }, false);
      return it.id;
    }, [edge, out]);
    const counted = (id) => page.evaluate((i) => state.inView.has(i), id);

    for (const edge of ['right', 'left', 'bottom', 'top']) {
      const id = await park(edge, 5);
      await settleCounts(page);
      expect(await counted(id), `5 px past the ${edge} edge is inside the margin`).toBe(true);
      await park(edge, 15);
      await settleCounts(page);
      expect(await counted(id), `15 px past the ${edge} edge is outside it`).toBe(false);
      // And the marker that just left the view is named as off screen rather
      // than quietly dropped from both readings (invariant 12).
      const s = await snapshot(page);
      expect(s.inView + s.offScreen + s.offMapMatch, `reconciles past the ${edge} edge`)
        .toBe(s.matchCount + s.keptOpen);
    }
  });
});

// ---------------------------------------------------------------------------
// §9.2 — the unmeasured stage
// ---------------------------------------------------------------------------

test.describe('§9.2 unmeasured stage', () => {
  test('§9.2 printing measures the stage at zero, so every placed marker counts rather than none', async ({ page }) => {
    await open(page);
    await zoomBy(page, 6);                       // most markers off screen first
    expect((await snapshot(page)).offScreen).toBeGreaterThan(0);
    // The print stylesheet hides #app, so the stage rect collapses to zero.
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => refresh());
    await settleCounts(page);
    const c = await corpus(page);
    const d = await derive(page);
    expect(d.unmeasured).toBe(true);
    const s = await snapshot(page);
    expect(s.inView).toBe(c.all - c.nogeo);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(c.nogeo);
    expect((await tiles(page)).reduce((a, t) => a + t.count, 0)).toBe(s.inView);
    await expectCountersReconcile(page, 'printing');
  });

  test('§9.2 a hidden pane counts the same way as printing', async ({ page }) => {
    await open(page);
    await zoomBy(page, 6);
    await page.evaluate(() => { document.getElementById('stage').style.display = 'none'; refresh(); });
    const c = await corpus(page);
    const s = await snapshot(page);
    expect((await derive(page)).unmeasured).toBe(true);
    expect(s.inView).toBe(c.all - c.nogeo);
    expect(s.offScreen).toBe(0);
    expect(await caption(page)).toMatch(new RegExp(`\\(${c.nogeo} off the map\\)$`));
  });
});

// ---------------------------------------------------------------------------
// Invariant 13 — no count is a corpus constant unless it is labelled as one
// ---------------------------------------------------------------------------

test.describe('inv 13 no frozen counts', () => {
  test('inv 13 the numbers the spec names as the frozen ones are still the corpus numbers', async ({ page }) => {
    // 111 / 268 / 25 / 45, 37 and 11 are the figures §9.1 quotes as the ones
    // that used to sit there whatever the reader did. Pinning them here means
    // the regression tests below keep describing the bug they were written for.
    await open(page);
    const c = await corpus(page);
    expect(c.totals).toEqual({ project: 111, team: 268, commons: 25, framework: 45 });
    expect(c.all).toBe(449);
    expect(c.undated).toBe(37);
    expect(c.nogeo).toBe(11);
    expect(c.undatedByKind).toEqual({ team: 37 });   // "all of them teams"
    expect(await page.evaluate(() => ({ ...TOTALS }))).toEqual(c.totals);
  });

  test('inv 13 narrowing the period moves the layer rows off 111 / 268 / 25 / 45', async ({ page }) => {
    await open(page);
    const c = await corpus(page);
    const before = await layerRows(page);
    expect(before.map((r) => r.count)).toEqual(KINDS.map((k) => c.totals[k]));
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    const d = await derive(page);
    const after = await layerRows(page);
    for (const r of after) {
      expect(r.count, `row ${r.kind} after narrowing`).toBe(d.scopeKind[r.kind]);
      expect(r.count, `row ${r.kind} must not still be the corpus total`).not.toBe(c.totals[r.kind]);
    }
    // The rows are still a match count, not an in-view count: zooming must not
    // touch them.
    await zoomBy(page, 4);
    expect((await layerRows(page)).map((r) => r.count)).toEqual(after.map((r) => r.count));
  });

  test('inv 13 narrowing the period moves the Off-the-map badge off 11', async ({ page }) => {
    await open(page);
    const c = await corpus(page);
    let pc = await panelCounts(page);
    expect(pc.nogeo).toBe(c.nogeo);
    expect(pc.nogeoTitle).toBe('');                 // not narrowed: nothing to reconcile
    expect(pc.nogeoRows).toBe(c.nogeo);             // every off-map entity stays listed
    expect(pc.nogeoDimmed).toBe(0);
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    const d = await derive(page);
    pc = await panelCounts(page);
    expect(pc.nogeo).toBe(d.offMap);
    expect(pc.nogeo).not.toBe(c.nogeo);
    expect(pc.nogeoTitle).toBe(`${pc.nogeo} of ${c.nogeo} match the current filters`);
    // The ones that no longer match stay reachable but dimmed, so the badge and
    // the list agree by inspection (§9.3).
    expect(pc.nogeoRows).toBe(c.nogeo);
    expect(pc.nogeoDimmed).toBe(c.nogeo - pc.nogeo);
  });

  test('inv 13 the Off-the-map badge follows the layer switches too, down to 1 and to 0', async ({ page }) => {
    await open(page);
    const c = await corpus(page);
    for (const [layer, expected] of [
      ['commons', c.nogeoByKind.commons], ['framework', c.nogeoByKind.framework], ['project', 0], ['team', 0],
    ]) {
      await setLayers(page, [layer]);
      await settleCounts(page);
      const pc = await panelCounts(page);
      expect(pc.nogeo, `off the map with only ${layer} on`).toBe(expected);
      const verb = expected === 1 ? 'matches' : 'match';
      expect(pc.nogeoTitle).toBe(`${expected} of ${c.nogeo} ${verb} the current filters`);
      expect(pc.nogeoDimmed).toBe(c.nogeo - expected);
    }
  });

  test('inv 13 narrowing the period relights the histogram instead of leaving every year on', async ({ page }) => {
    await open(page);
    let pc = await panelCounts(page);
    const all = pc.bars;
    expect(pc.lit).toBe(all);                       // full range: every bar selected
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    const d = await derive(page);
    pc = await panelCounts(page);
    expect(pc.lit).toBe(d.lit);
    expect(pc.lit).toBe(3);                         // 2010, 2011, 2012 all have bars
    expect(pc.lit).toBeLessThan(all);
    // Bar *presence* is all this can see — a long-lived team keeps every year
    // populated — so it only shows the curve was not narrowed away entirely.
    // The curve skipping its own axis is the next test, over the heights.
    expect(pc.bars).toBe(all);
  });

  test('§6.1 / inv 13 the curve is redrawn by every axis but its own, heights included', async ({ page }) => {
    // Written against a surviving mutant: dropping `'period'` from
    // `renderHist()`'s `scopeItems('period')` — the one argument §6.1 exists
    // for — left every assertion in this file green. Bar *presence* cannot see
    // it, because a team founded before `YMIN` keeps all ~80 years populated
    // under any filter; only the heights move. So the curve is checked twice:
    // against the derived per-year population, and against itself before and
    // after the period moved.
    await open(page);
    const wide = await histBars(page);
    expectCurveRanks(wide, await derive(page), 'the full period');

    // The period is this control's own axis, so narrowing it must not redraw a
    // single bar — §6.1's "its own toggle must not move its own number", for a
    // number that happens to be a shape.
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    const narrowed = await histBars(page);
    expect(narrowed).toEqual(wide);
    expectCurveRanks(narrowed, await derive(page), 'a narrowed period');

    // ...and "every other filter must", or the equality above would hold for a
    // curve frozen on the corpus just as well as for a live one.
    await setLayers(page, ['team']);
    await settleCounts(page);
    const teams = await histBars(page);
    expect(teams).not.toEqual(wide);
    expectCurveRanks(teams, await derive(page), 'teams only, period still narrowed');

    await setLayers(page, ['commons']);
    await settleCounts(page);
    const commons = await histBars(page);
    expect(commons).not.toEqual(teams);
    expectCurveRanks(commons, await derive(page), 'commons only, period still narrowed');
  });

  test('inv 13 narrowing the layer axis moves the unknown-start count off 37 — to 0 on Commons', async ({ page }) => {
    // The spec's example, exactly: every one of the 37 is a team, so a reader
    // filtered to Commons was shown 37 for a set the switch cannot touch.
    await open(page);
    const c = await corpus(page);
    expect((await panelCounts(page)).undated).toBe(c.undated);
    await setLayers(page, ['commons']);
    await settleCounts(page);
    const pc = await panelCounts(page);
    expect(pc.undated).toBe(0);
    expect(pc.undatedTitle).toBe(`0 of ${c.undated} under the current filters`);
    await setLayers(page, ['team']);
    await settleCounts(page);
    expect((await panelCounts(page)).undated).toBe(c.undatedByKind.team);
  });

  test('inv 13 narrowing the layer axis redraws the histogram over the filtered scope', async ({ page }) => {
    await open(page);
    const all = (await panelCounts(page)).bars;
    for (const layer of ['commons', 'project', 'framework']) {
      await setLayers(page, [layer]);
      await settleCounts(page);
      const d = await derive(page);
      const pc = await panelCounts(page);
      expect(pc.bars, `histogram bars with only ${layer} on`).toBe(d.bars);
      expect(pc.bars, `histogram must not keep the corpus curve on ${layer}`).toBeLessThan(all);
    }
    await setLayers(page, []);
    await settleCounts(page);
    expect((await panelCounts(page)).bars).toBe(0);   // nothing selected, nothing drawn
  });

  test('inv 13 narrowing the domain axis moves the layer rows, the unknown start count and the histogram at once', async ({ page }) => {
    await open(page, { hash: '#dom=maritime' });
    const c = await corpus(page);
    const d = await expectEverythingLive(page, 'maritime only');
    const rows = await layerRows(page);
    expect(rows.map((r) => r.count)).not.toEqual(KINDS.map((k) => c.totals[k]));
    const pc = await panelCounts(page);
    expect(pc.undated).toBe(d.undated);
    // The bar *set* need not shrink — one long-lived team covers every year —
    // but the figure the switch governs must no longer be the corpus 37.
    expect(pc.undated).toBeLessThan(c.undated);
  });

  test('§6.1 a control\'s own axis does not move its own number', async ({ page }) => {
    // The other half of §6.1, and the reason the unknown-start count is not
    // expected to follow the period: a figure that collapsed when you touched
    // its own switch would be useless for deciding whether to touch it back.
    await open(page);
    const c = await corpus(page);
    const rows0 = await layerRows(page);
    await toggleLayer(page, 'commons');             // its own axis
    await settleCounts(page);
    expect((await layerRows(page)).map((r) => r.count)).toEqual(rows0.map((r) => r.count));
    expect((await layerRows(page)).find((r) => r.kind === 'commons').on).toBe(false);

    await toggleLayer(page, 'commons');
    await setPeriod(page, 1945, 1946);              // the unknown-start switch's own axis
    await settleCounts(page);
    const pc = await panelCounts(page);
    expect(pc.undated).toBe(c.undated);
    expect(pc.undatedTitle).toBe('');
  });

  test('inv 13 every live count is recomputed by refresh() alone, not by its own render function', async ({ page }) => {
    // §17's rule for adding a counter: update it from refresh(), because
    // renderTime() and renderNoGeo() run on language and preset changes, which
    // is not when the filters move. Poking the state and calling only refresh()
    // is the cheapest way to catch a counter wired to the wrong function.
    await open(page);
    const c = await corpus(page);
    await page.evaluate(() => {
      state.layers.team = false; state.layers.project = false; state.layers.framework = false;
      state.years = { a: 2015, b: 2018, undated: true };
      refresh();
    });
    await settleCounts(page);
    const d = await derive(page);
    const pc = await panelCounts(page);
    expect(pc.undated).toBe(0);                     // all 37 are teams, and teams are off
    expect(pc.undated).not.toBe(c.undated);
    expect(pc.nogeo).toBe(d.offMap);
    expect(pc.bars).toBe(d.bars);
    expect(pc.lit).toBe(d.lit);
    for (const r of await layerRows(page)) expect(r.count).toBe(d.scopeKind[r.kind]);
    for (const t of await tiles(page)) expect(t.count).toBe(d.inViewKind[t.kind]);
    expect(await caption(page)).toBe(captionFor(d));
  });

  test('inv 13 switching language does not restore the corpus totals into the layer rows', async ({ page }) => {
    // renderLayerRows() writes TOTALS[k] into the markup and relies on
    // updateLayerCounts() to overwrite it; applyLang() re-runs that render on
    // every language switch, which is exactly where the frozen numbers used to
    // come back.
    await open(page);
    const c = await corpus(page);
    await setPeriod(page, 2010, 2012);
    await settleCounts(page);
    const en = await layerRows(page);
    await page.click('.lang-switch button[data-lang="fr"]');
    await settleCounts(page);
    const fr = await layerRows(page);
    expect(fr.map((r) => r.count)).toEqual(en.map((r) => r.count));
    expect(fr.map((r) => r.count)).not.toEqual(KINDS.map((k) => c.totals[k]));
    expect(fr.find((r) => r.kind === 'commons').title)
      .toBe(`${fr.find((r) => r.kind === 'commons').count} sur ${c.totals.commons} avec les filtres actuels`);
    // Spelled out rather than matched loosely: `/correspond(ent)?/` accepts
    // both verbs, so it stays green when the agreement branch is deleted.
    expect(await caption(page)).toBe(captionForFr(await derive(page)));
  });

  test('inv 13 a preset is a clean slate and every count follows it back up', async ({ page }) => {
    await open(page);
    const c = await corpus(page);
    await setLayers(page, ['commons']);
    await setPeriod(page, 1990, 1995);
    await settleCounts(page);
    await applyPreset(page, 'health');
    await settleCounts(page);
    await expectEverythingLive(page, 'the Health preset');
    // The preset resets the layers and the period, so only the domain axis is
    // narrow: the rows must be below the corpus, not back at it.
    const rows = await layerRows(page);
    for (const r of rows) expect(r.count).toBeLessThan(c.totals[r.kind]);
    await applyPreset(page, 'overview');
    await settleCounts(page);
    expect((await layerRows(page)).map((r) => r.count)).toEqual(KINDS.map((k) => c.totals[k]));
    expect((await panelCounts(page)).nogeo).toBe(c.nogeo);
    expect((await panelCounts(page)).undated).toBe(c.undated);
  });

  test('inv 13 the period floor and ceiling are live states, not the corpus state', async ({ page }) => {
    await open(page);
    const c = await corpus(page);
    const bounds = await page.evaluate(() => ({ ymin: YMIN, ymax: YMAX }));
    await setPeriod(page, bounds.ymin, bounds.ymin);
    await settleCounts(page);
    let d = await expectEverythingLive(page, 'the period floor');
    expect(d.lit).toBe(1);
    expect(d.match).toBeLessThan(c.all);

    await setPeriod(page, bounds.ymax, bounds.ymax);
    await settleCounts(page);
    d = await expectEverythingLive(page, 'the period ceiling');
    expect(d.lit).toBe(1);
    expect(d.match).toBeLessThan(c.all);

    // Clamped back past both ends: no period filter at all, so every row is the
    // corpus total again and none of them carries a reconciliation title.
    await setPeriod(page, bounds.ymin - 500, bounds.ymax + 500);
    await settleCounts(page);
    expect((await layerRows(page)).map((r) => r.count)).toEqual(KINDS.map((k) => c.totals[k]));
    for (const r of await layerRows(page)) expect(r.title).toBe('');
    expect((await snapshot(page)).matchCount).toBe(c.all);
  });

  test('inv 13 the floor stays inclusive: an entity founded before the axis starts is still reachable there', async ({ page }) => {
    // §10's slider floor. Unchecking "unknown start" at the floor year leaves
    // only dated entities running in 1945 — a handful of founders that predate
    // the axis — and the counters must report that handful, not zero and not
    // the corpus.
    await open(page, { hash: '#yr=1945,1945&nd=0' });
    const d = await expectEverythingLive(page, 'the floor year with unknown starts excluded');
    expect(d.match).toBeGreaterThan(0);
    expect(d.match).toBe(d.matchKind.team);         // the founders on this map are all teams
    expect((await snapshot(page)).matchCount).toBe(d.match);
  });
});

// ---------------------------------------------------------------------------
// §9.2 — the caption's three named terms
// ---------------------------------------------------------------------------

test.describe('§9.2 the caption names the gap', () => {
  test('§9.2 "off screen" alone: zoomed in on layers that are all placed', async ({ page }) => {
    // Projects and teams all carry coordinates, so this isolates the pan/zoom
    // term from the off-map one.
    await open(page);
    await setLayers(page, ['project', 'team']);
    await zoomCentre(page, 2.2);
    const d = await derive(page);
    expect(d.offMap).toBe(0);
    expect(d.keptOpen).toBe(0);
    expect(d.offScreen).toBeGreaterThan(0);
    expect(d.inView).toBeGreaterThan(0);
    const note = await caption(page);
    expect(note).toBe(
      `${d.countries} countries · in view · ${d.match} match the filters (${d.offScreen} off screen)`);
    expect(note).toMatch(/\(\d+ off screen\)$/);   // and no other term
  });

  test('§9.2 "off the map" alone: the whole map on screen', async ({ page }) => {
    await open(page);
    await showWholeMap(page);
    const c = await corpus(page);
    const d = await derive(page);
    expect(d.offScreen).toBe(0);
    expect(await caption(page)).toBe(
      `${d.countries} countries · in view · ${c.all} match the filters (${c.nogeo} off the map)`);
  });

  test('§9.2 "plus the open card" alone: a card the filters exclude, with every layer off', async ({ page }) => {
    // The surplus the other way round. state.matchCount counts `matched`,
    // recorded before visibleSet() re-adds the focused entity, so the caption
    // can say 0 while a tile says 1 — and the difference is named rather than
    // left to read as an off-by-one.
    await open(page, { hash: '#e=3ia-saclay' });
    await setLayers(page, []);
    await settleCounts(page);
    expect(await caption(page)).toBe('1 country · in view · 0 match the filters (plus the open card)');
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.keptOpen).toBe(1);
    expect(s.inView).toBe(1);
    expect((await tiles(page)).map((t) => t.count)).toEqual([1, 0, 0, 0]);
    // The tile's own reconciliation says the same thing in the other direction.
    expect((await tileA11y(page)).find((t) => t.kind === 'project').title)
      .toBe('1 in view · 0 match the filters');
  });

  test('§9.2 all three terms at once, in the order off screen, off the map, open card', async ({ page }) => {
    await open(page, { hash: '#e=3ia-saclay&lay=framework' });
    await zoomBy(page, 2);
    const d = await derive(page);
    expect(d.offScreen).toBeGreaterThan(0);
    expect(d.offMap).toBeGreaterThan(0);
    expect(d.keptOpen).toBe(1);
    const note = await caption(page);
    expect(note).toBe(captionFor(d));
    expect(note).toBe(
      `in view · ${d.match} match the filters (${d.offScreen} off screen, ${d.offMap} off the map, plus the open card)`);
    const i = (s) => note.indexOf(s);
    expect(i('off screen')).toBeLessThan(i('off the map'));
    expect(i('off the map')).toBeLessThan(i('plus the open card'));
  });

  test('§9.2 no parenthetical at all when nothing is missing', async ({ page }) => {
    await open(page, { hash: '#lay=project' });
    const c = await corpus(page);
    const d = await derive(page);
    expect(d.offScreen).toBe(0);
    expect(d.offMap).toBe(0);
    expect(await caption(page)).toBe(`${d.countries} countries · in view · ${c.totals.project} match the filters`);
    expect(await caption(page)).not.toContain('(');
  });

  test('§9.1 zero results: the caption is bare and every tile reads 0', async ({ page }) => {
    await open(page);
    await setLayers(page, []);
    await settleCounts(page);
    // "0 countries ·" would be noise, so the term is dropped rather than shown.
    expect(await caption(page)).toBe('in view · 0 match the filters');
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0]);
    expect(await feedHeader(page)).toEqual({ count: 0, offScreen: null, offMap: null });
    const pc = await panelCounts(page);
    expect(pc.nogeo).toBe(0);
    expect(pc.undated).toBe(0);
    expect(pc.bars).toBe(0);
  });

  test('§9.2 My map does not claim to be a filter state', async ({ page }) => {
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify(['sbb']) } });
    await page.evaluate(() => toggleMyMap());
    await settleCounts(page);
    const d = await derive(page);
    expect(d.match).toBe(4);                        // sbb plus its three neighbours
    const note = await caption(page);
    expect(note).toBe(`${d.countries} countries · in view · ${d.match} on your map`);
    expect(note).not.toContain('match the filters');
    // Leaving My map puts the filter wording back.
    await page.evaluate(() => toggleMyMap());
    await settleCounts(page);
    expect(await caption(page)).toContain('match the filters');
    expect(await caption(page)).not.toContain('on your map');
  });

  test('§6.1 in My map mode the layer rows describe the My map set, not the corpus', async ({ page }) => {
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify(['sbb']) } });
    await page.evaluate(() => toggleMyMap());
    await settleCounts(page);
    const d = await derive(page);
    const rows = await layerRows(page);
    for (const r of rows) expect(r.count, `row ${r.kind} in My map`).toBe(d.scopeKind[r.kind]);
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(d.match);
    expect((await panelCounts(page)).undated).toBe(d.undated);
  });
});

// ---------------------------------------------------------------------------
// §9.3 — the same reconciliation, restated in the feed header
// ---------------------------------------------------------------------------

test.describe('§9.3 the feed header restates the gap', () => {
  test('§9.3 the feed header quotes state.inView, state.offScreen and state.offMapMatch', async ({ page }) => {
    await open(page);
    await zoomBy(page, 3);
    const s = await snapshot(page);
    const d = await derive(page);
    expect(s.offScreen).toBeGreaterThan(0);
    // `#fd-count` is written from `state.inView.size`, so comparing the two
    // only checks the wiring; the figures themselves are pinned to `derive()`.
    expect(s.inView).toBe(d.inView);
    expect(s.offScreen).toBe(d.offScreen);
    expect(s.offMapMatch).toBe(d.offMap);
    expect(await feedHeader(page)).toEqual({
      count: s.inView,
      offScreen: `+ ${s.offScreen} off screen`,
      offMap: `+ ${s.offMapMatch} off the map`,
    });
    // Each part hides rather than showing a zero.
    await showWholeMap(page);
    const fh = await feedHeader(page);
    expect(fh.count).toBe((await snapshot(page)).inView);
    expect(fh.offScreen).toBe(null);
    expect(fh.offMap).toBe(`+ ${(await snapshot(page)).offMapMatch} off the map`);
  });

  test('§9.3 a button that promises a number lands on that number: "+ N off the map" equals the badge', async ({ page }) => {
    await open(page);
    for (const layers of [KINDS, ['framework'], ['commons'], ['commons', 'framework']]) {
      await setLayers(page, layers);
      await settleCounts(page);
      const pc = await panelCounts(page);
      const fh = await feedHeader(page);
      expect(fh.offMap, `off-map button with ${layers.join('+')}`).toBe(`+ ${pc.nogeo} off the map`);
      expect(pc.nogeo).toBe((await snapshot(page)).offMapMatch);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundaries the counters have to survive
// ---------------------------------------------------------------------------

test.describe('counter boundaries', () => {
  test('§9.1 the counters still compute when localStorage throws (private mode)', async ({ page }) => {
    // Nothing about counting depends on persistence, but boot reads
    // localStorage before the first refresh(), so a throwing accessor used to
    // be able to take the whole panel down with it.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true, get() { throw new Error('private mode'); },
      });
    });
    await open(page);
    const c = await corpus(page);
    const d = await derive(page);
    expect(d.match).toBe(c.all);
    expect((await snapshot(page)).matchCount).toBe(c.all);
    expect(await caption(page)).toBe(captionFor(d));
    await expectCountersReconcile(page, 'private mode');
  });

  test('§9.2 one result: the singular caption, one tile at 1, the rest at 0', async ({ page }) => {
    await open(page, { hash: '#lay=commons&dom=maritime' });
    const d = await derive(page);
    expect(d.match).toBe(1);
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 1, 0]);
    expect(await feedHeader(page)).toEqual({ count: 1, offScreen: null, offMap: null });
    expect(await caption(page)).toBe('1 country · in view · 1 matches the filters');
    // Zoom past it and the one result becomes the one off-screen entity.
    await page.evaluate(() => setView({ k: view.k, x: -99999, y: -99999 }, false));
    await settleCounts(page);
    expect(await caption(page)).toBe('in view · 1 matches the filters (1 off screen)');
    expect(await feedHeader(page)).toEqual({ count: 0, offScreen: '+ 1 off screen', offMap: null });
  });

  test('§9.2 closing the card drops the kept-open term again', async ({ page }) => {
    await open(page, { hash: '#e=3ia-saclay' });
    await setLayers(page, []);
    await settleCounts(page);
    expect((await snapshot(page)).keptOpen).toBe(1);
    // §9.3: clicking the open feed row collapses the card.
    await page.click('.fd-row[data-open="3ia-saclay"]');
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.focusId).toBe(null);
    expect(s.keptOpen).toBe(0);
    expect(await caption(page)).toBe('in view · 0 match the filters');
  });

  test('§9.2 an off-map card kept open by the focus override', async ({ page }) => {
    // SPEC-DEVIATION (§9.3): `state.offMapMatch` is tallied over `vis`, which
    // includes the focused entity the filters exclude, so the Off-the-map badge
    // reads 1 while every row in the list below it is dimmed as not matching —
    // the badge and the list stop agreeing by inspection, which is the reason
    // §9.3 gives for making the badge live in the first place. The caption also
    // names the same entity twice, once as "1 off the map" and once as "plus
    // the open card". Invariant 12's arithmetic still holds, so this is a
    // wording/labelling deviation rather than a broken sum. Asserted as it
    // currently behaves.
    await open(page, { hash: '#e=iso-9241-210&lay=project' });
    const c = await corpus(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(c.totals.project);
    expect(s.keptOpen).toBe(1);
    expect(s.offMapMatch).toBe(1);
    expect(s.inView + s.offScreen + s.offMapMatch).toBe(s.matchCount + s.keptOpen);
    expect(await caption(page)).toBe(
      `${(await derive(page)).countries} countries · in view · ${c.totals.project} match the filters (1 off the map, plus the open card)`);
    const pc = await panelCounts(page);
    expect(pc.nogeo).toBe(1);
    expect(pc.nogeoTitle).toBe(`1 of ${c.nogeo} matches the current filters`);
    expect(pc.nogeoDimmed).toBe(c.nogeo);           // ...including the one the badge counts
  });

  test('§9.2 the debounced recount lands on the same figures as a synchronous refresh', async ({ page }) => {
    // updateInView() runs from refresh() and, at 90 ms, from applyView(). The
    // two paths have to agree, or panning would leave a different set of counts
    // behind than a filter change would.
    await open(page);
    await zoomBy(page, 2.7);
    const debounced = await snapshot(page);
    await page.evaluate(() => refresh());
    const direct = await snapshot(page);
    expect(direct.inView).toBe(debounced.inView);
    expect(direct.offScreen).toBe(debounced.offScreen);
    expect(direct.offMapMatch).toBe(debounced.offMapMatch);
    expect(direct.matchCount).toBe(debounced.matchCount);
    // Agreeing with each other is not enough — both paths could be wrong
    // together — so one of them is also pinned to the derived figures.
    const d = await derive(page);
    expect(direct.inView).toBe(d.inView);
    expect(direct.offScreen).toBe(d.offScreen);
  });
});
