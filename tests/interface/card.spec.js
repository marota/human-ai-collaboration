// The card and the navigation through it — spec §7, §8, invariants 5 and 7.
//
// Two things make this area worth testing hard. The first is that one function,
// `cardHtml()`, feeds two surfaces (the floating panel and the feed), so a
// regression that only touches one of them is invisible in the surface the
// author happened to be looking at — invariant 5 exists because that drift is
// easy. The second is that the card is where the map's traversal commitment
// (§1) collides with its filter state: the related-entity counts are
// deliberately *not* filtered, which looks like the stale-count bug §9.1
// forbids and must never be "fixed" into one. Those tests say so out loud.
import { test, expect } from '@playwright/test';
import { openMap, snapshot, openViaSearch } from './_map.js';

// ---------------------------------------------------------------- fixtures
// Entities chosen for what they exercise, not for being typical. Each test that
// leans on a property of one of them re-asserts that property from the payload,
// so a data regeneration that moves the ground under a test says so instead of
// silently testing something else.
const PROJECT = 'ai4realnet';                 // 17 consortium rows (16 renamed, 1 not), funding in €, 21+4 neighbours
const TEAM = 'rte-rd-grid-ai';                // the only shape with all three related sections
const COMMONS = 'citylearn';                  // no coordinates, no consortium, no related rows
const FRAMEWORK = 'iso-9241-210';             // no coordinates, jurisdiction + issuing body
const LONG_EN = 'ifac-tc41-human-machine-systems';  // longest English description in the payload
const LONG_FR = 'euroguard';                  // longest French one
const PARAS = 'epri-europe';                  // two paragraphs, and a description only under `desc`
const SOFT_HOST = 'arcelormittal-rd';         // start year is the host institution's
const SOFT_LOW = 'canal-isabel-ii';           // start year is an estimate, no host
const PAPERS_ONLY = 'grid2op';                // Publications but nothing for "Other links"
const STANDARD = 'eu-ai-act';                 // the only identity shape with all four of §8 item 6's framework fields
const ONE_REL = 'openstef';                   // exactly one neighbour, in exactly one role

// The card surfaces. With the feed open — the default above 840px — the
// floating panel is display:none (`body.feed-open #detail`), but it is still
// rendered: invariant 5 is about the markup, not about which one is on screen.
const PANEL = '#dt-body';
const FEED_CARD = '.fd-item.open .fd-card';

// §8's section order, in English, as the spec lists it. Hard-coded rather than
// read back out of I18N so that a renamed label fails here instead of passing
// against itself.
const SEC_ORDER = ['Focus areas', 'Timeline', 'Consortium', 'Funding', 'Infrastructure',
  'Demonstrators', 'Deliverables', 'Facilities hosted', 'Applies to', 'Builds on',
  'Publications', 'Other links'];
const REL_ORDER = ['Consortium teams', 'Projects & programmes', 'Created', 'Builds on',
  'Created by', 'Used by'];
const CANON = [...SEC_ORDER, ...REL_ORDER];

// §8 item 6's ten identity fields, in the order the spec lists them, with the
// payload field each one reads. Hard-coded for the same reason as SEC_ORDER —
// and kept as a list rather than as one fixture's expectations because the two
// cards that pin exact rows below (a framework, a piece of software) between
// them cover six of the ten, which leaves the rest free to be dropped or
// reordered without anything going red.
const FACT_ORDER = [
  ['Affiliation', d => d.affiliation && d.affiliation.org && d.affiliation.org !== d.name],
  ['Parent body', d => !!(d.affiliation && d.affiliation.parent)],
  ['Jurisdiction', d => !!d.jurisdiction],
  ['Issuing body', d => !!d.issuer],
  ['Legal status', d => !!d.legal],
  ['Adopted', d => !!d.adopted],
  ['Licence', d => !!d.license],
  ['Maintainer', d => !!d.maintainer],
  ['Repository', d => !!(d.repo && d.repo !== d.url)],
  ['Reach', d => !!d.size],
];

// Markup in every string field of a synthetic entity. No entry in the payload
// carries any, which is exactly why invariant 9 is easy to break quietly: a
// name holding a bare "&" survives the parser and comes back out of innerHTML
// as "&amp;" whether the page escaped it or not, so the ampersand test at the
// bottom of this file cannot tell an escaped heading from a raw one. A hostile
// entity can — a dropped esc() puts a <b> element in the card.
const HOSTILE = '<b>x</b>&"\'';

// ---------------------------------------------------------------- helpers
/** Open a card through the page's own entry point. */
const open = (page, id, opts = {}) =>
  page.evaluate(([i, o]) => openEntity(i, o), [id, opts]);

/** Hide the feed so the floating panel is the visible surface. Do this before
 *  opening a card: `body.detail-open .ctl-tr` hides the pill afterwards. */
async function hideFeed(page) {
  await page.click('#feed-pill');
  await expect(page.locator('#feed')).toBeHidden();
  await expect(page.locator('#detail')).toBeHidden();   // nothing open yet
}

/** The section headings of a card, in render order, counts stripped. */
const sections = (page, root = PANEL) =>
  page.$$eval(`${root} .dt-sec h4`, hs => hs.map(h => {
    const em = h.querySelector('em');
    return em ? h.textContent.replace(em.textContent, '').trim() : h.textContent.trim();
  }));

/** Heading → count, for the related sections (the ones carrying an <em>). */
const relCounts = (page, root = PANEL) =>
  page.$$eval(`${root} .dt-sec h4`, hs => {
    const o = {};
    hs.forEach(h => { const em = h.querySelector('em');
      if (em) o[h.textContent.replace(em.textContent, '').trim()] = Number(em.textContent); });
    return o;
  });

/** The facts grid as label → value text. */
const factRows = (page, root = PANEL) =>
  page.$$eval(`${root} .dt-facts > div`, ds => {
    const o = {};
    ds.forEach(d => { o[d.querySelector('dt').textContent] = d.querySelector('dd').textContent; });
    return o;
  });

/** The identity grid only — the `<dl>` that is a direct child of the card root,
 *  as opposed to the ones inside the Funding, Infrastructure and Other-links
 *  sections, which `factRows(page)` would also sweep up. */
const identityRows = (page, root = PANEL) =>
  page.$$eval(`${root} > .dt-facts > div`, ds => ds.map(d =>
    [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));

/** An entity with markup in every string the card interpolates, and a full set
 *  of §8 item 6's identity fields. Built here and passed in, so the page sees
 *  it as data rather than as something it helped construct. */
const hostileEntity = (bad) => ({
  id: 'synthetic-hostile', kind: 'commons', domains: ['multi', `${bad} dom`],
  d: {
    id: 'synthetic-hostile', name: `${bad} name`, city: `${bad} city`, country: `${bad} cc`,
    when: `${bad} when`, desc: `${bad} desc`, url: `https://example.org/?q=${bad}`,
    kind: `${bad} kind`, status: `${bad} status`, tier: `${bad} tier`,
    affiliation: { org: `${bad} org`, parent: `${bad} parent` },
    jurisdiction: `${bad} juris`, issuer: { org: `${bad} issuer` },
    legal: `${bad} legal`, adopted: `${bad} adopted`, license: `${bad} licence`,
    maintainer: { org: `${bad} maintainer` }, repo: 'https://example.org/repo', size: `${bad} reach`,
    focus: [`${bad} focus`], appliesTo: [`${bad} applies`],
    timeline: { start: `${bad} start`, end: `${bad} end`, milestones: [{ date: `${bad} date`, label: `${bad} ms` }] },
    consortium: [{ org: `${bad} partner`, role: `${bad} role`, country: `${bad} ct` }],
    funding: { source: `${bad} source`, call: `${bad} call`, grant: `${bad} grant` },
    infra: { kind: `${bad} infra`, operator: { org: `${bad} operator` }, access: `${bad} access`, capacity: `${bad} capacity` },
    demos: [{ label: `${bad} demo` }], delivs: [{ title: `${bad} deliv` }],
    facilities: [`${bad} facility`], links: { official: 'https://example.org/o' },
    prov: { by: `${bad} by`, upd: `${bad} upd`, conf: `${bad} conf`, src: `${bad} src` },
  },
});

/** Adjacency rebuilt from the payload, so that what a card *should* list does
 *  not come from the same `neighbors` map the card reads it from. */
const neighboursFromData = (page, id) => page.evaluate((x) => {
  const known = new Set([...DATA.PROJECTS, ...DATA.TEAMS, ...DATA.COMMONS, ...DATA.FRAMEWORKS].map(d => d.id));
  const out = new Set();
  const add = i => { if (known.has(i)) out.add(i); };
  if (!known.has(x)) return [];
  DATA.EDGES.forEach(e => {
    if (!known.has(e.project)) return;                 // the page skips these too
    if (e.project === x) add(e.team);
    else if (e.team === x) add(e.project);
  });
  [...DATA.COMMONS, ...DATA.FRAMEWORKS].forEach(a => {
    const ends = [...(a.createdBy || []), ...(a.usedBy || [])];
    if (ends.includes(x)) add(a.id);
    if (a.id === x) ends.forEach(add);
  });
  return [...out];
}, id);

/** Every domain checkbox off: the hardest narrowing the interface allows. */
async function unfilterNothing(page) {
  const none = page.locator('#domain-groups [data-ga="none"]');
  for (let i = 0; i < await none.count(); i++) await none.nth(i).click();
  expect((await snapshot(page)).domains).toHaveLength(0);
}

/** Scan the stage for a point where the map itself is the topmost element, and
 *  one where a marker is. A scan rather than a hand-picked coordinate: the
 *  point has to be empty *with the card open*, which is when it is clicked. */
const findPoint = (page, wantMarker) => page.evaluate((marker) => {
  for (let y = 40; y < 700; y += 6) for (let x = 320; x < 930; x += 6) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !hit.closest('#map')) continue;
    const mk = hit.closest('.mk');
    if (marker ? mk : !mk) return { x, y, id: mk ? mk.dataset.id : null };
  }
  return null;
}, wantMarker);

