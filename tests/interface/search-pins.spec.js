// §11 search, pins, sharing, print · §13 persistence and deep links.
//
// These are the reader's own surfaces: the ways in to an entity that do not
// depend on finding its marker, and the ways out — a link, a printed sheet, a
// selection that survives the tab being closed. Two of the spec's claims here
// are stated as reasoning rather than as rules, and those are the ones that
// encode real bugs:
//
//   · "Ranking carries this feature, not the widening" — searching affiliations
//     as well as names is only useful if own-name matches still win, or a query
//     like "universit" spends all eight slots on teams whose *parent* is a
//     university and evicts the ones actually called that.
//   · "Unknown ids and codes are filtered out on read, so a stale link degrades
//     to a sensible view instead of an empty map" — the fragment is a public
//     contract, and a link that outlives a data refresh must not blank the map.
//
// Expectations are derived from `window.HAI_DATA` (the raw generated payload)
// or from the spec's stated rule, never by reading them back out of the code
// path under test. Where the reference implementations below restate a rule
// they restate it from the spec text, over the payload, and independently of
// `items` / `byId` / `runSearch`.
import { test, expect } from '@playwright/test';
import { openMap, snapshot, setLayers, setPeriod, settleCounts, MAP_PATH } from './_map.js';

// ---------------------------------------------------------------- local rig

/** Open the map WITHOUT the shared helper's storage priming, so the tests that
 *  are about storage can see a genuinely first-visit browser — or one whose
 *  localStorage refuses to answer at all. `init` runs before any page script. */
async function openRaw(page, { lang = null, hash = '', init = null, seed = null, wait = true } = {}) {
  if (init) await page.addInitScript(init);
  await page.addInitScript((s) => {
    try {
      localStorage.clear();
      if (s) for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    } catch { /* storage refused — the page must cope, and so must the test */ }
  }, seed);
  await page.goto(MAP_PATH + (lang ? `?lang=${lang}` : '') + hash);
  if (wait) await expect(page.locator('#st-note')).not.toBeEmpty();
  return page;
}

/** Load the page again from scratch. `page.goto()` to a URL that differs from
 *  the current one only after the '#' is a same-document navigation: the boot
 *  code never runs a second time, so a test comparing two deep links would be
 *  comparing the first one with itself. Going through about:blank forces the
 *  real reload — without it, the round-trip tests below would pass whatever
 *  applyHash() did. */
async function reopen(page, opts) {
  await page.goto('about:blank');
  return openMap(page, opts);
}

/** Read one localStorage key from the page's own origin. 'THREW' distinguishes
 *  "storage is refused" from "the key is absent" (null). */
const ls = (page, key) =>
  page.evaluate((k) => { try { return localStorage.getItem(k); } catch { return 'THREW'; } }, key);

/** Everything the URL fragment is supposed to carry, plus the resulting corpus,
 *  so a round trip can be compared as one value. */
const fullState = (page) => page.evaluate(() => ({
  pins: [...state.pins],
  focusId: state.focusId,
  domains: [...state.domains],
  layers: { ...state.layers },
  links: state.links,
  myMap: state.myMap,
  years: { ...state.years },
  matchCount: state.matchCount,
  visible: [...state.inFilter].sort(),
}));

// ---- search -------------------------------------------------------------

const dropOpen = (page) => expect(page.locator('#search-drop')).toHaveClass(/open/);
const dropShut = (page) => expect(page.locator('#search-drop')).not.toHaveClass(/open/);

async function type(page, q) {
  await page.fill('#search', q);
}

/** The rendered dropdown, flattened: one row per result, in DOM order. */
const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#search-drop .sd-item')].map((b) => ({
    id: b.dataset.open,
    name: b.querySelector('.nm').textContent,
    meta: b.querySelector('.mt').textContent,
    selected: b.classList.contains('sel'),
  })));

/** The rendered dropdown, grouped: each header with the ids that follow it. */
const groups = (page) => page.evaluate(() => {
  const out = []; let cur = null;
  for (const el of document.getElementById('search-drop').children) {
    if (el.classList.contains('sd-group')) { cur = { label: el.textContent, ids: [] }; out.push(cur); }
    else if (el.classList.contains('sd-item') && cur) cur.ids.push(el.dataset.open);
  }
  return out;
});

/** A reference implementation of §11's matching rule, written from the spec
 *  text and run over the raw payload: match name or city diacritic-insensitively
 *  (rank 0), else affiliation.org / affiliation.parent (rank 1); group by layer;
 *  stable sort by rank; at most eight per layer. It exists so the assertions
 *  below can name exact ids without asking the page what it found. */
const reference = (page, query) => page.evaluate((q) => {
  const D = window.HAI_DATA;
  const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const nq = norm(q.trim());
  const LAYERS = [['project', D.PROJECTS], ['team', D.TEAMS], ['commons', D.COMMONS], ['framework', D.FRAMEWORKS]];
  return LAYERS.map(([kind, arr]) => {
    const own = [], aff = [];
    for (const d of arr) {
      if (norm(d.name).includes(nq) || norm(d.city || '').includes(nq)) { own.push({ kind, id: d.id, via: null }); continue; }
      const a = d.affiliation || {};
      const via = [a.org, a.parent].find((v) => v && norm(v).includes(nq));
      if (via) aff.push({ kind, id: d.id, via });
    }
    return { kind, own: own.map((h) => h.id), aff: aff.map((h) => h.id), shown: own.concat(aff).slice(0, 8) };
  }).filter((g) => g.own.length + g.aff.length);
}, query);

// ---- pins ---------------------------------------------------------------

// The card is rendered twice over: into the floating panel (#dt-body) and into
// the feed column (.fd-card), from the same cardHtml() — invariant 5. Only one
// of the two is ever on screen (`body.feed-open #detail{display:none}`), and the
// feed is the default on a wide window, so these helpers address whichever copy
// the reader can actually see rather than hard-coding one surface.
const cardPin = (page) => page.locator('.dt-pin:visible').first();
const cardName = (page) => page.locator('.dt-name:visible').first();

/** Pin through the card's own ★ button — the reader's path. */
async function pinFromCard(page, id) {
  await page.evaluate((x) => openEntity(x), id);
  await cardPin(page).click();
}

const pinUi = (page) => page.evaluate(() => ({
  badge: document.getElementById('mymap-badge').textContent,
  count: document.getElementById('pin-count').textContent,
  emptyShown: getComputedStyle(document.getElementById('pin-empty')).display !== 'none',
  rows: [...document.querySelectorAll('#pin-list .pin-item')].map((b) => b.dataset.open),
  names: [...document.querySelectorAll('#pin-list .pin-item .nm')].map((b) => b.textContent),
  pillPressed: document.getElementById('mymap-pill').getAttribute('aria-pressed'),
  cardBtn: (() => {
    const b = [...document.querySelectorAll('.dt-pin')].find((el) => el.getClientRects().length);
    return b ? b.textContent : null;
  })(),
}));

const toastText = (page) => page.evaluate(() => {
  const el = document.getElementById('toast');
  return el.classList.contains('show') ? el.textContent : null;
});

/** Pins ∪ neighbours, derived from the payload's own edge lists rather than
 *  from the page's `neighbors` map. */
const myMapExpectation = (page, ids) => page.evaluate((pins) => {
  const D = window.HAI_DATA;
  const known = new Set([...D.PROJECTS, ...D.COMMONS, ...D.TEAMS, ...D.FRAMEWORKS].map((d) => d.id));
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
  const out = new Set();
  pins.forEach((id) => { if (known.has(id)) out.add(id); });
  pins.forEach((id) => (nb.get(id) || new Set()).forEach((n) => out.add(n)));
  return [...out].sort();
}, ids);

// ---- sharing ------------------------------------------------------------

