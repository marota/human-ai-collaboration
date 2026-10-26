// §12 bilingual model · invariant 8.
//
// Two claims are under test here, and they fail in different ways.
//
// The first is structural: every user-visible string goes through `t()` and
// exists in both language blocks. That one can be checked without rendering
// anything — compare the key sets, then compare them against every key the
// markup and the script actually ask for. A key present in one block only does
// not throw; it silently serves English to a French reader, or the raw key.
//
// The second is behavioural: `applyLang()` has to re-render *every* dynamic
// surface, because half this interface is written by JavaScript after boot and
// `[data-i18n]` cannot reach it. The spec lists the surfaces — presets, layer
// rows, domain groups, legend, pins, off-the-map list, period control, the open
// card — and the expensive bug is a surface left off that list: the reader
// switches language and one panel stays in the other one, usually the one they
// were reading. So each surface gets its own test, with a card open at the
// time, since the open card is the surface most easily forgotten.
//
// The verb-agreement functions get their own block. They were fixed by hand
// ("1 matches" / "25 match", "0 correspond" / "25 correspondent") and nothing
// else in the page would notice them rotting back.
import { test, expect } from '@playwright/test';
import {
  openMap, snapshot, tiles, layerRows, caption, setLayers, settleCounts,
  zoomBy, fitAll, expectCountersReconcile, MAP_PATH,
} from './_map.js';

// ---------------------------------------------------------------- local helpers

// openMap() always pins the language with `?lang=`, which is exactly what the
// resolution-order tests must not do. bootMap is the same boot sequence with
// the query string left to the caller, plus the two overrides those tests need:
// a browser language, and a localStorage that throws (private mode).
async function bootMap(page, { search = '', storage = null, seen = true, navLang, privateMode = false } = {}) {
  await page.addInitScript(({ seed, seenFlag, nav, priv }) => {
    if (priv) {
      // Safari's private mode and "block all cookies" both make this throw on
      // access rather than return null. §13: every read and write goes through
      // lsGet/lsSet, which swallow it.
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('denied', 'SecurityError'); },
      });
    } else {
      try {
        localStorage.clear();
        if (seenFlag) localStorage.setItem('hai-map-v2-seen', '1');
        if (seed) for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
      } catch { /* not reachable here, but the page must cope either way */ }
    }
    if (nav !== undefined) Object.defineProperty(navigator, 'language', { configurable: true, get: () => nav });
  }, { seed: storage, seenFlag: seen, nav: navLang, priv: privateMode });
  await page.goto(MAP_PATH + search);
  await expect(page.locator('#st-note')).not.toBeEmpty();
}

const langOf = (page) => page.evaluate(() => LANG);

/** Switch language through the control a reader uses, not by calling applyLang(). */
async function switchLang(page, lang) {
  await page.click(`.lang-switch button[data-lang="${lang}"]`);
  await expect(page.locator(`.lang-switch button[data-lang="${lang}"]`)).toHaveClass(/is-active/);
}

/** Same, for the layouts where CSS puts something on top of the control.
 *  `body.detail-open .ctl-tr{display:none}` hides the whole top-right cluster —
 *  period slider, pills and language switch — while the floating card is open,
 *  so the click has to be dispatched rather than aimed. */
async function switchLangDispatched(page, lang) {
  await page.locator(`.lang-switch button[data-lang="${lang}"]`).dispatchEvent('click');
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}

/** Click an element the layout has buried under a floating cluster. */
const clickBuried = (page, sel) => page.locator(sel).dispatchEvent('click');

/** Both I18N blocks, flattened to what a test can compare. */
const i18n = (page) => page.evaluate(() => ({
  fr: I18N.fr, en: I18N.en,
  frKeys: Object.keys(I18N.fr).sort(), enKeys: Object.keys(I18N.en).sort(),
  frTypes: Object.fromEntries(Object.entries(I18N.fr).map(([k, v]) => [k, typeof v])),
  enTypes: Object.fromEntries(Object.entries(I18N.en).map(([k, v]) => [k, typeof v])),
  frArity: Object.fromEntries(Object.entries(I18N.fr).filter(([, v]) => typeof v === 'function').map(([k, v]) => [k, v.length])),
  enArity: Object.fromEntries(Object.entries(I18N.en).filter(([, v]) => typeof v === 'function').map(([k, v]) => [k, v.length])),
}));

/** The inline script as shipped — for the static scan of `t('literal')` calls. */
const scriptSource = (page) => page.evaluate(() =>
  [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent).join('\n'));

/** Every text node a reader can reach, minus the inline script (which of course
 *  contains every key as a literal). Hidden panels are included on purpose: a
 *  superset makes the "no raw key leaks" assertion stronger, not weaker. */
const pageText = (page) => page.evaluate(() =>
  ['#app', '#welcome', '#tour-card', '#print-sheet', '#toast', '#tooltip']
    .map((sel) => document.querySelector(sel))
    .filter(Boolean).map((el) => el.textContent).join('\n'));

/** Every label a screen reader or a tooltip could read out, hidden ones included
 *  — for the leakage scan, where a superset is the stronger assertion. */
const pageLabels = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#app [title], #app [aria-label], #app [placeholder], #welcome [title], #welcome [aria-label]')]
    .flatMap((el) => ['title', 'aria-label', 'placeholder'].map((a) => el.getAttribute(a)))
    .filter(Boolean));

/** The same, minus the `hidden` elements. A hidden hint keeps whatever text it
 *  last carried — `renderFeed()` only rewrites "+ N off screen" when there is
 *  an N to write — so those labels are stale by design and out of the a11y
 *  tree; counting them would make the language diff below depend on history. */
const visibleLabels = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#app [title], #app [aria-label], #app [placeholder]')]
    .filter((el) => !el.hidden && !el.closest('[hidden]'))
    .flatMap((el) => ['title', 'aria-label', 'placeholder'].map((a) => el.getAttribute(a)))
    .filter(Boolean));

// A key only leaks into the interface as raw text through t()'s last resort, so
// the scan looks for key-shaped strings: a dotted namespace ('sec.focus') or a
// camelCase identifier ('stNote'). Plain-word keys like `title` or `all` are
// excluded — they are also ordinary English and would false-positive.
const KEY_SHAPED = (k) => k.includes('.') || /^[a-z]+[A-Z]/.test(k);

/** Narrow the domain axis to a single domain, through the real controls. */
async function onlyDomain(page, dom) {
  for (const none of await page.locator('#domain-groups [data-ga="none"]').all()) await none.click();
  await page.locator(`#domain-groups input[data-dom="${dom}"]`).check();
}

/** fr-FR currency and dates use U+202F / U+00A0; compare on visible shape. */
const spaces = (s) => s.replace(/[\u00a0\u202f\u2009]/g, ' ');

const textOf = (page, sel) => page.locator(sel).first().textContent();

// Payload facts the assertions below are derived from, rather than read back out
// of the code under test. 460 entities in four layers; 11 of them carry no
// coordinates; 27 countries; the data's freshness date is 2026-10-23.
const CORPUS = 460, NOGEO_TOTAL = 11, COUNTRIES = 27;
// The same, per layer, in KINDS order — the figure a layer row shows with no
// filter narrowing it. Spelled out here so an assertion about a *narrowed*
// count has something to be narrower than.
const LAYER_TOTALS = [115, 274, 26, 45];

// ------------------------------------------------- invariant 8: key parity

