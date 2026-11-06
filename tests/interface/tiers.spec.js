// §6 the tier axis — core and periphery.
//
// Every card belongs to one tier of the admission grid: the core does human–AI
// collaboration itself, the periphery (`tier: ecosystem` in the data) gravitates
// around it. A card with no tier is core, which is how the data repository
// defines the field. The map makes the split readable twice over: a facet in
// the sidebar, which is a filter axis like the layers, and a strength on the
// map, where a periphery marker is drawn muted (§4.2).
//
// The facet is held to the rules every other axis already obeys, so these tests
// mirror filters.spec.js: one predicate (the tier axis ANDs with the other
// three, and `skip` leaves exactly it out), and §6.1's facet-count rule (its own
// toggle never moves its own figures, every other filter does, and it moves
// every other count in turn). The expectations come from `__tiers`, a second
// implementation of §6 built from `window.HAI_DATA`, never from the page's own
// `items`, `matchesFilters()` or `TIER_TOTALS`.
//
// Nothing about how many cards sit in each tier is written down: the figures
// move with every regeneration (§3.2), and this suite has to hold on the payload
// before the October 2026 re-tiering and after it. What is pinned instead is the
// arithmetic around them — a partition, a strict narrowing — and the guards that
// keep it from passing vacuously. Entities are chosen by the property that makes
// them the right subject ("a placed periphery card"), not by id.
import { test, expect } from '@playwright/test';
import {
  MAP_PATH, openMap, snapshot, tiles, layerRows, caption, setLayers, setPeriod,
  applyPreset, settleCounts, fitAll, zoomBy, expectCountersReconcile, periodAlone
} from './_map.js';

// ---------------------------------------------------------------------------
// The oracle: §6's four axes and §10's period rule, re-derived from the
// payload, with the tier rule stated once — no tier means core. Injected as
// source text because a page.evaluate() callback cannot close over this file's
// scope. (No backticks inside: it is a template literal.)
// ---------------------------------------------------------------------------
const ORACLE_SRC = `window.__tiers = (function () {
  const D = window.HAI_DATA;
  const KINDS = ['project','team','cluster','commons','framework'];
  const SRC = { project:'PROJECTS', team:'TEAMS', cluster:'CLUSTERS', commons:'COMMONS', framework:'FRAMEWORKS' };
  const ALL = ['energy','aviation','rail','transport','telecom','utility','health','manufacturing','maritime','nuclear','defense',
               'hf','xai','multi','compute','cluster','simulation'];
  const TIERS = ['core','ecosystem'];
  const yr = v => { const m = /^(\\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
  const list = [], byId = {};
  KINDS.forEach(kind => (D[SRC[kind]] || []).forEach(d => {
    const tl = d.timeline || {};
    const y0 = yr(tl.start), y1 = yr(tl.end), dated = (y0 != null || y1 != null);
    const it = { id: d.id, kind, raw: d.tier, tier: d.tier ? d.tier : 'core',
                 doms: (d.domains && d.domains.length) ? d.domains : [d.domain],
                 geo: d.lat != null && d.lon != null, y0, y1, dated, vague: (!dated || !!d.dateHost) };
    list.push(it); byId[it.id] = it;
  }));
  const ys = list.reduce((a, i) => a.concat([i.y0, i.y1]), []).filter(y => y != null);
  const YMIN = Math.max(1945, Math.min.apply(null, ys));
  const starts = list.map(i => i.y0).filter(y => y != null);
  const YMAX = Math.max(+String(D.AS_OF).slice(0, 4), Math.max.apply(null, starts));
  const PRESENT_FROM = 2020;

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
  function pass(c) {
    c = c || {};
    const layers = c.layers || KINDS, tiers = c.tiers || TIERS, domains = c.domains || ALL;
    const cfg = { a: c.a == null ? YMIN : c.a, b: c.b == null ? YMAX : c.b, undated: c.undated !== false };
    return list.filter(it => {
      if (c.skip !== 'layer'  && layers.indexOf(it.kind) < 0) return false;
      if (c.skip !== 'tier'   && tiers.indexOf(it.tier) < 0) return false;
      if (c.skip !== 'domain' && !it.doms.some(d => domains.indexOf(d) >= 0)) return false;
      if (c.skip !== 'period' && pstate(it, cfg) === 'out') return false;
      return true;
    }).map(it => it.id);
  }
  const byTier = ids => { const n = { core: 0, ecosystem: 0 }; ids.forEach(id => n[byId[id].tier]++); return n; };
  const byKind = ids => { const n = { project: 0, team: 0, cluster: 0, commons: 0, framework: 0 };
    ids.forEach(id => n[byId[id].kind]++); return n; };
  const vagueOf = ids => ids.filter(id => byId[id].vague).length;
  const histYearsOf = ids => {
    const s = new Set();
    ids.forEach(id => { const it = byId[id]; if (!it.dated) return;
      const a = Math.max(YMIN, it.y0 == null ? YMIN : it.y0);
      const b = Math.min(YMAX, it.y1 == null ? YMAX : it.y1);
      for (let y = a; y <= b; y++) s.add(y); });
    return [...s].sort((x, y) => x - y);
  };
  const mapSetOf = pins => { const s = new Set();
    pins.forEach(id => { if (byId[id]) s.add(id); });
    pins.forEach(id => (nb.get(id) || new Set()).forEach(n => s.add(n)));
    return [...s]; };
  return { KINDS, TIERS, ALL, YMIN, YMAX, items: list, size: list.length, itemOf: id => byId[id],
           neighboursOf: id => [...(nb.get(id) || new Set())],
           pass, byTier, byKind, vagueOf, histYearsOf, mapSetOf };
})();`;

