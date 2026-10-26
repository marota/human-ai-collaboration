// §14 accessibility.
//
// The map is one HTML file with no framework, so every accessibility affordance
// here is hand-maintained: an `aria-pressed` that a new toggle forgets to set, a
// slider whose `aria-valuenow` stops following the drag, a tile label that drops
// which layer it belongs to. Those are exactly the regressions nobody sees in a
// screenshot, which is why they are asserted here against the attribute values
// themselves rather than against the rendered pixels.
//
// Two things this file leans on deliberately:
//  * Playwright's accessible-name matchers (`toHaveAccessibleName`) use the
//    browser's own name computation, so a test can fail because a name became
//    unreachable to assistive technology even while the attribute is still in
//    the markup.
//  * Expected counts are derived from `window.HAI_DATA` — the raw payload — not
//    from `items`/`state`, so a counter and its label cannot agree by both being
//    wrong in the same way (rule: derive the expectation independently).
//
// No corpus figure is written down anywhere below. §3.2 says it plainly —
// "Counts are a snapshot and move with every upstream regeneration; the shape
// of the table is what is normative, not the figures" — so every number an
// assertion compares against is computed from the payload the page just
// loaded, and what stays pinned is the shape around it: the four layer names,
// the sentence the figures are poured into, and the verb each figure takes.
import { test, expect } from '@playwright/test';
import {
  openMap, snapshot, tiles, layerRows, toggleLayer, setLayers,
  nudgePeriod, periodLabel, settleCounts, zoomBy, fitAll, openViaSearch,
} from './_map.js';

// The data bounds the period slider must expose, re-derived from the payload by
// §10's rule rather than read back out of the page's YMIN/YMAX.
async function payloadYears(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const all = [...D.PROJECTS, ...D.COMMONS, ...D.TEAMS, ...D.FRAMEWORKS];
    const y = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
    const years = all.flatMap((e) => [y((e.timeline || {}).start), y((e.timeline || {}).end)]).filter((n) => n != null);
    const starts = all.map((e) => y((e.timeline || {}).start)).filter((n) => n != null);
    const asOf = D.AS_OF ? parseInt(D.AS_OF.slice(0, 4), 10) : null;
    return {
      min: Math.max(1945, Math.min(...years)),
      max: Math.max(asOf || Math.max(...years), Math.max(...starts)),
    };
  });
}

/** How many entities the period rule of §10.1–10.2 leaves for [a,b], computed
 *  from the payload rather than from the page's own periodState(): an unknown
 *  start is out only when its host's founding year is later than b, solid from
 *  2020, and otherwise kept as "possibly" while the unknown-start switch is on. */
async function payloadPeriodMatches(page, a, b, undated = true) {
  return page.evaluate(([A, B, UND]) => {
    const D = window.HAI_DATA;
    const y = (v) => { const m = /^(\d{4})/.exec(String(v == null ? '' : v)); return m ? +m[1] : null; };
    return [...D.PROJECTS, ...D.COMMONS, ...D.TEAMS, ...D.FRAMEWORKS].filter((e) => {
      const tl = e.timeline || {};
      const y0 = y(tl.start), y1 = y(tl.end);
      const vague = !(y0 != null || y1 != null) || !!e.dateHost;
      if (vague) {
        if (y0 != null && B < y0) return false;
        if (B >= 2020) return true;
        return UND;
      }
      return (y0 == null ? -Infinity : y0) <= B && (y1 == null ? Infinity : y1) >= A;
    }).length;
  }, [a, b, undated]);
}

/** The corpus as the payload carries it: one count per layer, keyed by the
 *  page's own KINDS, plus the number of distinct ids across all four. Keying
 *  off KINDS rather than a literal list of four names means a fifth layer
 *  makes this throw rather than go quietly uncounted. */
async function payloadTotals(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const groups = { project: D.PROJECTS, team: D.TEAMS, commons: D.COMMONS, framework: D.FRAMEWORKS };
    const byKind = {};
    for (const k of KINDS) byKind[k] = groups[k].length;
    const all = KINDS.flatMap((k) => groups[k]);
    return { byKind, ids: new Set(all.map((e) => e.id)).size };
  });
}

/** The entities the map cannot place, derived twice over: once from the absence
 *  of a usable coordinate pair, once from the `geo:false` flag §3.1.4 says the
 *  generator must leave on exactly those entities and no others. Two
 *  derivations rather than a count, because a count is a snapshot and "eleven"
 *  agrees just as happily with the wrong eleven. */
async function payloadOffMap(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const all = [...D.PROJECTS, ...D.COMMONS, ...D.TEAMS, ...D.FRAMEWORKS];
    return {
      missingCoords: all.filter((e) => e.lat == null || e.lon == null).map((e) => e.id),
      flagged: all.filter((e) => e.geo === false).map((e) => e.id),
    };
  });
}

/** Witnesses for the two verb-agreement boundaries of §9.1, chosen out of the
 *  payload rather than named: a (domain, layer) pair nothing matches, and one
 *  exactly one entity matches — the latter only in a domain that also has a
 *  layer with more than one, so a single narrowing exercises the singular and
 *  the plural branch together. The domain axis is read off the real
 *  checkboxes, so a witness is always a domain the reader can select; the
 *  counts come from the payload. Deterministic (first match in checkbox order,
 *  then KINDS order), and a regeneration moves the witness instead of voiding
 *  the test. */
async function agreementWitnesses(page) {
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    const groups = { project: D.PROJECTS, team: D.TEAMS, commons: D.COMMONS, framework: D.FRAMEWORKS };
    const doms = [...document.querySelectorAll('input[data-dom]')].map((cb) => cb.dataset.dom);
    const count = (d, k) => groups[k].filter((e) =>
      ((e.domains && e.domains.length) ? e.domains : [e.domain]).includes(d)).length;
    let zero = null, single = null;
    for (const domain of doms) for (const kind of KINDS) {
      const n = count(domain, kind);
      if (n === 0 && !zero) zero = { domain, kind };
      if (n === 1 && !single) {
        const plural = KINDS.map((k) => ({ kind: k, n: count(domain, k) })).find((c) => c.n > 1);
        if (plural) single = { domain, kind, plural };
      }
    }
    return { zero, single };
  });
}

/** One real entity's id, for the tests that need it *before* the page boots —
 *  a seeded pin arrives through localStorage. Which entity it is does not
 *  matter to those tests, so it is taken from the corpus (first by id) rather
 *  than named, and the throwaway first load is what makes the payload
 *  readable at all. */
async function someEntityId(page) {
  await openMap(page);
  return page.evaluate(() => {
    const D = window.HAI_DATA;
    return [...D.PROJECTS, ...D.COMMONS, ...D.TEAMS, ...D.FRAMEWORKS].map((e) => e.id).sort()[0];
  });
}

/** The four layer names as the English interface writes them. These are
 *  interface strings rather than data — i18n.spec.js owns their translation —
 *  so they stay pinned, which is what lets a tile's accessible name be checked
 *  as one whole string instead of a tail-anchored fragment. */
const LAYER_LABEL = { project: 'Projects', team: 'Teams', commons: 'Commons', framework: 'Frameworks' };

/** Narrow the domain axis to exactly one domain, through the real controls:
 *  every group's "None", then the one checkbox. */
async function onlyDomain(page, domain) {
  for (const b of await page.locator('.mini-btn[data-ga="none"]').all()) await b.click();
  await page.click(`input[data-dom="${domain}"]`);
  await settleCounts(page);
}

/** Can this element take focus at all? A `role="button"` with no tabindex
 *  cannot, which is invisible in the markup but decisive for a keyboard user. */
const canFocus = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  el.focus();
  return document.activeElement === el;
}, sel);

/** Record the `behavior` of every scrollIntoView the page asks for. §14's
 *  reduced-motion claim is about that argument — the destination is the same
 *  either way — so the only way to see it is to intercept the call. */
const recordScrolls = (page) => page.addInitScript(() => {
  window.__scrolls = [];
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (opt) { window.__scrolls.push(opt && opt.behavior); return orig.call(this, opt); };
});

const attrs = (page, sel, names) => page.evaluate(([s, ns]) => {
  const el = document.querySelector(s);
  return ns.reduce((o, n) => (o[n] = el.getAttribute(n), o), {});
}, [sel, names]);