test.describe('§16 invariant 8 — both languages, every key', () => {
  test('§16.8 I18N.fr and I18N.en declare exactly the same keys', async ({ page }) => {
    await openMap(page);
    const { frKeys, enKeys } = await i18n(page);
    expect(frKeys.filter((k) => !enKeys.includes(k)), 'French keys with no English twin').toEqual([]);
    expect(enKeys.filter((k) => !frKeys.includes(k)), 'English keys with no French twin').toEqual([]);
    expect(frKeys).toEqual(enKeys);
    // A truncated block would still compare equal to an equally truncated one;
    // the floor is the 159 keys that ship today.
    expect(frKeys.length).toBeGreaterThanOrEqual(159);
  });

  test('§16.8 each key has the same type, and each interpolating key the same arity', async ({ page }) => {
    await openMap(page);
    const { frKeys, frTypes, enTypes, frArity, enArity } = await i18n(page);
    expect(frKeys.filter((k) => frTypes[k] !== enTypes[k])).toEqual([]);
    // "25 match" / "25 correspondent" are functions of n. A French twin taking
    // fewer arguments drops the number silently instead of failing.
    expect(frArity).toEqual(enArity);
  });

  test('§16.8 no key resolves to an empty string in either language', async ({ page }) => {
    await openMap(page);
    const blanks = await page.evaluate(() => {
      const bad = [];
      for (const lang of ['fr', 'en'])
        for (const [k, v] of Object.entries(I18N[lang]))
          if (typeof v === 'string' && v.trim() === '') bad.push(lang + ':' + k);
      return bad;
    });
    expect(blanks).toEqual([]);
  });

  test('§16.8 the badge and dom tables label every domain in both languages', async ({ page }) => {
    await openMap(page);
    const res = await page.evaluate(() => ({
      doms: ALL_DOMS,
      missing: ['fr', 'en'].flatMap((l) => ['badge', 'dom'].flatMap((tbl) =>
        ALL_DOMS.filter((d) => !I18N[l][tbl][d]).map((d) => `${l}.${tbl}.${d}`))),
      extra: ['fr', 'en'].flatMap((l) => ['badge', 'dom'].flatMap((tbl) =>
        Object.keys(I18N[l][tbl]).filter((d) => !ALL_DOMS.includes(d)).map((d) => `${l}.${tbl}.${d}`))),
    }));
    expect(res.doms).toHaveLength(17);          // §17: seventeen domains, three groups
    expect(res.missing).toEqual([]);
    expect(res.extra).toEqual([]);
  });

  test('§16.8 every [data-i18n] key in the markup exists in both blocks, as a string', async ({ page }) => {
    await openMap(page);
    const bad = await page.evaluate(() => {
      const keys = [...document.querySelectorAll('[data-i18n]')].map((el) => el.dataset.i18n);
      const ph = [...document.querySelectorAll('[data-i18n-ph]')].map((el) => el.dataset.i18nPh);
      const out = { missing: [], notString: [], count: keys.length + ph.length };
      for (const k of [...new Set([...keys, ...ph])])
        for (const l of ['fr', 'en']) {
          if (!(k in I18N[l])) out.missing.push(`${l}:${k}`);
          // applyLang() writes the value only when it is a string, so a
          // function-valued key would leave the markup's French default in
          // place — invisible in French, wrong in English.
          else if (typeof I18N[l][k] !== 'string') out.notString.push(`${l}:${k}`);
        }
      return out;
    });
    expect(bad.missing).toEqual([]);
    expect(bad.notString).toEqual([]);
    expect(bad.count).toBeGreaterThanOrEqual(43);
  });

  test('§16.8 every static t() key in the shipped script exists in both blocks', async ({ page }) => {
    await openMap(page);
    const src = await scriptSource(page);
    // `t('foo')` but not `get('foo')` or `it('foo')`.
    const keys = [...new Set([...src.matchAll(/(?<![\w$.'])t\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThanOrEqual(80);
    const { fr, en } = await i18n(page);
    expect(keys.filter((k) => !(k in fr)), 'asked for but missing in French').toEqual([]);
    expect(keys.filter((k) => !(k in en)), 'asked for but missing in English').toEqual([]);
  });

  test('§16.8 every computed key family resolves in both blocks', async ({ page }) => {
    await openMap(page);
    // The interesting keys are the ones built at call time — t('kinds.'+k),
    // t('preset.'+p.id), t('tour.'+s.k+'b'), t(s.key) from relSections(). A
    // static grep cannot see them, so expand them from the real data.
    const families = await page.evaluate(() => ({
      preset: PRESETS.map((p) => 'preset.' + p.id),
      kinds: KINDS.flatMap((k) => ['kind.' + k, 'kinds.' + k, 'wl.' + k]),
      grp: DOM_GROUPS.map((g) => 'grp.' + g.key),
      tour: tourTargets().flatMap((s) => ['tour.' + s.k + 't', 'tour.' + s.k + 'b']),
      rel: [...new Set(items.flatMap((it) => relSections(it).map((s) => s.key)))].sort(),
      slider: ['timeFrom', 'timeTo'],
    }));
    const { fr, en } = await i18n(page);
    const all = Object.values(families).flat();
    expect(families.rel).toEqual(['rel.created', 'rel.createdBy', 'rel.projects', 'rel.teams', 'rel.usedBy', 'rel.uses']);
    expect(families.tour).toHaveLength(8);
    expect(all.filter((k) => !(k in fr))).toEqual([]);
    expect(all.filter((k) => !(k in en))).toEqual([]);
  });

  test('§16.8 an unknown key falls through to the key itself, not to undefined', async ({ page }) => {
    await openMap(page);
    // The documented last resort. It exists so a typo degrades to something
    // greppable rather than to `undefined` in the middle of a sentence.
    expect(await page.evaluate(() => t('no.such.key'))).toBe('no.such.key');
    expect(await page.evaluate(() => String(t('noSuchKey')))).toBe('noSuchKey');
  });
});

// ------------------------------------------------- no untranslated leakage

test.describe('§12 no raw i18n key reaches the reader', () => {
  for (const lang of ['en', 'fr']) {
    test(`§16.8 no key-shaped string appears as visible text or label (${lang})`, async ({ page }) => {
      // Every surface at once: sidebar, map, feed, the open card, and — because
      // the scan is on textContent — the welcome and tour panels too.
      await openMap(page, { lang, hash: '#e=ai4realnet&pins=ai4realnet' });
      await page.click('#tour-btn');
      await expect(page.locator('#tour-card')).toBeVisible();
      const { frKeys } = await i18n(page);
      const suspects = frKeys.filter(KEY_SHAPED);
      expect(suspects.length).toBeGreaterThanOrEqual(60);
      const text = await pageText(page);
      const labels = (await pageLabels(page)).join('\n');
      expect(suspects.filter((k) => text.includes(k)), 'raw keys rendered as text').toEqual([]);
      expect(suspects.filter((k) => labels.includes(k)), 'raw keys rendered as labels').toEqual([]);
    });

    test(`§16.8 no key-shaped string leaks with the feed closed either (${lang})`, async ({ page }) => {
      // The other layout: the floating card instead of the feed column, and the
      // welcome overlay open on top of it.
      await openMap(page, { lang, hash: '#e=ai4realnet', storage: { 'hai-map-v2-feed': '0' } });
      await clickBuried(page, '#intro-btn');
      await expect(page.locator('#welcome')).toHaveClass(/open/);
      const { frKeys } = await i18n(page);
      const suspects = frKeys.filter(KEY_SHAPED);
      expect(suspects.length).toBeGreaterThanOrEqual(60);   // an empty scan proves nothing
      const text = await pageText(page);
      const labels = (await pageLabels(page)).join('\n');
      expect(suspects.filter((k) => text.includes(k))).toEqual([]);
      expect(suspects.filter((k) => labels.includes(k))).toEqual([]);
    });
  }

  test('§12 the search dropdown is translated in both its states', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.fill('#search', 'zzqqxx');                 // two characters, no hits
    await expect(page.locator('.sd-empty')).toHaveText('No matches');
    await page.fill('#search', 'delft');
    await expect(page.locator('.sd-group').first()).toHaveText('Teams');
    await switchLang(page, 'fr');
    await page.fill('#search', 'zzqqxx');
    await expect(page.locator('.sd-empty')).toHaveText('Aucun résultat');
    await page.fill('#search', 'delft');
    await expect(page.locator('.sd-group').first()).toHaveText('Équipes');
  });

  test('§12 the marker tooltip names the layer in the current language', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.locator('.mk[data-id="ai4realnet"]').dispatchEvent('pointerover');
    await expect(page.locator('#tooltip .tt-meta')).toContainText('Project / programme');
    await switchLang(page, 'fr');
    await page.locator('.mk[data-id="ai4realnet"]').dispatchEvent('pointerover');
    await expect(page.locator('#tooltip .tt-meta')).toContainText('Projet / programme');
  });
});

// ------------------------------------------------- applyLang() surface by surface

test.describe('§12 applyLang() re-renders every dynamic surface', () => {
  // Each test opens a card first: the open card is itself one of the surfaces,
  // and having one open is also the state in which a forgotten re-render is
  // most visible to a reader.
  const withCard = (page, lang = 'en') => openMap(page, { lang, hash: '#e=ai4realnet&pins=ai4realnet' });

  test('§12 presets, in the sidebar and on the welcome panel', async ({ page }) => {
    await withCard(page);
    const labels = () => page.locator('#presets [data-preset]').allTextContents();
    expect(await labels()).toEqual(['Overview', 'Energy & grids', 'Aviation & ATM', 'Health', 'Human factors & XAI', 'Simulation & infrastructure']);
    await switchLang(page, 'fr');
    expect(await labels()).toEqual(['Vue d’ensemble', 'Énergie & réseaux', 'Aviation & ATM', 'Santé', 'Facteurs humains & XAI', 'Simulation & infrastructures']);
    // renderPresets() fills two hosts; the welcome copy is easy to forget.
    expect(await page.locator('#w-presets [data-preset]').allTextContents())
      .toEqual(await labels());
  });

  test('§12 layer rows keep their counts and swap their labels', async ({ page }) => {
    await withCard(page);
    expect((await layerRows(page)).map((r) => r.label))
      .toEqual(['Projects & programmes', 'Teams', 'Commons', 'Frameworks']);
    // Narrow the domain axis before reading the counts. Unfiltered, a facet
    // count *is* the corpus total, so "the counts came back unchanged" would
    // hold just as well for a row that had stopped counting and gone back to
    // TOTALS — the regression invariant 13 names. And the expectation is
    // derived from the payload rather than read back out of the counters, so
    // the two sides of the comparison cannot rot together.
    await onlyDomain(page, 'aviation');
    await settleCounts(page);
    const want = await page.evaluate(() =>
      KINDS.map((k) => items.filter((it) => it.kind === k && it.domains.includes('aviation')).length));
    expect(want).toEqual([26, 47, 6, 10]);
    expect(want.filter((n, i) => n > 0 && n < LAYER_TOTALS[i])).toHaveLength(4);
    expect((await layerRows(page)).map((r) => r.count)).toEqual(want);
    await switchLang(page, 'fr');
    expect((await layerRows(page)).map((r) => r.label))
      .toEqual(['Projets & programmes', 'Équipes', 'Communs', 'Cadres']);
    // renderLayerRows() rebuilds the DOM from scratch; the facet counts must
    // survive that — language is not a filter change — and they must come back
    // as the narrowed figures, not as the totals the fresh markup would carry.
    expect((await layerRows(page)).map((r) => r.count)).toEqual(want);
  });

  test('§16.8 the layer-row count title is translated, not hardcoded English', async ({ page }) => {
    // The one sentence §6.1 keeps a corpus total in: the tooltip and accessible
    // name of a count that has narrowed. It is written by updateLayerCounts(),
    // which runs from refresh() rather than from applyLang(), and it only
    // exists while a filter is on — so no other test in this file is in a state
    // where it can be read at all. A hardcoded I18N.en.layerCount there leaves
    // a French reader hovering an English sentence, silently.
    await openMap(page, { lang: 'en' });
    await onlyDomain(page, 'aviation');
    await settleCounts(page);
    const titles = async () => (await layerRows(page)).map((r) => r.title);
    expect(await titles()).toEqual([
      '26 of 115 under the current filters',
      '47 of 274 under the current filters',
      '6 of 26 under the current filters',
      '10 of 45 under the current filters',
    ]);
    await switchLang(page, 'fr');
    expect(await titles()).toEqual([
      '26 sur 115 avec les filtres actuels',
      '47 sur 274 avec les filtres actuels',
      '6 sur 26 avec les filtres actuels',
      '10 sur 45 avec les filtres actuels',
    ]);
    // §14: the same string reaches a screen reader as the accessible name, so
    // it has to be translated there too and not only in the tooltip.
    expect(await page.locator('.layer-row[data-layer="team"] .cnt').getAttribute('aria-label'))
      .toBe('47 sur 274 avec les filtres actuels');
  });

  test('§12 header tiles and their reconciliation titles', async ({ page }) => {
    await withCard(page);
    expect((await tiles(page)).map((t) => t.label)).toEqual(['Projects', 'Teams', 'Commons', 'Frameworks']);
    expect((await tiles(page))[0].title).toMatch(/^\d+ in view · \d+ match(es)? the filters$/);
    await switchLang(page, 'fr');
    expect((await tiles(page)).map((t) => t.label)).toEqual(['Projets', 'Équipes', 'Communs', 'Cadres']);
    expect((await tiles(page))[0].title).toMatch(/^\d+ dans la vue · \d+ correspond(ent)? aux filtres$/);
  });

  test('§12 domain groups: headings, All/None, and the seventeen labels', async ({ page }) => {
    await withCard(page);
    const headings = () => page.locator('#domain-groups .fgroup-h h4').allTextContents();
    const mini = () => page.locator('#domain-groups .mini-btn').allTextContents();
    expect(await headings()).toEqual(['Industrial domains', 'Research focus', 'Research infrastructure']);
    expect(await mini()).toEqual(['All', 'None', 'All', 'None', 'All', 'None']);
    expect(await page.locator('#domain-groups label:has([data-dom="energy"]) span:last-child').textContent())
      .toBe('Energy / power grid');
    await switchLang(page, 'fr');
    expect(await headings()).toEqual(['Domaines industriels', 'Axes de recherche', 'Infrastructures de recherche']);
    expect(await mini()).toEqual(['Tout', 'Aucun', 'Tout', 'Aucun', 'Tout', 'Aucun']);
    expect(await page.locator('#domain-groups label:has([data-dom="energy"]) span:last-child').textContent())
      .toBe('Énergie / réseau électrique');
  });

  test('§12 a language switch does not silently reset the filters it re-renders', async ({ page }) => {
    // renderDomainGroups() and renderLayerRows() rebuild their DOM, so the
    // checkbox and aria-pressed state has to be written back from `state`, not
    // left at the markup default.
    await withCard(page);
    await onlyDomain(page, 'aviation');
    await setLayers(page, ['project', 'team']);
    const before = await snapshot(page);
    await switchLang(page, 'fr');
    const after = await snapshot(page);
    expect(after.domains).toEqual(['aviation']);
    expect(after.layers).toEqual({ project: true, team: true, commons: false, framework: false });
    expect(after.focusId).toBe('ai4realnet');
    expect(after.matchCount).toBe(before.matchCount);
    expect(await page.locator('#domain-groups input[data-dom="aviation"]').isChecked()).toBe(true);
    expect(await page.locator('#domain-groups input[data-dom="energy"]').isChecked()).toBe(false);
    expect((await layerRows(page)).map((r) => r.on)).toEqual([true, true, false, false]);
  });

  test('§12 the legend', async ({ page }) => {
    await withCard(page);
    expect(await page.locator('#legend-rows').allTextContents())
      .toEqual(['Projects & programmesTeamsCommonsFrameworks']);
    expect(await textOf(page, '#legend summary')).toBe('Legend');
    await switchLang(page, 'fr');
    expect(await page.locator('#legend-rows').allTextContents())
      .toEqual(['Projets & programmesÉquipesCommunsCadres']);
    expect(await textOf(page, '#legend summary')).toBe('Légende');
  });

  test('§12 the pins section, with a pin in it and with none', async ({ page }) => {
    await withCard(page);
    expect(await textOf(page, '#f-mymap .sb-h span')).toBe('My map');
    expect(await textOf(page, '#mymap-btn')).toBe('View my map');
    expect(await page.locator('#pin-list .pin-item .nm').allTextContents())
      .toEqual(['AI4RealNet: AI for Real-world Network Operation']);
    await switchLang(page, 'fr');
    expect(await textOf(page, '#f-mymap .sb-h span')).toBe('Ma carte');
    expect(await textOf(page, '#mymap-btn')).toBe('Voir ma carte');
    // renderPins() rebuilds the list; the pin must still be there afterwards.
    expect(await page.locator('#pin-list .pin-item .nm').allTextContents())
      .toEqual(['AI4RealNet: AI for Real-world Network Operation']);
    // Zero pins is the other branch: the empty-state sentence.
    await openMap(page, { lang: 'en' });
    expect(await textOf(page, '#pin-empty')).toContain('Pin cards (★)');
    await switchLang(page, 'fr');
    expect(await textOf(page, '#pin-empty')).toContain('Épinglez des fiches (★)');
  });

  test('§12 the off-the-map list, its heading, note and badge', async ({ page }) => {
    await withCard(page);
    expect(await textOf(page, '#f-nogeo .sb-h span')).toBe('Off the map');
    expect(await textOf(page, '#f-nogeo .note')).toContain('International standards');
    const rows = () => page.locator('#nogeo-list .pin-item').count();
    expect(await rows()).toBe(NOGEO_TOTAL);
    await switchLang(page, 'fr');
    expect(await textOf(page, '#f-nogeo .sb-h span')).toBe('Hors carte');
    expect(await textOf(page, '#f-nogeo .note')).toContain('Normes internationales');
    expect(await rows()).toBe(NOGEO_TOTAL);       // renderNoGeo() reruns, same eleven
  });

  test('§12 the period control: labels change, the years do not', async ({ page }) => {
    await withCard(page);
    // The axis runs from the 1945 floor to the AS_OF year, whatever the locale.
    expect(await textOf(page, '#tf-range')).toBe('1945 – 2026');
    expect(await textOf(page, '.tf-h')).toBe('Period');
    expect(await textOf(page, '#tf-opt span')).toBe('unknown start');
    expect(await page.locator('#tf-reset').getAttribute('title')).toBe('All years');
    expect(await page.locator('#tf-slider').getAttribute('title')).toBe('1945 – 2026 · earlier foundings stay included');
    expect(await page.locator('#tf-a').getAttribute('aria-label')).toBe('First year');
    expect(await page.locator('#tf-b').getAttribute('aria-label')).toBe('Last year');
    await switchLang(page, 'fr');
    expect(await textOf(page, '#tf-range')).toBe('1945 – 2026');
    expect(await textOf(page, '.tf-h')).toBe('Période');
    expect(await textOf(page, '#tf-opt span')).toBe('date incertaine');
    expect(await page.locator('#tf-reset').getAttribute('title')).toBe('Toutes les années');
    expect(await page.locator('#tf-slider').getAttribute('title')).toBe('1945 – 2026 · les fondations antérieures restent incluses');
    expect(await page.locator('#tf-a').getAttribute('aria-label')).toBe('Première année');
    expect(await page.locator('#tf-b').getAttribute('aria-label')).toBe('Dernière année');
  });

  test('§12 the open card, in the feed and in the floating panel', async ({ page }) => {
    // Invariant 5: one cardHtml() for both surfaces — so both have to follow
    // the language, and the feed's render key includes LANG for that reason
    // (§9.3), otherwise an identical id list would skip the DOM write.
    await withCard(page);
    await expect(page.locator('.fd-card .dt-kind')).toHaveText('Project / programme');
    await expect(page.locator('.fd-card .dt-sec h4').first()).toHaveText('Focus areas');
    expect(await textOf(page, '.fd-card .dt-pin')).toBe('★ Pinned');
    expect(await textOf(page, '#dt-body .dt-kind')).toBe('Project / programme');
    await switchLang(page, 'fr');
    await expect(page.locator('.fd-card .dt-kind')).toHaveText('Projet / programme');
    await expect(page.locator('.fd-card .dt-sec h4').first()).toHaveText('Axes de recherche');
    expect(await textOf(page, '.fd-card .dt-pin')).toBe('★ Épinglé');
    expect(await textOf(page, '#dt-body .dt-kind')).toBe('Projet / programme');
  });

  test('§9.3 the feed re-renders on a switch even when its id list has not moved', async ({ page }) => {
    // The test above reaches the feed card too, but only because a fly-to
    // leaves the in-view set a marker or two different from what it was: the
    // key changed, so the feed would have been rewritten whatever LANG did.
    // Zoomed out until every placed entity is in view, the id list cannot
    // shift — and that is the state in which a render key without its LANG
    // term (§9.3, §15 "keyed and skipped when the key is unchanged") skips the
    // write and leaves a French reader an English feed.
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet' });
    // Fit the whole world rather than scaling view.k: the card deep-link flies
    // the view somewhere first, and a bare multiplication keeps that offset, so
    // the window slides off Europe instead of widening over it. fitView is the
    // operation that puts every placed marker on the stage — the precondition
    // this test needs, asserted here rather than assumed.
    await fitAll(page);
    expect(await page.evaluate(() => state.offScreen), 'nothing off screen').toBe(0);
    const ids = () => page.locator('#fd-list .fd-item').evaluateAll((els) => els.map((e) => e.dataset.id));
    const before = await ids();
    expect(before).toHaveLength(CORPUS - NOGEO_TOTAL);   // everything that has coordinates
    await expect(page.locator('.fd-card .dt-kind')).toHaveText('Project / programme');
    await switchLang(page, 'fr');
    // Same ids, in the same order: nothing but LANG can have moved the key.
    expect(await ids()).toEqual(before);
    await expect(page.locator('.fd-card .dt-kind')).toHaveText('Projet / programme');
    await expect(page.locator('.fd-card .dt-sec h4').first()).toHaveText('Axes de recherche');
  });

  test('§12 the floating panel card when the feed is closed', async ({ page }) => {
    // With the feed hidden the card lives in #detail instead; the panel must
    // re-render too, and it is the surface no feed test would catch.
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet', storage: { 'hai-map-v2-feed': '0' } });
    await expect(page.locator('#detail')).toBeVisible();
    await expect(page.locator('#dt-body .dt-sec h4').first()).toHaveText('Focus areas');
    await switchLangDispatched(page, 'fr');
    await expect(page.locator('#dt-body .dt-sec h4').first()).toHaveText('Axes de recherche');
    await expect(page.locator('#dt-body .dt-kind')).toHaveText('Projet / programme');
  });

  test('§12 the feed header and its two reconciliation buttons', async ({ page }) => {
    await withCard(page);
    // Commons only: of the eleven off-map entities exactly one is a commons
    // (CityLearn), so the off-map hint is the n = 1 case in both languages.
    await setLayers(page, ['commons']);
    await settleCounts(page);
    expect(await textOf(page, '.fd-title span')).toBe('In view');
    await expect(page.locator('#fd-offmap')).toHaveText('+ 1 off the map');
    expect(await page.locator('#fd-offmap').getAttribute('title'))
      .toBe('1 more match the filters but have no coordinates, so no marker — see “Off the map” in the left panel.');
    await switchLang(page, 'fr');
    expect(await textOf(page, '.fd-title span')).toBe('Dans la vue');
    await expect(page.locator('#fd-offmap')).toHaveText('+ 1 hors carte');
    expect(await page.locator('#fd-offmap').getAttribute('title'))
      .toBe('1 de plus correspond aux filtres mais n’a pas de coordonnées, donc pas de marqueur — voir « Hors carte » dans le panneau de gauche.');
  });

  test('§12 the feed empty state', async ({ page }) => {
    await withCard(page);
    await page.keyboard.press('Escape');            // no focus, so nothing is kept open
    await expect(page.locator('#detail')).not.toHaveClass(/open/);
    await setLayers(page, []);
    await settleCounts(page);
    await expect(page.locator('.fd-empty')).toHaveText('Nothing in view — zoom out or widen the filters.');
    await switchLang(page, 'fr');
    await expect(page.locator('.fd-empty')).toHaveText('Aucune fiche dans la vue — dézoomez ou élargissez les filtres.');
  });

  test('§12 the welcome panel while it is open', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#intro-btn');
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    await expect(page.locator('#welcome h2')).toHaveText('The human–AI ecosystem map');
    await expect(page.locator('#wl-rows .wl-row b').first()).toHaveText('Projects & programmes');
    // wFigs is one of the two interpolating keys reached through I18N[LANG]
    // directly rather than through t(); the figures are corpus totals, which is
    // allowed here because the panel describes the map, not the view (§9.1).
    const links = await page.evaluate(() => edges.length);
    expect(links).toBe(358);            // 303 consortium edges plus created/used
    await expect(page.locator('#wl-figs')).toHaveText(new RegExp(`^${COUNTRIES} countries · ${links} documented links ·`));
    // The overlay is modal and covers the switch, so the click has to be
    // dispatched: applyLang()'s `if (welcome is open) renderWelcome()` guard is
    // defensive rather than reachable with a mouse. It still has to work — a
    // deep link, a keyboard path or a narrower layout can all get there.
    await switchLangDispatched(page, 'fr');
    // applyLang() only calls renderWelcome() when the overlay is open — that
    // guard is why this has to be tested with it open.
    await expect(page.locator('#welcome h2')).toHaveText("La carte de l’écosystème humain–IA");
    await expect(page.locator('#wl-rows .wl-row b').first()).toHaveText('Projets & programmes');
    await expect(page.locator('#wl-figs')).toHaveText(new RegExp(`^${COUNTRIES} pays · ${links} liens documentés ·`));
  });

  test('§12 the guided tour card while it is open', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#tour-btn');
    await expect(page.locator('#tour-card')).toBeVisible();
    await expect(page.locator('#tour-n')).toHaveText('Step 1 / 4');
    await expect(page.locator('#tour-title')).toHaveText('Filters & layers');
    await expect(page.locator('#tour-next')).toHaveText('Next');
    await switchLang(page, 'fr');
    // SPEC-DEVIATION: applyLang() re-renders presets, layer rows, domain
    // groups, legend, pins, off-the-map, period and the open card — but not the
    // tour card, which has no re-render hook of its own. The step title stays
    // in the language it was opened in until the reader steps forward.
    await expect(page.locator('#tour-n')).toHaveText('Step 1 / 4');
    await expect(page.locator('#tour-title')).toHaveText('Filters & layers');
    await page.click('#tour-next');
    await expect(page.locator('#tour-n')).toHaveText('Étape 2 / 4');
    await expect(page.locator('#tour-title')).toHaveText('La carte');
    await expect(page.locator('#tour-next')).toHaveText('Suivant');
  });

  test('§12 document title, html lang, the switch itself and the footer', async ({ page }) => {
    await withCard(page);
    expect(await page.title()).toBe('Human–AI Collaboration in Europe — ecosystem map');
    expect(await page.getAttribute('html', 'lang')).toBe('en');
    expect(await page.locator('.lang-switch button.is-active').textContent()).toBe('EN');
    await expect(page.locator('#sb-foot')).toContainText('Basemap: Natural Earth');
    await switchLang(page, 'fr');
    expect(await page.title()).toBe('Collaboration humain–IA en Europe — carte de l’écosystème');
    expect(await page.getAttribute('html', 'lang')).toBe('fr');
    expect(await page.locator('.lang-switch button.is-active').count()).toBe(1);
    expect(await page.locator('.lang-switch button.is-active').textContent()).toBe('FR');
    await expect(page.locator('#sb-foot')).toContainText('Fond de carte : Natural Earth');
    // The footer is the one string written as innerHTML: the data-repo link has
    // to survive the swap, not be escaped into visible markup.
    expect(await page.locator('#sb-foot a[href*="eu-hai-collab-map"]').count()).toBe(1);
  });

  test('§12 the collapsed sidebar still follows the language', async ({ page }) => {
    await withCard(page);
    await clickBuried(page, '#sb-hide');
    await expect(page.locator('body')).toHaveClass(/sb-hidden/);
    expect(await textOf(page, '#sb-open span')).toBe('Filters');
    await switchLang(page, 'fr');
    expect(await textOf(page, '#sb-open span')).toBe('Filtres');
    // Hidden is not absent: reopening must not reveal a stale English panel.
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Couches');
    expect((await layerRows(page)).map((r) => r.label))
      .toEqual(['Projets & programmes', 'Équipes', 'Communs', 'Cadres']);
  });

  test('§12 toasts speak the current language', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#mymap-pill');               // no pins yet: refuses, with a reason
    await expect(page.locator('#toast')).toHaveText(/^Pin cards \(★\)/);
    await switchLang(page, 'fr');
    await page.click('#mymap-pill');
    await expect(page.locator('#toast')).toHaveText(/^Épinglez des fiches \(★\)/);
  });

  test('§12 the print sheet is written in the current language', async ({ page }) => {
    await openMap(page, { lang: 'en', hash: '#pins=ai4realnet' });
    await page.evaluate(() => { window.print = () => {}; });
    const desc = await page.evaluate(() => ({ en: byId.ai4realnet.d.desc_en, fr: byId.ai4realnet.d.desc_fr }));
    await page.click('#print-btn');
    let sheet = await page.locator('#print-sheet').textContent();
    expect(sheet).toContain('Human–AI Collaboration in Europe');
    expect(sheet).toContain('My map');
    expect(sheet).toContain('Projects & programmes (1)');
    expect(sheet).toContain(desc.en.slice(0, 60));
    await switchLang(page, 'fr');
    await page.click('#print-btn');
    sheet = await page.locator('#print-sheet').textContent();
    expect(sheet).toContain('Collaboration humain–IA en Europe');
    expect(sheet).toContain('Ma carte');
    expect(sheet).toContain('Projets & programmes (1)');
    expect(sheet).toContain(desc.fr.slice(0, 60));
  });

  test('§12 the shared link carries the language it was copied in', async ({ page }) => {
    await openMap(page, { lang: 'en', hash: '#pins=ai4realnet' });
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (s) => { window.__copied = s; return Promise.resolve(); } },
      });
    });
    await page.click('#share-btn');
    await expect(page.locator('#toast')).toHaveText('Link copied — it restores your pins and the current view.');
    expect(await page.evaluate(() => window.__copied)).toContain('?lang=en#pins=ai4realnet');
    await switchLang(page, 'fr');
    await page.click('#share-btn');
    await expect(page.locator('#toast')).toHaveText('Lien copié — il restaure vos épingles et la vue en cours.');
    expect(await page.evaluate(() => window.__copied)).toContain('?lang=fr#pins=ai4realnet');
  });
});

