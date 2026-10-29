// §6 filtering — the predicate and the facet-count rule.
//
// Everything the reader can narrow goes through one function, `matchesFilters(it, skip)`,
// and one visibility function, `visibleSet()`, built on it. These tests hold that
// arrangement in place from both sides: the predicate itself (does it really AND the
// four axes, does `skip` really leave exactly one axis out) and the counts that read it
// (§6.1: a control's own toggle must not move its own number, every *other* filter must).
//
// The expectations are computed by a second, independent implementation of the rule —
// `__oracle` below, built from `window.HAI_DATA` — rather than read back out of the
// page's own `items`/`matchesFilters`/`TOTALS`. A test that asked the implementation what
// it thought the answer was would pass for any implementation, which is worse than no
// test at all.
//
// Every figure here is derived from that payload rather than written out. §3.2 is explicit:
// the counts "are a snapshot and move with every upstream regeneration; the shape of the
// table is what is normative, not the figures" — and `hai-data-additions.js`, merged into
// `window.HAI_DATA` after `hai-data.js` loads, moved all of them. Where a literal used to
// stand in as a guard against a degenerate oracle, what is pinned now is an arithmetic
// relation around the figure — a partition, a sum, a strict narrowing — reached by a second
// route through the payload that never touches the axis machinery. Entities are chosen by
// the property that makes them the right subject ("the widest pie", "a commons with a
// start year of its own") rather than by id wherever the id is not itself the point.
import { test, expect } from '@playwright/test';
import {
  MAP_PATH, openMap, snapshot, tiles, layerRows, caption, toggleLayer, setLayers,
  setPeriod, periodLabel, applyPreset, settleCounts, fitAll, expectCountersReconcile,
} from './_map.js';

// ---------------------------------------------------------------------------
// The oracle: §6's four axes and §10's period rule, re-derived from the payload.
// Injected as source text because a page.evaluate() callback cannot close over
// the test file's scope; installed once per page, then called by name.
// ---------------------------------------------------------------------------
const ORACLE_SRC = `window.__oracle = (function () {
  const D = window.HAI_DATA;
  const GROUPS = {
    industrial: ['energy','aviation','rail','transport','telecom','utility','health','manufacturing','maritime','nuclear','defense'],
    research:   ['hf','xai','multi'],
    infra:      ['compute','cluster','simulation'],
  };
  const ALL = GROUPS.industrial.concat(GROUPS.research, GROUPS.infra);
  const KINDS = ['project','team','cluster','commons','framework'];
  const yr = v => { const m = /^(\\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
  const list = [];
  const byId = {};
  const add = (arr, kind) => arr.forEach(d => {
    const doms = (d.domains && d.domains.length) ? d.domains : [d.domain];
    const tl = d.timeline || {};
    const y0 = yr(tl.start), y1 = yr(tl.end), dated = (y0 != null || y1 != null);
    const it = { id: d.id, kind, doms, y0, y1, dated, vague: (!dated || !!d.dateHost),
                 geo: d.lat != null && d.lon != null, country: d.country };
    list.push(it); byId[it.id] = it;
  });
  add(D.PROJECTS, 'project'); add(D.CLUSTERS, 'cluster'); add(D.COMMONS, 'commons'); add(D.TEAMS, 'team'); add(D.FRAMEWORKS, 'framework');
  const TOTALS = { project: D.PROJECTS.length, team: D.TEAMS.length, cluster: D.CLUSTERS.length, commons: D.COMMONS.length, framework: D.FRAMEWORKS.length };
  const ys = list.reduce((a, i) => a.concat([i.y0, i.y1]), []).filter(y => y != null);
  const YMIN = Math.max(1945, Math.min.apply(null, ys));
  const starts = list.map(i => i.y0).filter(y => y != null);
  const YMAX = Math.max(+String(D.AS_OF).slice(0, 4), Math.max.apply(null, starts));
  const PRESENT_FROM = 2020;

  // Adjacency, from the same two sources the map draws it from: consortium edges
  // and the createdBy / usedBy links on commons and frameworks.
  const nb = new Map();
  const link = (a, b) => { if (!byId[a] || !byId[b]) return;
    if (!nb.has(a)) nb.set(a, new Set()); if (!nb.has(b)) nb.set(b, new Set());
    nb.get(a).add(b); nb.get(b).add(a); };
  D.EDGES.forEach(e => link(e.project || e.cluster, e.team));
  D.COMMONS.concat(D.FRAMEWORKS).forEach(a => {
    (a.createdBy || []).forEach(u => link(u, a.id));
    (a.usedBy || []).forEach(u => link(a.id, u));
  });

  function pstate(it, c) {
    if (!(c.a > YMIN || c.b < YMAX)) return 'in';
    if (it.vague) {
      if (it.y0 != null && c.b < it.y0) return 'out';
      if (c.b >= PRESENT_FROM) return 'in';
      return c.undated ? 'soft' : 'out';
    }
    const s = it.y0 == null ? -Infinity : it.y0;
    const e = it.y1 == null ?  Infinity : it.y1;
    return (s <= c.b && e >= c.a) ? 'in' : 'out';
  }
  function cfg(c) {
    c = c || {};
    return { layers: c.layers || KINDS, domains: c.domains || ALL,
             a: c.a == null ? YMIN : c.a, b: c.b == null ? YMAX : c.b,
             undated: c.undated !== false, skip: c.skip || null };
  }
  function pass(c0) {
    const c = cfg(c0);
    return list.filter(it => {
      if (c.skip !== 'layer'  && c.layers.indexOf(it.kind) < 0) return false;
      if (c.skip !== 'domain' && !it.doms.some(d => c.domains.indexOf(d) >= 0)) return false;
      if (c.skip !== 'period' && pstate(it, c) === 'out') return false;
      return true;
    }).map(it => it.id);
  }
  const countsOf = ids => { const n = { project: 0, team: 0, cluster: 0, commons: 0, framework: 0 };
    ids.forEach(id => n[byId[id].kind]++); return n; };
  const vagueOf = ids => ids.filter(id => byId[id].vague).length;
  const noGeoOf = ids => ids.filter(id => !byId[id].geo).length;
  const histYearsOf = ids => {
    const s = new Set();
    ids.forEach(id => { const it = byId[id]; if (!it.dated) return;
      const a = Math.max(YMIN, it.y0 == null ? YMIN : it.y0);
      const b = Math.min(YMAX, it.y1 == null ? YMAX : it.y1);
      for (let y = a; y <= b; y++) s.add(y); });
    return [...s].sort((x, y) => x - y);
  };
  // One bar per year with the population behind it: the histogram's own arithmetic,
  // so a test can check a bar's height against the count that produced it.
  const histCountsOf = ids => {
    const c = new Map();
    ids.forEach(id => { const it = byId[id]; if (!it.dated) return;
      const a = Math.max(YMIN, it.y0 == null ? YMIN : it.y0);
      const b = Math.min(YMAX, it.y1 == null ? YMAX : it.y1);
      for (let y = a; y <= b; y++) c.set(y, (c.get(y) || 0) + 1); });
    return [...c.entries()].sort((x, y) => x[0] - y[0]).map(([y, n]) => ({ y, n }));
  };
  const noDateOf = ids => ids.filter(id => !byId[id].dated).length;
  const mapSetOf = pins => { const s = new Set();
    pins.forEach(id => { if (byId[id]) s.add(id); });
    pins.forEach(id => (nb.get(id) || new Set()).forEach(n => s.add(n)));
    return [...s]; };
  // items is the flat record of the whole payload — one entry per entity, with the four
  // axis properties plus the two the captions read (geo, country). Tests scan it to pick
  // their own subject by property, and to reach a figure by a route that does not go
  // through pass() or counts() at all. (No backticks in here: this is a template literal.)
  return { ALL, KINDS, GROUPS, TOTALS, YMIN, YMAX, PRESENT_FROM,
           items: list, size: list.length, itemOf: id => byId[id],
           ids: list.map(i => i.id), kindOf: id => byId[id].kind, domsOf: id => byId[id].doms,
           neighboursOf: id => [...(nb.get(id) || new Set())],
           pass, counts: c => countsOf(pass(c)), countsOf, vagueOf, noGeoOf, noDateOf,
           histYearsOf, histCountsOf, mapSetOf };
})();`;

async function installOracle(page) {
  await page.evaluate(ORACLE_SRC);
}

/** Open the map with the oracle installed — the shape every test in this file starts from. */
async function open(page, opts) {
  await openMap(page, opts);
  await installOracle(page);
  return page;
}

/** A first visit, with nothing in storage at all. `openMap` seeds `hai-map-v2-seen`
 *  so the welcome overlay stays out of the way; the welcome panel carries its own copy
 *  of the preset chips (§9.1), and reaching those means arriving cold. */
async function openCold(page, { lang = 'en' } = {}) {
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch { /* private mode — the page must cope */ }
  });
  await page.goto(`${MAP_PATH}?lang=${lang}`);
  await expect(page.locator('#st-note')).not.toBeEmpty();
  await installOracle(page);
  return page;
}

const ls = (page, k) => page.evaluate((x) => localStorage.getItem(x), k);

const sorted = (a) => [...a].sort();