const history = (page) => page.evaluate(() => ({ ids: [...state.history], i: state.hIndex }));
const crumbs = (page) => page.$$eval('#dt-trail .dt-crumb', bs => bs.map(b => b.textContent));

// =========================================================================
test.describe('invariant 5 — the panel and the feed render the same card', () => {
  // The two surfaces are built from one function precisely so they cannot
  // drift; the only way to test that is to compare the bytes.
  test('inv5 the floating panel and the feed hold byte-identical markup', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });

    const panel = await page.locator(PANEL).innerHTML();
    const feed = await page.locator(FEED_CARD).innerHTML();
    expect(panel).toBe(feed);
    expect(panel).toContain('AI4RealNet');

    // …and both are what cardHtml() returns for that entity, parsed once.
    const fresh = await page.evaluate((id) => {
      const d = document.createElement('div');
      d.innerHTML = cardHtml(byId[id]);
      return d.innerHTML;
    }, PROJECT);
    expect(panel).toBe(fresh);
  });

  test('inv5 holds for an entity the feed has to unshift, having no marker', async ({ page }) => {
    // §3.3 / invariant 3: no coordinates means no marker, so it can never be
    // "in view" — the feed prepends the open card instead of dropping it.
    await openMap(page);
    await open(page, FRAMEWORK, { fly: false });
    expect(await page.evaluate((id) => state.inView.has(id), FRAMEWORK)).toBe(false);
    expect(await page.evaluate((id) => byId[id].geo, FRAMEWORK)).toBe(false);

    expect(await page.locator(PANEL).innerHTML()).toBe(await page.locator(FEED_CARD).innerHTML());
    await expect(page.locator(`${FEED_CARD} .dt-name`)).toHaveText('ISO 9241-210 — Human-centred design');
  });

  test('inv5 survives a pin taken from one surface', async ({ page }) => {
    await openMap(page);
    await open(page, COMMONS, { fly: false });
    await expect(page.locator(`${FEED_CARD} .dt-pin`)).toHaveText('☆ Pin');

    await page.click(`${FEED_CARD} .dt-pin`);
    expect((await snapshot(page)).pins).toBe(1);
    await expect(page.locator(`${FEED_CARD} .dt-pin`)).toHaveText('★ Pinned');
    await expect(page.locator(`${PANEL} .dt-pin`)).toHaveText('★ Pinned');
    expect(await page.locator(PANEL).innerHTML()).toBe(await page.locator(FEED_CARD).innerHTML());
  });

  test('inv5 survives the language switch, which re-renders the open card', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await page.click('.lang-switch button[data-lang="fr"]');

    await expect(page.locator(`${PANEL} .dt-kind`)).toHaveText('Projet / programme');
    expect(await page.locator(PANEL).innerHTML()).toBe(await page.locator(FEED_CARD).innerHTML());
    // §12: the content switches too, not only the chrome.
    const fr = await page.evaluate((id) => byId[id].d.desc_fr, PROJECT);
    await expect(page.locator(`${PANEL} .dt-desc`).first()).toHaveText(fr);
  });

  test('inv5 a card opened against a hidden feed appears there when the feed comes back', async ({ page }) => {
    // renderFeed() skips work when its key is unchanged, and `setFeed` resets
    // the key for exactly this case: the card was opened while the column was
    // hidden, so the feed has never rendered it.
    await openMap(page);
    await hideFeed(page);
    await open(page, COMMONS, { fly: false });
    await expect(page.locator(FEED_CARD)).toHaveCount(0);

    // Through setFeed() rather than the pill: with the panel open and the feed
    // hidden, `body.detail-open .ctl-tr` takes the whole cluster off screen, so
    // the reader reaches this state from a deep link or a stored preference
    // rather than by clicking. The function is the same one the pill calls.
    await page.evaluate(() => setFeed(true));
    await expect(page.locator('#feed')).toBeVisible();
    await expect(page.locator(FEED_CARD)).toHaveCount(1);
    expect(await page.locator(PANEL).innerHTML()).toBe(await page.locator(FEED_CARD).innerHTML());
  });

  test('§7 one selection at a time — opening another card replaces the first', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await open(page, TEAM, { fly: false });

    expect((await snapshot(page)).focusId).toBe(TEAM);
    await expect(page.locator(`${PANEL} .dt-name`)).toHaveText('RTE — R&D Grid AI (Réseau de Transport d\'Électricité)');
    expect(await page.$$eval('.mk.focus', els => els.map(e => e.dataset.id))).toEqual([TEAM]);
    // §14: aria-expanded says which feed row carries the open card, and only one does.
    await expect(page.locator('.fd-item.open')).toHaveCount(1);
    expect(await page.$$eval('.fd-row[aria-expanded="true"]', bs => bs.map(b => b.dataset.open))).toEqual([TEAM]);
  });
});