// ------------------------------------------------- the fallback chain

test.describe('§12 a missing French key falls back to English', () => {
  test('§12 a key absent from I18N.fr renders the English string, not the key', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    await zoomBy(page, 0.5);
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Couches');
    expect(await caption(page)).toBe(`${COUNTRIES} pays · dans la vue · ${CORPUS} correspondent aux filtres (${NOGEO_TOTAL} hors carte)`);
    await page.evaluate(() => {
      for (const k of ['layersTitle', 'stCountriesN', 'stNote', 'stNoteWhy', 'stOffMap']) delete I18N.fr[k];
      applyLang();
    });
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Layers');
    // The interpolating keys fall back too — a raw "stNoteWhy" in the caption is
    // the failure this guards against, and it is the caption a reader trusts.
    expect(await caption(page)).toBe(`${COUNTRIES} countries · in view · ${CORPUS} match the filters (${NOGEO_TOTAL} off the map)`);
    expect(await page.evaluate(() => t('layersTitle'))).toBe('Layers');
  });

  test('§12 a null French value falls back as well as a missing one', async ({ page }) => {
    // t() tests `v == null`, so an explicitly blanked key behaves like an
    // absent one rather than printing "null".
    await openMap(page, { lang: 'fr' });
    await page.evaluate(() => { I18N.fr.legendTitle = null; applyLang(); });
    expect(await textOf(page, '#legend summary')).toBe('Legend');
  });

  test('§12 a key missing from both languages degrades to the key, not to undefined', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    await page.evaluate(() => { delete I18N.fr.legendTitle; delete I18N.en.legendTitle; applyLang(); });
    expect(await textOf(page, '#legend summary')).toBe('legendTitle');
    expect(await page.evaluate(() => String(t('legendTitle')))).toBe('legendTitle');
  });

  test('§12 applyLang() leaves a [data-i18n] node alone when the value is not a string', async ({ page }) => {
    // The `typeof v === 'string'` guard: an interpolating key wired to a
    // data-i18n attribute would otherwise stringify a function into the page.
    await openMap(page, { lang: 'en' });
    expect(await textOf(page, '#sb-open span')).toBe('Filters');
    await page.evaluate(() => { I18N.en.filtersBtn = (n) => `Filters ${n}`; applyLang(); });
    const shown = await textOf(page, '#sb-open span');
    expect(shown).toBe('Filters');
    expect(shown).not.toContain('=>');
    expect(shown).not.toContain('function');
  });
});

