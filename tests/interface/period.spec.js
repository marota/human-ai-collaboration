// Period filter — §10, §10.1, §10.2, §10.3.
//
// The slider is the one filter in the interface whose semantics are not binary.
// An entity whose own start date could not be established is *possible* over a
// band of years rather than in or out of it, and §10.1 fixes exactly where that
// band opens and closes. So most of what follows is about a tri-state, and the
// expectations are derived twice over: from the raw payload (window.HAI_DATA,
// which the map reads but these tests parse themselves) and from the spec's own
// table, transcribed below. Reading an expectation back out of periodState()
// would make every one of these tests agree with whatever the implementation
// happened to do next.
//
// No figure from the corpus is written out as a literal here. §3.2: "Counts are
// a snapshot and move with every upstream regeneration; the shape of the table
// is what is normative, not the figures." The payload the page actually loaded
// — hai-data.js and whatever hai-data-additions.js merged into it — is the one
// source for how many of anything there are, so a regeneration moves these
// tests' expectations with the data instead of failing them. Years that the
// spec itself fixes (1945, 2020) stay literal, because those are rules.
import { test, expect } from '@playwright/test';
import {
  openMap, snapshot, tiles, setLayers, setPeriod, nudgePeriod,
  periodLabel, applyPreset, expectCountersReconcile, fitAll,
} from './_map.js';

// ---------------------------------------------------------------------------
// local helpers — the shared module deliberately knows nothing about dates
// ---------------------------------------------------------------------------

const FLOOR = 1945;     // §10.3, "The 1945 floor"
const PRESENT = 2020;   // §10.1, PRESENT_FROM — everything on the map exists today
const ALL_KINDS = ['project', 'team', 'cluster', 'commons', 'framework'];

/** The payload, re-read from raw fields rather than from the map's `items`. */
async function payload(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const yr = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
    const rows = [];
    for (const [key, kind] of [['PROJECTS', 'project'], ['CLUSTERS', 'cluster'], ['COMMONS', 'commons'],
                               ['TEAMS', 'team'], ['FRAMEWORKS', 'framework']]) {
      for (const d of D[key]) {
        const tl = d.timeline || {};
        const y0 = yr(tl.start), y1 = yr(tl.end);
        rows.push({
          id: d.id, kind, y0, y1,
          start: tl.start ?? null,
          dated: y0 != null || y1 != null,
          host: !!d.dateHost,              // §10.2, "dateHost: true"
          conf: d.dateConf ?? null,
          domains: (d.domains && d.domains.length) ? d.domains : [d.domain],
          geo: d.lat != null && d.lon != null,
          place: [d.city, d.country].filter(Boolean).join(', '),
        });
      }
    }
    return { rows, asOf: D.AS_OF };
  });
}

/** §10.2 — "vague" is exactly two cases: no start at all, or only the host's year. */
const isVague = (r) => !r.dated || r.host;

/** The axis the data implies, computed from the payload alone (§10). */
function axis({ rows, asOf }) {
  const years = rows.flatMap((r) => [r.y0, r.y1]).filter((y) => y != null);
  const starts = rows.map((r) => r.y0).filter((y) => y != null);
  const corpusMin = Math.min(...years), corpusMax = Math.max(...years);
  const maxStart = Math.max(...starts);
  const asOfYear = Number(asOf.slice(0, 4));
  return {
    corpusMin, corpusMax, maxStart, asOfYear,
    ymin: Math.max(FLOOR, corpusMin),
    ymax: Math.max(asOfYear, maxStart),
  };
}

/** The §10.1 table, transcribed from the spec.
 *  The leading full-range short-circuit is the "no range picked" state: with
 *  both handles at the ends the period axis is simply off. */
function specState(r, a, b, undated, ax) {
  if (a <= ax.ymin && b >= ax.ymax) return 'in';
  if (isVague(r)) {
    if (r.y0 != null && b < r.y0) return 'out';   // cannot predate its host
    if (b >= PRESENT) return 'in';                // certainly present
    return undated ? 'soft' : 'out';              // possible, not established
  }
  const s = r.y0 == null ? -Infinity : r.y0;      // no start: reaches back forever
  const e = r.y1 == null ? Infinity : r.y1;       // no end: still running
  return (s <= b && e >= a) ? 'in' : 'out';       // overlap
}

const inScope = (r, { layers = ALL_KINDS, domains = null }) =>
  layers.includes(r.kind) && (!domains || r.domains.some((d) => domains.includes(d)));

/** Ids the spec says survive a given filter state. */
function keptBySpec(rows, ax, { a, b, undated = true, layers, domains } = {}) {
  return rows.filter((r) => inScope(r, { layers, domains }))
    .filter((r) => specState(r, a, b, undated, ax) !== 'out')
    .map((r) => r.id);
}

/** What periodState() actually returns, per entity. */
const statesFromPage = (page) =>
  page.evaluate(() => Object.fromEntries(items.map((it) => [it.id, periodState(it)])));

/** Every claim the two internal sets make about one entity (§10.1: `soft`
 *  belongs to vis *and* dimmed). */
const seenBy = (page, id) => page.evaluate((x) => {
  const { vis, dimmed, matched } = visibleSet();
  const mk = document.querySelector(`.mk[data-id="${x}"]`);
  return {
    state: periodState(byId[x]),
    matches: matchesFilters(byId[x]),
    vis: vis.has(x), dimmed: dimmed.has(x), matched: matched.has(x),
    markerHidden: mk ? mk.style.display === 'none' : null,
    markerDim: mk ? mk.classList.contains('dim') : null,
  };
}, id);

const bars = (page) => page.evaluate(() => ({
  viewBox: document.getElementById('tf-hist').getAttribute('viewBox'),
  rects: [...document.querySelectorAll('#tf-hist rect')].map((r) => ({
    y: Number(r.dataset.y), h: r.getAttribute('height'), on: r.classList.contains('on'),
    x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')),
  })),
}));

/** The per-year running totals the histogram is supposed to draw (§10). */
function histCounts(rows, ax, scope = {}) {
  const counts = new Map();
  for (const r of rows) {
    if (!inScope(r, scope) || !r.dated) continue;
    const s = Math.max(ax.ymin, r.y0 == null ? ax.ymin : r.y0);
    const e = Math.min(ax.ymax, r.y1 == null ? ax.ymax : r.y1);
    for (let y = s; y <= e; y++) counts.set(y, (counts.get(y) || 0) + 1);
  }
  return counts;
}

/** Those totals as the bars the SVG must contain: one rect per non-empty year,
 *  heights normalised to the *filtered* peak. */
function expectedBars(counts, ax) {
  const peak = Math.max(1, ...counts.values());
  const out = [];
  for (let y = ax.ymin; y <= ax.ymax; y++) {
    const c = counts.get(y) || 0;
    if (c) out.push({ y, h: Math.max(1.1, (c / peak) * 19).toFixed(2) });
  }
  return out;
}

const undatedControl = (page) => page.evaluate(() => ({
  n: Number(document.getElementById('tf-undated-n').textContent),
  title: document.getElementById('tf-undated-n').title,
  checked: document.getElementById('tf-undated').checked,
  rowHidden: document.getElementById('tf-row2').hidden,
}));

const knob = (page, which) => page.evaluate((w) => {
  const el = document.getElementById('tf-' + w);
  return {
    role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
    min: el.getAttribute('aria-valuemin'), max: el.getAttribute('aria-valuemax'),
    now: el.getAttribute('aria-valuenow'), text: el.getAttribute('aria-valuetext'),
    label: el.getAttribute('aria-label'),
  };
}, which);

/** Press the track at a given fraction of its width, the way a reader clicks
 *  next to the selection (§10.3). The two extremes are used wherever a test
 *  needs an exact year: a pixel of slop there is a fifth of a year. */
async function clickTrackAt(page, px) {
  const slider = page.locator('#tf-slider');
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  await page.mouse.click(box.x + px, box.y + box.height / 2);
}
const trackWidth = async (page) => (await page.locator('#tf-slider').boundingBox()).width;