/** Capture what the share button puts on the clipboard. Stubbing the clipboard
 *  rather than granting permissions keeps the test independent of the browser's
 *  permission model, which is not what §11 is about. */
async function stubClipboard(page, { fail = false } = {}) {
  await page.evaluate((f) => {
    window.__copied = null;
    window.__prompted = null;
    window.prompt = (_label, value) => { window.__prompted = value; return null; };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => (f ? undefined : { writeText: (v) => { window.__copied = v; return Promise.resolve(); } }),
    });
  }, fail);
}

async function copiedLink(page) {
  await page.evaluate(() => { window.__copied = null; });
  await page.click('#share-btn');
  await page.waitForFunction(() => window.__copied !== null);
  return page.evaluate(() => window.__copied);
}

const fragmentOf = (url) => new URL(url).hash.replace(/^#/, '');

/** The domain vocabulary in the order the sidebar renders it — the order the
 *  `dom=` parameter is built from, read off a different surface than the one
 *  under test. */
const domainOrder = (page) => page.evaluate(() =>
  [...document.querySelectorAll('[data-dom]')].map((cb) => cb.dataset.dom));

// ---- print --------------------------------------------------------------

async function stubPrint(page) {
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
}

async function printSheet(page) {
  await page.click('#print-btn');
  await page.waitForFunction(() => window.__printed > 0);
  return page.evaluate(() => {
    const host = document.getElementById('print-sheet');
    const out = { title: host.querySelector('h1').textContent,
                  sub: host.querySelector('.ps-sub').textContent,
                  groups: [], total: host.querySelectorAll('.ps-item').length,
                  printed: window.__printed,
                  visibleOnScreen: getComputedStyle(host).display !== 'none' };
    let cur = null;
    for (const el of host.children) {
      if (el.tagName === 'H2') { cur = { heading: el.textContent, items: [] }; out.groups.push(cur); }
      else if (el.classList && el.classList.contains('ps-item') && cur) {
        cur.items.push({
          name: el.querySelector('b').textContent,
          meta: el.querySelector('.m').textContent,
          desc: el.querySelector('p') ? el.querySelector('p').textContent : null,
          link: el.querySelector('a') ? el.querySelector('a').getAttribute('href') : null,
        });
      }
    }
    return out;
  });
}

const payloadTotals = (page) => page.evaluate(() => ({
  project: window.HAI_DATA.PROJECTS.length,
  team: window.HAI_DATA.TEAMS.length,
  commons: window.HAI_DATA.COMMONS.length,
  framework: window.HAI_DATA.FRAMEWORKS.length,
}));

// Fixtures picked for their shape, not their content:
//   dlr-gsoc   — own name says only "DLR"; its affiliation is spelled out in
//                full, which is the case §11 names. No neighbours: n=1 My map.
//   chalmers-revere — exactly one neighbour, so "pins and their neighbours" has
//                a two-element expectation that a wrong join would miss.
//   sae-j3016  — a framework with no coordinates and no city: no marker, and
//                the empty-place branch of every row renderer.
//   3ia-cotedazur — an accented name with a `when` range and a URL.
//   flatland-association — a team whose description exists only as a bare
//                `desc`, with no `desc_en` key: the fallback branch of the
//                print sheet's paragraph.
const DLR = 'dlr-gsoc';
const REVERE = 'chalmers-revere';
const SAE = 'sae-j3016';
const AZUR = '3ia-cotedazur';
const FLAT = 'flatland-association';

// Three surfaces carry pin order — the sidebar list, the stored array and the
// `pins=` fragment — and all three read `state.pins` in insertion order. The
// fixtures above are a trap for that claim: pinned in the obvious order they
// come out as chalmers-revere, dlr-gsoc, sae-j3016, which is *already* the
// alphabetical one, so a `.sort()` slipped into any of the three sites changes
// nothing any assertion can see. Order is therefore asserted against this
// deliberately backwards fixture, behind the guard below.
const PIN_ORDER = [SAE, DLR, REVERE];

/** Guard: the fixture must not be in alphabetical order, or the test that uses
 *  it is asserting nothing about order at all. */
const notAlphabetical = (ids) => expect([...ids].sort()).not.toEqual(ids);

// =========================================================== search: matching

test.describe('§11 search — matching', () => {
  test('§11 nothing happens on one character; two opens the list', async ({ page }) => {
    await openMap(page);
    await type(page, 'a');
    await dropShut(page);
    expect(await rows(page)).toEqual([]);
    await type(page, 'ai');
    await dropOpen(page);
    expect((await rows(page)).length).toBeGreaterThan(0);
  });

  test('§11 the two-character floor is measured after trimming', async ({ page }) => {
    await openMap(page);
    await type(page, '  a  ');
    await dropShut(page);
    await type(page, '  ai  ');
    await dropOpen(page);
    const ref = await reference(page, 'ai');
    expect((await rows(page)).map((r) => r.id))
      .toEqual(ref.flatMap((g) => g.shown.map((h) => h.id)));
  });

  test('§11 diacritic-insensitive: an unaccented query reaches an accented name', async ({ page }) => {
    await openMap(page);
    // "3IA Côte d'Azur" typed as a reader without a French keyboard would.
    await type(page, 'cote');
    await dropOpen(page);
    expect((await rows(page)).map((r) => r.id)).toEqual([AZUR]);
    expect((await rows(page))[0].name).toContain('Côte');
  });

  test('§11 diacritic-insensitive both ways: göteborg and goteborg find one set', async ({ page }) => {
    await openMap(page);
    await type(page, 'goteborg');
    await dropOpen(page);
    const plain = (await rows(page)).map((r) => r.id);
    await type(page, 'göteborg');
    await dropOpen(page);
    const accented = (await rows(page)).map((r) => r.id);
    const ref = await reference(page, 'goteborg');
    const expected = ref.flatMap((g) => g.shown.map((h) => h.id));
    expect(expected.length).toBe(4);            // guards the fixture itself
    expect(plain).toEqual(expected);
    expect(accented).toEqual(expected);
  });

  test('§11 it matches the city, not only the name', async ({ page }) => {
    await openMap(page);
    await type(page, 'oberpfaffenhofen');
    await dropOpen(page);
    const ref = await reference(page, 'oberpfaffenhofen');
    const expected = ref.flatMap((g) => g.shown.map((h) => h.id));
    expect(expected).toContain(DLR);
    expect((await rows(page)).map((r) => r.id)).toEqual(expected);
    // The name carries no trace of the city, so this row can only be a city hit.
    const name = (await rows(page)).find((r) => r.id === DLR).name;
    expect(name.toLowerCase()).not.toContain('oberpfaffenhofen');
  });

  test('§11 it does not reach into descriptions — name, city and affiliation only', async ({ page }) => {
    // The widening stops at the affiliation. "biology" appears in a project's
    // description and in no name, city or affiliation anywhere in the payload,
    // so a hit here would mean the match had quietly grown a fourth field — and
    // with it a ranking rule the spec does not define.
    await openMap(page);
    const inDesc = await page.evaluate(() => window.HAI_DATA.PROJECTS
      .some((d) => (d.desc_en || d.desc || '').toLowerCase().includes('biology')));
    expect(inDesc).toBe(true);
    await type(page, 'biology');
    await dropOpen(page);
    expect(await rows(page)).toEqual([]);
    await expect(page.locator('#search-drop .sd-empty')).toHaveText('No matches');
  });

  test('§11 zero results say so instead of showing an empty list', async ({ page }) => {
    await openMap(page);
    await type(page, 'qqqqq');
    await dropOpen(page);
    expect(await rows(page)).toEqual([]);
    await expect(page.locator('#search-drop .sd-empty')).toHaveText('No matches');
  });

  test('§11 one result: a single row, no other layer', async ({ page }) => {
    await openMap(page);
    await type(page, 'deutsches zentrum');
    await dropOpen(page);
    expect((await rows(page)).map((r) => r.id)).toEqual([DLR]);
    expect((await groups(page)).map((g) => g.label)).toEqual(['Teams']);
  });
});

// =========================================================== search: grouping

test.describe('§11 search — grouping and the eight-per-layer cap', () => {
  test('§11 results are grouped by layer, in layer order, under the layer label', async ({ page }) => {
    await openMap(page);
    await type(page, 'er');                    // hits all four layers
    await dropOpen(page);
    const g = await groups(page);
    expect(g.map((x) => x.label))
      .toEqual(['Projects & programmes', 'Teams', 'Commons', 'Frameworks']);
    const ref = await reference(page, 'er');
    expect(g.map((x) => x.ids)).toEqual(ref.map((x) => x.shown.map((h) => h.id)));
  });

  test('§11 at most eight per layer, even when a layer has a hundred hits', async ({ page }) => {
    await openMap(page);
    await type(page, 'er');
    await dropOpen(page);
    const ref = await reference(page, 'er');
    // The fixture must actually exercise the cap on every layer, or the test
    // would pass on an implementation with no cap at all.
    for (const g of ref) expect(g.own.length + g.aff.length).toBeGreaterThan(8);
    const g = await groups(page);
    expect(g.map((x) => x.ids.length)).toEqual([8, 8, 8, 8]);
    expect((await rows(page)).length).toBe(32);
  });

  test('§11 a layer under the cap shows all of its hits', async ({ page }) => {
    await openMap(page);
    await type(page, 'ai');
    await dropOpen(page);
    const ref = await reference(page, 'ai');
    const commons = ref.find((g) => g.kind === 'commons');
    expect(commons.own.length + commons.aff.length).toBe(6);   // fewer than eight
    const shown = (await groups(page)).find((g) => g.label === 'Commons');
    expect(shown.ids).toEqual(commons.shown.map((h) => h.id));
    expect(shown.ids.length).toBe(6);
  });

  test('§11 a layer with no hits contributes no header', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    expect((await groups(page)).map((g) => g.label)).toEqual(['Teams']);
    expect(await page.locator('#search-drop .sd-group').count()).toBe(1);
  });
});

