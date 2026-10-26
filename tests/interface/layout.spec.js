// Layout and responsive bounds — §5 and invariant 11.
//
// Both failure modes this file guards against are invisible rather than ugly,
// which is why they are worth measuring rather than eyeballing:
//
//   · `#stage{overflow:hidden}` clips a floating cluster that outgrows it
//     instead of letting it spill somewhere a reader would notice, so an
//     unbounded cluster loses content silently (invariant 11).
//   · a collapsed column that keeps a `0`-width stub in the grid hands the map
//     the stub and the feed the map's track — the map disappears (§5).
//
// So almost everything here reads real rectangles out of the page and compares
// them with each other, or with the 312 px / 344 px / 840 px numbers §5 states.
import { test, expect } from '@playwright/test';
import {
  openMap, snapshot, tiles, expectCountersReconcile, settleCounts, setLayers,
  nudgePeriod, periodLabel,
} from './_map.js';

// ---------------------------------------------------------------- helpers ---

/** Open the map at a given window size.
 *  The viewport has to be set *before* the navigation: the feed's default
 *  column is decided once, at boot, from `window.innerWidth` against §5's
 *  840 px breakpoint — resizing afterwards would test a different page. */
async function openAt(page, { width, height = 820, lang = 'en', denyStorage = false } = {}) {
  await page.setViewportSize({ width, height });
  if (denyStorage) {
    // A private window, where touching localStorage throws. Registered before
    // openMap's own seeding script so that the seed is the first thing refused
    // and the page boots with no persisted reader state at all.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true, get() { throw new Error('denied'); },
      });
    });
  }
  await openMap(page, { lang });
  return page;
}

/** The stage, the three floating clusters and the period pill, as rectangles.
 *  Rounded to hundredths of a pixel so sub-pixel noise cannot decide an
 *  inequality; a cluster hidden by `display:none` comes back as null, which is
 *  a width bound of its own kind. */
function rects(page) {
  return page.evaluate(() => {
    const r2 = (n) => Math.round(n * 100) / 100;
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === 'none') return null;
      const b = el.getBoundingClientRect();
      return {
        left: r2(b.left), right: r2(b.right), top: r2(b.top), bottom: r2(b.bottom),
        width: r2(b.width), height: r2(b.height),
      };
    };
    const pill = document.querySelector('.tf');
    return {
      stage: box('#stage'), map: box('#map'),
      tr: box('.ctl-tr'), br: box('.ctl-br'), bl: box('.ctl-bl'),
      tf: box('.tf'), slider: box('#tf-slider'), group: box('.ctl-group'),
      pill: {
        scrollWidth: pill.scrollWidth, clientWidth: pill.clientWidth,
        overflow: getComputedStyle(pill).overflow, maxWidth: getComputedStyle(pill).maxWidth,
      },
      hScroll: {
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        bodyScroll: document.body.scrollWidth,
        inner: window.innerWidth,
      },
    };
  });
}

const CLUSTERS = { tr: '.ctl-tr', br: '.ctl-br', bl: '.ctl-bl' };

/** Invariant 11: every floating cluster's box lies wholly within #stage's
 *  visible rectangle. Also insists each visible cluster has a real size — a
 *  0×0 box would satisfy "inside" while showing the reader nothing.
 *
 *  A cluster that is not on the map at all satisfies "inside" even more
 *  cheaply, so the three the invariant names have to be *there*. Only one
 *  state is entitled to hide any of them — the open card takes the two
 *  right-hand corners (§5) — and that caller names them in `absent`, where
 *  they are then required to be hidden rather than merely allowed to be.
 *  This used to be `if (!c) continue`, and hiding `.ctl-br` below 840px (the
 *  zoom and fit buttons, gone) passed every test in this file: the measure
 *  had nothing left to measure. */
function expectClustersInsideStage(r, because, { absent = [] } = {}) {
  const { stage } = r;
  expect(stage.width, `#stage has a real width — ${because}`).toBeGreaterThan(0);
  for (const [key, sel] of Object.entries(CLUSTERS)) {
    const c = r[key];
    const why = `${sel} — ${because}`;
    if (absent.includes(key)) {
      expect(c, `${why} (hidden, as this state requires)`).toBeNull();
      continue;
    }
    expect(c, `${why} (on the map at all)`).not.toBeNull();
    expect(c.width, `${why} (non-empty)`).toBeGreaterThan(0);
    expect(c.height, `${why} (non-empty)`).toBeGreaterThan(0);
    expect(c.left, `${why} (left edge)`).toBeGreaterThanOrEqual(stage.left);
    expect(c.right, `${why} (right edge)`).toBeLessThanOrEqual(stage.right);
    expect(c.top, `${why} (top edge)`).toBeGreaterThanOrEqual(stage.top);
    expect(c.bottom, `${why} (bottom edge)`).toBeLessThanOrEqual(stage.bottom);
  }
}

/** `body{overflow:hidden}` means a horizontal overflow would be silent too. */
function expectNoHorizontalScroll(r, because) {
  expect(r.hScroll.docScroll, `the document never scrolls sideways — ${because}`)
    .toBe(r.hScroll.docClient);
  expect(r.hScroll.bodyScroll, `the body never scrolls sideways — ${because}`)
    .toBeLessThanOrEqual(r.hScroll.inner);
}

/** Put the period pill in its widest *and* tallest state, through the control
 *  a reader actually has. Nudging a knob engages the filter, which unfolds
 *  row 2 (§10) — and because `.tf-range` is tabular-nums, "1946 – 2026" is
 *  exactly as wide as the full "1945 – 2026", so one keypress buys both the
 *  longest row-1 content and the two-row shape at once. */
async function engagePeriod(page) {
  await nudgePeriod(page, 'a', 'ArrowRight');
  await expect(page.locator('#tf-row2')).toBeVisible();
  expect(await periodLabel(page), 'the engaged pill shows a full four-digit range')
    .toMatch(/^\d{4} – \d{4}$/);
}

/** Fire a control's own click handler, bypassing hit-testing.
 *  Needed for the two top-left buttons only: at most window widths they sit
 *  under the top-right cluster's transparent box, so a real mouse click never
 *  reaches them — see the two SPEC-DEVIATION tests at the end of this file.
 *  A collapse test driven by a real click would be testing that bug instead. */
const pressById = (page, id) => page.evaluate((i) => document.getElementById(i).click(), id);

/** Zoom about the stage's centre, so the visible window narrows onto the same
 *  geography. A bare `view.k` multiplication slides the window off Europe
 *  entirely and leaves nothing in view for a later resize to change. */
async function zoomCentre(page, factor) {
  await page.evaluate((f) => { const [w, h] = stageSize(); zoomAt(w / 2, h / 2, f); }, factor);
  await settleCounts(page);
}

/** The view as the map keeps it, plus the world-space point currently at the
 *  centre of the stage — the thing §5 says a stage resize must preserve. */
const viewState = (page) => page.evaluate(() => ({
  k: view.k, x: view.x, y: view.y, k0, stageW, stageH,
  centreX: (stageW / 2 - view.x) / view.k,
  centreY: (stageH / 2 - view.y) / view.k,
  geoW: GEO.W, geoH: GEO.H,
}));