/** The range the control actually *draws*, read back as years from the pixels
 *  the handles and the selection band occupy. Measured rather than taken from
 *  the page's own tfPct(), so that a handle drawn from the wrong end of the
 *  range cannot agree with the test. Fractions are of the track's width, which
 *  is the same geometry yearAt() reads a pointer against. */
async function drawnYears(page) {
  const slider = page.locator('#tf-slider');
  await slider.scrollIntoViewIfNeeded();
  const track = await slider.boundingBox();
  const box = async (sel) => page.locator(sel).boundingBox();
  const [a, b, band] = [await box('#tf-a'), await box('#tf-b'), await box('#tf-sel')];
  const frac = (x) => (x - track.x) / track.width;
  return {
    a: frac(a.x + a.width / 2), b: frac(b.x + b.width / 2),
    selL: band ? frac(band.x) : null, selR: band ? frac(band.x + band.width) : null,
  };
}

/** Every element that states one of `needles` on a surface a reader can see:
 *  its *own* text nodes, its `title`, or its `aria-label`. Elements are walked
 *  one at a time and descendants' text is deliberately not inherited — a
 *  subtree search would report <html> and <body> as matches and tell us
 *  nothing. Returns a sorted, deduplicated list of ids (or tag.class, for the
 *  unnamed element a regression would most likely add), so a failure names the
 *  offending surface. */
function statedOn(page, needles) {
  return page.evaluate((ns) => {
    const hits = (s) => !!s && ns.some((n) => s.includes(n));
    const found = new Set();
    for (const el of document.querySelectorAll('*')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
      if (!(hits(own) || hits(el.getAttribute('title')) || hits(el.getAttribute('aria-label')))) continue;
      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      found.add(el.id ? '#' + el.id
        : el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).join('.') : ''));
    }
    return [...found].sort();
  }, needles);
}

// ---------------------------------------------------------------------------
// §10 — the axis
// ---------------------------------------------------------------------------

test.describe('§10 the axis', () => {
  test('§10 YMIN is max(1945, the earliest year in the data)', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const ymin = await page.evaluate(() => YMIN);
    expect(ymin).toBe(ax.ymin);
    // The clamp has to be doing real work, or the test above proves nothing:
    // the corpus reaches back to Philips 1914, well under the floor (§10.3).
    // The floor is compared against the file's own FLOOR constant: this line
    // used to read 1945 back out of page.evaluate(), which dressed up the
    // test's own number as something the page had reported.
    expect(ax.corpusMin).toBeLessThan(FLOOR);
    expect(ymin).toBe(FLOOR);
  });

  test('§10.3 the 1945 floor keeps a pre-1945 founding included at the floor', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const old = rows.filter((r) => r.y0 != null && r.y0 < FLOOR);
    // The set is not pinned by size — §3.2 — but §10.3 names four of its members
    // outright, and the floor rule is only load-bearing because the corpus really
    // does reach back behind it. Those four, with their years, are the claim.
    const named = { 'philips-research': 1914, 'abb-cr': 1916, 'siemens-ct': 1916, radboud: 1923 };
    expect(Object.fromEntries(old.filter((r) => r.id in named).map((r) => [r.id, r.y0])))
      .toEqual(named);
    await setPeriod(page, FLOOR, FLOOR);
    const states = await statesFromPage(page);
    // "those entities stay included in any range that reaches the floor" — the
    // axis stops stretching, it does not start excluding.
    for (const r of old) expect(states[r.id], r.id).toBe(isVague(r) ? 'soft' : 'in');
  });

  test('§10 YMAX is the freshness date AS_OF, not the furthest end-date in the data', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const got = await page.evaluate(() => ({ ymax: YMAX, asOfYear: AS_OF_YEAR }));
    // The whole axis rests on slicing a year off AS_OF, so the shape of that
    // field is part of the claim. (The assertion here used to compare
    // `DATA.AS_OF` with `window.HAI_DATA.AS_OF` — but the page opens with
    // `const DATA = window.HAI_DATA`, so it compared the payload with itself
    // and could not fail.)
    expect(pl.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(got.asOfYear).toBe(ax.asOfYear);
    expect(got.ymax).toBe(ax.ymax);
    expect(got.ymax).toBe(ax.asOfYear);
    // The regression this replaced: YMAX used to be Math.max(...YEARS), which
    // is a Horizon Europe end-date years past the present.
    expect(ax.corpusMax).toBeGreaterThan(got.ymax);
  });

  test('§10 YMAX is never clamped below the latest known start year', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const { ymax } = await page.evaluate(() => ({ ymax: YMAX }));
    expect(ymax).toBeGreaterThanOrEqual(ax.maxStart);
    // Note for whoever mutates this next: the clamp itself is invisible from
    // here on the current data. The latest start (Thames Water, 2026) is
    // exactly AS_OF's year, so `Math.max(AS_OF_YEAR, maxStart)` and a bare
    // AS_OF_YEAR are the same number, and deleting the clamp leaves this file
    // green. What the test does pin is the consequence the spec names — no
    // start year outside the slider's reach — which is why the assertion below
    // is over the entities and not over the formula.
    expect(ax.maxStart).toBeLessThanOrEqual(ax.asOfYear);
    // The point of the clamp: every start year must be reachable by some range.
    const { rows } = await payload(page);
    const unreachable = rows.filter((r) => r.y0 != null && r.y0 > ymax).map((r) => r.id);
    expect(unreachable).toEqual([]);
  });

  test('§10 a project funded past the end of the axis still matches every range up to today', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const future = pl.rows.filter((r) => r.y1 != null && r.y1 > ax.ymax);
    // Not a count: the set is pinned by agreeing with the page's own parse of
    // the same entities, and by containing the furthest end-date in the corpus
    // — which is what makes the "empty decade" §10 describes real rather than
    // hypothetical. (If the grants ever all expire the walk below goes vacuous,
    // and the corpusMax assertion is what fails first.)
    const pageSide = await page.evaluate(() =>
      items.filter((it) => it.y1 != null && it.y1 > YMAX).map((it) => it.id).sort());
    expect(pageSide).toEqual(future.map((r) => r.id).sort());
    expect(future.map((r) => r.y1)).toContain(ax.corpusMax);
    // Every range the slider can express, from its own start onwards, keeps it:
    // the end-date it loses off the top of the axis was never what excluded it.
    for (const [a, b] of [[ax.ymin, ax.ymax], [ax.ymax, ax.ymax], [PRESENT, ax.ymax]]) {
      await setPeriod(page, a, b);
      const states = await statesFromPage(page);
      for (const r of future) expect(states[r.id], `${r.id} at ${a}–${b}`).toBe('in');
    }
    // And a collapsed range on its own start year, the tightest case of all.
    for (const r of future) {
      await setPeriod(page, r.y0, r.y0);
      expect((await statesFromPage(page))[r.id], `${r.id} at ${r.y0}`).toBe('in');
    }
  });

  test('§10 no future tail: the histogram and the range both stop at YMAX', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const { viewBox, rects } = await bars(page);
    expect(viewBox).toBe(`0 0 ${ax.ymax - ax.ymin + 1} 20`);
    expect(Math.max(...rects.map((r) => r.y))).toBe(ax.ymax);
    // Both handles clamp to the axis, so the "empty decade" is not draggable.
    await setPeriod(page, ax.ymax + 10, ax.ymax + 20);
    expect((await snapshot(page)).years).toEqual({ a: ax.ymax, b: ax.ymax, undated: true });
  });

  test('§10 the default range is the whole axis, so the period axis is off', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const s = await snapshot(page);
    expect(s.years).toEqual({ a: ax.ymin, b: ax.ymax, undated: true });
    expect(await page.evaluate(() => timeOn())).toBe(false);
    expect(await periodLabel(page)).toBe(`${ax.ymin} – ${ax.ymax}`);
    // The axis being off means every entity in the payload matches, whatever
    // the corpus happens to hold on the day (§3.2).
    expect(s.matchCount).toBe(pl.rows.length);
    // Nothing is dimmed by the period when no period is picked.
    expect(await page.evaluate(() => visibleSet().dimmed.size)).toBe(0);
    expect((await undatedControl(page)).rowHidden).toBe(true);
  });

  test('§10 the range label reads as a span, and collapses to one year when a === b', async ({ page }) => {
    await openMap(page);
    await setPeriod(page, 1990, 2001);
    expect(await periodLabel(page)).toBe('1990 – 2001');   // en dash, not a hyphen
    await setPeriod(page, 2001, 2001);
    expect(await periodLabel(page)).toBe('2001');
  });

  test('§10.3 the slider title names the axis and the floor rule', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    expect(await page.getAttribute('#tf-slider', 'title'))
      .toBe(`${ax.ymin} – ${ax.ymax} · earlier foundings stay included`);
  });
});