// --- the corpus, derived -----------------------------------------------------
// The four shapes a test used to spell out as a literal. Each reads the oracle's own
// derivation of `window.HAI_DATA`, which is where the additions file has already been
// merged, so a regeneration moves them instead of breaking the suite (§3.2).
const corpusSize = (page) => page.evaluate(() => window.__oracle.size);
const corpusTotals = (page) => page.evaluate(() => window.__oracle.TOTALS);
const bounds = (page) =>
  page.evaluate(() => ({ YMIN: window.__oracle.YMIN, YMAX: window.__oracle.YMAX }));
/** The unknown-start population of the whole corpus — the figure the switch's own row
 *  shows at the default state, and the "of N" its tooltip names (§6.1, inv13). */
const vagueCorpus = (page) =>
  page.evaluate(() => window.__oracle.vagueOf(window.__oracle.pass({})));
/** `state.years` as a clean slate: the whole axis, unknown starts included. What a preset
 *  and Reset must put back (§6), with the two ends derived rather than written out. */
const defaultYears = async (page) => {
  const { YMIN, YMAX } = await bounds(page);
  return { a: YMIN, b: YMAX, undated: true };
};

// --- reading the page under test ------------------------------------------
const passIds = (page, skip = null) =>
  page.evaluate((s) => items.filter((it) => matchesFilters(it, s === null ? undefined : s))
    .map((it) => it.id).sort(), skip);

const scopeIds = (page, skip = null) =>
  page.evaluate((s) => scopeItems(s === null ? undefined : s).map((it) => it.id).sort(), skip);

const visible = (page) => page.evaluate(() => {
  const { vis, dimmed, matched } = visibleSet();
  return { vis: [...vis].sort(), dimmed: [...dimmed].sort(), matched: [...matched].sort() };
});

/** The layer-row figures as {kind: n}, straight off the rendered rows. */
async function layerCounts(page) {
  const rows = await layerRows(page);
  return Object.fromEntries(rows.map((r) => [r.kind, r.count]));
}
const layerTitles = async (page) =>
  Object.fromEntries((await layerRows(page)).map((r) => [r.kind, r.title]));

const undatedCount = (page) =>
  page.evaluate(() => Number(document.getElementById('tf-undated-n').textContent));
const undatedTitle = (page) =>
  page.evaluate(() => document.getElementById('tf-undated-n').title);

/** The period histogram as the reader sees it: one entry per drawn bar. */
const histBars = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#tf-hist rect')].map((r) => ({
    y: Number(r.dataset.y), h: r.getAttribute('height'), on: r.classList.contains('on'),
  })));

/** Marker state for one entity: is it rendered, is it faint, is it the focus. */
const markerOf = (page, id) => page.evaluate((x) => {
  const el = document.querySelector(`.mk[data-id="${x}"]`);
  if (!el) return null;
  return { hidden: el.style.display === 'none', dim: el.classList.contains('dim'),
           focus: el.classList.contains('focus') };
}, id);

// --- driving the controls --------------------------------------------------
/** Set the domain axis through the 17 checkboxes, the way a reader would. */
async function setDomains(page, wanted) {
  const all = await page.evaluate(() => window.__oracle.ALL);
  for (const d of all) {
    const cb = page.locator(`#domain-groups input[data-dom="${d}"]`);
    if (wanted.includes(d)) await cb.check(); else await cb.uncheck();
  }
}
/** The All / None button of one domain group. */
const domainGroup = (page, key, which) =>
  page.click(`#domain-groups .mini-btn[data-ga="${which}"][data-g="${key}"]`);

/** Which starting-view chips read as the current view, in one of the two hosts
 *  `renderPresets()` fills — the sidebar's `#presets` and the welcome panel's `#w-presets`. */
const activePresets = (page, host) => page.evaluate((h) =>
  [...document.querySelectorAll(`${h} [data-preset]`)]
    .filter((b) => b.classList.contains('active')).map((b) => b.dataset.preset), host);

/** The "unknown start" checkbox. Its row only unfolds once a period is engaged (§10),
 *  so a caller that wants it off has to narrow the range first. */
const setUndated = (page, on) =>
  on ? page.locator('#tf-undated').check() : page.locator('#tf-undated').uncheck();

/** Focus without the fly animation: these tests are about what the filters do to the
 *  focused entity, and a 520 ms camera move would put the in-view counters in motion. */
const focus = (page, id) => page.evaluate((x) => openEntity(x, { fly: false }), id);

// A team with a small, mixed neighbourhood — consortium projects and a commons. Small
// enough to assert on member by member, mixed enough that a single layer toggle can hide
// the neighbours while leaving the entity itself. The one id in this file that is kept
// deliberately: it is the subject of the inv6 and My map blocks, not a stand-in for a
// property, and every figure about it below is derived from the payload.
const SBB = 'sbb';

// Entities of each layer that carry the given domain and have no coordinates —
// read straight out of the payload, so the expected split is derived from the
// data rather than from the tally the page just computed.
const placelessByDomain = (page, dom) => page.evaluate((d) => {
  const n = { project: 0, team: 0, cluster: 0, commons: 0, framework: 0 };
  const LAYER = { PROJECTS: 'project', TEAMS: 'team', CLUSTERS: 'cluster', COMMONS: 'commons', FRAMEWORKS: 'framework' };
  Object.entries(LAYER).forEach(([key, kind]) => window.HAI_DATA[key].forEach((e) => {
    const doms = (e.domains && e.domains.length) ? e.domains : [e.domain];
    if (doms.includes(d) && (e.lat == null || e.lon == null)) n[kind]++;
  }));
  return n;
}, dom);