async function open(page, opts) {
  await openMap(page, opts);
  await page.evaluate(ORACLE_SRC);
  return page;
}

/** Load the page again from scratch: a `goto()` that changes only the fragment
 *  is a same-document navigation, and boot reads the hash once. */
async function reopen(page, opts) {
  await page.goto('about:blank');
  return open(page, opts);
}

const sorted = (a) => [...a].sort();
const oracle = (page, fn, arg) => page.evaluate(fn, arg);

// --- reading the page under test --------------------------------------------
/** The tier rows, as rendered. */
const tierRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.layer-row[data-tier]')].map((b) => {
    const cnt = b.querySelector('.cnt');
    return {
      tier: b.dataset.tier,
      count: Number(cnt.textContent),
      title: cnt.title,
      aria: cnt.getAttribute('aria-label'),
      on: b.getAttribute('aria-pressed') === 'true',
      label: b.querySelector('.lbl').textContent,
      glyph: Number(getComputedStyle(b.querySelector('.glyph')).opacity),
    };
  }));
const tierCounts = async (page) =>
  Object.fromEntries((await tierRows(page)).map((r) => [r.tier, r.count]));
const layerCounts = async (page) =>
  Object.fromEntries((await layerRows(page)).map((r) => [r.kind, r.count]));

const passIds = (page, skip = null) =>
  page.evaluate((s) => items.filter((it) => matchesFilters(it, s === null ? undefined : s))
    .map((it) => it.id).sort(), skip);
const visible = (page) => page.evaluate(() => {
  const { vis, matched } = visibleSet();
  return { vis: [...vis].sort(), matched: [...matched].sort() };
});
const undatedCount = (page) =>
  page.evaluate(() => Number(document.getElementById('tf-undated-n').textContent));
const histYears = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#tf-hist rect')].map((r) => Number(r.dataset.y)));

/** A marker's computed strength, and whether it is drawn at all. */
const markerOf = (page, id) => page.evaluate((x) => {
  const el = document.querySelector(`.mk[data-id="${x}"]`);
  if (!el) return null;
  return { hidden: el.style.display === 'none', opacity: Number(getComputedStyle(el).opacity),
           periph: el.classList.contains('periph'), dim: el.classList.contains('dim') };
}, id);

// --- driving the controls -----------------------------------------------------
const toggleTier = (page, k) => page.click(`.layer-row[data-tier="${k}"]`);
async function setTiers(page, wanted) {
  for (const r of await tierRows(page)) if (r.on !== wanted.includes(r.tier)) await toggleTier(page, r.tier);
}
async function setDomains(page, wanted) {
  const all = await page.evaluate(() => window.__tiers.ALL);
  for (const d of all) {
    const cb = page.locator(`#domain-groups input[data-dom="${d}"]`);
    if (wanted.includes(d)) await cb.check(); else await cb.uncheck();
  }
}
const focus = (page, id) => page.evaluate((x) => openEntity(x, { fly: false }), id);

// --- fixtures, by property --------------------------------------------------
/** The corpus split by tier, straight off the payload. Guarded on both sides:
 *  every assertion about a narrowing needs each tier to hold some cards and not
 *  all of them. */
async function corpusByTier(page) {
  const n = await page.evaluate(() => window.__tiers.byTier(window.__tiers.items.map((i) => i.id)));
  expect(n.core, 'the payload has core cards').toBeGreaterThan(0);
  expect(n.ecosystem, 'the payload has periphery cards').toBeGreaterThan(0);
  return n;
}
/** A placed card of the given tier, the first in payload order. */
const placedOf = (page, tier) => page.evaluate((t) =>
  (window.__tiers.items.find((i) => i.geo && i.tier === t) || {}).id, tier);