// =========================================================== search: ranking

test.describe('§11 search — ranking carries the affiliation widening', () => {
  test('§11 the widening: the institution\'s full name finds the team called only "DLR"', async ({ page }) => {
    await openMap(page);
    await type(page, 'Deutsches Zentrum für Luft- und Raumfahrt');
    await dropOpen(page);
    const r = await rows(page);
    expect(r.map((x) => x.id)).toEqual([DLR]);
    // The point of the widening: nothing in the row's own name matches.
    expect(r[0].name).toBe('DLR — German Space Operations Center (GSOC)');
  });

  test('§11 "universit" keeps the teams actually called that and evicts none of them for a parent match', async ({ page }) => {
    await openMap(page);
    await type(page, 'universit');
    await dropOpen(page);
    const ref = await reference(page, 'universit');
    const teams = ref.find((g) => g.kind === 'team');
    // The bug the spec describes only exists when affiliation matches outnumber
    // own-name matches and together overflow the eight slots.
    expect(teams.own.length).toBe(9);
    expect(teams.aff.length).toBe(24);

    const shown = (await groups(page)).find((g) => g.label === 'Teams').ids;
    expect(shown).toEqual(teams.own.slice(0, 8));          // exact order: stable sort
    for (const id of teams.aff) expect(shown).not.toContain(id);
  });

  test('§11 the cap is applied after ranking, so the evicted row is an own-name one', async ({ page }) => {
    await openMap(page);
    await type(page, 'universit');
    await dropOpen(page);
    const ref = await reference(page, 'universit');
    const teams = ref.find((g) => g.kind === 'team');
    const shown = (await groups(page)).find((g) => g.label === 'Teams').ids;
    // Nine own-name teams compete for eight slots: the ninth loses, and it loses
    // to another own-name team rather than to an affiliation match.
    const evicted = teams.own[8];
    expect(shown).not.toContain(evicted);
    // `.every()` on an empty array is true, so the length comes first: without
    // it this test passes on an implementation that shows no Teams at all.
    expect(shown.length).toBe(8);
    expect(shown.every((id) => teams.own.includes(id))).toBe(true);
  });

  test('§11 within one rank the order is the corpus order — the sort is stable', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');              // three teams, all affiliation-only
    await dropOpen(page);
    const ref = await reference(page, 'zentrum');
    const teams = ref.find((g) => g.kind === 'team');
    expect(teams.own).toEqual([]);
    expect(teams.aff.length).toBe(3);
    expect((await rows(page)).map((r) => r.id)).toEqual(teams.aff);
  });

  test('§11 an affiliation-only row appends the institution after the city', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    const r = (await rows(page)).find((x) => x.id === DLR);
    expect(r.meta).toBe('Oberpfaffenhofen, DE · Deutsches Zentrum für Luft- und Raumfahrt (DLR)');
  });

  test('§11 an own-name row shows the city alone, with nothing appended', async ({ page }) => {
    await openMap(page);
    await type(page, 'dlr');                  // now the name itself matches
    await dropOpen(page);
    const r = (await rows(page)).find((x) => x.id === DLR);
    expect(r.meta).toBe('Oberpfaffenhofen, DE');
    expect(r.meta).not.toContain(' · ');
  });
});

// ============================================== search: reach beyond the map

test.describe('§11 search — reach', () => {
  test('§11 search reaches an entity every layer filter excludes', async ({ page }) => {
    await openMap(page);
    await setLayers(page, []);                // every layer off: nothing on the map
    await settleCounts(page);
    expect((await snapshot(page)).matchCount).toBe(0);
    await type(page, 'deutsches zentrum');
    await dropOpen(page);
    expect((await rows(page)).map((r) => r.id)).toEqual([DLR]);
    await page.click(`#search-drop [data-open="${DLR}"]`);
    expect((await snapshot(page)).focusId).toBe(DLR);
    await expect(cardName(page)).toHaveText('DLR — German Space Operations Center (GSOC)');
  });

  test('§11 search reaches an entity the period filter excludes', async ({ page }) => {
    await openMap(page);
    const { ymin } = await page.evaluate(() => ({ ymin: YMIN }));
    await setPeriod(page, ymin, ymin);        // a one-year window at the floor
    await settleCounts(page);
    const inFilter = await page.evaluate((id) => state.inFilter.has(id), AZUR);
    expect(inFilter).toBe(false);             // the fixture really is filtered out
    await type(page, 'cote');
    await dropOpen(page);
    expect((await rows(page)).map((r) => r.id)).toEqual([AZUR]);
  });

  test('§11 search reaches an entity with no coordinates, which has no marker', async ({ page }) => {
    await openMap(page);
    const hasMarker = await page.evaluate((id) => !!document.querySelector(`.mk[data-id="${id}"]`), SAE);
    expect(hasMarker).toBe(false);
    const geo = await page.evaluate((id) => byId[id].geo, SAE);
    expect(geo).toBe(false);
    await type(page, 'j3016');
    await dropOpen(page);
    expect((await rows(page)).map((r) => r.id)).toEqual([SAE]);
    await page.click(`#search-drop [data-open="${SAE}"]`);
    expect((await snapshot(page)).focusId).toBe(SAE);
  });

  test('§11 an entity with no city renders an empty meta line rather than a stray comma', async ({ page }) => {
    await openMap(page);
    await type(page, 'j3016');
    await dropOpen(page);
    expect((await rows(page))[0].meta).toBe('');
  });
});

// ========================================================= search: keyboard