test.describe('§6 the predicate', () => {
  test('§6 with every control at its default every entity passes — no domain code is unreachable', async ({ page }) => {
    // If an entity carried only a domain that has no checkbox, it could never be shown
    // and never be counted; the default state is where that would surface.
    await open(page);
    const all = await page.evaluate(() => window.__oracle.ids.slice().sort());
    expect(await passIds(page)).toEqual(all);
    // The oracle's seventeen codes are a literal in this file, so asserting their count
    // against itself would check nothing: compare them to the axis the page has in force.
    const axis = sorted(await page.evaluate(() => [...state.domains]));
    expect(axis).toEqual(sorted(await page.evaluate(() => window.__oracle.ALL)));
    expect(axis.length).toBe(17);
    expect((await snapshot(page)).matchCount).toBe(all.length);
  });

  test('§6 matchesFilters() with no skip is the AND of layer, domain and period', async ({ page }) => {
    await open(page);
    const cfg = { layers: ['project', 'commons'], domains: ['energy', 'xai'], a: 2015, b: 2020 };
    await setLayers(page, cfg.layers);
    await setDomains(page, cfg.domains);
    await setPeriod(page, cfg.a, cfg.b);
    const want = await page.evaluate((c) => window.__oracle.pass(c).sort(), cfg);
    expect(want.length).toBeGreaterThan(0);           // guard: an empty oracle proves nothing
    expect(want.length).toBeLessThan(await corpusSize(page));   // and a real narrowing
    expect(await passIds(page)).toEqual(want);
  });

  test('§6.1 skip:"layer" leaves the layer axis out and keeps the other two', async ({ page }) => {
    await open(page);
    const cfg = { layers: ['commons'], domains: ['energy', 'aviation'], a: 2018, b: 2024 };
    await setLayers(page, cfg.layers);
    await setDomains(page, cfg.domains);
    await setPeriod(page, cfg.a, cfg.b);
    expect(await passIds(page, 'layer'))
      .toEqual(await page.evaluate((c) => window.__oracle.pass({ ...c, skip: 'layer' }).sort(), cfg));
    // and it is genuinely wider than the unskipped predicate: with the layer
    // axis left out, every layer has an energy or aviation entity in the period
    const kinds = await page.evaluate((ids) => [...new Set(ids.map(window.__oracle.kindOf))].sort(),
      await passIds(page, 'layer'));
    expect(kinds).toEqual(await page.evaluate(() => [...KINDS].sort()));
  });

  test('§6.1 skip:"domain" leaves the domain axis out and keeps the other two', async ({ page }) => {
    await open(page);
    const cfg = { layers: ['team', 'framework'], domains: ['nuclear'], a: 2010, b: 2022 };
    await setLayers(page, cfg.layers);
    await setDomains(page, cfg.domains);
    await setPeriod(page, cfg.a, cfg.b);
    expect(await passIds(page, 'domain'))
      .toEqual(await page.evaluate((c) => window.__oracle.pass({ ...c, skip: 'domain' }).sort(), cfg));
  });

  test('§6.1 skip:"period" leaves the period axis out and keeps the other two', async ({ page }) => {
    await open(page);
    const { YMIN } = await bounds(page);
    const cfg = { layers: ['project'], domains: ['health'], a: YMIN, b: YMIN + 1 };
    await setLayers(page, cfg.layers);
    await setDomains(page, cfg.domains);
    await setPeriod(page, cfg.a, cfg.b);
    // Two years at the floor exclude every project, so the skip is doing visible work here:
    // the unskipped predicate is empty and the skipped one is not, both derived.
    const want = await page.evaluate((c) => window.__oracle.pass({ ...c, skip: 'period' }).sort(), cfg);
    expect(want.length).toBeGreaterThan(0);
    expect(await page.evaluate((c) => window.__oracle.pass(c).length, cfg)).toBe(0);
    expect(await passIds(page)).toEqual([]);
    expect(await passIds(page, 'period')).toEqual(want);
  });

  test('§6.1 only the three axis names are honoured — any other skip filters on all three', async ({ page }) => {
    // `skip` is compared literally; a typo'd axis name must not quietly widen a count.
    await open(page);
    await setLayers(page, ['commons']);
    await setDomains(page, ['energy']);
    await setPeriod(page, 2018, 2024);
    const strict = await passIds(page);
    expect(await passIds(page, 'layers')).toEqual(strict);   // note the plural
    expect(await passIds(page, 'Domain')).toEqual(strict);
    expect(await passIds(page, '')).toEqual(strict);
  });

  test('§6 the domain axis is an OR: a multi-domain entity survives until its last domain is unchecked', async ({ page }) => {
    // The legend promises this in so many words — "it stays visible while any of them is
    // ticked" — and it is the whole reason a pie-slice marker is honest.
    //
    // The subject is "the widest pie on the map", not a named entity: the test needs an
    // entity with several domains, and a regeneration that trimmed the one it used to name
    // would leave the loop below running on a single-domain dot, where it proves nothing.
    await open(page);
    const { id, doms } = await page.evaluate(() => {
      const widest = window.__oracle.items.reduce((a, b) => (b.doms.length > a.doms.length ? b : a));
      return { id: widest.id, doms: widest.doms };
    });
    expect(doms.length).toBeGreaterThan(1);           // guard: one slice is not a pie
    for (let i = 0; i < doms.length; i++) {
      await page.locator(`#domain-groups input[data-dom="${doms[i]}"]`).uncheck();
      const left = doms.length - i - 1;
      const vis = (await visible(page)).vis;
      expect(vis.includes(id), `${left} of its domains still ticked`).toBe(left > 0);
    }
  });

  test('§6 unchecking a domain the entity does not carry leaves it visible', async ({ page }) => {
    await open(page);
    // An entity carrying exactly one domain code, chosen by that property: what matters is
    // that exactly one of the seventeen checkboxes can hide it, not which entity it is.
    const { id, dom, other } = await page.evaluate(() => {
      const one = window.__oracle.items.find((i) => i.doms.length === 1);
      return { id: one.id, dom: one.doms[0],
               other: window.__oracle.ALL.find((d) => d !== one.doms[0]) };
    });
    expect(typeof id).toBe('string');                  // guard: no single-domain entity, no test
    await setDomains(page, (await page.evaluate(() => window.__oracle.ALL)).filter((d) => d !== other));
    expect((await visible(page)).vis).toContain(id);
    await page.locator(`#domain-groups input[data-dom="${dom}"]`).uncheck();
    expect((await visible(page)).vis).not.toContain(id);
  });

  test('§6 the axes combine with AND: a ticked domain cannot save an entity whose layer is off', async ({ page }) => {
    await open(page);
    // A commons — picked by its layer, and filtered on a domain it carries itself, so the
    // only thing left to take it off the map is the Commons toggle.
    const { id, dom } = await page.evaluate(() => {
      const c = window.__oracle.items.find((i) => i.kind === 'commons');
      return { id: c.id, dom: c.doms[0] };
    });
    await setDomains(page, [dom]);
    expect((await visible(page)).vis).toContain(id);
    await toggleLayer(page, 'commons');
    expect((await visible(page)).vis).not.toContain(id);
    expect(await passIds(page, 'layer')).toContain(id); // the layer axis, and nothing else, excluded it
  });

  test('§6 the axes combine with AND: an on layer cannot save an entity the period excludes', async ({ page }) => {
    await open(page);
    // A commons whose start year is its own and later than the floor, so a two-year range
    // at the floor is guaranteed to exclude it however the corpus is regenerated.
    const { YMIN } = await bounds(page);
    const id = await page.evaluate((y) => (window.__oracle.items
      .find((i) => i.kind === 'commons' && !i.vague && i.y0 != null && i.y0 > y + 1) || {}).id, YMIN);
    expect(typeof id).toBe('string');
    await setLayers(page, ['commons']);
    await setPeriod(page, YMIN, YMIN + 1);
    expect((await visible(page)).vis).not.toContain(id);
    expect(await passIds(page, 'period')).toContain(id);
  });

  test('§6 visibleSet() returns the three sets the counters read, and `matched` is the predicate', async ({ page }) => {
    await open(page);
    await setLayers(page, ['team']);
    await setDomains(page, ['nuclear', 'compute']);
    const v = await visible(page);
    // No card is open, so nothing is re-added: vis and matched coincide, and both are
    // exactly what matchesFilters() selects.
    expect(v.matched).toEqual(await passIds(page));
    expect(v.vis).toEqual(v.matched);
    expect(v.dimmed).toEqual([]);
    expect((await snapshot(page)).matchCount).toBe(v.matched.length);
  });
});

test.describe('§6.1 scopeItems and the facet counts', () => {
  test('§6.1 scopeItems() with no skip is the predicate, and its size is state.matchCount', async ({ page }) => {
    await open(page);
    await setLayers(page, ['project', 'team']);
    await setDomains(page, ['aviation']);
    const ids = await scopeIds(page);
    expect(ids).toEqual(await passIds(page));
    expect((await snapshot(page)).matchCount).toBe(ids.length);
  });

  test('§6.1 scopeItems("layer") still answers with every layer switched off', async ({ page }) => {
    // The zero-result boundary is exactly where a layer row has to keep saying how many
    // switching it back on would bring in.
    await open(page);
    await setLayers(page, []);
    expect(await passIds(page)).toEqual([]);
    expect(await scopeIds(page, 'layer'))
      .toEqual(await page.evaluate(() => window.__oracle.pass({ skip: 'layer' }).sort()));
  });

  test('§6.1 scopeItems("domain") still answers with every domain unchecked', async ({ page }) => {
    await open(page);
    await setDomains(page, []);
    expect(await passIds(page)).toEqual([]);
    expect(await scopeIds(page, 'domain'))
      .toEqual(await page.evaluate(() => window.__oracle.pass({ skip: 'domain' }).sort()));
  });

  test('§6.1 the layer figures sum to matchCount while every layer is on', async ({ page }) => {
    await open(page);
    const n = await layerCounts(page);
    const s = await snapshot(page);
    expect(Object.values(n).reduce((a, b) => a + b, 0)).toBe(s.matchCount);
    expect(n).toEqual(await page.evaluate(() => window.__oracle.TOTALS));
  });

  test('§6.1 with one layer off the rows exceed matchCount by exactly that layer\'s figure', async ({ page }) => {
    // The arithmetic is the proof that the rows and the caption read one predicate: the
    // rows skip the layer axis, so the whole of the difference is the layer switched off.
    await open(page);
    for (const k of ['project', 'team', 'cluster', 'commons', 'framework']) {
      await setLayers(page, ['project', 'team', 'cluster', 'commons', 'framework'].filter((x) => x !== k));
      const n = await layerCounts(page);
      const s = await snapshot(page);
      expect(Object.values(n).reduce((a, b) => a + b, 0) - s.matchCount,
        `${k} switched off`).toBe(n[k]);
    }
  });

  test('§6.1 a layer\'s own toggle never moves its own figure', async ({ page }) => {
    await open(page);
    const before = await layerCounts(page);
    for (const k of ['project', 'team', 'cluster', 'commons', 'framework']) {
      await toggleLayer(page, k);                        // off
      expect((await layerCounts(page))[k], `${k} off`).toBe(before[k]);
      await toggleLayer(page, k);                        // and back on
      expect((await layerCounts(page))[k], `${k} back on`).toBe(before[k]);
    }
  });

  test('§6.1 no layer toggle moves any layer figure — the whole axis is skipped', async ({ page }) => {
    // A figure that collapsed to zero the moment you switched the layer off would be
    // useless for deciding whether to switch it back on; the same holds for its siblings,
    // because `skip` drops the axis rather than the one switch.
    await open(page);
    const corpus = await page.evaluate(() => window.__oracle.TOTALS);
    for (const on of [[], ['project'], ['team', 'commons'], ['framework']]) {
      await setLayers(page, on);
      expect(await layerCounts(page), `layers on: ${on.join(',') || 'none'}`).toEqual(corpus);
    }
  });

  test('§6.1 a domain change moves every layer figure', async ({ page }) => {
    await open(page);
    await setDomains(page, ['energy']);
    const want = await page.evaluate(() => window.__oracle.counts({ domains: ['energy'], skip: 'layer' }));
    // The figures are a snapshot (§3.2), so what is held against them is the arithmetic:
    // with the period wide open the rows must partition exactly the entities carrying
    // `energy`, counted here by a flat scan of the payload that never enters pass().
    const flat = await page.evaluate(() =>
      window.__oracle.items.filter((i) => i.doms.indexOf('energy') >= 0).length);
    expect(Object.values(want).reduce((a, b) => a + b, 0)).toBe(flat);
    expect(await layerCounts(page)).toEqual(want);
    // every one of them actually moved
    const corpus = await corpusTotals(page);
    for (const k of Object.keys(corpus)) expect(want[k], k).toBeLessThan(corpus[k]);
  });

  test('§6.1 a period change moves every layer figure', async ({ page }) => {
    await open(page);
    const { YMIN } = await bounds(page);
    await setPeriod(page, YMIN, YMIN);
    const want = await page.evaluate((y) => window.__oracle.counts({ a: y, b: y, skip: 'layer' }), YMIN);
    expect(await layerCounts(page)).toEqual(want);
    // The figures move with the corpus; the shape of this state does not. Nothing but a
    // team reaches back to the floor year — the dated projects, commons and frameworks all
    // start later, and every entity whose start is unknown is a team (§10.1) — so three
    // rows are exactly 0 while the fourth is neither 0 nor the whole layer.
    const nonTeams = await page.evaluate((y) => window.__oracle.items
      .filter((i) => i.kind !== 'team' && (i.vague || (i.y0 != null && i.y0 <= y))).length, YMIN);
    expect(nonTeams).toBe(0);
    expect([want.project, want.commons, want.framework]).toEqual([0, 0, 0]);
    expect(want.team).toBeGreaterThan(0);
    expect(want.team).toBeLessThan((await corpusTotals(page)).team);
  });

  test('§6.1 the "unknown start" switch is part of the period axis, so it moves the layer figures too', async ({ page }) => {
    // The teams the floor year holds are mostly *possible* rather than established;
    // dropping the unknown starts is a period change like any other and the rows must
    // follow it. The two figures are derived, the narrowing between them is the assertion.
    await open(page);
    const { YMIN } = await bounds(page);
    await setPeriod(page, YMIN, YMIN);
    const loose = await page.evaluate((y) => window.__oracle.counts({ a: y, b: y, skip: 'layer' }), YMIN);
    await setUndated(page, false);
    const want = await page.evaluate((y) =>
      window.__oracle.counts({ a: y, b: y, undated: false, skip: 'layer' }), YMIN);
    expect(await layerCounts(page)).toEqual(want);
    expect(want.team).toBeLessThan(loose.team);         // the switch really narrowed the row
    expect(want.team).toBeGreaterThan(0);
    expect([want.project, want.commons, want.framework]).toEqual([0, 0, 0]);
  });

  test('§6.1 / inv13 a narrowed layer figure keeps the corpus total one hover away', async ({ page }) => {
    await open(page);
    // At the corpus there is nothing to reconcile, so no tooltip at all —
    // except on the layers that hold placeless entities, whose title carries the
    // split at every filter state because it describes the data, not a narrowing.
    const bare = await layerRows(page);
    for (const r of bare) {
      if (r.offMap) expect(r.title).toContain('with no coordinates');
      else expect(r.title).toBe('');
    }
    await setDomains(page, ['energy']);
    // Rebuilt from the derived narrowed and corpus figures, and still compared as the exact
    // string a reader hovers: "N of TOTAL under the current filters", one row at a time.
    const corpus = await corpusTotals(page);
    const want = await page.evaluate(() => window.__oracle.counts({ domains: ['energy'], skip: 'layer' }));
    const gone = await placelessByDomain(page, 'energy');
    expect(await layerTitles(page)).toEqual(Object.fromEntries(Object.keys(corpus).map((k) => [k,
      gone[k]
        ? `${want[k] - gone[k]} on the map · ${gone[k]} with no coordinates · ${want[k]} ${want[k] === 1 ? 'matches' : 'match'} the filters`
        : `${want[k]} of ${corpus[k]} under the current filters`])));
    // and all four rows genuinely have something to reconcile, or the strings are noise
    for (const k of Object.keys(corpus)) expect(want[k], k).toBeLessThan(corpus[k]);
  });
});

