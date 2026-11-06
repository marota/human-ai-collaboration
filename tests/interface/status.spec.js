// The status facet — spec §10.4.
//
// A card's status is read at the year of the period's right handle: foreseen
// before its start, terminated after its end, ongoing in between. Three toggles,
// all on by default, decide which of them the map shows, and a foreseen card,
// which starts after the period and so overlaps none of it, stays on the map
// beyond the period, faded, while its toggle is on.
//
// What is pinned here is that contract against the page's own data: the status
// follows the handle, the default changes nothing at the full range, turning
// Foreseen off gives back the period axis of §10 exactly, the rows are facet
// counts like the tier rows (§6.1), and the choice travels in the shared link
// only (§13).
import { test, expect } from '@playwright/test';
import { MAP_PATH, openMap, snapshot, setLayers, setPeriod, applyPreset } from './_map.js';

const STATUSES = ['terminated', 'ongoing', 'foreseen'];

async function open(page, opts) {
  await openMap(page, opts);
}
async function reopen(page, opts) {
  await page.goto('about:blank');
  return open(page, opts);
}
const statusRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.layer-row[data-status]')].map((b) => ({
    status: b.dataset.status, on: b.getAttribute('aria-pressed') === 'true',
    label: b.querySelector('.lbl').textContent, n: +b.querySelector('.cnt').textContent, title: b.title,
  })));
const toggleStatus = (page, k) => page.click(`.layer-row[data-status="${k}"]`);
const heading = (page) => page.locator('#status-h').textContent();
/** A dated project with its own start and end, both inside the axis. */
const spanned = (page) => page.evaluate(() => {
  const it = items.find((i) => i.kind === 'project' && !i.vague && i.y0 != null && i.y1 != null
    && i.y0 > YMIN + 1 && i.y1 < YMAX - 1 && i.y1 > i.y0);
  return { id: it.id, y0: it.y0, y1: it.y1, YMIN, YMAX };
});
const matched = (page) => page.evaluate(() => [...visibleSet().matched].sort());
/** The period axis of §10 alone, computed from the page's own pieces. */
const periodRule = (page) => page.evaluate(() => items.filter((it) =>
  state.layers[it.kind] && state.tiers[it.tier] && it.domains.some((d) => state.domains.has(d))
  && periodState(it) !== 'out').map((it) => it.id).sort());

test.describe('§10.4 the status follows the right handle', () => {
  test('§10.4 a project is foreseen before its start, ongoing during it, terminated after its end', async ({ page }) => {
    await open(page);
    const p = await spanned(page);
    const at = async (b) => { await setPeriod(page, p.YMIN, b); return page.evaluate((id) => statusAt(byId[id]), p.id); };
    expect(await at(p.y0 - 1)).toBe('foreseen');
    expect(await at(p.y0)).toBe('ongoing');
    expect(await at(p.y1)).toBe('ongoing');
    expect(await at(p.y1 + 1)).toBe('terminated');
  });

  test('§10.4 a card whose only year is its host\'s founding is never foreseen', async ({ page }) => {
    await open(page);
    const vague = await page.evaluate(() => items.filter((i) => i.vague && i.y0 != null).map((i) => i.id));
    expect(vague.length).toBeGreaterThan(0);
    await setPeriod(page, 1945, 1945);
    expect(await page.evaluate((ids) => ids.filter((id) => statusAt(byId[id]) === 'foreseen'), vague)).toEqual([]);
  });

  test('§10.4 a card with no date at all keeps its own status from the snapshot\'s year on', async ({ page }) => {
    await open(page);
    const undated = await page.evaluate(() => items.filter((i) => !i.dated)
      .map((i) => ({ id: i.id, status: i.d.status, now: statusAt(i) })));
    expect(undated.length).toBeGreaterThan(0);
    for (const u of undated) {
      expect(u.now, u.id).toBe(u.status === 'concluded' ? 'terminated' : u.status === 'planned' ? 'foreseen' : 'ongoing');
    }
  });
});