test.describe('§11 search — keyboard', () => {
  test('§11 ArrowDown walks the list from the top', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    await page.keyboard.press('ArrowDown');
    expect((await rows(page)).map((r) => r.selected)).toEqual([true, false, false]);
    await page.keyboard.press('ArrowDown');
    expect((await rows(page)).map((r) => r.selected)).toEqual([false, true, false]);
  });

  test('§11 ArrowDown wraps round past the last row', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect((await rows(page)).map((r) => r.selected)).toEqual([false, false, true]);
    await page.keyboard.press('ArrowDown');
    expect((await rows(page)).map((r) => r.selected)).toEqual([true, false, false]);
  });

  test('§11 ArrowUp from an unselected list lands on the second-to-last row', async ({ page }) => {
    // Documenting rather than judging: the selection index starts at -1 and the
    // handler wraps with a modulo, so the first ArrowUp resolves to n-2, not to
    // the last row. §11 asks only that the arrows select; it does not pin the
    // wrap-around, so this asserts what the page does today.
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    await page.keyboard.press('ArrowUp');
    expect((await rows(page)).map((r) => r.selected)).toEqual([false, true, false]);
    await page.keyboard.press('ArrowUp');
    expect((await rows(page)).map((r) => r.selected)).toEqual([true, false, false]);
  });

  test('§11 Enter opens the highlighted row and clears the search', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');   // third row: dlr-gsoc
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).focusId).toBe(DLR);
    await dropShut(page);
    await expect(page.locator('#search')).toHaveValue('');
  });

  test('§11 Enter with nothing highlighted opens nothing', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).focusId).toBe(null);
    await dropOpen(page);                     // the list is still there to choose from
    await expect(page.locator('#search')).toHaveValue('zentrum');
  });

  test('§11 Escape closes the list without opening anything, and the query survives', async ({ page }) => {
    await openMap(page);
    await type(page, 'zentrum');
    await dropOpen(page);
    await page.keyboard.press('Escape');
    await dropShut(page);
    expect((await snapshot(page)).focusId).toBe(null);
    await expect(page.locator('#search')).toHaveValue('zentrum');
    // Refocusing re-runs the search, so an escaped list is one click from back.
    // The field still has focus after Escape, so blur it first — otherwise no
    // focus event fires and the test would be asserting nothing.
    await page.click('#f-layers .sb-h');
    await page.click('#search');
    await dropOpen(page);
    expect((await rows(page)).length).toBe(3);
  });

  test('§11 clicking a row opens the entity, closes the list and empties the field', async ({ page }) => {
    await openMap(page);
    await type(page, 'cote');
    await dropOpen(page);
    await page.click(`#search-drop [data-open="${AZUR}"]`);
    expect((await snapshot(page)).focusId).toBe(AZUR);
    await dropShut(page);
    await expect(page.locator('#search')).toHaveValue('');
  });

  test('§11 clicking outside the search closes the list', async ({ page }) => {
    await openMap(page);
    await type(page, 'cote');
    await dropOpen(page);
    await page.click('#f-layers .sb-h');
    await dropShut(page);
    expect((await snapshot(page)).focusId).toBe(null);
  });
});

// =============================================================== pins

test.describe('§11 pins — My map', () => {
  test('§11 no pins: the badge and the count read zero and the invitation shows', async ({ page }) => {
    await openMap(page);
    expect(await pinUi(page)).toMatchObject({
      badge: '0', count: '0', emptyShown: true, rows: [], pillPressed: 'false',
    });
  });

  test('§11 pinning from the card fills the badge, the count and the list', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, DLR);
    const ui = await pinUi(page);
    expect(ui.badge).toBe('1');
    expect(ui.count).toBe('1');
    expect(ui.emptyShown).toBe(false);
    expect(ui.rows).toEqual([DLR]);
    expect(ui.names).toEqual(['DLR — German Space Operations Center (GSOC)']);
    expect(ui.cardBtn).toBe('★ Pinned');       // the card reflects it immediately
    expect((await snapshot(page)).pins).toBe(1);
  });

  test('§11 pinning works from the floating panel too, not only from the feed', async ({ page }) => {
    // Invariant 5: the panel and the feed render the same card from the same
    // function. Closing the feed swaps which copy is on screen, and the ★ has to
    // work on both — otherwise pinning would depend on a column being open.
    await openMap(page);
    await page.click('#fd-close');
    expect(await page.evaluate(() => state.feed)).toBe(false);
    await page.evaluate((id) => openEntity(id), DLR);
    await expect(page.locator('#dt-body .dt-pin')).toBeVisible();
    await page.locator('#dt-body .dt-pin').click();
    expect((await pinUi(page)).rows).toEqual([DLR]);
    expect((await pinUi(page)).cardBtn).toBe('★ Pinned');
  });

  test('§11 the pin list keeps the order the reader pinned in', async ({ page }) => {
    await openMap(page);
    notAlphabetical(PIN_ORDER);
    for (const id of PIN_ORDER) await pinFromCard(page, id);
    expect((await pinUi(page)).rows).toEqual(PIN_ORDER);
    // Names as well as ids: the row the reader reads has to be the row the
    // order claim is about.
    expect((await pinUi(page)).names[0]).toBe('SAE J3016 — Levels of Driving Automation');
  });

  test('§11 the × on a list row unpins that row and leaves the others', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, REVERE);
    await pinFromCard(page, DLR);
    await page.click(`#pin-list [data-unpin="${DLR}"]`);
    expect((await pinUi(page)).rows).toEqual([REVERE]);
    expect((await pinUi(page)).badge).toBe('1');
  });

  test('§11 unpinning from the card empties the list and brings the invitation back', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, DLR);
    await cardPin(page).click();
    const ui = await pinUi(page);
    expect(ui).toMatchObject({ badge: '0', count: '0', emptyShown: true, rows: [] });
    expect(ui.cardBtn).toBe('☆ Pin');
  });

  test('§11 My map needs at least one pin — with none it refuses and says why', async ({ page }) => {
    await openMap(page);
    await page.click('#mymap-btn');
    expect((await snapshot(page)).myMap).toBe(false);
    expect(await pinUi(page)).toMatchObject({ pillPressed: 'false' });
    expect(await toastText(page))
      .toBe('Pin cards (★) to compose your own cartography — it is kept on this device.');
  });

  test('§11 My map shows only the pins and their neighbours', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, REVERE);
    await page.evaluate(() => closeDetail());   // no open card to widen the set
    await page.click('#mymap-btn');
    await settleCounts(page);
    const expected = await myMapExpectation(page, [REVERE]);
    expect(expected.length).toBe(2);            // the fixture: one pin, one neighbour
    const got = await page.evaluate(() => [...state.inFilter].sort());
    expect(got).toEqual(expected);
    expect((await snapshot(page)).matchCount).toBe(2);
    expect((await snapshot(page)).myMap).toBe(true);
  });

  test('§11 in My map the pin is drawn solid and the neighbour it dragged in is dimmed', async ({ page }) => {
    // "Pins and their neighbours" is two populations, not one: the reader's own
    // choice and the context it pulls along. If both rendered the same, the pill
    // would claim a selection the reader never made.
    await openMap(page);
    await pinFromCard(page, REVERE);
    await page.evaluate(() => closeDetail());
    await page.click('#mymap-btn');
    await settleCounts(page);
    const neighbour = (await myMapExpectation(page, [REVERE])).find((id) => id !== REVERE);
    expect(neighbour).toBe('hi-drive');          // guards the fixture
    const marks = await page.evaluate(([pin, nb]) => ({
      pinDim: document.querySelector(`.mk[data-id="${pin}"]`).classList.contains('dim'),
      pinned: document.querySelector(`.mk[data-id="${pin}"]`).classList.contains('pinned'),
      nbDim: document.querySelector(`.mk[data-id="${nb}"]`).classList.contains('dim'),
      nbPinned: document.querySelector(`.mk[data-id="${nb}"]`).classList.contains('pinned'),
    }), [REVERE, neighbour]);
    expect(marks).toEqual({ pinDim: false, pinned: true, nbDim: true, nbPinned: false });
  });

  test('§11 a pin with no neighbours makes a My map of exactly one', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, DLR);
    await page.evaluate(() => closeDetail());
    await page.click('#mymap-btn');
    await settleCounts(page);
    expect(await myMapExpectation(page, [DLR])).toEqual([DLR]);
    expect(await page.evaluate(() => [...state.inFilter])).toEqual([DLR]);
    expect((await snapshot(page)).matchCount).toBe(1);
  });

  test('§11 leaving My map restores the whole corpus', async ({ page }) => {
    await openMap(page);
    const before = (await snapshot(page)).matchCount;
    const totals = await payloadTotals(page);
    expect(before).toBe(totals.project + totals.team + totals.commons + totals.framework);
    await pinFromCard(page, REVERE);
    await page.click('#mymap-btn');
    await settleCounts(page);
    await page.click('#mymap-btn');
    await settleCounts(page);
    expect((await snapshot(page)).myMap).toBe(false);
    expect((await snapshot(page)).matchCount).toBe(before);
  });

  test('§11 the map-side pill mirrors the pin count and still works with the sidebar collapsed', async ({ page }) => {
    // Wide enough that the floating control cluster is not sitting on top of the
    // collapse button: this test is about what survives the collapse, not about
    // the layout at the width where those two meet.
    await page.setViewportSize({ width: 1600, height: 900 });
    await openMap(page);
    await pinFromCard(page, REVERE);
    await page.evaluate(() => closeDetail());
    await page.click('#sb-hide');
    await expect(page.locator('body')).toHaveClass(/sb-hidden/);
    expect((await pinUi(page)).badge).toBe('1');
    await page.click('#mymap-pill');
    await settleCounts(page);
    expect((await snapshot(page)).myMap).toBe(true);
    expect((await pinUi(page)).pillPressed).toBe('true');
  });
});

