// §9.3 — the feed.
//
// The feed exists because a map shows *where* but not *what*: past a certain
// marker density the reader cannot read the names. So the column has two jobs,
// and both are testable. It must list exactly what is on screen, in an order a
// reader can scan; and its header must account for everything that is *not* on
// screen, with a working remedy attached to each part of the gap.
//
// The second job is where the bugs were. A header that says "+ 1 off the map"
// and scrolls to a section badged 11 is worse than no header at all, so the
// tests below check the promise and the landing together rather than each in
// isolation.
import { test, expect } from '@playwright/test';
import {
  openMap, snapshot, tiles, caption, settleCounts, setLayers,
  zoomBy, fitAll, expectCountersReconcile,
} from './_map.js';

// ---------------------------------------------------------------- local helpers

// The layer order the spec sorts by, spelled out here rather than read back out
// of the page, so a reordering of KIND_ORDER in the implementation fails a test
// instead of silently redefining what "sorted by layer" means.
const LAYER_ORDER = ['project', 'team', 'cluster', 'commons', 'framework'];

/** The corpus as the page actually loaded it.
 *
 *  `window.HAI_DATA` is the merged payload — hai-data.js plus whatever
 *  hai-data-additions.js folds into it by id before the interface boots — so
 *  every figure derived here moves with an upstream regeneration, which §3.2
 *  says it must: "Counts are a snapshot and move with every upstream
 *  regeneration; the shape of the table is what is normative, not the figures."
 *  A literal 438 in an assertion below would be pinning one afternoon's
 *  snapshot rather than testing the interface.
 *
 *  Read off the payload and nothing else — not `items`, not `TOTALS`, not
 *  `NOGEO`, and above all not `state`: an expectation taken from the page's own
 *  derived figures cannot catch the page deriving them wrongly. Two rules are
 *  reimplemented here rather than borrowed, both stated in the spec: an entity
 *  is placed when it has both coordinates (§3.1.4), and the layers are
 *  registered projects, commons, teams, frameworks — which is also the order
 *  renderNoGeo() lists the off-map ones in. */
function corpus(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const LAYERS = [['PROJECTS', 'project'], ['CLUSTERS', 'cluster'], ['COMMONS', 'commons'], ['TEAMS', 'team'], ['FRAMEWORKS', 'framework']];
    const all = [];
    for (const [key, kind] of LAYERS) {
      for (const d of D[key]) all.push({ id: d.id, kind, name: d.name, placed: d.lat != null && d.lon != null });
    }
    const tally = (list) => {
      const n = { project: 0, team: 0, cluster: 0, commons: 0, framework: 0 };
      for (const e of list) n[e.kind]++;
      return n;
    };
    const placed = all.filter((e) => e.placed), offMap = all.filter((e) => !e.placed);
    return {
      total: all.length,
      placed: placed.length,
      placedIds: placed.map((e) => e.id),
      offMap: offMap.length,
      offMapEntries: offMap,
      byKind: tally(all),
      placedByKind: tally(placed),
      offMapByKind: tally(offMap),
    };
  });
}

/** How many off-map entities a layer selection matches. Layers are the only
 *  filter these entities are subject to in the tests below, so the sum over the
 *  chosen layers is what §9.1 calls "matches the filters but has no marker". */
const offMapFor = (c, layers) => layers.reduce((n, k) => n + c.offMapByKind[k], 0);

/** The English agreement the badge's title carries, reimplemented here so a
 *  derived n can still be compared as one exact string rather than a regex. */
const nogeoTitle = (n, total) => `${n} of ${total} ${n === 1 ? 'matches' : 'match'} the current filters`;

/** One entry of the payload. The tests whose subject is a particular entity
 *  keep its id, and assert here what they are relying on about it — so a
 *  regeneration that moves the entity fails them loudly instead of quietly
 *  leaving them testing nothing. */
function payloadEntry(page, id) {
  return page.evaluate((x) => {
    const KIND = { PROJECTS: 'project', CLUSTERS: 'cluster', COMMONS: 'commons', TEAMS: 'team', FRAMEWORKS: 'framework' };
    for (const key of Object.keys(KIND)) {
      const d = window.HAI_DATA[key].find((e) => e.id === x);
      if (d) return { id: x, kind: KIND[key], name: d.name, placed: d.lat != null && d.lon != null };
    }
    return null;
  }, id);
}

/** The placed entity whose nearest neighbour is furthest away in the default
 *  view, and that gap in px. Nothing keeps a particular entity the loneliest
 *  one — kios-cyprus held the title at 87 px in the September snapshot, and one
 *  new entry beside it would end that — so the tests that need a single marker
 *  alone on screen ask the payload's own geometry instead of naming it.
 *  `items[].X/Y` is the projection of the payload's lat/lon, computed once at
 *  boot and nothing to do with the feed. */
function mostIsolated(page) {
  return page.evaluate(() => {
    const placed = items.filter((it) => it.geo);
    let best = null;
    for (const a of placed) {
      let gap = Infinity;
      for (const b of placed) {
        if (b === a) continue;
        const d = Math.hypot((a.X - b.X) * view.k, (a.Y - b.Y) * view.k);
        if (d < gap) gap = d;
      }
      if (!best || gap > best.gap) best = { id: a.id, gap };
    }
    return best;
  });
}

/** The column as the reader sees it: one entry per card, in document order. */
function feedRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#fd-list .fd-item')].map((el) => ({
      id: el.dataset.id,
      name: el.querySelector('.nm').textContent,
      meta: el.querySelector('.mt').textContent,
      open: el.classList.contains('open'),
      expanded: el.querySelector('.fd-row').getAttribute('aria-expanded'),
      hasCard: !!el.querySelector('.fd-card'),
    })));
}

/** The three parts of the header, read off the rendered DOM rather than state.
 *  A hidden part contributes 0 — it is making no promise the reader can see. */
function feedHeader(page) {
  return page.evaluate(() => {
    const num = (el) => (el.hidden ? 0 : Number((el.textContent.match(/\d+/) || [0])[0]));
    const scr = document.getElementById('fd-offscreen');
    const off = document.getElementById('fd-offmap');
    return {
      countText: document.getElementById('fd-count').textContent,
      count: Number(document.getElementById('fd-count').textContent),
      offScreen: { hidden: scr.hidden, n: num(scr), text: scr.textContent, title: scr.title, aria: scr.getAttribute('aria-label') },
      offMap: { hidden: off.hidden, n: num(off), text: off.textContent, title: off.title, aria: off.getAttribute('aria-label') },
    };
  });
}

/** The Off-the-map section the `+ N off the map` button scrolls to. */
function offMapSection(page) {
  return page.evaluate(() => ({
    hidden: document.getElementById('f-nogeo').hidden,
    badge: document.getElementById('nogeo-count').textContent,
    badgeTitle: document.getElementById('nogeo-count').title,
    rows: [...document.querySelectorAll('#nogeo-list .pin-item')].map((b) => ({
      id: b.dataset.id, out: b.classList.contains('out'),
    })),
  }));
}

/** §9.3's own restatement of invariant 12, in the header's rendered numbers:
 *  in view + off screen + off the map == matches the filters (+ the open card). */
async function expectHeaderReconciles(page, because) {
  const h = await feedHeader(page);
  const s = await snapshot(page);
  expect(h.count, `#fd-count is the in-view reading — ${because}`).toBe(s.inView);
  expect(h.offScreen.n + h.offMap.n, `the two hints name the whole gap — ${because}`)
    .toBe(s.offScreen + s.offMapMatch);
  expect(h.count + h.offScreen.n + h.offMap.n, `the header must reconcile — ${because}`)
    .toBe(s.matchCount + s.keptOpen);
}

/** Put exactly one marker on screen: centre the entity mostIsolated() picked
 *  and zoom ~20× past the default fit, which turns its default-view gap into
 *  more than a stage's width of empty space. */
async function isolateOne(page, id) {
  await page.evaluate((x) => {
    const it = byId[x];
    const [w, h] = stageSize();
    const k = k0 * 24;
    setView({ k, x: w / 2 - it.X * k, y: h / 2 - it.Y * k }, false);
  }, id);
  await settleCounts(page);
}

/** A bare tap: pointerdown and pointerup with no movement, which is what the
 *  map's own `pointerup` handler tests for (moved <= 4). Playwright's
 *  locator.click() refuses markers that overlap each other, and force:true
 *  would land the click on whatever is on top — the page resolves the hit with
 *  elementFromPoint, so the coordinate has to be the real one. */
async function tapAt(page, { x, y }) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

// =============================================================== the list