const gridColumns = (page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('app')).gridTemplateColumns);

const total = (page) => page.evaluate(() => items.length);

// ------------------------------------------------------- §5 · the three-column grid ---

test.describe('§5 the grid', () => {
  test('§5 three columns, 312px | 1fr | 344px, with the map in the middle track', async ({ page }) => {
    await openAt(page, { width: 1440 });
    const r = await rects(page);
    // The feed is open by default above 840 px, so all three tracks are real.
    expect(r.stage.left, 'the map starts where the 312px sidebar ends').toBe(312);
    expect(await gridColumns(page)).toBe(`312px ${1440 - 312 - 344}px 344px`);
    expect(await page.evaluate(() =>
      document.getElementById('sidebar').getBoundingClientRect().width)).toBe(312);
    expect(await page.evaluate(() =>
      document.getElementById('feed').getBoundingClientRect().width)).toBe(344);
    // The map fills its track exactly: same rectangle as the stage.
    expect(r.map).toEqual(r.stage);
  });

  test('§5 the feed collapses to zero columns when it is hidden', async ({ page }) => {
    await openAt(page, { width: 1440 });
    await page.click('#feed-pill');
    await settleCounts(page);
    expect(await gridColumns(page)).toBe(`312px ${1440 - 312}px`);
    await expect(page.locator('#feed')).toBeHidden();
    const r = await rects(page);
    expect(r.stage.width).toBe(1440 - 312);
    expect(r.stage.right).toBe(1440);
    await expectCountersReconcile(page, 'feed hidden');
  });

  test('§5 the filters that configure the view live in the left panel', async ({ page }) => {
    await openAt(page, { width: 1440 });
    // §5 enumerates the sidebar's contents; the split with the floating cluster
    // is the whole point ("one place to look for interactions"), so each of
    // these has to be in the panel and not on the map.
    const ids = ['search', 'presets', 'f-layers', 'f-domains', 'links-row', 'f-nogeo',
      'f-mymap', 'st-project', 'st-team', 'st-commons', 'st-framework', 'st-note',
      'intro-btn', 'tour-btn'];
    const where = await page.evaluate((list) => list.map((id) => {
      const el = document.getElementById(id);
      return [id, !!el && !!el.closest('#sidebar'), !!el && !!el.closest('#stage')];
    }), ids);
    for (const [id, inSidebar, onStage] of where) {
      expect(inSidebar, `#${id} lives in the left panel`).toBe(true);
      expect(onStage, `#${id} does not float over the map`).toBe(false);
    }
  });

  test('§5 the top-right cluster holds the period slider and the mode pills', async ({ page }) => {
    await openAt(page, { width: 1440 });
    const shape = await page.evaluate(() => {
      const kids = (sel) => [...document.querySelector(sel).children].map((e) => e.id || e.className);
      return {
        clusters: [...document.querySelectorAll('.ctl')].map((e) => e.className),
        tr: kids('.ctl-tr'), group: kids('.ctl-group'), br: kids('.ctl-br'), bl: kids('.ctl-bl'),
        sliderCluster: document.getElementById('tf-slider').closest('.ctl').className,
        topLeft: ['sb-hide', 'sb-open'].map((id) => !!document.getElementById(id).closest('.ctl')),
      };
    });
    // Invariant 11 names exactly three clusters; a fourth would need its own
    // width bound, and this is where a reader of the invariant would look.
    expect(shape.clusters).toEqual(['ctl ctl-tr', 'ctl ctl-br', 'ctl ctl-bl']);
    expect(shape.tr).toEqual(['ctl-time', 'ctl-group']);
    expect(shape.group).toEqual(['links-pill', 'mymap-pill', 'feed-pill', 'lang-switch', 'help-btn']);
    // The slider is in the top-right cluster, not in a bottom bar: that move is
    // the reason §5 gives for the split.
    expect(shape.sliderCluster).toBe('ctl ctl-tr');
    expect(shape.br).toEqual(['z-in', 'z-out', 'z-fit']);
    expect(shape.bl).toEqual(['legend', 'attrib']);
    // §5 says "floating control clusters at the four corners", but the fourth —
    // top-left — is two loose buttons rather than a `.ctl`, so nothing bounds
    // them and nothing keeps them out from under the cluster above. That gap is
    // what the two deviations at the end of this file are about.
    expect(shape.topLeft, '#sb-hide and #sb-open belong to no cluster').toEqual([false, false]);
  });
});

// ------------------------------------------- invariant 11 · clusters inside the stage ---

const BOUND_WIDTHS = [1600, 1280, 1024, 900, 841, 840, 600, 375];

for (const lang of ['en', 'fr']) {
  for (const width of BOUND_WIDTHS) {
    // The three states are the ones that change a cluster's shape: as opened,
    // with the period pill engaged (two rows, longest range text), and with the
    // legend expanded (the bottom-left cluster's only variable content).
    test(`invariant 11 no floating cluster leaves #stage at ${width}px (${lang})`, async ({ page }) => {
      await openAt(page, { width, lang });
      const at = `${width}px ${lang}`;

      let r = await rects(page);
      expectClustersInsideStage(r, `${at}, as opened`);
      expectNoHorizontalScroll(r, `${at}, as opened`);

      await engagePeriod(page);
      r = await rects(page);
      expectClustersInsideStage(r, `${at}, period engaged (two rows)`);
      expectNoHorizontalScroll(r, `${at}, period engaged`);

      await page.click('#legend summary');
      await expect(page.locator('#legend-rows')).toBeVisible();
      r = await rects(page);
      expectClustersInsideStage(r, `${at}, legend expanded`);
      expectNoHorizontalScroll(r, `${at}, legend expanded`);
    });
  }
}