// The muted strength §4.2 gives the periphery, per colour scheme, and the
// strength of a dimmed marker (§6), which must stay below it.
const PERIPH = { light: 0.42, dark: 0.55 };
const DIM = 0.13;

// =============================================================================
test.describe('§6 the tier axis', () => {
  test('§6 every card has one of the two tiers, and a card with no tier is core', async ({ page }) => {
    await open(page);
    const want = await page.evaluate(() =>
      Object.fromEntries(window.__tiers.items.map((i) => [i.id, i.tier])));
    const got = await page.evaluate(() => Object.fromEntries(items.map((it) => [it.id, it.tier])));
    expect(got).toEqual(want);
    // The two values are the whole vocabulary: an oracle that let a third one
    // through would make the comparison above say nothing about the rule.
    expect(sorted(new Set(Object.values(want)))).toEqual(['core', 'ecosystem']);
    await corpusByTier(page);
  });

  test('§6 a card the data gives no tier is counted, drawn and labelled as core', async ({ page }) => {
    // Built rather than found, so the rule stays under test whatever the payload
    // carries: the first placed periphery card has its tier removed between
    // hai-data.js and the page, the way bareDesc() reshapes a description.
    await page.addInitScript(() => {
      let real;
      Object.defineProperty(window, 'HAI_DATA', {
        configurable: true,
        get() { return real; },
        set(v) {
          real = v;
          const hit = ['PROJECTS', 'CLUSTERS', 'COMMONS', 'TEAMS', 'FRAMEWORKS'].flatMap((k) => v[k])
            .find((e) => e.tier === 'ecosystem' && e.lat != null && e.lon != null);
          if (hit) { window.__untiered = hit.id; delete hit.tier; }
        },
      });
    });
    await open(page);
    const id = await page.evaluate(() => window.__untiered);
    expect(typeof id).toBe('string');
    expect(await page.evaluate((x) => byId[x].tier, id)).toBe('core');
    expect(await markerOf(page, id)).toMatchObject({ periph: false, opacity: 1 });
    // The core row counts it: the oracle reads the same reshaped payload.
    expect(await tierCounts(page)).toEqual(await corpusByTier(page));
    // Switching the periphery off leaves it on the map…
    await toggleTier(page, 'ecosystem');
    expect((await visible(page)).matched).toContain(id);
    // …and its card carries no tier tag, because the data does not carry one.
    await focus(page, id);
    const tags = await page.locator('.fd-card .dt-tag').allTextContents();
    expect(tags).not.toContain('Core');
    expect(tags).not.toContain('Periphery');
  });

  test('§6 switching the periphery off leaves exactly the core', async ({ page }) => {
    await open(page);
    const n = await corpusByTier(page);
    await toggleTier(page, 'ecosystem');
    const want = sorted(await page.evaluate(() => window.__tiers.pass({ tiers: ['core'] })));
    expect(want).toHaveLength(n.core);
    expect(await passIds(page)).toEqual(want);
    expect((await snapshot(page)).matchCount).toBe(n.core);
    // Every placed periphery marker has left the map, every core one is still on it.
    const markers = await page.evaluate(() => [...document.querySelectorAll('#g-markers .mk')]
      .map((el) => ({ tier: byId[el.dataset.id].tier, shown: el.style.display !== 'none' })));
    expect(markers.filter((m) => m.tier === 'ecosystem' && m.shown)).toEqual([]);
    expect(markers.filter((m) => m.tier === 'core' && !m.shown)).toEqual([]);
  });

  test('§6 switching the core off leaves exactly the periphery', async ({ page }) => {
    await open(page);
    const n = await corpusByTier(page);
    await toggleTier(page, 'core');
    const want = sorted(await page.evaluate(() => window.__tiers.pass({ tiers: ['ecosystem'] })));
    expect(want).toHaveLength(n.ecosystem);
    expect(await passIds(page)).toEqual(want);
  });

  test('§6 matchesFilters() is the AND of layer, tier, domain and period', async ({ page }) => {
    await open(page);
    await periodAlone(page);
    const cfg = { layers: ['project', 'team'], tiers: ['core'], domains: ['energy', 'aviation', 'hf'], a: 2015, b: 2024 };
    await setLayers(page, cfg.layers);
    await setTiers(page, cfg.tiers);
    await setDomains(page, cfg.domains);
    await setPeriod(page, cfg.a, cfg.b);
    const want = sorted(await page.evaluate((c) => window.__tiers.pass(c), cfg));
    // A real narrowing on the tier axis itself, not only on the other three.
    const withPeriphery = await page.evaluate((c) =>
      window.__tiers.pass({ ...c, tiers: ['core', 'ecosystem'] }).length, cfg);
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(withPeriphery);
    expect(await passIds(page)).toEqual(want);
  });

  test('§6.1 skip:"tier" leaves the tier axis out and keeps the other three', async ({ page }) => {
    await open(page);
    const cfg = { layers: ['team', 'cluster'], tiers: [], domains: ['energy', 'cluster'] };
    await setLayers(page, cfg.layers);
    await setTiers(page, cfg.tiers);
    await setDomains(page, cfg.domains);
    expect(await passIds(page)).toEqual([]);            // both tiers off: nothing matches
    const want = sorted(await page.evaluate((c) => window.__tiers.pass({ ...c, skip: 'tier' }), cfg));
    expect(want.length).toBeGreaterThan(0);
    expect(await passIds(page, 'tier')).toEqual(want);
    // and the other skips still apply the tier axis: with both tiers off, leaving
    // the layer or the domain out cannot bring anything back
    expect(await passIds(page, 'layer')).toEqual([]);
    expect(await passIds(page, 'domain')).toEqual([]);
  });

  test('§6 both tiers off is a zero-result state whose tier rows still read the corpus', async ({ page }) => {
    await open(page);
    const n = await corpusByTier(page);
    await setTiers(page, []);
    await fitAll(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.inView).toBe(0);
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0, 0]);
    expect(await caption(page)).toBe('in view · 0 match the filters');
    // The tier rows skip their own axis, so they still say what each switch
    // would bring back; the layer rows do not, so they fall to zero with it.
    expect(await tierCounts(page)).toEqual(n);
    expect(await layerCounts(page)).toEqual({ project: 0, team: 0, cluster: 0, commons: 0, framework: 0 });
    await expectCountersReconcile(page, 'both tiers off');
  });
});