test.describe('§9.3 the feed lists what is in view', () => {
  test('§9.3 the feed lists exactly state.inView — no more, no less', async ({ page }) => {
    await openMap(page);
    const rows = await feedRows(page);
    const inView = await page.evaluate(() => [...state.inView]);
    expect(rows).toHaveLength(inView.length);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(inView));
    // …and state.inView is the right set to be listing, which the assertions
    // above cannot tell on their own: at the default fit every placed marker is
    // on screen, so the column is the whole corpus less the entities that have
    // no coordinates to be placed at (§3.1.4). Both figures come from the
    // payload, so a regeneration moves them together.
    const c = await corpus(page);
    expect(c.placed).toBe(c.total - c.offMap);
    expect(rows).toHaveLength(c.placed);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(c.placedIds));
  });

  test('§9.3 sorted by layer first, in the layers\' own order', async ({ page }) => {
    await openMap(page);
    const rows = await feedRows(page);
    const kinds = await page.evaluate((ids) => ids.map((id) => byId[id].kind), rows.map((r) => r.id));
    // Each layer is one contiguous run, and the runs come in layer order.
    const runs = kinds.filter((k, i) => i === 0 || kinds[i - 1] !== k);
    expect(runs).toEqual(LAYER_ORDER);
  });

  test('§9.3 sorted by name within a layer, locale-aware — not by code point', async ({ page }) => {
    await openMap(page);
    const r = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#fd-list .fd-item')].map((e) => e.dataset.id);
      const ORDER = { project: 0, team: 1, cluster: 2, commons: 3, framework: 4 };
      const set = ids.map((id) => byId[id]);
      const byLocale = [...set].sort((a, b) =>
        (ORDER[a.kind] - ORDER[b.kind]) || a.d.name.localeCompare(b.d.name, LANG)).map((it) => it.id);
      const byCodePoint = [...set].sort((a, b) =>
        (ORDER[a.kind] - ORDER[b.kind]) || (a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0)).map((it) => it.id);
      // The witness is derived from the payload rather than named: the placed
      // project whose name starts with a lowercase letter and sorts earliest
      // for a reader, together with the project a reader expects right after
      // it. A code-point sort puts every uppercase initial ahead of that pair,
      // so the two orders disagree about exactly these two rows.
      const projects = window.HAI_DATA.PROJECTS.filter((d) => d.lat != null && d.lon != null);
      const lower = projects
        .filter((d) => d.name[0] !== d.name[0].toUpperCase() && d.name[0] === d.name[0].toLowerCase())
        .sort((a, b) => a.name.localeCompare(b.name, LANG))[0];
      const after = projects
        .filter((d) => d.name.localeCompare(lower.name, LANG) > 0)
        .sort((a, b) => a.name.localeCompare(b.name, LANG))[0];
      return {
        ids,
        byLocale,
        sameAsCodePoint: ids.join() === byCodePoint.join(),
        lowerId: lower.id,
        afterId: after.id,
        lowerAt: ids.indexOf(lower.id),
        afterAt: ids.indexOf(after.id),
        codePointSaysLowerLast: lower.name > after.name,
        // Where that row belongs, counted off the payload: the projects come
        // first (§9.3's layer order), so its index is the number of placed
        // projects whose name a reader would file before it.
        lowerBelongsAt: projects.filter((d) => d.name.localeCompare(lower.name, LANG) < 0).length,
      };
    });
    expect(r.ids).toEqual(r.byLocale);
    // The load-bearing half: a plain `<` sort over the very same names gives a
    // different column, so "locale-aware" is a claim the data can falsify.
    expect(r.sameAsCodePoint).toBe(false);
    // …and the cheapest witness of the difference, named by the payload: a
    // lowercase-initial project sorts before its uppercase successor for a
    // reader, and after it for a byte.
    expect(r.codePointSaysLowerLast).toBe(true);
    expect(r.lowerAt).toBeLessThan(r.afterAt);
    expect(r.lowerAt).toBe(r.lowerBelongsAt);
  });

  test('§9.3 the column follows the viewport: zooming in drops the rows whose markers left', async ({ page }) => {
    await openMap(page);
    const before = (await feedRows(page)).map((r) => r.id);
    await zoomBy(page, 3);
    const after = (await feedRows(page)).map((r) => r.id);
    expect(after.length).toBeLessThan(before.length);
    // Zooming cannot invent an entity, only lose one.
    expect(after.every((id) => before.includes(id))).toBe(true);
    const s = await snapshot(page);
    expect(after).toHaveLength(s.inView);
  });

  test('§9.3 one row: a single marker on screen gives a list of one and a header of 1', async ({ page }) => {
    await openMap(page);
    const alone = await mostIsolated(page);
    await isolateOne(page, alone.id);
    const rows = await feedRows(page);
    expect(rows.map((r) => r.id)).toEqual([alone.id]);
    const h = await feedHeader(page);
    expect(h.countText).toBe('1');
    // Nothing is open, so the one row carries no card.
    expect(rows[0].open).toBe(false);
    expect(rows[0].hasCard).toBe(false);
    expect(rows[0].expanded).toBe('false');
  });

  test('§9.3 zero rows: the empty note replaces the list and both hints go quiet', async ({ page }) => {
    await openMap(page);
    await setLayers(page, []);
    await settleCounts(page);
    expect(await feedRows(page)).toHaveLength(0);
    await expect(page.locator('#fd-list .fd-empty'))
      .toHaveText('Nothing in view — zoom out or widen the filters.');
    const h = await feedHeader(page);
    expect(h.countText).toBe('0');
    // With every layer off nothing matches, so there is no gap to name: a hint
    // reading "+ 0 off screen" would be noise dressed as information.
    expect(h.offScreen.hidden).toBe(true);
    expect(h.offMap.hidden).toBe(true);
    await expectHeaderReconciles(page, 'every layer off');
  });

  test('§9.3 the row says name and place, and "possibly" instead when the start is a guess (§10)', async ({ page }) => {
    await openMap(page);
    // At the default period nothing is merely possible, so every row shows its
    // city and country.
    let check = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#fd-list .fd-item')];
      return {
        maybe: rows.filter((r) => r.querySelector('.mt').textContent === 'possibly').length,
        wrong: rows.filter((r) => {
          const it = byId[r.dataset.id];
          return r.querySelector('.mt').textContent !== [it.d.city, it.d.country].filter(Boolean).join(', ');
        }).map((r) => r.dataset.id),
      };
    });
    expect(check.maybe).toBe(0);
    expect(check.wrong).toEqual([]);

    // Narrow to a window that ends before 2020 and the vague entities become
    // "possible, not established" (§10.1) — the row says so where the place
    // would otherwise be, because the place is not the thing in doubt.
    await page.evaluate(() => setYears(1990, 2005));
    await settleCounts(page);
    check = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#fd-list .fd-item')];
      const maybe = rows.filter((r) => r.querySelector('.mt').textContent === 'possibly');
      // How many rows *should* read "possibly", counted off the payload with
      // §10.1's rule rather than taken from periodState(): an entity whose own
      // start is unknown — no year at all, or only its host's founding year —
      // is merely possible in a window stopping before PRESENT_FROM (2020),
      // unless that host year is later than the window, which makes it
      // impossible and drops it from view altogether.
      const softByRule = (() => {
        const yr = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
        const KEYS = ['PROJECTS', 'CLUSTERS', 'COMMONS', 'TEAMS', 'FRAMEWORKS'];
        let n = 0;
        for (const key of KEYS) for (const d of window.HAI_DATA[key]) {
          if (d.lat == null || d.lon == null) continue;          // no marker, never in view
          const tl = d.timeline || {}, y0 = yr(tl.start), y1 = yr(tl.end);
          if (!((y0 == null && y1 == null) || d.dateHost)) continue;
          if (y0 != null && y0 > 2005) continue;                 // impossible, not possible
          n++;
        }
        return n;
      })();
      return {
        n: rows.length,
        maybeN: maybe.length,
        softByRule,
        allSoft: maybe.every((r) => periodState(byId[r.dataset.id]) === 'soft'),
        softShownAsPlace: rows.filter((r) => r.querySelector('.mt').textContent !== 'possibly')
          .filter((r) => periodState(byId[r.dataset.id]) === 'soft').length,
      };
    });
    expect(check.softByRule, 'the window must actually make some entity merely possible').toBeGreaterThan(0);
    expect(check.maybeN).toBe(check.softByRule);
    expect(check.allSoft).toBe(true);          // nothing solid is labelled possible
    expect(check.softShownAsPlace).toBe(0);    // and nothing possible is left unlabelled
  });

  // The ampersand half of this test was once the whole of it, and it could not
  // fail: a text node containing "&" comes back out of innerHTML as "&amp;"
  // whether the interpolation escaped it or not, and no name in the corpus
  // carries a "<". Dropping `esc()` from the row's name changed nothing the
  // assertions could see. The second half feeds the renderer a name that can
  // tell the two apart — the key is ids + focus + language + pins, and a renamed
  // entity moves none of them, so clearing the key is what makes renderFeed()
  // redraw at all.
  test('invariant 9 the row\'s name is text, not markup — esc() is doing the work', async ({ page }) => {
    await openMap(page);
    const r = await page.evaluate(() => {
      const nm = document.querySelector('.fd-row[data-open="haiku"] .nm');
      return { text: nm.textContent, html: nm.innerHTML, name: byId['haiku'].d.name };
    });
    // The expected name is read out of the payload, not pinned as a literal —
    // and the ampersand in it is the whole reason this entity is the witness.
    const subject = await payloadEntry(page, 'haiku');
    expect(subject.name).toContain('&');
    expect(r.text).toBe(subject.name);
    expect(r.text).toBe(r.name);
    expect(r.html).toContain('&amp;');

    const injected = await page.evaluate(() => {
      const it = byId['haiku'], real = { name: it.d.name, city: it.d.city };
      it.d.name = 'Trust <b>me</b> & <i>Co</i>';
      it.d.city = 'Toulouse <img src=x>';
      feedKey = ''; renderFeed();
      const row = document.querySelector('.fd-row[data-open="haiku"]');
      const nm = row.querySelector('.nm'), mt = row.querySelector('.mt');
      const out = {
        text: nm.textContent, html: nm.innerHTML, children: nm.children.length,
        meta: mt.textContent, metaHtml: mt.innerHTML, metaChildren: mt.children.length,
        expectedMeta: [it.d.city, it.d.country].filter(Boolean).join(', '),
      };
      Object.assign(it.d, real); feedKey = ''; renderFeed();     // leave the page as found
      return out;
    });
    // A raw interpolation puts a real <b> element in the row; an escaped one
    // leaves the angle brackets where a reader can see them.
    expect(injected.children).toBe(0);
    expect(injected.text).toBe('Trust <b>me</b> & <i>Co</i>');
    expect(injected.html).toContain('&lt;b&gt;me&lt;/b&gt;');
    // The place column is interpolated the same way and needs the same guard —
    // a city is data from the generator too, and `<img src=x>` is the case where
    // "it is only ever a city name" stops being an argument.
    expect(injected.metaChildren).toBe(0);
    expect(injected.meta).toBe(injected.expectedMeta);
    expect(injected.metaHtml).toContain('&lt;img src=x&gt;');
  });

  test('§14 aria-expanded marks the one open row, and only that one', async ({ page }) => {
    await openMap(page);
    let states = await page.evaluate(() =>
      [...document.querySelectorAll('#fd-list .fd-row')].map((b) => b.getAttribute('aria-expanded')));
    expect(states.filter((s) => s === 'true')).toHaveLength(0);
    expect(states.every((s) => s === 'false')).toBe(true);

    await page.locator('.fd-row[data-open="haiku"]').click();
    states = await page.evaluate(() =>
      [...document.querySelectorAll('#fd-list .fd-row')].map((b) => b.getAttribute('aria-expanded')));
    expect(states.filter((s) => s === 'true')).toHaveLength(1);
    const rows = await feedRows(page);
    expect(rows.filter((r) => r.open).map((r) => r.id)).toEqual(['haiku']);
    expect(rows.filter((r) => r.hasCard).map((r) => r.id)).toEqual(['haiku']);
  });
});

