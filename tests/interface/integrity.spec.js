// Integrity: no network, escaping, performance.
//
// Spec sections covered: §1 (no dependencies), §2 (opens from disk),
// invariant 9 (every interpolated string goes through esc()),
// invariant 10 (the page never makes a network request), §15 (performance).
//
// Two techniques recur here and are worth explaining once.
//
// 1. Function *declarations* in the page's classic script become properties of
//    the global object, so `window.refresh`, `window.renderStats` and
//    `window.applyView` can be wrapped with counters from a test. The page's
//    own call sites resolve the identifier through the global object and reach
//    the wrapper — which is how a claim like "refresh() does not run per
//    animation frame" becomes a number instead of a code reading. Top-level
//    `const`/`let` bindings (state, items, view, ivTimer, feedKey…) stay in the
//    declarative environment and are readable by bare name, as _map.js says.
// 2. Invariant 9 is proved by *injection*, not by grepping for esc(). A setter
//    on `window.HAI_DATA` intercepts the payload between hai-data.js and the
//    inline script and pushes two entities whose every string carries an
//    `<img src=x onerror=…>`, a `</script>`, quotes and ampersands. If any
//    interpolation site forgot esc(), the browser builds an element and the
//    onerror handler sets a flag. No element, flag unset, text verbatim: the
//    escaping holds on that surface.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openMap, settleCounts, snapshot, setLayers, setPeriod, applyPreset, nudgePeriod, MAP_PATH } from './_map.js';

// ---------------------------------------------------------------- fixtures ---

/** The three files the published page is allowed to load (§2), as paths,
 *  derived from MAP_PATH so a mutation run pointed at a doctored copy still
 *  compares against that copy's own directory. */
function ownFiles() {
  const dir = MAP_PATH.replace(/[^/]*$/, '');
  return [MAP_PATH, `${dir}hai-data.js`, `${dir}europe-geo.js`];
}

const srcCache = new Map();
/** Read a committed file from the repository, for the static assertions. */
function repoFile(testInfo, rel) {
  const abs = path.resolve(testInfo.project.testDir, '../..', rel);
  if (!srcCache.has(abs)) srcCache.set(abs, readFileSync(abs, 'utf8'));
  return srcCache.get(abs);
}

/** The page under test, read as source. The static assertions below are claims
 *  about *the file being exercised*, so they have to follow MAP_PATH: reading
 *  `eu-hai-map.html` unconditionally would let a mutation run report green on
 *  markup, CSS and script text it never actually looked at. */
const pageSource = (testInfo) => repoFile(testInfo, MAP_PATH.replace(/^\/+/, ''));

/** Collect every request the browser makes, from before the first navigation. */
function recordRequests(page) {
  const seen = [];
  page.on('request', (r) => seen.push({ url: r.url(), type: r.resourceType() }));
  return seen;
}

const paths = (seen) => seen.map((r) => new URL(r.url).pathname);

// The hostile payload. Every string a card, a row, a tooltip or the print sheet
// can interpolate carries all four hazards at once: a tag that fires script if
// parsed, a `</script>` that would close the inline script if it were ever
// written into one, quotes that would break out of an attribute, and a raw
// ampersand that must survive a round trip through the HTML parser unchanged.
const IMG = '<img src=x onerror="window.__pwned=(window.__pwned||0)+1">';
const SCR = '</script><scr' + 'ipt>window.__pwned=(window.__pwned||0)+1;</scr' + 'ipt>';
const AMP = '& "double" \'single\' <b>&amp;</b>';
const HAZ = (s) => `${s} ${IMG} ${AMP}${SCR}`;

const PROBE = 'xss-probe';
const PROBE_FW = 'xss-probe-fw';

// A url is the one payload value that reaches three interpolations at once —
// `href`, `title` and the anchor's visible text — and extUrl() is the only
// helper that writes all three. This one is hostile in every way an attribute
// can be: a quote that would close `href`, a tag that would be built if the `>`
// ever reached the parser, a raw ampersand that has to survive the round trip,
// and enough length that extUrl() truncates the *text* mid-tag. Nothing in the
// committed payload does all four, which is why it has to be planted.
const HAZ_URL = 'https://example.invalid/doc?a=1&b=2"><img src=x onerror="window.__pwned=(window.__pwned||0)+1">';
// extUrl() strips the scheme, then cuts an unlabelled url at 36 characters and
// adds an ellipsis. The cut lands inside `<img sr`, so the visible text is a
// half-written tag — which is text only because it was escaped first.
const HAZ_URL_TEXT = 'example.invalid/doc?a=1&b=2"><img sr…';

/** Controlled values are rendered through taxo(), whose fallback for a key the
 *  vocabulary does not know is the key with its underscores spaced out (§3.4).
 *  The hazard strings carry `__pwned`, so expectations on those surfaces have to
 *  apply the same transformation. */
const deUnderscore = (s) => s.replace(/_/g, ' ');

const HOSTILE_PROJECT = {
  id: PROBE,
  name: HAZ('Zalgo'),
  city: HAZ('Cité'),
  country: HAZ('Pays'),
  // A deliberately unpopulated spot: jitter() nudges co-located entities, and
  // this test asserts on the marker for this exact id.
  lat: 44.13,
  lon: 9.67,
  domain: 'energy',
  when: HAZ('2021'),
  status: HAZ('statut'),
  size: HAZ('taille'),
  url: 'https://example.invalid/?a=1&b=2"><img src=x onerror="window.__pwned=1">',
  desc: `${HAZ('First')}\n\n${HAZ('Second')}`,
  desc_en: `${HAZ('First')}\n\n${HAZ('Second')}`,
  desc_fr: `${HAZ('Premier')}\n\n${HAZ('Second')}`,
  timeline: { start: '2021', end: '2026', milestones: [{ date: HAZ('2022'), label: HAZ('Jalon') }] },
  affiliation: { org: HAZ('Org'), parent: HAZ('Parent') },
  consortium: [{ org: HAZ('Consortium'), ref: PROBE_FW, role: HAZ('rôle'), country: HAZ('Pays') }],
  facilities: [HAZ('Installation')],
  demos: [{ label: HAZ('Démo'), date: HAZ('2023') }],
  delivs: [{ title: HAZ('Livrable'), date: HAZ('2024') }],
  appliesTo: [HAZ('champ')],
  focus: [HAZ('focus')],
  refs: [PROBE_FW],
  // `official` is the field that routes through extUrl(); giving it the hostile
  // url is what makes that helper's three interpolations testable at all.
  links: { official: HAZ_URL },
  prov: { by: HAZ('Curateur'), upd: HAZ('2026'), conf: 'high', src: HAZ('Source') },
};

// No coordinates: the same hazards have to survive the off-the-map list, which
// is the only place an entity without a marker is named (invariant 3).
const HOSTILE_FRAMEWORK = {
  id: PROBE_FW,
  name: HAZ('Norme'),
  domain: 'xai',
  createdBy: [PROBE],
  usedBy: [PROBE],
  timeline: { start: '2021' },
  jurisdiction: HAZ('juridiction'),
  issuer: { org: HAZ('Émetteur') },
};

/** Boot the page with the two hostile entities spliced into the payload. */
async function openHostile(page, opts = {}) {
  await page.addInitScript(({ proj, fw }) => {
    let real;
    Object.defineProperty(window, 'HAI_DATA', {
      configurable: true,
      get() { return real; },
      set(v) { real = v; v.PROJECTS.push(proj); v.FRAMEWORKS.push(fw); },
    });
  }, { proj: HOSTILE_PROJECT, fw: HOSTILE_FRAMEWORK });
  await openMap(page, opts);
  await settleCounts(page);
  return page;
}

/** The document-wide evidence that nothing was built out of the payload. */
function injectionEvidence(page) {
  return page.evaluate(() => ({
    pwned: window.__pwned ?? 0,
    // The page ships no <img> and no framed content at all, so any appearance
    // is an injected one.
    media: document.querySelectorAll('img, iframe, object, embed, source, track').length,
    // Two <script src> plus the one inline script. A parsed `</script>` from
    // the payload would add a fourth.
    scripts: document.querySelectorAll('script').length,
    handlers: document.querySelectorAll('[onerror], [onload], [onclick], [onmouseover], [onfocus]').length,
  }));
}

async function expectNoInjection(page, where) {
  const e = await injectionEvidence(page);
  expect(e, `nothing may be built from the payload — ${where}`)
    .toEqual({ pwned: 0, media: 0, scripts: 3, handlers: 0 });
}

/** Wrap the page's own functions with call counters (see the header note). */
async function instrument(page) {
  await page.evaluate(() => {
    window.__n = { recount: 0, refresh: 0, frame: 0 };
    const rs = window.renderStats, rf = window.refresh, av = window.applyView;
    window.renderStats = function () { window.__n.recount++; return rs.apply(this, arguments); };
    window.refresh = function () { window.__n.refresh++; return rf.apply(this, arguments); };
    window.applyView = function () { window.__n.frame++; return av.apply(this, arguments); };
  });
}
const counters = (page) => page.evaluate(() => ({ ...window.__n }));

// ============================================================== invariant 10 ==