// =================================================== pins in localStorage

test.describe('§13 pins in localStorage', () => {
  test('§13 hai-map-v2-pins holds a JSON array of ids, in pin order', async ({ page }) => {
    await openMap(page);
    expect(await ls(page, 'hai-map-v2-pins')).toBe('[]');
    notAlphabetical(PIN_ORDER);
    for (const id of PIN_ORDER) await pinFromCard(page, id);
    // The stored array is written from `state.pins` at a different site than the
    // rendered list, so it needs its own order assertion.
    expect(JSON.parse(await ls(page, 'hai-map-v2-pins'))).toEqual(PIN_ORDER);
    await page.click(`#pin-list [data-unpin="${DLR}"]`);
    expect(JSON.parse(await ls(page, 'hai-map-v2-pins'))).toEqual([SAE, REVERE]);
  });

  test('§13 stored pins come back on the next visit', async ({ page }) => {
    await openMap(page, { storage: { 'hai-map-v2-pins': JSON.stringify([REVERE, SAE]) } });
    expect((await snapshot(page)).pins).toBe(2);
    expect((await pinUi(page)).rows).toEqual([REVERE, SAE]);
    expect((await pinUi(page)).count).toBe('2');
    // Restored pins are enough to enter My map — the gate is the count, not the session.
    await page.click('#mymap-btn');
    await settleCounts(page);
    expect((await snapshot(page)).myMap).toBe(true);
  });

  test('§13 a corrupted pins value stops the page dead', async ({ page }) => {
    // Not a spec deviation — §13 promises only that the page survives storage
    // that *throws*, and lsGet does swallow that. But the value it returns is
    // handed straight to JSON.parse inside the `state` initialiser, outside any
    // guard, so one corrupted entry (a half-written value, a key another tool
    // reused) takes the whole script down before first paint. Asserting what
    // happens today, so that hardening it shows up here as a change.
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(String(e)));
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1', 'hai-map-v2-pins': 'not json' }, wait: false });
    await page.waitForFunction(() => document.readyState === 'complete');
    await expect(page.locator('#search')).toBeAttached();        // the markup is there
    await expect(page.locator('#st-note')).toBeEmpty();          // the script is not
    expect(crashes.join(' ')).toContain('JSON');
  });

  test('§13 a stale stored pin is counted by the badge but has no row to show', async ({ page }) => {
    // SPEC-DEVIATION: §13 says unknown ids are filtered out on read (stated for
    // the URL). The localStorage path does not filter: `state.pins` keeps the
    // dead id, so the pill badge (state.pins.size) and the sidebar count
    // (resolved entities) disagree, and the dead id is written back out again.
    await openMap(page, { storage: { 'hai-map-v2-pins': JSON.stringify([DLR, 'no-such-entity']) } });
    const ui = await pinUi(page);
    expect(ui.badge).toBe('2');
    expect(ui.count).toBe('1');
    expect(ui.rows).toEqual([DLR]);
    expect(JSON.parse(await ls(page, 'hai-map-v2-pins'))).toEqual([DLR, 'no-such-entity']);
  });

  test('§13 the first pin explains itself once, and only once', async ({ page }) => {
    await openMap(page);
    expect(await ls(page, 'hai-map-v2-hint-pin')).toBe(null);
    await pinFromCard(page, DLR);
    expect(await toastText(page)).toBe('Pinned ★ — find your selection under “My map”.');
    expect(await ls(page, 'hai-map-v2-hint-pin')).toBe('1');
  });

  test('§13 a reader who has seen the pin hint is not shown it again', async ({ page }) => {
    await openMap(page, { storage: { 'hai-map-v2-hint-pin': '1' } });
    await pinFromCard(page, DLR);
    expect(await toastText(page)).toBe(null);
  });
});

// ============================================================= sharing