// ====================================================== feed → map, map → feed

test.describe('§9.3 the two directions', () => {
  test('§9.3 feed → map: clicking a row expands its card without moving the view', async ({ page }) => {
    await openMap(page);
    const before = await page.evaluate(() => ({ k: view.k, x: view.x, y: view.y }));
    await page.locator('.fd-row[data-open="haiku"]').click();
    const after = await page.evaluate(() => ({ k: view.k, x: view.x, y: view.y, focusId: state.focusId }));
    // Not "about the same": openEntity(id,{fly:false}) must not touch the view
    // at all, or the map slides under the reader's cursor as they read the list.
    expect({ k: after.k, x: after.x, y: after.y }).toEqual(before);
    expect(after.focusId).toBe('haiku');
    const rows = await feedRows(page);
    expect(rows.find((r) => r.id === 'haiku').open).toBe(true);
  });

  test('§9.3 feed → map highlights the marker and dims what is not a neighbour (§7)', async ({ page }) => {
    await openMap(page);
    await page.locator('.fd-row[data-open="haiku"]').click();
    const r = await page.evaluate(() => {
      const focus = mkEls['haiku'];
      const nbr = [...nOf('haiku')];
      const strangers = [...state.inView].filter((id) => id !== 'haiku' && !nOf('haiku').has(id));
      return {
        focused: focus.classList.contains('focus'),
        focusDimmed: focus.classList.contains('dim'),
        nbrCount: nbr.length,
        strangersAllDim: strangers.every((id) => mkEls[id].classList.contains('dim')),
      };
    });
    expect(r.focused).toBe(true);
    expect(r.focusDimmed).toBe(false);
    expect(r.nbrCount).toBeGreaterThan(0);
    expect(r.strangersAllDim).toBe(true);
  });

  test('§9.3 clicking the open row collapses it, and still does not move the view', async ({ page }) => {
    await openMap(page);
    const row = page.locator('.fd-row[data-open="haiku"]');
    await row.click();
    const mid = await page.evaluate(() => ({ k: view.k, x: view.x, y: view.y }));
    await row.click();
    const after = await page.evaluate(() => ({
      k: view.k, x: view.x, y: view.y, focusId: state.focusId,
      open: document.querySelectorAll('#fd-list .fd-item.open').length,
      cards: document.querySelectorAll('#fd-list .fd-card').length,
      detailOpen: document.body.classList.contains('detail-open'),
    }));
    expect({ k: after.k, x: after.x, y: after.y }).toEqual(mid);
    expect(after.focusId).toBe(null);
    expect(after.open).toBe(0);
    expect(after.cards).toBe(0);
    expect(after.detailOpen).toBe(false);
  });

  test('§9.3 hovering a row haloes the matching marker; leaving the row clears it', async ({ page }) => {
    await openMap(page);
    await page.locator('.fd-row[data-open="haiku"]').hover();
    expect(await page.evaluate(() => ({ peekId, halo: mkEls['haiku'].classList.contains('peek') })))
      .toEqual({ peekId: 'haiku', halo: true });
    await page.locator('.fd-head').hover();
    expect(await page.evaluate(() => ({ peekId, halo: mkEls['haiku'].classList.contains('peek') })))
      .toEqual({ peekId: null, halo: false });
  });

  test('invariant 5 the feed\'s card and the floating panel\'s card are byte-identical', async ({ page }) => {
    await openMap(page);
    await page.locator('.fd-row[data-open="haiku"]').click();
    const inFeed = await page.evaluate(() => document.querySelector('#fd-list .fd-card').innerHTML);
    await page.click('#fd-close');
    const inPanel = await page.evaluate(() => document.getElementById('dt-body').innerHTML);
    // One cardHtml(), two hosts: the two surfaces cannot drift because there is
    // nothing to drift.
    expect(inFeed).toBe(inPanel);
    expect(inFeed.length).toBeGreaterThan(1000);
  });

  // Identical HTML is only half of "the same card". The markup carries no
  // handlers, so the column's copy is live only because renderFeed() calls
  // bindCard() on it — drop that one line and the feed renders a card whose Pin
  // button and whose relation links do nothing, with every other test here
  // still green.
  test('invariant 5 the card in the column is live, not a picture of a card', async ({ page }) => {
    await openMap(page);
    await page.locator('.fd-row[data-open="haiku"]').click();
    const pin = page.locator('#fd-list .fd-item.open .fd-card .dt-pin');
    await expect(pin).toHaveCount(1);
    await expect(pin).toHaveText('☆ Pin');
    await pin.click();
    await settleCounts(page);
    expect(await page.evaluate(() => [...state.pins])).toEqual(['haiku']);
    await expect(page.locator('#fd-list .fd-item.open .fd-card .dt-pin')).toHaveText('★ Pinned');

    // A relation link in the same card moves the focus to the neighbour, which
    // is the other half of what bindCard() wires up.
    const link = page.locator('#fd-list .fd-item.open .fd-card [data-open]').first();
    const nbr = await link.getAttribute('data-open');
    expect(nbr).not.toBe('haiku');
    await link.click();
    await settleCounts(page);
    expect(await page.evaluate(() => state.focusId)).toBe(nbr);
  });
});

// ============================================== marker → feed (needs no motion)