test.describe('invariant 10 — the page never makes a network request', () => {
  test('§16.10 first paint asks for exactly the page and its two local files', async ({ page }) => {
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    expect(paths(seen)).toEqual(ownFiles());
  });

  test('§16.10 no stylesheet, font, image, xhr or fetch is ever requested', async ({ page }) => {
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    // A CDN stylesheet, a web font or an analytics beacon would each show up
    // here as its own resource type, whatever host it came from.
    expect([...new Set(seen.map((r) => r.type))].sort()).toEqual(['document', 'script']);
  });

  test('§16.10 nothing is requested off-origin, and nothing outside the page\'s own directory', async ({ page }) => {
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    const origin = new URL(page.url()).origin;
    const dir = MAP_PATH.replace(/[^/]*$/, '');
    for (const r of seen) {
      expect(new URL(r.url).origin, r.url).toBe(origin);
      expect(new URL(r.url).pathname.startsWith(dir), r.url).toBe(true);
    }
  });

  test('§16.10 no favicon is fetched — the page declares none, so the browser asks for none', async ({ page }) => {
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    expect(seen.filter((r) => /favicon|\.ico(\?|$)/i.test(r.url))).toEqual([]);
  });

  test('§16.10 exercising every control adds no request', async ({ page }) => {
    // The point of the invariant is not "a static page makes no requests" — it
    // is that no *interaction* reaches for anything either. So this walks the
    // whole surface: presets, filters, period, search, a card, a pin, the
    // graph, My map, the feed, the sidebar, zoom, both languages, the welcome
    // panel and the tour.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    const afterBoot = paths(seen);

    for (const id of ['overview', 'energy', 'aviation', 'health', 'human', 'sim']) await applyPreset(page, id);
    await setLayers(page, ['project', 'team']);
    await setLayers(page, ['project', 'team', 'commons', 'framework']);
    await page.click('#f-domains .fgroup-h .mini-btn[data-ga="none"]');
    await page.click('#f-domains .fgroup-h .mini-btn[data-ga="all"]');
    await setPeriod(page, 2015, 2020);
    await page.click('#tf-undated');
    await page.click('#tf-reset');
    await page.fill('#search', 'grid');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    await page.locator('.sd-item').first().click();
    // `body.feed-open #detail{display:none!important}` — at desktop width the
    // card lives in the feed, so the floating panel only becomes clickable once
    // the feed is closed. Both surfaces are exercised here.
    await page.click('#feed-pill');
    await page.click('#dt-body .dt-pin');
    await page.click('#dt-close');
    await page.click('#feed-pill');
    await page.click('#links-pill');
    await page.click('#mymap-pill');
    await page.click('#mymap-pill');
    await page.click('#z-in');
    await page.click('#z-out');
    await page.click('#z-fit');
    // dispatchEvent, not click: at 1280×720 with the feed open, #ctl-cluster's
    // box reaches across the stage and sits over the collapse button, so a real
    // click lands on the cluster. That is a layout question (§5, invariant 11);
    // what this test needs is the collapse handler to run.
    await page.locator('#sb-hide').dispatchEvent('click');
    await page.locator('#sb-open').dispatchEvent('click');
    await page.click('#share-btn');
    await page.click('.lang-switch button[data-lang="fr"]');
    await page.click('.lang-switch button[data-lang="en"]');
    await page.click('#help-btn');
    await page.click('#w-explore');
    await page.click('#tour-btn');
    for (let i = 0; i < 4; i++) await page.click('#tour-next');
    await page.click('#reset-btn');
    await settleCounts(page);

    expect(afterBoot).toEqual(ownFiles());
    expect(paths(seen), 'no interaction may add a request').toEqual(ownFiles());
    expect(errors, 'and none of it may throw').toEqual([]);
  });

  test('§16.10 the surfaces no click reaches — marker hover, the gap buttons, the off-the-map list, the trail, the slider keys — add no request', async ({ page }) => {
    // The walk above drives every control a reader can click. Three kinds of
    // surface are invisible to it, and each is a place a future edit would
    // naturally reach for an asset: the tooltip, which is built on pointerover
    // and is the obvious home for a country flag or a logo; the feed's two gap
    // buttons and the off-the-map list, which only exist once the counts
    // disagree; and the keyboard path through the period slider. A beacon added
    // to the tooltip was in fact caught by nothing here but the phone-width
    // test, which happens to land a real mouse on a marker — coverage by
    // accident, one viewport change away from gone.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);

    // Marker hover, through the delegated handler on #g-markers.
    await page.evaluate(() => {
      const el = mkEls[Object.keys(mkEls)[0]].querySelector('circle');
      const at = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y }));
      at('pointerover', 400, 300);
      at('pointermove', 420, 320);
    });
    await expect(page.locator('#tooltip .tt-name')).not.toBeEmpty();
    await page.evaluate(() => {
      mkEls[Object.keys(mkEls)[0]].querySelector('circle')
        .dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    });

    // Feed-row hover: the peek path, which restyles the focused entity's edges.
    await page.locator('#fd-list .fd-row').first().hover();
    await page.locator('#fd-list .fd-row').nth(1).hover();

    // The off-the-map list: the only place a coordinate-less entity is named,
    // and a row that draws a glyph of its own per entity (invariant 3).
    await expect(page.locator('#f-nogeo')).toBeVisible();
    expect(await page.locator('#nogeo-list .pin-item').count()).toBeGreaterThan(0);
    await page.locator('#nogeo-list .pin-item').first().dispatchEvent('click');
    await expect(page.locator('#dt-body .dt-name')).not.toBeEmpty();

    // A second hop, so the trail has a crumb to click back through.
    await page.evaluate(() => openEntity([...state.inView][0], { fly: false }));
    await expect(page.locator('#dt-trail .dt-crumb')).toHaveCount(1);
    await page.locator('#dt-trail .dt-crumb').first().dispatchEvent('click');

    // Zoom in until markers fall off the stage, which is what reveals the
    // feed's "+ N off screen" button, then use it (it fits the view back).
    await page.evaluate(() => setView({ k: view.k * 6, x: view.x, y: view.y }, false));
    await settleCounts(page);
    expect(await page.evaluate(() => state.offScreen), 'the off-screen gap is real').toBeGreaterThan(0);
    await expect(page.locator('#fd-offscreen')).toBeVisible();
    await page.locator('#fd-offscreen').dispatchEvent('click');
    await settleCounts(page);
    // And the off-the-map gap button, which scrolls the sidebar section into view.
    expect(await page.evaluate(() => state.offMapMatch), 'the off-map gap is real too').toBeGreaterThan(0);
    await expect(page.locator('#fd-offmap')).toBeVisible();
    await page.locator('#fd-offmap').dispatchEvent('click');

    // §14 says the slider is operable by keyboard; that path renders the
    // histogram and the period label without any click involved.
    await nudgePeriod(page, 'a', 'ArrowRight', 3);
    await nudgePeriod(page, 'b', 'ArrowLeft', 3);
    await nudgePeriod(page, 'a', 'Home');
    await settleCounts(page);

    expect(paths(seen), 'no hover, no keystroke and no gap button may add a request').toEqual(ownFiles());
    expect(errors, 'and none of it may throw').toEqual([]);
  });

  test('§16.10 the print sheet requests nothing either', async ({ page }) => {
    // The print sheet is built from the payload, including every entity's url —
    // an <img> or a stylesheet slipped in there would only show up at print
    // time. window.print() itself is stubbed: it is the browser's dialog, not
    // the page's behaviour, and it would block the run.
    await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    await page.click('#print-btn');
    expect(await page.evaluate(() => window.__printed)).toBe(1);
    await expect(page.locator('#print-sheet h1')).not.toBeEmpty();
    expect(await page.evaluate(() => document.querySelectorAll('#print-sheet img, #print-sheet link').length)).toBe(0);
    expect(paths(seen)).toEqual(ownFiles());
  });

  test('§16.10 every url field in the payload is http(s), so no href can navigate the page itself', async ({ page }) => {
    await openMap(page);
    // esc() escapes characters, not schemes: a `javascript:` or a relative url
    // in the payload would reach an href intact. The guarantee has to come from
    // the data, so assert it of the data — across every field §3.3 documents as
    // a url and that ends up inside an href.
    const urls = await page.evaluate(() => {
      const out = [];
      const add = (u) => { if (u != null && u !== '') out.push(String(u)); };
      items.forEach(({ d }) => {
        add(d.url); add(d.repo);
        const lk = d.links || {};
        ['official', 'docs'].forEach((k) => add(lk[k]));
        [d.affiliation, d.issuer, d.maintainer, (d.infra || {}).operator].forEach((o) => o && add(o.url));
        (d.demos || []).forEach((x) => add(x.url));
        (d.delivs || []).forEach((x) => add(x.url));
        if (d.funding) add(d.funding.url);
      });
      return out;
    });
    // Guard against a vacuous pass: the real corpus is full of links.
    expect(urls.length).toBeGreaterThan(200);
    expect(urls.filter((u) => !/^https?:\/\//.test(u))).toEqual([]);
  });

  test('§16.10 every anchor the card renders leaves the document: target=_blank, rel=noopener', async ({ page }) => {
    await openMap(page);
    const anchors = await page.evaluate(() => {
      const out = [];
      // Deterministic sample: the first five entities of the payload that carry
      // a url at all, each opened in turn.
      const ids = items.filter((it) => it.d.url).slice(0, 5).map((it) => it.id);
      ids.forEach((id) => {
        openEntity(id, { fly: false });
        document.querySelectorAll('#dt-body a[href]').forEach((a) =>
          out.push({ id, href: a.getAttribute('href'), target: a.target, rel: a.rel }));
      });
      document.querySelectorAll('#sb-foot a[href]').forEach((a) =>
        out.push({ id: 'footer', href: a.getAttribute('href'), target: a.target, rel: a.rel }));
      return out;
    });
    expect(anchors.length).toBeGreaterThanOrEqual(6);
    for (const a of anchors) {
      expect(a.target, `${a.id} → ${a.href}`).toBe('_blank');
      expect(a.rel, `${a.id} → ${a.href}`).toContain('noopener');
    }
  });

  test('§16.10 a social handle or a citation in links{} becomes a same-origin href', async ({ page }) => {
    // SPEC-DEVIATION: §3.3 lists `links{papers[], linkedin, twitter, …}` among
    // the url fields, and says of the one dead link it does guard against that
    // "the card never renders a dead link". But extUrl() assumes an absolute
    // url and only decorates it, so where the payload holds a handle
    // (`@ELLISforEurope`, `dfki`) or a full citation string, the anchor's href
    // is that raw text — a relative path that resolves against the page's own
    // directory. The link is dead, and clicking it navigates the map away
    // instead of opening anything. Five values in the committed payload are
    // affected; the test pins the current behaviour so the fix is visible when
    // it lands.
    await openMap(page);
    const out = await page.evaluate(() => {
      const pick = (id, label) => {
        openEntity(id, { fly: false });
        const dd = [...document.querySelectorAll('#dt-body .dt-facts div')]
          .find((el) => el.querySelector('dt').textContent === label);
        const a = dd && dd.querySelector('a');
        return a && { raw: a.getAttribute('href'), resolved: a.href, text: a.textContent };
      };
      const paper = (id) => {
        openEntity(id, { fly: false });
        const a = document.querySelector('#dt-body .dt-list a');
        return a && { raw: a.getAttribute('href'), resolved: a.href, text: a.textContent };
      };
      return {
        twitter: pick('ellis-society', 'X / Twitter'),
        linkedin: pick('lf-energy', 'LinkedIn'),
        paper: paper('meaningful-human-control'),
        origin: location.origin,
        dir: location.pathname.replace(/[^/]*$/, ''),
      };
    });
    expect(out.twitter.raw).toBe('@ELLISforEurope');
    expect(out.twitter.resolved).toBe(`${out.origin}${out.dir}@ELLISforEurope`);
    expect(out.linkedin.raw).toBe('lf-energy');
    expect(out.linkedin.resolved).toBe(`${out.origin}${out.dir}lf-energy`);
    // A citation is not a url either; extUrl() truncates its *text* at 36
    // characters and puts the whole string in the href.
    expect(out.paper.raw.startsWith('Santoni de Sio')).toBe(true);
    expect(out.paper.text).toBe(out.paper.raw.slice(0, 36) + '…');
    expect(out.paper.resolved.startsWith(out.origin)).toBe(true);
  });

  test('§1 the page boots with every request but its own three files blocked', async ({ page }) => {
    // The offline claim, enforced: anything that is not one of the three files
    // fails outright. If the page depended on a CDN, a font or a tile server,
    // it would not reach first paint here.
    const blocked = [];
    await page.route('**/*', (route) => {
      const p = new URL(route.request().url()).pathname;
      if (ownFiles().includes(p)) return route.continue();
      blocked.push(p);
      return route.abort();
    });
    await openMap(page);
    await settleCounts(page);
    expect(blocked).toEqual([]);
    const s = await snapshot(page);
    expect(s.matchCount).toBeGreaterThan(0);
    // openMap() already waited for a non-empty caption, so "not empty" could
    // not fail here. What is worth asserting is that the caption carries the
    // live figure: the page computed and wrote a count with every request but
    // its own three files refused.
    expect(await page.locator('#st-note').textContent()).toContain(String(s.matchCount));
  });

  test('§1/§2 the page opens straight from disk over file:// and asks for nothing else', async ({ page }, testInfo) => {
    // "It works offline, from file://" — and a file:// origin is also the
    // harshest test of the relative <script src> pair: no server to rewrite
    // paths, no origin to fall back on.
    const seen = recordRequests(page);
    const repo = path.resolve(testInfo.project.testDir, '../..');
    // Derived from MAP_PATH, like every other path here: a mutation run has to
    // boot the page it is mutating off disk, not the committed one next to it.
    const own = ownFiles().map((p) => p.replace(/^.*\//, ''));
    await page.goto(`file://${path.join(repo, MAP_PATH.replace(/^\/+/, ''))}?lang=en`);
    await expect(page.locator('#st-note')).not.toBeEmpty();
    await settleCounts(page);
    expect(seen.map((r) => r.url.replace(/\?.*$/, '').replace(/^.*\/assets\/map\//, '')))
      .toEqual(own);
    for (const r of seen) expect(r.url.startsWith('file://'), r.url).toBe(true);
    // And it is a working map, not just a page that parsed.
    const s = await snapshot(page);
    expect(s.matchCount).toBeGreaterThan(0);
    expect(s.layers).toEqual({ project: true, team: true, commons: true, framework: true });
  });

  test('§16.10 a deep link that opens a card and restores pins still loads three files', async ({ page }) => {
    const seen = recordRequests(page);
    const id = 'lf-energy';   // in the committed payload, and it carries links
    await openMap(page, { lang: 'fr', hash: `#e=${id}&pins=${id}&links=1&yr=2018,2024&nd=0` });
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.focusId).toBe(id);
    expect(s.pins).toBe(1);
    expect(s.links).toBe(true);
    expect(s.years).toEqual({ a: 2018, b: 2024, undated: false });
    expect(paths(seen)).toEqual(ownFiles());
  });

  test('§16.10 a first visit — welcome panel and all — requests nothing extra', async ({ page }) => {
    // openMap() suppresses the welcome overlay, so this boots the page raw: the
    // panel renders four glyphs, the corpus totals and the preset chips, and
    // none of it may reach for anything.
    const seen = recordRequests(page);
    await page.goto(`${MAP_PATH}?lang=en`);
    await expect(page.locator('#st-note')).not.toBeEmpty();
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    await settleCounts(page);
    expect(await page.locator('#wl-rows .wl-row').count()).toBe(5);
    await page.click('#w-explore');
    expect(paths(seen)).toEqual(ownFiles());
  });

  test('§13/§16.10 a private window where localStorage throws still boots, and asks for nothing more', async ({ page }) => {
    // Safari's private mode and Chromium's blocked-site-data mode both make the
    // accessor throw rather than return null. lsGet/lsSet swallow it; what this
    // proves is that nothing downstream of them reaches for a server instead.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('denied', 'SecurityError'); },
      });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    expect(errors).toEqual([]);
    const s = await snapshot(page);
    expect(s.matchCount).toBeGreaterThan(0);
    // The feed's default falls back to the width rule when the store is unreadable.
    expect(await page.evaluate(() => state.feed)).toBe(true);
    // And a pin still works for the session, it just cannot be remembered.
    const id = await page.evaluate(() => { const x = [...state.inView][0]; togglePin(x); return x; });
    expect(await page.evaluate(() => state.pins.size)).toBe(1);
    expect(await page.locator('#pin-list .pin-item').count()).toBe(1);
    // The pin row has to name the entity that was pinned — `toBeTruthy()` on
    // the entity's own name proved only that the payload has names.
    const pinned = await page.evaluate((x) => ({
      row: document.querySelector('#pin-list .pin-item .nm').textContent,
      name: byId[x].d.name,
    }), id);
    expect(pinned.row).toBe(pinned.name);
    expect(paths(seen)).toEqual(ownFiles());
  });

  test('§16.10 at phone width, with the drawer and the floating card, still three files', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const seen = recordRequests(page);
    await openMap(page);
    await settleCounts(page);
    // Below 841px the feed starts closed, so the card is the floating panel —
    // a different rendering path from the desktop tests above.
    expect(await page.evaluate(() => state.feed)).toBe(false);
    // Opened through the element rather than by a real click: at this width the
    // top-right cluster covers the Filters FAB, so a genuine click never lands
    // on it. That defect is pinned in layout.spec.js, "§5 below 840px the
    // cluster's button row swallows taps on the Filters FAB"; here it is only
    // in the way, and what this test is about is that exercising the drawer
    // requests nothing.
    await page.evaluate(() => document.getElementById('sb-open').click());
    await applyPreset(page, 'energy');
    await page.fill('#search', 'grid');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    await page.locator('.sd-item').first().click();
    await expect(page.locator('#detail')).toHaveClass(/open/);
    await page.click('#dt-body .dt-pin');
    await page.click('#dt-close');
    await page.locator('#z-in').dispatchEvent('click');
    await page.locator('#z-fit').dispatchEvent('click');
    await settleCounts(page);
    expect(errors).toEqual([]);
    expect(paths(seen)).toEqual(ownFiles());
  });

  test('§1 no web font is loaded — the stacks are system fonts', async ({ page }) => {
    await openMap(page);
    // An @font-face rule, matched or not, puts a FontFace in document.fonts.
    expect(await page.evaluate(() => document.fonts.size)).toBe(0);
    const fam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(fam).toContain('-apple-system');
  });
});

// =================================================== §1 — static: the file ====

test.describe('§1 no dependencies — what the file itself says', () => {
  test('§2 exactly three scripts: two relative srcs, then one inline classic script', async ({}, testInfo) => {
    const html = pageSource(testInfo);
    const tags = html.match(/<script\b[^>]*>/g) || [];
    expect(tags.length).toBe(3);
    expect(tags[0]).toBe('<script src="hai-data.js">');
    expect(tags[1]).toBe('<script src="europe-geo.js">');
    // The third is bare: no type="module", no defer, no src. The whole test
    // suite depends on it staying a classic script (its top-level bindings are
    // what page.evaluate() reaches), and so does §2's "single document".
    expect(tags[2]).toBe('<script>');
    expect(html).not.toMatch(/type\s*=\s*["']module["']/);
    // Data before logic: the inline script reads window.HAI_DATA at top level.
    expect(html.indexOf('<script src="hai-data.js">')).toBeLessThan(html.lastIndexOf('<script>'));
  });

  test('§1 the markup declares no <link>, <base>, <img>, <iframe> or subresource hint', async ({}, testInfo) => {
    const html = pageSource(testInfo);
    for (const tag of ['link', 'base', 'img', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'track']) {
      expect(html.match(new RegExp(`<${tag}\\b`, 'i')) || [], `<${tag}> must not appear`).toEqual([]);
    }
    // crossorigin / integrity only mean anything for a third-party subresource.
    expect(html).not.toMatch(/\bcrossorigin\b|\bintegrity\s*=/);
  });

  test('§1 no src or href the browser fetches at load time carries a scheme', async ({}, testInfo) => {
    const html = pageSource(testInfo);
    // Every src in the file, markup and template strings alike.
    const srcs = [...html.matchAll(/\bsrc\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]);
    expect(srcs.filter((s) => /^[a-z]+:|^\/\//i.test(s))).toEqual([]);
    expect(srcs.filter((s) => s.startsWith('/') || s.includes('..'))).toEqual([]);
    // The `<img src=x>` inside the escaping tests' own payload is not in the
    // page, so the only srcs left are the two data files.
    expect([...new Set(srcs)].sort()).toEqual(['europe-geo.js', 'hai-data.js']);

    // hrefs: the only absolute ones are prose links in the two footer strings,
    // which a reader clicks — the browser never fetches them.
    const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]);
    const absolute = hrefs.filter((h) => /^[a-z]+:|^\/\//i.test(h));
    expect(absolute).toEqual([
      'https://github.com/marota/eu-hai-collab-map',
      'https://github.com/marota/eu-hai-collab-map',
    ]);
    for (const h of absolute) {
      const idx = html.indexOf(`href="${h}"`);
      expect(html.slice(idx, idx + 200)).toContain('target="_blank"');
    }
  });

  test('§1 the CSS pulls in nothing: no @font-face, no @import, no url()', async ({}, testInfo) => {
    const html = pageSource(testInfo);
    expect(html).not.toMatch(/@font-face/i);
    expect(html).not.toMatch(/@import/i);
    // url() is how a stylesheet reaches for an image, a font or a cursor. The
    // check is on the <style> block alone and case-sensitive: the script below
    // has an extUrl() helper, which is not a CSS function.
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(style.length).toBeGreaterThan(10000);
    expect(style).not.toContain('url(');
    // Also no inline style attribute anywhere reaching for a resource.
    expect(html).not.toMatch(/style\s*=\s*["'][^"']*url\(/i);
  });

  test('§16.10 the inline script names no network API at all', async ({}, testInfo) => {
    const html = pageSource(testInfo);
    const script = html.slice(html.lastIndexOf('<script>'));
    for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
      'new Worker', 'importScripts', 'document.write', 'srcdoc', 'gtag', 'dataLayer']) {
      expect(script.includes(api), `${api} must not appear in the page`).toBe(false);
    }
    // A dynamic import() would fetch at runtime, and would also break the
    // classic-script contract of §2.
    expect(script).not.toMatch(/\bimport\s*\(/);
    expect(script).not.toMatch(/^\s*(import|export)\s/m);
  });

  test('§16.10 the two generated files only assign to window', async ({}, testInfo) => {
    for (const [rel, global] of [['assets/map/hai-data.js', 'window.HAI_DATA'],
      ['assets/map/europe-geo.js', 'window.HAI_GEO']]) {
      const src = repoFile(testInfo, rel);
      expect(src, `${rel} must assign ${global}`).toContain(`${global} = `);
      for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
        'importScripts', 'document.', 'window.location']) {
        expect(src.includes(api), `${rel} must not name ${api}`).toBe(false);
      }
      // Data, not code: no function bodies, no script tags smuggled in strings.
      expect(src).not.toMatch(/<script/i);
      expect(src).not.toMatch(/<\/script/i);
    }
  });
});

// =============================================================== invariant 9 ==

test.describe('invariant 9 — every string interpolated into HTML goes through esc()', () => {
  test('§16.9 esc() escapes the five characters that can break out of markup', async ({ page }) => {
    await openMap(page);
    const out = await page.evaluate(() => ({
      all: esc('&<>"\''),
      // Escaping & first is what stops `&amp;lt;` from decoding back to `<`.
      round: esc('&amp;'),
      plain: esc('Zalgo — Côte d\'Azur'.replace(/'/g, 'x')),
      nul: esc(null),
      undef: esc(undefined),
      zero: esc(0),
    }));
    expect(out.all).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(out.round).toBe('&amp;amp;');
    expect(out.plain).toBe('Zalgo — Côte dxAzur');
    // ?? not ||: an empty string is a legitimate value, and 0 must not vanish.
    expect(out.nul).toBe('');
    expect(out.undef).toBe('');
    expect(out.zero).toBe('0');
  });

  test('§16.9 the injected entity exists, so the escaping tests are not vacuous', async ({ page }) => {
    await openHostile(page);
    const seen = await page.evaluate(([p, f]) => ({
      project: byId[p] ? byId[p].d.name : null,
      framework: byId[f] ? byId[f].d.name : null,
      geo: byId[p].geo,
      noGeo: byId[f].geo,
      marker: !!mkEls[p],
      noMarker: !mkEls[f],
    }), [PROBE, PROBE_FW]);
    expect(seen.project).toBe(HOSTILE_PROJECT.name);
    expect(seen.framework).toBe(HOSTILE_FRAMEWORK.name);
    expect(seen.geo).toBe(true);
    expect(seen.noGeo).toBe(false);
    expect(seen.marker).toBe(true);
    expect(seen.noMarker).toBe(true);
    await expectNoInjection(page, 'at boot, before anything is opened');
  });

  test('§16.9 the card renders a hostile name, place and date literally', async ({ page }) => {
    await openHostile(page);
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE);
    const card = await page.evaluate(() => {
      const h = document.getElementById('dt-body');
      return {
        name: h.querySelector('.dt-name').textContent,
        meta: h.querySelector('.dt-meta').textContent,
        tags: [...h.querySelectorAll('.dt-tag')].map((e) => e.textContent),
        media: h.querySelectorAll('img, iframe, b').length,
      };
    });
    expect(card.name).toBe(HOSTILE_PROJECT.name);
    expect(card.meta).toBe(`${HOSTILE_PROJECT.city}, ${HOSTILE_PROJECT.country} · ${HOSTILE_PROJECT.when}`);
    // A tag is a vocabulary value, so it goes through taxo() first: an unmapped
    // key degrades to its de-underscored form (§3.4). The hazard survives that
    // with its underscores spaced out — and is still text, not markup.
    expect(card.tags).toEqual([deUnderscore(HOSTILE_PROJECT.status)]);
    // `<b>&amp;</b>` in the payload must stay four visible characters of text,
    // not an element — so not even a harmless <b> may appear.
    expect(card.media).toBe(0);
    await expectNoInjection(page, 'the open card');
  });

  test('§16.9 the description keeps its paragraph split and injects nothing (invariant 7: never truncated)', async ({ page }) => {
    await openHostile(page);
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE);
    const paras = await page.evaluate(() =>
      [...document.querySelectorAll('#dt-body .dt-desc')].map((p) => p.textContent));
    // Split on the blank line, each half whole: the split happens before esc(),
    // so a payload that closed a paragraph early would show up as a count.
    expect(paras).toEqual(HOSTILE_PROJECT.desc_en.split('\n\n'));
    await expectNoInjection(page, 'the description');
  });

  test('§16.9 every other card section escapes too: facts, chips, timeline, consortium, list, provenance', async ({ page }) => {
    await openHostile(page);
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE);
    const c = await page.evaluate(() => {
      const h = document.getElementById('dt-body');
      const txt = (sel) => [...h.querySelectorAll(sel)].map((e) => e.textContent);
      return {
        facts: txt('.dt-facts dd'),
        chips: txt('.dt-chip'),
        milestones: txt('.dt-ms li'),
        list: txt('.dt-list li'),
        rel: txt('.rel-row .nm'),
        prov: h.querySelector('.dt-prov').textContent,
        // Every planted hazard string should be visible *as text*. If one
        // interpolation had skipped esc(), its copy would have become an
        // element instead and this count would drop.
        hazards: (h.textContent.match(/<img src=x onerror=/g) || []).length,
      };
    });
    expect(c.facts).toContain(HOSTILE_PROJECT.affiliation.org);
    expect(c.facts).toContain(HOSTILE_PROJECT.affiliation.parent);
    expect(c.facts).toContain(HOSTILE_PROJECT.size);
    // focus[] is vocabulary (taxo → de-underscored); appliesTo[] is free text
    // that chips() de-underscores itself. Either way the hazard stays text.
    expect(c.chips).toContain(deUnderscore(HOSTILE_PROJECT.focus[0]));
    expect(c.chips).toContain(deUnderscore(HOSTILE_PROJECT.appliesTo[0]));
    expect(c.milestones).toEqual([
      HOSTILE_PROJECT.timeline.milestones[0].date + HOSTILE_PROJECT.timeline.milestones[0].label,
    ]);
    expect(c.list).toContain(HOSTILE_PROJECT.facilities[0]);
    expect(c.list.join('|')).toContain(HOSTILE_PROJECT.consortium[0].org);
    expect(c.list.join('|')).toContain(HOSTILE_PROJECT.demos[0].label);
    expect(c.list.join('|')).toContain(HOSTILE_PROJECT.delivs[0].title);
    // relSections reaches into *another* entity's name — the framework that
    // names this project in createdBy / usedBy.
    expect(c.rel).toContain(HOSTILE_FRAMEWORK.name);
    expect(c.prov).toContain(HOSTILE_PROJECT.prov.by);
    expect(c.prov).toContain(HOSTILE_PROJECT.prov.src);
    expect(c.hazards).toBeGreaterThanOrEqual(14);
    await expectNoInjection(page, 'the whole card');
  });

  test('§16.9 a hostile url lands in href verbatim and creates no attribute', async ({ page }) => {
    await openHostile(page);
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE);
    const a = await page.evaluate(() => {
      const el = document.querySelector('#dt-body .dt-actions a.btn');
      return { href: el.getAttribute('href'), attrs: el.getAttributeNames().sort(), title: el.title };
    });
    // The quote-and-tag payload is inside the attribute value, not a second
    // attribute: esc() turned the `"` into &quot; before the parser saw it.
    expect(a.href).toBe(HOSTILE_PROJECT.url);
    expect(a.attrs).toEqual(['class', 'href', 'rel', 'target']);
    await expectNoInjection(page, 'a hostile url in an href');
  });

  test('§16.9 extUrl() escapes all three of its interpolations: the href, the title and the text it truncates', async ({ page }) => {
    // The test above covers the one anchor the card writes by hand. Every other
    // link on the card — official text, documentation, repository, funding
    // page, affiliation, issuer, operator, a demo, a deliverable — comes from
    // extUrl(), which interpolates the url twice and its label once. Three
    // chances to forget esc() in a single two-line helper, and before the
    // hostile payload carried a hostile `links.official` none of them was
    // reachable from a test: the planted entity's only url went to the handmade
    // anchor, so an extUrl() that escaped nothing at all passed the suite.
    await openHostile(page);
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE);
    const a = await page.evaluate(() => {
      const dd = [...document.querySelectorAll('#dt-body .dt-facts div')]
        .find((el) => el.querySelector('dt').textContent === t('f.official'));
      const el = dd && dd.querySelector('a');
      return el && {
        href: el.getAttribute('href'),
        title: el.getAttribute('title'),
        text: el.textContent,
        attrs: el.getAttributeNames().sort(),
        target: el.target,
        rel: el.rel,
        // The anchor's content has to be text, so it has no element children.
        kids: el.children.length,
      };
    });
    expect(a, 'the hostile official link must render').not.toBeNull();
    // The attribute value decodes back to the url it was given: escaped on the
    // way in, verbatim on the way out, ampersand and quote included.
    expect(a.href).toBe(HAZ_URL);
    expect(a.title).toBe(HAZ_URL);
    expect(a.text).toBe(HAZ_URL_TEXT);
    // The literal above is the head of the url and not a transcription slip.
    expect(HAZ_URL).toContain(HAZ_URL_TEXT.slice(0, -1));
    // A `"` that escaped would have closed href or title and opened whatever
    // followed as a second attribute; four is the whole set.
    expect(a.attrs).toEqual(['href', 'rel', 'target', 'title']);
    expect(a.kids, 'the visible text is text, not markup').toBe(0);
    // Same claim as "every anchor leaves the document", at the helper that
    // writes nearly all of them.
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    await expectNoInjection(page, 'a hostile url through extUrl()');
  });

  test('§16.9 the feed row renders it literally', async ({ page }) => {
    await openHostile(page);
    const row = await page.evaluate((id) => {
      const el = document.querySelector(`#fd-list .fd-item[data-id="${CSS.escape(id)}"]`);
      return el && {
        name: el.querySelector('.nm').textContent,
        meta: el.querySelector('.mt').textContent,
        media: el.querySelectorAll('img, b').length,
      };
    }, PROBE);
    expect(row).not.toBeNull();
    expect(row.name).toBe(HOSTILE_PROJECT.name);
    expect(row.meta).toBe(`${HOSTILE_PROJECT.city}, ${HOSTILE_PROJECT.country}`);
    expect(row.media).toBe(0);
    await expectNoInjection(page, 'the feed row');
  });

  test('§16.9 the search result renders it literally', async ({ page }) => {
    await openHostile(page);
    await page.fill('#search', 'zalgo');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    const hit = await page.evaluate(() => {
      const el = document.querySelector('.sd-item');
      return { id: el.dataset.open, name: el.querySelector('.nm').textContent, media: el.querySelectorAll('img, b').length };
    });
    expect(hit.id).toBe(PROBE);
    expect(hit.name).toBe(HOSTILE_PROJECT.name);
    expect(hit.media).toBe(0);
    await expectNoInjection(page, 'the search dropdown');
  });

  test('§16.9 the tooltip renders it literally', async ({ page }) => {
    await openHostile(page);
    // The handler is delegated on #g-markers, so a dispatched pointerover on
    // the marker's own shape exercises exactly the production path without
    // depending on where the marker happens to land on screen.
    await page.evaluate((id) => {
      mkEls[id].querySelector('circle').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    }, PROBE);
    const tt = await page.evaluate(() => ({
      name: document.querySelector('#tooltip .tt-name').textContent,
      meta: document.querySelector('#tooltip .tt-meta').textContent,
      media: document.querySelectorAll('#tooltip img, #tooltip b').length,
      shown: document.getElementById('tooltip').style.display,
    }));
    expect(tt.shown).toBe('block');
    expect(tt.name).toBe(HOSTILE_PROJECT.name);
    expect(tt.meta).toContain(HOSTILE_PROJECT.city);
    expect(tt.media).toBe(0);
    await expectNoInjection(page, 'the tooltip');
  });

  test('§16.9 the marker label escapes, and truncates the name rather than the markup', async ({ page }) => {
    await openHostile(page);
    const lbl = await page.evaluate((id) => {
      const el = mkEls[id].querySelector('.lbl');
      return el && el.textContent;
    }, PROBE);
    // Labels are cut at 34 characters — a cut that lands inside an escaped
    // entity must still render as text, never as a half-open tag.
    expect(lbl).toBe(HOSTILE_PROJECT.name.slice(0, 32) + '…');
    await expectNoInjection(page, 'the marker label');
  });

  test('§16.9 the pin list and the trail crumb render it literally', async ({ page }) => {
    await openHostile(page);
    await page.evaluate((id) => { openEntity(id, { fly: false }); togglePin(id); }, PROBE);
    // A second hop so the first entity becomes a breadcrumb.
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE_FW);
    const out = await page.evaluate(() => ({
      pin: document.querySelector('#pin-list .pin-item .nm').textContent,
      crumb: document.querySelector('#dt-trail .dt-crumb').textContent,
      media: document.querySelectorAll('#pin-list img, #dt-trail img, #pin-list b, #dt-trail b').length,
    }));
    expect(out.pin).toBe(HOSTILE_PROJECT.name);
    expect(out.crumb).toBe(HOSTILE_PROJECT.name);
    expect(out.media).toBe(0);
    await expectNoInjection(page, 'the pin list and the trail');
  });

  test('§16.9 the off-the-map list renders the coordinate-less entity literally (with invariant 3)', async ({ page }) => {
    await openHostile(page);
    const out = await page.evaluate((id) => {
      const el = document.querySelector(`#nogeo-list [data-id="${CSS.escape(id)}"]`);
      return el && { name: el.querySelector('.nm').textContent, media: el.querySelectorAll('img, b').length };
    }, PROBE_FW);
    expect(out).not.toBeNull();
    expect(out.name).toBe(HOSTILE_FRAMEWORK.name);
    expect(out.media).toBe(0);
    await expectNoInjection(page, 'the off-the-map list');
  });

  test('§16.9 the print sheet renders it literally', async ({ page }) => {
    await page.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    await openHostile(page);
    await page.evaluate((id) => { openEntity(id, { fly: false }); togglePin(id); }, PROBE);
    await page.click('#print-btn');
    const sheet = await page.evaluate(() => ({
      name: document.querySelector('#print-sheet .ps-item b').textContent,
      desc: document.querySelector('#print-sheet .ps-item p').textContent,
      href: document.querySelector('#print-sheet .ps-item a').getAttribute('href'),
      media: document.querySelectorAll('#print-sheet img, #print-sheet iframe').length,
      // One <b> per pinned item is the sheet's own markup; a payload-built one
      // would push this past the number of items.
      bolds: document.querySelectorAll('#print-sheet b').length,
      items: document.querySelectorAll('#print-sheet .ps-item').length,
    }));
    expect(sheet.name).toBe(HOSTILE_PROJECT.name);
    expect(sheet.desc).toBe(HOSTILE_PROJECT.desc_en);
    expect(sheet.href).toBe(HOSTILE_PROJECT.url);
    expect(sheet.media).toBe(0);
    expect(sheet.bolds).toBe(sheet.items);
    expect(await page.evaluate(() => window.__pwned ?? 0)).toBe(0);
  });

  test('§16.9 the French rendering escapes the same way (both languages, one esc())', async ({ page }) => {
    await openHostile(page);
    await page.evaluate((id) => openEntity(id, { fly: false }), PROBE);
    await page.click('.lang-switch button[data-lang="fr"]');
    const fr = await page.evaluate(() => ({
      lang: LANG,
      name: document.querySelector('#dt-body .dt-name').textContent,
      paras: [...document.querySelectorAll('#dt-body .dt-desc')].map((p) => p.textContent),
    }));
    expect(fr.lang).toBe('fr');
    expect(fr.name).toBe(HOSTILE_PROJECT.name);
    expect(fr.paras).toEqual(HOSTILE_PROJECT.desc_fr.split('\n\n'));
    await expectNoInjection(page, 'after a language switch');
  });

  test('§16.9 a hostile deep link injects nothing, and leaves every layer off', async ({ page }) => {
    // The URL is reader-supplied input too. applyHash() validates every value
    // against byId / ALL_DOMS / KINDS, so a payload in the hash should reach no
    // interpolation at all — and the `lay=` case lands on the zero-results
    // boundary, since none of the four layer names is in it.
    const q = (s) => encodeURIComponent(s);
    await openMap(page, { hash: `#e=${q(IMG)}&pins=${q(SCR)}&dom=${q(AMP)}&lay=${q(IMG)}` });
    await settleCounts(page);
    const s = await snapshot(page);
    expect(s.focusId).toBeNull();
    expect(s.pins).toBe(0);
    expect(s.layers).toEqual({ project: false, team: false, commons: false, framework: false });
    // An unrecognised domain list falls back to every domain rather than none.
    expect(s.domains.length).toBeGreaterThan(0);
    expect(s.matchCount).toBe(0);
    expect(s.inView).toBe(0);
    const tileSum = await page.evaluate(() =>
      KINDS.reduce((a, k) => a + Number(document.getElementById('st-' + k).textContent), 0));
    expect(tileSum).toBe(0);
    await expectNoInjection(page, 'a hostile hash');
  });

  test('§16.9 a hostile search query injects nothing and lands on the empty state', async ({ page }) => {
    await openMap(page);
    await page.fill('#search', IMG);
    await expect(page.locator('.sd-empty')).toBeVisible();
    const drop = await page.evaluate(() => ({
      text: document.querySelector('.sd-empty').textContent,
      elements: document.querySelectorAll('#search-drop *').length,
      items: document.querySelectorAll('.sd-item').length,
    }));
    // The query is never interpolated back into the dropdown — only the fixed
    // message is — so zero results means exactly one element.
    expect(drop.text).toBe('No matches');
    expect(drop.elements).toBe(1);
    expect(drop.items).toBe(0);
    await expectNoInjection(page, 'a hostile search query');
  });

  test('§16.9 a full exercise of the interface on a hostile payload builds nothing', async ({ page }) => {
    // The per-surface tests above each open one thing. This one drives the
    // interface the way the invariant-10 test does, so that any surface not
    // enumerated above still has to survive the payload.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openHostile(page);
    await applyPreset(page, 'energy');
    await applyPreset(page, 'overview');
    await setLayers(page, ['framework']);
    await setLayers(page, ['project', 'team', 'commons', 'framework']);
    await setPeriod(page, 2019, 2024);
    await page.fill('#search', 'zalgo');
    await expect(page.locator('.sd-item').first()).toBeVisible();
    await page.locator('.sd-item').first().click();
    await page.click('.fd-card .dt-pin');
    await page.click('#mymap-pill');
    await page.click('#links-pill');
    await page.click('#help-btn');
    await page.click('#w-explore');
    await page.click('.lang-switch button[data-lang="fr"]');
    await page.click('.lang-switch button[data-lang="en"]');
    await settleCounts(page);
    await expectNoInjection(page, 'after exercising everything');
    expect(errors).toEqual([]);
  });

  test('§16.9 the one innerHTML built from a plain value is a translated constant, not data', async ({}, testInfo) => {
    // #sb-foot takes t('footer') as raw HTML because the footer carries a link.
    // That is sound only as long as the string is an I18N constant — the moment
    // a payload value reaches it, invariant 9 is gone. So pin down the shape of
    // every innerHTML assignment in the file: each one is either a template
    // literal (or a .map() of one, which is where the esc() calls live), the
    // card builder, or that single constant.
    const html = pageSource(testInfo);
    const raw = [...html.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
    expect(raw.length).toBe(20);
    const plain = raw.filter((r) => !r.startsWith('`') && !r.includes('.map('));
    expect(plain).toEqual(['cardHtml(it)', "t('footer')"]);
  });

  test('§16.9 the footer\'s raw HTML is one link, in both languages', async ({ page }) => {
    await openMap(page);
    const read = () => page.evaluate(() => ({
      lang: LANG,
      anchors: [...document.querySelectorAll('#sb-foot a')].map((a) => ({
        href: a.getAttribute('href'), target: a.target, rel: a.rel })),
      elements: document.querySelectorAll('#sb-foot *').length,
    }));
    const en = await read();
    expect(en.lang).toBe('en');
    expect(en.anchors).toEqual([{ href: 'https://github.com/marota/eu-hai-collab-map', target: '_blank', rel: 'noopener' }]);
    expect(en.elements, 'one anchor and nothing else').toBe(1);
    await page.click('.lang-switch button[data-lang="fr"]');
    const fr = await read();
    expect(fr.lang).toBe('fr');
    expect(fr.anchors).toEqual(en.anchors);
    expect(fr.elements).toBe(1);
  });

  test('§16.9 the three interpolations that skip esc() carry no escapable character', async ({ page }) => {
    // SPEC-DEVIATION: invariant 9 says *every* string interpolated into HTML
    // goes through esc(); three do not — the country outlines' path data, the
    // graticule's, and the capital labels. None of them is payload: two are
    // generated geometry from europe-geo.js and one is a hard-coded table in
    // the page. So the exception is safe by data rather than by construction,
    // which is exactly what this test holds in place: if a future geo build or
    // a new capital ever carried an ampersand or a quote, it would fail here
    // rather than in the DOM.
    await openMap(page);
    const bad = await page.evaluate(() => ({
      countries: GEO.countries.filter((c) => /[&<>"']/.test(c.d)).map((c) => c.d.slice(0, 40)),
      grat: GEO.grat.filter((d) => /[&<>"']/.test(d)).length,
      capitals: CAPITALS.filter((c) => /[&<>"']/.test(c[0])).map((c) => c[0]),
      drawn: document.querySelectorAll('#g-countries path.country').length,
      caps: document.querySelectorAll('#g-caps .cap').length,
    }));
    expect(bad.countries).toEqual([]);
    expect(bad.grat).toBe(0);
    expect(bad.capitals).toEqual([]);
    // And the geometry did render, so the check is not passing on an empty set.
    expect(bad.drawn).toBe(await page.evaluate(() => GEO.countries.length));
    expect(bad.caps).toBe(20);
  });
});

// ================================================== §15 — performance claims ==

test.describe('§15 performance', () => {
  test('§15 a burst of view changes collapses into exactly one in-view recount', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    await instrument(page);
    const burst = await page.evaluate(() => {
      const before = window.__n.recount;
      // Synchronous: no timer can fire in the middle of this loop, so what it
      // measures is the debounce's guard, not a race.
      for (let i = 0; i < 25; i++) setView({ k: view.k, x: view.x + 1, y: view.y }, false);
      return { during: window.__n.recount - before, frames: window.__n.frame, pending: ivTimer !== null };
    });
    expect(burst.frames, '25 view changes paint 25 times').toBe(25);
    expect(burst.during, 'and recount none of them inline').toBe(0);
    expect(burst.pending, 'one timer is armed').toBe(true);
    await settleCounts(page);
    expect((await counters(page)).recount, '25 frames, one recount').toBe(1);
  });

  test('§15 the recount waits ~90 ms rather than running inline', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const dt = await page.evaluate(() => new Promise((resolve) => {
      const orig = window.renderStats;
      const t0 = performance.now();
      window.renderStats = function () {
        window.renderStats = orig;
        resolve(performance.now() - t0);
        return orig.apply(this, arguments);
      };
      setView({ k: view.k, x: view.x + 5, y: view.y }, false);
    }));
    // A timer never fires early, so the floor pins the documented 90 ms; the
    // ceiling is loose on purpose — it only has to fail a debounce that is off
    // by an order of magnitude, or one that never fires at all.
    expect(dt).toBeGreaterThanOrEqual(85);
    expect(dt).toBeLessThan(1500);
  });

  test('§15 the debounce is armed at exactly 90 ms, and a second view change arms no second timer', async ({ page }) => {
    // The wall-clock test above can only hold a floor honestly: a timer never
    // fires early, but a loaded machine makes any ceiling either flaky or so
    // loose that a debounce raised to half a second sails straight through it —
    // it did. The delay is not a measurement, though. It is an argument, and an
    // argument can be read exactly. §15 names 90 ms; a counter that lags longer
    // leaves the reader looking at a stale number after the map has stopped.
    await openMap(page);
    await settleCounts(page);
    const armed = await page.evaluate(() => {
      const real = window.setTimeout;
      const delays = [];
      window.setTimeout = function (fn, ms, ...rest) { delays.push(ms); return real.call(window, fn, ms, ...rest); };
      try {
        setView({ k: view.k, x: view.x + 7, y: view.y }, false);
        // While one is pending, scheduleInView() must return without arming
        // another — the leading-edge guard, read as a count of timers.
        setView({ k: view.k, x: view.x + 9, y: view.y }, false);
      } finally { window.setTimeout = real; }
      return delays;
    });
    expect(armed, 'one timer, at the documented 90 ms').toEqual([90]);
    await settleCounts(page);
  });

  test('§15 the reader sees no half-counted state mid-burst: the caption changes once, after the timer', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const before = await page.locator('#st-note').textContent();
    const mid = await page.evaluate(() => {
      // Pan the whole of Europe off the stage: the counts must really change,
      // or this test would pass on a caption that never updates.
      for (let i = 0; i < 10; i++) setView({ k: view.k, x: view.x - 20000, y: view.y }, false);
      return { note: document.getElementById('st-note').textContent, tiles: KINDS.reduce((a, k) => a + Number(document.getElementById('st-' + k).textContent), 0) };
    });
    expect(mid.note, 'unchanged while the debounce is pending').toBe(before);
    expect(mid.tiles).toBeGreaterThan(0);
    await settleCounts(page);
    const after = await page.evaluate(() => ({
      note: document.getElementById('st-note').textContent,
      tiles: KINDS.reduce((a, k) => a + Number(document.getElementById('st-' + k).textContent), 0),
      inView: state.inView.size,
    }));
    expect(after.tiles).toBe(0);
    expect(after.inView).toBe(0);
    expect(after.note).not.toBe(before);
  });

  test('§15 refresh() does not run per animation frame', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openMap(page);
    await settleCounts(page);
    expect(await page.evaluate(() => reduceMotion), 'the animated path is the one under test').toBe(false);
    await instrument(page);
    await page.evaluate(() => setView({ k: view.k * 2.5, x: view.x - 220, y: view.y - 140 }, true));
    // Each frame repaints the transform and arms the debounce; none of them may
    // redo the filter pass over 449 entities and 352 edges.
    await page.waitForFunction(() => window.__n.frame >= 5);
    expect((await counters(page)).refresh, 'mid-animation').toBe(0);
    await settleCounts(page);
    const end = await counters(page);
    expect(end.refresh, 'and not at the end of it either').toBe(0);
    expect(end.frame).toBeGreaterThanOrEqual(5);
    expect(end.recount).toBeGreaterThanOrEqual(1);
  });

  test('§15 the per-marker counter-scale pass is skipped when the scale did not change', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    // A sentinel is the only honest probe here: the pass rewrites every
    // marker's transform to the same value it already had whenever k is
    // unchanged, so only an out-of-band value can tell "ran" from "skipped".
    const panned = await page.evaluate(() => {
      const id = Object.keys(mkEls)[0];
      mkEls[id].setAttribute('transform', 'SENTINEL');
      const k = lastK;
      setView({ k: view.k, x: view.x + 40, y: view.y + 20 }, false);   // pure pan
      return { t: mkEls[id].getAttribute('transform'), lastKHeld: lastK === k, world: worldG.getAttribute('transform') };
    });
    expect(panned.t, 'a pan must not touch 438 markers').toBe('SENTINEL');
    expect(panned.lastKHeld).toBe(true);
    // The pan itself did happen — it is one attribute on the world group.
    expect(panned.world).toMatch(/^translate\(/);

    const tiny = await page.evaluate(() => {
      const id = Object.keys(mkEls)[0];
      const k = lastK;
      setView({ k: view.k * 1.0005, x: view.x, y: view.y }, false);    // under the 0.1% threshold
      return { t: mkEls[id].getAttribute('transform'), lastKHeld: lastK === k };
    });
    expect(tiny.t, 'nor a scale change too small to see').toBe('SENTINEL');
    expect(tiny.lastKHeld).toBe(true);

    const zoomed = await page.evaluate(() => {
      const id = Object.keys(mkEls)[0];
      setView({ k: view.k * 1.4, x: view.x, y: view.y }, false);       // a real zoom
      return { t: mkEls[id].getAttribute('transform'), lastK, k: view.k };
    });
    expect(zoomed.t, 'but a real zoom must').toMatch(/^translate\([-\d.]+,[-\d.]+\) scale\([\d.]+\)$/);
    expect(zoomed.lastK, 'and the pass records the scale it ran at').toBe(zoomed.k);
    await settleCounts(page);
  });

  test('§15 "only when the scale actually changed" means 0.1%, not "only on a big zoom"', async ({ page }) => {
    // The test above pins one end of the guard: a pan and a 0.05% nudge are
    // skipped, a 40% zoom runs. That leaves the tolerance itself free, and the
    // tolerance is the whole claim — markers are drawn at 1/k and corrected by
    // this pass, so a scale change the guard ignores is 438 markers left at the
    // wrong screen size until the next big zoom. The wheel handler multiplies
    // by 1.0016^-deltaY, so one notch of a trackpad is a few tenths of a
    // percent: exactly the range a loosened bound would swallow. 0.1% is the
    // documented figure, so this holds the other end of it.
    await openMap(page);
    await settleCounts(page);
    const out = await page.evaluate(() => {
      const id = Object.keys(mkEls)[0];
      const res = {};
      // Both steps are measured from `lastK`, the scale the pass last ran at,
      // which is what the guard compares against.
      mkEls[id].setAttribute('transform', 'SENTINEL');
      setView({ k: lastK * 1.0005, x: view.x, y: view.y }, false);
      res.under = mkEls[id].getAttribute('transform');
      setView({ k: lastK * 1.0015, x: view.x, y: view.y }, false);
      res.over = mkEls[id].getAttribute('transform');
      res.lastK = lastK;
      res.k = view.k;
      return res;
    });
    expect(out.under, '0.05% is below the tolerance and is skipped').toBe('SENTINEL');
    expect(out.over, '0.15% is above it and must rescale every marker')
      .toMatch(/^translate\([-\d.]+,[-\d.]+\) scale\([\d.]+\)$/);
    expect(out.lastK, 'and the run records the scale it ran at').toBe(out.k);
    await settleCounts(page);
  });

  test('§15 markers are built once: filtering toggles display, it never rebuilds the DOM', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    // The expected count comes from the payload, not from the page's own
    // `items`: an entity with coordinates gets a marker, one without does not
    // (invariant 3).
    const placed = await page.evaluate(() =>
      [...DATA.PROJECTS, ...DATA.COMMONS, ...DATA.TEAMS, ...DATA.FRAMEWORKS]
        .filter((d) => d.lat != null && d.lon != null).length);
    expect(await page.evaluate(() => { window.__mk = [...gMarkers.querySelectorAll('.mk')]; return window.__mk.length; }))
      .toBe(placed);

    await setLayers(page, []);
    const off = await page.evaluate(() => ({
      hidden: window.__mk.every((el) => el.style.display === 'none'),
      same: [...gMarkers.querySelectorAll('.mk')].every((el, i) => el === window.__mk[i]),
      count: gMarkers.querySelectorAll('.mk').length,
    }));
    expect(off.hidden, 'every layer off hides every marker').toBe(true);
    expect(off.same, 'by display, not by deletion').toBe(true);
    expect(off.count).toBe(placed);

    await setLayers(page, ['project', 'team', 'commons', 'framework']);
    await applyPreset(page, 'energy');
    await setPeriod(page, 2010, 2015);
    await applyPreset(page, 'overview');
    await settleCounts(page);
    const end = await page.evaluate(() => ({
      same: [...gMarkers.querySelectorAll('.mk')].every((el, i) => el === window.__mk[i]),
      count: gMarkers.querySelectorAll('.mk').length,
      shown: window.__mk.filter((el) => el.style.display !== 'none').length,
    }));
    expect(end.same, 'the same nodes after every filter axis has moved').toBe(true);
    expect(end.count).toBe(placed);
    expect(end.shown).toBe(placed);
  });

  test('§15 edges are built once too, and their count follows the payload', async ({ page }) => {
    await openMap(page);
    // Derived from DATA rather than from `edges`: one path per relation whose
    // two ends are both placed on the map.
    const expected = await page.evaluate(() => {
      const all = [...DATA.PROJECTS, ...DATA.COMMONS, ...DATA.TEAMS, ...DATA.FRAMEWORKS];
      const placed = new Map(all.map((d) => [d.id, d.lat != null && d.lon != null]));
      const both = (a, b) => placed.has(a) && placed.has(b) && placed.get(a) && placed.get(b);
      let n = 0;
      DATA.EDGES.forEach((e) => { if (placed.has(e.project) && both(e.project, e.team)) n++; });
      [...DATA.COMMONS, ...DATA.FRAMEWORKS].forEach((a) => {
        (a.createdBy || []).forEach((u) => { if (both(u, a.id)) n++; });
        (a.usedBy || []).forEach((u) => { if (both(a.id, u)) n++; });
      });
      return n;
    });
    const drawn = await page.evaluate(() => {
      window.__ed = [...gEdges.querySelectorAll('path.edge')];
      return { count: window.__ed.length, total: edges.length };
    });
    expect(drawn.count).toBe(expected);
    expect(drawn.total).toBe(expected);

    await page.click('#links-pill');
    await setLayers(page, ['team']);
    await setLayers(page, ['project', 'team', 'commons', 'framework']);
    await settleCounts(page);
    const after = await page.evaluate(() => ({
      same: [...gEdges.querySelectorAll('path.edge')].every((el, i) => el === window.__ed[i]),
      count: gEdges.querySelectorAll('path.edge').length,
      on: window.__ed.filter((el) => el.classList.contains('on')).length,
    }));
    expect(after.same, 'toggling the graph must not rebuild 352 paths').toBe(true);
    expect(after.count).toBe(expected);
    expect(after.on, 'the graph is on, so some are drawn').toBeGreaterThan(0);
  });

  test('§15 the map SVG is static: its node count does not move when the filters do', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const nodes = () => page.evaluate(() => document.querySelectorAll('#world *').length);
    const before = await nodes();
    expect(before).toBeGreaterThan(1000);
    await applyPreset(page, 'health');
    await setPeriod(page, 2022, 2024);
    await setLayers(page, ['commons']);
    await page.click('#links-pill');
    await settleCounts(page);
    expect(await nodes(), 'no node is added or removed by filtering').toBe(before);
    await page.click('#reset-btn');
    await settleCounts(page);
    expect(await nodes()).toBe(before);
  });

  test('§15 the feed\'s render key skips the DOM write when nothing changed', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const out = await page.evaluate(() => {
      const first = document.querySelector('#fd-list .fd-item');
      first.__probe = 1;
      const key = feedKey;
      refresh(); refresh(); refresh();
      const now = document.querySelector('#fd-list .fd-item');
      return { same: now === first, probe: now.__probe === 1, keySame: feedKey === key, keyEmpty: key === '' };
    });
    expect(out.keyEmpty, 'the key is set after first paint').toBe(false);
    expect(out.keySame).toBe(true);
    expect(out.same, 'three refreshes, no rebuild').toBe(true);
    expect(out.probe).toBe(true);
  });

  test('§15 the render key is exactly the four things the rows depend on', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const id = await page.evaluate(() => [...state.inView][0]);
    await page.evaluate((x) => { openEntity(x, { fly: false }); togglePin(x); }, id);
    await settleCounts(page);
    const parts = await page.evaluate(() => feedKey.split('|'));
    const s = await snapshot(page);
    expect(parts.length, 'ids | focus | language | pins').toBe(4);
    expect(parts[0].split(',').length, 'one id per row in view').toBe(s.inView);
    expect(parts[1]).toBe(id);
    expect(parts[2]).toBe('en');
    expect(parts[3]).toBe(id);
    // The rows really are the ids in the key.
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#fd-list .fd-item')].map((el) => el.dataset.id).join(','));
    expect(rows).toBe(parts[0]);
  });

  test('§15 repeated refreshes do not grow the document', async ({ page }) => {
    // The cheapest regression guard there is for "it never rebuilds the DOM":
    // an append where a replace was meant shows up as a document that grows
    // every time the reader touches a filter.
    await openMap(page);
    await settleCounts(page);
    const count = () => page.evaluate(() => document.getElementsByTagName('*').length);
    const before = await count();
    await page.evaluate(() => { for (let i = 0; i < 20; i++) refresh(); });
    expect(await count()).toBe(before);
    const id = await page.evaluate(() => [...state.inView][0]);
    await page.evaluate((x) => { openEntity(x, { fly: false }); }, id);
    const withCard = await count();
    expect(withCard).toBeGreaterThan(before);
    await page.evaluate(() => { for (let i = 0; i < 20; i++) refresh(); });
    expect(await count(), 'a card renders once, not once per refresh').toBe(withCard);
  });

  test('§15 the key covers the focus, the language and the pins — each forces the rebuild it needs', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const probe = () => page.evaluate(() => {
      const el = document.querySelector('#fd-list .fd-item');
      const was = el.__probe === 1;
      el.__probe = 1;
      return { was, key: feedKey };
    });
    await probe();
    // Focus: the open card is rendered *into* the feed row, so the key must move.
    const id = await page.evaluate(() => [...state.inView][0]);
    await page.evaluate((x) => openEntity(x, { fly: false }), id);
    let r = await probe();
    expect(r.was, 'a new focus rebuilds the list').toBe(false);
    // Language: every row's label and its embedded card are translated.
    await page.click('.lang-switch button[data-lang="fr"]');
    r = await probe();
    expect(r.was, 'a language switch rebuilds the list').toBe(false);
    // Pins: the embedded card's button reads Pin or Unpin.
    await page.evaluate((x) => togglePin(x), id);
    r = await probe();
    expect(r.was, 'pinning rebuilds the list').toBe(false);
    // And a no-op refresh still does not.
    await page.evaluate(() => refresh());
    r = await probe();
    expect(r.was, 'but an unchanged key still skips').toBe(true);
  });

  test('§15 a hidden feed is not rendered at all, and reopening it clears the key', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    expect(await page.evaluate(() => state.feed), 'the feed is open at desktop width').toBe(true);
    await page.evaluate(() => { document.querySelector('#fd-list .fd-item').__probe = 1; });
    await page.click('#feed-pill');
    await settleCounts(page);
    const closed = await page.evaluate(() => ({
      feed: state.feed,
      key: feedKey,
      probe: document.querySelector('#fd-list .fd-item').__probe === 1,
    }));
    expect(closed.feed).toBe(false);
    // setFeed() blanks the key precisely so that the list cannot come back
    // stale after being hidden while the filters moved.
    expect(closed.key).toBe('');
    expect(closed.probe, 'while hidden, nothing is written to it').toBe(true);

    await applyPreset(page, 'energy');
    await page.click('#feed-pill');
    await settleCounts(page);
    const reopened = await page.evaluate(() => ({
      probe: document.querySelector('#fd-list .fd-item').__probe === 1,
      key: feedKey,
      rows: document.querySelectorAll('#fd-list .fd-item').length,
      inView: state.inView.size,
    }));
    expect(reopened.probe, 'reopening re-renders').toBe(false);
    expect(reopened.key).not.toBe('');
    expect(reopened.rows).toBe(reopened.inView);
  });

  test('§15 cards are rendered on demand, one at a time', async ({ page }) => {
    await openMap(page);
    await settleCounts(page);
    const cards = () => page.evaluate(() => ({
      names: [...document.querySelectorAll('.dt-name')].map((e) => e.textContent),
      feedCards: document.querySelectorAll('.fd-card').length,
      panelOpen: document.getElementById('detail').classList.contains('open'),
    }));
    expect(await cards(), 'nothing is rendered before a selection')
      .toEqual({ names: [], feedCards: 0, panelOpen: false });

    const [a, b] = await page.evaluate(() => [...state.inView].slice(0, 2));
    const nameOf = (id) => page.evaluate((x) => byId[x].d.name, id);

    await page.evaluate((x) => openEntity(x, { fly: false }), a);
    let c = await cards();
    // Invariant 5: the panel and the feed render the same card from the same
    // function, so an open entity is two nodes and never more.
    expect(c.names).toEqual([await nameOf(a), await nameOf(a)]);
    expect(c.feedCards).toBe(1);
    expect(c.panelOpen).toBe(true);

    await page.evaluate((x) => openEntity(x, { fly: false }), b);
    c = await cards();
    expect(c.names).toEqual([await nameOf(b), await nameOf(b)]);
    expect(c.feedCards).toBe(1);

    // Clicking the open row is how a reader closes a card with the feed open —
    // the floating panel is display:none at this width.
    await page.click('#fd-list .fd-item.open .fd-row');
    await settleCounts(page);
    c = await cards();
    // Closing the panel drops the feed's copy and hides the panel; the panel
    // keeps its last card in the DOM rather than clearing it, which is still
    // one card, not a pile.
    expect(c.feedCards).toBe(0);
    expect(c.panelOpen).toBe(false);
    expect(c.names).toEqual([await nameOf(b)]);
  });
});