test.describe('§10.4 the default changes nothing at the full range', () => {
  test('§10.4 three rows, all on, under a heading that names the last year', async ({ page }) => {
    await open(page);
    const rows = await statusRows(page);
    expect(rows.map((r) => r.status)).toEqual(STATUSES);
    expect(rows.map((r) => r.on)).toEqual([true, true, true]);
    expect(rows.map((r) => r.label)).toEqual(['Terminated', 'Ongoing', 'Foreseen']);
    const { YMAX } = await spanned(page);
    expect(await heading(page)).toBe(`Status in ${YMAX}`);
    expect(rows.map((r) => r.title)).toEqual([`Ended before ${YMAX}`, `Running in ${YMAX}`, `Starting after ${YMAX}`]);
  });

  test('§10.4 at the full range nothing is foreseen and the whole corpus matches', async ({ page }) => {
    await open(page);
    const rows = await statusRows(page);
    expect(rows.find((r) => r.status === 'foreseen').n).toBe(0);
    const total = await page.evaluate(() => items.length);
    expect(rows.reduce((s, r) => s + r.n, 0)).toBe(total);
    expect((await snapshot(page)).matchCount).toBe(total);
  });
});

test.describe('§10.4 moving the right handle', () => {
  test('§10.4 a project that starts after the period stays on the map, faded, and the feed gives its start', async ({ page }) => {
    await open(page);
    const p = await spanned(page);
    await setPeriod(page, p.YMIN, p.y0 - 1);
    const v = await page.evaluate(() => { const s = visibleSet(); return { vis: [...s.vis], dimmed: [...s.dimmed] }; });
    expect(v.vis).toContain(p.id);
    expect(v.dimmed).toContain(p.id);
    await page.evaluate(() => { if (!state.feed) toggleFeed(); });
    await expect(page.locator(`.fd-item[data-id="${p.id}"] .mt`)).toHaveText(`from ${p.y0}`);
  });

  test('§10.4 with Foreseen off the period axis of §10 is all there is', async ({ page }) => {
    await open(page);
    const p = await spanned(page);
    await setPeriod(page, p.YMIN, p.y0 - 1);
    await toggleStatus(page, 'foreseen');
    expect(await matched(page)).toEqual(await periodRule(page));
    expect(await matched(page)).not.toContain(p.id);
  });

  test('§10.4 with Terminated off, what ended before the handle goes and what still runs stays', async ({ page }) => {
    await open(page);
    const p = await spanned(page);
    await setPeriod(page, p.YMIN, p.y1 + 1);
    expect(await matched(page)).toContain(p.id);
    await toggleStatus(page, 'terminated');
    const m = await matched(page);
    expect(m).not.toContain(p.id);
    expect(await page.evaluate((ids) => ids.filter((id) => statusAt(byId[id]) === 'terminated'), m)).toEqual([]);
  });

  test('§10.4 the heading and the row hints follow the handle, in both languages', async ({ page }) => {
    await open(page);
    await setPeriod(page, 1990, 2018);
    expect(await heading(page)).toBe('Status in 2018');
    expect((await statusRows(page)).map((r) => r.title))
      .toEqual(['Ended before 2018', 'Running in 2018', 'Starting after 2018']);
    await page.click('.lang-switch button[data-lang="fr"]');
    expect(await heading(page)).toBe('Statut en 2018');
    expect((await statusRows(page)).map((r) => r.label)).toEqual(['Terminé', 'En cours', 'Prévu']);
    expect((await statusRows(page)).map((r) => r.title))
      .toEqual(['Achevé avant 2018', 'En cours en 2018', 'Commence après 2018']);
  });
});