test.describe('§9.3 marker → feed', () => {
  // scrollIntoView and the fly are both animated unless the reader asks for
  // less; asking for less is what makes the assertions below land on a final
  // position instead of a frame of an animation (§14).
  test.use({ reducedMotion: 'reduce' });

  test('§9.3 marker → feed: selecting on the map expands that card in the column', async ({ page }) => {
    await openMap(page);
    // Whichever entity's nearest neighbour is furthest away at the default view
    // — the payload decides, see mostIsolated() — so a tap on its centre cannot
    // land on another marker. The gap is asserted, not assumed.
    const alone = await mostIsolated(page);
    expect(alone.gap, 'the loneliest marker needs room for a tap of its own').toBeGreaterThan(20);
    const pt = await page.evaluate((id) => {
      const it = byId[id];
      const r = document.getElementById('map').getBoundingClientRect();
      return { x: r.left + view.x + it.X * view.k, y: r.top + view.y + it.Y * view.k };
    }, alone.id);
    await tapAt(page, pt);
    await settleCounts(page);
    const rows = await feedRows(page);
    const open = rows.filter((r) => r.open);
    expect(await page.evaluate(() => state.focusId)).toBe(alone.id);
    expect(open.map((r) => r.id)).toEqual([alone.id]);
    expect(open[0].hasCard).toBe(true);
    expect(open[0].expanded).toBe('true');
  });

  test('§9.3 selecting on the map flies (§7) — the contrast the feed\'s fly:false buys', async ({ page }) => {
    await openMap(page);
    const alone = await mostIsolated(page);
    const pt = await page.evaluate((id) => {
      const it = byId[id];
      const r = document.getElementById('map').getBoundingClientRect();
      return { x: r.left + view.x + it.X * view.k, y: r.top + view.y + it.Y * view.k };
    }, alone.id);
    const beforeRatio = await page.evaluate(() => view.k / k0);
    expect(beforeRatio).toBeCloseTo(1.22, 5);
    await tapAt(page, pt);
    await settleCounts(page);
    // The map path is the one that moves: k0 × 3.2, the documented minimum.
    expect(await page.evaluate(() => view.k / k0)).toBeCloseTo(3.2, 5);
  });

  // SPEC-DEVIATION: §14 says `prefers-reduced-motion` "disables view animation
  // and feed auto-scroll". It disables the animation of both, but not the scroll
  // itself: renderFeed() passes `behavior:'auto'` rather than skipping
  // scrollIntoView, so a reader who asked for less motion still gets the column
  // jumping to centre — instantly, which is arguably the more startling of the
  // two. Charitably the sentence means the animation in both cases; either way
  // this test asserts the behaviour as it stands, which is that the scroll does
  // happen under reduced motion.
  test('§9.3 marker → feed scrolls the card to centre', async ({ page }) => {
    await openMap(page);
    // Half-way down a column of every placed entity: the card cannot be
    // visible by accident.
    const mid = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#fd-list .fd-item')].map((e) => e.dataset.id);
      return ids[Math.floor(ids.length / 2)];
    });
    await page.evaluate((id) => openEntity(id, { fly: false }), mid);
    const geo = await page.evaluate(() => {
      const list = document.getElementById('fd-list');
      const el = document.querySelector('#fd-list .fd-item.open');
      const lb = list.getBoundingClientRect(), eb = el.getBoundingClientRect();
      return {
        scrollTop: list.scrollTop,
        listCentre: lb.top + lb.height / 2,
        cardCentre: eb.top + eb.height / 2,
        visible: eb.bottom > lb.top && eb.top < lb.bottom,
      };
    });
    expect(geo.scrollTop).toBeGreaterThan(0);
    expect(geo.visible).toBe(true);
    expect(geo.cardCentre).toBeCloseTo(geo.listCentre, 0);
  });

  test('§9.3 the auto-scroll is keyed to the focus changing, not to every rewrite', async ({ page }) => {
    await openMap(page);
    const mid = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#fd-list .fd-item')].map((e) => e.dataset.id);
      return ids[Math.floor(ids.length / 2)];
    });
    await page.evaluate((id) => openEntity(id, { fly: false }), mid);
    const centred = await page.evaluate(() => document.getElementById('fd-list').scrollTop);
    expect(centred).toBeGreaterThan(0);
    // The reader then scrolls away from the card they opened, which is the state
    // the guard protects. Asserting from the centred position cannot fail —
    // re-centring an already-centred card lands on the same scrollTop — so the
    // test has to move first.
    const moved = await page.evaluate(() => {
      const l = document.getElementById('fd-list');
      l.scrollTop = Math.max(0, l.scrollTop - 900);
      return l.scrollTop;
    });
    expect(centred - moved).toBeGreaterThan(400);
    // Stamp the rows, so "the column was rebuilt" is observed rather than assumed.
    await page.evaluate(() => {
      document.querySelectorAll('#fd-list .fd-item').forEach((el) => { el.dataset.stamp = '1'; });
    });
    // Pinning some *other* row rewrites the list — the key carries the pins —
    // but leaves the focus alone, so `focus !== feedFocus` is false and
    // scrollIntoView is not called again. The reader keeps their place: the
    // column's own scrollTop survives the innerHTML assignment, and the card
    // does not jump back to centre under their eyes.
    const other = await page.evaluate((m) => [...state.inView].find((id) => id !== m), mid);
    await page.evaluate((id) => togglePin(id), other);
    await settleCounts(page);
    const after = await page.evaluate(() => ({
      scrollTop: document.getElementById('fd-list').scrollTop,
      stamps: document.querySelectorAll('#fd-list .fd-item[data-stamp]').length,
      open: document.querySelectorAll('#fd-list .fd-item.open').length,
    }));
    expect(after.stamps).toBe(0);              // the DOM write really did happen
    expect(after.open).toBe(1);
    expect(after.scrollTop).toBe(moved);       // and the scroll position did not
    expect(await page.evaluate(() => state.focusId)).toBe(mid);
  });
});

// ========================================================== the off-map entries

test.describe('§9.3 entities with no coordinates', () => {
  test('§9.3 a selected entity with no coordinates is prepended to the list', async ({ page }) => {
    await openMap(page, { hash: '#e=iso-9241-210' });
    await settleCounts(page);
    const rows = await feedRows(page);
    expect(rows[0].id).toBe('iso-9241-210');
    expect(rows[0].open).toBe(true);
    expect(rows[0].hasCard).toBe(true);
    // Why this entity: the payload says it is a framework with no coordinates —
    // one of §3.1.4's marker-less international standards. Were it merely
    // sorted it would land last, not first. The property is asserted rather
    // than assumed, so a regeneration that gives it a position fails the test
    // instead of voiding it.
    expect(await payloadEntry(page, 'iso-9241-210')).toMatchObject({ kind: 'framework', placed: false });
    expect(rows[rows.length - 1].id).not.toBe('iso-9241-210');
    // No coordinates means no city either: the meta column is simply empty.
    expect(rows[0].meta).toBe('');
  });

  test('§9.3 the prepended row is the one row the header does not count', async ({ page }) => {
    await openMap(page, { hash: '#e=iso-9241-210' });
    await settleCounts(page);
    const rows = await feedRows(page);
    const h = await feedHeader(page);
    const s = await snapshot(page);
    // "In view" means "has a marker inside the stage" (§9.1). An off-map entity
    // has no marker, so it can be listed without being counted — and the count
    // stays the number the tiles sum to.
    expect(h.count).toBe(s.inView);
    expect(rows).toHaveLength(s.inView + 1);
    // Which in-view reading that is, derived from the payload rather than taken
    // from state: every placed entity, with the one prepended off-map card on
    // top of it.
    const c = await corpus(page);
    expect(h.countText).toBe(String(c.placed));
    expect(rows).toHaveLength(c.placed + 1);
    await expectHeaderReconciles(page, 'an off-map card open');
  });

  test('§9.3 an entity already in view is listed once, at its sorted place', async ({ page }) => {
    await openMap(page);
    // A row from the middle of the column, wherever the middle happens to fall.
    const id = await page.evaluate(() => [...state.inView][Math.floor(state.inView.size / 2)]);
    await page.evaluate((x) => openEntity(x, { fly: false }), id);
    const ids = (await feedRows(page)).map((r) => r.id);
    // The prepend is for the unreachable case only; duplicating a row that is
    // already there would make the column disagree with its own count.
    expect(ids.filter((x) => x === id)).toHaveLength(1);
    expect(ids[0]).not.toBe(id);
    expect(ids).toHaveLength(await page.evaluate(() => state.inView.size));
  });

  test('invariant 3 no marker, but a feed row and a full card all the same', async ({ page }) => {
    await openMap(page, { hash: '#e=iso-9241-210' });
    await settleCounts(page);
    expect(await page.evaluate(() => !!mkEls['iso-9241-210'])).toBe(false);
    const subject = await payloadEntry(page, 'iso-9241-210');
    expect(subject.placed).toBe(false);
    const card = await page.evaluate(() =>
      document.querySelector('#fd-list .fd-item.open .fd-card').textContent);
    expect(card).toContain(subject.name);
    expect(card.length).toBeGreaterThan(200);
  });

  test('§9.3 a dimmed off-map row is still clickable, and lands in the feed', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await setLayers(page, ['commons']);
    await settleCounts(page);
    // Frameworks are off, so every framework row in the section is dimmed —
    // which one of them the payload offers is immaterial, so it is not named.
    const dimmed = c.offMapEntries.find((e) => e.kind === 'framework');
    const row = page.locator(`#nogeo-list .pin-item[data-id="${dimmed.id}"]`);
    await expect(row).toHaveClass(/\bout\b/);
    await row.click();
    await settleCounts(page);
    // "The entities that do not match stay listed and stay clickable, because
    // reaching them is what the section is for."
    expect(await page.evaluate(() => state.focusId)).toBe(dimmed.id);
    const rows = await feedRows(page);
    expect(rows[0].id).toBe(dimmed.id);
    expect(rows[0].open).toBe(true);
  });
});

// ================================================================= the header