// ---------------------------------------------------------------------------
test.describe('§14 landmarks and regions', () => {
  // "Semantic landmarks; data-screen-label on each region." The labelled
  // regions are also what the screenshot tooling names, so the list is fixed:
  // a new region that forgets the attribute is a region nothing can address.
  test('§14 every labelled region is a landmark, and its label names that region', async ({ page }) => {
    await openMap(page);
    const regions = await page.evaluate(() =>
      [...document.querySelectorAll('[data-screen-label]')].map((el) => ({
        id: el.id, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
        label: el.dataset.screenLabel,
      })));
    // The labels are pinned rather than checked for being non-empty. "Each
    // region carries a label" is satisfied just as well by five copies of one
    // word, or by two labels swapped in a markup reorder — and a region that
    // answers to the wrong name is worse than one that answers to none, since
    // the label is the handle the region is addressed by.
    expect(regions).toEqual([
      { id: 'sidebar', tag: 'aside', role: null, label: 'Panneau latéral' },
      { id: 'stage', tag: 'main', role: null, label: 'Carte' },
      { id: 'detail', tag: 'aside', role: null, label: 'Fiche détail' },
      { id: 'feed', tag: 'aside', role: null, label: 'Fil des fiches' },
      { id: 'welcome', tag: 'div', role: 'dialog', label: "Écran d'accueil" },
    ]);
    expect(new Set(regions.map((r) => r.label)).size, 'two regions share a label').toBe(regions.length);
  });

  test('§14 there is exactly one main landmark and one h1', async ({ page }) => {
    await openMap(page);
    expect(await page.locator('main').count()).toBe(1);
    expect(await page.locator('h1').count()).toBe(1);
    await expect(page.locator('main')).toHaveAttribute('id', 'stage');
  });

  test('§14 the map itself carries a role and a label', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('#map')).toHaveRole('application');
    // Pinned: role="application" hands keystrokes to the page, so the name is
    // the only thing that tells a reader what they have just stepped into.
    await expect(page.locator('#map')).toHaveAccessibleName('Carte interactive');
  });

  test('§14 the two aside panels carry their own accessible names', async ({ page }) => {
    await openMap(page);
    // #detail and #feed are labelled independently of data-screen-label, since
    // a reader landing in one of them needs to know which panel it is.
    expect(await attrs(page, '#detail', ['aria-label'])).toEqual({ 'aria-label': 'Détail' });
    // Pinned rather than truthy: the two panels sit side by side, so the names
    // only do their job if they differ from each other.
    expect(await attrs(page, '#feed', ['aria-label'])).toEqual({ 'aria-label': 'Fiches dans la vue' });
  });

  test('§14 decorative graphics are hidden from the accessibility tree', async ({ page }) => {
    await openMap(page);
    // The brand mark, the period histogram and the feed chevrons say nothing a
    // reader needs: they duplicate text that is already there.
    await expect(page.locator('.brand svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#tf-hist')).toHaveAttribute('aria-hidden', 'true');
    // The feed is open at this width, so its rows are rendered: every chevron
    // is a repeat of "opens this card", which the row's own name already says.
    expect(await page.evaluate(() => {
      const chev = [...document.querySelectorAll('.fd-row .chev')];
      return { n: chev.length, hidden: chev.every((c) => c.getAttribute('aria-hidden') === 'true') };
    })).toEqual({ n: await page.locator('.fd-row').count(), hidden: true });
    expect(await page.locator('.fd-row').count()).toBeGreaterThan(10);
  });

  test('§14 the document language follows the interface language', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.click('.lang-switch [data-lang="fr"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 aria-pressed on every toggle', () => {
  test('§14 exactly nine controls claim a pressed state, and they are the toggles', async ({ page }) => {
    await openMap(page);
    // Enumerated rather than spot-checked: the failure this guards against is a
    // new two-state control that keeps its state in a CSS class only.
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('[aria-pressed]')].map((el) => el.id || el.dataset.layer)))
      .toEqual(['project', 'team', 'commons', 'framework', 'links-row', 'links-pill', 'mymap-pill',
        'feed-pill', 'chat-pill']);
  });

  test('§14 the four layer toggles start pressed and track state', async ({ page }) => {
    await openMap(page);
    expect((await layerRows(page)).map((r) => r.on)).toEqual([true, true, true, true]);
    await toggleLayer(page, 'commons');
    expect(await attrs(page, '.layer-row[data-layer="commons"]', ['aria-pressed']))
      .toEqual({ 'aria-pressed': 'false' });
    expect((await snapshot(page)).layers).toEqual({ project: true, team: true, commons: false, framework: true });
    await toggleLayer(page, 'commons');
    expect(await attrs(page, '.layer-row[data-layer="commons"]', ['aria-pressed']))
      .toEqual({ 'aria-pressed': 'true' });
  });

  test('§14 a layer toggle is operable from the keyboard and keeps its focus', async ({ page }) => {
    await openMap(page);
    // Focus survives because the row updates its own attribute in place; a
    // handler that re-rendered the list would drop the reader back to the body.
    const row = page.locator('.layer-row[data-layer="team"]');
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.activeElement.dataset.layer)).toBe('team');
    await page.keyboard.press(' ');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.activeElement.dataset.layer)).toBe('team');
  });

  test('§14 aria-pressed drives the switch graphic, so it cannot go stale silently', async ({ page }) => {
    await openMap(page);
    // .layer-row[aria-pressed="true"] .sw is the only thing that moves the
    // knuckle: the attribute is the state, not a copy of it.
    const knuckle = () => page.evaluate(() =>
      getComputedStyle(document.querySelector('.layer-row[data-layer="project"] .sw'), '::after').transform);
    await expect.poll(knuckle).toBe('matrix(1, 0, 0, 1, 11, 0)');
    await toggleLayer(page, 'project');
    await expect.poll(knuckle).toBe('none');
  });

  test('§14 the two links controls report one state between them', async ({ page }) => {
    await openMap(page);
    // Same state, two controls in two places — the classic desync.
    await expect(page.locator('#links-row')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#links-pill')).toHaveAttribute('aria-pressed', 'false');
    await page.click('#links-row');
    await expect(page.locator('#links-row')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#links-pill')).toHaveAttribute('aria-pressed', 'true');
    expect((await snapshot(page)).links).toBe(true);
    await page.click('#links-pill');
    await expect(page.locator('#links-row')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#links-pill')).toHaveAttribute('aria-pressed', 'false');
  });

  test('§14 the feed pill reports whether the drawer is open', async ({ page }) => {
    await openMap(page);
    // 1280px wide, so the feed is open by default (§5).
    await expect(page.locator('#feed-pill')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#feed-pill');
    await expect(page.locator('#feed-pill')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.body.classList.contains('feed-open'))).toBe(false);
  });

  test('§14 My map with no pins refuses, and says so, rather than lying about its state', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('#mymap-pill')).toHaveAttribute('aria-pressed', 'false');
    await page.click('#mymap-pill');
    // The toast is the announcement; the pill must not claim a mode that was
    // never entered.
    await expect(page.locator('#toast')).toHaveClass(/show/);
    await expect(page.locator('#mymap-pill')).toHaveAttribute('aria-pressed', 'false');
    expect((await snapshot(page)).myMap).toBe(false);
  });

  test('§14 My map with one pin reports pressed on both of its controls', async ({ page }) => {
    // What the pill reports is "there is at least one pin", so the pinned
    // entity's identity is immaterial and comes from the payload rather than
    // being named — a regeneration that retires whichever entity we would have
    // written down cannot leave this test pinning an id the corpus has lost.
    const id = await someEntityId(page);
    await openMap(page, { storage: { 'hai-map-v2-pins': JSON.stringify([id]) } });
    await page.click('#mymap-pill');
    await settleCounts(page);
    await expect(page.locator('#mymap-pill')).toHaveAttribute('aria-pressed', 'true');
    expect((await snapshot(page)).myMap).toBe(true);
  });

  test('§14 with every layer off the toggles all read false and the counts say zero', async ({ page }) => {
    await openMap(page);
    await setLayers(page, []);
    await settleCounts(page);
    expect((await layerRows(page)).map((r) => r.on)).toEqual([false, false, false, false]);
    expect((await tiles(page)).map((t) => t.count)).toEqual([0, 0, 0, 0]);
    for (const k of ['project', 'team', 'commons', 'framework'])
      await expect(page.locator(`#st-${k}`).locator('..')).toHaveAccessibleName(
        new RegExp(`— 0 in view · 0 match the filters$`));
  });

  test('§14 aria-expanded marks the open feed row, and only that one', async ({ page }) => {
    await openMap(page);
    const rows = page.locator('.fd-row');
    expect(await rows.count()).toBeGreaterThan(1);
    expect(await page.locator('.fd-row[aria-expanded="true"]').count()).toBe(0);
    const id = await page.evaluate(() => {
      const first = document.querySelector('.fd-row').dataset.open;
      openEntity(first, { fly: false });
      return first;
    });
    await expect(page.locator('.fd-row[aria-expanded="true"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector('.fd-row[aria-expanded="true"]').dataset.open)).toBe(id);
  });

  test('§14 closing the card clears aria-expanded instead of leaving it stale', async ({ page }) => {
    await openMap(page);
    // The feed is rendered from a cache key (§15) that includes the focused id,
    // so this is where a keyed render goes wrong: the row keeps saying it is
    // open after the card has gone.
    await page.evaluate(() => openEntity(document.querySelector('.fd-row').dataset.open, { fly: false }));
    await expect(page.locator('.fd-row[aria-expanded="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fd-row[aria-expanded="true"]')).toHaveCount(0);
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('.fd-row')].every((b) => b.getAttribute('aria-expanded') === 'false'))).toBe(true);
  });

  // SPEC-DEVIATION: §14 says "aria-pressed on every toggle", but the language
  // switch keeps its state in a CSS class only. A screen-reader user cannot
  // tell which of EN / FR is the current language — the group is labelled, the
  // selection is not. Asserting the current behaviour so the gap is visible.
  test('§14 SPEC-DEVIATION the language switch exposes its selection visually only', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const langs = await page.evaluate(() => [...document.querySelectorAll('.lang-switch button')].map((b) => ({
      lang: b.dataset.lang, active: b.classList.contains('is-active'),
      pressed: b.getAttribute('aria-pressed'), checked: b.getAttribute('aria-checked'), current: b.getAttribute('aria-current'),
    })));
    expect(langs).toEqual([
      { lang: 'en', active: true, pressed: null, checked: null, current: null },
      { lang: 'fr', active: false, pressed: null, checked: null, current: null },
    ]);
    // The group around them is at least named.
    expect(await attrs(page, '.lang-switch', ['role'])).toEqual({ role: 'group' });
    await expect(page.locator('.lang-switch')).toHaveAccessibleName('Langue');
  });

  // SPEC-DEVIATION: the same omission on the preset chips. renderPresetsActive()
  // marks the chip matching the current domain set with .active, which no
  // assistive technology can read.
  test('§14 SPEC-DEVIATION the active preset chip is marked by class only', async ({ page }) => {
    await openMap(page);
    const chips = await page.evaluate(() => [...document.querySelectorAll('#presets [data-preset]')].map((b) => ({
      id: b.dataset.preset, active: b.classList.contains('active'), pressed: b.getAttribute('aria-pressed'),
    })));
    expect(chips.filter((c) => c.active).length).toBe(1);
    expect(chips.every((c) => c.pressed === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 the period handles are sliders', () => {
  test('§14 both knobs expose role, min, max, value and a label at boot', async ({ page }) => {
    await openMap(page);
    const { min, max } = await payloadYears(page);
    for (const [id, label] of [['tf-a', 'First year'], ['tf-b', 'Last year']]) {
      await expect(page.locator(`#${id}`)).toHaveRole('slider');
      expect(await attrs(page, `#${id}`, ['tabindex', 'aria-valuemin', 'aria-valuemax', 'aria-label'])).toEqual({
        tabindex: '0', 'aria-valuemin': String(min), 'aria-valuemax': String(max), 'aria-label': label,
      });
    }
    // Boot state is the full span: the first knob sits on the floor, the second
    // on the data's freshness year (§10.3).
    expect(await attrs(page, '#tf-a', ['aria-valuenow', 'aria-valuetext']))
      .toEqual({ 'aria-valuenow': String(min), 'aria-valuetext': String(min) });
    expect(await attrs(page, '#tf-b', ['aria-valuenow', 'aria-valuetext']))
      .toEqual({ 'aria-valuenow': String(max), 'aria-valuetext': String(max) });
    expect(await periodLabel(page)).toBe(`${min} – ${max}`);
  });

  test('§14 the arrow keys move one year and the value follows', async ({ page }) => {
    await openMap(page);
    const { min, max } = await payloadYears(page);
    await nudgePeriod(page, 'a', 'ArrowRight', 5);
    expect(await attrs(page, '#tf-a', ['aria-valuenow', 'aria-valuetext']))
      .toEqual({ 'aria-valuenow': String(min + 5), 'aria-valuetext': String(min + 5) });
    expect(await periodLabel(page)).toBe(`${min + 5} – ${max}`);
    await nudgePeriod(page, 'a', 'ArrowLeft', 2);
    await expect(page.locator('#tf-a')).toHaveAttribute('aria-valuenow', String(min + 3));
    // Up/Down are the same axis, for a reader who reaches for them.
    await nudgePeriod(page, 'a', 'ArrowUp', 1);
    await expect(page.locator('#tf-a')).toHaveAttribute('aria-valuenow', String(min + 4));
    await nudgePeriod(page, 'a', 'ArrowDown', 4);
    await expect(page.locator('#tf-a')).toHaveAttribute('aria-valuenow', String(min));
  });

  test('§14 PageUp and PageDown move five years', async ({ page }) => {
    await openMap(page);
    const { min, max } = await payloadYears(page);
    await nudgePeriod(page, 'b', 'PageDown', 3);
    await expect(page.locator('#tf-b')).toHaveAttribute('aria-valuenow', String(max - 15));
    await nudgePeriod(page, 'b', 'PageUp', 1);
    await expect(page.locator('#tf-b')).toHaveAttribute('aria-valuenow', String(max - 10));
    expect(await periodLabel(page)).toBe(`${min} – ${max - 10}`);
  });

  test('§14 the slider floor holds: ArrowLeft at the minimum stays at the minimum', async ({ page }) => {
    await openMap(page);
    const { min } = await payloadYears(page);
    // §10 keeps the axis at 1945 even though a handful of founders predate it,
    // so the floor is a real edge a keyboard user will hit.
    await nudgePeriod(page, 'a', 'ArrowLeft', 3);
    await expect(page.locator('#tf-a')).toHaveAttribute('aria-valuenow', String(min));
    expect((await snapshot(page)).years.a).toBe(min);
  });

  test('§14 the slider ceiling holds at the freshness year', async ({ page }) => {
    await openMap(page);
    const { max } = await payloadYears(page);
    await nudgePeriod(page, 'b', 'ArrowRight', 3);
    await expect(page.locator('#tf-b')).toHaveAttribute('aria-valuenow', String(max));
    expect((await snapshot(page)).years.b).toBe(max);
  });

  test('§14 End on the first knob cannot overtake the second', async ({ page }) => {
    await openMap(page);
    const { min, max } = await payloadYears(page);
    await nudgePeriod(page, 'b', 'PageDown', 2);          // b = max - 10
    await nudgePeriod(page, 'a', 'End', 1);
    await expect(page.locator('#tf-a')).toHaveAttribute('aria-valuenow', String(max - 10));
    await expect(page.locator('#tf-b')).toHaveAttribute('aria-valuenow', String(max - 10));
    // A collapsed range names one year rather than repeating it.
    expect(await periodLabel(page)).toBe(String(max - 10));
    await nudgePeriod(page, 'a', 'Home', 1);
    await expect(page.locator('#tf-a')).toHaveAttribute('aria-valuenow', String(min));
  });

  test('§14 Home on the second knob collapses onto the first, never below it', async ({ page }) => {
    await openMap(page);
    const { min } = await payloadYears(page);
    await nudgePeriod(page, 'a', 'PageUp', 4);           // a = min + 20
    await nudgePeriod(page, 'b', 'Home', 1);
    await expect(page.locator('#tf-b')).toHaveAttribute('aria-valuenow', String(min + 20));
    expect((await snapshot(page)).years).toMatchObject({ a: min + 20, b: min + 20 });
  });

  test('§14 a key the slider does not own leaves the value alone', async ({ page }) => {
    await openMap(page);
    const { min, max } = await payloadYears(page);
    await nudgePeriod(page, 'a', 'x', 1);
    await nudgePeriod(page, 'b', 'Enter', 1);
    expect((await snapshot(page)).years).toMatchObject({ a: min, b: max });
    expect(await periodLabel(page)).toBe(`${min} – ${max}`);
  });

  test('§14 the knob shows a focus ring and a filled state when focused', async ({ page }) => {
    await openMap(page);
    const seen = await page.evaluate(() => {
      const el = document.getElementById('tf-a');
      const before = getComputedStyle(el).backgroundColor;
      el.focus();
      return {
        before, after: getComputedStyle(el).backgroundColor,
        focusVisible: el.matches(':focus-visible'),
        outline: getComputedStyle(el).outlineWidth + ' ' + getComputedStyle(el).outlineStyle,
      };
    });
    expect(seen.before).toBe('rgb(255, 255, 255)');        // --surface
    expect(seen.after).toBe('rgb(164, 85, 43)');           // --accent, from .tf-knob:focus-visible
    expect(seen.focusVisible).toBe(true);
    expect(seen.outline).toBe('2px solid');
  });

  test('§14 the knob labels are translated with the rest of the interface', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    expect(await attrs(page, '#tf-a', ['aria-label'])).toEqual({ 'aria-label': 'First year' });
    await page.click('.lang-switch [data-lang="fr"]');
    expect(await attrs(page, '#tf-a', ['aria-label'])).toEqual({ 'aria-label': 'Première année' });
    expect(await attrs(page, '#tf-b', ['aria-label'])).toEqual({ 'aria-label': 'Dernière année' });
  });

  test('§14 the value the slider reports is the value the filter used', async ({ page }) => {
    await openMap(page);
    const { min, max } = await payloadYears(page);
    // The slider is not just an ARIA widget: a knob that updated aria-valuenow
    // without running refresh() would announce a map nobody is looking at. The
    // expected count comes from the payload by §10's rule, not from the page.
    const expected = await payloadPeriodMatches(page, min, max - 30);
    // The figure itself is a snapshot (§3.2), so what is checked in its place
    // is that this window is a real narrowing: it leaves something out, and it
    // does not leave everything out. Without that, `matchCount === expected`
    // would hold just as well for a period filter that had stopped filtering.
    const { ids } = await payloadTotals(page);
    expect({ everything: expected === ids, nothing: expected === 0 })
      .toEqual({ everything: false, nothing: false });
    await nudgePeriod(page, 'b', 'PageDown', 6);          // b = max - 30
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.years).toMatchObject({ a: min, b: max - 30 });
    expect(await attrs(page, '#tf-b', ['aria-valuenow', 'aria-valuetext']))
      .toEqual({ 'aria-valuenow': String(max - 30), 'aria-valuetext': String(max - 30) });
    expect(await periodLabel(page)).toBe(`${min} – ${max - 30}`);
    expect(s.matchCount).toBe(expected);
  });

  test('§14 the unknown-start row is out of the tab order until the period is engaged', async ({ page }) => {
    await openMap(page);
    // #tf-row2 is `hidden` at the full span, so its reset button and checkbox
    // are not focus stops a keyboard reader has to walk past for nothing.
    await expect(page.locator('#tf-row2')).toBeHidden();
    expect(await canFocus(page, '#tf-reset')).toBe(false);
    expect(await canFocus(page, '#tf-undated')).toBe(false);
    await nudgePeriod(page, 'a', 'PageUp', 1);
    await expect(page.locator('#tf-row2')).toBeVisible();
    expect(await canFocus(page, '#tf-reset')).toBe(true);
    expect(await canFocus(page, '#tf-undated')).toBe(true);
    await expect(page.locator('#tf-reset')).toHaveAccessibleName('All years');
  });

  test('§14 the unknown-start switch never hides itself from under the reader', async ({ page }) => {
    await openMap(page);
    const { min } = await payloadYears(page);
    // The other half of the rule above. #tf-row2 unfolds while the period is
    // engaged *or* the unknown-start switch is off, and the second clause is
    // the one that matters for focus: the switch lives inside that row, so a
    // row that folded away the moment the range widened back would take the
    // control the reader had just used with it — leaving a changed filter axis
    // with nothing to change it back by, and focus dropped to the body.
    await nudgePeriod(page, 'a', 'PageUp', 1);
    await expect(page.locator('#tf-row2')).toBeVisible();
    await page.locator('#tf-undated').focus();
    await page.keyboard.press(' ');
    await expect(page.locator('#tf-undated')).not.toBeChecked();
    expect(await page.evaluate(() => document.activeElement.id)).toBe('tf-undated');
    // Back at the full span the period axis is off, so nothing is filtered by
    // it any more — but the switch the reader turned off is still off.
    await nudgePeriod(page, 'a', 'PageDown', 1);
    expect((await snapshot(page)).years.a).toBe(min);
    await expect(page.locator('#tf-row2')).toBeVisible();
    expect(await canFocus(page, '#tf-undated')).toBe(true);
    await expect(page.locator('#tf-undated')).not.toBeChecked();
    // Turning it back on restores the documented default, and only then does
    // the row fold away.
    await page.locator('#tf-undated').focus();
    await page.keyboard.press(' ');
    await expect(page.locator('#tf-undated')).toBeChecked();
    await expect(page.locator('#tf-row2')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 the stats block is a live region', () => {
  test('§14 the counters sit in one aria-live=polite region', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('.stats')).toHaveAttribute('aria-live', 'polite');
    expect(await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((el) => el.className)))
      .toEqual(['stats']);
    // All four tiles are inside it — a tile outside would change in silence.
    expect(await page.evaluate(() =>
      KINDS.every((k) => document.getElementById('st-' + k).closest('[aria-live]') !== null))).toBe(true);
  });

  // SPEC-DEVIATION: §14 says the counters are in a polite live region, and §9.1
  // makes the caption the sentence that explains the tiles ("… 11 off the map").
  // The caption is a sibling of .stats, not inside it, so the figures are
  // announced without the reason they differ. Current behaviour asserted.
  test('§14 SPEC-DEVIATION the caption that explains the tiles is outside the live region', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => !!document.getElementById('st-note').closest('[aria-live]'))).toBe(false);
    // It is at least adjacent, so a reader who goes looking finds it.
    expect(await page.evaluate(() =>
      document.getElementById('st-note').previousElementSibling.className)).toBe('stats');
  });

  test('§14 each tile keeps the layer name in front of its reconciliation', async ({ page }) => {
    await openMap(page);
    // The tiles live in the live region, so the label has to carry the layer:
    // a bare "24 in view · 25 match the filters" announces a number without
    // saying what it counts (§9.1).
    // §3.2: the figures are a snapshot, the shape of the table is not. What is
    // pinned is that shape — the four layers the interface counts — while every
    // figure is derived. The partition check is what keeps the derivation
    // honest: the four layers between them hold each entity exactly once, so a
    // tile's match half cannot come out right against a corpus the payload
    // never had (an entity counted in two layers, say).
    const { byKind: totals, ids } = await payloadTotals(page);
    expect(Object.keys(totals)).toEqual(['project', 'team', 'commons', 'framework']);
    expect(Object.values(totals).reduce((a, n) => a + n, 0)).toBe(ids);
    const t = await tiles(page);
    for (const tile of t) {
      const host = page.locator(`#st-${tile.kind}`).locator('..');
      await expect(host).toHaveAccessibleName(`${tile.label} — ${tile.title}`);
      // Pinned whole rather than matched against /match(es)?/, which accepts
      // either verb for either number and so cannot see an agreement branch
      // that has stopped branching. Nothing is filtered out at boot, so the
      // match half of every label is that layer's own corpus count — straight
      // from the payload.
      const m = totals[tile.kind];
      expect(tile.title).toBe(`${tile.count} in view · ${m} ${m === 1 ? 'matches' : 'match'} the filters`);
    }
  });

  test('§14 a tile with nothing matching says "0 match", a tile with one says "1 matches"', async ({ page }) => {
    await openMap(page);
    // The two boundaries of §9.1's agreement rule, with the witnesses taken
    // from the payload instead of named: whichever (domain, layer) pair no
    // entity matches, and whichever exactly one entity matches. Which pair
    // that is moves with every regeneration; that "0" takes the plural verb
    // and "1" the singular one does not.
    const { zero, single } = await agreementWitnesses(page);
    // Stated rather than left to a TypeError two lines down: if a regeneration
    // ever leaves no (domain, layer) pair empty, or none with exactly one, the
    // boundaries have moved and this test needs a new witness — which is worth
    // saying in those words.
    expect({ empty: !!zero, singleton: !!single },
      'the payload no longer offers a witness for one of the agreement boundaries')
      .toEqual({ empty: true, singleton: true });
    await onlyDomain(page, zero.domain);
    // Checked as one whole string: nothing is in view either, since a layer
    // with no match has no marker to show.
    await expect(page.locator(`#st-${zero.kind}`).locator('..'))
      .toHaveAccessibleName(`${LAYER_LABEL[zero.kind]} — 0 in view · 0 match the filters`);

    await onlyDomain(page, single.domain);
    await expect(page.locator(`#st-${single.kind}`).locator('..'))
      .toHaveAccessibleName(new RegExp(`· 1 matches the filters$`));
    // The same narrowing carries a layer with more than one, so the plural
    // branch is measured against the singular one rather than on its own.
    await expect(page.locator(`#st-${single.plural.kind}`).locator('..'))
      .toHaveAccessibleName(new RegExp(`· ${single.plural.n} match the filters$`));
  });

  test('§14 the French labels agree with their own number', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    const { single } = await agreementWitnesses(page);
    expect(!!single, 'no (domain, layer) pair matches exactly one entity any more').toBe(true);
    await onlyDomain(page, single.domain);
    // « 1 correspond » / « 14 correspondent » — the verb is part of the
    // announced name, so it has to be right in both languages. The numbers are
    // derived; the agreement each number triggers is what is pinned.
    await expect(page.locator(`#st-${single.kind}`).locator('..'))
      .toHaveAccessibleName(new RegExp(`· 1 correspond aux filtres$`));
    await expect(page.locator(`#st-${single.plural.kind}`).locator('..'))
      .toHaveAccessibleName(new RegExp(`· ${single.plural.n} correspondent aux filtres$`));
  });

  test('§14 the announced names are recomputed when the view moves, not only when filters do', async ({ page }) => {
    await openMap(page);
    await fitAll(page);
    const wide = await tiles(page);
    await zoomBy(page, 6);
    const close = await tiles(page);
    // Zooming in leaves markers off screen: the in-view half of every label has
    // to fall, while the match half holds.
    expect(close.reduce((a, x) => a + x.count, 0)).toBeLessThan(wide.reduce((a, x) => a + x.count, 0));
    for (const tile of close) {
      await expect(page.locator(`#st-${tile.kind}`).locator('..'))
        .toHaveAccessibleName(`${tile.label} — ${tile.title}`);
      expect(tile.title.startsWith(`${tile.count} in view`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 accessible names on icon-only controls', () => {
  // Every one of these is a glyph — ×, ⟨, ⓘ, ⟲, +, −, ⌂, ? — so the only name
  // it can have is the one the markup gives it.
  const ICONS = ['#sb-hide', '#dt-close', '#dt-back', '#fd-close', '#help-btn', '#z-in', '#z-out', '#z-fit'];

  test('§14 every icon-only button carries an aria-label, and no two share one', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    // Pinned and checked for duplicates rather than measured for length: "a
    // name longer than two characters" passes just as happily for a label
    // copy-pasted from the button next to it, which is the mistake two
    // adjacent glyphs invite — + and − carrying the same name leave a reader
    // no way to tell zoom in from zoom out, and nothing else in this file
    // looks at #z-out's name. All but #fd-close are hard-coded French even
    // here (the deviation pinned further down); #fd-close is the one applyLang
    // does re-translate, which is why it reads English in an English page.
    const names = {};
    for (const sel of ICONS) names[sel] = (await attrs(page, sel, ['aria-label']))['aria-label'];
    expect(names).toEqual({
      '#sb-hide': 'Masquer le panneau', '#dt-close': 'Fermer', '#dt-back': 'Retour',
      '#fd-close': 'Hide feed', '#help-btn': 'Aide',
      '#z-in': 'Zoom avant', '#z-out': 'Zoom arrière', '#z-fit': "Vue d'ensemble",
    });
    expect(new Set(Object.values(names)).size, 'two glyphs answer to one name').toBe(ICONS.length);
  });

  // SPEC-DEVIATION (minor): the same glyph buttons are inconsistent about the
  // hover tooltip that gives a sighted mouse user the same sentence. #sb-hide,
  // #z-fit, #help-btn, #tf-asof and #tf-reset carry `title`; #dt-close,
  // #dt-back, #z-in and #z-out carry only the aria-label, so their meaning is
  // available to a screen reader and to nobody else. §14 asks for the
  // accessible name, which they have, so this is an inconsistency rather than a
  // broken claim — pinned here so the next person notices the pattern.
  test('§14 SPEC-DEVIATION only some icon buttons repeat their name as a hover title', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => {
      const has = (id) => document.getElementById(id).hasAttribute('title');
      return {
        titled: ['sb-hide', 'z-fit', 'help-btn', 'tf-asof', 'tf-reset', 'fd-close'].filter(has),
        untitled: ['dt-close', 'dt-back', 'z-in', 'z-out'].filter((id) => !has(id)),
      };
    })).toEqual({
      titled: ['sb-hide', 'z-fit', 'help-btn', 'tf-asof', 'tf-reset', 'fd-close'],
      untitled: ['dt-close', 'dt-back', 'z-in', 'z-out'],
    });
  });

  test('§14 the names of the visible icon controls reach the accessibility tree', async ({ page }) => {
    await openMap(page);
    for (const sel of ['#sb-hide', '#fd-close', '#help-btn', '#z-in', '#z-out', '#z-fit', '#tf-asof']) {
      await expect(page.locator(sel)).toBeVisible();
      await expect(page.locator(sel)).not.toHaveAccessibleName('');
    }
  });

  test('§14 the card buttons are named once the card is on screen', async ({ page }) => {
    await openMap(page);
    // The floating card only shows when the feed is closed (§5), so close it
    // first — a name on a display:none button reaches nobody.
    await page.click('#fd-close');
    await openViaSearch(page, 'CityLearn');
    await expect(page.locator('#detail')).toBeVisible();
    await expect(page.locator('#dt-close')).toHaveAccessibleName('Fermer');
    await expect(page.locator('#dt-back')).toHaveAccessibleName('Retour');
  });

  test('§14 #tf-asof carries the freshness sentence as title, label and toast', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    const asOf = await page.evaluate(() => t('asOf')(fmtAsOf()));
    expect(asOf).toMatch(/^Data current as of \d+ \w+ \d{4} — the period slider stops at that year\.$/);
    expect(await attrs(page, '#tf-asof', ['title', 'aria-label'])).toEqual({ title: asOf, 'aria-label': asOf });
    // A title covers hover; the click repeats it through the status region so a
    // touch reader, who never hovers, gets the same sentence.
    await page.click('#tf-asof');
    await expect(page.locator('#toast')).toHaveRole('status');
    await expect(page.locator('#toast')).toHaveText(asOf);
  });

  // §10 asks for the sentence to also arrive as a toast, and §14 makes #toast a
  // live region — neither is worth much if the message never leaves. #toast is
  // `position:fixed; bottom:26px; z-index:120`, across the middle of the stage,
  // so a lost timer parks it over the map for the rest of the session. The
  // 4 200 ms is the page's own figure (the spec asks only for a transient
  // message); what this test defends is the two structural properties around
  // it: the timer fires, and a second message starts a fresh one instead of
  // inheriting what is left of the first.
  test('§10/§14 a toast clears itself, and a second one gets its own full life', async ({ page }) => {
    await page.clock.install();
    await openMap(page, { lang: 'en' });
    // install() leaves the fake clock ticking with real time, so on a loaded
    // worker the 4 200 ms timer can expire in the wall-clock gap between the
    // click and the runFor that is supposed to be measuring it. Pausing it
    // makes every advance below exactly the one the test asks for — and only
    // that: the two properties under test are still the timer firing and the
    // second message starting a fresh one.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    const toast = page.locator('#toast');
    const asOf = await page.evaluate(() => t('asOf')(fmtAsOf()));

    await page.click('#tf-asof');
    await expect(toast).toHaveClass(/show/);
    await page.clock.runFor(4100);
    await expect(toast).toHaveClass(/show/);
    await page.clock.runFor(200);
    await expect(toast).not.toHaveClass(/show/);

    // Two messages in a row, the second arriving 4 000 ms into the first one's
    // life: without the clearTimeout it would inherit the 200 ms the first had
    // left and the explanation would flash past.
    await page.click('#mymap-pill');                   // "no pins yet" (§11)
    await expect(toast).toHaveClass(/show/);
    await page.clock.runFor(4000);
    await page.click('#tf-asof');
    await page.clock.runFor(1000);
    await expect(toast).toHaveClass(/show/);
    await expect(toast).toHaveText(asOf);
  });

  test('§14 #tf-reset is named by what it does, in both languages', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await nudgePeriod(page, 'a', 'PageUp', 1);
    expect(await attrs(page, '#tf-reset', ['title', 'aria-label']))
      .toEqual({ title: 'All years', 'aria-label': 'All years' });
    await page.click('.lang-switch [data-lang="fr"]');
    expect(await attrs(page, '#tf-reset', ['title', 'aria-label']))
      .toEqual({ title: 'Toutes les années', 'aria-label': 'Toutes les années' });
  });

  test('§14 #fd-offmap names the gap it stands for, with the same count it shows', async ({ page }) => {
    await openMap(page);
    const s = await snapshot(page);
    // Standards and one benchmark have no coordinates: the hint is the only
    // place the reader learns the tiles are not the whole answer. Nothing is
    // filtered out at boot, so every entity the payload cannot place is an
    // off-map match — and that population is derived rather than counted off,
    // then cross-checked against the `geo:false` flag of §3.1.4, so the figure
    // in the sentence cannot be right about the wrong set of entities.
    const { missingCoords, flagged } = await payloadOffMap(page);
    expect(missingCoords).toEqual(flagged);
    const n = missingCoords.length;
    expect(s.offMapMatch).toBe(n);
    const sentence = `${n} more match the filters but have no coordinates, so no marker`
      + ' — see “Off the map” in the left panel.';
    await expect(page.locator('#fd-offmap')).toBeVisible();
    await expect(page.locator('#fd-offmap')).toHaveText(`+ ${n} off the map`);
    expect(await attrs(page, '#fd-offmap', ['title', 'aria-label']))
      .toEqual({ title: sentence, 'aria-label': sentence });
  });

  test('§14 #fd-offscreen appears with a name once panning hides markers, and is keyboard-operable', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('#fd-offscreen')).toBeHidden();
    await zoomBy(page, 8);
    const s = await snapshot(page);
    expect(s.offScreen).toBeGreaterThan(0);
    const sentence = `${s.offScreen} more match the filters but sit outside the current view`
      + ' — zoom out to bring them in.';
    await expect(page.locator('#fd-offscreen')).toBeVisible();
    await expect(page.locator('#fd-offscreen')).toHaveText(`+ ${s.offScreen} off screen`);
    expect(await attrs(page, '#fd-offscreen', ['title', 'aria-label']))
      .toEqual({ title: sentence, 'aria-label': sentence });
    // It is a real button, so Enter has to do what the click does: fit the view.
    await page.locator('#fd-offscreen').focus();
    await page.keyboard.press('Enter');
    await settleCounts(page);
    await expect.poll(async () => (await snapshot(page)).offScreen).toBe(0);
    await expect(page.locator('#fd-offscreen')).toBeHidden();
  });

  test('§14 the sidebar collapse and its reopen twin are both named', async ({ page }) => {
    await openMap(page);
    // The feed has to go first: at 1280px with the feed open the top-right
    // control cluster reaches across the stage and covers this button, so a
    // click on it never lands (see the stacked-controls test below).
    await page.click('#fd-close');
    await expect(page.locator('#sb-hide')).toHaveAccessibleName('Masquer le panneau');
    await page.click('#sb-hide');
    await expect(page.locator('#sidebar')).toBeHidden();
    // The FAB that brings the panel back is the only way in once it is gone.
    await expect(page.locator('#sb-open')).toBeVisible();
    await expect(page.locator('#sb-open')).toHaveAccessibleName('Filtres');
    await page.locator('#sb-open').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sidebar')).toBeVisible();
  });

  // SPEC-DEVIATION: invariant 8 says every user-visible string goes through
  // t(), and §14 makes the accessible name the only name a screen-reader user
  // gets. These names are hard-coded French in the markup and never
  // re-translated — #fd-close is the one that is (applyLang updates it), which
  // is what makes the rest look like an oversight rather than a decision.
  test('§14 SPEC-DEVIATION hard-coded aria-labels stay French in the English interface', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    expect(await page.evaluate(() => ({
      map: document.getElementById('map').getAttribute('aria-label'),
      search: document.getElementById('search').getAttribute('aria-label'),
      close: document.getElementById('dt-close').getAttribute('aria-label'),
      back: document.getElementById('dt-back').getAttribute('aria-label'),
      hide: document.getElementById('sb-hide').getAttribute('aria-label'),
      help: document.getElementById('help-btn').getAttribute('aria-label'),
      zin: document.getElementById('z-in').getAttribute('aria-label'),
      fit: document.getElementById('z-fit').getAttribute('aria-label'),
      detail: document.getElementById('detail').getAttribute('aria-label'),
      feed: document.getElementById('feed').getAttribute('aria-label'),
    }))).toEqual({
      map: 'Carte interactive', search: 'Recherche', close: 'Fermer', back: 'Retour',
      hide: 'Masquer le panneau', help: 'Aide', zin: 'Zoom avant', fit: "Vue d'ensemble",
      detail: 'Détail', feed: 'Fiches dans la vue',
    });
    // The counter-example: this one does follow the language.
    await expect(page.locator('#fd-close')).toHaveAccessibleName('Hide feed');
  });

  // SPEC-DEVIATION: "Visible focus ring on all interactive elements" presumes
  // every interactive element can be focused. The unpin × is a <span
  // role="button"> with no tabindex, nested inside the <button> that opens the
  // card — so a keyboard reader can open a pinned entity but can never remove
  // it from My map.
  test('§14 SPEC-DEVIATION the unpin control is a role=button no keyboard can reach', async ({ page }) => {
    // Any pinned entity renders the same ×, so the pin is taken from the
    // payload rather than named (see the My map test above for why).
    const id = await someEntityId(page);
    await openMap(page, { storage: { 'hai-map-v2-pins': JSON.stringify([id]) } });
    await expect(page.locator('.pin-x')).toHaveCount(1);
    expect(await attrs(page, '.pin-x', ['role', 'aria-label', 'tabindex']))
      .toEqual({ role: 'button', 'aria-label': 'Retirer', tabindex: null });
    expect(await canFocus(page, '.pin-x')).toBe(false);
    expect(await page.evaluate(() => document.querySelector('.pin-x').parentElement.tagName)).toBe('BUTTON');
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 focus visibility and order', () => {
  test('§14 :focus-visible paints a 2px accent outline', async ({ page }) => {
    await openMap(page);
    const seen = await page.evaluate(() => {
      const el = document.querySelector('.layer-row[data-layer="project"]');
      el.focus();
      const cs = getComputedStyle(el);
      return { fv: el.matches(':focus-visible'), w: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor };
    });
    expect(seen).toEqual({ fv: true, w: '2px', style: 'solid', color: 'rgb(164, 85, 43)' });
  });

  test('§14 the search box trades the outline for an accent border, not for nothing', async ({ page }) => {
    await openMap(page);
    // .search-input:focus sets outline:none deliberately; the ring becomes the
    // border, so the field still shows where the caret is.
    const seen = await page.evaluate(() => {
      const el = document.getElementById('search');
      const before = getComputedStyle(el).borderTopColor;
      el.focus();
      const cs = getComputedStyle(el);
      return { before, after: cs.borderTopColor, outline: cs.outlineStyle, bg: cs.backgroundColor };
    });
    expect(seen.outline).toBe('none');
    expect(seen.after).toBe('rgb(164, 85, 43)');
    expect(seen.after).not.toBe(seen.before);
  });

  test('§14 the first tab stop is the search box', async ({ page }) => {
    await openMap(page);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('search');
  });

  test('§14 tabbing walks the sidebar in document order and only then leaves it', async ({ page }) => {
    await openMap(page);
    // Nothing in the sidebar sets tabindex, so document order is the contract:
    // search → presets → layers → domains → links → off the map → My map →
    // help. A stray positive tabindex anywhere would reorder this silently.
    const order = await page.evaluate(() => {
      const sel = '#sidebar input, #sidebar button, #sidebar [tabindex]:not([tabindex="-1"]), #sidebar a[href]';
      window.__stops = [...document.querySelectorAll(sel)];
      return window.__stops.length;
    });
    expect(order).toBeGreaterThan(20);
    const visited = [];
    for (let i = 0; i < order; i++) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => window.__stops.indexOf(document.activeElement)));
    }
    expect(visited).toEqual([...Array(order).keys()]);
    // One more tab and focus has left the panel for the map's own controls.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#sidebar'))).toBe(false);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('sb-hide');
  });

  test('§14 the collapsed sidebar takes its whole tab order with it', async ({ page }) => {
    await openMap(page);
    await page.click('#fd-close');
    await page.click('#sb-hide');
    await expect(page.locator('#sidebar')).toBeHidden();
    // display:none, so none of the 50-odd stops are reachable any more — a
    // collapsed panel a reader could still tab into is a focus trap in reverse.
    expect(await canFocus(page, '#search')).toBe(false);
    expect(await canFocus(page, '.layer-row[data-layer="team"]')).toBe(false);
    // Not one of the panel's fifty-odd stops is laid out any more.
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('#sidebar button, #sidebar input, #sidebar a[href]')]
        .filter((el) => el.offsetParent !== null).length)).toBe(0);
    // Focus is on the collapse button that was just clicked; stepping back
    // reaches the FAB, which is the stop the collapsed state adds.
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('sb-open');
  });

  // SPEC-DEVIATION: collapsing the panel reveals #sb-open but never hides
  // #sb-hide — both sit at top:14px left:14px — so the corner holds two focus
  // stops, and the one a click lands on is the collapse button that has nothing
  // left to collapse. §14 asks for a sensible focus order; §5's own rule that a
  // floating cluster stays inside the stage is what the second half of this test
  // measures, since with the feed open the top-right cluster covers the corner
  // entirely and the collapse button cannot be clicked at all.
  test('§14 SPEC-DEVIATION the collapsed panel leaves two controls stacked in one corner', async ({ page }) => {
    await openMap(page);
    // With the feed open the wrapped cluster's box spans the collapse button,
    // and lets the pointer through to it: the box takes no clicks of its own.
    expect(await page.evaluate(() => {
      const r = document.getElementById('sb-hide').getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top.closest('#ctl-cluster') ? 'ctl-cluster' : top.id;
    })).toBe('sb-hide');
    await page.click('#fd-close');
    await page.click('#sb-hide');
    const stacked = await page.evaluate(() => {
      const o = document.getElementById('sb-open').getBoundingClientRect();
      const h = document.getElementById('sb-hide').getBoundingClientRect();
      const top = document.elementFromPoint(h.x + h.width / 2, h.y + h.height / 2);
      return { sameOrigin: o.x === h.x && o.y === h.y, openVisible: o.width > 0, topAt: top.id };
    });
    expect(stacked).toEqual({ sameOrigin: true, openVisible: true, topAt: 'sb-hide' });
    expect(await canFocus(page, '#sb-hide')).toBe(true);
    expect(await canFocus(page, '#sb-open')).toBe(true);
  });

  // "Visible focus ring on all interactive elements" is a claim about every
  // control, and the rest of this file samples three: a layer row, the search
  // box and a period knob. One representative of each styled family in the page
  // is listed here instead, because a rule that suppresses the ring on a single
  // family — the round glyph buttons, whose outline sits awkwardly inside their
  // border-radius, are the tempting ones — leaves every other family painting
  // it correctly, and nothing else here would notice.
  const RING_FAMILIES = {
    'layer rows': '.layer-row[data-layer="project"]',
    'the links row': '#links-row',
    'preset chips': '#presets .chip',
    'group buttons': '.mini-btn[data-ga="none"]',
    'domain checkboxes': 'input[data-dom]',
    'floating pills': '#feed-pill',
    'glyph squares': '#z-in',
    'panel buttons': '#mymap-btn',
    'panel close buttons': '#fd-close',
    'period knobs': '#tf-a',
    'the freshness button': '#tf-asof',
    'feed hints': '#fd-offmap',
    'feed rows': '.fd-row',
    'off-map rows': '#nogeo-list .pin-item',
    'the language switch': '.lang-switch [data-lang="fr"]',
    'the legend disclosure': '#legend summary',
    'footer links': '#sb-foot a[href]',
  };

  test('§14 every family of interactive control paints the same focus ring', async ({ page }) => {
    await openMap(page);
    const rings = {};
    for (const [family, sel] of Object.entries(RING_FAMILIES)) {
      rings[family] = await page.evaluate(async (s) => {
        const el = document.querySelector(s);
        if (!el) return 'missing';
        el.focus();
        if (document.activeElement !== el) return 'unfocusable';
        // .chip, .pill and .btn carry `transition:all .12s`, so the first frame
        // after focus is mid-fade and reads 3px of the inherited colour. The
        // ring the reader actually sees is the one the transition ends on.
        getComputedStyle(el).outlineWidth;          // force the style recalc that starts it
        await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
        const cs = getComputedStyle(el);
        return [cs.outlineWidth, cs.outlineStyle, cs.outlineColor, cs.outlineOffset].join(' ');
      }, sel);
    }
    // #search is the one documented exception (outline traded for a border, two
    // tests up); everything else takes the single :focus-visible rule.
    const ring = '2px solid rgb(164, 85, 43) 2px';
    expect(rings).toEqual(Object.fromEntries(Object.keys(RING_FAMILIES).map((k) => [k, ring])));
  });

  test('§14 every focus stop in the sidebar is reachable and named', async ({ page }) => {
    await openMap(page);
    // A focus stop with no accessible name is a stop that announces nothing;
    // one that cannot take focus is a control the keyboard cannot use at all.
    const broken = await page.evaluate(() => {
      const els = [...document.querySelectorAll('#sidebar button, #sidebar a[href], #sidebar input')];
      const unnamed = els.filter((el) =>
        !(el.getAttribute('aria-label') || el.textContent.trim() || el.type === 'checkbox' || el.type === 'text'));
      const unfocusable = els.filter((el) => { el.focus(); return document.activeElement !== el; });
      return {
        n: els.length,
        unnamed: unnamed.map((el) => el.outerHTML.slice(0, 60)),
        unfocusable: unfocusable.map((el) => el.outerHTML.slice(0, 60)),
      };
    });
    expect(broken.n).toBeGreaterThan(20);
    expect(broken.unnamed).toEqual([]);
    expect(broken.unfocusable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 Escape priority: tour > welcome > detail > drawer', () => {
  // The four things Escape can close, read straight off the page.
  const stack = (page) => page.evaluate(() => ({
    tour: tourStep >= 0,
    welcome: welcome.classList.contains('open'),
    detail: detail.classList.contains('open'),
    drawer: document.body.classList.contains('panel-open'),
  }));

  test('§14 Escape unstacks the whole chain, one layer per press', async ({ page }) => {
    await openMap(page);
    // All four at once is not a state a reader reaches by accident, but it is
    // the only way to prove the order rather than one branch of it.
    await page.evaluate(() => {
      setPanel(true);
      openEntity(items.find((it) => it.geo).id, { fly: false });
      openWelcome();
      startTour();
    });
    expect(await stack(page)).toEqual({ tour: true, welcome: true, detail: true, drawer: true });
    await page.keyboard.press('Escape');
    expect(await stack(page)).toEqual({ tour: false, welcome: true, detail: true, drawer: true });
    await page.keyboard.press('Escape');
    expect(await stack(page)).toEqual({ tour: false, welcome: false, detail: true, drawer: true });
    await page.keyboard.press('Escape');
    expect(await stack(page)).toEqual({ tour: false, welcome: false, detail: false, drawer: true });
    await page.keyboard.press('Escape');
    expect(await stack(page)).toEqual({ tour: false, welcome: false, detail: false, drawer: false });
  });

  test('§14 Escape ends the tour and hides both of its parts', async ({ page }) => {
    await openMap(page);
    await page.click('#tour-btn');
    await expect(page.locator('#tour-card')).toBeVisible();
    await expect(page.locator('#tour-spot')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#tour-card')).toBeHidden();
    await expect(page.locator('#tour-spot')).toBeHidden();
    expect(await page.evaluate(() => tourStep)).toBe(-1);
  });

  test('§14 Escape closes the welcome dialog and leaves the map alone', async ({ page }) => {
    await openMap(page);
    await page.click('#help-btn');
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#welcome')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#welcome')).toHaveRole('dialog');
    await page.keyboard.press('Escape');
    await expect(page.locator('#welcome')).toBeHidden();
    expect(await stack(page)).toEqual({ tour: false, welcome: false, detail: false, drawer: false });
  });

  test('§14 Escape closes the card when nothing is stacked above it', async ({ page }) => {
    await openMap(page);
    await openViaSearch(page, 'CityLearn');
    expect((await snapshot(page)).focusId).toBe('citylearn');
    await page.keyboard.press('Escape');
    expect((await snapshot(page)).focusId).toBe(null);
    await expect(page.locator('#detail')).toBeHidden();
  });

  test('§14 the closed welcome is hidden from the accessibility tree, not just from view', async ({ page }) => {
    await openMap(page);
    // display:none rather than opacity, so an aria-modal dialog nobody opened
    // cannot capture a reader who tabs into it.
    await expect(page.locator('#welcome')).toBeHidden();
    expect(await canFocus(page, '#w-explore')).toBe(false);
    await page.click('#help-btn');
    expect(await canFocus(page, '#w-explore')).toBe(true);
  });

  // SPEC-DEVIATION: the welcome panel declares aria-modal="true", which tells a
  // screen reader to ignore everything outside it — but opening it never moves
  // focus into the dialog and nothing keeps focus inside, so the reader is left
  // standing on a control that has just been hidden from them, and Tab walks
  // straight back out into the map behind the scrim. Escape is the only part of
  // the modal contract the page implements.
  test('§14 SPEC-DEVIATION the modal dialog neither takes focus nor keeps it', async ({ page }) => {
    await openMap(page);
    await page.click('#help-btn');
    await expect(page.locator('#welcome')).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement.closest('#welcome'))).toBe(false);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('help-btn');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#welcome'))).toBe(false);
  });

  // SPEC-DEVIATION: the search box's own Escape handler clears the dropdown but
  // does not stop the event, so the document handler runs too and one press
  // closes both the dropdown and whatever was next in the chain. The documented
  // priority ("tour > welcome > detail > drawer") implies one layer per press.
  test('§14 SPEC-DEVIATION Escape in the search box also closes the card behind it', async ({ page }) => {
    await openMap(page);
    await openViaSearch(page, 'CityLearn');
    await page.fill('#search', 'CityLearn');
    await expect(page.locator('#search-drop')).toBeVisible();
    await page.locator('#search').press('Escape');
    await expect(page.locator('#search-drop')).toBeHidden();
    expect((await snapshot(page)).focusId).toBe(null);      // the card went too
  });
});