// =========================================================================
test.describe('§8 section order, and omission when empty', () => {
  test('§8 a project card renders the sections the spec lists, in that order', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });

    expect(await sections(page)).toEqual(['Focus areas', 'Timeline', 'Consortium', 'Funding',
      'Consortium teams', 'Builds on']);
    // The whole skeleton, in order: eyebrow, name, place, tags, domains,
    // description, actions, then the sections, then provenance. No facts grid
    // here — a project carries none of the identity fields §8 item 6 lists.
    expect(await page.$$eval(`${PANEL} > *`, els => els.map(e => e.tagName.toLowerCase() + '.' + e.className)))
      .toEqual(['div.dt-kind', 'h2.dt-name', 'p.dt-meta', 'div.dt-tags', 'div.dt-doms',
        'p.dt-desc', 'div.dt-actions',
        'section.dt-sec', 'section.dt-sec', 'section.dt-sec', 'section.dt-sec',
        'section.dt-sec', 'section.dt-sec', 'p.dt-prov']);
  });

  test('§8 a team card puts its three related sections last, before provenance', async ({ page }) => {
    await openMap(page);
    await open(page, TEAM, { fly: false });
    expect(await sections(page)).toEqual(['Focus areas', 'Timeline', 'Facilities hosted',
      'Publications', 'Projects & programmes', 'Created', 'Builds on']);
    expect(await page.$$eval(`${PANEL} > *`, els => els[els.length - 1].className)).toBe('dt-prov');
  });

  test('§8 no card in the payload renders its sections out of order', async ({ page }) => {
    // The order is the claim, for all 460 cards and not just the two above: a
    // new `dtSec()` call dropped in at the wrong line is exactly the mistake
    // §17 warns about, and it shows up nowhere else.
    await openMap(page);
    const bad = await page.evaluate((canon) => {
      const host = document.createElement('div');
      const out = [];
      items.forEach(it => {
        host.innerHTML = cardHtml(it);
        const titles = [...host.querySelectorAll('.dt-sec h4')].map(h => {
          const em = h.querySelector('em');
          return em ? h.textContent.replace(em.textContent, '').trim() : h.textContent.trim();
        });
        let p = 0;
        for (const title of titles) {
          const at = canon.indexOf(title, p);
          if (at < 0) { out.push([it.id, titles]); return; }
          p = at + 1;
        }
      });
      return out;
    }, CANON);
    expect(bad).toEqual([]);
  });

  test('§8 an entity with nothing to show omits every empty section', async ({ page }) => {
    await openMap(page);
    await open(page, COMMONS, { fly: false });
    // CityLearn has no consortium, no funding, no infrastructure, no
    // neighbours: those sections must be absent, not present and empty.
    expect(await sections(page)).toEqual(['Focus areas', 'Timeline']);
    await expect(page.locator(`${PANEL} .rel-row`)).toHaveCount(0);
    for (const gone of ['Consortium', 'Funding', 'Infrastructure', 'Used by', 'Created by']) {
      await expect(page.locator(`${PANEL} .dt-sec h4`, { hasText: gone })).toHaveCount(0);
    }
    // Nor an empty shell: every section rendered has something under its title.
    expect(await page.$$eval(`${PANEL} .dt-sec`,
      ss => ss.filter(s => s.children.length < 2).length)).toBe(0);
  });

  test('§8 "Other links" is omitted when the only link is a paper', async ({ page }) => {
    // linksSec is built unconditionally from four optional fields, so it is the
    // section most likely to render as an empty heading. Grid2Op has papers and
    // nothing else: Publications appears, Other links must not.
    await openMap(page);
    await open(page, PAPERS_ONLY, { fly: false });
    const secs = await sections(page);
    expect(secs).toContain('Publications');
    expect(secs).not.toContain('Other links');
    await expect(page.locator(`${PANEL} .dt-sec`).filter({ hasText: 'Publications' }).locator('li'))
      .toHaveCount(1);
  });

  test('§8 the eyebrow, the name and the place line', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await expect(page.locator(`${PANEL} .dt-kind`)).toHaveText('Project / programme');
    await expect(page.locator(`${PANEL} .dt-kind .glyph svg`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} .dt-name`)).toHaveText('AI4RealNet: AI for Real-world Network Operation');
    // "city, country · span" — the span is the project's compact `when`.
    await expect(page.locator(`${PANEL} .dt-meta`)).toHaveText('Porto, PT · 2023-10–2027-03');
  });

  test('§8 an entity with no coordinates says so instead of naming a place', async ({ page }) => {
    await openMap(page);
    await open(page, FRAMEWORK, { fly: false });
    await expect(page.locator(`${PANEL} .dt-meta`)).toHaveText('No geographic anchor');
  });

  test('§8 the tags row is kind-or-type, status, tier — and only those present', async ({ page }) => {
    await openMap(page);
    await open(page, COMMONS, { fly: false });
    expect(await page.$$eval(`${PANEL} .dt-tag`, ts => ts.map(t => t.textContent)))
      .toEqual(['Software', 'Active', 'Ecosystem']);

    await open(page, PROJECT, { fly: false });          // no tier in the data → two tags
    expect(await page.$$eval(`${PANEL} .dt-tag`, ts => ts.map(t => t.textContent)))
      .toEqual(['Horizon Europe', 'Active']);

    await open(page, TEAM, { fly: false });             // a team has `type`, not `kind`
    expect(await page.$$eval(`${PANEL} .dt-tag`, ts => ts.map(t => t.textContent)))
      .toEqual(['Industrial R&D', 'Active']);
  });

  test('§8 one domain badge per domain, in payload order, each with its dot', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const doms = await page.evaluate((id) => byId[id].domains, PROJECT);
    expect(doms).toEqual(['energy', 'rail', 'aviation', 'multi', 'hf', 'xai']);
    // The short `badge` labels, not the long filter names: the card has six of
    // them to fit on two lines.
    expect(await page.$$eval(`${PANEL} .dt-dom`, es => es.map(e => e.textContent)))
      .toEqual(['energy', 'rail', 'aviation', 'multi/other', 'human factors', 'XAI']);
    await expect(page.locator(`${PANEL} .dt-dom .dot`)).toHaveCount(doms.length);
  });

  test('§8 the facts grid names a framework\'s jurisdiction and issuing body', async ({ page }) => {
    await openMap(page);
    await open(page, FRAMEWORK, { fly: false });
    expect(await factRows(page)).toEqual({ Jurisdiction: 'International', 'Issuing body': 'ISO TC 159' });
    // The issuing body is a link out, not plain text.
    await expect(page.locator(`${PANEL} .dt-facts a`)).toHaveAttribute('href', 'https://www.iso.org/standard/77520.html');
  });

  test('§8 the facts grid drops a row that only repeats what is already shown', async ({ page }) => {
    // Two guards in `cardHtml` exist so the grid does not restate the heading:
    // an affiliation identical to the name, and a repository identical to the
    // site already on the Visit button.
    await openMap(page);
    await open(page, 'aalto-dt', { fly: false });
    expect(await page.evaluate(() => byId['aalto-dt'].d.affiliation.org === byId['aalto-dt'].d.name)).toBe(true);
    expect(Object.keys(await factRows(page))).not.toContain('Affiliation');

    await open(page, COMMONS, { fly: false });
    expect(await page.evaluate((id) => byId[id].d.repo === byId[id].d.url, COMMONS)).toBe(true);
    const rows = await factRows(page);
    expect(Object.keys(rows)).not.toContain('Repository');
    expect(rows).toEqual({ Licence: 'MIT', Maintainer: 'Intelligent Environments Lab, UT Austin' });
  });

  test('§8 the facts grid carries the identity fields the spec lists, in order', async ({ page }) => {
    await openMap(page);
    await open(page, PAPERS_ONLY, { fly: false });
    // Grid2Op's repository is not its documentation site, so unlike CityLearn
    // above it earns the Repository row. Order follows §8 item 6.
    expect(Object.entries(await factRows(page))).toEqual([
      ['Licence', 'MPL-2.0'],
      ['Maintainer', 'RTE France'],
      ['Repository', 'github.com/Grid2op/grid2op'],
      ['Reach', '~600 GitHub stars; used in L2RPN challenges'],
    ]);
  });

  test('§8 the facts grid carries all four of a standard\'s identity fields, in order', async ({ page }) => {
    // The two fixtures above cover six of §8 item 6's ten fields and neither
    // carries `legal` or `adopted` — 8 and 10 entities in the payload do. A
    // grid read back as an object compares equal whatever the order, so this
    // one reads it as a list: the sequence is the claim, not just the contents.
    await openMap(page);
    const d = await page.evaluate((id) => byId[id].d, STANDARD);
    expect([d.jurisdiction, d.legal, d.adopted]).toEqual(['EU', 'in_force', '2024-08-01']);

    await open(page, STANDARD, { fly: false });
    expect(await identityRows(page)).toEqual([
      ['Jurisdiction', 'European Union'],
      ['Issuing body', 'European Parliament & Council of the EU'],
      ['Legal status', 'In force'],
      ['Adopted', '2024-08-01'],
    ]);
    // Both halves are vocabulary lookups, not raw keys: "in_force" reaching the
    // reader is the §3.4 failure, and an & in the issuer name is invariant 9's.
    await expect(page.locator(`${PANEL} > .dt-facts`)).not.toContainText('in_force');
  });

  test('§8 no card in the payload drops or reorders an identity field', async ({ page }) => {
    // §8 item 6 lists ten fields in one order, for 460 cards. The prediction is
    // built here from the payload and from FACT_ORDER, so a row deleted from
    // `identity` — or two of them swapped — fails against the spec's list
    // rather than against whatever `cardHtml()` currently emits.
    await openMap(page);
    const [got, data] = await Promise.all([
      page.evaluate(() => {
        const host = document.createElement('div');
        const o = {};
        items.forEach(it => {
          host.innerHTML = cardHtml(it);
          const dl = host.querySelector(':scope > .dt-facts');
          o[it.id] = dl ? [...dl.querySelectorAll(':scope > div > dt')].map(dt => dt.textContent) : [];
        });
        return o;
      }),
      page.evaluate(() => {
        const o = {};
        items.forEach(it => { const d = it.d;
          o[it.id] = { name: d.name, url: d.url, affiliation: d.affiliation, jurisdiction: d.jurisdiction,
            issuer: d.issuer, legal: d.legal, adopted: d.adopted, license: d.license,
            maintainer: d.maintainer, repo: d.repo, size: d.size }; });
        return o;
      }),
    ]);
    const bad = [];
    for (const [id, d] of Object.entries(data)) {
      const want = FACT_ORDER.filter(([, has]) => has(d)).map(([label]) => label);
      if (JSON.stringify(want) !== JSON.stringify(got[id])) bad.push({ id, want, got: got[id] });
    }
    expect(bad).toEqual([]);
    // …and the fields really are exercised, rather than the whole corpus
    // happening to have none of them.
    const seen = new Set(Object.values(got).flat());
    expect([...FACT_ORDER.map(([l]) => l)].filter(l => !seen.has(l))).toEqual([]);
  });

  test('§8 focus areas are taxonomy labels, as chips', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    expect(await page.$$eval(`${PANEL} .dt-chip`, cs => cs.map(c => c.textContent)))
      .toEqual(['Decision support', 'Mixed initiative', 'Shared situational awareness',
        'Human factors', 'Human oversight']);
  });

  test('§8 the timeline is a span, then the milestones on a rule', async ({ page }) => {
    await openMap(page);
    await open(page, PAPERS_ONLY, { fly: false });
    const sec = page.locator(`${PANEL} .dt-sec`).filter({ has: page.locator('h4', { hasText: 'Timeline' }) });
    await expect(sec.locator('.dt-span')).toHaveText('2019-06 →');   // open-ended: no end date
    expect(await sec.locator('.dt-ms li').allTextContents())
      .toEqual(['2019-06First public release', '2020Used in NeurIPS L2RPN competition']);
  });

  test('§8 a start year that is not the entity\'s own is hedged in the card', async ({ page }) => {
    // §10.1: the hedging is the whole point of keeping these dates at all. A
    // medium/low confidence start gets "≈", and the reason is spelled out —
    // the host institution's founding year, or an estimate.
    await openMap(page);
    await open(page, SOFT_HOST, { fly: false });
    await expect(page.locator(`${PANEL} .dt-span`)).toHaveText('≈ 1946 →');
    await expect(page.locator(`${PANEL} .dt-caveat`))
      .toHaveText(/^Founding year of the host institution/);

    await open(page, SOFT_LOW, { fly: false });
    await expect(page.locator(`${PANEL} .dt-span`)).toHaveText('≈ 2022 →');
    await expect(page.locator(`${PANEL} .dt-caveat`))
      .toHaveText('Approximate date, reconstructed from indirect evidence.');

    await open(page, PROJECT, { fly: false });                        // high confidence
    await expect(page.locator(`${PANEL} .dt-span`)).toHaveText('2023-10 → 2027-03');
    await expect(page.locator(`${PANEL} .dt-caveat`)).toHaveCount(0);
  });

  test('§8 the infrastructure section names kind, operator, access and capacity', async ({ page }) => {
    // §3.2: an infrastructure entry whose facility belongs to a team already on
    // the map enriches that team's card instead of adding a second pin. This
    // section is where the merge becomes visible.
    await openMap(page);
    await open(page, 'bsc', { fly: false });
    expect(await sections(page)).toContain('Infrastructure');
    expect(await factRows(page, `${PANEL} .dt-sec:has(h4:text-is("Infrastructure"))`)).toEqual({
      Kind: 'Compute cluster',
      Operator: 'Barcelona Supercomputing Center',
      Access: 'On request',
      Capacity: 'MareNostrum 5 — pre-exascale supercomputer',
    });
  });

  test('§8 demonstrators and deliverables are listed, linked when they have a URL', async ({ page }) => {
    await openMap(page);
    await open(page, 'haiku', { fly: false });
    const demos = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Demonstrators")) li`);
    expect(await demos.allTextContents()).toEqual(['Cockpit assistant prototypes (2)',
      'ATC assistant prototypes (2)', 'Airport assistant prototypes (2)']);
    await expect(demos.locator('a')).toHaveCount(3);
    await expect(demos.first().locator('a')).toHaveAttribute('href', 'https://haikuproject.eu/');

    // The deliverables carry no URL: plain text, not empty links.
    const delivs = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Deliverables")) li`);
    expect(await delivs.allTextContents()).toEqual(['HAIKU Human-AI Teaming Validation Framework',
      'Human factors design guidance for aviation AI']);
    await expect(delivs.locator('a')).toHaveCount(0);
  });

  test('§8 "applies to" is a chip list, de-underscored when it is not vocabulary', async ({ page }) => {
    // §3.4: an unmapped key degrades to readable text rather than breaking.
    // `appliesTo` is free text in some entries and underscored keys in others,
    // and the card has to read as prose either way.
    await openMap(page);
    await open(page, 'iec-62682', { fly: false });
    expect(await page.$$eval(`${PANEL} .dt-sec:has(h4:text-is("Applies to")) .dt-chip`,
      cs => cs.map(c => c.textContent)))
      .toEqual(['alarm management', 'control systems', 'human machine interfaces',
        'basic process control systems', 'safety instrumented systems',
        'continuous batch and discrete processes']);

    await open(page, 'cen-cenelec-jtc21', { fly: false });
    expect(await page.$$eval(`${PANEL} .dt-sec:has(h4:text-is("Applies to")) .dt-chip`,
      cs => cs.map(c => c.textContent)))
      .toEqual(['AI systems placed on the EU market', 'high-risk AI systems under the EU AI Act',
        'risk management', 'human oversight', 'transparency', 'robustness', 'quality management']);
  });

  test('§8 "builds on" names the frameworks a framework rests on, and opens them', async ({ page }) => {
    await openMap(page);
    await open(page, 'cen-cenelec-jtc21', { fly: false });
    const refs = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Builds on")) .dt-lk`);
    expect(await refs.evaluateAll(bs => bs.map(b => b.dataset.open)))
      .toEqual(['eu-ai-act', 'iso-iec-42001']);
    expect(await refs.allTextContents())
      .toEqual(await page.evaluate(() => ['eu-ai-act', 'iso-iec-42001'].map(i => byId[i].d.name)));

    await page.locator(`${FEED_CARD} .dt-sec:has(h4:text-is("Builds on")) .dt-lk`).first().click();
    expect((await snapshot(page)).focusId).toBe('eu-ai-act');
  });

  test('§8 pin and visit-website are the card\'s two actions', async ({ page }) => {
    await openMap(page);
    await open(page, TEAM, { fly: false });
    const url = await page.evaluate((id) => byId[id].d.url, TEAM);
    const visit = page.locator(`${PANEL} .dt-actions a`);
    await expect(visit).toHaveText('Visit website ↗');
    await expect(visit).toHaveAttribute('href', url);
    await expect(visit).toHaveAttribute('target', '_blank');
    await expect(visit).toHaveAttribute('rel', 'noopener');

    await page.click(`${FEED_CARD} .dt-pin`);
    expect(await page.evaluate(() => [...state.pins])).toEqual([TEAM]);
    await page.click(`${FEED_CARD} .dt-pin`);
    expect(await page.evaluate(() => state.pins.size)).toBe(0);
  });
});