test.describe('invariant 11 the width bounds themselves', () => {
  test('invariant 11 #stage clips rather than spills, which is why the bounds exist', async ({ page }) => {
    await openAt(page, { width: 1440 });
    // The premise of the invariant: an over-wide cluster would be swallowed,
    // not visibly broken. If #stage ever stopped clipping, the invariant would
    // still hold but for a different reason, and this file would be measuring
    // the wrong thing.
    const styles = await page.evaluate(() => ({
      stage: getComputedStyle(document.getElementById('stage')).overflow,
      stagePosition: getComputedStyle(document.getElementById('stage')).position,
      pill: getComputedStyle(document.querySelector('.tf')).overflow,
      body: getComputedStyle(document.body).overflow,
      clusterPos: [...document.querySelectorAll('.ctl')].map((e) => getComputedStyle(e).position),
    }));
    expect(styles.stage).toBe('hidden');
    // The clusters are absolutely positioned against the stage — that is what
    // makes #stage's rectangle the right thing to compare them with.
    expect(styles.stagePosition).toBe('relative');
    expect(styles.clusterPos).toEqual(['absolute', 'absolute', 'absolute']);
    expect(styles.pill, 'the pill clips its own content as a second line of defence')
      .toBe('hidden');
    expect(styles.body).toBe('hidden');
  });

  test('invariant 11 above 840px each cluster is hung from a single bracket', async ({ page }) => {
    // §5's image for why a width bound is needed at all: `.ctl-tr`, `.ctl-br`
    // and `.ctl-bl` each have an offset from one edge and nothing from the
    // other, so nothing about the positioning limits how wide they get. 1600px
    // is wide enough that none of them is at its bound, which is the state this
    // measures — a cluster sitting at its max-width would pin both edges and
    // hide the asymmetry.
    await openAt(page, { width: 1600, lang: 'fr' });
    const r = await rects(page);
    for (const [key, edge] of [['tr', 'right'], ['br', 'right'], ['bl', 'left']]) {
      const c = r[key];
      if (edge === 'right') {
        expect(c.right, `.ctl-${key} is pinned 14px from the stage's right`).toBe(r.stage.right - 14);
        expect(c.left, `.ctl-${key}'s left edge floats`).toBeGreaterThan(r.stage.left + 14);
      } else {
        expect(c.left, `.ctl-${key} is pinned 14px from the stage's left`).toBe(r.stage.left + 14);
        expect(c.right, `.ctl-${key}'s right edge floats`).toBeLessThan(r.stage.right - 14);
      }
    }
  });

  test('§5 the cluster max-width is written in the grid\'s own 312/344px, above 840px only', async ({ page }) => {
    const W = 1280;
    await openAt(page, { width: W });
    const trMax = () => page.evaluate(() =>
      getComputedStyle(document.querySelector('.ctl-tr')).maxWidth);

    // feed open, sidebar shown: the stage is 100vw minus both columns.
    expect(await trMax()).toBe(`${W - 312 - 344 - 28}px`);

    await page.click('#feed-pill');                       // feed hidden
    await settleCounts(page);
    expect(await trMax()).toBe(`${W - 312 - 28}px`);

    await pressById(page, 'sb-hide');                      // sidebar hidden too
    await settleCounts(page);
    expect(await trMax()).toBe(`${W - 28}px`);

    await page.click('#feed-pill');                        // sidebar hidden, feed open
    await settleCounts(page);
    expect(await trMax()).toBe(`${W - 344 - 28}px`);

    // Below the breakpoint the cluster is bounded the simpler way, by having
    // both `left` and `right` — so the calc()s must not apply there.
    await openAt(page, { width: 840 });
    expect(await trMax()).toBe('none');
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.tf')).maxWidth)).toBe('none');
  });

  test('§5 engaging the period filter grows the pill downward, never sideways', async ({ page }) => {
    await openAt(page, { width: 1600, lang: 'fr' });
    const before = await rects(page);
    await engagePeriod(page);
    const after = await rects(page);
    // Row 2 unfolds below; the pill's footprint on the map does not move.
    expect(after.tf.width).toBe(before.tf.width);
    expect(after.tf.left).toBe(before.tf.left);
    expect(after.tf.right).toBe(before.tf.right);
    expect(after.tf.top).toBe(before.tf.top);
    expect(after.tf.height).toBeGreaterThan(before.tf.height);
    // The cluster grows with it, downward only.
    expect(after.tr.right).toBe(before.tr.right);
    expect(after.tr.bottom).toBeGreaterThan(before.tr.bottom);
    expectClustersInsideStage(after, '1600px fr, period engaged');
  });

  for (const lang of ['en', 'fr']) {
    test(`§5 the pill's 400px budget fits its longest row-1 content (${lang})`, async ({ page }) => {
      // 1600px leaves the cluster's own max-width slack (100vw-684 = 916px), so
      // what is measured here is the pill's own 400px budget and nothing else.
      // §5 says that budget was measured against the longer language's widest
      // realistic row 1 "with headroom" — label + a full four-digit range + the
      // info icon + the slider's fixed 172px.
      await openAt(page, { width: 1600, lang });
      await engagePeriod(page);
      const r = await rects(page);
      expect(r.pill.maxWidth).toBe('400px');
      expect(r.tf.width, 'the pill sits inside its own budget').toBeLessThanOrEqual(400);
      expect(r.pill.scrollWidth, 'nothing in the pill is clipped').toBeLessThanOrEqual(r.pill.clientWidth);
      // The slider is the one fixed-width, non-shrinking child — the part that
      // visibly overflowed the pill's border when the budget was 320px.
      expect(r.slider.width).toBe(172);
      expect(r.slider.right).toBeLessThanOrEqual(r.tf.right);
      expect(r.slider.left).toBeGreaterThanOrEqual(r.tf.left);
      expectClustersInsideStage(r, `1600px ${lang}, period engaged`);
    });
  }

  test('§5 a pill narrower than its content clips itself instead of leaking onto the map', async ({ page }) => {
    // SPEC-DEVIATION: §5 says the cluster's max-width gives flex-wrap "an
    // actual width to wrap against: past a certain narrowness — a modest window
    // with the feed panel open, say — the button row drops to its own line
    // below the pill instead of either row clipping". At 1024px with the feed
    // open the button row does drop, but row 1 clips as well: the cluster's
    // budget (100vw-684 = 340px) is below the pill's ~370-377px natural width,
    // so the slider is cut off. The pill's overflow:hidden keeps the clipping
    // invisible rather than leaking it, which is the behaviour asserted here.
    await openAt(page, { width: 1024, lang: 'fr' });
    await engagePeriod(page);
    const r = await rects(page);
    expect(r.pill.scrollWidth).toBeGreaterThan(r.pill.clientWidth);
    // The button row did drop below the pill, as §5 promises.
    expect(r.group.top).toBeGreaterThanOrEqual(r.tf.bottom);
    // And the part that no longer fits is clipped, not painted over the map:
    // the slider's box reaches past the stage, the pill's box does not.
    expect(r.slider.right).toBeGreaterThan(r.stage.right);
    expect(r.tf.right).toBeLessThanOrEqual(r.stage.right);
    expect(r.pill.overflow).toBe('hidden');
    expectClustersInsideStage(r, '1024px fr, pill clipped');
    expectNoHorizontalScroll(r, '1024px fr, pill clipped');
  });

  test('invariant 11 the bottom clusters carry their own bounds too', async ({ page }) => {
    // §5's rule is about every cluster, not only the exposed one: `.ctl-br` and
    // `.ctl-bl` are hung from a single bracket in the same way. Their bounds are
    // just quieter — three fixed 34px squares, and a legend with a max-width.
    await openAt(page, { width: 1600, lang: 'fr' });
    // Checked before anything is measured or clicked: a `display:none` cluster
    // still answers getComputedStyle with a max-width, and the legend click
    // below would then hang for the full timeout instead of saying what broke.
    expectClustersInsideStage(await rects(page), '1600px fr, as opened');
    const desktop = await page.evaluate(() => ({
      legend: getComputedStyle(document.querySelector('.legend')).maxWidth,
      squares: [...document.querySelectorAll('.ctl-br .sq')].map((e) => e.getBoundingClientRect().width),
      brRight: getComputedStyle(document.querySelector('.ctl-br')).right,
      blLeft: getComputedStyle(document.querySelector('.ctl-bl')).left,
    }));
    expect(desktop.legend).toBe('230px');
    expect(desktop.squares).toEqual([34, 34, 34]);
    expect(desktop.brRight).toBe('14px');
    expect(desktop.blLeft).toBe('14px');
    await page.click('#legend summary');
    await expect(page.locator('#legend-rows')).toBeVisible();
    let r = await rects(page);
    expect(r.bl.width, 'the expanded legend stays inside its own budget').toBeLessThanOrEqual(230);
    expectClustersInsideStage(r, '1600px fr, legend expanded');

    // Mobile trims the legend's budget rather than dropping it.
    await openAt(page, { width: 375, lang: 'fr' });
    expectClustersInsideStage(await rects(page), '375px fr, as opened');
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.legend')).maxWidth)).toBe('180px');
    await page.click('#legend summary');
    await expect(page.locator('#legend-rows')).toBeVisible();
    r = await rects(page);
    expect(r.bl.width).toBeLessThanOrEqual(180);
    expectClustersInsideStage(r, '375px fr, legend expanded');
  });

  test('§5 anything added to the pill\'s second row shares the pill\'s budget', async ({ page }) => {
    // "Anything added to either row of the pill shares the pill's budget." The
    // only way to test a rule about future content is to add some: a 900px block
    // in row 2 must not widen the pill past 400px, and must not push the cluster
    // off the stage — it gets clipped, which is what overflow:hidden is for.
    await openAt(page, { width: 1600, lang: 'fr' });
    await engagePeriod(page);
    const before = await rects(page);
    await page.evaluate(() => {
      const s = document.createElement('span');
      s.style.cssText = 'flex:none;width:900px;height:6px';
      document.getElementById('tf-row2').appendChild(s);
    });
    const after = await rects(page);
    expect(after.tf.width).toBe(400);                       // the budget, not 900px
    expect(after.tf.right).toBe(before.tf.right);            // grown leftward only
    expect(after.pill.scrollWidth).toBeGreaterThan(after.pill.clientWidth);
    expectClustersInsideStage(after, '1600px fr, 900px added to pill row 2');
    expectNoHorizontalScroll(after, '1600px fr, 900px added to pill row 2');
  });

  test('§5 anything added to the cluster shares the cluster\'s budget', async ({ page }) => {
    // The other half of the same sentence. A 2000px pill added to the button row
    // must stop at the cluster's max-width — which is the stage's width less the
    // two 14px offsets — rather than reaching back across the sidebar.
    await openAt(page, { width: 1600, lang: 'fr' });
    await page.evaluate(() => {
      const s = document.createElement('span');
      s.style.cssText = 'flex:none;width:2000px;height:10px';
      document.querySelector('.ctl-group').appendChild(s);
    });
    const r = await rects(page);
    expect(r.tr.width).toBe(1600 - 312 - 344 - 28);
    expect(r.tr.left).toBe(r.stage.left + 14);
    expect(r.tr.right).toBe(r.stage.right - 14);
    expectClustersInsideStage(r, '1600px fr, 2000px added to the cluster');
    expectNoHorizontalScroll(r, '1600px fr, 2000px added to the cluster');
  });

  test('invariant 11 an empty view changes no rectangle', async ({ page }) => {
    // The zero case: every layer off, so nothing matches, the histogram goes
    // flat and every count reads 0. None of that is allowed to resize anything —
    // the pill's row 1 holds a fixed 172px slider and tabular figures precisely
    // so that its footprint does not follow the data.
    await openAt(page, { width: 1280, lang: 'fr' });
    const before = await rects(page);
    await setLayers(page, []);
    await settleCounts(page);
    const after = await rects(page);
    expect((await snapshot(page)).matchCount, 'nothing matches').toBe(0);
    expect(after.tf).toEqual(before.tf);
    expect(after.tr).toEqual(before.tr);
    expect(after.bl).toEqual(before.bl);
    expect(after.br).toEqual(before.br);
    expectClustersInsideStage(after, '1280px fr, every layer off');
    await expectCountersReconcile(page, 'every layer off');
    for (const l of await page.evaluate(() => [...document.querySelectorAll('.stats span')]
      .map((s) => ({ text: s.textContent, scroll: s.scrollWidth, client: s.clientWidth })))) {
      expect(l.scroll, `"${l.text}" is not clipped by the zero counts`).toBeLessThanOrEqual(l.client);
    }
  });

  test('invariant 11 the clusters stay inside a short stage with the legend expanded', async ({ page }) => {
    // Height is the axis the bottom clusters grow along: `.ctl-bl` is anchored
    // by `bottom`, so an expanded legend pushes its top edge upward, towards
    // the top of the stage rather than past its foot.
    for (const size of [{ width: 841, height: 420 }, { width: 375, height: 420 }]) {
      await openAt(page, { ...size, lang: 'fr' });
      // Again before the click: the legend lives in `.ctl-bl`, so a cluster
      // that is not on the map turns this into a timeout rather than a verdict.
      expectClustersInsideStage(await rects(page), `${size.width}x${size.height} fr, as opened`);
      await page.click('#legend summary');
      await expect(page.locator('#legend-rows')).toBeVisible();
      await engagePeriod(page);
      const r = await rects(page);
      expectClustersInsideStage(r, `${size.width}x${size.height} fr, legend expanded`);
      expect(r.bl.top).toBeGreaterThanOrEqual(r.stage.top);
      expect(r.bl.bottom).toBeLessThanOrEqual(r.stage.bottom);
    }
  });
});