// ---------------------------------------------------------------------------
// §10 — overlap semantics
// ---------------------------------------------------------------------------

test.describe('§10 overlap semantics', () => {
  test('§10 a dated entity is kept exactly when its span overlaps the selection', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    for (const [a, b] of [[1945, 1948], [1949, 2019], [2000, 2005], [1990, 1990], [PRESENT, ax.ymax]]) {
      await setPeriod(page, a, b);
      const got = await statesFromPage(page);
      const wrong = pl.rows
        .map((r) => [r.id, got[r.id], specState(r, a, b, true, ax)])
        .filter(([, got_, want]) => got_ !== want)
        .map(([id, got_, want]) => `${id}: ${got_} ≠ ${want}`);
      expect(wrong, `period ${a}–${b}`).toEqual([]);
    }
  });

  test('§10 no recorded end means "still running"', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    // Fitts's list, 1951, no end: a framework does not stop being a framework.
    const fitts = rows.find((r) => r.id === 'fitts-list-maba-maba');
    expect([fitts.y0, fitts.y1, isVague(fitts)]).toEqual([1951, null, false]);
    for (const [a, b] of [[1951, 1951], [1960, 1960], [1951, 2026], [2026, 2026]]) {
      await setPeriod(page, a, b);
      expect((await statesFromPage(page))[fitts.id], `${a}–${b}`).toBe('in');
    }
    // …but it did not exist before it was written.
    await setPeriod(page, FLOOR, 1950);
    expect((await statesFromPage(page))[fitts.id]).toBe('out');
  });

  test('§10 a present-day range drops exactly the entities that have ended', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    // This test used to read "nothing in the corpus has ended, so a present-day
    // range keeps all 449", and said in a comment that if a closed project were
    // ever added, this is the test that would say so. A regeneration later,
    // there are some — concluded FP4/FP6-era projects and a research institute
    // that was wound up — so the claim is stated as the rule it always was:
    // what a 2020-onwards range drops is exactly the entities whose recorded
    // end is in the past, by the overlap test and nothing else.
    const ended = pl.rows.filter((r) => r.y1 != null && r.y1 < PRESENT);
    await setPeriod(page, PRESENT, ax.ymax);
    const states = await statesFromPage(page);
    for (const r of ended) expect(states[r.id], `${r.id} ended ${r.y1}`).toBe('out');
    const s = await snapshot(page);
    expect(s.matchCount).toBe(pl.rows.length - ended.length);
    expect(await page.evaluate(() => [...visibleSet().matched].sort()))
      .toEqual(keptBySpec(pl.rows, ax, { a: PRESENT, b: ax.ymax }).sort());
    // Dated either way, so nothing is merely possible in this range.
    expect(await page.evaluate(() => visibleSet().dimmed.size)).toBe(0);
    await expectCountersReconcile(page, '2020 to now');
  });

  test('§10 one result: Frameworks in 1960 leaves only Fitts, which has no marker', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setLayers(page, ['framework']);
    await setPeriod(page, 1960, 1960);
    expect(keptBySpec(pl.rows, ax, { a: 1960, b: 1960, layers: ['framework'] }))
      .toEqual(['fitts-list-maba-maba']);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(1);
    expect(s.offMapMatch).toBe(1);      // the concept is not placed anywhere
    expect(s.inView).toBe(0);
    expect(s.offScreen).toBe(0);
    expect((await tiles(page)).reduce((a, t) => a + t.count, 0)).toBe(0);
    await expectCountersReconcile(page, 'one off-map match');
  });

  test('§10 zero results: Commons has nothing before 1961', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setLayers(page, ['commons']);
    await setPeriod(page, FLOOR, 1960);
    expect(keptBySpec(pl.rows, ax, { a: FLOOR, b: 1960, layers: ['commons'] })).toEqual([]);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.inView).toBe(0);
    expect(s.offMapMatch).toBe(0);
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0, 0]);
    expect(await page.textContent('.fd-empty')).toBe('Nothing in view — zoom out or widen the filters.');
    await expectCountersReconcile(page, 'empty selection');
  });
});

// ---------------------------------------------------------------------------
// §10.1 — the tri-state
// ---------------------------------------------------------------------------