// ------------------------------------------------- content, not just chrome

test.describe('§12 the content switches too', () => {
  test('§12 descriptions come from desc_fr / desc_en', async ({ page }) => {
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet' });
    const d = await page.evaluate(() => ({ en: byId.ai4realnet.d.desc_en, fr: byId.ai4realnet.d.desc_fr }));
    expect(d.fr).not.toBe(d.en);
    const paras = () => page.locator('.fd-card .dt-desc').allTextContents();
    expect((await paras()).join('\n\n')).toBe(d.en);
    await switchLang(page, 'fr');
    expect((await paras()).join('\n\n')).toBe(d.fr);
  });

  test('§12 an entity with no desc_fr/desc_en falls back to desc in both languages', async ({ page }) => {
    // Four entities carry only the undifferentiated `desc`; the card must show
    // it rather than the "description to come" placeholder.
    await openMap(page, { lang: 'en', hash: '#e=uva-illc' });
    const d = await page.evaluate(() => ({
      desc: byId['uva-illc'].d.desc,
      hasFr: 'desc_fr' in byId['uva-illc'].d,
      hasEn: 'desc_en' in byId['uva-illc'].d,
    }));
    expect(d.hasFr).toBe(false);
    expect(d.hasEn).toBe(false);
    expect((await page.locator('.fd-card .dt-desc').allTextContents()).join('\n\n')).toBe(d.desc);
    await switchLang(page, 'fr');
    expect((await page.locator('.fd-card .dt-desc').allTextContents()).join('\n\n')).toBe(d.desc);
  });

  test('§12 an entity with no description at all gets the translated placeholder', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const card = (lang) => page.evaluate((l) => {
      LANG = l;
      return cardHtml({ id: '__t', kind: 'commons', domains: ['energy'], d: { id: '__t', name: 'Nothing', kind: 'dataset' } });
    }, lang);
    expect(await card('en')).toContain('Description to come.');
    expect(await card('fr')).toContain('Description à venir.');
  });

  test('§12 every value in DATA.TAXO carries both labels', async ({ page }) => {
    await openMap(page);
    const audit = await page.evaluate(() => {
      const out = { groups: Object.keys(DATA.TAXO).sort(), entries: 0, missing: [] };
      for (const [g, tbl] of Object.entries(DATA.TAXO))
        for (const [k, e] of Object.entries(tbl)) {
          out.entries++;
          for (const l of ['fr', 'en']) if (!e[l] || !String(e[l]).trim()) out.missing.push(`${g}.${k}.${l}`);
        }
      return out;
    });
    expect(audit.groups).toEqual(['access', 'confidence', 'focus', 'jurisdiction', 'kind', 'legal', 'role', 'status', 'tier', 'type']);
    expect(audit.entries).toBe(67);
    expect(audit.missing).toEqual([]);
  });

  test('§12 taxo() returns the current language for every value that has a label', async ({ page }) => {
    await openMap(page);
    const bad = await page.evaluate(() => {
      const out = [];
      for (const l of ['fr', 'en']) {
        LANG = l;
        for (const [g, tbl] of Object.entries(DATA.TAXO))
          for (const [k, e] of Object.entries(tbl)) {
            const got = taxo(g, k);
            if (got !== e[l]) out.push(`${l}:${g}.${k}=${got}`);
            // The de-underscored fallback must not win over a real label.
            if (k.includes('_') && got === k.replace(/_/g, ' ')) out.push(`${l}:${g}.${k} fell back`);
          }
      }
      return out;
    });
    expect(bad).toEqual([]);
  });

  test('§12 vocabulary values the generator never labelled render de-underscored in both languages', async ({ page }) => {
    // SPEC-DEVIATION: §12 says every controlled vocabulary value has both
    // labels in DATA.TAXO. Seven values used by the payload have none, so
    // taxo() falls through to §17's documented de-underscored key — which means
    // a French reader sees English words ("third party", "restricted",
    // "commercial"). It degrades rather than breaks, as §17 promises, but the
    // §12 claim is not true of the data as generated.
    await openMap(page);
    const gaps = await page.evaluate(() => {
      const used = {};
      const add = (g, v) => { if (v) (used[g] = used[g] || new Set()).add(v); };
      items.forEach(({ d }) => {
        add('kind', d.kind); add('type', d.type); add('status', d.status); add('tier', d.tier);
        add('jurisdiction', d.jurisdiction); add('legal', d.legal);
        (d.focus || []).forEach((v) => add('focus', v));
        if (d.infra) { add('kind', d.infra.kind); add('access', d.infra.access); }
        (d.consortium || []).forEach((c) => add('role', c.role));
        if (d.prov) add('confidence', d.prov.conf);
      });
      const out = [];
      for (const [g, s] of Object.entries(used))
        for (const v of s) if (!(DATA.TAXO[g] && DATA.TAXO[g][v])) out.push(g + '.' + v);
      return out.sort();
    });
    expect(gaps).toEqual([
      'access.commercial', 'access.restricted',
      'jurisdiction.DE', 'jurisdiction.DK', 'jurisdiction.NL', 'jurisdiction.UK',
      'role.third_party',
    ]);
    // And what the reader gets for them is identical in both languages.
    const rendered = await page.evaluate(() => {
      const at = (l) => { LANG = l; return [taxo('role', 'third_party'), taxo('access', 'restricted'), taxo('jurisdiction', 'UK')]; };
      return { fr: at('fr'), en: at('en') };
    });
    expect(rendered.fr).toEqual(['third party', 'restricted', 'UK']);
    expect(rendered.en).toEqual(rendered.fr);
  });

  test('§12 the card chips and domain badges read from the taxonomy and the badge table', async ({ page }) => {
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet' });
    const want = await page.evaluate(() => ({
      focusFr: byId.ai4realnet.d.focus.map((v) => DATA.TAXO.focus[v].fr),
      focusEn: byId.ai4realnet.d.focus.map((v) => DATA.TAXO.focus[v].en),
      domsFr: byId.ai4realnet.domains.map((d) => I18N.fr.badge[d]),
      domsEn: byId.ai4realnet.domains.map((d) => I18N.en.badge[d]),
    }));
    expect(want.focusEn).toContain('Decision support');
    expect(want.focusFr).toContain('Aide à la décision');
    const chips = () => page.locator('.fd-card .dt-sec').first().locator('.dt-chip').allTextContents();
    const badges = () => page.locator('.fd-card .dt-dom').allTextContents();
    expect(await chips()).toEqual(want.focusEn);
    expect(await badges()).toEqual(want.domsEn);
    await switchLang(page, 'fr');
    expect(await chips()).toEqual(want.focusFr);
    expect(await badges()).toEqual(want.domsFr);
  });

  test('§12 the status tag is translated where the taxonomy has a label', async ({ page }) => {
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet' });
    await expect(page.locator('.fd-card .dt-tag').last()).toHaveText('Active');
    await switchLang(page, 'fr');
    await expect(page.locator('.fd-card .dt-tag').last()).toHaveText('En cours');
  });
});