// =============================================================================
test.describe('§6.1 the tier rows are facet counts', () => {
  test('§6.1 at the default view the tier rows partition the corpus, with nothing to reconcile', async ({ page }) => {
    await open(page);
    const n = await corpusByTier(page);
    const rows = await tierRows(page);
    expect(rows.map((r) => [r.tier, r.count, r.on])).toEqual([['core', n.core, true], ['ecosystem', n.ecosystem, true]]);
    expect(n.core + n.ecosystem).toBe((await snapshot(page)).matchCount);
    // inv13: a figure that has not narrowed carries no corpus total to hover.
    expect(rows.map((r) => r.title)).toEqual(['', '']);
  });

  test('§6.1 a tier\'s own toggle never moves its own figure, nor its sibling\'s', async ({ page }) => {
    await open(page);
    const before = await tierCounts(page);
    for (const k of ['core', 'ecosystem']) {
      await toggleTier(page, k);
      expect(await tierCounts(page), `${k} off`).toEqual(before);
      await toggleTier(page, k);
      expect(await tierCounts(page), `${k} back on`).toEqual(before);
    }
    await setTiers(page, []);
    expect(await tierCounts(page), 'both off').toEqual(before);
  });

  test('§6.1 a layer, a domain and a period change each move the tier figures', async ({ page }) => {
    await open(page);
    await periodAlone(page);
    const n = await corpusByTier(page);
    const check = async (why, c) => {
      const want = await page.evaluate((x) => window.__tiers.byTier(window.__tiers.pass({ ...x, skip: 'tier' })), c);
      expect(await tierCounts(page), why).toEqual(want);
      return want;
    };
    await setLayers(page, ['team']);
    const teams = await check('teams only', { layers: ['team'] });
    // Reached a second way — a flat scan of the payload, no axis machinery.
    expect(teams.core + teams.ecosystem).toBe(await page.evaluate(() =>
      window.__tiers.items.filter((i) => i.kind === 'team').length));
    expect(teams.core).toBeLessThan(n.core);
    expect(teams.ecosystem).toBeLessThan(n.ecosystem);

    await setLayers(page, ['project', 'team', 'cluster', 'commons', 'framework']);
    await setDomains(page, ['energy']);
    const energy = await check('energy only', { domains: ['energy'] });
    expect(energy.core).toBeLessThan(n.core);
    expect(energy.ecosystem).toBeLessThan(n.ecosystem);

    await setDomains(page, await page.evaluate(() => window.__tiers.ALL));
    await setPeriod(page, 2000, 2010);
    const decade = await check('2000–2010', { a: 2000, b: 2010 });
    expect(decade.core + decade.ecosystem).toBeLessThan(n.core + n.ecosystem);
  });

  test('§6.1 the tier axis moves the layer rows, the unknown-start count and the histogram', async ({ page }) => {
    await open(page);
    await toggleTier(page, 'ecosystem');
    const core = { tiers: ['core'] };
    const wantLayers = await page.evaluate((c) => window.__tiers.byKind(window.__tiers.pass({ ...c, skip: 'layer' })), core);
    expect(await layerCounts(page)).toEqual(wantLayers);
    // At least one layer row really narrowed, or the comparison could not tell
    // a row that ignores the tier axis from one that applies it.
    const corpus = await page.evaluate(() => window.__tiers.byKind(window.__tiers.items.map((i) => i.id)));
    expect(Object.keys(corpus).filter((k) => wantLayers[k] < corpus[k]).length).toBeGreaterThan(0);

    const periodScope = await page.evaluate((c) => window.__tiers.pass({ ...c, skip: 'period' }), core);
    expect(await undatedCount(page)).toBe(await page.evaluate((x) => window.__tiers.vagueOf(x), periodScope));
    expect(await histYears(page)).toEqual(await page.evaluate((x) => window.__tiers.histYearsOf(x), periodScope));

    // Periphery only: the unknown-start figure is the periphery's own share.
    await toggleTier(page, 'ecosystem');
    await toggleTier(page, 'core');
    const periphScope = await page.evaluate(() => window.__tiers.pass({ tiers: ['ecosystem'], skip: 'period' }));
    expect(await undatedCount(page)).toBe(await page.evaluate((x) => window.__tiers.vagueOf(x), periphScope));
  });

  test('§6.1 / inv13 a narrowed tier figure keeps the corpus total one hover away, in both languages', async ({ page }) => {
    await open(page);
    const n = await corpusByTier(page);
    await setLayers(page, ['team']);
    const want = await page.evaluate(() => window.__tiers.byTier(window.__tiers.pass({ layers: ['team'], skip: 'tier' })));
    const en = (k) => `${want[k]} of ${n[k]} under the current filters`;
    const fr = (k) => `${want[k]} sur ${n[k]} avec les filtres actuels`;
    let rows = await tierRows(page);
    expect(rows.map((r) => r.title)).toEqual([en('core'), en('ecosystem')]);
    expect(rows.map((r) => r.aria)).toEqual([en('core'), en('ecosystem')]);
    await page.click('.lang-switch [data-lang="fr"]');
    rows = await tierRows(page);
    expect(rows.map((r) => r.title)).toEqual([fr('core'), fr('ecosystem')]);
    expect(rows.map((r) => r.count)).toEqual([want.core, want.ecosystem]);
  });

  test('inv12 the counters reconcile with the periphery off, at the fit and zoomed in', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await toggleTier(page, 'ecosystem');
    await fitAll(page);
    await expectCountersReconcile(page, 'periphery off, at the fit');
    await zoomBy(page, 3);
    const s = await snapshot(page);
    expect(s.offScreen).toBeGreaterThan(0);              // the zoom really cut something off
    await expectCountersReconcile(page, 'periphery off, zoomed in');
  });
});