// ------------------------------------------------ §5 · the collapsed sidebar's track ---

test.describe('§5 the collapsed sidebar', () => {
  test('§5 body.sb-hidden leaves the map in the map\'s track, feed open', async ({ page }) => {
    await openAt(page, { width: 1280 });
    await pressById(page, 'sb-hide');
    await settleCounts(page);
    await expect(page.locator('#sidebar')).toBeHidden();
    // `1fr 344px`, not `0 1fr 344px`: a stub for the collapsed column would
    // hand the map the stub and the feed the map's track.
    expect(await gridColumns(page)).toBe(`${1280 - 344}px 344px`);
    const r = await rects(page);
    expect(r.stage.left, 'the map starts at the window edge').toBe(0);
    expect(r.stage.width).toBe(1280 - 344);
    expect(r.map, 'the map still fills the stage').toEqual(r.stage);
    await expect(page.locator('#map')).toBeVisible();
    expect(await page.evaluate(() =>
      document.getElementById('feed').getBoundingClientRect().left)).toBe(1280 - 344);
  });

  test('§5 body.sb-hidden with the feed hidden gives the map the whole window', async ({ page }) => {
    await openAt(page, { width: 1280 });
    await page.click('#feed-pill');
    await settleCounts(page);
    await pressById(page, 'sb-hide');
    await settleCounts(page);
    expect(await gridColumns(page)).toBe('1280px');
    const r = await rects(page);
    expect(r.stage.left).toBe(0);
    expect(r.stage.width).toBe(1280);
    expect(r.map).toEqual(r.stage);
    await expectCountersReconcile(page, 'sidebar and feed both collapsed');
  });

  test('§5 reopening the sidebar hands its track back', async ({ page }) => {
    await openAt(page, { width: 1280 });
    await pressById(page, 'sb-hide');
    await settleCounts(page);
    await pressById(page, 'sb-open');
    await settleCounts(page);
    await expect(page.locator('#sidebar')).toBeVisible();
    expect(await gridColumns(page)).toBe(`312px ${1280 - 312 - 344}px 344px`);
    const r = await rects(page);
    expect(r.stage.left).toBe(312);
    expect(r.stage.width).toBe(1280 - 312 - 344);
    expectClustersInsideStage(r, 'sidebar restored');
  });
});