// ------------------------------------------------- initial language resolution

test.describe('§12 initial language: ?lang= → localStorage → browser → English', () => {
  test('§12 ?lang= wins over both localStorage and the browser', async ({ page }) => {
    await bootMap(page, { search: '?lang=fr', storage: { 'hai-map-lang': 'en' }, navLang: 'en-GB' });
    expect(await langOf(page)).toBe('fr');
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Couches');
    await bootMap(page, { search: '?lang=en', storage: { 'hai-map-lang': 'fr' }, navLang: 'fr-FR' });
    expect(await langOf(page)).toBe('en');
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Layers');
  });

  test('§12 an unrecognised ?lang= is ignored and the next step decides', async ({ page }) => {
    // Only 'fr' and 'en' are accepted, so ?lang=de must not become the
    // language, nor blank it — it falls through to the stored choice.
    await bootMap(page, { search: '?lang=de', storage: { 'hai-map-lang': 'fr' }, navLang: 'en-GB' });
    expect(await langOf(page)).toBe('fr');
    await bootMap(page, { search: '?lang=', navLang: 'en-GB' });
    expect(await langOf(page)).toBe('en');
  });

  test('§12 localStorage wins over the browser language', async ({ page }) => {
    await bootMap(page, { storage: { 'hai-map-lang': 'en' }, navLang: 'fr-FR' });
    expect(await langOf(page)).toBe('en');
    await bootMap(page, { storage: { 'hai-map-lang': 'fr' }, navLang: 'en-US' });
    expect(await langOf(page)).toBe('fr');
  });

  test('§12 a stored value that is neither fr nor en is ignored', async ({ page }) => {
    await bootMap(page, { storage: { 'hai-map-lang': 'es' }, navLang: 'fr-FR' });
    expect(await langOf(page)).toBe('fr');
  });

  test('§12 the browser language decides when nothing else does', async ({ page }) => {
    await bootMap(page, { navLang: 'fr-FR' });
    expect(await langOf(page)).toBe('fr');
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Couches');
    await bootMap(page, { navLang: 'fr' });
    expect(await langOf(page)).toBe('fr');
    // Any French region counts, and the tag is matched case-insensitively.
    await bootMap(page, { navLang: 'fr-CA' });
    expect(await langOf(page)).toBe('fr');
    await bootMap(page, { navLang: 'FR-fr' });
    expect(await langOf(page)).toBe('fr');
  });

  test('§12 any other browser language, or none at all, means English', async ({ page }) => {
    await bootMap(page, { navLang: 'de-DE' });
    expect(await langOf(page)).toBe('en');
    await bootMap(page, { navLang: 'nl' });
    expect(await langOf(page)).toBe('en');
    // `navigator.language || 'en'`: the empty-string case has its own branch,
    // and some embedding contexts really do report one.
    await bootMap(page, { navLang: '' });
    expect(await langOf(page)).toBe('en');
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Layers');
  });

  test('§12 the browser-language test is a prefix test, not a tag match', async ({ page }) => {
    // `startsWith('fr')` — so the three-letter ISO 639-2 code lands on French
    // too, which is right, and so would a hypothetical 'fr-Latn-CH'. Worth
    // pinning: a future tightening to an exact 'fr' / 'fr-XX' match would send
    // those readers to English without anyone noticing.
    await bootMap(page, { navLang: 'fra' });
    expect(await langOf(page)).toBe('fr');
    await bootMap(page, { navLang: 'fr-Latn-CH' });
    expect(await langOf(page)).toBe('fr');
  });

  test('§12 switching persists the choice under hai-map-lang', async ({ page }) => {
    await bootMap(page, { navLang: 'en-GB' });
    expect(await page.evaluate(() => localStorage.getItem('hai-map-lang'))).toBeNull();
    await switchLang(page, 'fr');
    expect(await page.evaluate(() => localStorage.getItem('hai-map-lang'))).toBe('fr');
    await switchLang(page, 'en');
    expect(await page.evaluate(() => localStorage.getItem('hai-map-lang'))).toBe('en');
  });

  test('§12 private mode: storage throws, the page still resolves and still switches', async ({ page }) => {
    // §13: all reads and writes go through lsGet/lsSet, which swallow. The
    // language then comes from the browser, and the switch has to keep working
    // even though it cannot remember the choice.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await bootMap(page, { privateMode: true, navLang: 'fr-FR' });
    expect(await langOf(page)).toBe('fr');
    // A consequence worth naming: `hai-map-v2-seen` can never be read back, so
    // the welcome panel opens on every visit — and it is modal, so it has to be
    // dismissed before the language switch behind it can be reached.
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    await expect(page.locator('#welcome h2')).toHaveText("La carte de l’écosystème humain–IA");
    await page.click('#w-explore');
    await switchLang(page, 'en');
    expect(await langOf(page)).toBe('en');
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Layers');
    expect(errors).toEqual([]);
  });
});

