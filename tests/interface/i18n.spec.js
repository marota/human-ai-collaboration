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

// §3.2 is explicit that "counts are a snapshot and move with every upstream
// regeneration; the shape of the table is what is normative, not the figures" —
// so no figure below is written as a literal. facts() re-derives the shape of the
// corpus from window.HAI_DATA, the merged payload the page really loaded
// (hai-data.js plus whatever hai-data-additions.js folded into it), and it does
// so with its own traversal: an assertion is never compared against the counter,
// caption or layer row it is about. The literals left in this file are the ones
// the spec states as rules (the 1945 axis floor, §11) or that belong to the
// interface rather than to the data (I18N keys, preset labels, the hardcoded
// French aria-labels invariant 8 is failed by).
const facts = (page) => page.evaluate(() => {
  const D = window.HAI_DATA;
  // kind → the payload array it is registered from: §3.2's table, in KINDS order.
  const SRC = { project: 'PROJECTS', team: 'TEAMS', commons: 'COMMONS', framework: 'FRAMEWORKS' };
  const all = KINDS.flatMap((k) => D[SRC[k]]);
  const placed = (e) => e.lat != null && e.lon != null;
  const geo = {};
  all.forEach((e) => { geo[e.id] = placed(e); });
  // §5: adjacency is always recorded, but a link only becomes a curve — and only
  // counts as a "documented link" on the welcome panel — when both of its ends
  // are placed. Counted here from DATA.EDGES and the createdBy/usedBy lists
  // rather than read off the page's own `edges` array.
  let links = 0;
  D.EDGES.forEach((e) => { if (geo[e.project] && geo[e.team]) links++; });
  [...D.COMMONS, ...D.FRAMEWORKS].forEach((a) => {
    (a.createdBy || []).forEach((u) => { if (geo[u] && geo[a.id]) links++; });
    (a.usedBy || []).forEach((u) => { if (geo[u] && geo[a.id]) links++; });
  });
  const year = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
  const starts = all.map((e) => year((e.timeline || {}).start)).filter((y) => y != null);
  const years = all.flatMap((e) => [year((e.timeline || {}).start), year((e.timeline || {}).end)])
    .filter((y) => y != null);
  return {
    kinds: [...KINDS],
    corpus: all.length,
    layerTotals: KINDS.map((k) => D[SRC[k]].length),
    placedByLayer: KINDS.map((k) => D[SRC[k]].filter(placed).length),
    offMapByLayer: KINDS.map((k) => D[SRC[k]].filter((e) => !placed(e)).length),
    placed: all.filter(placed).length,
    offMap: all.filter((e) => !placed(e)).length,
    // The caption's first term counts the countries *in view*, so the figure to
    // hold it to is the countries of the placed population — the off-map
    // international standards carry no country at all.
    countries: new Set(all.filter(placed).map((e) => e.country).filter(Boolean)).size,
    links,
    asOf: D.AS_OF,
    // §11: the axis runs from the 1945 floor to the data's own freshness year,
    // and is never cut below the latest known start year.
    ymin: Math.max(1945, Math.min(...years)),
    ymax: Math.max(year(D.AS_OF), ...starts),
  };
});

/** The per-layer population carrying one domain, in KINDS order, derived from the
 *  payload — not from the page's own filter pass, which is the thing a narrowed
 *  layer count is being compared against. `total` counts the same set without
 *  splitting it by layer, so a mistake in the layer mapping cannot hide. */
const facetByLayer = (page, dom) => page.evaluate((d) => {
  const D = window.HAI_DATA;
  const SRC = { project: 'PROJECTS', team: 'TEAMS', commons: 'COMMONS', framework: 'FRAMEWORKS' };
  const doms = (e) => (e.domains && e.domains.length) ? e.domains : [e.domain];
  const hit = (e) => doms(e).includes(d);
  return {
    byLayer: KINDS.map((k) => D[SRC[k]].filter(hit).length),
    total: KINDS.flatMap((k) => D[SRC[k]]).filter(hit).length,
  };
}, dom);

/** A layer/domain pair that narrows the corpus to exactly one placed entity in a
 *  known country: the n = 1 boundary the singular-agreement assertions need,
 *  reached through the real controls instead of by calling the string function.
 *  Which pair that is belongs to the payload, so it is derived — the pair this
 *  file used to name (commons + maritime) gained a second member upstream, and a
 *  pinned pair quietly turns a singular test into a plural one. First match in
 *  (domain, layer) order wins, so the choice is stable for a given payload. */