// ---------------------------------------------------------- §5 · stageResized() ---

test.describe('§5 stageResized()', () => {
  test('§5 collapsing the sidebar fires no resize, so the counters must be brought back in step', async ({ page }) => {
    await openAt(page, { width: 1280 });
    const n = await total(page);
    // Zoom in first: with everything in view there is nothing for a refit to
    // change, and a stageResized() that did nothing would still look right.
    await zoomCentre(page, 2.1);
    const before = await snapshot(page);
    expect(before.offScreen, 'the zoom has pushed markers off screen').toBeGreaterThan(0);
    expect(before.inView + before.offScreen + before.offMapMatch).toBe(n);

    await pressById(page, 'sb-hide');
    await settleCounts(page);

    const after = await snapshot(page);
    // A wider stage over the same geography shows strictly more of it.
    expect(after.inView, 'the wider stage brings markers into view').toBeGreaterThan(before.inView);
    expect(after.offScreen).toBeLessThan(before.offScreen);
    // Nothing is gained or lost from the placed set — only re-split.
    expect(after.inView + after.offScreen).toBe(before.inView + before.offScreen);
    expect(after.inView + after.offScreen + after.offMapMatch).toBe(n);
    await expectCountersReconcile(page, 'after collapsing the sidebar');
  });

  test('§5 stageResized keeps the reader\'s zoom and the same geography centred', async ({ page }) => {
    await openAt(page, { width: 1280 });
    await zoomCentre(page, 2.1);
    const before = await viewState(page);
    expect(before.stageW).toBe(1280 - 312 - 344);

    await pressById(page, 'sb-hide');
    await settleCounts(page);
    const after = await viewState(page);

    expect(after.stageW, 'the stage grew by the sidebar\'s track').toBe(1280 - 344);
    expect(after.k, 'the reader\'s zoom is untouched').toBe(before.k);
    // k0 is re-derived from the new rectangle — every zoom threshold in §4.4 is
    // relative to it, so a stale k0 would move the label and capital cut-offs.
    expect(after.k0).toBeCloseTo(Math.min(after.stageW / after.geoW, after.stageH / after.geoH), 10);
    expect(after.k0).not.toBeCloseTo(before.k0, 3);
    // Same geography centred: the offset moves by half the width difference.
    expect(after.x).toBeCloseTo(before.x + (after.stageW - before.stageW) / 2, 6);
    expect(after.centreX).toBeCloseTo(before.centreX, 6);
    expect(after.centreY).toBeCloseTo(before.centreY, 6);
  });

  test('§5 only a real resize refits the map — and that one does not keep the zoom', async ({ page }) => {
    // The contrast that makes stageResized() necessary. A window resize runs
    // fitView(), which throws the reader's zoom away and re-centres Europe; a
    // stage resize with the window unchanged must not, or collapsing the sidebar
    // would silently reset the view. Both paths have to leave the counts right.
    await openAt(page, { width: 1280 });
    await zoomCentre(page, 2.1);
    const before = await viewState(page);
    expect(before.k).toBeGreaterThan(before.k0 * 1.22);

    await page.setViewportSize({ width: 1000, height: 820 });
    await page.waitForFunction(() => stageW === 1000 - 312 - 344);
    await settleCounts(page);

    const after = await viewState(page);
    // fitView's own formula: k0 for the new rectangle, times 1.22.
    expect(after.k0).toBeCloseTo(Math.min(after.stageW / after.geoW, after.stageH / after.geoH), 10);
    expect(after.k).toBeCloseTo(after.k0 * 1.22, 10);
    expect(after.k).not.toBeCloseTo(before.k, 3);
    await expectCountersReconcile(page, 'after a real window resize');
    expectClustersInsideStage(await rects(page), 'after a real window resize to 1000px');
  });

  test('§5 toggling the feed resizes the stage with no resize event either', async ({ page }) => {
    await openAt(page, { width: 1280 });
    const n = await total(page);
    await zoomCentre(page, 2.1);
    const before = await viewState(page);
    const c0 = await snapshot(page);
    expect(c0.offScreen).toBeGreaterThan(0);

    await page.click('#feed-pill');                 // hide the feed: stage widens
    await settleCounts(page);
    const wider = await viewState(page);
    const c1 = await snapshot(page);
    expect(wider.stageW).toBe(1280 - 312);
    expect(wider.k).toBe(before.k);
    expect(wider.centreX).toBeCloseTo(before.centreX, 6);
    expect(c1.inView).toBeGreaterThan(c0.inView);
    expect(c1.inView + c1.offScreen + c1.offMapMatch).toBe(n);
    await expectCountersReconcile(page, 'after hiding the feed');

    await page.click('#feed-pill');                 // and back: stage narrows
    await settleCounts(page);
    const back = await viewState(page);
    const c2 = await snapshot(page);
    expect(back.stageW).toBe(before.stageW);
    expect(back.k).toBe(before.k);
    expect(back.x).toBeCloseTo(before.x, 6);
    expect(back.k0).toBeCloseTo(before.k0, 10);
    expect(c2.inView).toBe(c0.inView);
    await expectCountersReconcile(page, 'after showing the feed again');
  });
});

// --------------------------------------------------------------- §5 · the stats tiles ---