// ---------------------------------------------------------------------------
// The tour is the one overlay that can trap a reader: #tour-spot paints
// `box-shadow: 0 0 0 9999px var(--scrim)` over the whole window, nothing under
// it takes a click, and the documented ways out are the last step's own button
// and the Escape branch above. §12 owns the strings and covers the first two
// steps; what is asserted here is the part a reader can get stuck in — that
// stepping forward reaches an end that says so, and that the card holding the
// only live controls is on screen at every step and at both widths.
test.describe('§7/§12 the guided tour, from the first step to the way out', () => {
  // #tour-spot carries `transition:all .3s` and the buttons `transition:all
  // .12s`, so for a third of a second after each step the rect and the computed
  // visibility are both mid-flight. Everything below measures the resting state,
  // which is the one a reader sees.
  const settleTour = (page) => page.evaluate(() => new Promise((done) => {
    const el = document.getElementById('tour-spot');
    let last = null, still = 0, frames = 0;
    const tick = () => {
      const b = el.getBoundingClientRect();
      const key = [b.x, b.y, b.width, b.height].join();
      still = key === last ? still + 1 : 0;
      last = key;
      if (still >= 3 || ++frames > 90) return done(true);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  /** The two parts of the tour, the stage they are measured against, and the
   *  window they have to fit inside. */
  const tourBoxes = (page) => page.evaluate(() => {
    const r = (id) => {
      const b = document.getElementById(id).getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
    };
    return { card: r('tour-card'), spot: r('tour-spot'), stage: r('stage'), vw: window.innerWidth, vh: window.innerHeight };
  });

  const box = (page, id) => page.evaluate((i) => {
    const b = document.getElementById(i).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
  }, id);

  /** Does the spotlight cover its target completely? That is the whole job of
   *  the box arithmetic: a highlight that misses what it points at is worse
   *  than none, because the scrim hides everything else. */
  const encloses = (spot, target) => spot.x <= target.x && spot.y <= target.y
    && spot.right >= target.right && spot.bottom >= target.bottom;

  test('§7/§12 the tour walks all four steps and the fourth one finishes it', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#tour-btn');
    // The titles in order, not only the step numbers: a step that pointed at
    // the wrong target would still count 1…4 correctly.
    const titles = ['Filters & layers', 'The map', 'Hop by hop', 'Your cartography'];
    for (let n = 1; n <= 4; n++) {
      await settleTour(page);
      await expect(page.locator('#tour-n')).toHaveText(`Step ${n} / 4`);
      await expect(page.locator('#tour-title')).toHaveText(titles[n - 1]);
      await expect(page.locator('#tour-body')).not.toBeEmpty();
      await expect(page.locator('#tour-next')).toHaveText(n === 4 ? 'Done' : 'Next');
      if (n < 4) await page.click('#tour-next');
    }
    // Back, then forward again: both labels follow the step rather than latch.
    await page.click('#tour-prev');
    await expect(page.locator('#tour-n')).toHaveText('Step 3 / 4');
    await expect(page.locator('#tour-next')).toHaveText('Next');
    await page.click('#tour-next');
    await expect(page.locator('#tour-n')).toHaveText('Step 4 / 4');
    await expect(page.locator('#tour-next')).toHaveText('Done');
    // Stepping off the end is what ends it: there is no fifth step, and the
    // scrim has to leave with the card.
    await page.click('#tour-next');
    expect(await page.evaluate(() => tourStep)).toBe(-1);
    await expect(page.locator('#tour-card')).toBeHidden();
    await expect(page.locator('#tour-spot')).toBeHidden();
  });

  test('§7/§14 on the first step there is nothing to go back to, and the row says so without moving', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#tour-btn');
    await settleTour(page);
    const first = await page.evaluate(() => ({
      visibility: getComputedStyle(document.getElementById('tour-prev')).visibility,
      width: document.getElementById('tour-prev').offsetWidth,
      nextAt: document.getElementById('tour-next').offsetLeft,
    }));
    // visibility, not display: the button keeps its space, so the one button a
    // reader can press does not jump sideways between step 1 and step 2 — and a
    // hidden button is out of the tab order, so Tab cannot reach the control
    // that would take the tour to step zero and silently end it.
    expect(first.visibility).toBe('hidden');
    expect(first.width).toBeGreaterThan(0);
    expect(await canFocus(page, '#tour-prev')).toBe(false);

    await page.click('#tour-next');
    await settleTour(page);
    const second = await page.evaluate(() => ({
      visibility: getComputedStyle(document.getElementById('tour-prev')).visibility,
      nextAt: document.getElementById('tour-next').offsetLeft,
    }));
    expect(second.visibility).toBe('visible');
    expect(second.nextAt).toBe(first.nextAt);
    expect(await canFocus(page, '#tour-prev')).toBe(true);
  });

  // Step 1 spotlights the filters. Below 840px the panel is off-canvas
  // (`transform:translateX(-105%)`), so its own rect is behind the left edge of
  // the window and a spotlight measured from it would highlight nothing while
  // the scrim covered the map. tourTargets() has a branch for exactly that.
  test('§7/§12 at phone width step one spotlights the opener, not the off-canvas panel', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 820 });
    await openMap(page, { lang: 'en' });
    // dispatchEvent, not click: at this width #ctl-cluster is edge-to-edge and
    // covers the Filters pill at (14,14), which is layout.spec.js's own
    // deviation to report. What this test needs is the drawer open.
    await page.locator('#sb-open').dispatchEvent('click');
    await page.click('#tour-btn');                // which closes it again, then starts the tour
    await settleTour(page);
    const { spot, vw } = await tourBoxes(page);
    const fab = await box(page, 'sb-open');
    // The drawer takes .25s to slide back out of the window; what matters is
    // where it ends up, which is where its own rect is useless to the tour.
    await expect.poll(async () => (await box(page, 'sidebar')).right).toBeLessThanOrEqual(0);
    expect({ onScreen: spot.x >= 0 && spot.right <= vw, onTheOpener: encloses(spot, fab) })
      .toEqual({ onScreen: true, onTheOpener: true });
  });

  test('§7/§12 the collapsed panel hands step one to the opener too', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#fd-close');                // the feed covers the collapse button (§5)
    await page.click('#sb-hide');
    // body.sb-hidden: #sidebar is display:none, so its rect is all zeros and the
    // spotlight would be the 12px square the padding alone makes of it.
    expect((await box(page, 'sidebar')).w).toBe(0);
    // With the panel gone, the help overlay is the only remaining way in.
    await page.click('#help-btn');
    await page.click('#w-tour');
    await settleTour(page);
    const { spot } = await tourBoxes(page);
    const fab = await box(page, 'sb-open');
    expect({ drawn: spot.w > 20 && spot.h > 20, onTheOpener: encloses(spot, fab) })
      .toEqual({ drawn: true, onTheOpener: true });
  });

  // The four clamps that place #tour-card are plain arithmetic over the
  // spotlight box, and the failure they guard against is the worst one on the
  // page: the card leaves the window, the scrim stays, and the reader is behind
  // a modal whose controls they cannot see — Escape, which no label mentions,
  // being the only exit left. The narrow stage is where the `inset:60` on the
  // two map steps has the least room to work with.
  for (const [where, size] of [
    ['a desktop stage', { width: 1280, height: 800 }],
    ['a phone', { width: 420, height: 820 }],
  ]) {
    test(`§7/§12 on ${where} every step keeps its card inside the window and its spotlight drawn`, async ({ page }) => {
      await page.setViewportSize(size);
      await openMap(page, { lang: 'en' });
      if (size.width <= 840) await page.locator('#sb-open').dispatchEvent('click');
      await page.click('#tour-btn');
      for (let n = 1; n <= 4; n++) {
        await settleTour(page);
        await expect(page.locator('#tour-n')).toHaveText(`Step ${n} / 4`);
        const { card, spot, vw, vh } = await tourBoxes(page);
        expect({
          step: n,
          cardDrawn: card.w > 0 && card.h > 0,
          cardLeft: card.x >= 0,
          cardTop: card.y >= 0,
          cardRight: card.right <= vw,
          cardBottom: card.bottom <= vh,
          spotDrawn: spot.w > 0 && spot.h > 0,
        }).toEqual({
          step: n, cardDrawn: true, cardLeft: true, cardTop: true,
          cardRight: true, cardBottom: true, spotDrawn: true,
        });
        if (n < 4) await page.click('#tour-next');
      }
    });
  }

  test('§7/§12 a resize re-measures the open step instead of leaving the scrim where it was', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#tour-btn');
    await page.click('#tour-next');               // step 2 frames the stage, which a resize moves
    await settleTour(page);
    const before = await tourBoxes(page);
    // The spotlight insets the stage by the same amount on all four sides, so
    // the two boxes share a centre, and whatever the stage's width does the
    // spotlight's width has to do as well. Both hold only if the step was
    // measured against the layout that is on screen now.
    const centreGap = (b) => ({
      x: Math.round((b.spot.x + b.spot.w / 2) - (b.stage.x + b.stage.w / 2)),
      y: Math.round((b.spot.y + b.spot.h / 2) - (b.stage.y + b.stage.h / 2)),
    });
    expect(centreGap(before)).toEqual({ x: 0, y: 0 });

    await page.setViewportSize({ width: 900, height: 700 });
    await settleTour(page);
    const after = await tourBoxes(page);
    expect(centreGap(after)).toEqual({ x: 0, y: 0 });
    expect(Math.round(after.spot.w - before.spot.w)).toBe(Math.round(after.stage.w - before.stage.w));
    expect(Math.round(after.spot.h - before.spot.h)).toBe(Math.round(after.stage.h - before.stage.h));
    // Re-measured, not advanced and not restarted.
    expect(await page.evaluate(() => tourStep)).toBe(1);
    await expect(page.locator('#tour-n')).toHaveText('Step 2 / 4');
    expect({ left: after.card.x >= 0, top: after.card.y >= 0, right: after.card.right <= after.vw, bottom: after.card.bottom <= after.vh })
      .toEqual({ left: true, top: true, right: true, bottom: true });

    // And a resize after the tour is over must not bring the scrim back: the
    // handler is guarded on tourStep, which is the only thing endTour() leaves
    // behind.
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1100, height: 760 });
    await expect(page.locator('#tour-card')).toBeHidden();
    await expect(page.locator('#tour-spot')).toBeHidden();
    expect(await page.evaluate(() => tourStep)).toBe(-1);
  });

  test('§7/§12 a tour opened on a desktop follows the reader down to a phone', async ({ page }) => {
    await openMap(page, { lang: 'en' });
    await page.click('#tour-btn');
    await settleTour(page);
    expect(encloses(await box(page, 'tour-spot'), await box(page, 'sidebar'))).toBe(true);
    // Same step, same tour — but the thing step 1 points at has just left the
    // window, so the re-measure has to pick the other target, not re-draw the
    // old box.
    await page.setViewportSize({ width: 420, height: 820 });
    await settleTour(page);
    await expect(page.locator('#tour-n')).toHaveText('Step 1 / 4');
    const spot = await box(page, 'tour-spot');
    expect((await box(page, 'sidebar')).right).toBeLessThanOrEqual(0);
    expect({ onTheOpener: encloses(spot, await box(page, 'sb-open')), onScreen: spot.x >= 0 && spot.right <= 420 })
      .toEqual({ onTheOpener: true, onScreen: true });
  });

  test('§7/§12 the welcome overlay hands the reader to the same tour, with the overlay gone', async ({ page }) => {
    // #w-tour is the entry point a first-time reader meets, and it has to close
    // the welcome dialog as well as start the tour: two scrims would stack, and
    // Escape — the tour's own exit — would uncover a dialog rather than the map.
    await openMap(page);
    await page.evaluate(() => openWelcome());
    await page.click('#w-tour');
    await expect(page.locator('#welcome')).toBeHidden();
    await expect(page.locator('#tour-card')).toBeVisible();
    await expect(page.locator('#tour-n')).toHaveText('Step 1 / 4');
    await page.keyboard.press('Escape');
    await expect(page.locator('#tour-card')).toBeHidden();
    await expect(page.locator('#welcome')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 prefers-reduced-motion', () => {
  test('§14 reduced motion applies a view change immediately instead of tweening', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openMap(page);
    const seen = await page.evaluate(() => {
      const before = view.k;
      setView({ k: view.k * 2, x: view.x, y: view.y }, true);   // animated: true
      return { reduceMotion, before, immediately: view.k };
    });
    expect(seen.reduceMotion).toBe(true);
    expect(seen.immediately).toBeCloseTo(seen.before * 2, 6);
    await settleCounts(page);
  });

  test('§14 with motion allowed the same call tweens across frames', async ({ page }) => {
    await openMap(page);
    // The falsifiable half of the pair: if setView stopped animating for
    // everyone, the test above would still pass on its own.
    const seen = await page.evaluate(() => {
      const before = view.k;
      setView({ k: view.k * 2, x: view.x, y: view.y }, true);
      return { reduceMotion, before, immediately: view.k };
    });
    expect(seen.reduceMotion).toBe(false);
    expect(seen.immediately).toBe(seen.before);
    await expect.poll(() => page.evaluate(() => view.k)).toBeCloseTo(seen.before * 2, 3);
    await settleCounts(page);
  });

  test('§14 reduced motion asks the feed for an instant scroll', async ({ page }) => {
    // The spec names feed auto-scroll specifically, so the argument itself is
    // what has to change — the destination is the same either way.
    await recordScrolls(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openMap(page);
    await page.evaluate(() => openEntity(document.querySelector('.fd-row').dataset.open, { fly: false }));
    expect(await page.evaluate(() => window.__scrolls)).toEqual(['auto']);
  });

  test('§14 with motion allowed the feed scroll is smooth', async ({ page }) => {
    await recordScrolls(page);
    await openMap(page);
    await page.evaluate(() => openEntity(document.querySelector('.fd-row').dataset.open, { fly: false }));
    expect(await page.evaluate(() => window.__scrolls)).toEqual(['smooth']);
  });

  // The feed's "+ N off the map" button scrolls the sidebar down to the
  // Off-the-map list. That is the same ground moving under the reader as the
  // feed auto-scroll above, and the page's only other scrollIntoView, so it
  // has to take its instruction from the same media query. Asserted as a pair
  // for the same reason the feed pair is: a scroll hard-coded to 'auto' would
  // satisfy the reduced-motion half on its own.
  test('§14 reduced motion makes the Off-the-map jump instant too', async ({ page }) => {
    await recordScrolls(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openMap(page);
    await expect(page.locator('#fd-offmap')).toBeVisible();
    await page.click('#fd-offmap');
    expect(await page.evaluate(() => window.__scrolls)).toEqual(['auto']);
  });

  test('§14 with motion allowed the Off-the-map jump is smooth', async ({ page }) => {
    await recordScrolls(page);
    await openMap(page);
    await page.click('#fd-offmap');
    expect(await page.evaluate(() => window.__scrolls)).toEqual(['smooth']);
  });

  test('§14 reduced motion keeps the off-screen hint working, only without the flight', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openMap(page);
    await zoomBy(page, 8);
    expect((await snapshot(page)).offScreen).toBeGreaterThan(0);
    await page.click('#fd-offscreen');
    await settleCounts(page);
    expect((await snapshot(page)).offScreen).toBe(0);
  });

  test('§14 dark mode flips the tokens the whole interface is built on', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openMap(page);
    expect(await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())).toBe('#111318');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(17, 19, 24)');
    // The focus ring is a token too, so it has to move with them.
    expect(await page.evaluate(() => {
      const el = document.querySelector('.layer-row[data-layer="project"]');
      el.focus();
      return getComputedStyle(el).outlineColor;
    })).toBe('rgb(224, 146, 99)');
  });

  test('§14 light mode is the default, from the same custom properties', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openMap(page);
    expect(await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())).toBe('#faf8f4');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 248, 244)');
  });
});