// ------------------------------------------------- verb agreement

test.describe('§12 verb agreement in both languages', () => {
  // These branches were written by hand, one sentence at a time. Nothing else
  // in the page reads them, so a refactor that drops the ternary shows up only
  // as bad grammar in front of a reader.
  const call = (page, lang, key, ...args) =>
    page.evaluate(([l, k, a]) => I18N[l][k](...a), [lang, key, args]);

  test('§12 English: "1 matches the filters", "25 match the filters"', async ({ page }) => {
    await openMap(page);
    expect(await call(page, 'en', 'stNote', 0)).toBe('in view · 0 match the filters');
    expect(await call(page, 'en', 'stNote', 1)).toBe('in view · 1 matches the filters');
    expect(await call(page, 'en', 'stNote', 25)).toBe('in view · 25 match the filters');
    expect(await call(page, 'en', 'stNoteWhy', 1, '11 off the map')).toBe('in view · 1 matches the filters (11 off the map)');
    expect(await call(page, 'en', 'stNoteWhy', 2, '11 off the map')).toBe('in view · 2 match the filters (11 off the map)');
  });

  test('§12 French: "0 correspond", "1 correspond", "25 correspondent"', async ({ page }) => {
    await openMap(page);
    // French agrees with the number itself: zero takes the singular.
    expect(await call(page, 'fr', 'stNote', 0)).toBe('dans la vue · 0 correspond aux filtres');
    expect(await call(page, 'fr', 'stNote', 1)).toBe('dans la vue · 1 correspond aux filtres');
    expect(await call(page, 'fr', 'stNote', 25)).toBe('dans la vue · 25 correspondent aux filtres');
    expect(await call(page, 'fr', 'stNoteWhy', 1, 'x')).toBe('dans la vue · 1 correspond aux filtres (x)');
    expect(await call(page, 'fr', 'stNoteWhy', 25, 'x')).toBe('dans la vue · 25 correspondent aux filtres (x)');
  });

  test('§12 "1 country" / "27 countries", against an invariable French "pays"', async ({ page }) => {
    await openMap(page);
    expect(await call(page, 'en', 'stCountriesN', 1)).toBe('1 country');
    expect(await call(page, 'en', 'stCountriesN', 27)).toBe('27 countries');
    expect(await call(page, 'en', 'stCountriesN', 0)).toBe('0 countries');
    // "pays" is spelled the same in the singular and the plural — the French
    // function is deliberately branch-free, and adding a branch would be wrong.
    expect(await call(page, 'fr', 'stCountriesN', 1)).toBe('1 pays');
    expect(await call(page, 'fr', 'stCountriesN', 27)).toBe('27 pays');
  });

  test('§12 the tile reconciliation agrees on its second number', async ({ page }) => {
    await openMap(page);
    expect(await call(page, 'en', 'stTile', 0, 0)).toBe('0 in view · 0 match the filters');
    expect(await call(page, 'en', 'stTile', 3, 1)).toBe('3 in view · 1 matches the filters');
    expect(await call(page, 'en', 'stTile', 3, 25)).toBe('3 in view · 25 match the filters');
    expect(await call(page, 'fr', 'stTile', 0, 0)).toBe('0 dans la vue · 0 correspond aux filtres');
    expect(await call(page, 'fr', 'stTile', 3, 1)).toBe('3 dans la vue · 1 correspond aux filtres');
    expect(await call(page, 'fr', 'stTile', 3, 25)).toBe('3 dans la vue · 25 correspondent aux filtres');
  });

  test('§12 the off-the-map badge title agrees', async ({ page }) => {
    await openMap(page);
    expect(await call(page, 'en', 'nogeoCount', 1, 11)).toBe('1 of 11 matches the current filters');
    expect(await call(page, 'en', 'nogeoCount', 5, 11)).toBe('5 of 11 match the current filters');
    expect(await call(page, 'en', 'nogeoCount', 0, 11)).toBe('0 of 11 match the current filters');
    expect(await call(page, 'fr', 'nogeoCount', 1, 11)).toBe('1 sur 11 correspond aux filtres actuels');
    expect(await call(page, 'fr', 'nogeoCount', 5, 11)).toBe('5 sur 11 correspondent aux filtres actuels');
    expect(await call(page, 'fr', 'nogeoCount', 0, 11)).toBe('0 sur 11 correspond aux filtres actuels');
  });

  test('§12 the feed hints agree in French, and do not in English', async ({ page }) => {
    await openMap(page);
    expect(await call(page, 'fr', 'feedOffScreenTitle', 1))
      .toBe('1 de plus correspond aux filtres mais se trouve hors de la vue actuelle — dézoomez pour les afficher.');
    expect(await call(page, 'fr', 'feedOffScreenTitle', 3))
      .toBe('3 de plus correspondent aux filtres mais se trouvent hors de la vue actuelle — dézoomez pour les afficher.');
    expect(await call(page, 'fr', 'feedOffMapTitle', 1)).toContain('correspond aux filtres mais n’a pas de coordonnées');
    expect(await call(page, 'fr', 'feedOffMapTitle', 3)).toContain('correspondent aux filtres mais n’ont pas de coordonnées');
    // SPEC-DEVIATION: the English twins carry no such branch, so at n = 1 they
    // read "1 more match the filters but sit outside…" — which is what a reader
    // sees on hovering "+ 1 off screen", a state one zoom step away. The French
    // pair was given agreement and the English pair was not; both strings exist
    // in both languages, which is all invariant 8 asks for literally, so this is
    // asserted as-is rather than as a failure.
    expect(await call(page, 'en', 'feedOffScreenTitle', 1))
      .toBe('1 more match the filters but sit outside the current view — zoom out to bring them in.');
    expect(await call(page, 'en', 'feedOffMapTitle', 1))
      .toContain('1 more match the filters but have no coordinates');
  });

  test('§12 the layer-row title has no plural to get wrong, in either language', async ({ page }) => {
    await openMap(page);
    expect(await call(page, 'en', 'layerCount', 1, 268)).toBe('1 of 268 under the current filters');
    expect(await call(page, 'fr', 'layerCount', 1, 268)).toBe('1 sur 268 avec les filtres actuels');
  });

  test('§9.1 the caption reads the singular end to end, in both languages', async ({ page }) => {
    // Commons + human factors is exactly one entity in the payload (OpenBridge, NO),
    // so this is the n = 1 boundary through the real controls rather than
    // through the string function.
    await openMap(page, { lang: 'en' });
    await zoomBy(page, 0.5);                       // everything placed is on screen
    await setLayers(page, ['commons']);
    await onlyDomain(page, 'hf');
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(1);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(0);
    await expect(page.locator('#st-note')).toHaveText('1 country · in view · 1 matches the filters');
    expect((await tiles(page)).map((t) => t.title)).toEqual([
      '0 in view · 0 match the filters', '0 in view · 0 match the filters',
      '1 in view · 1 matches the filters', '0 in view · 0 match the filters',
    ]);
    await switchLang(page, 'fr');
    await expect(page.locator('#st-note')).toHaveText('1 pays · dans la vue · 1 correspond aux filtres');
    expect((await tiles(page))[2].title).toBe('1 dans la vue · 1 correspond aux filtres');
    await expectCountersReconcile(page, 'one commons, one human-factors domain');
  });

  test('§9.1 zero results: English pluralises, French does not', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await setLayers(page, []);                     // every layer off
    await settleCounts(page);
    expect((await snapshot(page)).matchCount).toBe(0);
    // No countries in view, so the caption drops that term rather than saying 0.
    await expect(page.locator('#st-note')).toHaveText('in view · 0 match the filters');
    await switchLang(page, 'fr');
    await expect(page.locator('#st-note')).toHaveText('dans la vue · 0 correspond aux filtres');
  });

  test('§9.2 the whole corpus, with the off-map term named in both languages', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await zoomBy(page, 0.5);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(CORPUS);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(NOGEO_TOTAL);
    await expect(page.locator('#st-note'))
      .toHaveText(`${COUNTRIES} countries · in view · ${CORPUS} match the filters (${NOGEO_TOTAL} off the map)`);
    await switchLang(page, 'fr');
    await expect(page.locator('#st-note'))
      .toHaveText(`${COUNTRIES} pays · dans la vue · ${CORPUS} correspondent aux filtres (${NOGEO_TOTAL} hors carte)`);
  });

  test('§9.2 the kept-open card is named as its own term in both languages', async ({ page }) => {
    // Invariant 6: the focused entity survives a filter change, so the tiles
    // can exceed the match count. Unnamed it reads as an off-by-one.
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet' });
    await setLayers(page, []);
    await settleCounts(page);
    await expect(page.locator('#st-note')).toHaveText('1 country · in view · 0 match the filters (plus the open card)');
    expect((await snapshot(page)).keptOpen).toBe(1);
    await switchLang(page, 'fr');
    await expect(page.locator('#st-note')).toHaveText('1 pays · dans la vue · 0 correspond aux filtres (plus la fiche ouverte)');
  });

  test('§9.2 My map mode does not claim a filter reading in either language', async ({ page }) => {
    await openMap(page, { lang: 'en', hash: '#pins=ai4realnet&my=1' });
    await settleCounts(page);
    expect((await snapshot(page)).myMap).toBe(true);
    const en = await caption(page);
    expect(en).toMatch(/in view · \d+ on your map$/);
    expect(en).not.toContain('match the filters');
    await switchLang(page, 'fr');
    const fr = await caption(page);
    expect(fr).toMatch(/dans la vue · \d+ sur votre carte$/);
    expect(fr).not.toContain('correspond');
  });

  test('§9.3 the off-the-map badge reads the same n as the feed button, in both languages', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await setLayers(page, ['commons']);            // one off-map commons: CityLearn
    await settleCounts(page);
    expect((await snapshot(page)).offMapMatch).toBe(1);
    expect(await textOf(page, '#nogeo-count')).toBe('1');
    expect(await page.locator('#nogeo-count').getAttribute('title')).toBe('1 of 11 matches the current filters');
    await switchLang(page, 'fr');
    expect(await page.locator('#nogeo-count').getAttribute('title')).toBe('1 sur 11 correspond aux filtres actuels');
  });

  test('§9.2 the off-screen term appears in the caption in both languages', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await zoomBy(page, 4);                          // push most markers off screen
    const s = await snapshot(page);
    expect(s.offScreen).toBeGreaterThan(0);
    await expect(page.locator('#st-note')).toHaveText(new RegExp(`\\(${s.offScreen} off screen, ${NOGEO_TOTAL} off the map\\)$`));
    await switchLang(page, 'fr');
    await settleCounts(page);
    const t = await snapshot(page);
    await expect(page.locator('#st-note')).toHaveText(new RegExp(`\\(${t.offScreen} hors écran, ${NOGEO_TOTAL} hors carte\\)$`));
  });
});