test.describe('§10.1 unknown start', () => {
  test('§10.1 PRESENT_FROM is 2020 and the vague set is exactly the undated teams', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const vague = rows.filter(isVague);
    const got = await page.evaluate(() => ({
      present: PRESENT_FROM, undated: UNDATED,
      vagueIds: items.filter((it) => it.vague).map((it) => it.id).sort(),
    }));
    expect(got.present).toBe(PRESENT);
    // UNDATED is the figure §10.1 calls "All 37"; the number moves with the
    // corpus, so what is pinned is that it counts the set this file's own rule
    // picks out of the payload, entity for entity and not merely in total.
    expect(got.undated).toBe(vague.length);
    expect(got.vagueIds).toEqual(vague.map((r) => r.id).sort());
    // "All 37 undated entities are teams" — the claim the 0-under-Commons
    // count rests on. An empty vague set would fail this line rather than
    // slip through it.
    expect([...new Set(vague.map((r) => r.kind))]).toEqual(['team']);
  });

  test('§10.1 reaching 2020 or later: solid, certainly present', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const vague = rows.filter(isVague);
    // The lower bound outranks the table's first row, and the data now makes
    // that visible: a department whose host was founded *after* 2020 cannot be
    // present in a range ending at 2020, so it is hidden rather than solid.
    // §10.1's "Reaching 2020 or later → solid" is written for host years that
    // precede 2020; the split is by that rule, not by the id that happens to
    // sit on the far side of it today.
    const present = vague.filter((r) => r.y0 == null || r.y0 <= PRESENT);
    const tooLate = vague.filter((r) => r.y0 != null && r.y0 > PRESENT);
    await setPeriod(page, FLOOR, PRESENT);              // a real range, ending exactly at 2020
    expect(await page.evaluate(() => timeOn())).toBe(true);
    const states = await statesFromPage(page);
    for (const r of present) expect(states[r.id], r.id).toBe('in');
    for (const r of tooLate) expect(states[r.id], `${r.id}, host ${r.y0}`).toBe('out');
    // Solid, not possible: a range reaching 2020 dims nothing at all.
    expect(await page.evaluate(() => visibleSet().dimmed.size)).toBe(0);
  });

  test('§10.1 between the host founding year and 2020: dimmed, possible but not established', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const tno = rows.find((r) => r.id === 'tno-hmt');
    expect([tno.y0, tno.host]).toEqual([1949, true]);   // TNO Soesterberg, 1949
    for (const [a, b] of [[1949, 2019], [FLOOR, 2019], [1960, 1990]]) {
      await setPeriod(page, a, b);
      expect((await statesFromPage(page))[tno.id], `${a}–${b}`).toBe('soft');
    }
  });

  test('§10.1 before the host founding year: hidden, impossible', async ({ page }) => {
    await openMap(page);
    await setPeriod(page, FLOOR, 1948);
    const seen = await seenBy(page, 'tno-hmt');
    expect(seen.state).toBe('out');
    expect(seen.matches).toBe(false);
    expect(seen.vis).toBe(false);
    expect(seen.markerHidden).toBe(true);
  });

  test('§10.1 the band edges are exact: 2020 solid, 2019 possible, host year possible, the year before it gone', async ({ page }) => {
    await openMap(page);
    // One entity walked across all three rows of the table, a year at a time.
    for (const [b, want] of [[2020, 'in'], [2019, 'soft'], [1949, 'soft'], [1948, 'out']]) {
      await setPeriod(page, FLOOR, b);
      expect((await statesFromPage(page))['tno-hmt'], `b=${b}`).toBe(want);
    }
  });

  test('§10.1 a host founded in 2020 or later is out at 2019 — which is why the soft set is short of the vague set', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    // Picked by the property that matters rather than by id: an entity whose
    // host year is exactly PRESENT_FROM sits one year above the band, so the
    // lower bound bites a year before the "certainly present" rule would
    // rescue it. (Maynooth's AISG is that entity today.)
    const atPresent = rows.find((r) => isVague(r) && r.y0 === PRESENT);
    expect([atPresent.host, atPresent.y0]).toEqual([true, PRESENT]);
    await setPeriod(page, FLOOR, 2019);
    const states = await statesFromPage(page);
    expect(states[atPresent.id], atPresent.id).toBe('out');
    // Every vague entity the bound bars is out, and the soft set is the rest of
    // the vague set exactly — no third outcome, and no arithmetic pinned to a
    // snapshot of the corpus.
    const barred = rows.filter((r) => isVague(r) && r.y0 != null && r.y0 > 2019);
    expect(barred.map((r) => r.id)).toContain(atPresent.id);
    for (const r of barred) expect(states[r.id], `${r.id}, host ${r.y0}`).toBe('out');
    const soft = Object.values(states).filter((s) => s === 'soft').length;
    expect(soft).toBe(rows.filter(isVague).length - barred.length);
  });

  test('§10.1 an entity with no year at all stays possible however far back the range goes', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const noYear = rows.filter((r) => !r.dated);
    // §10.2's table lists "No timeline.start at all" as a case the generator
    // emits, and this test is the only one that walks it: if it ever empties,
    // the loops below would pass by saying nothing, so the set is required to
    // exist before it is described.
    expect(noYear.length > 0, 'the no-year case §10.2 names must exist in the payload').toBe(true);
    // Not `r.y0 == null && r.y1 == null`, which is how `dated` was computed in
    // the payload helper two steps earlier and so could never fail. The claim
    // worth making is that the *page's* own parse found no year either, and
    // that these are the no-year case rather than the dateHost one (§10.2).
    const pageSide = await page.evaluate((ids) => ids.map((id) =>
      [byId[id].y0, byId[id].y1, byId[id].dated, !!byId[id].d.dateHost]), noYear.map((r) => r.id));
    expect(pageSide).toEqual(noYear.map(() => [null, null, false, false]));
    // No year means no lower bound, so there is no range in which they vanish —
    // only ranges in which they are possible rather than certain.
    for (const b of [FLOOR, 1949, 1990, 2019]) {
      await setPeriod(page, FLOOR, b);
      const states = await statesFromPage(page);
      for (const r of noYear) expect(states[r.id], `${r.id} at ${FLOOR}–${b}`).toBe('soft');
    }
    await setPeriod(page, FLOOR, PRESENT);
    const states = await statesFromPage(page);
    for (const r of noYear) expect(states[r.id], r.id).toBe('in');
  });

  test('§10.1 soft puts the entity in both vis and dimmed', async ({ page }) => {
    await openMap(page);
    await setPeriod(page, FLOOR, 2019);
    const seen = await seenBy(page, 'tno-hmt');
    expect(seen).toMatchObject({
      state: 'soft', matches: true, vis: true, dimmed: true, matched: true,
      markerHidden: false, markerDim: true,
    });
    // And the dimmed set is exactly the soft set — dimming has one cause here.
    const pl = await payload(page);
    const ax = axis(pl);
    const expected = pl.rows.filter((r) => specState(r, FLOOR, 2019, true, ax) === 'soft')
      .map((r) => r.id).sort();
    expect(await page.evaluate(() => [...visibleSet().dimmed].sort())).toEqual(expected);
  });

  test('§10.1 the feed replaces a possible entity\'s location with "possibly"', async ({ page }) => {
    await openMap(page);
    await fitAll(page);
    const { rows } = await payload(page);
    const tno = rows.find((r) => r.id === 'tno-hmt');
    expect(tno.place).toBe('The Hague, NL');
    // Solid: the row reads as any other row does.
    expect(await page.textContent('.fd-item[data-id="tno-hmt"] .mt')).toBe(tno.place);
    await setPeriod(page, FLOOR, 2019);
    expect(await page.textContent('.fd-item[data-id="tno-hmt"] .mt')).toBe('possibly');
    // A dated neighbour in the same feed keeps its location, so this is the
    // period speaking and not the whole feed losing its places.
    const dated = rows.find((r) => r.kind === 'team' && !isVague(r) && r.y0 <= 2019 && r.place && r.geo);
    expect(await page.textContent(`.fd-item[data-id="${dated.id}"] .mt`)).toBe(dated.place);
  });

  test('§10.1 in French the possible row reads "peut-être"', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    await fitAll(page);
    await setPeriod(page, FLOOR, 2019);
    expect(await page.textContent('.fd-item[data-id="tno-hmt"] .mt')).toBe('peut-être');
  });

  test('§10.1 possible entities count as matching the filters', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setPeriod(page, FLOOR, 2019);
    const kept = keptBySpec(pl.rows, ax, { a: FLOOR, b: 2019 });
    // The old "246 dated + 36 possible" comment, asserted instead of stated —
    // what matches is the established dates plus the possible set, and nothing
    // else is in there twice or missing.
    const dated = pl.rows.filter((r) => !isVague(r) && specState(r, FLOOR, 2019, true, ax) === 'in');
    const possible = pl.rows.filter((r) => specState(r, FLOOR, 2019, true, ax) === 'soft');
    expect(kept.length).toBe(dated.length + possible.length);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(kept.length);
    expect(await page.evaluate(() => [...visibleSet().matched].sort())).toEqual(kept.sort());
    await expectCountersReconcile(page, '1945–2019 with the possible set kept');
  });
});

// ---------------------------------------------------------------------------
// §10.1 — the unknown-start checkbox
// ---------------------------------------------------------------------------