test.describe('§6.1 the unknown-start count', () => {
  test('§6.1 the unknown-start figure skips the period axis — neither the range nor its own switch moves it', async ({ page }) => {
    await open(page);
    const corpus = await vagueCorpus(page);
    // The figure moves with the corpus; that it is a real subset of it does not.
    expect(corpus).toBeGreaterThan(0);
    expect(corpus).toBeLessThan(await corpusSize(page));
    expect(await undatedCount(page)).toBe(corpus);
    const { YMIN, YMAX } = await bounds(page);
    for (const [a, b] of [[YMIN, YMIN], [2000, 2010], [YMAX, YMAX], [YMIN, YMAX]]) {
      await setPeriod(page, a, b);
      expect(await undatedCount(page), `${a}–${b}`).toBe(corpus);
    }
    await setPeriod(page, 2000, 2010);
    await setUndated(page, false);
    expect(await undatedCount(page), 'its own switch off').toBe(corpus);
    await setUndated(page, true);
    expect(await undatedCount(page)).toBe(corpus);
  });

  test('§6.1 filtered to Commons the unknown-start figure is 0, not the corpus figure', async ({ page }) => {
    // Named in the spec because it shipped wrong: every entity with an unknown start is a
    // team, so a reader looking at Commons was shown the whole corpus figure for a set the
    // switch could not touch. The "every one of them is a team" half is derived too — it is
    // the reason 0 is the right answer here rather than a coincidence.
    await open(page);
    const corpus = await vagueCorpus(page);
    expect(await page.evaluate(() =>
      window.__oracle.items.filter((i) => i.vague && i.kind !== 'team').length)).toBe(0);
    await setLayers(page, ['commons']);
    expect(await undatedCount(page)).toBe(0);
    expect(await page.evaluate(() =>
      window.__oracle.vagueOf(window.__oracle.pass({ layers: ['commons'], skip: 'period' })))).toBe(0);
    // and it comes back when the team layer does
    await setLayers(page, ['commons', 'team']);
    expect(await undatedCount(page)).toBe(corpus);
  });

  test('§6.1 the unknown-start figure follows the domain axis', async ({ page }) => {
    // Also the §17 rule in action: a domain checkbox calls refresh() and never renderTime(),
    // so a figure updated only from its own render function would sit here unchanged.
    await open(page);
    await setDomains(page, ['energy']);
    const want = await page.evaluate(() =>
      window.__oracle.vagueOf(window.__oracle.pass({ domains: ['energy'], skip: 'period' })));
    // Reached a second way — a flat scan of the payload for `energy` entities with an
    // unknown start, no axis machinery involved — so the figure is derived twice over and
    // written out nowhere.
    const flat = await page.evaluate(() =>
      window.__oracle.items.filter((i) => i.vague && i.doms.indexOf('energy') >= 0).length);
    expect(want).toBe(flat);
    expect(want).toBeGreaterThan(0);                   // guard: a zero would prove nothing
    expect(want).toBeLessThan(await vagueCorpus(page));
    expect(await undatedCount(page)).toBe(want);
    await setDomains(page, []);
    expect(await undatedCount(page)).toBe(0);
  });

  test('§6.1 / inv13 the unknown-start figure names the corpus only once it has narrowed', async ({ page }) => {
    await open(page);
    const corpus = await vagueCorpus(page);
    expect(await undatedTitle(page)).toBe('');
    await setLayers(page, ['commons']);
    expect(await undatedTitle(page)).toBe(`0 of ${corpus} under the current filters`);
  });
});