// =========================================================================
test.describe('invariant 7 — descriptions are never truncated', () => {
  // The predecessor capped descriptions at 300 characters and cut 29 English
  // and 39 French ones mid-word (§3.1). These tests are the tripwire.
  test('inv7 the longest English description renders in full', async ({ page }) => {
    await openMap(page);
    const longest = await page.evaluate(() => {
      let best = null;
      items.forEach(it => { const s = it.d.desc_en || it.d.desc || '';
        if (!best || s.length > best.len) best = { id: it.id, len: s.length }; });
      return best;
    });
    // Pinned to a known entity so a data change is visible here rather than
    // quietly turning this into a test of some other, shorter card.
    expect(longest).toEqual({ id: LONG_EN, len: 1180 });

    await open(page, LONG_EN, { fly: false });
    const want = await page.evaluate((id) => byId[id].d.desc_en, LONG_EN);
    for (const root of [PANEL, FEED_CARD]) {
      const got = await page.$$eval(`${root} .dt-desc`, ps => ps.map(p => p.textContent).join('\n\n'));
      expect(got).toBe(want);
      expect(got.length).toBe(1180);
      expect(got).not.toContain('…');
    }
  });

  test('inv7 the longest French description renders in full', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    const longest = await page.evaluate(() => {
      let best = null;
      items.forEach(it => { const s = it.d.desc_fr || it.d.desc || '';
        if (!best || s.length > best.len) best = { id: it.id, len: s.length }; });
      return best;
    });
    expect(longest).toEqual({ id: LONG_FR, len: 1260 });

    await open(page, LONG_FR, { fly: false });
    const want = await page.evaluate((id) => byId[id].d.desc_fr, LONG_FR);
    const got = await page.$$eval(`${PANEL} .dt-desc`, ps => ps.map(p => p.textContent).join('\n\n'));
    expect(got).toBe(want);
    expect(got.length).toBe(1260);
  });

  test('inv7 paragraph breaks are preserved as paragraphs', async ({ page }) => {
    await openMap(page);
    const want = await page.evaluate((id) => (byId[id].d.desc_en || byId[id].d.desc).split('\n\n'), PARAS);
    expect(want).toHaveLength(2);

    await open(page, PARAS, { fly: false });
    expect(await page.$$eval(`${PANEL} .dt-desc`, ps => ps.map(p => p.textContent))).toEqual(want);
    // A newline rendered as a newline inside one <p> would collapse in HTML —
    // the split has to produce real paragraphs, which is what §3.1 promises.
    expect(await page.locator(`${PANEL} .dt-desc`).count()).toBe(2);
  });

  test('inv7 not one description in the payload is rendered short', async ({ page }) => {
    await openMap(page);
    const short = await page.evaluate(() => {
      const host = document.createElement('div');
      const bad = [];
      items.forEach(it => {
        const want = it.d.desc_en || it.d.desc || '';
        if (!want) return;
        host.innerHTML = cardHtml(it);
        const got = [...host.querySelectorAll('.dt-desc')].map(p => p.textContent).join('\n\n');
        if (got !== want) bad.push({ id: it.id, want: want.length, got: got.length });
      });
      return bad;
    });
    expect(short).toEqual([]);
  });

  test('§8/§12 a description that exists only under `desc` is used in both languages', async ({ page }) => {
    await openMap(page);
    const raw = await page.evaluate((id) => {
      const d = byId[id].d;
      return { desc: d.desc, en: d.desc_en, fr: d.desc_fr };
    }, PARAS);
    expect(raw.en).toBeUndefined();
    expect(raw.fr).toBeUndefined();

    await open(page, PARAS, { fly: false });
    const inEn = await page.$$eval(`${PANEL} .dt-desc`, ps => ps.map(p => p.textContent).join('\n\n'));
    await page.click('.lang-switch button[data-lang="fr"]');
    const inFr = await page.$$eval(`${PANEL} .dt-desc`, ps => ps.map(p => p.textContent).join('\n\n'));
    expect(inEn).toBe(raw.desc);
    expect(inFr).toBe(raw.desc);
  });

  test('§8 a card with no description at all says so rather than rendering blank', async ({ page }) => {
    // No entity in the payload lacks a description, so this exercises
    // cardHtml() directly on the shape the fallback exists for.
    await openMap(page);
    const out = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = cardHtml({ id: 'synthetic', kind: 'commons', domains: ['multi'],
        d: { id: 'synthetic', name: 'No description here' } });
      return [...host.querySelectorAll('.dt-desc')].map(p => p.textContent);
    });
    expect(out).toEqual(['Description to come.']);
  });
});