test.describe('§5 the stats tiles', () => {
  for (const lang of ['en', 'fr']) {
    test(`§5 no stats tile label is clipped in the 312px sidebar (${lang})`, async ({ page }) => {
      await openAt(page, { width: 1280, lang });
      const cells = await page.evaluate(() => ({
        cols: getComputedStyle(document.querySelector('.stats')).gridTemplateColumns,
        labels: [...document.querySelectorAll('.stats span')]
          .map((s) => ({ text: s.textContent, scroll: s.scrollWidth, client: s.clientWidth })),
      }));
      // Four equal columns, one per layer (invariant 14) — the constraint the
      // label lengths have to live inside.
      expect(cells.cols.split(' ')).toHaveLength(4);
      expect(new Set(cells.cols.split(' ')).size).toBe(1);
      expect(cells.labels).toHaveLength(4);
      expect((await tiles(page)).map((t) => t.label)).toEqual(cells.labels.map((l) => l.text));
      for (const l of cells.labels) {
        expect(l.scroll, `"${l.text}" is not clipped in the ${lang} sidebar`)
          .toBeLessThanOrEqual(l.client);
      }
    });

    test(`§5 no stats tile label is clipped in the mobile drawer (${lang})`, async ({ page }) => {
      // The drawer is min(88vw, 330px): at 375px it is wider than the 312px
      // desktop column, at 360px slightly narrower. Both still fit.
      for (const width of [375, 360]) {
        await openAt(page, { width, lang });
        await pressById(page, 'sb-open');
        await page.waitForFunction(() =>
          document.getElementById('sidebar').getBoundingClientRect().left === 0);
        const labels = await page.evaluate(() => [...document.querySelectorAll('.stats span')]
          .map((s) => ({ text: s.textContent, scroll: s.scrollWidth, client: s.clientWidth })));
        expect(labels).toHaveLength(4);
        for (const l of labels) {
          expect(l.scroll, `"${l.text}" is not clipped in the ${width}px ${lang} drawer`)
            .toBeLessThanOrEqual(l.client);
          expect(l.client, 'the label has real room to be measured against').toBeGreaterThan(0);
        }
      }
    });
  }

  test('§5 on a 320px phone the drawer is narrow enough to clip FRAMEWORKS', async ({ page }) => {
    // SPEC-DEVIATION: §17 states the four-tile row as a fit against "the 312 px
    // sidebar", and the mobile drawer is min(88vw, 330px) — which is narrower
    // than 312px on any phone below ~355px. The tiles' own budget is
    // (0.88·vw − 36 − 15)/4 − 4 per label, and the uppercase English
    // "FRAMEWORKS" needs 58px, so it clips below about 340px of window width.
    // French is unaffected: "CADRES" is half the length. Asserted as-is; the
    // row would need to reflow (two by two) to hold at 320px.
    await openAt(page, { width: 320, lang: 'en' });
    await pressById(page, 'sb-open');
    await page.waitForFunction(() =>
      document.getElementById('sidebar').getBoundingClientRect().left === 0);
    const en = await page.evaluate(() => [...document.querySelectorAll('.stats span')]
      .map((s) => ({ text: s.textContent, scroll: s.scrollWidth, client: s.clientWidth })));
    expect(en.find((l) => l.text === 'Frameworks').scroll)
      .toBeGreaterThan(en.find((l) => l.text === 'Frameworks').client);
    // The other three still fit, so it is the label length and not the row.
    for (const l of en.filter((x) => x.text !== 'Frameworks')) {
      expect(l.scroll, `"${l.text}" still fits at 320px`).toBeLessThanOrEqual(l.client);
    }

    await openAt(page, { width: 320, lang: 'fr' });
    await pressById(page, 'sb-open');
    await page.waitForFunction(() =>
      document.getElementById('sidebar').getBoundingClientRect().left === 0);
    const fr = await page.evaluate(() => [...document.querySelectorAll('.stats span')]
      .map((s) => ({ text: s.textContent, scroll: s.scrollWidth, client: s.clientWidth })));
    for (const l of fr) {
      expect(l.scroll, `"${l.text}" fits at 320px in French`).toBeLessThanOrEqual(l.client);
    }
  });

  test('§5 a fifth tile clips FRAMEWORKS, which is why Countries leads the caption instead', async ({ page }) => {
    await openAt(page, { width: 1280, lang: 'en' });
    // §17: "Five tiles do not fit the 312px sidebar at a legible label size."
    // Measuring the fifth column against a clone of the real row proves both
    // halves of that claim at once — and proves the clipping check above is not
    // vacuous, since the same measure does trip here.
    const five = await page.evaluate(() => {
      const stats = document.querySelector('.stats');
      const clone = stats.cloneNode(true);
      clone.style.gridTemplateColumns = 'repeat(5,1fr)';
      clone.appendChild(clone.children[3].cloneNode(true));   // a fifth layer tile
      stats.parentNode.appendChild(clone);
      const out = [...clone.querySelectorAll('span')]
        .map((s) => ({ text: s.textContent, scroll: s.scrollWidth, client: s.clientWidth }));
      clone.remove();
      return out;
    });
    expect(five).toHaveLength(5);
    const frameworks = five.filter((l) => l.text === 'Frameworks');
    expect(frameworks).toHaveLength(2);
    for (const l of frameworks) {
      expect(l.scroll, 'a fifth column clips the longest label').toBeGreaterThan(l.client);
    }
    // Countries is not a layer and has no control of its own, so it leads the
    // caption rather than taking the fifth tile.
    expect(await page.locator('#st-note').textContent()).toMatch(/^\d+ countr/);
  });
});

// ------------------------------------------------------- §5 · the 840px breakpoint ---