test.describe('§6.1 the period histogram', () => {
  test('§6.1 the histogram skips the period axis: moving the range repaints, it does not redraw', async ({ page }) => {
    await open(page);
    const { YMIN, YMAX } = await bounds(page);
    const before = await histBars(page);
    // One bar per year of the axis §10 describes — the floor to the data's own freshness
    // date — because at the corpus every year of that span carries something.
    expect(before.map((b) => b.y))
      .toEqual(Array.from({ length: YMAX - YMIN + 1 }, (_, i) => YMIN + i));
    expect(before.every((b) => b.on)).toBe(true);
    await setPeriod(page, 2000, 2010);
    const after = await histBars(page);
    expect(after.map((b) => [b.y, b.h])).toEqual(before.map((b) => [b.y, b.h]));
    expect(after.filter((b) => b.on).map((b) => b.y))
      .toEqual(Array.from({ length: 11 }, (_, i) => 2000 + i));
    // the switch on the same axis leaves the bars alone as well
    await setUndated(page, false);
    expect((await histBars(page)).map((b) => [b.y, b.h])).toEqual(before.map((b) => [b.y, b.h]));
  });

  test('§6.1 the histogram follows the layer and domain axes', async ({ page }) => {
    // The curve is the period control's own backdrop: drawn over the whole corpus while the
    // reader has narrowed to the handful of AI-network teams, it would size the handles
    // against a population they are not selecting from.
    await open(page);
    const { YMIN, YMAX } = await bounds(page);
    await setDomains(page, ['cluster']);
    const want = await page.evaluate(() =>
      window.__oracle.histYearsOf(window.__oracle.pass({ domains: ['cluster'], skip: 'period' })));
    // Derived, and held to the two things that make it the *narrowed* curve: it starts at
    // the earliest `cluster` entity's own start year, and it is shorter than the axis.
    const first = await page.evaluate(() => Math.min(...window.__oracle.items
      .filter((i) => i.doms.indexOf('cluster') >= 0 && i.y0 != null).map((i) => i.y0)));
    expect(want[0]).toBe(first);
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(YMAX - YMIN + 1);
    expect((await histBars(page)).map((b) => b.y)).toEqual(want);
    // `cluster` is an infrastructure code and §3.1 keeps those off the project layer, so
    // narrowing to Projects empties the curve outright. Derived, because an emptiness that
    // held for the wrong reason would be the same green.
    expect(await page.evaluate(() => window.__oracle.items
      .filter((i) => i.kind === 'project' && i.doms.indexOf('cluster') >= 0).length)).toBe(0);
    await setLayers(page, ['project']);
    expect(await histBars(page)).toEqual([]);
  });

  test('§6.1 with every layer off the histogram draws nothing', async ({ page }) => {
    await open(page);
    await setLayers(page, []);
    expect(await histBars(page)).toEqual([]);
  });

  test('§6.1 the histogram is normalised to the filtered peak, so a narrow scope still has a full-height bar', async ({ page }) => {
    // Normalising to a fixed corpus peak would draw the two-dozen-entity Commons layer as a
    // flat line one pixel high; the shape is what is being read, not the height against
    // other states. 19 is the band's own height in user units, a constant of the control.
    await open(page);
    await setLayers(page, ['commons']);
    const bars = await histBars(page);
    expect(bars.length).toBeGreaterThan(0);
    expect(Math.max(...bars.map((b) => Number(b.h)))).toBeCloseTo(19, 5);
  });

  test('§6.1 a year carrying a single entity still draws a bar the reader can see', async ({ page }) => {
    // The other end of the same normalisation. Against the whole Commons layer as the peak,
    // a year with one entity is well under a unit of the 19-unit band — a sliver at this
    // size. The floor is what keeps the sparse years of a narrow scope legible, so the
    // 1.1 is pinned here: without it the curve still has the right shape and the wrong
    // readability, which is the kind of regression a shape-only comparison cannot see.
    await open(page);
    await setLayers(page, ['commons']);
    const want = await page.evaluate(() =>
      window.__oracle.histCountsOf(window.__oracle.pass({ layers: ['commons'], skip: 'period' })));
    const bars = await histBars(page);
    expect(bars.map((b) => b.y)).toEqual(want.map((w) => w.y));
    const h = Object.fromEntries(bars.map((b) => [b.y, Number(b.h)]));
    const peak = Math.max(...want.map((w) => w.n));
    // The peak is the whole dated layer, derived rather than written out: no commons has a
    // recorded end, so every one of them is still running at the ceiling year and the last
    // bar carries all of them.
    const dated = await page.evaluate(() =>
      window.__oracle.items.filter((i) => i.kind === 'commons' && i.dated).length);
    expect(want[want.length - 1].n).toBe(dated);
    expect(peak).toBe(dated);
    const sparse = want.filter((w) => w.n === 1).map((w) => w.y);
    expect(sparse.length).toBeGreaterThan(0);           // guard: nothing floored, nothing proven
    for (const y of sparse) expect(h[y], `${y} carries one commons`).toBeCloseTo(1.1, 5);
    for (const w of want.filter((x) => x.n === peak)) {
      expect(h[w.y], `${w.y} is the filtered peak`).toBeCloseTo(19, 5);
    }
    // and a year never draws shorter than a year with fewer entities behind it
    const asc = [...want].sort((x, y) => x.n - y.n).map((w) => h[w.y]);
    expect(asc).toEqual([...asc].sort((x, y) => x - y));
  });

  test('§6.1/§10 the histogram counts only the entities whose dates are their own', async ({ page }) => {
    // Invariant 4 from the histogram's side. An entity with no dates at all, read through
    // the same `y0 ?? YMIN / y1 ?? YMAX` clamp the dated ones use, would draw a bar in
    // every year of the axis and drag the curve back to the floor year — a span it never
    // had. Telecom is the clean case: one of its teams has no dates at all, and the dated
    // ones reach back only to the mid-sixties, so the mistake shows as two decades of
    // invented years. Both ends of that are derived; the floor year is the axis's own.
    await open(page);
    const { YMIN } = await bounds(page);
    await setDomains(page, ['telecom']);
    const scope = await page.evaluate(() =>
      window.__oracle.pass({ domains: ['telecom'], skip: 'period' }));
    const noDate = await page.evaluate(() =>
      window.__oracle.items.filter((i) => i.doms.indexOf('telecom') >= 0 && !i.dated).length);
    expect(noDate).toBeGreaterThan(0);               // guard: nothing undated, nothing proven
    expect(await page.evaluate((x) => window.__oracle.noDateOf(x), scope)).toBe(noDate);
    const years = (await histBars(page)).map((b) => b.y);
    expect(years).toEqual(await page.evaluate((x) => window.__oracle.histYearsOf(x), scope));
    // The curve starts at the earliest telecom entity that has a date of its own, which is
    // strictly later than the floor the undated one would have dragged it back to.
    const first = await page.evaluate(() => Math.min(...window.__oracle.items
      .filter((i) => i.doms.indexOf('telecom') >= 0 && i.y0 != null).map((i) => i.y0)));
    expect(years[0]).toBe(first);
    expect(first).toBeGreaterThan(YMIN);
    // It is in the scope the bars are drawn from all the same — the unknown-start figure
    // counts it; only the curve declines to give it a span.
    expect(await undatedCount(page)).toBeGreaterThan(0);
  });
});

test.describe('invariant 6 — a filter change never hides the open card', () => {
  test('inv6 §6 the focused entity survives every layer being switched off', async ({ page }) => {
    await open(page);
    await focus(page, SBB);
    await setLayers(page, []);
    const v = await visible(page);
    expect(v.vis).toEqual([SBB]);
    expect(v.matched).toEqual([]);
    expect(await markerOf(page, SBB)).toEqual({ hidden: false, dim: false, focus: true });
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.keptOpen).toBe(1);
  });

  test('inv6 §6 the caption names the kept-open card rather than leaving an off-by-one', async ({ page }) => {
    await open(page);
    await focus(page, SBB);
    await setLayers(page, []);
    await fitAll(page);
    expect(await caption(page)).toBe('1 country · in view · 0 match the filters (plus the open card)');
    await expectCountersReconcile(page, 'one card kept open against empty filters');
  });

  test('inv6 §6 the focused entity survives its own domains being unchecked, and `matched` still excludes it', async ({ page }) => {
    // "N match the filters" must not be contradicted by the filters themselves, which is
    // why visibleSet() records `matched` before re-adding the focus.
    await open(page);
    await focus(page, SBB);
    await setDomains(page, []);
    const v = await visible(page);
    expect(v.vis).toEqual([SBB]);
    expect(v.matched).not.toContain(SBB);
    expect((await snapshot(page)).focusId).toBe(SBB);
    expect(await markerOf(page, SBB)).toEqual({ hidden: false, dim: false, focus: true });
  });

  test('inv6 §6/§10 the focused entity survives a period that excludes it', async ({ page }) => {
    await open(page);
    // An entity with a start year of its own, later than the floor, and a marker to watch:
    // a two-year range at the floor then excludes it whatever the corpus holds.
    const { YMIN } = await bounds(page);
    const id = await page.evaluate((y) => (window.__oracle.items
      .find((i) => i.geo && !i.vague && i.y0 != null && i.y0 > y + 1) || {}).id, YMIN);
    expect(typeof id).toBe('string');
    await focus(page, id);
    await setPeriod(page, YMIN, YMIN + 1);
    const v = await visible(page);
    expect(v.vis).toContain(id);
    expect(v.matched).not.toContain(id);
    expect(await markerOf(page, id)).toEqual({ hidden: false, dim: false, focus: true });
  });

  test('inv6 §6 the focused entity survives the switch into My map', async ({ page }) => {
    // The three tests above narrow one of the three filter axes, so every one of them
    // lands in the `else` half of visibleSet(). My map is the other half, and the tests
    // that cover it elsewhere deliberately have no card open — which leaves the focus
    // override free to slide inside the `else` without a single failure anywhere, while
    // a reader who opens a card and then clicks My map watches the marker disappear from
    // under it. §6 puts the override after both branches for that reason.
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify([SBB]) } });
    // An entity with a marker, picked for the one property that matters: it is outside the
    // pin's neighbourhood, so it can only be in `vis` as the kept-open card.
    const want = sorted(await page.evaluate((p) => window.__oracle.mapSetOf(p), [SBB]));
    const outside = await page.evaluate((set) => (window.__oracle.items
      .find((i) => i.geo && set.indexOf(i.id) < 0) || {}).id, want);
    expect(want).not.toContain(outside);
    await focus(page, outside);
    await page.click('#mymap-pill');
    await settleCounts(page);

    expect((await snapshot(page)).focusId).toBe(outside);
    const v = await visible(page);
    expect(v.vis).toContain(outside);
    expect(v.matched).toEqual(want);
    expect(v.matched).not.toContain(outside);
    expect(await markerOf(page, outside)).toEqual({ hidden: false, dim: false, focus: true });
    const s = await snapshot(page);
    expect(s.matchCount).toBe(want.length);
    // invariant 12's third term, in the mode where nothing else ever exercises it
    expect(s.keptOpen).toBe(1);
    await expectCountersReconcile(page, 'My map with an outside card open');

    // §9.2 makes the open card its own named term — "(plus the open card)" — precisely so
    // the surplus does not read as an off-by-one. This used to be a SPEC-DEVIATION: `why`
    // was assembled for the filter wording only, so the My map branch dropped the term and
    // the tiles summed to one above a caption that did not say why. Fixed upstream, and
    // asserted here as the exact string, rebuilt from the derived pin set: the My map fit
    // brings the kept-open card into view with the four, so every one of them is counted.
    const countries = await page.evaluate((ids) =>
      new Set(ids.map((id) => window.__oracle.itemOf(id).country)).size, [...want, outside]);
    expect(s.inView).toBe(want.length + 1);
    expect(await caption(page)).toBe(
      `${countries} ${countries === 1 ? 'country' : 'countries'} · in view`
      + ` · ${want.length} on your map (plus the open card)`);
    expect((await tiles(page)).reduce((a, x) => a + x.count, 0)).toBe(want.length + 1);

    // And the entity really was out of scope, rather than having been in it all along:
    // close the card and the only thing holding it on the map goes with it.
    await page.keyboard.press('Escape');
    await settleCounts(page);
    expect((await markerOf(page, outside)).hidden).toBe(true);
    expect((await snapshot(page)).keptOpen).toBe(0);
  });

  test('inv6 §6 closing the card gives the filters the last word again', async ({ page }) => {
    await open(page);
    await focus(page, SBB);
    await setLayers(page, []);
    expect((await snapshot(page)).keptOpen).toBe(1);
    // Escape, not #dt-close: at this width the feed is open, so the card renders there and
    // the floating panel's own close button is hidden (§5). Escape closes the card either way.
    await page.keyboard.press('Escape');
    const v = await visible(page);
    expect(v.vis).toEqual([]);
    const s = await snapshot(page);
    expect(s.keptOpen).toBe(0);
    expect(s.focusId).toBe(null);
    // refresh() stops at `display:none` for a marker that is out: the highlight classes it
    // carried are left behind rather than cleared, which costs nothing while it is not
    // rendered and is recomputed the moment a filter brings it back.
    expect((await markerOf(page, SBB)).hidden).toBe(true);
  });

  test('§6 a marker brought back by a filter is repainted, not restored with its old highlight', async ({ page }) => {
    // The other side of the stale-class note above: a marker that goes out while focused,
    // then comes back once the filters widen, must be drawn as an ordinary marker again.
    await open(page);
    await focus(page, SBB);
    await setLayers(page, []);
    await page.keyboard.press('Escape');
    await setLayers(page, ['team']);
    expect(await markerOf(page, SBB)).toEqual({ hidden: false, dim: false, focus: false });
  });

  test('§6 the focus\'s visible neighbours are un-dimmed, and everything else is dimmed', async ({ page }) => {
    await open(page);
    const nbs = sorted(await page.evaluate((x) => window.__oracle.neighboursOf(x), SBB));
    expect(nbs.length).toBeGreaterThan(0);             // guard: no neighbourhood, no test
    // The two derivations of the same neighbourhood must agree, which is also what makes
    // the My map set below the pin plus exactly these.
    expect(sorted(await page.evaluate((x) => window.__oracle.mapSetOf([x]), SBB)))
      .toEqual(sorted([SBB, ...nbs]));
    await focus(page, SBB);
    const v = await visible(page);
    for (const n of nbs) {
      expect(v.vis, n).toContain(n);
      expect(v.dimmed, n).not.toContain(n);
      expect(await markerOf(page, n), n).toEqual({ hidden: false, dim: false, focus: false });
    }
    // "everything else": an entity with a marker that is neither the focus nor one of its
    // neighbours, chosen by that property rather than named.
    const far = await page.evaluate((x) => {
      const near = new Set([x, ...window.__oracle.neighboursOf(x)]);
      return (window.__oracle.items.find((i) => i.geo && !near.has(i.id)) || {}).id;
    }, SBB);
    expect(await markerOf(page, far)).toEqual({ hidden: false, dim: true, focus: false });
  });

  test('§6 only *visible* neighbours are un-dimmed — one the filters hide stays hidden', async ({ page }) => {
    // The focus override re-adds the card's own entity, not its neighbourhood: a reader
    // who filters to Teams should not get the consortia around it back through the side door.
    await open(page);
    // SBB's neighbours that are not themselves teams, derived: those are exactly the ones
    // the Teams filter has to keep out.
    const nbs = await page.evaluate((x) => window.__oracle.neighboursOf(x)
      .filter((n) => window.__oracle.kindOf(n) !== 'team'), SBB);
    expect(nbs.length).toBeGreaterThan(0);             // guard: nothing to hide, nothing proven
    await focus(page, SBB);
    await setLayers(page, ['team']);
    const v = await visible(page);
    expect(v.vis).toContain(SBB);
    for (const n of nbs) {
      expect(v.vis, n).not.toContain(n);
      expect((await markerOf(page, n)).hidden, n).toBe(true);
    }
    expect((await snapshot(page)).keptOpen).toBe(0);     // the focus matches the team filter
  });
});