test.describe('§10.1 the unknown-start checkbox', () => {
  test('§10.1 unchecking removes exactly the possible set', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setPeriod(page, FLOOR, 2019);
    const before = await page.evaluate(() => [...visibleSet().matched].sort());
    await page.locator('#tf-undated').uncheck();
    const after = await page.evaluate(() => [...visibleSet().matched].sort());
    const removed = before.filter((id) => !after.includes(id)).sort();
    const soft = pl.rows.filter((r) => specState(r, FLOOR, 2019, true, ax) === 'soft')
      .map((r) => r.id).sort();
    expect(removed).toEqual(soft);
    // What is left is the established dates — asserted as the set itself, which
    // says more than the count it replaces.
    expect(after).toEqual(keptBySpec(pl.rows, ax, { a: FLOOR, b: 2019, undated: false }).sort());
    expect((await snapshot(page)).years.undated).toBe(false);
    expect(await page.evaluate(() => visibleSet().dimmed.size)).toBe(0);
    await expectCountersReconcile(page, 'established dates only');
  });

  test('§10.1 unchecking leaves an impossible entity impossible, not merely undimmed', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setPeriod(page, FLOOR, 1948);
    const kept = await page.evaluate(() => [...visibleSet().matched].sort());
    expect(kept).toEqual(keptBySpec(pl.rows, ax, { a: FLOOR, b: 1948 }).sort());
    await page.locator('#tf-undated').uncheck();
    const strict = await page.evaluate(() => [...visibleSet().matched].sort());
    expect(strict).toEqual(keptBySpec(pl.rows, ax, { a: FLOOR, b: 1948, undated: false }).sort());
    // The switch takes away the possible ones; what it must not do is give back
    // an entity the host bound already ruled out. Those stay gone either way.
    const impossible = pl.rows.filter((r) => isVague(r) && r.y0 != null && r.y0 > 1948);
    expect(impossible.map((r) => r.id)).not.toEqual([]);
    for (const r of impossible) {
      expect(kept, `${r.id}, host ${r.y0}, switch on`).not.toContain(r.id);
      expect(strict, `${r.id}, host ${r.y0}, switch off`).not.toContain(r.id);
    }
  });

  test('§10.1 the count is the set it governs — 0 under Commons, not the whole set', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const all = rows.filter(isVague).length;
    const under = (kind) => rows.filter((r) => isVague(r) && r.kind === kind).length;
    expect(await undatedControl(page)).toMatchObject({ n: all, title: '', checked: true });
    await setLayers(page, ['commons']);
    // The figure a reader filtered to Commons must see: the switch beside it
    // cannot change a single entity here. The 0 is derived — it is what the
    // payload says about Commons, not a transcribed figure — and the caption
    // still has to spell out the set it is 0 of.
    expect(under('commons')).toBe(0);
    expect(await undatedControl(page))
      .toMatchObject({ n: 0, title: `0 of ${all} under the current filters` });
    await setLayers(page, ['team']);
    expect(under('team')).toBe(all);                    // §10.1, "All 37 … are teams"
    expect(await undatedControl(page)).toMatchObject({ n: all, title: '' });
  });

  test('§10.1 the count skips the period axis it controls', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const all = rows.filter(isVague).length;
    // A range that hides most of the vague set must not shrink the number
    // beside the switch: it would then describe a set the switch cannot change.
    await setPeriod(page, FLOOR, 1948);
    expect((await undatedControl(page)).n).toBe(all);
    await setPeriod(page, FLOOR, 1945);
    expect((await undatedControl(page)).n).toBe(all);
    await page.locator('#tf-undated').uncheck();
    expect((await undatedControl(page)).n).toBe(all);
  });

  test('§10.1 the count follows the domain axis', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const all = rows.filter(isVague).length;
    await applyPreset(page, 'energy');
    const expected = rows.filter((r) => isVague(r) && r.domains.includes('energy')).length;
    // A domain that holds some but not all of the vague set is what makes this
    // test bite: both ends would be indistinguishable from the count ignoring
    // the domain axis altogether.
    expect(expected > 0 && expected < all, `energy holds ${expected} of ${all}`).toBe(true);
    expect(await undatedControl(page)).toMatchObject({
      n: expected, title: `${expected} of ${all} under the current filters`,
    });
  });

  test('§10.1 the switch and the reset appear only once the period filter is engaged', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    expect((await undatedControl(page)).rowHidden).toBe(true);
    await setPeriod(page, 1990, 2010);
    expect((await undatedControl(page)).rowHidden).toBe(false);
    await page.locator('#tf-undated').uncheck();
    // Still engaged with the handles back at the ends, because the switch is off.
    await setPeriod(page, ax.ymin, ax.ymax);
    expect(await undatedControl(page)).toMatchObject({ rowHidden: false, checked: false });
    await page.click('#tf-reset');
    expect(await undatedControl(page)).toMatchObject({ rowHidden: true, checked: true });
  });

  // SPEC-DEVIATION: §10.1 says the switch "removes the whole set for a reader
  // who wants only established dates", but with the full range selected the
  // vague set comes back whatever the checkbox says. A reader can reach this
  // state through the UI: narrow the range (which reveals the switch), uncheck
  // it, then widen back to the ends. A strict reading of the prose would keep
  // the corpus minus the vague set here.
  //
  // The cause is the §10.1 table itself, not the `if (!timeOn()) return 'in'`
  // short-circuit this comment used to blame: deleting that line leaves every
  // test in this file green, because a full range reaches AS_OF's year, and the
  // table's first row makes an unknown start "solid — certainly present" from
  // 2020 onwards regardless of the switch. Repairing the short-circuit would
  // therefore change nothing; the row is what would have to give.
  test('§10.1 at the full range the switch has no effect (current behaviour)', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setPeriod(page, 1990, 2010);
    await page.locator('#tf-undated').uncheck();
    await setPeriod(page, ax.ymin, ax.ymax);
    expect((await snapshot(page)).years).toEqual({ a: ax.ymin, b: ax.ymax, undated: false });
    expect(await page.evaluate(() => timeOn())).toBe(false);
    // The whole corpus, not the corpus minus the vague set — which is the
    // deviation, stated as the arithmetic a strict reading would have expected.
    const vague = pl.rows.filter(isVague).length;
    expect((await snapshot(page)).matchCount).toBe(pl.rows.length);
    expect((await snapshot(page)).matchCount).not.toBe(pl.rows.length - vague);
    // One year in from the ceiling, the axis is live again and it does bite.
    await setPeriod(page, ax.ymin, 2019);
    expect((await snapshot(page)).matchCount)
      .toBe(keptBySpec(pl.rows, ax, { a: ax.ymin, b: 2019, undated: false }).length);
  });
});

// ---------------------------------------------------------------------------
// §10.2 — what counts as an unknown start
// ---------------------------------------------------------------------------

test.describe('§10.2 what counts as an unknown start', () => {
  test('§10.2 the vague set is exactly "no timeline.start" plus "dateHost"', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const noStart = rows.filter((r) => !r.dated).map((r) => r.id);
    const hosted = rows.filter((r) => r.host).map((r) => r.id);
    // §10.2's table has a row for each case, so both must be populated for the
    // union below to mean anything — but how many are in each is a snapshot
    // (§3.2). What is pinned instead is that the page's own parse agrees, id by
    // id, on which entity falls in which row of that table.
    expect([noStart.length > 0, hosted.length > 0],
      'both §10.2 cases must exist in the payload').toEqual([true, true]);
    const pageSide = await page.evaluate(() => ({
      noStart: items.filter((it) => !it.dated).map((it) => it.id).sort(),
      hosted: items.filter((it) => !!it.d.dateHost).map((it) => it.id).sort(),
    }));
    expect(pageSide.noStart).toEqual([...noStart].sort());
    expect(pageSide.hosted).toEqual([...hosted].sort());
    expect(noStart.filter((id) => hosted.includes(id))).toEqual([]);   // disjoint cases
    const got = await page.evaluate(() => items.filter((it) => it.vague).map((it) => it.id).sort());
    expect(got).toEqual([...noStart, ...hosted].sort());
    // A dateHost entity still counts as *dated* for the histogram's purposes:
    // it has a year, it just is not its own.
    expect(await page.evaluate(() => byId['tno-hmt'].dated)).toBe(true);
  });

  test('§10.2 a dateConf-only estimate is dated normally — hidden before its year', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    // "Estimate: MAHALO started 2020" is a judgement about *this* entry, so it
    // behaves like any other start: no dimmed band, no host bound.
    const mahalo = rows.find((r) => r.id === 'mahalo');
    expect([mahalo.y0, mahalo.host, isVague(mahalo)]).toEqual([2020, false, false]);
    await setPeriod(page, FLOOR, 2019);
    expect((await statesFromPage(page))['mahalo']).toBe('out');
    await setPeriod(page, PRESENT, PRESENT);
    expect((await statesFromPage(page))['mahalo']).toBe('in');
    expect(await page.evaluate(() => visibleSet().dimmed.has('mahalo'))).toBe(false);
  });

  test('§10.2 TNO — Human-Machine Teaming shows ≈ 1949 with the host caveat', async ({ page }) => {
    await openMap(page);
    const card = await page.evaluate(() => {
      openEntity('tno-hmt', { fly: false });
      const host = document.getElementById('dt-body');
      return {
        span: host.querySelector('.dt-span').textContent,
        caveat: host.querySelector('.dt-caveat').textContent,
        hostMsg: I18N.en.dateHost, approxMsg: I18N.en.dateApprox,
      };
    });
    // The year stays in the data and is shown, but marked as approximate.
    expect(card.span).toBe('≈ 1949 →');
    expect(card.caveat).toBe(card.hostMsg);
    expect(card.caveat).not.toBe(card.approxMsg);
    // "a caption stating exactly how the map treats it" — the caption spells
    // out the same three bands periodState() implements.
    expect(card.caveat).toContain('2020');
  });

  test('§10.3 the researched dates are the entity\'s own; the three open ones keep a host bound', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    const row = (id) => rows.find((r) => r.id === id);
    // §10.3, "Researched": resolved individually, so they are dated normally —
    // the map must not flatten a researched date back into "unknown start".
    const researched = {
      powsybl: '2018', italgas: '2017', energinet: '2023', vitens: '2010',
      'inserm-ai': '2021-12', 'thames-water': '2026',
      'ifac-tc41-human-machine-systems': '1981',
    };
    for (const [id, start] of Object.entries(researched)) {
      const r = row(id);
      expect([id, r.start, r.host, isVague(r)]).toEqual([id, start, false, false]);
    }
    // §10.3, "Judged": three remain genuinely open and stay on a host bound,
    // which is what keeps them possible rather than present before 2020.
    for (const id of ['ceps-ics', 'transelectrica-smartgrid', 'uisce-eireann']) {
      const r = row(id);
      expect([id, r.host, isVague(r), r.y0 < PRESENT]).toEqual([id, true, true, true]);
    }
    // Italgas 2017 is "not the 1837 company" — a researched date that the floor
    // would otherwise have had to stretch for.
    expect(row('italgas').y0).toBe(2017);
    await setPeriod(page, FLOOR, 2016);
    const states = await statesFromPage(page);
    expect(states['italgas']).toBe('out');            // its own date, applied strictly
    expect(states['ceps-ics']).toBe('soft');          // a bound, applied softly
  });

  test('§10.2 a host year is a lower bound, not a start: 1950 leaves TNO possible, not present', async ({ page }) => {
    await openMap(page);
    const { rows } = await payload(page);
    // The contrast that makes the distinction visible: an entity that genuinely
    // started in 1949 is solidly `in` for 1950–1960; TNO's HMT department,
    // which only inherits 1949 from its institute, is merely possible.
    const genuine = rows.find((r) => !isVague(r) && r.y0 != null && r.y0 <= 1950 && r.y1 == null);
    await setPeriod(page, 1950, 1960);
    const states = await statesFromPage(page);
    expect(states['tno-hmt']).toBe('soft');
    expect(states[genuine.id], genuine.id).toBe('in');
  });
});