test.describe('§9.3 the header and its remedies', () => {
  test('§9.3 the header is a count and two hints, in reading order', async ({ page }) => {
    await openMap(page);
    const parts = await page.evaluate(() =>
      [...document.querySelector('.fd-title').children].map((el) => ({ id: el.id, tag: el.tagName, type: el.getAttribute('type') })));
    expect(parts.map((p) => p.id)).toEqual(['', 'fd-count', 'fd-offscreen', 'fd-offmap']);
    await expect(page.locator('.fd-title span[data-i18n="feedTitle"]')).toHaveText('In view');
    // Each gap has a remedy, so each is a button rather than a caption.
    expect(parts[2]).toMatchObject({ tag: 'BUTTON', type: 'button' });
    expect(parts[3]).toMatchObject({ tag: 'BUTTON', type: 'button' });
  });

  test('§9.3 at the default fit the header reads the placed count, then the off-map gap', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    const h = await feedHeader(page);
    expect(h.countText).toBe(String(c.placed));
    // Every placed marker is on screen at the fit, so there is no off-screen
    // term — and naming only the off-map part is safe *here*, which is exactly
    // why the earlier version's omission survived so long.
    expect(h.offScreen.hidden).toBe(true);
    expect(h.offMap.hidden).toBe(false);
    expect(h.offMap.text).toBe(`+ ${c.offMap} off the map`);
    await expectHeaderReconciles(page, 'default fit');
  });

  test('§9.3 zoomed in, the off-screen term appears and the sum still holds', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await zoomBy(page, 3);
    const h = await feedHeader(page);
    const s = await snapshot(page);
    expect(h.offScreen.hidden).toBe(false);
    expect(h.offScreen.text).toBe(`+ ${s.offScreen} off screen`);
    expect(h.offMap.text).toBe(`+ ${c.offMap} off the map`);
    // The reader who zooms in is the one the caption was failing: the in-view
    // count drops well below the placed total while the off-map term does not
    // move at all, and without the off-screen term that is an arithmetic
    // problem with a missing term. The three must still add up to the corpus.
    expect(h.count).toBeLessThan(c.placed);
    expect(h.count + h.offScreen.n + h.offMap.n).toBe(c.total);
    await expectHeaderReconciles(page, 'zoomed in 3×');
  });

  test('§9.3 #fd-count is the in-view reading, the same one the tiles sum to (§9.1)', async ({ page }) => {
    await openMap(page);
    for (const factor of [1, 2, 4]) {
      if (factor !== 1) await zoomBy(page, factor);
      const h = await feedHeader(page);
      const t = await tiles(page);
      expect(h.count, `tiles must sum to #fd-count at ${factor}×`)
        .toBe(t.reduce((a, x) => a + x.count, 0));
      await expectCountersReconcile(page, `${factor}× with the feed open`);
    }
  });

  test('§9.3 the header reconciles in every filter state, not just the default', async ({ page }) => {
    await openMap(page);
    await expectHeaderReconciles(page, 'default');
    await setLayers(page, ['commons']);
    await settleCounts(page);
    await expectHeaderReconciles(page, 'commons only');
    await page.evaluate(() => setYears(2015, 2020));
    await settleCounts(page);
    await expectHeaderReconciles(page, 'commons only, 2015–2020');
    await setLayers(page, ['project', 'team', 'cluster', 'commons', 'framework']);
    await settleCounts(page);
    await zoomBy(page, 5);
    await expectHeaderReconciles(page, 'all layers, 2015–2020, zoomed 5×');
  });

  test('§9.3 the header reconciles in My map mode too', async ({ page }) => {
    await openMap(page, { hash: '#pins=haiku,ai4realnet&my=1' });
    await settleCounts(page);
    expect(await page.evaluate(() => state.myMap)).toBe(true);
    const rows = await feedRows(page);
    const s = await snapshot(page);
    expect(rows).toHaveLength(s.inView);
    await expectHeaderReconciles(page, 'My map');
    // §9.2: the caption drops the word "filters" in this mode, because the pins
    // replaced them. The feed's own count is unaffected — it is still in view.
    expect(await caption(page)).toContain('on your map');
  });

  test('§9.3 a hint with nothing to report is hidden, not rendered as zero', async ({ page }) => {
    await openMap(page);
    await zoomBy(page, 3);
    await expect(page.locator('#fd-offscreen')).toBeVisible();
    await fitAll(page);
    await expect(page.locator('#fd-offscreen')).toBeHidden();
    // A layer with no off-map population at all is what leaves the off-map
    // hint with nothing to report; the payload says which layer that is.
    const c = await corpus(page);
    const fullyPlaced = LAYER_ORDER.find((k) => c.offMapByKind[k] === 0);
    expect(fullyPlaced, 'some layer must be fully placed for this case to exist').toBeTruthy();
    await setLayers(page, [fullyPlaced]);
    await settleCounts(page);
    expect(await page.evaluate(() => state.offMapMatch)).toBe(0);
    await expect(page.locator('#fd-offmap')).toBeHidden();
  });

  // The count and the two hints are written *before* renderFeed() consults its
  // key, and they have to be: the key tracks the row set, and the gap can move
  // while the rows do not. Hoisting the key check to the top of the function —
  // the obvious "skip the work" edit, and one no other test here notices —
  // leaves all three figures showing the previous filter state.
  //
  // One marker on screen, then Frameworks off: the column still lists exactly
  // that one entity, so nothing is rewritten, while both hints move — the
  // off-map term loses every off-map framework, and the off-screen term loses
  // the placed frameworks as well.
  test('§9.3 the header\'s numbers are not behind the render key', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    const alone = await mostIsolated(page);
    // The entity left on screen must survive the filter change, or the premise
    // of the test ("nothing is rewritten") goes with it.
    expect((await payloadEntry(page, alone.id)).kind,
      'the loneliest marker must not be in the layer this test switches off').not.toBe('framework');
    await isolateOne(page, alone.id);
    const before = await feedHeader(page);
    expect(before.countText).toBe('1');
    expect(before.offScreen.n).toBe(c.placed - 1);
    expect(before.offMap.n).toBe(c.offMap);
    await page.evaluate(() => { document.querySelector('#fd-list .fd-item').dataset.stamp = '1'; });

    const kept = LAYER_ORDER.filter((k) => k !== 'framework');
    await setLayers(page, kept);
    await settleCounts(page);

    expect((await feedRows(page)).map((r) => r.id)).toEqual([alone.id]);
    // The DOM write was skipped — this is the case the key exists for…
    expect(await page.evaluate(() =>
      document.querySelectorAll('#fd-list .fd-item[data-stamp]').length)).toBe(1);
    // …and the header moved anyway. Every figure below is the corpus narrowed
    // by the one filter this test touched: the three layers still on, less the
    // single marker that stayed on screen.
    const matching = c.total - c.byKind.framework;
    const offMap = offMapFor(c, kept);
    const after = await feedHeader(page);
    expect(after.countText).toBe('1');
    expect(after.offMap.text).toBe(`+ ${offMap} off the map`);
    expect(after.offScreen.text).toBe(`+ ${matching - offMap - 1} off screen`);
    expect(1 + after.offScreen.n + after.offMap.n).toBe(matching);
    // Not a deviation, just worth naming while the string is compared whole:
    // unlike its French counterpart the English title carries no verb
    // agreement, so with a single off-map entity it reads "1 more match the
    // filters". The spec only ever quotes the plural.
    expect(after.offMap.title)
      .toBe(`${offMap} more match the filters but have no coordinates, so no marker — see “Off the map” in the left panel.`);
    await expectHeaderReconciles(page, 'one marker on screen, Frameworks off');
  });

  test('§9.3 both hints carry their remedy in prose, on the tooltip and the accessible name', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await zoomBy(page, 3);
    const h = await feedHeader(page);
    const s = await snapshot(page);
    expect(h.offScreen.title)
      .toBe(`${s.offScreen} more match the filters but sit outside the current view — zoom out to bring them in.`);
    expect(h.offScreen.aria).toBe(h.offScreen.title);
    expect(h.offMap.title)
      .toBe(`${c.offMap} more match the filters but have no coordinates, so no marker — see “Off the map” in the left panel.`);
    expect(h.offMap.aria).toBe(h.offMap.title);
  });

  test('§9.3 in French the hints agree with n = 1', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    // The singular is the point, so the filter state is derived for it: the
    // layer whose off-map population is exactly one entity.
    const c = await corpus(page);
    const solo = LAYER_ORDER.find((k) => c.offMapByKind[k] === 1);
    expect(solo, 'some layer must have exactly one off-map entity for n = 1 to be reachable').toBeTruthy();
    await setLayers(page, [solo]);
    await settleCounts(page);
    expect(await page.evaluate(() => state.offMapMatch)).toBe(1);
    const h = await feedHeader(page);
    expect(h.offMap.text).toBe('+ 1 hors carte');
    expect(h.offMap.title).toBe(
      '1 de plus correspond aux filtres mais n’a pas de coordonnées, donc pas de marqueur — voir « Hors carte » dans le panneau de gauche.');
    await expect(page.locator('.fd-title span[data-i18n="feedTitle"]')).toHaveText('Dans la vue');
    // The plural forms of the same two strings, so a regression that drops the
    // agreement in either direction fails here rather than in a screenshot.
    expect(await page.evaluate(() => [I18N.fr.feedOffMapTitle(7), I18N.fr.feedOffScreenTitle(1), I18N.fr.feedOffScreenTitle(7)]))
      .toEqual([
        '7 de plus correspondent aux filtres mais n’ont pas de coordonnées, donc pas de marqueur — voir « Hors carte » dans le panneau de gauche.',
        '1 de plus correspond aux filtres mais se trouve hors de la vue actuelle — dézoomez pour les afficher.',
        '7 de plus correspondent aux filtres mais se trouvent hors de la vue actuelle — dézoomez pour les afficher.',
      ]);
  });

  test('invariant 8 every string the feed shows exists in both languages', async ({ page }) => {
    await openMap(page);
    const missing = await page.evaluate(() => {
      const keys = ['feedPill', 'feedTitle', 'feedHide', 'feedEmpty', 'feedOffScreen',
        'feedOffScreenTitle', 'feedOffMap', 'feedOffMapTitle', 'timeMaybe', 'nogeoTitle', 'nogeoCount'];
      const bad = [];
      for (const k of keys) for (const lg of ['en', 'fr']) {
        const v = I18N[lg][k];
        if (v === undefined) { bad.push(`${lg}.${k} missing`); continue; }
        const s = typeof v === 'function' ? v(3, 11) : v;
        if (typeof s !== 'string' || !s.length) bad.push(`${lg}.${k} empty`);
      }
      return bad;
    });
    expect(missing).toEqual([]);
  });

  // SPEC-DEVIATION: invariant 8 ("every user-visible string goes through t() and
  // exists in both languages") does not reach the column's own accessible name.
  // `#feed`'s aria-label and data-screen-label are hardcoded French literals and
  // carry no data-i18n, so applyLang() never touches them: an English reader on
  // a screen reader is announced into "Fiches dans la vue". The close button next
  // to it *is* translated (applyLang sets #fd-close's title and aria-label), which
  // is what makes the omission look like an oversight rather than a choice.
  // Asserting the behaviour as it stands.
  test('§9.3 the column\'s accessible name stays French in English (invariant 8 gap)', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const labels = await page.evaluate(() => {
      const f = document.getElementById('feed');
      return {
        aria: f.getAttribute('aria-label'),
        screen: f.dataset.screenLabel,
        closeAria: document.getElementById('fd-close').getAttribute('aria-label'),
        lang: document.documentElement.lang,
      };
    });
    expect(labels.lang).toBe('en');
    expect(labels.aria).toBe('Fiches dans la vue');
    expect(labels.screen).toBe('Fil des fiches');
    expect(labels.closeAria).toBe('Hide feed');
  });
});