test.describe('§5 the 840px breakpoint', () => {
  test('§5 at 841px the layout is still three in-flow columns', async ({ page }) => {
    await openAt(page, { width: 841 });
    expect(await gridColumns(page)).toBe(`312px ${841 - 312 - 344}px 344px`);
    const how = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.getElementById('sidebar')).position,
      feed: getComputedStyle(document.getElementById('feed')).position,
      collapse: getComputedStyle(document.getElementById('sb-hide')).display,
      trMax: getComputedStyle(document.querySelector('.ctl-tr')).maxWidth,
    }));
    expect(how.sidebar, 'the sidebar is a grid item, not an overlay').toBe('static');
    expect(how.feed).toBe('static');
    expect(how.collapse).not.toBe('none');
    expect(how.trMax).toBe(`${841 - 312 - 344 - 28}px`);
    expect((await snapshot(page)).inView).toBeGreaterThan(0);
  });

  test('§5 at 840px the sidebar and the feed become overlay drawers', async ({ page }) => {
    await openAt(page, { width: 840 });
    expect(await gridColumns(page), 'one track: the drawers are out of flow').toBe('840px');
    const r = await rects(page);
    expect(r.stage.left).toBe(0);
    expect(r.stage.width).toBe(840);
    const how = await page.evaluate(() => {
      const sb = document.getElementById('sidebar');
      return {
        position: getComputedStyle(sb).position,
        right: sb.getBoundingClientRect().right,
        width: sb.getBoundingClientRect().width,
        feedDisplay: getComputedStyle(document.getElementById('feed')).display,
      };
    });
    expect(how.position).toBe('fixed');
    expect(how.right, 'the closed drawer is off screen to the left').toBeLessThanOrEqual(0);
    expect(how.width).toBe(Math.min(0.88 * 840, 330));
    expect(how.feedDisplay).toBe('none');
    // The collapse chevron is replaced by the Filters FAB.
    await expect(page.locator('#sb-hide')).toBeHidden();
    await expect(page.locator('#sb-open')).toBeVisible();
  });

  test('§5 the sidebar drawer slides over the map without resizing it', async ({ page }) => {
    await openAt(page, { width: 375 });
    const before = await rects(page);
    const counts = await snapshot(page);
    await pressById(page, 'sb-open');
    await page.waitForFunction(() =>
      document.getElementById('sidebar').getBoundingClientRect().left === 0);
    const after = await rects(page);
    // An overlay, so the stage keeps its rectangle and needs no refit: the
    // counts must be untouched rather than merely reconciled.
    expect(after.stage).toEqual(before.stage);
    expect(await snapshot(page)).toEqual(counts);
    const backdrop = await page.evaluate(() => {
      const b = document.getElementById('sb-backdrop');
      return { opacity: getComputedStyle(b).opacity, pointer: getComputedStyle(b).pointerEvents };
    });
    expect(backdrop.opacity).toBe('1');
    expect(backdrop.pointer, 'the scrim takes the next tap, to dismiss the drawer').toBe('auto');
  });

  test('§5 the feed drawer leaves the map its full width below 840px', async ({ page }) => {
    await openAt(page, { width: 375 });
    await expect(page.locator('#feed')).toBeHidden();
    await page.click('#feed-pill');
    await page.waitForFunction(() =>
      document.getElementById('feed').getBoundingClientRect().right === window.innerWidth);
    await settleCounts(page);
    expect(await gridColumns(page), 'the feed takes no track below 840px').toBe('375px');
    const r = await rects(page);
    expect(r.stage.width).toBe(375);
    const feed = await page.evaluate(() => ({
      position: getComputedStyle(document.getElementById('feed')).position,
      width: document.getElementById('feed').getBoundingClientRect().width,
    }));
    expect(feed.position).toBe('fixed');
    expect(feed.width).toBe(Math.min(0.88 * 375, 340));
    expectNoHorizontalScroll(r, '375px with the feed drawer open');
    await expectCountersReconcile(page, '375px with the feed drawer open');
  });

  test('§5 both overlay drawers keep a cap, so a wide sub-breakpoint window keeps its map', async ({ page }) => {
    // The drawers are `min(88vw, 330px)` (sidebar) and `min(88vw, 340px)`
    // (feed). Every other drawer measurement in this file is taken at 375px or
    // narrower, where 88vw is the binding term — so the caps themselves went
    // untested, and replacing the feed's `min(88vw,340px)` with a bare `88vw`
    // passed the whole file. 800px is still below the 840px breakpoint, so both
    // panels are drawers, and wide enough that the caps are what binds: 88vw
    // there is 704px, seven eighths of the map.
    await openAt(page, { width: 800 });
    expect(await gridColumns(page), 'the drawers take no track below 840px').toBe('800px');

    await page.click('#feed-pill');
    await page.waitForFunction(() =>
      document.getElementById('feed').getBoundingClientRect().right === window.innerWidth);
    await settleCounts(page);
    const feed = await page.evaluate(() => {
      const el = document.getElementById('feed');
      const b = el.getBoundingClientRect();
      return { width: b.width, left: b.left, position: getComputedStyle(el).position };
    });
    expect(feed.position).toBe('fixed');
    expect(feed.width, 'the feed drawer stops at its 340px cap').toBe(340);
    const r = await rects(page);
    expect(r.stage.width, 'the map still has the whole window underneath').toBe(800);
    // The point of the cap, stated as the reader sees it: a drawer that covers
    // most of the map is a column in all but name, and §5 gives it no track.
    expect(feed.left - r.stage.left, 'more map is left showing than the drawer covers')
      .toBeGreaterThan(feed.width);
    expectNoHorizontalScroll(r, '800px with the feed drawer open');
    expectClustersInsideStage(r, '800px with the feed drawer open');

    await pressById(page, 'sb-open');
    await page.waitForFunction(() =>
      document.getElementById('sidebar').getBoundingClientRect().left === 0);
    expect(await page.evaluate(() =>
      document.getElementById('sidebar').getBoundingClientRect().width),
    'the sidebar drawer stops at its 330px cap').toBe(330);

    // And at 360px the other term binds, which is what keeps the caps honest:
    // a drawer as wide as its cap would be wider than the window itself.
    await openAt(page, { width: 360 });
    await page.click('#feed-pill');
    await page.waitForFunction(() =>
      document.getElementById('feed').getBoundingClientRect().right === window.innerWidth);
    await pressById(page, 'sb-open');
    await page.waitForFunction(() =>
      document.getElementById('sidebar').getBoundingClientRect().left === 0);
    const narrow = await page.evaluate(() => ({
      feed: document.getElementById('feed').getBoundingClientRect().width,
      sidebar: document.getElementById('sidebar').getBoundingClientRect().width,
    }));
    expect(narrow.feed, '88vw, below the 340px cap').toBeCloseTo(0.88 * 360, 1);
    expect(narrow.sidebar, '88vw, below the 330px cap').toBeCloseTo(0.88 * 360, 1);
  });

  test('§5 the top-right cluster wraps to two rows below 840px', async ({ page }) => {
    await openAt(page, { width: 375, lang: 'fr' });
    const r = await rects(page);
    // The buttons keep the first line; the period strip drops to a full-width
    // line of its own underneath.
    expect(r.group.top).toBe(r.tr.top);
    expect(r.tf.top).toBeGreaterThanOrEqual(r.group.bottom);
    expect(r.tf.width, 'the strip spans the whole cluster').toBe(r.tr.width);
    expect(r.pill.maxWidth, 'left+right already bound it; a max-width would leave a gap')
      .toBe('none');
    // The slider stretches instead of keeping its fixed desktop width, and the
    // "Période" label is dropped to buy the room.
    expect(r.slider.width).toBeGreaterThan(172);
    await expect(page.locator('.tf-h')).toBeHidden();
    // Below the breakpoint the cluster is bounded by having both offsets — a
    // real, simpler bound than the desktop calc()s, and the reason those are
    // scoped to min-width:841px rather than left to win on source order.
    const offsets = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.ctl-tr'));
      return { left: s.left, right: s.right };
    });
    expect(offsets).toEqual({ left: '10px', right: '10px' });
    expectClustersInsideStage(r, '375px fr, two-row cluster');
  });

  test('§5 the detail panel docks to the bottom of the screen below 840px', async ({ page }) => {
    await openAt(page, { width: 375, height: 820 });
    // Opened through the page's own entry point rather than a marker tap: at
    // this width the markers are 3 px wide and this test is about the panel's
    // rectangle, not about hit-testing a marker.
    await page.evaluate(() => openEntity(items.find((i) => i.geo).id));
    await expect(page.locator('#detail')).toBeVisible();
    const d = await page.evaluate(() => {
      const b = document.getElementById('detail').getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height };
    });
    expect(d.bottom, 'docked to the foot of the screen').toBe(820 - 10);
    expect(d.left).toBe(10);
    expect(d.right).toBeLessThanOrEqual(375 - 10);
    expect(d.height, 'at most 58vh, so the map stays visible above it')
      .toBeLessThanOrEqual(0.58 * 820 + 0.01);
    // `bottom` is the anchored edge here, not `top` as on desktop: the top is
    // wherever the height leaves it, and the gap below is the fixed 10px.
    expect(d.top).toBeCloseTo(820 - 10 - d.height, 3);
    expect(820 - d.bottom, 'the gap under the card is smaller than the map left above it')
      .toBeLessThan(d.top);
    // A sheet across the screen, not the 352px desktop column.
    expect(d.right - d.left).toBeGreaterThan(375 - 40);
    // The card covers the corners the right-hand clusters live in, so they go.
    await expect(page.locator('.ctl-tr')).toBeHidden();
    await expect(page.locator('.ctl-br')).toBeHidden();
    const r = await rects(page);
    expectClustersInsideStage(r, '375px with the docked card', { absent: ['tr', 'br'] });
  });

  test('§5 the detail panel is a right-hand column above 840px', async ({ page }) => {
    await openAt(page, { width: 1280 });
    await page.click('#feed-pill');                  // the feed renders the card instead
    await settleCounts(page);
    await page.evaluate(() => openEntity(items.find((i) => i.geo).id));
    await expect(page.locator('#detail')).toBeVisible();
    const { d, stage } = await page.evaluate(() => {
      const b = document.getElementById('detail').getBoundingClientRect();
      const s = document.getElementById('stage').getBoundingClientRect();
      return { d: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width },
        stage: { left: s.left, right: s.right, top: s.top, bottom: s.bottom } };
    });
    expect(d.width).toBe(352);
    expect(d.top).toBe(stage.top + 14);
    expect(d.right).toBe(stage.right - 14);
    expect(d.bottom).toBe(stage.bottom - 16);
    expect(d.left).toBeGreaterThan(stage.left);
    // With the card open and the feed closed, the right-hand clusters step
    // aside; reopening the feed moves the card into the feed and brings them
    // back, which is the state the bounds above are measured in.
    await expect(page.locator('.ctl-tr')).toBeHidden();
    // The feed pill lives in the cluster the open card just hid, so it has to be
    // reached through its handler rather than through a click.
    await pressById(page, 'feed-pill');
    await settleCounts(page);
    await expect(page.locator('#detail')).toBeHidden();
    await expect(page.locator('.ctl-tr')).toBeVisible();
    expectClustersInsideStage(await rects(page), 'card open, feed open');
  });

  test('§5 the 840px breakpoint decides the feed\'s default column', async ({ page }) => {
    // 841 is the first width at which the feed is a column rather than a
    // drawer, and the boot default follows the same line.
    await openAt(page, { width: 841 });
    expect((await snapshot(page)).myMap).toBe(false);
    await expect(page.locator('#feed')).toBeVisible();
    expect(await gridColumns(page)).toBe(`312px ${841 - 312 - 344}px 344px`);

    await openAt(page, { width: 840 });
    await expect(page.locator('#feed')).toBeHidden();
    expect(await gridColumns(page)).toBe('840px');
  });

  test('§5 the feed default survives a private window where localStorage throws', async ({ page }) => {
    // Nothing can be remembered, so the breakpoint decides alone — and the page
    // still has to boot rather than dying on the read.
    await openAt(page, { width: 1280, denyStorage: true });
    expect(await page.evaluate(() => { try { localStorage.getItem('x'); return 'readable'; } catch { return 'throws'; } }))
      .toBe('throws');
    await expect(page.locator('#feed')).toBeVisible();
    expect(await gridColumns(page)).toBe(`312px ${1280 - 312 - 344}px 344px`);
    await expectCountersReconcile(page, 'private window, 1280px');

    await openAt(page, { width: 840, denyStorage: true });
    await expect(page.locator('#feed')).toBeHidden();
    expect(await gridColumns(page)).toBe('840px');
    expectNoHorizontalScroll(await rects(page), 'private window, 840px');
  });
});