// =========================================================================
test.describe('§8 the consortium row', () => {
  test('§8 a row is a button when its reference resolves, plain text when there is none', async ({ page }) => {
    await openMap(page);
    // AI4RealNet's seventeen partners all resolve to entities on the map.
    await open(page, PROJECT, { fly: false });
    const sec = page.locator(`${PANEL} .dt-sec`).filter({ has: page.locator('h4', { hasText: 'Consortium' }) });
    expect(await page.evaluate((id) => byId[id].d.consortium.length, PROJECT)).toBe(17);
    await expect(sec.locator('li')).toHaveCount(17);
    await expect(sec.locator('li button.dt-lk')).toHaveCount(17);

    // AI-EDGE lists twenty-five and resolves four; the other twenty-one are
    // names the map does not know, and must not pretend to be links.
    await open(page, 'ai-edge', { fly: false });
    const sec2 = page.locator(`${PANEL} .dt-sec`).filter({ has: page.locator('h4', { hasText: 'Consortium' }) });
    await expect(sec2.locator('li')).toHaveCount(25);
    await expect(sec2.locator('li button.dt-lk')).toHaveCount(4);
    await expect(sec2.locator('li').first()).toHaveText('Fondazione Bruno Kessler Coordinator · IT');
  });

  test('§8 a resolved row names its destination when the legal name differs', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const rows = await page.$$eval(`${PANEL} .dt-sec li`, lis => lis.map(li => li.textContent));
    // Sixteen of the seventeen carry "→ <entity name>"; the seventeenth is the
    // Flatland Association, whose legal name *is* the entity's name, so there
    // is nothing to add — the arrow would be noise.
    expect(rows.filter(r => r.includes('→'))).toHaveLength(16);
    expect(rows.find(r => r.startsWith('Flatland Association'))).toBe('Flatland Association Partner · CH');
    // The reason the arrow is worth the pixels: the row says "Linkopings
    // Universitet", the entity is a named group inside it.
    expect(rows.find(r => r.startsWith('Linkopings Universitet')))
      .toBe('Linkopings Universitet → The iVis Group / Human-AI Teaming Research Group Partner · SE');
  });

  test('§8 a consortium row opens the entity it resolves to', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await page.locator(`${FEED_CARD} .dt-lk`).first().click();
    expect((await snapshot(page)).focusId).toBe('inesc-tec-cpes');
    expect(await history(page)).toEqual({ ids: [PROJECT, 'inesc-tec-cpes'], i: 1 });
  });

  test('§3.3/§8 no card anywhere renders a reference the map cannot open', async ({ page }) => {
    // The generator drops an unresolvable `consortium[].ref`, and refsHtml /
    // relSections filter by byId. Assert the result: every clickable reference
    // in every card, of every kind, is an entity that exists.
    await openMap(page);
    const dead = await page.evaluate(() => {
      const host = document.createElement('div');
      const bad = [];
      items.forEach(it => {
        host.innerHTML = cardHtml(it);
        host.querySelectorAll('[data-open]').forEach(b => {
          if (!byId[b.dataset.open]) bad.push([it.id, b.dataset.open]);
        });
      });
      return bad;
    });
    expect(dead).toEqual([]);
  });
});

// =========================================================================
test.describe('§8 the related-entities counts are deliberately unfiltered', () => {
  // This is the one place in the interface where a count ignores the filters,
  // and §8's last paragraph says why: "a consortium has the partners it has —
  // hiding three of seventeen would misdescribe the entity rather than the
  // view." It is NOT an instance of the stale-count problem in §9.1, and a
  // future reader who "fixes" it into a filtered count should fail these tests.
  test('§8 narrowing the filters to nothing does not move a related count', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    expect(await relCounts(page)).toEqual({ 'Consortium teams': 21, 'Builds on': 4 });

    await unfilterNothing(page);                       // every domain off: nothing matches
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.keptOpen).toBe(1);                        // only the open card survives (§6)

    expect(await relCounts(page)).toEqual({ 'Consortium teams': 21, 'Builds on': 4 });
    await expect(page.locator(`${PANEL} .rel-row`)).toHaveCount(25);
    // And the same in the feed, which is the surface the reader is looking at.
    expect(await relCounts(page, FEED_CARD)).toEqual({ 'Consortium teams': 21, 'Builds on': 4 });
  });

  test('§8 clicking a neighbour the filters exclude still opens it, and it stays visible', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await unfilterNothing(page);

    const target = await page.locator(`${FEED_CARD} .rel-row`).first().getAttribute('data-open');
    await page.locator(`${FEED_CARD} .rel-row`).first().click();

    const s = await snapshot(page);
    expect(s.focusId).toBe(target);
    expect(s.matchCount).toBe(0);
    expect(s.keptOpen).toBe(1);                        // invariant 6: never hidden by a filter
    // The marker is drawn, not merely counted: the focus override re-adds it.
    expect(await page.evaluate((id) => mkEls[id] && mkEls[id].style.display, target)).toBe('');
    // The card on screen is that neighbour's, not the one we came from.
    await expect(page.locator(`${PANEL} .dt-name`))
      .toHaveText(await page.evaluate((id) => byId[id].d.name, target));
  });

  test('§8 the related lists are every neighbour the data gives, whatever the view', async ({ page }) => {
    await openMap(page);
    for (const id of [PROJECT, TEAM, PAPERS_ONLY]) {
      await open(page, id, { fly: false });
      const want = (await neighboursFromData(page, id)).sort();
      // De-duplicated: a team that both built an asset and uses it — RTE and
      // OperatorFabric — is listed under both headings, which is the honest
      // rendering of two different relationships, not a double count.
      const got = await page.$$eval(`${PANEL} .rel-row`, bs => [...new Set(bs.map(b => b.dataset.open))].sort());
      expect(got, `related rows for ${id}`).toEqual(want);
    }
  });

  test('§8 a neighbour related twice over is listed under each heading', async ({ page }) => {
    // OperatorFabric names RTE in both `createdBy` and `usedBy`. Collapsing the
    // two would lose the distinction the sections exist to draw.
    await openMap(page);
    expect(await page.evaluate(() => {
      const a = [...DATA.COMMONS, ...DATA.FRAMEWORKS].find(x => x.id === 'operatorfabric');
      return [a.createdBy.includes('rte-rd-grid-ai'), a.usedBy.includes('rte-rd-grid-ai')];
    })).toEqual([true, true]);

    await open(page, TEAM, { fly: false });
    const where = await page.$$eval(`${PANEL} .dt-sec`, ss => ss
      .filter(s => s.querySelector('[data-open="operatorfabric"]'))
      .map(s => s.querySelector('h4').textContent.replace(/\s*\d+$/, '')));
    expect(where).toEqual(['Created', 'Builds on']);
  });
});