test.describe('§9.3 the remedies land', () => {
  // fitView and scrollIntoView are animated for a reader who has not asked for
  // less; asking for less lets the assertions see where they ended up.
  test.use({ reducedMotion: 'reduce' });

  test('§9.3 #fd-offscreen fits the view, so the off-screen markers come in', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await zoomBy(page, 4);
    const before = await feedHeader(page);
    expect(before.offScreen.n).toBeGreaterThan(0);
    await page.click('#fd-offscreen');
    await settleCounts(page);
    const s = await snapshot(page);
    // The remedy has to actually close the gap it names, not merely zoom a bit:
    // every placed entity is back on screen, and the view is at the documented
    // fit (k0 × 1.22, a constant of fitView() rather than of the data).
    expect(s.offScreen).toBe(0);
    expect(s.inView).toBe(c.placed);
    expect(await page.evaluate(() => view.k / k0)).toBeCloseTo(1.22, 5);
    const after = await feedHeader(page);
    expect(after.offScreen.hidden).toBe(true);
    expect(after.countText).toBe(String(c.placed));
    expect((await feedRows(page))).toHaveLength(c.placed);
  });

  test('§9.3 #fd-offmap reveals the sidebar and scrolls Off the map into view', async ({ page }) => {
    // 1600 px wide so the collapse button is not sitting under the top-right
    // cluster, which is a separate (§5) matter and not what this test is about.
    await page.setViewportSize({ width: 1600, height: 900 });
    await openMap(page);
    await page.click('#sb-hide');
    await settleCounts(page);
    expect(await page.evaluate(() => document.body.classList.contains('sb-hidden'))).toBe(true);

    await page.click('#fd-offmap');
    await settleCounts(page);
    const r = await page.evaluate(() => {
      const sec = document.getElementById('f-nogeo');
      const body = document.querySelector('.sb-body');
      const s = sec.getBoundingClientRect(), b = body.getBoundingClientRect();
      return {
        sbHidden: document.body.classList.contains('sb-hidden'),
        display: getComputedStyle(document.getElementById('sidebar')).display,
        scrollTop: body.scrollTop,
        inside: s.top >= b.top - 1 && s.bottom <= b.bottom + 1,
        panelOpen: document.body.classList.contains('panel-open'),
      };
    });
    expect(r.sbHidden).toBe(false);
    expect(r.display).not.toBe('none');
    expect(r.scrollTop).toBeGreaterThan(0);       // the section was not already there
    expect(r.inside).toBe(true);
    expect(r.panelOpen).toBe(false);              // the drawer is the narrow-screen path
  });

  // SPEC-DEVIATION: §5 turns both the sidebar and the feed into overlay drawers
  // below 840 px, and §9.3 insists each header hint carries "its own remedy" —
  // #fd-offmap "reveals the sidebar and scrolls the Off the map section into
  // view". On a phone it reveals the sidebar *and leaves the column it was
  // pressed from open*, and the two drawers do not fit side by side: at 420 px
  // the sidebar takes x 0–330 (min(88vw,330)) and the feed x 80–420
  // (min(88vw,340) off the right edge), both at z-index 90, with #feed later in
  // #app — so the feed wins all 250 px of the overlap. The section is scrolled
  // into place *behind* the column: its rows are rendered, badged and counted,
  // and a 293 px row is reachable only in the 62 px sliver left of the feed's
  // edge, never on its name and never at its centre. The remedy lands on
  // nothing a thumb can hit.
  //
  // It is not a corner case either. #fd-offmap lives inside #feed, and below
  // 840 px the column boots closed, so every press of the button on a phone is
  // a press from inside the open column — the collision is the whole of the
  // narrow path, not one route through it. The fix would be one more call in
  // the handler (close the column, or make the drawers mutually exclusive);
  // until then, asserting the behaviour as it stands.
  test('§9.3 on a narrow screen #fd-offmap opens the sidebar drawer instead', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 820 });
    await openMap(page);
    const c = await corpus(page);
    // The button is part of the feed's own header, so there is no way to press
    // it with the column shut — which is what makes the overlap below universal.
    expect(await page.evaluate(() =>
      !!document.getElementById('fd-offmap').closest('#feed'))).toBe(true);
    await page.click('#feed-pill');               // below 840 px the feed starts closed
    await settleCounts(page);
    await page.click('#fd-offmap');
    await settleCounts(page);
    const r = await page.evaluate(() => ({
      panelOpen: document.body.classList.contains('panel-open'),
      sbHidden: document.body.classList.contains('sb-hidden'),
      secVisible: !document.getElementById('f-nogeo').hidden,
    }));
    expect(r).toEqual({ panelOpen: true, sbHidden: false, secVisible: true });

    // The drawer slides in over .25s and that CSS transition is not guarded by
    // prefers-reduced-motion, so geometry read too early is a frame of an
    // animation rather than where the drawer came to rest.
    await page.waitForFunction(() =>
      Math.abs(document.getElementById('sidebar').getBoundingClientRect().left) < 0.5);

    const geo = await page.evaluate(() => {
      const z = (id) => getComputedStyle(document.getElementById(id)).zIndex;
      const sb = document.getElementById('sidebar').getBoundingClientRect();
      const fd = document.getElementById('feed').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#nogeo-list [data-open]')];
      const row = rows[0], rb = row.getBoundingClientRect();
      const nb = row.querySelector('.nm').getBoundingClientRect();
      // Who owns a point, as the browser resolves a tap there. A point outside
      // the viewport belongs to nobody, which is worth reporting rather than
      // throwing: it would mean the scroll never landed.
      const at = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? { feed: !!el.closest('#feed'), sidebar: !!el.closest('#sidebar') }
          : { feed: false, sidebar: false, offViewport: true };
      };
      const mid = (b) => at(b.left + b.width / 2, b.top + b.height / 2);
      return {
        // The column the remedy was pressed from is still there.
        feedOpen: state.feed,
        feedDisplay: getComputedStyle(document.getElementById('feed')).display,
        sb: { left: sb.left, right: sb.right, z: z('sidebar') },
        fd: { left: fd.left, right: fd.right, z: z('feed') },
        // Same stacking context, same z-index: document order decides, and the
        // feed is the later sibling.
        feedIsLaterSibling:
          document.getElementById('sidebar').compareDocumentPosition(document.getElementById('feed'))
            === Node.DOCUMENT_POSITION_FOLLOWING,
        // The scroll really did land — the section is on screen, it is simply
        // not the thing on top of itself.
        rowId: row.dataset.id,
        rowOnScreen: rb.top >= 0 && rb.bottom <= innerHeight,
        row: { left: rb.left, right: rb.right },
        atRowCentre: mid(rb),
        atRowName: mid(nb),
        atRowLeftEdge: at(rb.left + 2, rb.top + rb.height / 2),
        // Not one unlucky row: every row in the section, and the badge whose
        // number the button quoted.
        rowsCoveredAtCentre: rows.filter((b) => mid(b.getBoundingClientRect()).feed).length,
        rowCount: rows.length,
        atBadge: mid(document.getElementById('nogeo-count').getBoundingClientRect()),
      };
    });

    expect(geo.feedOpen).toBe(true);
    expect(geo.feedDisplay).toBe('flex');
    expect(geo.sb).toEqual({ left: 0, right: 330, z: '90' });
    expect(geo.fd).toEqual({ left: 80, right: 420, z: '90' });
    expect(geo.feedIsLaterSibling).toBe(true);
    expect(geo.sb.right).toBeGreaterThan(geo.fd.left);   // 250 px of overlap

    // renderNoGeo() lists the off-map entities in registration order, so the
    // row the scroll lands on is the first one the payload offers — the single
    // commons with no coordinates, ahead of the ten standards.
    expect(geo.rowId).toBe(c.offMapEntries[0].id);
    expect(c.offMapEntries[0].kind).toBe('commons');
    expect(geo.rowOnScreen).toBe(true);
    // The row starts left of the feed's edge and ends well inside it, so the
    // sliver is real but the useful part of the row is not.
    expect(geo.row.left).toBeLessThan(geo.fd.left);
    expect(geo.row.right).toBeGreaterThan(geo.fd.left);
    expect(geo.atRowLeftEdge).toEqual({ feed: false, sidebar: true });
    expect(geo.atRowCentre).toEqual({ feed: true, sidebar: false });
    expect(geo.atRowName).toEqual({ feed: true, sidebar: false });
    expect(geo.atBadge).toEqual({ feed: true, sidebar: false });
    expect(geo.rowCount).toBe(c.offMap);
    expect(geo.rowsCoveredAtCentre).toBe(c.offMap);

    // And the hit test is not a DOM curiosity: a real tap on the row the button
    // just scrolled to is refused, because something else is in front of it.
    await expect(page.locator('#nogeo-list [data-open]').first().click({ timeout: 1500 }))
      .rejects.toThrow(/intercepts pointer events/);
  });

  test('§9.3 the button\'s number is the badge of the section it scrolls to', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    // The bug this replaces: the button said "+ 1 off the map" and the section
    // it scrolled to was badged with the count of every off-map entity, filters
    // ignored — and had that many rows to match.
    //
    // One case per layer plus the all-on case, with the expected figure summed
    // off the payload rather than written down: layers are the only filter
    // these entities are subject to here.
    const cases = [[...LAYER_ORDER], ...LAYER_ORDER.map((k) => [k])];
    for (const layers of cases) {
      const n = offMapFor(c, layers);
      await setLayers(page, layers);
      await settleCounts(page);
      const h = await feedHeader(page);
      const sec = await offMapSection(page);
      expect(h.offMap.n, `button vs ${layers.join('+')}`).toBe(n);
      expect(Number(sec.badge), `badge vs ${layers.join('+')}`).toBe(n);
      expect(sec.rows.filter((r) => !r.out), `undimmed rows vs ${layers.join('+')}`).toHaveLength(n);
      // The section keeps every off-map entity listed whatever the filters say.
      expect(sec.rows, `listed rows vs ${layers.join('+')}`).toHaveLength(c.offMap);
      expect(sec.hidden).toBe(false);
    }
    // The cases are only worth running if they are not all the same number —
    // at least one layer with an off-map population and one without.
    const spread = LAYER_ORDER.map((k) => c.offMapByKind[k]);
    expect(Math.max(...spread)).toBeGreaterThan(Math.min(...spread));
  });

  test('§9.3 the non-matching off-map rows are dimmed, and exactly those', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await setLayers(page, ['commons']);
    await settleCounts(page);
    const sec = await offMapSection(page);
    // With only Commons on, the off-map commons are exactly the undimmed rows —
    // which ones those are comes from the payload, in its own order.
    const commons = c.offMapEntries.filter((e) => e.kind === 'commons').map((e) => e.id);
    expect(sec.rows.filter((r) => !r.out).map((r) => r.id)).toEqual(commons);
    expect(sec.rows.filter((r) => r.out)).toHaveLength(c.offMap - commons.length);
    // Derived from the filter state rather than from the classes themselves:
    // `.out` must be the complement of "matches the filters".
    const mismatch = await page.evaluate(() =>
      [...document.querySelectorAll('#nogeo-list .pin-item')]
        .filter((b) => b.classList.contains('out') === state.inFilter.has(b.dataset.id))
        .map((b) => b.dataset.id));
    expect(mismatch).toEqual([]);
  });

  test('§9.3 the badge names the corpus total it narrowed from, and agrees with n = 1', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    // Nothing has narrowed: no title, because N of N needs no explaining and a
    // corpus constant sitting unlabelled next to live numbers is the §9.1 bug.
    expect((await offMapSection(page)).badgeTitle).toBe('');
    // Both halves of the English agreement, on filter states the payload picks:
    // a layer holding exactly one off-map entity, and one holding several.
    const solo = LAYER_ORDER.find((k) => c.offMapByKind[k] === 1);
    const many = LAYER_ORDER.find((k) => c.offMapByKind[k] > 1);
    expect({ solo: !!solo, many: !!many },
      'the agreement needs one layer with a single off-map entity and one with more').toEqual({ solo: true, many: true });
    await setLayers(page, [solo]);
    await settleCounts(page);
    expect((await offMapSection(page)).badgeTitle).toBe(nogeoTitle(1, c.offMap));
    await setLayers(page, [many]);
    await settleCounts(page);
    expect((await offMapSection(page)).badgeTitle).toBe(nogeoTitle(c.offMapByKind[many], c.offMap));
  });

  test('§9.3 with every layer off the badge reads 0 and every row is dimmed', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await setLayers(page, []);
    await settleCounts(page);
    const sec = await offMapSection(page);
    expect(sec.badge).toBe('0');
    expect(sec.rows.filter((r) => r.out)).toHaveLength(c.offMap);
    // The section stays on screen: it is the only route to these cards, and
    // hiding it would strand them.
    expect(sec.hidden).toBe(false);
    expect(await feedHeader(page)).toMatchObject({ countText: '0' });
  });

  // SPEC-DEVIATION: "the badge is now state.offMapMatch, the same figure the
  // button quotes… badge and list then agree by inspection rather than by
  // arithmetic the reader has to do" (§9.3), and §9.1's table files the badge
  // under "matches the filters". Both fail once an off-map card is open that the
  // filters exclude. updateInView() tallies offMapMatch over `vis`, which §6's
  // focus override has already widened by that card, while updateNoGeo() dims
  // rows against `inFilter`, which is recorded *before* the override. So the
  // badge counts the open card and the list dims it: badge 2, one undimmed row,
  // and a title that claims "2 of 11 match the current filters" when one does.
  // The caption gets this right — it names the surplus as `state.keptOpen`,
  // "plus the open card" — which is the shape of the fix the badge is missing.
  // Asserting the behaviour as it stands.
  test('§9.3 a kept-open off-map card is counted by the badge but dimmed in the list', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    await setLayers(page, ['commons']);
    await settleCounts(page);
    // An off-map entity from a layer that is off: the filters exclude it, and
    // §6's focus override keeps it open regardless. Any of them would do, so
    // the payload picks rather than the test naming one.
    const kept = c.offMapEntries.find((e) => e.kind === 'framework');
    await page.evaluate((id) => openEntity(id), kept.id);
    await settleCounts(page);

    const matching = c.offMapByKind.commons;        // what really matches: the off-map commons
    const s = await snapshot(page);
    expect(s.keptOpen).toBe(1);
    const reallyMatching = await page.evaluate(() =>
      [...state.inFilter].filter((id) => !byId[id].geo).length);
    expect(reallyMatching).toBe(matching);
    expect(s.offMapMatch).toBe(matching + 1);       // but the badge's figure counts the open card

    const sec = await offMapSection(page);
    expect(sec.badge).toBe(String(matching + 1));
    expect(sec.rows.filter((r) => !r.out).map((r) => r.id))
      .toEqual(c.offMapEntries.filter((e) => e.kind === 'commons').map((e) => e.id));
    expect(sec.badgeTitle).toBe(nogeoTitle(matching + 1, c.offMap));
    expect((await feedHeader(page)).offMap.text).toBe(`+ ${matching + 1} off the map`);
    // Invariant 12 still holds — the surplus is accounted for, just not where
    // the badge and its list can be compared by eye.
    await expectHeaderReconciles(page, 'a kept-open off-map card');
    expect(await caption(page)).toContain('plus the open card');
  });
});