// =============================================================================
test.describe('§6 the tier axis with the rest of the page', () => {
  test('inv6 a periphery card stays open when the periphery is switched off', async ({ page }) => {
    await open(page);
    const id = await placedOf(page, 'ecosystem');
    expect(typeof id).toBe('string');
    await focus(page, id);
    await toggleTier(page, 'ecosystem');
    const v = await visible(page);
    expect(v.vis).toContain(id);
    expect(v.matched).not.toContain(id);
    expect(await markerOf(page, id)).toMatchObject({ hidden: false, dim: false });
    expect((await snapshot(page)).keptOpen).toBe(1);
  });

  test('§6 in My map the tier rows describe the pin set and the facet is inert', async ({ page }) => {
    // A pin whose neighbourhood spans both tiers, so the rows have two figures to
    // get right; chosen by that property.
    await open(page);
    const pin = await page.evaluate(() => window.__tiers.items.find((i) => {
      const set = window.__tiers.mapSetOf([i.id]);
      const n = window.__tiers.byTier(set);
      return n.core > 0 && n.ecosystem > 0;
    }).id);
    await reopen(page, { storage: { 'hai-map-v2-pins': JSON.stringify([pin]) } });
    await page.click('#mymap-pill');
    const set = await page.evaluate((p) => window.__tiers.mapSetOf([p]), pin);
    const want = await page.evaluate((x) => window.__tiers.byTier(x), set);
    expect(want.core + want.ecosystem).toBe(set.length);
    const rows = await tierRows(page);
    expect(rows.map((r) => r.count)).toEqual([want.core, want.ecosystem]);
    expect(rows.map((r) => r.title)).toEqual([`${want.core} on your map`, `${want.ecosystem} on your map`]);
    const css = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('f-tiers'));
      return { pointerEvents: cs.pointerEvents, opacity: Number(cs.opacity) };
    });
    expect(css.pointerEvents).toBe('none');
    expect(css.opacity).toBeLessThan(1);
  });

  test('§6 a starting view and Reset both put the two tiers back on', async ({ page }) => {
    await open(page);
    const corpus = await page.evaluate(() => window.__tiers.size);
    await toggleTier(page, 'ecosystem');
    await applyPreset(page, 'overview');
    expect(await page.evaluate(() => ({ ...state.tiers }))).toEqual({ core: true, ecosystem: true });
    expect((await tierRows(page)).map((r) => r.on)).toEqual([true, true]);
    expect((await snapshot(page)).matchCount).toBe(corpus);

    await toggleTier(page, 'core');
    await page.click('#reset-btn');
    expect(await page.evaluate(() => ({ ...state.tiers }))).toEqual({ core: true, ecosystem: true });
    expect((await tierRows(page)).map((r) => r.on)).toEqual([true, true]);
    expect((await snapshot(page)).matchCount).toBe(corpus);
  });

  test('§14 a tier toggle is pressed state, operable from the keyboard, and keeps its focus', async ({ page }) => {
    await open(page);
    const row = page.locator('.layer-row[data-tier="ecosystem"]');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => state.tiers.ecosystem)).toBe(false);
    expect(await page.evaluate(() => document.activeElement.dataset.tier)).toBe('ecosystem');
    await page.keyboard.press(' ');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => state.tiers.ecosystem)).toBe(true);
  });
});