// =========================================================================
test.describe('§7 selection and navigation', () => {
  test('§7 selecting highlights the marker, dims the rest, and draws its edges hot', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });

    const nbrs = await neighboursFromData(page, PROJECT);
    expect(nbrs).toHaveLength(25);
    // Every one of them is placed, so the dimming arithmetic below is exact.
    expect(await page.evaluate((ns) => ns.every(n => byId[n].geo), nbrs)).toBe(true);
    const placed = await page.evaluate(() => items.filter(i => i.geo).length);

    const st = await page.evaluate(([id, ns]) => ({
      focused: mkEls[id].classList.contains('focus'),
      dimmedNeighbours: ns.filter(n => mkEls[n] && mkEls[n].classList.contains('dim')).length,
      dimmedElsewhere: Object.keys(mkEls).filter(k => k !== id && !ns.includes(k)
        && mkEls[k].style.display !== 'none' && mkEls[k].classList.contains('dim')).length,
      undimmedElsewhere: Object.keys(mkEls).filter(k => k !== id && !ns.includes(k)
        && mkEls[k].style.display !== 'none' && !mkEls[k].classList.contains('dim')).length,
      onEdges: edgeEls.filter(e => e.classList.contains('on')).length,
      hot: hotEdges.length,
      links: state.links,
    }), [PROJECT, nbrs]);

    expect(st.focused).toBe(true);
    expect(st.dimmedNeighbours).toBe(0);
    expect(st.undimmedElsewhere).toBe(0);
    // Nothing else is left bright: every placed marker but this one and its
    // twenty-five neighbours is dimmed.
    expect(st.dimmedElsewhere).toBe(placed - 1 - nbrs.length);
    // The link mesh is off by default, so every drawn edge is one of this
    // entity's own — 25 neighbours, all of them placed, so 25 edges.
    expect(st.links).toBe(false);
    expect(st.onEdges).toBe(25);
    expect(st.hot).toBe(25);
  });

  test('§7 closing the card clears the focus and the dimming it caused', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await page.click(`${FEED_CARD} .dt-pin`);          // pinned state must survive the close
    await page.evaluate(() => closeDetail());

    const s = await snapshot(page);
    expect(s.focusId).toBe(null);
    expect(s.keptOpen).toBe(0);
    expect(s.pins).toBe(1);
    expect(await page.evaluate(() => document.body.classList.contains('detail-open'))).toBe(false);
    expect(await page.evaluate(() => document.querySelectorAll('.mk.focus').length)).toBe(0);
    expect(await page.evaluate(() => edgeEls.filter(e => e.classList.contains('on')).length)).toBe(0);
    await expect(page.locator('.fd-item.open')).toHaveCount(0);
  });

  test('§7 clicking empty map closes the card, clicking a marker opens one', async ({ page }) => {
    await openMap(page);
    const mk = await findPoint(page, true);
    expect(mk).not.toBeNull();
    await page.mouse.click(mk.x, mk.y);
    expect((await snapshot(page)).focusId).toBe(mk.id);

    const empty = await findPoint(page, false);        // scanned with the card open
    expect(empty).not.toBeNull();
    await page.mouse.click(empty.x, empty.y);
    expect((await snapshot(page)).focusId).toBe(null);
  });

  test('§7 Escape closes the card — and the welcome screen first, when both are open', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await page.evaluate(() => openWelcome());

    await page.keyboard.press('Escape');               // welcome outranks the card
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);
    expect((await snapshot(page)).focusId).toBe(PROJECT);

    await page.keyboard.press('Escape');
    expect((await snapshot(page)).focusId).toBe(null);
    await expect(page.locator('#detail')).not.toHaveClass(/open/);
  });

  test('§7 the tour outranks both of them on Escape', async ({ page }) => {
    // The full priority order is tour > welcome > card > drawer. Only the tour
    // has nowhere else to go, so it has to be dismissed first.
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    await page.evaluate(() => { openWelcome(); startTour(); });
    expect(await page.evaluate(() => tourStep)).toBe(0);

    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => tourStep)).toBe(-1);
    await expect(page.locator('#welcome')).toHaveClass(/open/);
    expect((await snapshot(page)).focusId).toBe(PROJECT);
  });

  test('§7 hovering a related row halos that marker on the map', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const row = page.locator(`${FEED_CARD} .rel-row`).first();
    const id = await row.getAttribute('data-open');

    await row.hover();
    expect(await page.evaluate(() => peekId)).toBe(id);
    expect(await page.evaluate((x) => mkEls[x].classList.contains('peek'), id)).toBe(true);

    await page.locator(`${FEED_CARD} .dt-name`).hover();   // leave the row
    expect(await page.evaluate(() => peekId)).toBe(null);
    expect(await page.evaluate((x) => mkEls[x].classList.contains('peek'), id)).toBe(false);
  });

  test('§7 a peek shows one relationship at a time', async ({ page }) => {
    // With 25 edges fanning out of one project, all of them at full strength is
    // a hairball; pointing at a row is how a reader picks one out.
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const before = await page.evaluate(() =>
      hotEdges.map(i => Number(edgeEls[i].getAttribute('stroke-opacity'))));
    // A 25-edge fan is the widest case: the base opacity is 0.4, thinned by up
    // to 40% for the longest hops, so every edge starts somewhere in 0.24–0.4.
    expect(before).toHaveLength(25);
    expect(Math.min(...before)).toBeGreaterThanOrEqual(0.24);
    expect(Math.max(...before)).toBeLessThanOrEqual(0.4);

    const row = page.locator(`${FEED_CARD} .rel-row`).first();
    const id = await row.getAttribute('data-open');
    await row.hover();

    const after = await page.evaluate((x) => hotEdges.map(i => ({
      mine: edges[i].a === x || edges[i].b === x,
      op: edgeEls[i].getAttribute('stroke-opacity'),
      w: edgeEls[i].getAttribute('stroke-width'),
    })), id);
    const mine = after.filter(e => e.mine);
    expect(mine).toHaveLength(1);
    expect(mine[0].op).toBe('0.950');
    expect(Math.max(...after.filter(e => !e.mine).map(e => Number(e.op)))).toBeLessThan(0.07);
    expect(Number(mine[0].w)).toBeGreaterThan(Number(after.find(e => !e.mine).w));
  });

  test('§7 peeking an entity with no marker is harmless', async ({ page }) => {
    // Invariant 3 again: a framework with no coordinates still has rows to
    // hover, in its own card and in the cards of its neighbours.
    await openMap(page);
    await open(page, FRAMEWORK, { fly: false });
    expect(await page.evaluate((id) => mkEls[id], FRAMEWORK)).toBeFalsy();
    await page.evaluate((id) => peek(id, true), FRAMEWORK);
    expect(await page.evaluate(() => peekId)).toBe(FRAMEWORK);
    await page.evaluate((id) => peek(id, false), FRAMEWORK);
    expect(await page.evaluate(() => peekId)).toBe(null);
  });

  test('§7 hovering a marker while a card is open peeks it and fills the tooltip', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const nbr = (await neighboursFromData(page, PROJECT))[0];
    const tip = await page.evaluate((id) => {
      mkEls[id].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      const el = document.getElementById('tooltip');
      return { peek: peekId, shown: el.style.display,
        name: el.querySelector('.tt-name').textContent,
        meta: el.querySelector('.tt-meta').textContent,
        dots: el.querySelectorAll('.tt-doms span').length };
    }, nbr);
    expect(tip.peek).toBe(nbr);
    expect(tip.shown).toBe('block');
    expect(tip.name).toBe(await page.evaluate((id) => byId[id].d.name, nbr));
    expect(tip.dots).toBe(await page.evaluate((id) => byId[id].domains.length, nbr));
    // The meta line is layer, then place — the same two facts as the card's
    // eyebrow, which is what makes the tooltip readable without opening it.
    expect(tip.meta).toBe(await page.evaluate((id) => {
      const it = byId[id];
      return `${t('kind.' + it.kind)} · ${[it.d.city, it.d.country].filter(Boolean).join(', ')}`;
    }, nbr));

    // The focused entity is not peeked by its own hover — it is already hot.
    expect(await page.evaluate((id) => {
      mkEls[id].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      return peekId;
    }, PROJECT)).toBe(nbr);
  });
});