test.describe('§6 My map replaces the axes', () => {
  const PIN = SBB;
  const pinned = { storage: { 'hai-map-v2-pins': JSON.stringify([SBB]) } };

  test('§6 with My map on, scopeItems is the pin set whatever the layers and domains say', async ({ page }) => {
    await open(page, pinned);
    await page.click('#mymap-pill');
    const want = sorted(await page.evaluate((p) => window.__oracle.mapSetOf(p), [PIN]));
    expect(want).toContain(PIN);                       // the pin itself, plus its neighbours
    expect(want.length).toBeGreaterThan(1);
    expect(want.length).toBeLessThan(await corpusSize(page));
    for (const skip of [null, 'layer', 'domain', 'period']) {
      expect(await scopeIds(page, skip), `skip=${skip}`).toEqual(want);
    }
    // and the axes are genuinely inert: poking them changes nothing about the scope
    await page.evaluate(() => { state.layers.project = false; state.domains = new Set(['nuclear']); refresh(); });
    expect(await scopeIds(page, 'layer')).toEqual(want);
    expect((await snapshot(page)).matchCount).toBe(want.length);
  });

  test('§6.1 in My map the layer figures describe the pin set, not the corpus', async ({ page }) => {
    await open(page, pinned);
    await page.click('#mymap-pill');
    const ids = await page.evaluate((p) => window.__oracle.mapSetOf(p), [PIN]);
    const want = await page.evaluate((x) => window.__oracle.countsOf(x), ids);
    // The rows partition the pin set exactly — nothing counted twice, nothing dropped —
    // and every one of them is below its corpus total, which is the whole point of the mode.
    expect(Object.values(want).reduce((a, b) => a + b, 0)).toBe(ids.length);
    expect(await layerCounts(page)).toEqual(want);
    const corpus = await corpusTotals(page);
    for (const k of Object.keys(corpus)) expect(want[k], k).toBeLessThan(corpus[k]);
  });

  test('§6.1 in My map the unknown-start figure and the histogram describe the pin set too', async ({ page }) => {
    await open(page, pinned);
    await page.click('#mymap-pill');
    const ids = await page.evaluate((p) => window.__oracle.mapSetOf(p), [PIN]);
    const vague = await page.evaluate((x) => window.__oracle.vagueOf(x), ids);
    const years = await page.evaluate((x) => window.__oracle.histYearsOf(x), ids);
    expect(await undatedCount(page)).toBe(vague);
    expect((await histBars(page)).map((b) => b.y)).toEqual(years);
    // Both figures are guarded as well as compared: an oracle that drifted to zero bars and
    // a zero count would agree with a page that had stopped computing either of them. The
    // pin itself dates from its host, which is where the unknown start comes from.
    expect(vague).toBeGreaterThan(0);
    expect(years.length).toBeGreaterThan(0);
    expect(years.length).toBeLessThan((await bounds(page)).YMAX - (await bounds(page)).YMIN + 1);
  });

  test('§6 a pin whose entity has left the data is ignored rather than counted', async ({ page }) => {
    // The pin set is read back from `localStorage`, where an id outlives a regeneration of
    // the payload. `myMapSet()` guards every id against `byId`, and that guard is the only
    // thing between a stale pin and an `undefined` in the scope: the first facet count to
    // read `it.kind` off it would throw inside refresh() and take every number in the
    // panel down with it, mid-repaint.
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify(['left-in-a-regeneration', SBB]) } });
    expect((await snapshot(page)).pins).toBe(2);        // state keeps what storage held
    await page.click('#mymap-pill');
    const s = await snapshot(page);
    expect(s.myMap).toBe(true);
    // The scope is the live pin's neighbourhood and nothing else: `mapSetOf` is given both
    // ids and guards them the same way the page must, so the stale one contributes nothing.
    const want = sorted(await page.evaluate((p) => window.__oracle.mapSetOf(p),
      ['left-in-a-regeneration', SBB]));
    expect(want).toEqual(sorted(await page.evaluate((p) => window.__oracle.mapSetOf(p), [SBB])));
    expect(await scopeIds(page)).toEqual(want);
    expect(s.matchCount).toBe(want.length);
    // Every facet count still answers, which is where a refresh() that threw would show.
    expect(await layerCounts(page))
      .toEqual(await page.evaluate((x) => window.__oracle.countsOf(x), want));
    expect(await undatedCount(page))
      .toBe(await page.evaluate((x) => window.__oracle.vagueOf(x), want));
    expect((await histBars(page)).map((b) => b.y))
      .toEqual(await page.evaluate((x) => window.__oracle.histYearsOf(x), want));
    expect(await caption(page)).toContain(`${want.length} on your map`);
    // SPEC-DEVIATION: the pill's badge counts the stored ids (2) while the My map list
    // below it drops the one that no longer resolves (1), so the two disagree about the
    // size of the reader's own map. §6.1 would have every figure describe the set the
    // reader is looking at; pinned here as it behaves today.
    expect(await page.evaluate(() => document.getElementById('mymap-badge').textContent)).toBe('2');
    expect(await page.evaluate(() => document.getElementById('pin-count').textContent)).toBe('1');
  });

  test('§6 in My map the layer and domain controls are visibly inert', async ({ page }) => {
    await open(page, pinned);
    await page.click('#mymap-pill');
    expect(await page.evaluate(() => document.body.classList.contains('mymap-on'))).toBe(true);
    for (const sel of ['#f-layers', '#f-domains']) {
      const css = await page.evaluate((s) => {
        const cs = getComputedStyle(document.querySelector(s));
        return { pointerEvents: cs.pointerEvents, opacity: cs.opacity };
      }, sel);
      expect(css.pointerEvents, sel).toBe('none');
      expect(Number(css.opacity), sel).toBeLessThan(1);
    }
    // switching back restores them
    await page.click('#mymap-pill');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('f-layers')).pointerEvents))
      .toBe('auto');
  });

  test('§6 in My map the pins are solid and their neighbours dimmed', async ({ page }) => {
    await open(page, pinned);
    await page.click('#mymap-pill');
    const nbs = sorted(await page.evaluate((x) => window.__oracle.neighboursOf(x), PIN));
    expect(nbs.length).toBeGreaterThan(0);             // guard: nothing to dim, nothing proven
    const v = await visible(page);
    expect(v.vis).toEqual(sorted([PIN, ...nbs]));
    expect(v.dimmed).toEqual(nbs);                      // the pin is solid, everything it reaches is faint
    expect(await markerOf(page, PIN)).toEqual({ hidden: false, dim: false, focus: false });
    // Only the ones with coordinates have a marker to be faint (invariant 3).
    const placed = await page.evaluate((ids) =>
      ids.filter((id) => window.__oracle.itemOf(id).geo), nbs);
    for (const n of placed) expect((await markerOf(page, n)).dim, n).toBe(true);
  });

  test('§6 My map with no pins refuses to engage', async ({ page }) => {
    await open(page);
    expect((await snapshot(page)).pins).toBe(0);
    await page.click('#mymap-pill');
    expect((await snapshot(page)).myMap).toBe(false);
    expect(await page.locator('#toast').textContent())
      .toBe('Pin cards (★) to compose your own cartography — it is kept on this device.');
    // The axes stayed in charge. Against the oracle rather than against the page's own
    // predicate: scopeItems() with no skip *is* that predicate, so comparing the two would
    // hold even if both had stopped filtering.
    expect(await scopeIds(page)).toEqual(await page.evaluate(() => window.__oracle.pass({}).sort()));
  });

  test('§6 the My map axis works even when localStorage throws', async ({ page }) => {
    // Private mode: the pin cannot be persisted, but it must still filter the map in this
    // session — the axis lives in `state`, storage is only its memory.
    await page.addInitScript(() => {
      const boom = () => { throw new Error('private mode'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => ({ getItem: boom, setItem: boom, removeItem: boom, clear: boom }),
      });
    });
    await open(page);
    await page.evaluate((x) => togglePin(x), SBB);
    expect((await snapshot(page)).pins).toBe(1);
    await page.evaluate(() => toggleMyMap());
    const want = sorted(await page.evaluate((x) => window.__oracle.mapSetOf([x]), SBB));
    const s = await snapshot(page);
    expect(s.myMap).toBe(true);
    expect(s.matchCount).toBe(want.length);
    expect(await scopeIds(page, 'layer')).toEqual(want);
  });
});