test.describe('§10.4 / §6.1 the status rows are facet counts', () => {
  test('§10.4 each row counts its own status across every other axis', async ({ page }) => {
    await open(page);
    await setLayers(page, ['project']);
    await setPeriod(page, 2010, 2018);
    const want = await page.evaluate(() => {
      const n = { terminated: 0, ongoing: 0, foreseen: 0 };
      items.filter((it) => matchesFilters(it, 'status')).forEach((it) => { n[statusAt(it)]++; });
      return n;
    });
    expect(Object.fromEntries((await statusRows(page)).map((r) => [r.status, r.n]))).toEqual(want);
    expect(want.foreseen).toBeGreaterThan(0);
  });

  test('§10.4 a status toggle never moves its own figure, nor its siblings\'', async ({ page }) => {
    await open(page);
    await setPeriod(page, 2010, 2018);
    const before = (await statusRows(page)).map((r) => r.n);
    for (const k of STATUSES) {
      await toggleStatus(page, k);
      expect((await statusRows(page)).map((r) => r.n), k).toEqual(before);
      await toggleStatus(page, k);
    }
  });

  test('§10.4 the histogram is the period\'s backdrop and ignores the status', async ({ page }) => {
    await open(page);
    await setPeriod(page, 2010, 2018);
    const bars = () => page.evaluate(() => document.getElementById('tf-hist').innerHTML);
    const before = await bars();
    for (const k of STATUSES) await toggleStatus(page, k);
    expect(await bars()).toBe(before);
    expect((await snapshot(page)).matchCount).toBe(0);
  });
});

test.describe('§13 the statuses in the shared link', () => {
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

  test('§13 st= carries the statuses left on, and only when one is off', async ({ page }) => {
    await open(page);
    expect(fragmentOf(await copiedLink(page))).toBe('');
    await toggleStatus(page, 'foreseen');
    expect(fragmentOf(await copiedLink(page))).toBe('st=terminated,ongoing');
  });

  test('§13 a round trip through the link restores the statuses and what they select', async ({ page }) => {
    await open(page);
    await setPeriod(page, 2005, 2018);
    await toggleStatus(page, 'terminated');
    const read = () => page.evaluate(() => ({ statuses: { ...state.statuses }, matched: [...visibleSet().matched].sort() }));
    const before = await read();
    const u = new URL(await copiedLink(page));
    expect(u.hash).toBe('#st=ongoing,foreseen&yr=2005,2018');
    await reopen(page, { lang: u.searchParams.get('lang'), hash: u.hash });
    expect(await read()).toEqual(before);
    expect((await statusRows(page)).map((r) => r.on)).toEqual([false, true, true]);
  });

  test('§13 a stale or empty st= degrades to all three rather than an empty map', async ({ page }) => {
    const all = { terminated: true, ongoing: true, foreseen: true };
    for (const [hash, want] of [['#st=later', all], ['#st=', all],
      ['#st=ongoing,later', { terminated: false, ongoing: true, foreseen: false }]]) {
      await reopen(page, { hash });
      expect(await page.evaluate(() => ({ ...state.statuses })), hash).toEqual(want);
    }
  });

  test('§13 the statuses live in the link alone — nothing in localStorage', async ({ page }) => {
    await open(page);
    const keys = () => page.evaluate(() => Object.keys(localStorage).sort());
    const before = await keys();
    await toggleStatus(page, 'terminated');
    expect(await keys()).toEqual(before);
    await page.goto('about:blank');
    await page.goto(`${MAP_PATH}?lang=en`);
    await expect(page.locator('#st-note')).not.toBeEmpty();
    expect(await page.evaluate(() => ({ ...state.statuses }))).toEqual({ terminated: true, ongoing: true, foreseen: true });
  });

  test('§10.4 a starting view and Reset both put the three statuses back on', async ({ page }) => {
    await open(page);
    await toggleStatus(page, 'terminated');
    await toggleStatus(page, 'foreseen');
    await applyPreset(page, 'overview');
    expect((await statusRows(page)).map((r) => r.on)).toEqual([true, true, true]);
    await toggleStatus(page, 'ongoing');
    await page.click('#reset-btn');
    expect((await statusRows(page)).map((r) => r.on)).toEqual([true, true, true]);
  });
});