test.describe('§13 sharing — the URL fragment', () => {
  test('§13 the default view shares a bare link with no fragment at all', async ({ page }) => {
    await openMap(page);
    await stubClipboard(page);
    const url = await copiedLink(page);
    expect(url).not.toContain('#');
    const base = await page.evaluate(() => location.origin + location.pathname);
    expect(url).toBe(`${base}?lang=en`);
  });

  test('§13 pins= carries the pinned ids, in pin order', async ({ page }) => {
    await openMap(page);
    notAlphabetical(PIN_ORDER);
    for (const id of PIN_ORDER) await pinFromCard(page, id);
    await page.evaluate(() => closeDetail());
    await stubClipboard(page);
    // A shared link is read by someone else: the order it carries is the only
    // record of what the sender put first.
    expect(fragmentOf(await copiedLink(page))).toBe(`pins=${PIN_ORDER.join(',')}`);
  });

  test('§13 e= carries the open card', async ({ page }) => {
    await openMap(page);
    await page.evaluate((id) => openEntity(id), SAE);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe(`e=${SAE}`);
  });

  test('§13 dom= carries the checked domains, and only when some are off', async ({ page }) => {
    await openMap(page);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe('');   // all on: nothing emitted
    await page.uncheck('[data-dom="energy"]');
    const order = await domainOrder(page);
    const expected = order.filter((d) => d !== 'energy');
    expect(expected.length).toBe(order.length - 1);
    expect(fragmentOf(await copiedLink(page))).toBe('dom=' + expected.join(','));
  });

  test('§13 lay= carries the enabled layers, in layer order', async ({ page }) => {
    await openMap(page);
    await setLayers(page, ['project', 'team', 'framework']);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe('lay=project,team,framework');
  });

  test('§13 links=1 appears only when the whole mesh is drawn', async ({ page }) => {
    await openMap(page);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe('');
    await page.click('#links-row');
    expect(await page.evaluate(() => state.links)).toBe(true);
    expect(fragmentOf(await copiedLink(page))).toBe('links=1');
  });

  test('§13 my=1 rides along with the pins it needs', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, REVERE);
    await page.evaluate(() => closeDetail());
    await page.click('#mymap-btn');
    await settleCounts(page);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe(`pins=${REVERE}&my=1`);
  });

  test('§13 yr= carries the period, and only when the range is narrowed', async ({ page }) => {
    await openMap(page);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe('');   // the full span is the default
    await setPeriod(page, 2016, 2021);
    await settleCounts(page);
    expect(fragmentOf(await copiedLink(page))).toBe('yr=2016,2021');
  });

  test('§13 nd=0 travels on its own once the range is back to full', async ({ page }) => {
    await openMap(page);
    // The unknown-start switch only appears once a range is engaged, so narrow
    // the period, untick it, then widen back: nd=0 must outlive yr=.
    await setPeriod(page, 2016, 2021);
    await page.uncheck('#tf-undated');
    const { ymin, ymax } = await page.evaluate(() => ({ ymin: YMIN, ymax: YMAX }));
    await setPeriod(page, ymin, ymax);
    await settleCounts(page);
    expect(await page.evaluate(() => state.years.undated)).toBe(false);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe('nd=0');
  });

  test('§13 every parameter at once, in the documented order', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, REVERE);
    await pinFromCard(page, DLR);
    await page.evaluate((id) => openEntity(id), AZUR);
    await page.uncheck('[data-dom="energy"]');
    await setLayers(page, ['project', 'team', 'framework']);
    await page.click('#links-row');
    await page.click('#mymap-btn');
    await setPeriod(page, 2016, 2021);
    await page.uncheck('#tf-undated');
    await settleCounts(page);

    const doms = (await domainOrder(page)).filter((d) => d !== 'energy').join(',');
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe(
      [`pins=${REVERE},${DLR}`, `e=${AZUR}`, `dom=${doms}`, 'lay=project,team,framework',
        'links=1', 'my=1', 'yr=2016,2021', 'nd=0'].join('&'));
  });

  test('§13 a full round trip restores the identical state', async ({ page }) => {
    await openMap(page);
    // Pinned backwards on purpose: `fullState` compares the pin arrays, so with
    // an alphabetical fixture the round trip would survive a fragment that
    // silently reordered them.
    await pinFromCard(page, DLR);
    await pinFromCard(page, REVERE);
    await page.evaluate((id) => openEntity(id), AZUR);
    await page.uncheck('[data-dom="energy"]');
    await setLayers(page, ['project', 'team', 'framework']);
    await page.click('#links-row');
    await setPeriod(page, 2016, 2021);
    await page.uncheck('#tf-undated');
    await settleCounts(page);
    const before = await fullState(page);

    await stubClipboard(page);
    const url = await copiedLink(page);

    // A fresh visit with nothing in storage: the link alone must rebuild it.
    const u = new URL(url);
    await reopen(page, { lang: u.searchParams.get('lang'), hash: u.hash });
    await settleCounts(page);
    expect(await fullState(page)).toEqual(before);
  });

  test('§13 My map survives the round trip too', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, REVERE);
    await page.evaluate(() => closeDetail());
    await page.click('#mymap-btn');
    await settleCounts(page);
    const before = await fullState(page);
    await stubClipboard(page);
    const u = new URL(await copiedLink(page));
    await reopen(page, { lang: u.searchParams.get('lang'), hash: u.hash });
    await settleCounts(page);
    expect(await fullState(page)).toEqual(before);
  });

  test('§11 the copy is confirmed in words a reader can act on', async ({ page }) => {
    await openMap(page);
    await stubClipboard(page);
    await copiedLink(page);
    // The confirmation is written in the clipboard promise's resolve handler, so
    // wait on the toast rather than sampling it.
    await expect(page.locator('#toast')).toHaveText('Link copied — it restores your pins and the current view.');
    await expect(page.locator('#toast')).toHaveClass(/show/);
  });

  test('§11 with no clipboard the same URL is offered through a prompt instead', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, DLR);
    await page.evaluate(() => closeDetail());
    await stubClipboard(page, { fail: true });
    await page.click('#share-btn');
    await page.waitForFunction(() => window.__prompted !== null);
    const offered = await page.evaluate(() => window.__prompted);
    expect(fragmentOf(offered)).toBe(`pins=${DLR}`);
    expect(await page.evaluate(() => window.__copied)).toBe(null);
  });
});

// ======================================================= deep links on read

test.describe('§13 deep links', () => {
  test('§13 pins=, e= and dom= from a hand-written link', async ({ page }) => {
    await openMap(page, { hash: `#pins=${REVERE},${DLR}&e=${SAE}&dom=energy,rail` });
    await settleCounts(page);
    const s = await fullState(page);
    expect(s.pins).toEqual([REVERE, DLR]);
    expect(s.focusId).toBe(SAE);
    expect(s.domains).toEqual(['energy', 'rail']);
    await expect(cardName(page)).toHaveText('SAE J3016 — Levels of Driving Automation');
  });

  test('§13 unknown pin ids are dropped on read', async ({ page }) => {
    await openMap(page, { hash: `#pins=${DLR},no-such-entity,also-gone` });
    expect((await fullState(page)).pins).toEqual([DLR]);
    expect((await pinUi(page)).badge).toBe('1');
  });

  test('§13 an unknown e= leaves the map with no card open', async ({ page }) => {
    await openMap(page, { hash: '#e=no-such-entity' });
    expect((await snapshot(page)).focusId).toBe(null);
    expect(await page.evaluate(() => detail.classList.contains('open'))).toBe(false);
  });

  test('§13 unknown domain codes are dropped, and an all-unknown dom= falls back to every domain', async ({ page }) => {
    await openMap(page, { hash: '#dom=energy,not-a-domain' });
    expect((await fullState(page)).domains).toEqual(['energy']);
    const all = await domainOrder(page);
    await reopen(page, { hash: '#dom=not-a-domain,nor-this' });
    await settleCounts(page);
    expect((await fullState(page)).domains).toEqual(all);
    // The fallback is what keeps a stale link from showing an empty map.
    expect((await snapshot(page)).matchCount).toBeGreaterThan(0);
  });

  test('§13 an unknown lay= empties the map instead of degrading', async ({ page }) => {
    // SPEC-DEVIATION: §13 says "Unknown ids and codes are filtered out on read,
    // so a stale link degrades to a sensible view instead of an empty map."
    // `dom=` has that guard; `lay=` does not — it assigns
    // `layers[k] = lay.split(',').includes(k)` for every layer, so a fragment
    // carrying only unrecognised codes switches all four layers off and the map
    // goes blank. Asserting today's behaviour, not blessing it.
    await openMap(page, { hash: '#lay=teams,projets' });   // plausible stale spellings
    await settleCounts(page);
    const s = await fullState(page);
    expect(s.layers).toEqual({ project: false, team: false, commons: false, framework: false });
    expect(s.matchCount).toBe(0);
  });

  test('§13 a partly-known lay= keeps the layers it recognises', async ({ page }) => {
    await openMap(page, { hash: '#lay=team,not-a-layer' });
    await settleCounts(page);
    expect((await fullState(page)).layers)
      .toEqual({ project: false, team: true, commons: false, framework: false });
    const totals = await payloadTotals(page);
    expect((await snapshot(page)).matchCount).toBe(totals.team);
  });

  test('§13 yr= outside the axis is clamped to the axis', async ({ page }) => {
    await openMap(page, { hash: '#yr=1800,3000' });
    const { ymin, ymax } = await page.evaluate(() => ({ ymin: YMIN, ymax: YMAX }));
    expect((await fullState(page)).years).toEqual({ a: ymin, b: ymax, undated: true });
    // Clamped back to the full span, so nothing is narrowed and nothing is lost.
    const totals = await payloadTotals(page);
    await settleCounts(page);
    expect((await snapshot(page)).matchCount)
      .toBe(totals.project + totals.team + totals.commons + totals.framework);
  });

  test('§13 a non-numeric yr= is ignored', async ({ page }) => {
    await openMap(page, { hash: '#yr=early,later' });
    const { ymin, ymax } = await page.evaluate(() => ({ ymin: YMIN, ymax: YMAX }));
    expect((await fullState(page)).years).toEqual({ a: ymin, b: ymax, undated: true });
  });

  test('§13 the period floor and ceiling round-trip exactly', async ({ page }) => {
    const probe = await openMap(page);
    const { ymin, ymax } = await probe.evaluate(() => ({ ymin: YMIN, ymax: YMAX }));
    await reopen(page, { hash: `#yr=${ymin},${ymin}` });
    expect((await fullState(page)).years).toMatchObject({ a: ymin, b: ymin });
    await reopen(page, { hash: `#yr=${ymax},${ymax}` });
    expect((await fullState(page)).years).toMatchObject({ a: ymax, b: ymax });
  });

  test('§13 nd=0 excludes the undated entities on read', async ({ page }) => {
    await openMap(page, { hash: '#nd=0' });
    await settleCounts(page);
    expect(await page.evaluate(() => state.years.undated)).toBe(false);
    await expect(page.locator('#tf-undated')).not.toBeChecked();
  });

  test('§13 my=1 without a surviving pin does not enter My map', async ({ page }) => {
    await openMap(page, { hash: '#my=1' });
    expect((await snapshot(page)).myMap).toBe(false);
    await reopen(page, { hash: '#pins=no-such-entity&my=1' });
    expect((await snapshot(page)).myMap).toBe(false);
    expect((await snapshot(page)).pins).toBe(0);
  });

  test('§13 a link\'s pins are added to the ones already stored', async ({ page }) => {
    await openMap(page, { hash: `#pins=${DLR}`, storage: { 'hai-map-v2-pins': JSON.stringify([REVERE]) } });
    expect((await fullState(page)).pins).toEqual([REVERE, DLR]);
  });
});