// =========================================================================
test.describe('§7 traversal, history and the breadcrumb', () => {
  // The floating panel carries the back button and the trail, and it is
  // display:none while the feed is open — so these tests read the panel.
  test('§7 clicking related rows walks outwards, and the trail keeps the last three steps', async ({ page }) => {
    await openMap(page);
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await expect(page.locator('#detail')).toBeVisible();
    expect(await crumbs(page)).toEqual([]);
    await expect(page.locator('#dt-back')).toBeDisabled();

    const names = [];
    for (let step = 0; step < 4; step++) {
      const rows = page.locator(`${PANEL} .rel-row`);
      expect(await rows.count(), `step ${step} has somewhere to go`).toBeGreaterThan(0);
      names.push(await page.locator(`${PANEL} .dt-name`).textContent());
      await rows.first().click();
    }
    const h = await history(page);
    expect(h.ids).toHaveLength(5);
    expect(h.i).toBe(4);
    // Three crumbs, not four: the trail is the last three steps before here.
    expect(await crumbs(page)).toEqual(names.slice(1));
    await expect(page.locator('#dt-back')).toBeEnabled();
  });

  test('§7 a crumb walks to its own step, not to the start of the history', async ({ page }) => {
    // The trail shows the last three steps of a history that can be longer, so
    // each crumb has to carry its index into `state.history` rather than its
    // position in the trail. Those two numbers are equal for the first four
    // steps, which is why the test above — and the labels alone — cannot tell
    // the difference: it takes a fifth step before the offset matters.
    await openMap(page);
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    for (let step = 0; step < 4; step++) await page.locator(`${PANEL} .rel-row`).first().click();

    const h = await history(page);
    expect(h.ids).toHaveLength(5);                    // five deep: the trail window has slid
    expect(h.i).toBe(4);
    expect(await page.$$eval('#dt-trail .dt-crumb', bs => bs.map(b => b.dataset.h)))
      .toEqual(['1', '2', '3']);
    expect(await crumbs(page))
      .toEqual(await page.evaluate((ids) => ids.map(i => byId[i].d.name), h.ids.slice(1, 4)));

    await page.locator('#dt-trail .dt-crumb').first().click();
    expect((await snapshot(page)).focusId).toBe(h.ids[1]);
    expect(await history(page)).toEqual({ ids: h.ids, i: 1 });
  });

  test('§7 the back button walks the history and is disabled at the first step', async ({ page }) => {
    await openMap(page);
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await page.locator(`${PANEL} .rel-row`).first().click();
    const second = (await snapshot(page)).focusId;

    await page.click('#dt-back');
    expect((await snapshot(page)).focusId).toBe(PROJECT);
    expect(await history(page)).toEqual({ ids: [PROJECT, second], i: 0 });
    await expect(page.locator('#dt-back')).toBeDisabled();
  });

  test('§7 re-opening the card already shown adds no history step', async ({ page }) => {
    await openMap(page);
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await open(page, PROJECT, { fly: false });
    await page.click('#dt-close');
    await open(page, PROJECT, { fly: false });         // reopened after a close
    expect(await history(page)).toEqual({ ids: [PROJECT], i: 0 });
    await expect(page.locator('#dt-back')).toBeDisabled();
  });

  test('§7 opening something new after going back drops the steps ahead', async ({ page }) => {
    await openMap(page);
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await open(page, COMMONS, { fly: false });
    await open(page, FRAMEWORK, { fly: false });
    await page.click('#dt-back');                      // back to COMMONS
    await open(page, TEAM, { fly: false });
    expect(await history(page)).toEqual({ ids: [PROJECT, COMMONS, TEAM], i: 2 });
  });

  test('§7 a breadcrumb click walks back without dropping the steps ahead', async ({ page }) => {
    await openMap(page);
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await open(page, COMMONS, { fly: false });
    await open(page, FRAMEWORK, { fly: false });
    expect(await crumbs(page)).toEqual(['AI4RealNet: AI for Real-world Network Operation', 'CityLearn']);

    await page.locator('#dt-trail .dt-crumb').first().click();
    expect((await snapshot(page)).focusId).toBe(PROJECT);
    expect(await history(page)).toEqual({ ids: [PROJECT, COMMONS, FRAMEWORK], i: 0 });
  });

  test('§7 the feed opens a card without moving the map under the reader', async ({ page }) => {
    // `openEntity(id, {fly:false})` exists for exactly this: a feed click is a
    // reading action, not a navigation one.
    await openMap(page);
    const before = await page.evaluate(() => ({ ...view }));
    const row = page.locator('.fd-row').first();
    const id = await row.getAttribute('data-open');
    await row.click();
    expect((await snapshot(page)).focusId).toBe(id);
    expect(await page.evaluate(() => ({ ...view }))).toEqual(before);

    // Clicking the open row again closes it rather than re-opening it.
    await page.locator(`.fd-item.open .fd-row`).click();
    expect((await snapshot(page)).focusId).toBe(null);
  });

  test('§7 an entity with no marker cannot be flown to', async ({ page }) => {
    await openMap(page);
    const before = await page.evaluate(() => ({ ...view }));
    await open(page, FRAMEWORK);                       // fly not suppressed
    expect((await snapshot(page)).focusId).toBe(FRAMEWORK);
    expect(await page.evaluate(() => ({ ...view }))).toEqual(before);
  });
});

test.describe('§7 flying to a selection', () => {
  // With motion reduced, setView lands in one step, so the destination can be
  // asserted exactly instead of waited out — and §14's reduced-motion path
  // gets exercised on the way.
  test.use({ reducedMotion: 'reduce' });

  test('§7 opening from search flies to at least k₀ × 3.2 and centres the entity', async ({ page }) => {
    await openMap(page);
    const before = await page.evaluate(() => ({ k: view.k, k0 }));
    expect(before.k).toBeLessThan(before.k0 * 3.2);

    await openViaSearch(page, 'AI4RealNet');
    expect((await snapshot(page)).focusId).toBe(PROJECT);
    const after = await page.evaluate((id) => ({
      ...view, k0, X: byId[id].X, Y: byId[id].Y, w: stageSize()[0], h: stageSize()[1],
    }), PROJECT);
    expect(after.k).toBeCloseTo(after.k0 * 3.2, 9);
    expect(after.x).toBeCloseTo(after.w / 2 - after.X * after.k, 6);
    expect(after.y).toBeCloseTo(after.h / 2 - after.Y * after.k, 6);
  });

  test('§7 a related row is navigation, so it does fly — unlike a feed row', async ({ page }) => {
    // The distinction is deliberate and easy to lose: `bindCard` wires the
    // card's own rows to a plain `openEntity(id)`, while the feed's rows pass
    // {fly:false}. Reading down the feed must not move the map; following a
    // relationship out of a card is exactly a request to move it.
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const still = await page.evaluate(() => ({ ...view }));

    const row = page.locator(`${FEED_CARD} .rel-row`).first();
    const id = await row.getAttribute('data-open');
    await row.click();

    const after = await page.evaluate((x) => ({
      ...view, k0, geo: byId[x].geo, X: byId[x].X, Y: byId[x].Y, w: stageSize()[0], h: stageSize()[1],
    }), id);
    expect(after.geo).toBe(true);
    expect(after.k).toBeCloseTo(Math.max(still.k, after.k0 * 3.2), 9);
    expect(after.x).toBeCloseTo(after.w / 2 - after.X * after.k, 6);
    expect(after.y).toBeCloseTo(after.h / 2 - after.Y * after.k, 6);
  });

  test('§7 a fly never zooms back out from a closer view', async ({ page }) => {
    await openMap(page);
    await page.evaluate(() => setView({ k: k0 * 8, x: view.x, y: view.y }, false));
    const k = await page.evaluate(() => view.k);
    await open(page, PROJECT);
    expect(await page.evaluate(() => view.k)).toBeCloseTo(k, 9);
  });
});

// =========================================================================
test.describe('§8 the provenance footer', () => {
  // Not decoration: the map is a curated snapshot with uneven certainty, and a
  // reader deciding whether to act on an entry needs to see whether a date is a
  // founding record or an estimate.
  test('§8 provenance names who, when, at what confidence and from what source', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const p = await page.evaluate((id) => byId[id].d.prov, PROJECT);
    expect(p.on).not.toBe(p.upd);                      // the two differ, so the choice is visible

    const foot = page.locator(`${PANEL} .dt-prov`);
    await expect(foot).toContainText(`Added by ${p.by} · ${p.upd} · confidence ${p.conf}`);
    await expect(foot.locator('.src')).toHaveText(`Source: ${p.src}`);
    // The last-updated date wins over the date added — a reader wants the
    // freshest touch, not the oldest.
    await expect(foot).not.toContainText(p.on);
  });

  test('§8 provenance falls back to the date added when nothing has been updated', async ({ page }) => {
    // Every entry in the payload carries `upd`, so this branch is exercised on
    // provHtml() directly rather than through a card.
    await openMap(page);
    const out = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = provHtml({ by: 'someone', on: '2020-01-02', conf: 'low' });
      const bare = document.createElement('div');
      bare.innerHTML = provHtml({ on: '2020-01-02' });   // no author: no footer at all
      return { text: host.textContent, bare: bare.innerHTML };
    });
    expect(out.text).toBe('Added by someone · 2020-01-02 · confidence low');
    expect(out.bare).toBe('');
  });

  test('§8 every entity in the payload carries a provenance footer', async ({ page }) => {
    await openMap(page);
    const missing = await page.evaluate(() => {
      const host = document.createElement('div');
      const bad = [];
      items.forEach(it => {
        host.innerHTML = cardHtml(it);
        const foot = host.querySelector('.dt-prov');
        if (!foot || !foot.textContent.trim()) bad.push(it.id);
      });
      return bad;
    });
    expect(missing).toEqual([]);
    expect(await page.evaluate(() => items.length)).toBe(460);
  });

  test('§8/§12 provenance is in French in French, confidence label included', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    await open(page, PROJECT, { fly: false });
    const p = await page.evaluate((id) => byId[id].d.prov, PROJECT);
    expect(p.conf).toBe('high');
    await expect(page.locator(`${PANEL} .dt-prov`))
      .toContainText(`Ajouté par ${p.by} · ${p.upd} · confiance élevée`);
    await expect(page.locator(`${PANEL} .dt-prov .src`)).toHaveText(`Source : ${p.src}`);
  });
});

