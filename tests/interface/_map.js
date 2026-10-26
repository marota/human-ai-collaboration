// Shared helpers for the ecosystem-map interface tests.
//
// The page is a single classic <script>, so its top-level `const` bindings
// (state, items, byId, KINDS, I18N, view…) live in the global lexical
// environment rather than on `window`. page.evaluate() runs its function in
// that same global scope, so a bare `state` resolves — no instrumentation of
// the page under test is needed, and the tests exercise exactly the file that
// ships.
import { expect } from '@playwright/test';

// MAP_PATH lets a mutation run point the whole suite at a doctored copy of the
// page placed next to the real one (so its relative <script src> still
// resolves). Everything else defaults to the committed artefact.
export const MAP_PATH = process.env.MAP_PATH || '/assets/map/eu-hai-map.html';

/** Open the map, wait for first paint of the data-driven UI, and clear
 *  any persisted reader state so each test starts from the documented default. */
export async function openMap(page, { lang = 'en', hash = '', storage = null } = {}) {
  // localStorage is per-origin; seed it before the page's boot code reads it.
  await page.addInitScript((seed) => {
    try {
      localStorage.clear();
      // Suppress the first-visit welcome overlay unless a test asks for it.
      localStorage.setItem('hai-map-v2-seen', '1');
      if (seed) for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    } catch { /* private mode — the page must cope, and so must the test */ }
  }, storage);

  await page.goto(`${MAP_PATH}?lang=${lang}${hash}`);
  // The stats caption is written by the first refresh(); its presence means
  // boot finished (data parsed, markers drawn, counters computed).
  await expect(page.locator('#st-note')).not.toBeEmpty();
  return page;
}

/** The page's own state object, plus the derived figures the spec talks about. */
export function snapshot(page) {
  return page.evaluate(() => ({
    inView: state.inView.size,
    inFilter: state.inFilter.size,
    matchCount: state.matchCount,
    offScreen: state.offScreen,
    offMapMatch: state.offMapMatch,
    keptOpen: state.keptOpen,
    myMap: state.myMap,
    focusId: state.focusId,
    pins: state.pins.size,
    layers: { ...state.layers },
    domains: [...state.domains],
    years: { ...state.years },
    links: state.links,
  }));
}

/** The four header tiles, as rendered. */
export function tiles(page) {
  return page.evaluate(() =>
    KINDS.map((k) => ({
      kind: k,
      count: Number(document.getElementById('st-' + k).textContent),
      label: document.getElementById('st-' + k).parentNode.querySelector('span').textContent,
      title: document.getElementById('st-' + k).parentNode.title,
    })));
}

/** The layer rows, as rendered. */
export function layerRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.layer-row[data-layer]')].map((b) => ({
      kind: b.dataset.layer,
      count: Number(b.querySelector('.cnt').textContent),
      title: b.querySelector('.cnt').title,
      on: b.getAttribute('aria-pressed') === 'true',
      label: b.querySelector('.lbl').textContent,
    })));
}

export const caption = (page) => page.locator('#st-note').textContent();

/** Toggle a layer through its actual control, not by poking state. */
export async function toggleLayer(page, kind) {
  await page.click(`.layer-row[data-layer="${kind}"]`);
}

export async function setLayers(page, wanted) {
  const rows = await layerRows(page);
  for (const r of rows) if (r.on !== wanted.includes(r.kind)) await toggleLayer(page, r.kind);
}

/** Drive the period slider by keyboard, the way §14 says it must be operable. */
export async function nudgePeriod(page, which, key, times = 1) {
  const knob = page.locator(which === 'a' ? '#tf-a' : '#tf-b');
  await knob.focus();
  for (let i = 0; i < times; i++) await knob.press(key);
}

export const periodLabel = (page) => page.locator('#tf-range').textContent();

/** Set the period directly, for tests about the consequences rather than the control. */
export async function setPeriod(page, a, b) {
  await page.evaluate(([x, y]) => setYears(x, y), [a, b]);
}

export async function applyPreset(page, id) {
  await page.click(`#presets [data-preset="${id}"]`);
}

/** Open an entity the way a reader would: through search. */
export async function openViaSearch(page, query, index = 0) {
  await page.fill('#search', query);
  const items = page.locator('.sd-item');
  await expect(items.first()).toBeVisible();
  await items.nth(index).click();
}

/** Invariant 12: in view + off screen + off the map == matches the filters
 *  + any card the filters exclude but that is kept open (§9.2). */
export async function expectCountersReconcile(page, because = '') {
  const s = await snapshot(page);
  expect(s.inView + s.offScreen + s.offMapMatch,
    `counters must reconcile${because ? ' — ' + because : ''}`)
    .toBe(s.matchCount + s.keptOpen);
  const t = await tiles(page);
  expect(t.reduce((a, x) => a + x.count, 0),
    `the four tiles must sum to what is in view${because ? ' — ' + because : ''}`)
    .toBe(s.inView);
}

/** Wait out the 90 ms debounce on pan/zoom recounts (§9.2). */
export async function settleCounts(page) {
  await page.waitForFunction(() => ivTimer === null);
}

export async function zoomBy(page, factor) {
  await page.evaluate((f) => setView({ k: view.k * f, x: view.x, y: view.y }, false), factor);
  await settleCounts(page);
}

export async function fitAll(page) {
  await page.evaluate(() => fitView(false));
  await settleCounts(page);
}