const singleMatchPair = (page) => page.evaluate(() => {
  const D = window.HAI_DATA;
  const SRC = { project: 'PROJECTS', team: 'TEAMS', commons: 'COMMONS', framework: 'FRAMEWORKS' };
  const doms = (e) => (e.domains && e.domains.length) ? e.domains : [e.domain];
  for (const dom of ALL_DOMS)
    for (const kind of KINDS) {
      const hits = D[SRC[kind]].filter((e) => doms(e).includes(dom));
      if (hits.length === 1 && hits[0].lat != null && hits[0].lon != null && hits[0].country)
        return { dom, kind, layer: KINDS.indexOf(kind), id: hits[0].id };
    }
  return null;
});

// ------------------------------------------------- invariant 8: key parity

// Entities of each layer that carry the given domain and have no coordinates —
// read straight out of the payload, so the expected split is derived from the
// data rather than from the tally the page just computed.
const placelessByDomain = (page, dom) => page.evaluate((d) => {
  const n = { project: 0, team: 0, commons: 0, framework: 0 };
  const LAYER = { PROJECTS: 'project', TEAMS: 'team', COMMONS: 'commons', FRAMEWORKS: 'framework' };
  Object.entries(LAYER).forEach(([key, kind]) => window.HAI_DATA[key].forEach((e) => {
    const doms = (e.domains && e.domains.length) ? e.domains : [e.domain];
    if (doms.includes(d) && (e.lat == null || e.lon == null)) n[kind]++;
  }));
  return n;
}, dom);

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

  test('§17 the languages the page accepts are exactly the I18N blocks it ships', async ({ page }) => {
    // §17's recipe for a new language is four steps, and three of them already
    // complain if you skip them: the generator's TAXO tables are pinned to
    // exactly {en, fr}, load_descriptions iterates LANGS, and the key-parity
    // tests above sweep the I18N block. The fourth — "an entry in the switch" —
    // understates the work: the set of accepted languages is written out three
    // more times, in the switch markup and twice inside initialLang()
    // (`q==='fr'||q==='en'`, then `st==='fr'||st==='en'`), and nothing ties any
    // of them to Object.keys(I18N). A third block with no matching entry in
    // those lists would be unreachable by URL and unpersistable.
    await bootMap(page, { search: '?lang=en' });
    const langs = await page.evaluate(() => ({
      blocks: Object.keys(I18N).sort(),
      buttons: [...document.querySelectorAll('.lang-switch button')].map((b) => b.dataset.lang).sort(),
    }));
    // Not pinned to the literal pair: adding a language should make this test
    // fail at the boot loop below, which names the missing wiring, rather than
    // here on the count. But English must always be a block — t() falls back
    // to it — and French is the markup's own default.
    expect(langs.blocks).toContain('en');
    expect(langs.blocks).toContain('fr');
    expect(langs.buttons, 'a switch entry for every block, and no entry without one').toEqual(langs.blocks);

    for (const k of langs.blocks) {
      // The browser language is set to a *different* one each time, so a
      // rejected ?lang= or stored value falls through to a visible wrong answer
      // instead of coincidentally landing on the expected one.
      const other = k === 'fr' ? 'en-GB' : 'fr-FR';
      await bootMap(page, { search: '?lang=' + k, navLang: other });
      expect(await page.getAttribute('html', 'lang'), `?lang=${k} must be accepted`).toBe(k);
      await bootMap(page, { storage: { 'hai-map-lang': k }, navLang: other });
      expect(await page.getAttribute('html', 'lang'), `a stored ${k} must be honoured`).toBe(k);
    }
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
    const f = await facts(page);
    const av = await facetByLayer(page, 'aviation');
    await onlyDomain(page, 'aviation');
    await settleCounts(page);
    const want = av.byLayer;
    expect(want.reduce((a, n) => a + n, 0), 'the four layers partition the domain')
      .toBe(av.total);
    // Falsifiable only while every layer holds some aviation and not all of it:
    // at 0 the row could have stopped counting, and at the layer total it could
    // have reverted to TOTALS — the regression invariant 13 names.
    expect(want.filter((n, i) => n > 0 && n < f.layerTotals[i])).toHaveLength(f.layerTotals.length);
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
    const f = await facts(page);
    const av = await facetByLayer(page, 'aviation');
    await onlyDomain(page, 'aviation');
    await settleCounts(page);
    // Both numbers in the sentence are derived: the narrowed one from the
    // payload's aviation population, the corpus one from the layer's own array.
    // The sentence only exists while it has narrowed, hence the guard.
    expect(av.byLayer.filter((n, i) => n > 0 && n < f.layerTotals[i])).toHaveLength(f.layerTotals.length);
    const titles = async () => (await layerRows(page)).map((r) => r.title);
    // A layer holding placeless entities says so instead, in both languages —
    // the split is the sentence that has to be translated there.
    const gone = await placelessByDomain(page, 'aviation');
    const want = (lang) => av.byLayer.map((n, i) => {
      const off = gone[f.kinds[i]];
      if (!off) return lang === 'en'
        ? `${n} of ${f.layerTotals[i]} under the current filters`
        : `${n} sur ${f.layerTotals[i]} avec les filtres actuels`;
      return lang === 'en'
        ? `${n - off} on the map · ${off} with no coordinates · ${n} ${n === 1 ? 'matches' : 'match'} the filters`
        : `${n - off} sur la carte · ${off} sans coordonnées · ${n} ${n > 1 ? 'correspondent' : 'correspond'} aux filtres`;
    });
    expect(await titles()).toEqual(want('en'));
    await switchLang(page, 'fr');
    expect(await titles()).toEqual(want('fr'));
    // §14: the same string reaches a screen reader as the accessible name, so
    // it has to be translated there too and not only in the tooltip.
    const team = f.kinds.indexOf('team');
    expect(await page.locator('.layer-row[data-layer="team"] .cnt').getAttribute('aria-label'))
      .toBe(`${av.byLayer[team]} sur ${f.layerTotals[team]} avec les filtres actuels`);
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
    const f = await facts(page);
    const rows = () => page.locator('#nogeo-list .pin-item').count();
    expect(await rows()).toBe(f.offMap);
    await switchLang(page, 'fr');
    expect(await textOf(page, '#f-nogeo .sb-h span')).toBe('Hors carte');
    expect(await textOf(page, '#f-nogeo .note')).toContain('Normes internationales');
    expect(await rows()).toBe(f.offMap);          // renderNoGeo() reruns, same list
  });

  test('§12 the period control: labels change, the years do not', async ({ page }) => {
    await withCard(page);
    const f = await facts(page);
    // The axis runs from the 1945 floor to the AS_OF year, whatever the locale —
    // §11's rule, with both ends derived from the payload rather than pinned.
    const range = `${f.ymin} – ${f.ymax}`;
    expect(await textOf(page, '#tf-range')).toBe(range);
    expect(await textOf(page, '.tf-h')).toBe('Period');
    expect(await textOf(page, '#tf-opt span')).toBe('unknown start');
    expect(await page.locator('#tf-reset').getAttribute('title')).toBe('All years');
    expect(await page.locator('#tf-slider').getAttribute('title')).toBe(`${range} · earlier foundings stay included`);
    expect(await page.locator('#tf-a').getAttribute('aria-label')).toBe('First year');
    expect(await page.locator('#tf-b').getAttribute('aria-label')).toBe('Last year');
    await switchLang(page, 'fr');
    expect(await textOf(page, '#tf-range')).toBe(range);
    expect(await textOf(page, '.tf-h')).toBe('Période');
    expect(await textOf(page, '#tf-opt span')).toBe('date incertaine');
    expect(await page.locator('#tf-reset').getAttribute('title')).toBe('Toutes les années');
    expect(await page.locator('#tf-slider').getAttribute('title')).toBe(`${range} · les fondations antérieures restent incluses`);
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
    expect(before).toHaveLength((await facts(page)).placed);   // everything that has coordinates
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
    // One layer only, chosen because exactly one of its entities has no
    // coordinates — that makes the off-map hint the n = 1 case in both
    // languages. Which layer that is (today the commons, for CityLearn) is a
    // property of the payload, so it is derived rather than named.
    const f = await facts(page);
    const only = f.offMapByLayer.indexOf(1);
    expect(only, 'one layer must hold exactly one entity without coordinates').toBeGreaterThan(-1);
    await setLayers(page, [f.kinds[only]]);
    await settleCounts(page);
    expect((await snapshot(page)).offMapMatch).toBe(1);
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
    // Both are re-derived from the payload — f.links recounts the consortium
    // edges and the createdBy/usedBy pairs that have both ends placed, instead
    // of reading back the `edges` array the panel itself prints.
    const f = await facts(page);
    await expect(page.locator('#wl-figs')).toHaveText(new RegExp(`^${f.countries} countries · ${f.links} documented links ·`));
    // The per-layer figures the same panel lists, in KINDS order, then the links
    // row: the whole table a first-time reader is shown.
    expect(await page.locator('#wl-rows .wl-row .n').allTextContents())
      .toEqual([...f.layerTotals, f.links].map(String));
    // The overlay is modal and covers the switch, so the click has to be
    // dispatched: applyLang()'s `if (welcome is open) renderWelcome()` guard is
    // defensive rather than reachable with a mouse. It still has to work — a
    // deep link, a keyboard path or a narrower layout can all get there.
    await switchLangDispatched(page, 'fr');
    // applyLang() only calls renderWelcome() when the overlay is open — that
    // guard is why this has to be tested with it open.
    await expect(page.locator('#welcome h2')).toHaveText("La carte de l’écosystème humain–IA");
    await expect(page.locator('#wl-rows .wl-row b').first()).toHaveText('Projets & programmes');
    await expect(page.locator('#wl-figs')).toHaveText(new RegExp(`^${f.countries} pays · ${f.links} liens documentés ·`));
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

  // "Reopen it tomorrow in the other language" usually means switching
  // mid-task, and a list of search results is the likeliest thing to be on
  // screen when the reader reaches for the switch. §12's list of re-rendered
  // surfaces leaves the dropdown out, so these two pin what happens rather
  // than what the spec claims.
  test('§12 the open search dropdown keeps its old headings across a switch', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.fill('#search', 'delft');
    await expect(page.locator('.sd-group').first()).toHaveText('Teams');
    // Dispatched, not clicked: a real click moves focus to the button, and the
    // reader we are describing still has the caret in the search field.
    await switchLangDispatched(page, 'fr');
    // SPEC-DEVIATION: §12 has applyLang() "re-render every dynamic surface",
    // and the dropdown is one of them — its group headings come from
    // t('kinds.'+k) and its empty line from t('searchEmpty'). applyLang() does
    // not re-run runSearch(), so the markup keeps the strings it was built
    // with. Invariant 8 is still satisfied; what the reader is looking at is
    // not. The document-level outside-click handler closes the dropdown on the
    // same click, which is what keeps the stale headings from being seen
    // today — so the assertions below are on the markup, not on what is
    // visible.
    await expect(page.locator('#search-drop')).not.toHaveClass(/open/);
    expect(await textOf(page, '.sd-group')).toBe('Teams');
    // One keystroke, with the field never refocused (focus also re-runs
    // runSearch), and the heading catches up. 'delf' still finds Delft.
    await page.keyboard.press('Backspace');
    await expect(page.locator('.sd-group').first()).toHaveText('Équipes');
  });

  test('§12 the "no matches" line survives a switch unchanged too', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.fill('#search', 'zzqqxx');
    await expect(page.locator('.sd-empty')).toHaveText('No matches');
    await switchLangDispatched(page, 'fr');
    // SPEC-DEVIATION: same cause as above — the empty state is written once by
    // runSearch() and applyLang() never asks for it again.
    expect(await textOf(page, '.sd-empty')).toBe('No matches');
    await page.keyboard.press('z');                       // still nothing matches
    await expect(page.locator('.sd-empty')).toHaveText('Aucun résultat');
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
    const f = await facts(page);
    await zoomBy(page, 0.5);
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Couches');
    expect(await caption(page)).toBe(`${f.countries} pays · dans la vue · ${f.corpus} correspondent aux filtres (${f.offMap} hors carte)`);
    await page.evaluate(() => {
      for (const k of ['layersTitle', 'stCountriesN', 'stNote', 'stNoteWhy', 'stOffMap']) delete I18N.fr[k];
      applyLang();
    });
    expect(await textOf(page, '#f-layers .sb-h')).toBe('Layers');
    // The interpolating keys fall back too — a raw "stNoteWhy" in the caption is
    // the failure this guards against, and it is the caption a reader trusts.
    expect(await caption(page)).toBe(`${f.countries} countries · in view · ${f.corpus} match the filters (${f.offMap} off the map)`);
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
    // A handful of entities carry only the undifferentiated `desc`; the card must
    // show it rather than the "description to come" placeholder. The subject is
    // chosen by that property, lowest id first, rather than named: a regeneration
    // that finally translates this one should move the test to the next such
    // entity, not leave it asserting nothing.
    await openMap(page, { lang: 'en' });
    const pick = await page.evaluate(() => {
      const D = window.HAI_DATA;
      const all = ['PROJECTS', 'TEAMS', 'COMMONS', 'FRAMEWORKS'].flatMap((l) => D[l]);
      const hit = all.filter((e) => e.desc && !('desc_fr' in e) && !('desc_en' in e))
        .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      return hit ? { id: hit.id, desc: hit.desc } : null;
    });
    expect(pick, 'the payload must still hold an entity with only `desc`').not.toBeNull();
    // Deep-link to whichever entity that is. The page reads #e= once, at boot,
    // and a goto that differs from the current URL only in its fragment is a
    // same-document navigation — so the reload is what makes the deep link run.
    await page.goto(`${MAP_PATH}?lang=en#e=${pick.id}`);
    await page.reload();
    await expect(page.locator('#st-note')).not.toBeEmpty();
    await expect(page.locator('.fd-card')).toBeVisible();
    const d = await page.evaluate((id) => ({
      desc: byId[id].d.desc,
      hasFr: 'desc_fr' in byId[id].d,
      hasEn: 'desc_en' in byId[id].d,
    }), pick.id);
    expect(d.hasFr).toBe(false);
    expect(d.hasEn).toBe(false);
    expect(d.desc).toBe(pick.desc);
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
    // PINNED ON PURPOSE. Everything else in this file derives its expectation
    // from the payload, but the subject *is* the payload's own label table:
    // counting it a second way would only restate it, and without a floor the
    // `missing` assertion below would pass vacuously on an empty table. So the
    // census stays a snapshot, and a regeneration that grows *or shrinks* the
    // vocabulary is expected to come past this line. It shrank by one here:
    // `jurisdiction.global` was never in the vocabulary the framework schema
    // documents, the data repository now rejects it, and the generator's label
    // for it went with the eight entities that used to carry it. It then grew by
    // two: `kind.horizon_2020` and `kind.eu_other`, so that a Horizon 2020 grant
    // or a Digital Europe one is no longer labelled Horizon Europe.
    expect(audit.entries).toBe(68);
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
    // Every one of those gaps, not just the three spot-checked below, has to
    // degrade the way §17 promises: the de-underscored key, and the same string
    // in both languages. Derived from the list above, so a gap that appears
    // upstream is held to the rule too.
    const fallback = await page.evaluate((list) => {
      const split = (gv) => [gv.slice(0, gv.indexOf('.')), gv.slice(gv.indexOf('.') + 1)];
      const at = (l) => { LANG = l; return list.map((gv) => taxo(...split(gv))); };
      return { want: list.map((gv) => split(gv)[1].replace(/_/g, ' ')), fr: at('fr'), en: at('en') };
    }, gaps);
    expect(fallback.fr).toEqual(fallback.want);
    expect(fallback.en).toEqual(fallback.want);
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
    // One layer and one domain narrowed to a single placed entity: the n = 1
    // boundary through the real controls rather than through the string
    // function. The pair is derived, because it belongs to the payload — this
    // test used to name commons + maritime, which was one entity (OpenCLSim)
    // until OpenBridge arrived upstream and quietly made it two.
    await openMap(page, { lang: 'en' });
    const f = await facts(page);
    const pick = await singleMatchPair(page);
    expect(pick, 'the payload must hold a layer/domain pair matching one placed entity').not.toBeNull();
    await zoomBy(page, 0.5);                       // everything placed is on screen
    await setLayers(page, [pick.kind]);
    await onlyDomain(page, pick.dom);
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(1);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(0);
    await expect(page.locator('#st-note')).toHaveText('1 country · in view · 1 matches the filters');
    const one = '1 in view · 1 matches the filters', none = '0 in view · 0 match the filters';
    expect((await tiles(page)).map((t) => t.title))
      .toEqual(f.layerTotals.map((_, i) => (i === pick.layer ? one : none)));
    await switchLang(page, 'fr');
    await expect(page.locator('#st-note')).toHaveText('1 pays · dans la vue · 1 correspond aux filtres');
    expect((await tiles(page))[pick.layer].title).toBe('1 dans la vue · 1 correspond aux filtres');
    await expectCountersReconcile(page, `one ${pick.kind}, one ${pick.dom} domain`);
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
    const f = await facts(page);
    await zoomBy(page, 0.5);
    const s = await snapshot(page);
    expect(s.matchCount).toBe(f.corpus);
    expect(s.offScreen).toBe(0);
    expect(s.offMapMatch).toBe(f.offMap);
    await expect(page.locator('#st-note'))
      .toHaveText(`${f.countries} countries · in view · ${f.corpus} match the filters (${f.offMap} off the map)`);
    await switchLang(page, 'fr');
    await expect(page.locator('#st-note'))
      .toHaveText(`${f.countries} pays · dans la vue · ${f.corpus} correspondent aux filtres (${f.offMap} hors carte)`);
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
    // Again the layer with exactly one entity lacking coordinates — today the
    // commons, for CityLearn — derived rather than named, and the denominator
    // is the whole off-map population.
    const f = await facts(page);
    const only = f.offMapByLayer.indexOf(1);
    expect(only, 'one layer must hold exactly one entity without coordinates').toBeGreaterThan(-1);
    await setLayers(page, [f.kinds[only]]);
    await settleCounts(page);
    expect((await snapshot(page)).offMapMatch).toBe(1);
    expect(await textOf(page, '#nogeo-count')).toBe('1');
    expect(await page.locator('#nogeo-count').getAttribute('title')).toBe(`1 of ${f.offMap} matches the current filters`);
    await switchLang(page, 'fr');
    expect(await page.locator('#nogeo-count').getAttribute('title')).toBe(`1 sur ${f.offMap} correspond aux filtres actuels`);
  });

  test('§9.2 the off-screen term appears in the caption in both languages', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const f = await facts(page);
    await zoomBy(page, 4);                          // push most markers off screen
    const s = await snapshot(page);
    expect(s.offScreen).toBeGreaterThan(0);
    await expect(page.locator('#st-note')).toHaveText(new RegExp(`\\(${s.offScreen} off screen, ${f.offMap} off the map\\)$`));
    await switchLang(page, 'fr');
    await settleCounts(page);
    const t = await snapshot(page);
    await expect(page.locator('#st-note')).toHaveText(new RegExp(`\\(${t.offScreen} hors écran, ${f.offMap} hors carte\\)$`));
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
    // The whole team layer is in view — the precondition the claim needs, held
    // to the payload's own placed-team population rather than to a round number.
    const f = await facts(page);
    expect(pos.teamCount).toBe(f.placedByLayer[f.kinds.indexOf('team')]);
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
    // The figure comes from the payload and the grouping is done by hand here,
    // because Intl is the formatter under test: asking it for the expectation
    // would make the comparison agree with itself. spaces() has already
    // flattened the narrow spaces fr-FR groups with.
    expect(eur, 'a budget needs thousands to have separators worth asserting').toBeGreaterThanOrEqual(1000);
    const grouped = String(eur).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const row = () => page.locator('.fd-card .dt-facts div', { has: page.locator('dt', { hasText: /^(Budget)$/ }) }).locator('dd').textContent();
    expect(spaces(await row())).toBe(`€${grouped.replace(/ /g, ',')}`);
    await switchLang(page, 'fr');
    expect(spaces(await row())).toBe(`${grouped} €`);
    // The separators, not just the digits: an English reader gets ASCII commas
    // and a leading symbol, a French one narrow spaces and a trailing one.
    const fmt = await page.evaluate((n) => {
      const at = (l) => { LANG = l; return money(n); };
      return { fr: at('fr'), en: at('en') };
    }, eur);
    expect(fmt.en.startsWith('€')).toBe(true);
    expect(fmt.en).toContain(',');
    expect(fmt.fr.endsWith('€')).toBe(true);
    expect(fmt.fr).not.toContain(',');
    expect(fmt.fr).not.toBe(fmt.en);
  });

  test('§10 the freshness date is spelled out in the reader\'s locale', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const f = await facts(page);
    // The sentence wraps a date Intl formats, so the expectation is spelled out
    // from DATA.AS_OF by hand — month tables, day before month, no ordinal —
    // rather than by asking fmtAsOf(), which would agree with itself whatever it
    // produced. AS_OF moves on every upstream touch (§3.5), the shape of the
    // sentence does not.
    const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const [yy, mm, dd] = f.asOf.split('-').map(Number);
    const en = `${dd} ${EN_MONTHS[mm - 1]} ${yy}`, fr = `${dd} ${FR_MONTHS[mm - 1]} ${yy}`;
    const label = () => page.locator('#tf-asof').getAttribute('aria-label');
    expect(await label()).toBe(`Data current as of ${en} — the period slider stops at that year.`);
    await switchLang(page, 'fr');
    const frSentence = `Données à jour au ${fr} — le curseur de période s’arrête à cette année.`;
    expect(await label()).toBe(frSentence);
    // The same sentence reaches touch devices as a toast — all of it, not just
    // the date.
    await page.click('#tf-asof');
    await expect(page.locator('#toast')).toHaveText(frSentence);
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