// =============================================================================
test.describe('§4.2 the periphery is drawn muted', () => {
  test('§4.2 every placed periphery card, and only those, has a muted marker', async ({ page }) => {
    await open(page);
    const want = sorted(await page.evaluate(() =>
      window.__tiers.items.filter((i) => i.geo && i.tier === 'ecosystem').map((i) => i.id)));
    expect(want.length).toBeGreaterThan(0);
    const got = await page.evaluate(() => [...document.querySelectorAll('#g-markers .mk')].map((el) => ({
      id: el.dataset.id, periph: el.classList.contains('periph'), opacity: Number(getComputedStyle(el).opacity),
    })));
    expect(sorted(got.filter((m) => m.periph).map((m) => m.id))).toEqual(want);
    // Nothing is open, so nothing is dimmed: every marker is at one of two strengths.
    expect([...new Set(got.filter((m) => m.periph).map((m) => m.opacity))]).toEqual([PERIPH.light]);
    expect([...new Set(got.filter((m) => !m.periph).map((m) => m.opacity))]).toEqual([1]);
  });

  test('§4.2 dark mode draws the periphery stronger, still muted, still above a dimmed marker', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page);
    const core = await placedOf(page, 'core');
    const periph = await placedOf(page, 'ecosystem');
    expect((await markerOf(page, periph)).opacity).toBe(PERIPH.dark);
    expect((await markerOf(page, core)).opacity).toBe(1);
    expect(DIM).toBeLessThan(PERIPH.light);
    expect(PERIPH.light).toBeLessThan(PERIPH.dark);
    // The tier rows are the key to it: each glyph at its tier's strength.
    expect((await tierRows(page)).map((r) => r.glyph)).toEqual([1, PERIPH.dark]);
    await page.emulateMedia({ colorScheme: 'light' });
    expect((await markerOf(page, periph)).opacity).toBe(PERIPH.light);
    expect((await tierRows(page)).map((r) => r.glyph)).toEqual([1, PERIPH.light]);
  });

  test('§4.2 / inv2 the tier never reaches the glyph: same layer and domains, same markup', async ({ page }) => {
    // Strength is carried by the marker's class alone. A core and a periphery card
    // that agree on layer and domains must draw byte-identical shapes.
    await open(page);
    const pair = await page.evaluate(() => {
      const seen = {};
      for (const el of document.querySelectorAll('#g-markers .mk')) {
        const it = byId[el.dataset.id];
        const key = it.kind + '|' + it.domains.join(',');
        (seen[key] = seen[key] || {})[it.tier] = el;
        const g = seen[key];
        if (g.core && g.ecosystem) {
          const inner = (x) => { const c = x.cloneNode(true); c.querySelectorAll('text.lbl').forEach((n) => n.remove()); return c.innerHTML; };
          return { key, core: inner(g.core), periph: inner(g.ecosystem),
                   classes: [g.core.getAttribute('class'), g.ecosystem.getAttribute('class')] };
        }
      }
      return null;
    });
    expect(pair, 'some layer and domain set holds both tiers').not.toBeNull();
    expect(pair.periph).toBe(pair.core);
    expect(pair.classes).toEqual(['mk', 'mk periph']);
  });

  test('§4.2 within a layer the periphery is drawn under the core', async ({ page }) => {
    // Later siblings paint on top, so document order is the stacking order.
    await open(page);
    const order = await page.evaluate(() => [...document.querySelectorAll('#g-markers .mk')]
      .map((el) => [byId[el.dataset.id].kind, byId[el.dataset.id].tier]));
    const layersWithBoth = new Set();
    for (const kind of new Set(order.map(([k]) => k))) {
      const tiers = order.filter(([k]) => k === kind).map(([, t]) => t);
      const firstCore = tiers.indexOf('core'), lastPeriph = tiers.lastIndexOf('ecosystem');
      if (firstCore >= 0 && lastPeriph >= 0) {
        layersWithBoth.add(kind);
        expect(lastPeriph, `${kind}: every periphery marker before the first core one`).toBeLessThan(firstCore);
      }
    }
    expect(layersWithBoth.size, 'some layer holds both tiers').toBeGreaterThan(0);
  });

  test('§4.2 the open card and the marker being pointed at come back to full strength; a dimmed one stays dimmed', async ({ page }) => {
    await open(page);
    // A core card whose card lists a placed periphery neighbour: the neighbour
    // stays muted beside the open card, and pointing at its row lifts it.
    const fx = await page.evaluate(() => {
      for (const it of items) {
        if (it.tier !== 'core' || !it.geo) continue;
        const ids = relSections(it).flatMap((s) => s.ids);
        const nb = ids.find((x) => byId[x].tier === 'ecosystem' && byId[x].geo);
        if (nb) {
          const near = new Set([it.id, ...nOf(it.id)]);
          const far = items.find((o) => o.tier === 'ecosystem' && o.geo && !near.has(o.id));
          return { id: it.id, nb, far: far && far.id };
        }
      }
      return null;
    });
    expect(fx, 'some core card lists a placed periphery neighbour').not.toBeNull();
    await focus(page, fx.id);
    expect((await markerOf(page, fx.nb)).opacity).toBe(PERIPH.light);
    expect(await markerOf(page, fx.far)).toMatchObject({ dim: true, opacity: DIM });
    await page.hover(`.fd-card .rel-row[data-open="${fx.nb}"]`);
    await expect.poll(async () => (await markerOf(page, fx.nb)).opacity).toBe(1);
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await markerOf(page, fx.nb)).opacity).toBe(PERIPH.light);
    // The open card itself, when it is a periphery card.
    await focus(page, fx.nb);
    expect(await markerOf(page, fx.nb)).toMatchObject({ periph: true, opacity: 1 });
  });

  test('§4.2 a periphery marker under the pointer comes back to full strength', async ({ page }) => {
    await open(page);
    const at = await page.evaluate(() => {
      const stage = document.getElementById('stage').getBoundingClientRect();
      for (const el of document.querySelectorAll('#g-markers .mk.periph')) {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < stage.left + 4 || x > stage.right - 4 || y < stage.top + 60 || y > stage.bottom - 4) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest && hit.closest('.mk') === el) return { id: el.dataset.id, x, y };
      }
      return null;
    });
    expect(at, 'some periphery marker is reachable by pointer').not.toBeNull();
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await markerOf(page, at.id)).opacity).toBe(1);
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await markerOf(page, at.id)).opacity).toBe(PERIPH.light);
  });
});