// ================================================================ print

test.describe('§11 print', () => {
  test('§11 with nothing pinned the sheet is everything visible, grouped by layer with counts', async ({ page }) => {
    await openMap(page);
    await stubPrint(page);
    const sheet = await printSheet(page);
    const totals = await payloadTotals(page);
    expect(sheet.printed).toBe(1);
    expect(sheet.groups.map((g) => g.heading)).toEqual([
      `Projects & programmes (${totals.project})`,
      `Teams (${totals.team})`,
      `Commons (${totals.commons})`,
      `Frameworks (${totals.framework})`,
    ]);
    expect(sheet.groups.map((g) => g.items.length))
      .toEqual([totals.project, totals.team, totals.commons, totals.framework]);
    expect(sheet.total).toBe(totals.project + totals.team + totals.commons + totals.framework);
    expect(sheet.sub.startsWith('Starting views · ')).toBe(true);
  });

  test('§11 with pins the sheet is the pins, grouped by layer, counted', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, AZUR);
    await pinFromCard(page, SAE);
    await pinFromCard(page, DLR);
    await stubPrint(page);
    const sheet = await printSheet(page);
    expect(sheet.groups.map((g) => g.heading))
      .toEqual(['Projects & programmes (1)', 'Teams (1)', 'Frameworks (1)']);
    expect(sheet.total).toBe(3);
    expect(sheet.sub.startsWith('My map · ')).toBe(true);
    expect(sheet.title).toBe('Human–AI Collaboration in Europe');
  });

  test('§11 a layer with no pinned entity gets no heading', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, SAE);
    await stubPrint(page);
    const sheet = await printSheet(page);
    expect(sheet.groups.map((g) => g.heading)).toEqual(['Frameworks (1)']);
    expect(sheet.groups[0].items.map((i) => i.name)).toEqual(['SAE J3016 — Levels of Driving Automation']);
  });

  test('§11 each entry carries its place, its dates, its description and its link', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, AZUR);
    await stubPrint(page);
    const item = (await printSheet(page)).groups[0].items[0];
    expect(item.name).toBe("3IA Côte d'Azur");
    expect(item.meta).toBe('— Sophia Antipolis, FR · 2019–2027');
    expect(item.link).toBe('https://3ia.univ-cotedazur.eu/');
    const desc = await page.evaluate((id) =>
      window.HAI_DATA.PROJECTS.find((d) => d.id === id).desc_en, AZUR);
    expect(item.desc).toBe(desc);
  });

  test('§11 an entry whose description has only a bare desc still prints one', async ({ page }) => {
    // §11 says the sheet carries descriptions; four teams in the payload have a
    // bare `desc` and no `desc_en` at all (§12's fallback chain). The sheet
    // renders `desc_<LANG> || desc`, and dropping the second half empties the
    // paragraph for exactly those four — invisible to every other print test,
    // because the fixtures they pin all carry a language key.
    await openMap(page);
    const d = await page.evaluate((id) => {
      const x = window.HAI_DATA.TEAMS.find((t) => t.id === id);
      return { desc: x.desc || null, desc_en: x.desc_en ?? null, desc_fr: x.desc_fr ?? null };
    }, FLAT);
    expect(d.desc_en).toBe(null);               // the fixture really has no language key
    expect(d.desc_fr).toBe(null);
    expect(d.desc.length).toBeGreaterThan(40);
    await pinFromCard(page, FLAT);
    await stubPrint(page);
    const sheet = await printSheet(page);
    expect(sheet.groups.map((g) => g.heading)).toEqual(['Teams (1)']);
    const item = sheet.groups[0].items[0];
    expect(item.name).toBe('Flatland Association');
    expect(item.desc).toBe(d.desc);
  });

  test('§11 an entry with no place prints an empty meta rather than a stray comma', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, SAE);
    await stubPrint(page);
    const item = (await printSheet(page)).groups[0].items[0];
    expect(item.meta).toBe('— ');
  });

  test('§11 the pinned sheet ignores the filters — a pin hidden by a filter still prints', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, SAE);                 // a framework
    await page.evaluate(() => closeDetail());
    await setLayers(page, ['project']);           // frameworks are off the map now
    await settleCounts(page);
    expect(await page.evaluate((id) => state.inFilter.has(id), SAE)).toBe(false);
    await stubPrint(page);
    const sheet = await printSheet(page);
    expect(sheet.groups.map((g) => g.heading)).toEqual(['Frameworks (1)']);
    expect(sheet.total).toBe(1);
  });

  test('§11 the unpinned sheet follows the filters', async ({ page }) => {
    await openMap(page);
    await setLayers(page, ['commons']);
    await settleCounts(page);
    await stubPrint(page);
    const sheet = await printSheet(page);
    const totals = await payloadTotals(page);
    expect(sheet.groups.map((g) => g.heading)).toEqual([`Commons (${totals.commons})`]);
    expect(sheet.total).toBe(totals.commons);
  });

  test('§11 nothing pinned and nothing visible prints a sheet with no entries', async ({ page }) => {
    await openMap(page);
    await setLayers(page, []);
    await settleCounts(page);
    await stubPrint(page);
    const sheet = await printSheet(page);
    expect(sheet.groups).toEqual([]);
    expect(sheet.total).toBe(0);
    expect(sheet.title).toBe('Human–AI Collaboration in Europe');   // still a sheet, just empty
  });

  test('§11 the print sheet never shows on screen', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, DLR);
    await stubPrint(page);
    const sheet = await printSheet(page);
    expect(sheet.visibleOnScreen).toBe(false);
    await expect(page.locator('#print-sheet')).toBeHidden();
    expect(sheet.total).toBe(1);                  // hidden, but populated
  });

  test('§11 under print media the sheet replaces the interface', async ({ page }) => {
    // The counterpart of the on-screen check: emulating print media is the only
    // way to see what the reader's printer gets — the sheet visible, and the
    // whole application chrome (#app, overlays, toasts) gone.
    await openMap(page);
    await pinFromCard(page, AZUR);
    await stubPrint(page);
    await printSheet(page);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#print-sheet')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.locator('#print-sheet .ps-item b')).toHaveText("3IA Côte d'Azur");
    await page.emulateMedia({ media: 'screen' });
    await expect(page.locator('#print-sheet')).toBeHidden();
  });

  test('§11 printing twice reprints from the current selection', async ({ page }) => {
    await openMap(page);
    await pinFromCard(page, DLR);
    await stubPrint(page);
    expect((await printSheet(page)).total).toBe(1);
    await pinFromCard(page, SAE);
    const second = await printSheet(page);
    expect(second.printed).toBe(2);
    expect(second.total).toBe(2);
  });
});