// ---------------------------------------------------------------------------
// §10 — the histogram
// ---------------------------------------------------------------------------

test.describe('§10 the histogram', () => {
  test('§10 one bar per year with entities running, from the filtered set', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const want = expectedBars(histCounts(pl.rows, ax), ax);
    const { rects } = await bars(page);
    expect(rects.map(({ y, h }) => ({ y, h }))).toEqual(want);
    // Across the whole corpus every year on the axis has something running, so
    // there is a bar per year — one claim rather than a transcribed 82.
    expect(rects.length).toBe(ax.ymax - ax.ymin + 1);
    expect(rects[0].y).toBe(ax.ymin);
  });

  // The bars' heights are checked all over this block; their horizontal
  // placement was not checked anywhere, and it is what makes the curve mean
  // anything under the handles — a bar drawn one slot out shifts the whole
  // growth curve against a selection band that did not move.
  test('§10 every bar sits in its own year\'s slot, so the curve lines up with the handles', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const { viewBox, rects } = await bars(page);
    // One viewBox unit per year is what lets the slot double as the year.
    expect(viewBox).toBe(`0 0 ${ax.ymax - ax.ymin + 1} 20`);
    for (const r of rects) {
      expect(Math.round(r.x), `bar ${r.y} is in the slot for ${ax.ymin + Math.round(r.x)}`)
        .toBe(r.y - ax.ymin);
      expect(r.x, `bar ${r.y}`).toBeCloseTo(r.y - ax.ymin + 0.12, 6);   // inset in its slot
      expect(r.w, `bar ${r.y}`).toBe(0.76);                             // narrower than it
    }
    // Ascending, one slot each, and the curve spans exactly the axis the
    // handles travel — no bar beyond either end.
    const slots = rects.map((r) => r.x);
    expect(slots).toEqual([...slots].sort((p, q) => p - q));
    expect(new Set(slots).size).toBe(slots.length);
    expect(rects[0].y).toBe(ax.ymin);
    expect(rects[rects.length - 1].y).toBe(ax.ymax);
  });

  test('§10 the histogram is drawn from the filtered set, not the corpus', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setLayers(page, ['commons']);
    const want = expectedBars(histCounts(pl.rows, ax, { layers: ['commons'] }), ax);
    const { rects } = await bars(page);
    expect(rects.map(({ y, h }) => ({ y, h }))).toEqual(want);
    // Commons begins two thirds of the way along the axis, so the early decades
    // are empty — the reader sizes the handles against the population actually
    // on the map. Both figures come from the payload: the first Commons year,
    // and the run of years from there to the ceiling.
    const first = Math.min(...pl.rows.filter((r) => r.kind === 'commons' && r.dated)
      .map((r) => r.y0 ?? ax.ymin));
    expect(rects[0].y).toBe(first);
    expect(rects.length).toBe(ax.ymax - first + 1);
    expect(first).toBeGreaterThan(ax.ymin);              // or there is nothing to notice
  });

  test('§10 bars are normalised to the filtered peak, not a fixed corpus peak', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const full = await bars(page);
    const fullCounts = histCounts(pl.rows, ax);
    const fullPeak = Math.max(...fullCounts.values());
    await setLayers(page, ['commons']);
    const small = await bars(page);
    const smallPeak = Math.max(...histCounts(pl.rows, ax, { layers: ['commons'] }).values());
    // The two peaks are an order of magnitude apart in entities — which is the
    // premise of the test, not a figure from the corpus: §10 justifies the
    // per-filter normalisation by exactly this gap, so it is asserted as the
    // ratio the prose claims rather than as the day's two counts.
    expect(fullPeak).toBeGreaterThan(smallPeak * 10);
    // …and exactly the same height on screen, which is the point: a layer of a
    // couple of dozen entities would otherwise draw a flat line one pixel high.
    const tallest = (b) => Math.max(...b.rects.map((r) => Number(r.h)));
    expect(tallest(full)).toBe(19);
    expect(tallest(small)).toBe(19);
    // And no populated year is ever drawn thinner than the 1.1 floor.
    expect(small.rects.every((r) => Number(r.h) >= 1.1)).toBe(true);
  });

  test('§10 toggling a layer redraws the bars', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const before = (await bars(page)).rects.map(({ y, h }) => ({ y, h }));
    await setLayers(page, ['team']);
    const after = (await bars(page)).rects.map(({ y, h }) => ({ y, h }));
    // Teams span the whole axis too, so the bar *count* is unchanged — what
    // moves is every height, against a peak that is now the layer's own.
    const wantAfter = expectedBars(histCounts(pl.rows, ax, { layers: ['team'] }), ax);
    expect(after).toEqual(wantAfter);
    const changed = after.filter((r) => !before.some((b) => b.y === r.y && b.h === r.h));
    const wantChanged = wantAfter.filter((r) => !before.some((b) => b.y === r.y && b.h === r.h));
    expect(changed).toEqual(wantChanged);
    // The bars that hold still are the sparse early years, both readings
    // already pinned to the 1.1 minimum height that keeps a single entity
    // visible — and nothing else holds still, which is the claim worth making:
    // a bar standing still for any other reason means a height that did not
    // follow the layer. (The old "13" said less, and moved with the corpus.)
    const held = after.filter((r) => before.some((b) => b.y === r.y && b.h === r.h));
    expect(held).toEqual(wantAfter.filter((r) => r.h === '1.10'
      && before.some((b) => b.y === r.y && b.h === '1.10')));
    expect(held.every((r) => r.h === '1.10')).toBe(true);
    expect(held.length).toBe(after.length - changed.length);
  });

  test('§10 the histogram skips the period axis it is the control for', async ({ page }) => {
    await openMap(page);
    const before = (await bars(page)).rects.map(({ y, h }) => ({ y, h }));
    await setPeriod(page, 2000, 2005);
    expect((await bars(page)).rects.map(({ y, h }) => ({ y, h }))).toEqual(before);
    await page.locator('#tf-undated').uncheck();
    expect((await bars(page)).rects.map(({ y, h }) => ({ y, h }))).toEqual(before);
  });

  test('§10 the selection is repainted onto the bars, not redrawn', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    expect((await bars(page)).rects.every((r) => r.on)).toBe(true);
    await setPeriod(page, 1990, 2001);
    const { rects } = await bars(page);
    expect(rects.filter((r) => r.on).map((r) => r.y))
      .toEqual(rects.map((r) => r.y).filter((y) => y >= 1990 && y <= 2001));
    // A collapsed range lights exactly one bar.
    await setPeriod(page, 2001, 2001);
    expect((await bars(page)).rects.filter((r) => r.on).map((r) => r.y)).toEqual([2001]);
    await page.click('#tf-reset');
    expect((await bars(page)).rects.filter((r) => !r.on)).toEqual([]);
    expect(await periodLabel(page)).toBe(`${ax.ymin} – ${ax.ymax}`);
  });

  // §10.2 says the map "never draws [a host year] as the start of the work",
  // and the card honours that with "≈ 1949". The histogram is the one place
  // that does not: a dateHost entity contributes a bar from its host's founding
  // year like any dated entity. Asserting the current arithmetic, so that a
  // deliberate change shows up here rather than as a silent shift in the curve.
  test('§10.2 the histogram counts host years as starts (current behaviour)', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const at = (year, rows) => rows.filter((r) => r.dated
      && Math.max(ax.ymin, r.y0 ?? ax.ymin) <= year
      && Math.min(ax.ymax, r.y1 ?? ax.ymax) >= year).length;
    const withVague = at(1949, pl.rows);
    const withoutVague = at(1949, pl.rows.filter((r) => !isVague(r)));
    // The difference between the two readings is exactly the vague entities
    // running in 1949 — TNO's HMT department, whose 1949 is its institute's,
    // among them. That decomposition is the behaviour being pinned; the two
    // totals themselves are a snapshot (§3.2).
    const vagueAt = pl.rows.filter((r) => isVague(r) && at(1949, [r]) === 1);
    expect(vagueAt.map((r) => r.id)).toContain('tno-hmt');
    expect(withVague).toBe(withoutVague + vagueAt.length);
    const counts = histCounts(pl.rows, ax);
    expect(counts.get(1949)).toBe(withVague);
    const bar = (await bars(page)).rects.find((r) => r.y === 1949);
    const peak = Math.max(...counts.values());
    expect(bar.h).toBe(Math.max(1.1, (withVague / peak) * 19).toFixed(2));
  });
});