test.describe('§6 starting views are a clean slate', () => {
  test('§6 a preset sets exactly its domains and resets the other three axes', async ({ page }) => {
    await open(page);
    await applyPreset(page, 'energy');
    const s = await snapshot(page);
    expect(s.domains).toEqual(['energy']);
    expect(s.layers).toEqual({ project: true, team: true, cluster: true, commons: true, framework: true });
    expect(s.years).toEqual(await defaultYears(page));
    expect(s.myMap).toBe(false);
  });

  test('§6 Overview restores all seventeen domains', async ({ page }) => {
    await open(page);
    await setDomains(page, ['nuclear']);
    await applyPreset(page, 'overview');
    expect(sorted((await snapshot(page)).domains))
      .toEqual(sorted(await page.evaluate(() => window.__oracle.ALL)));
    // All seventeen checked is the whole corpus — derived, because the corpus moves (§3.2).
    expect((await snapshot(page)).matchCount).toBe(await corpusSize(page));
  });

  test('§6 a preset is a clean slate, not a modifier on the current state', async ({ page }) => {
    // Arrive dirty on all four axes at once, then click one chip.
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify([SBB]) } });
    await setLayers(page, ['commons']);
    await setDomains(page, ['nuclear', 'compute']);
    await setPeriod(page, 1990, 1995);
    await page.click('#mymap-pill');
    expect((await snapshot(page)).myMap).toBe(true);

    await applyPreset(page, 'human');
    const s = await snapshot(page);
    expect(sorted(s.domains)).toEqual(['hf', 'xai']);
    expect(s.layers).toEqual({ project: true, team: true, cluster: true, commons: true, framework: true });
    expect(s.years).toEqual(await defaultYears(page));
    expect(s.myMap).toBe(false);
    expect(s.matchCount).toBe(await page.evaluate(() => window.__oracle.pass({ domains: ['hf', 'xai'] }).length));
  });

  test('§6 the six named starting views each land on their own domain set', async ({ page }) => {
    // §6 names all six. Their domain lists are pinned here because a preset whose codes
    // drifted out of the checkbox set would silently select nothing.
    await open(page);
    const all = await page.evaluate(() => window.__oracle.ALL);
    const expected = {
      overview: sorted(all),
      energy: ['energy'],
      aviation: ['aviation'],
      health: ['health'],
      human: ['hf', 'xai'],
      sim: ['cluster', 'compute', 'simulation'],
    };
    for (const [id, doms] of Object.entries(expected)) {
      await applyPreset(page, id);
      expect(sorted((await snapshot(page)).domains), id).toEqual(doms);
      for (const d of doms) expect(all, `${id}/${d}`).toContain(d);
      expect((await snapshot(page)).matchCount, id)
        .toBe(await page.evaluate((c) => window.__oracle.pass({ domains: c }).length, doms));
      // the chip a reader just clicked is the only one reading as the current view
      const active = await page.evaluate(() =>
        [...document.querySelectorAll('#presets [data-preset]')]
          .filter((b) => b.classList.contains('active')).map((b) => b.dataset.preset));
      expect(active, id).toEqual([id]);
    }
  });

  test('§6/§9.1 a starting view chosen from the welcome panel applies and dismisses it', async ({ page }) => {
    // `renderPresets()` fills two hosts from one `mk()` helper, called twice: the sidebar's
    // `#presets` and the welcome panel's `#w-presets`. Every other preset test goes through
    // the sidebar copy, so losing the second binding would leave the chips a first-time
    // reader actually sees inert — the click does nothing, the overlay stays up — with the
    // suite still green. This is the cold-arrival path, end to end.
    await openCold(page);
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    expect(await ls(page, 'hai-map-v2-seen')).toBe(null);

    await page.click('#w-presets [data-preset="energy"]');

    // applyPreset() does four things from here, and nothing checks them together.
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);
    expect(await ls(page, 'hai-map-v2-seen')).toBe('1');
    const s = await snapshot(page);
    expect(s.domains).toEqual(['energy']);
    expect(s.layers).toEqual({ project: true, team: true, cluster: true, commons: true, framework: true });
    expect(s.years).toEqual(await defaultYears(page));
    expect(s.myMap).toBe(false);
    const want = await page.evaluate(() => window.__oracle.pass({ domains: ['energy'] }).length);
    expect(want).toBeGreaterThan(0);        // a preset selecting nothing would agree with itself
    expect(s.matchCount).toBe(want);
    // Both hosts read back the view the reader is now in, the welcome copy included —
    // `renderPresetsActive()` walks `[data-preset]` document-wide for that reason.
    expect(await activePresets(page, '#presets')).toEqual(['energy']);
    expect(await activePresets(page, '#w-presets')).toEqual(['energy']);
    // applyPreset() calls closeWelcome() without the `first` flag, so the first-marker
    // hint stays unspent: it belongs to the reader who chose "Explore freely" and is now
    // looking at an unexplained map, not to one who has just picked a starting view.
    expect(await ls(page, 'hai-map-v2-hint-click')).toBe(null);
    expect(await page.locator('#toast').textContent()).toBe('');
  });

  test('§6 no preset reads as active while My map has replaced the axes', async ({ page }) => {
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify([SBB]) } });
    await applyPreset(page, 'overview');
    expect(await page.evaluate(() =>
      document.querySelector('#presets [data-preset="overview"]').classList.contains('active'))).toBe(true);
    await page.click('#mymap-pill');
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('#presets [data-preset]')].some((b) => b.classList.contains('active'))))
      .toBe(false);
  });
});

test.describe('§6 the domain group buttons', () => {
  test('§6 a group\'s None unchecks exactly that group, and All puts it back', async ({ page }) => {
    await open(page);
    const groups = await page.evaluate(() => window.__oracle.GROUPS);
    // The oracle's groups are a literal here, so count the page's own rendered groups:
    // 11 / 3 / 3 asserted against the oracle's own lists would assert nothing.
    expect(await page.evaluate(() => [...document.querySelectorAll('#domain-groups .fgroup')]
      .map((g) => g.querySelectorAll('input[data-dom]').length))).toEqual([11, 3, 3]);
    await domainGroup(page, 'research', 'none');
    expect(sorted((await snapshot(page)).domains))
      .toEqual(sorted(groups.industrial.concat(groups.infra)));
    // the checkboxes agree with state, which is what syncDomainChecks() is for
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('#domain-groups input[data-dom]')]
        .filter((cb) => cb.checked).map((cb) => cb.dataset.dom).sort()))
      .toEqual(sorted(groups.industrial.concat(groups.infra)));
    await domainGroup(page, 'research', 'all');
    expect(sorted((await snapshot(page)).domains)).toEqual(sorted(await page.evaluate(() => window.__oracle.ALL)));
  });

  test('§6 the seventeen checkboxes are the whole domain axis, grouped 11 / 3 / 3', async ({ page }) => {
    await open(page);
    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('#domain-groups .fgroup')].map((g) =>
        [...g.querySelectorAll('input[data-dom]')].map((cb) => cb.dataset.dom)));
    const groups = await page.evaluate(() => window.__oracle.GROUPS);
    expect(rendered).toEqual([groups.industrial, groups.research, groups.infra]);
    expect(rendered.flat().length).toBe(17);
  });
});