// ==================================================== §13 other storage keys

test.describe('§13 localStorage keys and their defaults', () => {
  test('§13 a first visit writes none of the reader keys except the empty pin list', async ({ page }) => {
    await openRaw(page);
    expect(await ls(page, 'hai-map-lang')).toBe(null);
    expect(await ls(page, 'hai-map-v2-feed')).toBe(null);
    expect(await ls(page, 'hai-map-v2-hint-click')).toBe(null);
    expect(await ls(page, 'hai-map-v2-hint-pin')).toBe(null);
    // renderPins() runs on first paint and persists the (empty) selection.
    expect(await ls(page, 'hai-map-v2-pins')).toBe('[]');
  });

  test('§13 hai-map-v2-seen: absent means the welcome screen, and closing it records that', async ({ page }) => {
    await openRaw(page);
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    expect(await ls(page, 'hai-map-v2-seen')).toBe(null);
    await page.click('#w-explore');
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);
    expect(await ls(page, 'hai-map-v2-seen')).toBe('1');
    expect(await ls(page, 'hai-map-v2-hint-click')).toBe('1');
  });

  test('§13 hai-map-v2-seen: set means straight to the map', async ({ page }) => {
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1' } });
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);
  });

  test('§13 a deep link to a card skips the welcome and records it as seen', async ({ page }) => {
    // A shared link lands the reader on someone else's card; an intro overlay
    // on top of it would hide the thing they followed the link for.
    await openRaw(page, { hash: `#e=${DLR}` });
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);
    expect(await ls(page, 'hai-map-v2-seen')).toBe('1');
    expect((await snapshot(page)).focusId).toBe(DLR);
  });

  test('§13 hai-map-v2-feed defaults to shown on a wide window and is written when toggled', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1' } });
    expect(await page.evaluate(() => state.feed)).toBe(true);
    await expect(page.locator('body')).toHaveClass(/feed-open/);
    await page.click('#feed-pill');
    expect(await ls(page, 'hai-map-v2-feed')).toBe('0');
    expect(await page.evaluate(() => state.feed)).toBe(false);
    await page.click('#feed-pill');
    expect(await ls(page, 'hai-map-v2-feed')).toBe('1');
  });

  test('§13 hai-map-v2-feed defaults to hidden on a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1' } });
    expect(await page.evaluate(() => state.feed)).toBe(false);
    await expect(page.locator('body')).not.toHaveClass(/feed-open/);
  });

  test('§13 a stored hai-map-v2-feed beats the window width', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1', 'hai-map-v2-feed': '1' } });
    expect(await page.evaluate(() => state.feed)).toBe(true);
  });

  test('§13 hai-map-lang: ?lang wins over the stored language', async ({ page }) => {
    await openRaw(page, { lang: 'en', seed: { 'hai-map-v2-seen': '1', 'hai-map-lang': 'fr' } });
    expect(await page.evaluate(() => LANG)).toBe('en');
  });

  test('§13 hai-map-lang: the stored language is used when the URL says nothing', async ({ page }) => {
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1', 'hai-map-lang': 'fr' } });
    expect(await page.evaluate(() => LANG)).toBe('fr');
    await expect(page.locator('#print-btn')).toHaveText('Imprimer la liste');
  });

  test('§13 switching language writes hai-map-lang', async ({ page }) => {
    await openRaw(page, { lang: 'en', seed: { 'hai-map-v2-seen': '1' } });
    await page.click('.lang-switch [data-lang="fr"]');
    expect(await ls(page, 'hai-map-lang')).toBe('fr');
    expect(await page.evaluate(() => LANG)).toBe('fr');
  });

  test('§13 a junk stored language is ignored and the browser decides instead', async ({ page }) => {
    await openRaw(page, { seed: { 'hai-map-v2-seen': '1', 'hai-map-lang': 'klingon' } });
    const got = await page.evaluate(() => ({ lang: LANG, nav: (navigator.language || 'en').toLowerCase() }));
    // §13's order is ?lang → localStorage → browser language → English; with the
    // first two unusable the third decides, so the expectation comes from the
    // browser rather than from a hard-coded 'en'.
    expect(got.lang).toBe(got.nav.startsWith('fr') ? 'fr' : 'en');
  });
});

// ======================================================= §13 private mode

test.describe('§13 private mode — storage that throws', () => {
  // Every read and write goes through lsGet/lsSet, which swallow exceptions.
  // The claim is not that those two functions are wrapped — it is that the page
  // still works when they always fail, which is what a locked-down browser or a
  // third-party iframe with cookies blocked actually does. The map ships inside
  // an iframe on the site, so this is the real deployment, not a corner case.
  const deny = () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  };

  test('§13 the page boots with no storage at all', async ({ page }) => {
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(String(e)));
    await openRaw(page, { init: deny, lang: 'en' });
    expect(await ls(page, 'hai-map-v2-pins')).toBe('THREW');   // storage really is refused
    expect(crashes).toEqual([]);
    // Unreadable storage means an unreadable "seen" flag, so the welcome opens.
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    const totals = await payloadTotals(page);
    expect((await snapshot(page)).matchCount)
      .toBe(totals.project + totals.team + totals.commons + totals.framework);
    expect((await snapshot(page)).pins).toBe(0);
  });

  test('§13 pinning still works in memory when it cannot be persisted', async ({ page }) => {
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(String(e)));
    await openRaw(page, { init: deny, lang: 'en' });
    // With storage refused, the "already seen" flag is unreadable, so the welcome
    // screen greets this reader every time. Dismissing it is part of the
    // scenario: it also proves the overlay closes without being able to record
    // that it did.
    await page.click('#w-explore');
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);
    await pinFromCard(page, REVERE);
    expect((await pinUi(page)).rows).toEqual([REVERE]);
    expect((await pinUi(page)).badge).toBe('1');
    await page.evaluate(() => closeDetail());
    await page.click('#mymap-btn');
    await settleCounts(page);
    expect((await snapshot(page)).myMap).toBe(true);
    expect(crashes).toEqual([]);
  });

  test('§13 search, sharing and printing all survive private mode', async ({ page }) => {
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(String(e)));
    await openRaw(page, { init: deny, lang: 'en' });
    await page.click('#w-explore');
    await type(page, 'deutsches zentrum');
    await dropOpen(page);
    expect((await rows(page)).map((r) => r.id)).toEqual([DLR]);
    await page.click(`#search-drop [data-open="${DLR}"]`);
    expect((await snapshot(page)).focusId).toBe(DLR);
    await stubClipboard(page);
    expect(fragmentOf(await copiedLink(page))).toBe(`e=${DLR}`);
    await stubPrint(page);
    expect((await printSheet(page)).printed).toBe(1);
    expect(crashes).toEqual([]);
  });

  test('§13 a deep link still restores the view when storage is refused', async ({ page }) => {
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(String(e)));
    await openRaw(page, { init: deny, lang: 'en', hash: `#pins=${REVERE},${DLR}&lay=team&links=1&my=1` });
    await settleCounts(page);
    const s = await fullState(page);
    expect(s.pins).toEqual([REVERE, DLR]);
    expect(s.links).toBe(true);
    expect(s.myMap).toBe(true);
    expect(crashes).toEqual([]);
  });
});