// ------------------------------------------------------------ §5 · horizontal scroll ---

test('§5 the page never scrolls horizontally, whatever the columns are doing', async ({ page }) => {
  await openAt(page, { width: 1280, lang: 'fr' });
  const check = async (because) => expectNoHorizontalScroll(await rects(page), because);
  await check('as opened');
  await engagePeriod(page);
  await check('period engaged');
  await page.click('#feed-pill');
  await settleCounts(page);
  await check('feed hidden');
  await pressById(page, 'sb-hide');
  await settleCounts(page);
  await check('sidebar collapsed');
  await page.click('#feed-pill');
  await settleCounts(page);
  await check('sidebar collapsed, feed open');

  // A positive control: the same measure does react to real overflow, so the
  // five assertions above are not passing by construction.
  const overflowed = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:0;top:0;width:4000px;height:2px';
    document.body.appendChild(d);
    const w = document.documentElement.scrollWidth;
    d.remove();
    return w;
  });
  expect(overflowed).toBeGreaterThan(1280);
  await check('after the control element is removed again');
});

// --------------------------------------------------------------- known deviations ---

test.describe('§5 clusters versus the top-left buttons', () => {
  test('§5 the wrapped top-right cluster swallows clicks on the collapse button', async ({ page }) => {
    // SPEC-DEVIATION: bounding `.ctl-tr` by max-width (§5) makes its box as wide
    // as that bound whenever its content wraps — and the box is a plain div, so
    // its empty left half still takes the hit. At 1280px with the feed open the
    // cluster spans the whole stage from x=14, which is exactly where #sb-hide
    // sits: a real click on the collapse chevron lands on the cluster and the
    // sidebar never collapses. §5 puts "all controls the reader acts on" in the
    // cluster, but the collapse chevron and the Filters FAB are not in it.
    // Asserted as-is; the fix would be `pointer-events:none` on `.ctl` with it
    // re-enabled on the children.
    await openAt(page, { width: 1280 });
    const covered = await page.evaluate(() => {
      const b = document.getElementById('sb-hide').getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { id: top && top.id, inCluster: !!(top && top.closest('#ctl-cluster')) };
    });
    expect(covered.inCluster).toBe(true);
    expect(covered.id).not.toBe('sb-hide');

    const box = await page.locator('#sb-hide').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await page.evaluate(() => document.body.classList.contains('sb-hidden')),
      'the click never reaches the chevron').toBe(false);
    // The handler itself is fine — only the geometry is in the way.
    await pressById(page, 'sb-hide');
    await settleCounts(page);
    expect(await page.evaluate(() => document.body.classList.contains('sb-hidden'))).toBe(true);
  });

  test('§5 the collapse button is clickable at the widths where the cluster does not wrap', async ({ page }) => {
    // The other side of the deviation above, and the reason it is easy to miss:
    // at 1440px the cluster's content fits on one row, so it shrinks to that
    // row's width and leaves the chevron alone. The bug follows the wrap, not
    // the window.
    await openAt(page, { width: 1440 });
    const r = await rects(page);
    expect(r.tr.height, 'one row').toBeLessThan(50);
    const free = await page.evaluate(() => {
      const b = document.getElementById('sb-hide').getBoundingClientRect();
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) ===
        document.getElementById('sb-hide');
    });
    expect(free, 'the unwrapped cluster leaves the chevron reachable').toBe(true);
    await page.click('#sb-hide');
    await settleCounts(page);
    expect(await page.evaluate(() => document.body.classList.contains('sb-hidden'))).toBe(true);
    expect((await rects(page)).stage.left).toBe(0);
  });

  test('§5 below 840px the cluster\'s button row swallows taps on the Filters FAB', async ({ page }) => {
    // SPEC-DEVIATION: the mobile rule gives `.ctl-tr` both `left:10px` and
    // `right:10px` — a real bound, as §5 says — but that edge-to-edge box also
    // covers #sb-open at (14,14), the only way to reach the sidebar drawer
    // §5 promises below 840px. A tap on "Filtres" lands on the cluster (on the
    // "Liens" pill at 375px) and nothing opens. Asserted as-is.
    for (const width of [840, 375]) {
      await openAt(page, { width });
      await expect(page.locator('#sb-open')).toBeVisible();
      const covered = await page.evaluate(() => {
        const b = document.getElementById('sb-open').getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { inCluster: !!(top && top.closest('#ctl-cluster')), isFab: top === document.getElementById('sb-open') };
      });
      expect(covered.inCluster, `${width}px: the cluster box covers the FAB`).toBe(true);
      expect(covered.isFab).toBe(false);

      const box = await page.locator('#sb-open').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(await page.evaluate(() => document.body.classList.contains('panel-open')),
        `${width}px: the tap never opens the drawer`).toBe(false);
      // The handler works when it is reached, so the drawer itself is sound.
      await pressById(page, 'sb-open');
      await page.waitForFunction(() =>
        document.getElementById('sidebar').getBoundingClientRect().left === 0);
      expect(await page.evaluate(() => document.body.classList.contains('panel-open'))).toBe(true);
    }
  });
});