// =============================================================================
test.describe('§8 / §12 the tier in words', () => {
  test('§8 the card\'s tier tag uses the facet\'s word, in both languages', async ({ page }) => {
    await open(page);
    const ids = await page.evaluate(() => ({
      periph: window.__tiers.items.find((i) => i.raw === 'ecosystem').id,
      core: window.__tiers.items.find((i) => i.raw === 'core').id,
    }));
    const lastTag = () => page.locator('.fd-card .dt-tag').last().textContent();
    await focus(page, ids.periph);
    expect(await lastTag()).toBe('Periphery');
    await focus(page, ids.core);
    expect(await lastTag()).toBe('Core');
    await page.click('.lang-switch [data-lang="fr"]');
    expect(await lastTag()).toBe('Cœur');
    await focus(page, ids.periph);
    expect(await lastTag()).toBe('Périphérie');
  });

  test('§12 the facet\'s heading, rows, note and legend line follow the language', async ({ page }) => {
    await open(page, { lang: 'fr' });
    const read = () => page.evaluate(() => ({
      head: document.querySelector('#f-tiers .sb-h').textContent,
      rows: [...document.querySelectorAll('.layer-row[data-tier] .lbl')].map((l) => l.textContent),
      note: document.querySelector('#f-tiers .note').textContent,
      legend: document.querySelector('#legend [data-i18n="legendTier"]').textContent,
    }));
    const fr = await read();
    expect(fr.head).toBe('Périmètre');
    expect(fr.rows).toEqual(['Cœur', 'Périphérie']);
    expect(fr.note).toMatch(/^Cœur : .* Périphérie : .* estompés\.$/);
    expect(fr.legend).toBe('Marqueur estompé = périphérie.');
    await page.click('.lang-switch [data-lang="en"]');
    const en = await read();
    expect(en.head).toBe('Scope');
    expect(en.rows).toEqual(['Core', 'Periphery']);
    expect(en.note).toMatch(/^Core: .* Periphery: .* faded\.$/);
    expect(en.legend).toBe('Faded marker = periphery.');
  });

  test('§12 a language switch keeps the tier state it re-renders', async ({ page }) => {
    await open(page);
    await toggleTier(page, 'ecosystem');
    const before = await snapshot(page);
    await page.click('.lang-switch [data-lang="fr"]');
    expect(await page.evaluate(() => ({ ...state.tiers }))).toEqual({ core: true, ecosystem: false });
    expect((await tierRows(page)).map((r) => r.on)).toEqual([true, false]);
    expect((await snapshot(page)).matchCount).toBe(before.matchCount);
  });
});