// =========================================================================
test.describe('§8 funding amounts are locale-formatted euros', () => {
  const EUR = 3999976;

  test('§8 the budget reads as euros in English', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate((id) => byId[id].d.funding.eur, PROJECT)).toBe(EUR);
    await open(page, PROJECT, { fly: false });
    const sec = page.locator(`${PANEL} .dt-sec`).filter({ has: page.locator('h4', { hasText: 'Funding' }) });
    expect(await factRows(page, `${PANEL} .dt-sec:has(h4:text-is("Funding"))`)).toEqual({
      Source: 'Horizon Europe', Grant: '101119527', Budget: '€3,999,976',
      'Funding page': 'cordis.europa.eu/project/id/101119527',
    });
    await expect(sec.locator('a')).toHaveAttribute('href', 'https://cordis.europa.eu/project/id/101119527');
  });

  test('§8 the same budget reads as euros in French', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    await open(page, PROJECT, { fly: false });
    const rows = await factRows(page, `${PANEL} .dt-sec:has(h4:text-is("Financement"))`);
    expect(Object.keys(rows)).toEqual(['Source', 'Convention', 'Budget', 'Page de financement']);
    // French puts the symbol last and groups with a (narrow, non-breaking)
    // space; normalise the spacing rather than hard-coding the code point.
    expect(rows.Budget.replace(/[\s   ]/g, ' ')).toBe('3 999 976 €');
  });

  test('§8 no funding amount is ever rendered as a bare number', async ({ page }) => {
    // 65 entities carry an amount, four of them to the cent (€6,881,508.75).
    // A locale-formatted figure keeps every euro, drops the cents, and gains
    // separators; the `money()` fallback ("€" + n) would keep the raw number.
    await openMap(page);
    const bad = await page.evaluate(() => {
      const host = document.createElement('div');
      const out = [];
      let seen = 0;
      items.forEach(it => {
        const eur = it.d.funding && it.d.funding.eur;
        if (!eur) return;
        seen++;
        host.innerHTML = cardHtml(it);
        const row = [...host.querySelectorAll('.dt-facts div')]
          .find(d => d.querySelector('dt').textContent === 'Budget');
        const txt = row ? row.querySelector('dd').textContent : null;
        const digits = txt ? txt.replace(/\D/g, '') : '';
        if (digits !== String(Math.round(eur)) || !txt.includes('€') || txt === '€' + eur) out.push([it.id, txt]);
      });
      return { out, seen };
    });
    expect(bad.out).toEqual([]);
    expect(bad.seen).toBe(65);
  });
});

// =========================================================================
test.describe('§8 boundaries', () => {
  test('§13/§8 the card still opens and pins when localStorage throws', async ({ page }) => {
    // Private-browsing storage throws on every access. lsGet/lsSet swallow it,
    // so the reader loses persistence but not the interface.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('denied', 'SecurityError'); },
      });
    });
    await openMap(page);
    await page.keyboard.press('Escape');               // no "seen" flag: the welcome opened
    await expect(page.locator('#welcome')).not.toHaveClass(/open/);

    await open(page, PROJECT, { fly: false });
    await expect(page.locator(`${FEED_CARD} .dt-name`)).toHaveText('AI4RealNet: AI for Real-world Network Operation');
    await page.click(`${FEED_CARD} .dt-pin`);
    expect((await snapshot(page)).pins).toBe(1);
    await expect(page.locator(`${FEED_CARD} .dt-pin`)).toHaveText('★ Pinned');
  });

  test('§8/inv9 a name carrying an ampersand reads as one', async ({ page }) => {
    // Everything interpolated into the card goes through esc(); the failure
    // mode is a reader seeing "&amp;" in a project title.
    await openMap(page);
    await open(page, 'haiku', { fly: false });
    const name = await page.evaluate(() => byId['haiku'].d.name);
    expect(name).toContain('&');
    await expect(page.locator(`${PANEL} .dt-name`)).toHaveText(name);
    expect(await page.locator(`${PANEL} .dt-name`).innerHTML()).toContain('&amp;');
  });

  test('§8/inv9 every string the card interpolates goes through esc()', async ({ page }) => {
    // The test above cannot fail if esc() is dropped from the heading: a bare
    // "&" is the only metacharacter in the payload, and the parser hands it
    // back out of innerHTML as "&amp;" whether the page escaped it or not. So
    // feed cardHtml() an entity with markup in every field — the shape the
    // payload will have the day someone's project is called "Trust & Safety
    // <AI>" — and read what comes back out of the document.
    await openMap(page);
    const out = await page.evaluate((it) => {
      const host = document.createElement('div');
      host.innerHTML = cardHtml(it);
      const texts = sel => [...host.querySelectorAll(sel)].map(e => e.textContent);
      return {
        injected: [...host.querySelectorAll('b, i, img, script, iframe')].map(e => e.tagName),
        name: host.querySelector('.dt-name').textContent,
        meta: host.querySelector('.dt-meta').textContent,
        desc: texts('.dt-desc'),
        tags: texts('.dt-tag'),
        doms: texts('.dt-dom'),
        span: host.querySelector('.dt-span').textContent,
        chips: texts('.dt-chip'),
        lists: texts('.dt-list li'),
        ms: texts('.dt-ms li'),
        identity: [...host.querySelectorAll(':scope > .dt-facts > div')]
          .map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]),
        secFacts: [...host.querySelectorAll('.dt-sec .dt-facts > div')]
          .map(d => d.querySelector('dd').textContent),
        prov: host.querySelector('.dt-prov').textContent,
        href: host.querySelector('.dt-actions a').getAttribute('href'),
      };
    }, hostileEntity(HOSTILE));

    // Nothing the entity said became part of the document…
    expect(out.injected).toEqual([]);
    // …and every string comes back exactly as the data held it, markup and all.
    const H = HOSTILE;
    expect(out.name).toBe(`${H} name`);
    expect(out.meta).toBe(`${H} city, ${H} cc · ${H} when`);
    expect(out.desc).toEqual([`${H} desc`]);
    expect(out.tags).toEqual([`${H} kind`, `${H} status`, `${H} tier`]);
    expect(out.doms).toEqual(['multi/other', `${H} dom`]);
    expect(out.span).toBe(`${H} start → ${H} end`);
    expect(out.chips).toEqual([`${H} focus`, `${H} applies`]);
    expect(out.ms).toEqual([`${H} date${H} ms`]);
    expect(out.lists).toEqual([`${H} partner ${H} role · ${H} ct`,
      `${H} demo`, `${H} deliv`, `${H} facility`]);
    expect(out.secFacts).toEqual([`${H} source`, `${H} call`, `${H} grant`,
      `${H} infra`, `${H} operator`, `${H} access`, `${H} capacity`, 'example.org/o']);
    expect(out.prov).toBe(`Added by ${H} by · ${H} upd · confidence ${H} confSource: ${H} src`);
    // Attributes too: a quote that survives unescaped ends the attribute early.
    expect(out.href).toBe(`https://example.org/?q=${H}`);

    // The same synthetic entity carries all ten of §8 item 6's fields at once,
    // which no card in the payload does — so this is also where the full list
    // and its order are pinned.
    expect(out.identity).toEqual([
      ['Affiliation', `${H} org`],
      ['Parent body', `${H} parent`],
      ['Jurisdiction', `${H} juris`],
      ['Issuing body', `${H} issuer`],
      ['Legal status', `${H} legal`],
      ['Adopted', `${H} adopted`],
      ['Licence', `${H} licence`],
      ['Maintainer', `${H} maintainer`],
      ['Repository', 'example.org/repo'],
      ['Reach', `${H} reach`],
    ]);
    expect(out.identity.map(([k]) => k)).toEqual(FACT_ORDER.map(([k]) => k));
  });

  test('§8 a card with one related entity still counts it, and says one', async ({ page }) => {
    // n=1 is where a count rendered as a label rather than a number would show.
    // The entity is found in the payload rather than by asking relSections()
    // which card has one row — a count checked against the function that
    // produced it agrees with itself no matter what either of them does.
    await openMap(page);
    const roles = await page.evaluate((id) => {
      const known = new Set([...DATA.PROJECTS, ...DATA.TEAMS, ...DATA.COMMONS, ...DATA.FRAMEWORKS].map(d => d.id));
      const a = [...DATA.COMMONS, ...DATA.FRAMEWORKS].find(x => x.id === id);
      return { createdBy: (a.createdBy || []).filter(x => known.has(x)),
        usedBy: (a.usedBy || []).filter(x => known.has(x)) };
    }, ONE_REL);
    // OpenSTEF was built by Alliander and by nobody else on the map: one
    // section, one row, and the heading says which relationship it is.
    expect(roles).toEqual({ createdBy: ['alliander'], usedBy: [] });

    await open(page, ONE_REL, { fly: false });
    expect(await relCounts(page)).toEqual({ 'Created by': 1 });
    await expect(page.locator(`${PANEL} .rel-row`)).toHaveCount(1);
    expect(await page.$$eval(`${PANEL} .rel-row`, bs => bs.map(b => b.dataset.open))).toEqual(['alliander']);
  });
});