// ---------------------------------------------------------------------------
// §10.3 — interaction
// ---------------------------------------------------------------------------

test.describe('§10.3 interaction', () => {
  test('§10.3 the knobs are sliders with a live value', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    expect(await knob(page, 'a')).toEqual({
      role: 'slider', tabindex: '0', min: String(ax.ymin), max: String(ax.ymax),
      now: String(ax.ymin), text: String(ax.ymin), label: 'First year',
    });
    expect(await knob(page, 'b')).toMatchObject({
      role: 'slider', now: String(ax.ymax), text: String(ax.ymax), label: 'Last year',
    });
    await nudgePeriod(page, 'a', 'ArrowRight', 3);
    expect(await knob(page, 'a')).toMatchObject({ now: String(ax.ymin + 3), text: String(ax.ymin + 3) });
  });

  test('§10.3 arrows move a handle by one year', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await nudgePeriod(page, 'a', 'ArrowRight', 4);
    expect((await snapshot(page)).years).toMatchObject({ a: ax.ymin + 4, b: ax.ymax });
    await nudgePeriod(page, 'a', 'ArrowLeft');
    expect((await snapshot(page)).years.a).toBe(ax.ymin + 3);
    // Up/Down are the same axis as Right/Left for a horizontal slider.
    await nudgePeriod(page, 'a', 'ArrowUp', 2);
    expect((await snapshot(page)).years.a).toBe(ax.ymin + 5);
    await nudgePeriod(page, 'a', 'ArrowDown', 5);
    expect((await snapshot(page)).years.a).toBe(ax.ymin);
    await nudgePeriod(page, 'b', 'ArrowLeft', 6);
    expect((await snapshot(page)).years).toMatchObject({ a: ax.ymin, b: ax.ymax - 6 });
  });

  test('§10.3 PageUp and PageDown move five years', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await nudgePeriod(page, 'a', 'PageUp', 2);
    expect((await snapshot(page)).years.a).toBe(ax.ymin + 10);
    await nudgePeriod(page, 'a', 'PageDown');
    expect((await snapshot(page)).years.a).toBe(ax.ymin + 5);
    await nudgePeriod(page, 'b', 'PageDown', 3);
    expect((await snapshot(page)).years.b).toBe(ax.ymax - 15);
  });

  test('§10.3 Home and End jump to the bounds', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await setPeriod(page, 1980, 2000);
    await nudgePeriod(page, 'a', 'Home');
    expect((await snapshot(page)).years).toMatchObject({ a: ax.ymin, b: 2000 });
    await nudgePeriod(page, 'b', 'End');
    expect((await snapshot(page)).years).toMatchObject({ a: ax.ymin, b: ax.ymax });
  });

  test('§10.3 the handles clamp so a never passes b', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await setPeriod(page, 2000, 2000);
    await nudgePeriod(page, 'a', 'ArrowRight', 3);
    expect((await snapshot(page)).years).toMatchObject({ a: 2000, b: 2000 });
    await nudgePeriod(page, 'b', 'ArrowLeft', 3);
    expect((await snapshot(page)).years).toMatchObject({ a: 2000, b: 2000 });
    // End on the lower handle pins it to the upper one, not to the ceiling.
    await nudgePeriod(page, 'a', 'End');
    expect((await snapshot(page)).years).toMatchObject({ a: 2000, b: 2000 });
    await nudgePeriod(page, 'b', 'Home');
    expect((await snapshot(page)).years).toMatchObject({ a: 2000, b: 2000 });
    await nudgePeriod(page, 'b', 'End');
    expect((await snapshot(page)).years).toMatchObject({ a: 2000, b: ax.ymax });
  });

  test('§10.3 the handles stop at the floor and the ceiling', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await nudgePeriod(page, 'a', 'ArrowLeft', 2);
    await nudgePeriod(page, 'a', 'PageDown');
    await nudgePeriod(page, 'a', 'Home');
    expect((await snapshot(page)).years.a).toBe(ax.ymin);
    await nudgePeriod(page, 'b', 'ArrowRight', 2);
    await nudgePeriod(page, 'b', 'PageUp');
    await nudgePeriod(page, 'b', 'End');
    expect((await snapshot(page)).years.b).toBe(ax.ymax);
  });

  test('§10.3 a key the slider does not own is left alone', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await nudgePeriod(page, 'a', 'Enter');
    await nudgePeriod(page, 'a', 'Tab');
    expect((await snapshot(page)).years).toEqual({ a: ax.ymin, b: ax.ymax, undated: true });
  });

  test('§10.3 clicking the track outside the selection grabs the handle on that side', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const w = await trackWidth(page);
    // The case the spec calls out: a range collapsed to a single year has to be
    // reopenable in either direction. Note what this test can and cannot show:
    // the behaviour is pinned, but the *implementation*'s "outside the
    // selection, grab the handle on that side" branch cannot be told apart from
    // "grab the nearer handle, ties to a" by any click at all — below a, a is
    // always the nearer one, and above b, b is. Collapsing the branch to the
    // nearest-handle test leaves this whole file green, which is a property of
    // the arithmetic rather than a gap here.
    await setPeriod(page, 2000, 2000);
    await clickTrackAt(page, 1);
    expect((await snapshot(page)).years).toMatchObject({ a: ax.ymin, b: 2000 });
    await clickTrackAt(page, w - 1);
    expect((await snapshot(page)).years).toMatchObject({ a: ax.ymin, b: ax.ymax });
  });

  test('§10.3 a track click lands on the year under the pointer', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const w = await trackWidth(page);
    await setPeriod(page, 2010, ax.ymax);
    // Mid-track, comfortably below the selection: the lower handle follows.
    const target = 1985;
    await clickTrackAt(page, ((target - ax.ymin) / (ax.ymax - ax.ymin)) * w);
    expect((await snapshot(page)).years).toMatchObject({ a: target, b: ax.ymax });
    expect(await periodLabel(page)).toBe(`${target} – ${ax.ymax}`);
  });

  test('§10.3 dragging a handle follows the pointer', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    await setPeriod(page, 1960, 2000);
    const slider = await page.locator('#tf-slider').boundingBox();
    const b = await page.locator('#tf-b').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width - 1, slider.y + slider.height / 2);
    await page.mouse.up();
    expect((await snapshot(page)).years).toMatchObject({ a: 1960, b: ax.ymax });
  });

  // Everything else in this file reads the range out of state, the label or
  // aria-valuenow — which leaves the one thing a reader actually aims at
  // untested. Drawing the upper handle from `a` (a copy-pasted tfPct line) put
  // both handles on the same pixel and left all 57 tests green: the slider
  // reported 1990–2001 while showing 1990–1990, and a drag then started from
  // the wrong year.
  test('§10.3 the handles and the band are drawn at the years they report', async ({ page }) => {
    await openMap(page);
    const ax = axis(await payload(page));
    const span = ax.ymax - ax.ymin;
    // Eight decades over a track a couple of hundred pixels wide: a pixel is a
    // fraction of a year, so half a year is about as tight as a measured box
    // can honestly be read.
    const near = (frac, year, what) => {
      // A band collapsed to zero width has no box at all, which is a failure
      // of its own wherever a real span is selected.
      expect(frac, `${what}: nothing drawn`).not.toBeNull();
      const drawn = ax.ymin + frac * span;
      expect(Math.abs(drawn - year), `${what}: drawn at ${drawn.toFixed(2)}, reports ${year}`)
        .toBeLessThan(0.5);
    };

    let g = await drawnYears(page);
    near(g.a, ax.ymin, 'lower handle, full range');
    near(g.b, ax.ymax, 'upper handle, full range');
    near(g.selL, ax.ymin, 'band start, full range');
    near(g.selR, ax.ymax, 'band end, full range');

    await setPeriod(page, 1990, 2001);
    g = await drawnYears(page);
    near(g.a, 1990, 'lower handle');
    near(g.b, 2001, 'upper handle');
    near(g.selL, 1990, 'band start');
    near(g.selR, 2001, 'band end');
    expect(await periodLabel(page)).toBe('1990 – 2001');   // what it says it shows
    // Two handles, two places: eleven years is better than a tenth of the axis,
    // so they cannot both be sitting on the same pixel.
    expect(g.b - g.a).toBeGreaterThan(0.1);

    // A range collapsed to one year puts them on top of each other, which is
    // what the track-click rule in §10.3 exists to get a reader out of.
    await setPeriod(page, 2001, 2001);
    g = await drawnYears(page);
    near(g.a, 2001, 'lower handle, collapsed');
    near(g.b, 2001, 'upper handle, collapsed');
    expect(Math.abs(g.b - g.a)).toBeLessThan(0.01);
  });

  test('§10 the reset button returns the whole axis', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    await setPeriod(page, 1990, 2001);
    expect((await snapshot(page)).matchCount)
      .toBe(keptBySpec(pl.rows, ax, { a: 1990, b: 2001 }).length);
    await page.locator('#tf-undated').uncheck();
    expect((await snapshot(page)).matchCount)
      .toBe(keptBySpec(pl.rows, ax, { a: 1990, b: 2001, undated: false }).length);
    await page.click('#tf-reset');
    const s = await snapshot(page);
    expect(s.years).toEqual({ a: ax.ymin, b: ax.ymax, undated: true });
    expect(s.matchCount).toBe(pl.rows.length);
    expect(await periodLabel(page)).toBe(`${ax.ymin} – ${ax.ymax}`);
    expect(await undatedControl(page))
      .toMatchObject({ rowHidden: true, checked: true, n: pl.rows.filter(isVague).length });
    expect(await page.getAttribute('#tf-reset', 'title')).toBe('All years');
    expect(await page.getAttribute('#tf-reset', 'aria-label')).toBe('All years');
    await expectCountersReconcile(page, 'after reset');
  });

  test('§10 the ⓘ surfaces AS_OF on hover and, for touch, as a toast', async ({ page }) => {
    await openMap(page);
    const pl = await payload(page);
    const ax = axis(pl);
    const spelled = await page.evaluate((d) => new Intl.DateTimeFormat('en-GB',
      { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T00:00:00')), pl.asOf);
    const sentence = `Data current as of ${spelled} — the period slider stops at that year.`;
    expect(spelled).toContain(String(ax.asOfYear));
    expect(await page.getAttribute('#tf-asof', 'title')).toBe(sentence);
    expect(await page.getAttribute('#tf-asof', 'aria-label')).toBe(sentence);
    // Touch devices do not hover, so the same sentence has to be clickable.
    await expect(page.locator('#toast')).not.toHaveClass(/show/);
    await page.click('#tf-asof');
    await expect(page.locator('#toast')).toHaveClass(/show/);
    expect(await page.textContent('#toast')).toBe(sentence);
    // It says what it caps, and that is the year the axis ends on.
    expect(ax.asOfYear).toBe(ax.ymax);
  });

  test('§10 the ⓘ sentence is French in French', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    const pl = await payload(page);
    const spelled = await page.evaluate((d) => new Intl.DateTimeFormat('fr-FR',
      { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T00:00:00')), pl.asOf);
    await page.click('#tf-asof');
    expect(await page.textContent('#toast'))
      .toBe(`Données à jour au ${spelled} — le curseur de période s’arrête à cette année.`);
  });

  // §10's closing sentence has a negative half, and it is the half a
  // well-meaning addition breaks: the ⓘ is the map's *only* freshness
  // indicator. A second "data as of…" line — in the footer, on the welcome
  // screen — would almost certainly be built from something other than AS_OF
  // (a build date, a git timestamp), and the page would then carry two
  // freshness claims in two corners, drifting apart: the §9.1 failure mode one
  // section earlier, and the end of AS_OF as the page's single data-derived
  // notion of "now" — the reasoning that justifies YMAX. So this asserts the
  // absence, in both languages, and in the states where such a line would
  // plausibly live, with the toast up so its legitimate copy of the sentence
  // is accounted for rather than silently excluded from the walk.
  for (const [lang, locale] of [['en', 'en-GB'], ['fr', 'fr-FR']]) {
    test(`§10 the ⓘ is the only place the page states its freshness (${lang})`, async ({ page }) => {
      await openMap(page, { lang });
      const { asOf } = await payload(page);
      // Both spellings a freshness line could plausibly take: the raw ISO date
      // sitting in the payload, and the long form the ⓘ itself spells out.
      const spelled = await page.evaluate(([d, loc]) => new Intl.DateTimeFormat(loc,
        { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T00:00:00')), [asOf, locale]);
      const needles = [asOf, spelled];
      expect(spelled).not.toBe(asOf);

      // Opening state: the ⓘ's own title and aria-label, and nowhere else.
      expect(await statedOn(page, needles)).toEqual(['#tf-asof']);

      // Clicking it adds exactly one surface — the toast §10 asks it to raise.
      await page.click('#tf-asof');
      await expect(page.locator('#toast')).toHaveClass(/show/);
      expect(await statedOn(page, needles)).toEqual(['#tf-asof', '#toast']);

      // The welcome screen is the other place a "data as of…" line would go,
      // and renderWelcome() writes its rows only once it has been opened, so
      // the walk above cannot see them. Open it and walk again.
      await page.click('#help-btn');
      await expect(page.locator('#welcome')).toHaveClass(/open/);
      expect(await statedOn(page, needles)).toEqual(['#tf-asof', '#toast']);
    });
  }
});