// ------------------------------------------------- locale-aware sort and numbers

test.describe('§12 locale-aware collation and number formatting', () => {
  test('§9.3 the feed sorts by layer then name with the reader\'s collation', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await zoomBy(page, 0.5);
    const res = await page.evaluate(() => {
      const order = { project: 0, team: 1, commons: 2, framework: 3 };
      const names = [...state.inView].map((id) => byId[id]);
      const locale = [...names].sort((a, b) => (order[a.kind] - order[b.kind]) || a.d.name.localeCompare(b.d.name, LANG))
        .map((it) => it.d.name);
      const codepoint = [...names].sort((a, b) => (order[a.kind] - order[b.kind]) || (a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0))
        .map((it) => it.d.name);
      const shown = [...document.querySelectorAll('#fd-list .fd-item .nm')].map((e) => e.textContent);
      return { locale, codepoint, shown };
    });
    expect(res.shown).toEqual(res.locale);
    // Falsifiable only because the two orders really differ on this data:
    // "agrifoodTEF" and "ČEPS…" sort with A and C by collation, and after Z by
    // code point. A comparator that dropped the locale would pass otherwise.
    expect(res.codepoint).not.toEqual(res.locale);
  });

  test('§9.3 a caron sorts with its base letter, not after Z', async ({ page }) => {
    // The assertion has to be about where in the alphabet ČEPS lands, not about
    // where in the feed: a code-point comparator parks it at the end of the
    // *team* block, which is still a long way from the end of the feed, and two
    // commons and forty-five frameworks still follow it. Compare it against the
    // B run and the D run inside its own layer instead — that is the claim.
    await openMap(page, { lang: 'en' });
    await zoomBy(page, 0.5);
    const pos = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#fd-list .fd-item')];
      const teams = rows.filter((e) => byId[e.dataset.id] && byId[e.dataset.id].kind === 'team')
        .map((e) => e.querySelector('.nm').textContent);
      const ceps = teams.findIndex((n) => n.startsWith('ČEPS'));
      const firstOf = (re) => teams.findIndex((n) => re.test(n));
      const lastOf = (re) => teams.reduce((acc, n, i) => (re.test(n) ? i : acc), -1);
      return {
        ceps, teamCount: teams.length,
        name: teams[ceps], prev: teams[ceps - 1], next: teams[ceps + 1],
        lastB: lastOf(/^b/i), firstD: firstOf(/^d/i),
      };
    });
    expect(pos.teamCount).toBeGreaterThan(200);        // the whole team layer is in view
    expect(pos.ceps).toBeGreaterThan(-1);
    expect(pos.name).toMatch(/^ČEPS/);
    // Inside the C run: both neighbours start with a plain C.
    expect(pos.prev).toMatch(/^c/i);
    expect(pos.next).toMatch(/^c/i);
    // And the run itself is where C belongs — after every B, before every D.
    expect(pos.lastB).toBeGreaterThan(-1);
    expect(pos.firstD).toBeGreaterThan(-1);
    expect(pos.lastB).toBeLessThan(pos.ceps);
    expect(pos.ceps).toBeLessThan(pos.firstD);
  });

  test('§8 budgets are formatted in the reader\'s locale', async ({ page }) => {
    // §8, card section 10: "Funding — source, call, grant, budget in
    // locale-formatted euros".
    await openMap(page, { lang: 'en', hash: '#e=ai4realnet' });
    const eur = await page.evaluate(() => byId.ai4realnet.d.funding.eur);
    expect(eur).toBe(3999976);
    const row = () => page.locator('.fd-card .dt-facts div', { has: page.locator('dt', { hasText: /^(Budget)$/ }) }).locator('dd').textContent();
    expect(spaces(await row())).toBe('€3,999,976');
    await switchLang(page, 'fr');
    expect(spaces(await row())).toBe('3 999 976 €');
    // The separators, not just the digits: an English reader gets ASCII commas
    // and a leading symbol, a French one narrow spaces and a trailing one.
    const fmt = await page.evaluate(() => {
      const at = (l) => { LANG = l; return money(3999976); };
      return { fr: at('fr'), en: at('en') };
    });
    expect(fmt.en.startsWith('€')).toBe(true);
    expect(fmt.en).toContain(',');
    expect(fmt.fr.endsWith('€')).toBe(true);
    expect(fmt.fr).not.toContain(',');
    expect(fmt.fr).not.toBe(fmt.en);
  });

  test('§10 the freshness date is spelled out in the reader\'s locale', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const label = () => page.locator('#tf-asof').getAttribute('aria-label');
    expect(await label()).toBe('Data current as of 23 October 2026 — the period slider stops at that year.');
    await switchLang(page, 'fr');
    expect(await label()).toBe('Données à jour au 23 octobre 2026 — le curseur de période s’arrête à cette année.');
    // The same sentence reaches touch devices as a toast.
    await page.click('#tf-asof');
    await expect(page.locator('#toast')).toHaveText(/23 octobre 2026/);
  });
});