// ---------------------------------------------------------------------------
test.describe('§14 keyboard reach without the map', () => {
  test('§14 the zoom buttons are operable from the keyboard, by the documented factor', async ({ page }) => {
    await openMap(page);
    const before = await page.evaluate(() => view.k);
    await page.locator('#z-in').focus();
    await page.keyboard.press('Enter');
    await settleCounts(page);
    const zoomed = await page.evaluate(() => view.k);
    expect(zoomed / before).toBeCloseTo(1.45, 5);
    await page.locator('#z-out').focus();
    await page.keyboard.press('Enter');
    await settleCounts(page);
    expect(await page.evaluate(() => view.k)).toBeCloseTo(before, 5);
    // ⌂ returns to the overview, which is how a keyboard reader recovers from
    // having zoomed into nothing.
    await page.locator('#z-fit').focus();
    await page.keyboard.press('Enter');
    await settleCounts(page);
    await expect.poll(async () => (await snapshot(page)).offScreen).toBe(0);
  });

  test('§14 Space works on the zoom buttons too', async ({ page }) => {
    await openMap(page);
    const before = await page.evaluate(() => view.k);
    await page.locator('#z-in').focus();
    await page.keyboard.press(' ');
    await settleCounts(page);
    expect(await page.evaluate(() => view.k)).toBeGreaterThan(before);
  });

  // SPEC-DEVIATION: §14 says the map "is pannable and zoomable from the keyboard
  // through the zoom buttons". The buttons zoom about the centre of the stage;
  // no key pans. #map also carries role="application" — which tells a screen
  // reader to hand keystrokes to the page — while being unfocusable and having
  // no key handlers of its own. Reaching a marker therefore means zooming out
  // and back in, or going through search and the feed.
  test('§14 SPEC-DEVIATION nothing pans the map from the keyboard', async ({ page }) => {
    await openMap(page);
    expect(await canFocus(page, '#map')).toBe(false);
    expect(await attrs(page, '#map', ['tabindex'])).toEqual({ tabindex: null });
    const before = await page.evaluate(() => ({ x: view.x, y: view.y }));
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
      await page.keyboard.press(key);
    }
    expect(await page.evaluate(() => ({ x: view.x, y: view.y }))).toEqual(before);
  });

  test('§14 the entities with no marker are all reachable as buttons', async ({ page }) => {
    await openMap(page);
    const { missingCoords: nogeo, flagged } = await payloadOffMap(page);
    // §3.1.4: the generator keeps the coordinate-less entities and flags them
    // `geo:false` rather than dropping them, so the two derivations have to
    // name the same entities in the same order. That agreement is what the old
    // pinned count was standing in for, and it is the stronger claim: a count
    // is satisfied just as well by the wrong set of the right size.
    expect(nogeo).toEqual(flagged);
    // Invariant 3: no marker, but a card, a search result and a feed row. The
    // "Off the map" list is the one that does not need the map at all.
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('#nogeo-list [data-open]')].map((b) => b.dataset.open))).toEqual(nogeo);
    // Each row has to say which entity it is, not merely say something: eleven
    // rows announcing a glyph apiece would satisfy a non-empty check and tell
    // a reader without the map nothing at all. The names come from the
    // payload, so the list cannot agree with itself while both are wrong.
    const names = await page.evaluate(() => {
      const D = window.HAI_DATA, by = {};
      for (const e of [...D.PROJECTS, ...D.COMMONS, ...D.TEAMS, ...D.FRAMEWORKS]) by[e.id] = e.name;
      return [...document.querySelectorAll('#nogeo-list [data-open]')].map((b) => by[b.dataset.open]);
    });
    expect(names.filter(Boolean).length).toBe(nogeo.length);
    const rows = await page.locator('#nogeo-list [data-open]').all();
    for (const [i, b] of rows.entries()) await expect(b).toHaveAccessibleName(names[i]);
  });

  test('§14 Enter on an off-map row opens its card and the feed shows it expanded', async ({ page }) => {
    await openMap(page);
    // Any entity the map cannot place will do, so the subject is picked out of
    // the payload (first off-map id alphabetically) instead of named: a
    // regeneration that retires it moves the test onto the next one rather
    // than leaving a selector that silently matches nothing.
    const id = (await payloadOffMap(page)).missingCoords.slice().sort()[0];
    const row = page.locator(`#nogeo-list [data-open="${id}"]`);
    await row.focus();
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).focusId).toBe(id);
    // It has no marker, so renderFeed puts it at the head of the list rather
    // than leaving the reader with a card they cannot see the context of.
    await expect(page.locator('.fd-row[aria-expanded="true"]')).toHaveCount(1);
    expect(await page.evaluate(() =>
      document.querySelector('.fd-row[aria-expanded="true"]').dataset.open)).toBe(id);
    expect(await page.evaluate((x) => state.inView.has(x), id)).toBe(false);
  });

  test('§14 search is fully operable from the keyboard: type, arrow, Enter', async ({ page }) => {
    await openMap(page);
    await page.locator('#search').focus();
    // Named rather than derived, and deliberately: the claim is that *this*
    // query reaches *that* entity, so the pair is the subject of the test and
    // not an incidental fixture. A regeneration that retired it would fail
    // here loudly — no hit, no card — rather than quietly passing.
    await page.keyboard.type('IEC 61508');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).focusId).toBe('iec-61508');
  });

  test('§14 the results can also be reached by tabbing into them', async ({ page }) => {
    await openMap(page);
    // Arrowing is one path; the results are real buttons in document order after
    // the field, so Tab is the other. Either has to end on the same card.
    await page.locator('#search').focus();
    await page.keyboard.type('CityLearn');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement.dataset.open)).toBe('citylearn');
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).focusId).toBe('citylearn');
  });

  // SPEC-DEVIATION: the dropdown is a role="listbox" whose children are
  // <button>s rather than role="option", and the arrow-key highlight is a `.sel`
  // class with no aria-activedescendant and no aria-expanded on the field. The
  // entities stay reachable (the two tests above), which is what §14 claims, but
  // the selection a screen-reader user is moving through is announced to nobody.
  test('§14 SPEC-DEVIATION the search dropdown claims listbox semantics it does not implement', async ({ page }) => {
    await openMap(page);
    await page.fill('#search', 'CityLearn');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    expect(await page.evaluate(() => ({
      dropRole: document.getElementById('search-drop').getAttribute('role'),
      optionRoles: [...document.querySelectorAll('.sd-item')].map((b) => b.getAttribute('role')),
      inputExpanded: document.getElementById('search').getAttribute('aria-expanded'),
      activeDescendant: document.getElementById('search').getAttribute('aria-activedescendant'),
    }))).toEqual({ dropRole: 'listbox', optionRoles: [null], inputExpanded: null, activeDescendant: null });
    // The highlight the arrow keys move is purely visual.
    await page.locator('#search').press('ArrowDown');
    await expect(page.locator('.sd-item.sel')).toHaveCount(1);
    expect(await attrs(page, '#search', ['aria-activedescendant'])).toEqual({ 'aria-activedescendant': null });
  });

  test('§14 one letter is not a search: the dropdown stays shut', async ({ page }) => {
    await openMap(page);
    await page.locator('#search').focus();
    await page.keyboard.type('i');
    await expect(page.locator('#search-drop')).toBeHidden();
    await page.keyboard.type('e');
    await expect(page.locator('#search-drop')).toBeVisible();
  });

  test('§14 a search with no hits says so instead of going silent', async ({ page }) => {
    await openMap(page);
    await page.fill('#search', 'zzzzqqq');
    await expect(page.locator('#search-drop')).toBeVisible();
    await expect(page.locator('.sd-empty')).toHaveText('No matches');
    // Nothing to arrow onto, and Enter must not open a card by accident.
    await page.locator('#search').press('ArrowDown');
    await page.locator('#search').press('Enter');
    expect((await snapshot(page)).focusId).toBe(null);
  });

  test('§14 the legend is a native disclosure, so its state is exposed for free', async ({ page }) => {
    await openMap(page);
    // <details>/<summary> carries its expanded state in the DOM rather than in
    // an aria-expanded attribute, which is why the legend needs no ARIA of its
    // own — but it does have to stay keyboard-operable.
    const open = () => page.evaluate(() => document.getElementById('legend').open);
    expect(await open()).toBe(false);
    await page.locator('#legend summary').focus();
    await page.keyboard.press('Enter');
    expect(await open()).toBe(true);
    await expect(page.locator('#legend-rows')).toBeVisible();
    await page.keyboard.press('Enter');
    expect(await open()).toBe(false);
  });

  test('§14 private browsing: the interface still boots, announces and unstacks', async ({ page }) => {
    // localStorage throws in a locked-down profile. lsGet/lsSet swallow it, so
    // the reader gets a first-visit page every time — including the welcome
    // dialog, which Escape still has to close.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    });
    await openMap(page);
    expect(errors).toEqual([]);
    await expect(page.locator('#welcome')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#welcome')).toBeHidden();
    await expect(page.locator('.stats')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#st-note')).not.toBeEmpty();
  });
});