// ============================================================ render keying

test.describe('§9.3 rendering is keyed on ids + focus + language + pins', () => {
  /** Mark the live DOM, then see whether it survived. innerHTML is assigned
   *  wholesale, so a stamp that is still there proves no write happened. */
  const stamp = (page) => page.evaluate(() => {
    const els = document.querySelectorAll('#fd-list .fd-item');
    els[0].dataset.stamp = 'first';
    els[els.length - 1].dataset.stamp = 'last';
    return els.length;
  });
  const survivors = (page) => page.evaluate(() =>
    document.querySelectorAll('#fd-list .fd-item[data-stamp]').length);

  test('§9.3 an identical key skips the DOM write — a bare refresh() costs nothing', async ({ page }) => {
    await openMap(page);
    const c = await corpus(page);
    const n = await stamp(page);
    expect(n).toBe(c.placed);
    await page.evaluate(() => { refresh(); refresh(); });
    expect(await survivors(page)).toBe(2);
  });

  test('§9.3 a refresh that changes nothing the feed shows leaves the column alone', async ({ page }) => {
    await openMap(page);
    await stamp(page);
    // The links toggle redraws every edge and calls refresh(); the feed's key is
    // untouched by it, so not one of the rows may be rebuilt to find that out.
    await page.click('#links-row');
    await settleCounts(page);
    expect(await page.evaluate(() => state.links)).toBe(true);
    expect(await survivors(page)).toBe(2);
  });

  test('§9.3 panning across unchanged content costs nothing', async ({ page }) => {
    await openMap(page);
    const idsBefore = await page.evaluate(() => [...state.inView].sort().join(','));
    await stamp(page);
    await page.evaluate(() => setView({ k: view.k, x: view.x + 0.25, y: view.y + 0.25 }, false));
    await settleCounts(page);
    // A quarter-pixel pan cannot move a marker across the 10 px stage margin, so
    // the id set is identical and the key holds.
    expect(await page.evaluate(() => [...state.inView].sort().join(','))).toBe(idsBefore);
    expect(await survivors(page)).toBe(2);
  });

  test('§9.3 a changed id set rewrites the column', async ({ page }) => {
    await openMap(page);
    await stamp(page);
    await zoomBy(page, 3);
    expect(await survivors(page)).toBe(0);
    expect((await feedRows(page)).length).toBe(await page.evaluate(() => state.inView.size));
  });

  test('§9.3 a changed focus rewrites the column', async ({ page }) => {
    await openMap(page);
    await stamp(page);
    await page.evaluate(() => openEntity('haiku', { fly: false }));
    expect(await survivors(page)).toBe(0);
    // …and the rewrite is what puts the card in the column.
    expect(await page.evaluate(() => !!document.querySelector('#fd-list .fd-item.open .fd-card'))).toBe(true);
  });

  test('§9.3 a changed language rewrites the column', async ({ page }) => {
    await openMap(page);
    await stamp(page);
    await page.click('.lang-switch button[data-lang="fr"]');
    await settleCounts(page);
    expect(await survivors(page)).toBe(0);
    expect(await page.evaluate(() => feedKey.endsWith('|fr|'))).toBe(true);
  });

  test('§9.3 a changed pin set rewrites the column', async ({ page }) => {
    await openMap(page);
    await stamp(page);
    await page.evaluate(() => togglePin('haiku'));
    await settleCounts(page);
    // The open card carries a Pin / Unpin button, so the pins belong in the key
    // even though no collapsed row shows them.
    expect(await survivors(page)).toBe(0);
    expect(await page.evaluate(() => feedKey.includes('|haiku'))).toBe(true);
  });

  test('§9.3 the key carries exactly the four parts the spec names', async ({ page }) => {
    await openMap(page);
    await page.evaluate(() => { togglePin('haiku'); openEntity('haiku', { fly: false }); });
    await settleCounts(page);
    const parts = await page.evaluate(() => feedKey.split('|'));
    expect(parts).toHaveLength(4);
    const ids = await page.evaluate(() => [...document.querySelectorAll('#fd-list .fd-item')].map((e) => e.dataset.id));
    expect(parts[0]).toBe(ids.join(','));
    expect(parts[1]).toBe('haiku');
    expect(parts[2]).toBe('en');
    expect(parts[3]).toBe('haiku');
  });
});