test.describe('§6 boundaries', () => {
  test('§6 every layer off is a zero-result state whose layer rows still read the corpus', async ({ page }) => {
    await open(page);
    await setLayers(page, []);
    await fitAll(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.inView).toBe(0);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(0);
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0, 0]);
    expect(await caption(page)).toBe('in view · 0 match the filters');
    expect(await layerCounts(page)).toEqual(await page.evaluate(() => window.__oracle.TOTALS));
    await expectCountersReconcile(page, 'every layer off');
  });

  test('§6 every domain off is a zero-result state, and the layer rows go to zero with it', async ({ page }) => {
    // Unlike the layer case, the domain axis is *not* skipped by a layer row, so here the
    // rows must fall to zero — the other half of §6.1's rule, read off the same control.
    await open(page);
    for (const g of ['industrial', 'research', 'infra']) await domainGroup(page, g, 'none');
    await fitAll(page);
    expect((await snapshot(page)).domains).toEqual([]);
    expect((await snapshot(page)).matchCount).toBe(0);
    expect(await layerCounts(page)).toEqual({ project: 0, team: 0, cluster: 0, commons: 0, framework: 0 });
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0, 0]);
    expect(await caption(page)).toBe('in view · 0 match the filters');
    expect(await undatedCount(page)).toBe(0);
    expect(await histBars(page)).toEqual([]);
    await expectCountersReconcile(page, 'every domain off');
  });

  test('§6/§9.1 exactly one result: the caption agrees with itself in the singular', async ({ page }) => {
    // n=1 verb agreement, in the narrowest non-empty state two axes can reach. The pair of
    // settings is searched for rather than named: `maritime` + Commons was a population of
    // one when this was written and a population of two after the next regeneration, which
    // would have left the singular wording untested with the suite still green. The entity
    // has to be a placed one, or "1 country" and "1 in view" would both be wrong for a
    // reason that has nothing to do with agreement.
    await open(page);
    const one = await page.evaluate(() => {
      for (const kind of window.__oracle.KINDS) for (const dom of window.__oracle.ALL) {
        const hit = window.__oracle.items.filter((i) => i.kind === kind && i.doms.indexOf(dom) >= 0);
        if (hit.length === 1 && hit[0].geo) return { kind, dom, id: hit[0].id };
      }
      return null;
    });
    expect(one).not.toBeNull();                        // guard: no singleton scope, no test
    await setLayers(page, [one.kind]);
    await setDomains(page, [one.dom]);
    await fitAll(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(1);
    expect(await passIds(page)).toEqual([one.id]);
    expect(await caption(page)).toBe('1 country · in view · 1 matches the filters');
    expect((await tiles(page)).find((t) => t.kind === one.kind).title)
      .toBe('1 in view · 1 matches the filters');
    await expectCountersReconcile(page, 'exactly one match');
  });

  test('§6 an entity with no coordinates is filtered like any other — it just has no marker', async ({ page }) => {
    // Invariant 3: the placeless entities keep their card, their search result and their
    // feed row, so they have to keep passing and failing the predicate too.
    await open(page);
    await setLayers(page, ['framework']);
    await setDomains(page, ['hf']);
    await settleCounts(page);
    const s = await snapshot(page);
    const want = await page.evaluate(() =>
      window.__oracle.pass({ layers: ['framework'], domains: ['hf'] }));
    expect(await passIds(page)).toEqual(sorted(want));
    expect(s.offMapMatch).toBe(await page.evaluate((x) => window.__oracle.noGeoOf(x), want));
    expect(s.offMapMatch).toBeGreaterThan(0);          // guard: the case would be vacuous at 0
    // One of them, chosen for having no coordinates rather than by name, plus a domain it
    // does not carry — which is what has to take it out of the set.
    const { id, other } = await page.evaluate((ids) => {
      const it = ids.map((x) => window.__oracle.itemOf(x)).find((i) => !i.geo);
      return { id: it.id, other: window.__oracle.ALL.find((d) => it.doms.indexOf(d) < 0) };
    }, want);
    expect(await page.evaluate((x) => document.querySelector(`.mk[data-id="${x}"]`), id)).toBeNull();
    expect((await visible(page)).vis).toContain(id);
    // and it leaves the set when its domain does
    await setDomains(page, [other]);
    expect((await visible(page)).vis).not.toContain(id);
  });

  test('§6 the period floor and ceiling are inclusive at both ends', async ({ page }) => {
    await open(page);
    const { YMIN, YMAX } = await bounds(page);
    // §10's own rule, re-derived straight off the payload: the axis runs from 1945 — a
    // handful of founders predate it, so the floor is a clamp and not the earliest year —
    // to the data's freshness date `AS_OF`, not to the furthest funded end-date.
    const rule = await page.evaluate(() => {
      const D = window.HAI_DATA;
      const yr = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
      const ys = [], starts = [];
      [].concat(D.PROJECTS, D.CLUSTERS, D.TEAMS, D.COMMONS, D.FRAMEWORKS).forEach((d) => {
        const tl = d.timeline || {}, a = yr(tl.start), b = yr(tl.end);
        if (a != null) { ys.push(a); starts.push(a); }
        if (b != null) ys.push(b);
      });
      return { floor: 1945, earliest: Math.min(...ys),
               ceiling: Math.max(+String(D.AS_OF).slice(0, 4), Math.max(...starts)) };
    });
    expect(rule.earliest).toBeLessThan(rule.floor);    // guard: the clamp is doing work
    expect([YMIN, YMAX]).toEqual([rule.floor, rule.ceiling]);
    for (const [a, b] of [[YMIN, YMIN], [YMAX, YMAX], [YMIN, YMAX]]) {
      await setPeriod(page, a, b);
      expect(await passIds(page), `${a}–${b}`)
        .toEqual(await page.evaluate((c) => window.__oracle.pass(c).sort(), { a, b }));
    }
    // the full span is the unfiltered corpus again
    expect((await snapshot(page)).matchCount).toBe(await corpusSize(page));
  });

  test('§6.1 a collapsed sidebar still has current figures when it comes back', async ({ page }) => {
    // The period control lives in the floating cluster, so a reader can narrow the map with
    // the panel shut. The facet counts are updated from refresh() rather than from their own
    // render function precisely so that reopening the panel shows the map as it is now.
    await open(page);
    // Widened first: at the 1280 px default with the feed open, `.ctl-tr`'s box reaches back
    // over the collapse button and swallows the click (a §5 matter, not a §6 one). The resize
    // has to come before the collapse, since the resize handler re-opens the panel.
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.click('#sb-hide');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display))
      .toBe('none');
    const { YMIN } = await bounds(page);
    const corpus = await vagueCorpus(page);
    const knob = page.locator('#tf-b');
    await knob.focus();
    await knob.press('Home');                           // both handles to the floor year
    expect(await periodLabel(page)).toBe(String(YMIN));
    await page.click('#sb-open');
    expect(await layerCounts(page))
      .toEqual(await page.evaluate((y) => window.__oracle.counts({ a: y, b: y, skip: 'layer' }), YMIN));
    expect(await undatedCount(page)).toBe(corpus);       // still the period's own count, unmoved
  });

  test('§6 Reset puts the axes back where they started and keeps the pins', async ({ page }) => {
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify([SBB]) } });
    await setLayers(page, ['team']);
    await setDomains(page, ['nuclear']);
    await setPeriod(page, 2000, 2001);
    await focus(page, SBB);
    await page.click('#reset-btn');
    const s = await snapshot(page);
    expect(sorted(s.domains)).toEqual(sorted(await page.evaluate(() => window.__oracle.ALL)));
    expect(s.layers).toEqual({ project: true, team: true, cluster: true, commons: true, framework: true });
    expect(s.years).toEqual(await defaultYears(page));
    expect(s.myMap).toBe(false);
    expect(s.focusId).toBe(null);
    expect(s.matchCount).toBe(await corpusSize(page));
    expect(s.pins).toBe(1);                             // Reset clears the filters, not the pins
  });

  test('§6 Reset lives in the domain section, so My map makes it inert with the rest', async ({ page }) => {
    // Worth pinning because Reset's handler does clear My map: if it were ever reachable
    // from this mode it would be a second way out, and the pill would stop being the way.
    await open(page, { storage: { 'hai-map-v2-pins': JSON.stringify([SBB]) } });
    await page.click('#mymap-pill');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('reset-btn')).pointerEvents))
      .toBe('none');
    await page.click('#mymap-pill');                    // its own pill is the way back
    expect((await snapshot(page)).myMap).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('reset-btn')).pointerEvents))
      .toBe('auto');
  });
});