// =============================================================================
test.describe('§13 the tiers in the shared link', () => {
  async function copiedLink(page) {
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, get: () => ({ writeText: (v) => { window.__copied = v; return Promise.resolve(); } }),
      });
    });
    await page.click('#share-btn');
    await page.waitForFunction(() => window.__copied !== null);
    return page.evaluate(() => window.__copied);
  }
  const fragmentOf = (url) => new URL(url).hash.replace(/^#/, '');

  test('§13 tier= carries the tiers left on, and only when one is off', async ({ page }) => {
    await open(page);
    expect(fragmentOf(await copiedLink(page))).toBe('');
    await toggleTier(page, 'ecosystem');
    expect(fragmentOf(await copiedLink(page))).toBe('tier=core');
    await toggleTier(page, 'ecosystem');
    await toggleTier(page, 'core');
    expect(fragmentOf(await copiedLink(page))).toBe('tier=ecosystem');
  });

  test('§13 tier= sits after lay= in the documented order', async ({ page }) => {
    await open(page);
    await setLayers(page, ['project', 'team']);
    await toggleTier(page, 'ecosystem');
    await page.click('#links-row');
    expect(fragmentOf(await copiedLink(page))).toBe('lay=project,team&tier=core&links=1');
  });

  test('§13 a round trip through the link restores the tiers and what they select', async ({ page }) => {
    await open(page);
    await toggleTier(page, 'ecosystem');
    await setLayers(page, ['team', 'framework']);
    const read = () => page.evaluate(() => ({ tiers: { ...state.tiers }, layers: { ...state.layers },
      matched: [...visibleSet().matched].sort() }));
    const before = await read();
    const u = new URL(await copiedLink(page));
    await reopen(page, { lang: u.searchParams.get('lang'), hash: u.hash });
    expect(await read()).toEqual(before);
    expect((await tierRows(page)).map((r) => r.on)).toEqual([true, false]);
  });

  test('§13 a stale or empty tier= degrades to both tiers rather than an empty map', async ({ page }) => {
    const both = { core: true, ecosystem: true };
    for (const [hash, want] of [['#tier=satellite', both], ['#tier=', both],
      ['#tier=core,satellite', { core: true, ecosystem: false }], ['#tier=ecosystem', { core: false, ecosystem: true }]]) {
      await reopen(page, { hash });
      expect(await page.evaluate(() => ({ ...state.tiers })), hash).toEqual(want);
      expect((await tierRows(page)).map((r) => r.on), hash).toEqual([want.core, want.ecosystem]);
    }
  });

  test('§13 the tiers live in the link alone, like the other filters — nothing in localStorage', async ({ page }) => {
    // A shared link is the whole view (§11): a tier choice kept on the reader's
    // device would leak into every link they open that does not mention tiers.
    await open(page);
    const keys = () => page.evaluate(() => Object.keys(localStorage).sort());
    const before = await keys();
    await toggleTier(page, 'ecosystem');
    expect(await keys()).toEqual(before);
    await page.goto('about:blank');
    await page.goto(`${MAP_PATH}?lang=en`);                 // storage kept: no addInitScript reseed
    await expect(page.locator('#st-note')).not.toBeEmpty();
    expect(await page.evaluate(() => ({ ...state.tiers }))).toEqual({ core: true, ecosystem: true });
  });
});