// ======================================================== hiding and persisting

test.describe('§9.3 hiding the feed', () => {
  test('§9.3 hiding the feed reverts to the floating panel with the same card', async ({ page }) => {
    await openMap(page);
    await page.locator('.fd-row[data-open="haiku"]').click();
    // While the column is open the floating panel is suppressed outright, so
    // there is never a moment with two copies of the same card on screen.
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('detail')).display)).toBe('none');

    await page.click('#fd-close');
    await settleCounts(page);
    const r = await page.evaluate(() => ({
      feed: state.feed,
      feedOpen: document.body.classList.contains('feed-open'),
      focusId: state.focusId,
      detailOpen: document.body.classList.contains('detail-open'),
      detailDisplay: getComputedStyle(document.getElementById('detail')).display,
      name: document.querySelector('#dt-body .dt-name').textContent,
      feedColumn: getComputedStyle(document.getElementById('feed')).display,
    }));
    expect(r).toMatchObject({ feed: false, feedOpen: false, focusId: 'haiku', detailOpen: true, feedColumn: 'none' });
    expect(r.detailDisplay).not.toBe('none');
    expect(r.name).toBe((await payloadEntry(page, 'haiku')).name);
  });

  test('§9.3 the choice is written down as it is made', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => localStorage.getItem('hai-map-v2-feed'))).toBe(null);
    await page.click('#fd-close');
    expect(await page.evaluate(() => localStorage.getItem('hai-map-v2-feed'))).toBe('0');
    await page.click('#feed-pill');
    expect(await page.evaluate(() => localStorage.getItem('hai-map-v2-feed'))).toBe('1');
  });

  test('§9.3 the choice persists: a stored 0 boots with the column gone', async ({ page }) => {
    await openMap(page, { storage: { 'hai-map-v2-feed': '0' } });
    const r = await page.evaluate(() => ({
      feed: state.feed,
      feedOpen: document.body.classList.contains('feed-open'),
      display: getComputedStyle(document.getElementById('feed')).display,
      pressed: document.getElementById('feed-pill').getAttribute('aria-pressed'),
      active: document.getElementById('feed-pill').classList.contains('active'),
    }));
    expect(r).toEqual({ feed: false, feedOpen: false, display: 'none', pressed: 'false', active: false });
  });

  test('§9.3 the choice persists: a stored 1 boots with the column there', async ({ page }) => {
    await openMap(page, { storage: { 'hai-map-v2-feed': '1' } });
    const r = await page.evaluate(() => ({
      feed: state.feed,
      pressed: document.getElementById('feed-pill').getAttribute('aria-pressed'),
      active: document.getElementById('feed-pill').classList.contains('active'),
      count: document.getElementById('fd-count').textContent,
    }));
    expect(r).toMatchObject({ feed: true, pressed: 'true', active: true });
    expect(Number(r.count)).toBe(await page.evaluate(() => state.inView.size));
  });

  test('§9.3 with nothing stored the column follows the width — open on a desktop', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => ({ w: window.innerWidth, feed: state.feed })))
      .toEqual({ w: 1280, feed: true });
  });

  test('§9.3 with nothing stored the column follows the width — closed below 840 px', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 820 });
    await openMap(page);
    expect(await page.evaluate(() => ({ w: window.innerWidth, feed: state.feed, ls: localStorage.getItem('hai-map-v2-feed') })))
      .toEqual({ w: 420, feed: false, ls: null });
  });

  test('§9.3 the pill mirrors state.feed even while the column is gone', async ({ page }) => {
    await openMap(page, { storage: { 'hai-map-v2-feed': '0' } });
    // renderFeed() sets the pill *before* it returns early, which is the whole
    // reason the reader can find their way back to a column they cannot see.
    await expect(page.locator('#feed-pill')).toHaveAttribute('aria-pressed', 'false');
    await page.click('#feed-pill');
    await settleCounts(page);
    await expect(page.locator('#feed-pill')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#feed')).toBeVisible();
  });

  test('§9.3 re-showing the column brings the open card back into it', async ({ page }) => {
    await openMap(page);
    await page.locator('.fd-row[data-open="haiku"]').click();
    await page.click('#fd-close');
    // The floating panel covers the top-right cluster (and so the pill) while it
    // is open, so a reader gets the column back by closing the card first —
    // Escape, per §7's close order.
    await page.keyboard.press('Escape');
    await page.click('#feed-pill');
    await settleCounts(page);
    expect(await page.evaluate(() => state.focusId)).toBe(null);

    await page.locator('.fd-row[data-open="haiku"]').click();
    const rows = await feedRows(page);
    expect(rows.filter((r) => r.open).map((r) => r.id)).toEqual(['haiku']);
    expect(await page.evaluate(() => localStorage.getItem('hai-map-v2-feed'))).toBe('1');
  });

  test('§9.3 toggling the column resizes the stage, so the counts follow (§5)', async ({ page }) => {
    await openMap(page, { storage: { 'hai-map-v2-feed': '0' } });
    const wide = await page.evaluate(() => stageSize()[0]);
    await page.click('#feed-pill');
    await settleCounts(page);
    const r = await page.evaluate(() => ({
      stage: stageSize()[0],
      k0Correct: Math.abs(k0 - Math.min(stageSize()[0] / GEO.W, stageSize()[1] / GEO.H)) < 1e-9,
      inView: state.inView.size,
      count: Number(document.getElementById('fd-count').textContent),
    }));
    // The column takes 344 px off the stage, and neither the map's scale nor the
    // counters may keep measuring against the old rectangle.
    expect(r.stage).toBe(wide - 344);
    expect(r.k0Correct).toBe(true);
    expect(r.count).toBe(r.inView);
    expect((await feedRows(page))).toHaveLength(r.inView);
    await expectCountersReconcile(page, 'just after the feed opened');
  });

  test('§9.3 private mode: the toggle still works when localStorage throws', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // Safari's private mode, roughly: the object is there and every write throws.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          return {
            getItem: () => null,
            setItem() { throw new DOMException('QuotaExceededError'); },
            removeItem() { throw new DOMException('QuotaExceededError'); },
            clear() { throw new DOMException('QuotaExceededError'); },
          };
        },
      });
    });
    await openMap(page);
    await page.keyboard.press('Escape');          // no stored "seen", so the welcome opened
    expect(await page.evaluate(() => state.feed)).toBe(true);
    expect((await feedRows(page)).length).toBe(await page.evaluate(() => state.inView.size));

    await page.click('#fd-close');
    await settleCounts(page);
    expect(await page.evaluate(() => ({
      feed: state.feed, open: document.body.classList.contains('feed-open'),
    }))).toEqual({ feed: false, open: false });

    await page.click('#feed-pill');
    await settleCounts(page);
    expect(await page.evaluate(() => state.feed)).toBe(true);
    // The choice cannot be remembered, but nothing may break for trying.
    expect(errors).toEqual([]);
  });
});