// ------------------------------------------------- what does not go through t()

test.describe('§16 invariant 8 — the strings that do not go through t()', () => {
  test('§16.8 static aria-labels and titles stay French whatever the language', async ({ page }) => {
    // SPEC-DEVIATION: invariant 8 says every user-visible string goes through
    // t() and exists in both languages. These are written straight into the
    // markup in French and never touched by applyLang(), so in English mode a
    // screen-reader user hears a French interface. #fd-close is the one that
    // was wired up (applyLang sets its title and aria-label from t('feedHide')),
    // which is what the others should look like.
    await openMap(page, { lang: 'en', hash: '#pins=ai4realnet' });
    const labels = await page.evaluate(() => {
      const at = (sel, attr) => { const el = document.querySelector(sel); return el ? el.getAttribute(attr) : null; };
      return {
        search: at('#search', 'aria-label'),
        map: at('#map', 'aria-label'),
        sbOpen: at('#sb-open', 'aria-label'),
        sbHide: at('#sb-hide', 'aria-label'),
        langGroup: at('.lang-switch', 'aria-label'),
        help: at('#help-btn', 'aria-label'),
        zoomIn: at('#z-in', 'aria-label'),
        zoomOut: at('#z-out', 'aria-label'),
        fit: at('#z-fit', 'aria-label'),
        detail: at('#detail', 'aria-label'),
        back: at('#dt-back', 'aria-label'),
        close: at('#dt-close', 'aria-label'),
        feed: at('#feed', 'aria-label'),
        unpin: at('#pin-list .pin-x', 'aria-label'),
        fdClose: at('#fd-close', 'aria-label'),
      };
    });
    expect(labels).toEqual({
      search: 'Recherche',
      map: 'Carte interactive',
      sbOpen: 'Filtres',
      sbHide: 'Masquer le panneau',
      langGroup: 'Langue',
      help: 'Aide',
      zoomIn: 'Zoom avant',
      zoomOut: 'Zoom arrière',
      fit: "Vue d'ensemble",
      detail: 'Détail',
      back: 'Retour',
      close: 'Fermer',
      feed: 'Fiches dans la vue',
      unpin: 'Retirer',
      fdClose: 'Hide feed',           // the one that is translated
    });
    // Two labels for one control, in two languages: the search placeholder
    // follows the reader, its accessible name does not.
    expect(await page.locator('#search').getAttribute('placeholder')).toBe('Search a team, a project, a city…');
    expect(await page.locator('#search').getAttribute('aria-label')).toBe('Recherche');
  });

  test('§14 data-screen-label is French in both languages', async ({ page }) => {
    // SPEC-DEVIATION: §14 asks for a data-screen-label on each region; the five
    // values are hardcoded French, so they do not satisfy invariant 8 either.
    await openMap(page, { lang: 'en' });
    const got = await page.evaluate(() =>
      [...document.querySelectorAll('[data-screen-label]')].map((el) => el.getAttribute('data-screen-label')));
    expect(got).toEqual(['Panneau latéral', 'Carte', 'Fiche détail', 'Fil des fiches', "Écran d'accueil"]);
    await switchLang(page, 'fr');
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('[data-screen-label]')].map((el) => el.getAttribute('data-screen-label')));
    expect(after).toEqual(got);
  });

  test('§16.8 the labels that survive a language switch are a closed list', async ({ page }) => {
    // The canary for invariant 8. Take every aria-label and title in the
    // interface in English, take them again in French, and keep the ones that
    // came out identical: a label that does not change when the language does
    // is a label that never went through t(). Every entry below is a French
    // string an English reader is served — and a new hardcoded label added to
    // the markup lands in this diff instead of only in a screen reader.
    await openMap(page, { lang: 'en', hash: '#pins=ai4realnet' });
    await settleCounts(page);
    const labels = async () => new Set((await visibleLabels(page)).filter((v) => v.trim()));
    const en = await labels();
    await switchLang(page, 'fr');
    const fr = await labels();
    const unchanged = [...en].filter((v) => fr.has(v)).sort();
    expect(unchanged).toEqual([
      'Aide',
      'Carte interactive',
      'Détail',
      'Fermer',
      'Fiches dans la vue',
      'Filtres',
      'Langue',
      'Masquer le panneau',
      'Recherche',
      'Retirer',
      'Retour',
      "Vue d'ensemble",
      'Zoom arrière',
      'Zoom avant',
    ]);
  });
});
