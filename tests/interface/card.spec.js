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
// §3.2 is explicit that the figures are not the claim: "Counts are a snapshot
// and move with every upstream regeneration; the shape of the table is what is
// normative, not the figures." That holds just as well for one entity's partner
// list, its budget or the length of its longest description — so this file pins
// almost nothing from the data. `window.HAI_DATA` is the payload the page
// actually loaded (hai-data.js, with any pending additions merged over it by
// id), every expectation below is built from it or from a rule the spec states,
// and the comparison against what the interface rendered stays exact.
//
// What *is* written out literally is the interface's own vocabulary: §8's
// section titles, §8 item 6's field labels, the short domain badges. Those live
// in the page's I18N table, so pinning them makes a renamed label fail here
// instead of passing against itself.
//
// Two entities are still named. They are the subjects of the tests that use
// them, not stand-ins for a shape: AI4RealNet is the richest project card on the
// map, and the RTE group is the team the commons were built by and are used by.
// Everything either of them is asked to prove is derived from their own payload.
const PROJECT = 'ai4realnet';
const TEAM = 'rte-rd-grid-ai';

// The card surfaces. With the feed open — the default above 840px — the
// floating panel is display:none (`body.feed-open #detail`), but it is still
// rendered: invariant 5 is about the markup, not about which one is on screen.
const PANEL = '#dt-body';
const FEED_CARD = '.fd-item.open .fd-card';

// §8's sections, in the order the spec lists them, each with what the payload
// has to hold for that section to appear. Keeping the two together is what lets
// a card's headings be *predicted* from the data — `secsOf()` below — rather
// than pinned per entity, which is how a regeneration used to void these tests.
// The titles are hard-coded for the reason given above.
const SEC_SOURCES = [
  ['Focus areas', r => (r.focus || []).length > 0],
  ['Timeline', r => !!r.timeline && (!!r.timeline.start || !!r.timeline.end
    || (r.timeline.milestones || []).length > 0)],
  ['Consortium', r => (r.consortium || []).length > 0],
  ['Members', r => (r.members || []).length > 0],
  ['Funding', r => !!r.funding && ['source', 'call', 'grant', 'eur', 'url'].some(k => r.funding[k])],
  ['Infrastructure', r => !!r.infra && ['kind', 'operator', 'access', 'capacity'].some(k => r.infra[k])],
  ['Demonstrators', r => (r.demos || []).length > 0],
  ['Deliverables', r => (r.delivs || []).length > 0],
  ['Facilities hosted', r => (r.facilities || []).length > 0],
  ['Applies to', r => (r.appliesTo || []).length > 0],
  ['Builds on', r => r.resolvedRefs.length > 0],
  ['Publications', r => r.papers > 0],
  ['Other links', r => r.otherLinks > 0],
];
const SEC_ORDER = SEC_SOURCES.map(([title]) => title);
const REL_ORDER = ['Consortium teams', 'Consortium clusters', 'Member teams', 'Projects & programmes', 'Member of',
  'Created', 'Builds on', 'Created by', 'Used by'];
const CANON = [...SEC_ORDER, ...REL_ORDER];

// §8's short domain labels — the ones the card uses, as opposed to the long
// filter names. Vocabulary again, so written out here.
const BADGE = { energy: 'energy', aviation: 'aviation', rail: 'rail', transport: 'surface transport',
  telecom: 'telecom', utility: 'water/gas', health: 'health', manufacturing: 'manufacturing',
  compute: 'compute', cluster: 'AI network', simulation: 'socio-tech sim.', hf: 'human factors',
  xai: 'XAI', multi: 'multi/other', maritime: 'maritime', nuclear: 'nuclear', defense: 'defence' };

// §8 item 6's identity fields, in the order the spec lists them, with the
// payload field each one reads — the same arrangement as SEC_SOURCES, and for
// the same two reasons. It predicts one card's grid from that card's payload,
// and it doubles as a way to *find* a card by the shape of its identity grid
// (`idLabels()` below), which is how the tests that pin exact rows pick their
// subjects now that none of them may name an id.
const FACT_ORDER = [
  // The organisation a team belongs to (data/organisations.yml), when its own
  // affiliation does not already name it.
  ['Organisation', d => !!(d.organisation && d.organisation.name
    && d.organisation.name !== (d.affiliation || {}).org
    && d.organisation.name !== (d.affiliation || {}).parent)],
  ['Affiliation', d => d.affiliation && d.affiliation.org && d.affiliation.org !== d.name],
  ['Parent body', d => !!(d.affiliation && d.affiliation.parent)],
  ['Jurisdiction', d => !!d.jurisdiction],
  ['Issuing body', d => !!d.issuer],
  ['Legal status', d => !!d.legal],
  ['Adopted', d => !!d.adopted],
  ['Licence', d => !!d.license],
  ['Maintainer', d => !!d.maintainer],
  ['Repository', d => !!(d.repo && d.repo !== d.url)],
  ['Reach', d => !!d.size && d.layer !== 'cluster'],
  // A cluster's size is its membership: same field, its own label.
  ['Membership', d => !!d.size && d.layer === 'cluster'],
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
    organisation: { name: `${bad} organisation` },
    affiliation: { org: `${bad} org`, parent: `${bad} parent` },
    jurisdiction: `${bad} juris`, issuer: { org: `${bad} issuer` },
    legal: `${bad} legal`, adopted: `${bad} adopted`, license: `${bad} licence`,
    maintainer: { org: `${bad} maintainer` }, repo: 'https://example.org/repo', size: `${bad} reach`,
    focus: [`${bad} focus`], appliesTo: [`${bad} applies`],
    timeline: { start: `${bad} start`, end: `${bad} end`, milestones: [{ date: `${bad} date`, label: `${bad} ms` }] },
    consortium: [{ org: `${bad} partner`, role: `${bad} role`, country: `${bad} ct` }],
    members: [{ org: `${bad} member`, role: `${bad} mrole`, country: `${bad} mct` }],
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
  const known = new Set([...DATA.PROJECTS, ...DATA.CLUSTERS, ...DATA.TEAMS, ...DATA.COMMONS, ...DATA.FRAMEWORKS].map(d => d.id));
  const out = new Set();
  const add = i => { if (known.has(i)) out.add(i); };
  if (!known.has(x)) return [];
  DATA.EDGES.forEach(e => {
    const s = e.project || e.cluster;                  // a project or a cluster
    if (!known.has(s)) return;                         // the page skips these too
    if (s === x) add(e.team);
    else if (e.team === x) add(s);
  });
  [...DATA.COMMONS, ...DATA.FRAMEWORKS].forEach(a => {
    const ends = [...(a.createdBy || []), ...(a.usedBy || [])];
    if (ends.includes(x)) add(a.id);
    if (a.id === x) ends.forEach(add);
  });
  return [...out];
}, id);

/** The payload the page loaded, one row per entity, with the two long
 *  descriptions reduced to their lengths — every selection below is a question
 *  about an entity's *shape*, and the prose would double what crosses the
 *  bridge. The computed extras (which references resolve, which assets name
 *  this entity) come straight out of `window.HAI_DATA` rather than out of the
 *  page's `byId` / `neighbors`, so a card's expected contents are never read
 *  back from the structures the card itself reads. */
const corpus = (page) => page.evaluate(() => {
  const D = window.HAI_DATA;
  const all = [['project', D.PROJECTS], ['team', D.TEAMS], ['cluster', D.CLUSTERS],
    ['commons', D.COMMONS], ['framework', D.FRAMEWORKS]]
    .flatMap(([kind, arr]) => arr.map(d => ({ kind, d })));
  const known = new Set(all.map(r => r.d.id));
  const assets = all.filter(r => r.kind === 'commons' || r.kind === 'framework').map(r => r.d);
  return all.map(({ kind, d }) => {
    const { desc, desc_en: en, desc_fr: fr, ...rest } = d;
    const lk = d.links || {};
    const mates = new Set();
    const kindOf = new Map(all.map(x => [x.d.id, x.kind]));
    D.EDGES.forEach(e => {                               // the page skips unknown sources too
      const s = e.project || e.cluster;
      if (!known.has(s)) return;
      if (s === d.id && known.has(e.team)) mates.add(e.team);
      else if (e.team === d.id && known.has(s)) mates.add(s);
    });
    // `layer` rather than `kind`: the payload's own `kind` field ("software",
    // "horizon_europe") is a tag on the card and must not be shadowed.
    return { ...rest, layer: kind, geo: d.lat != null && d.lon != null,
      enLen: (en || desc || '').length, frLen: (fr || desc || '').length,
      enParas: (en || desc || '').split('\n\n').length,
      descOnly: !en && !fr && !!desc,
      papers: (lk.papers || []).length,
      otherLinks: ['official', 'docs', 'linkedin', 'twitter'].filter(k => lk[k]).length,
      resolvedRefs: (d.refs || []).filter(x => known.has(x)),
      resolvedCons: (d.consortium || []).filter(c => c.ref && known.has(c.ref)),
      createdHere: (d.createdBy || []).filter(x => known.has(x)),
      usedHere: (d.usedBy || []).filter(x => known.has(x)),
      mates: [...mates],
      matesBy: Object.fromEntries(['project', 'team', 'cluster'].map(k =>
        [k, [...mates].filter(x => kindOf.get(x) === k)])),
      madeAssets: assets.filter(a => (a.createdBy || []).includes(d.id)).map(a => a.id),
      usedAssets: assets.filter(a => (a.usedBy || []).includes(d.id)).map(a => a.id) };
  });
});

/** §8's related sections for a payload row: heading → ids, in render order. The
 *  page reads them off `neighbors` and `byId`; this reads the relations out of
 *  the payload, which is the only way the counts mean anything. */
const relOf = (r) => {
  const o = {};
  const put = (head, ids) => { const l = [...new Set(ids)]; if (l.length) o[head] = l; };
  if (r.layer === 'project' || r.layer === 'team' || r.layer === 'cluster') {
    if (r.layer === 'project') {
      put('Consortium teams', r.matesBy.team);
      put('Consortium clusters', r.matesBy.cluster);
    }
    if (r.layer === 'cluster') {
      put('Member teams', r.matesBy.team);
      put('Projects & programmes', r.matesBy.project);
    }
    if (r.layer === 'team') {
      put('Projects & programmes', r.matesBy.project);
      put('Member of', r.matesBy.cluster);
    }
    put('Created', r.madeAssets);
    put('Builds on', r.usedAssets);
  } else {
    put('Created by', r.createdHere);
    put('Used by', r.usedHere);
  }
  return o;
};

/** The section headings one card should carry, predicted from the payload:
 *  §8's own sections for what the entity holds, then its related sections. */
const secsOf = (r) => [...SEC_SOURCES.filter(([, has]) => has(r)).map(([title]) => title),
  ...Object.keys(relOf(r))];

/** §8's skeleton for one card: the eyebrow, the name, the place line, the tags
 *  when there are any, the domains, one paragraph per paragraph of description,
 *  the actions, the identity grid when §8 item 6 has anything to say, then the
 *  sections and the provenance footer. */
const skeletonOf = (r) => [
  'div.dt-kind', 'h2.dt-name', 'p.dt-meta',
  ...(r.kind || r.type || r.status || r.tier ? ['div.dt-tags'] : []),
  'div.dt-doms',
  ...Array(r.enParas).fill('p.dt-desc'),
  'div.dt-actions',
  ...(FACT_ORDER.some(([, has]) => has(r)) ? ['dl.dt-facts'] : []),
  ...Array(secsOf(r).length).fill('section.dt-sec'),
  ...(r.prov && r.prov.by ? ['p.dt-prov'] : []),
];

/** The curves the map draws for one entity — edge *entries*, not neighbours: a
 *  team that both built an asset and uses it gets two, and geometry only exists
 *  when both ends are placed. With `other`, only the curves between that pair.
 *  One line per organisation: an edge carrying `via` draws nothing of its own,
 *  it shares the line of the card it names, which lights for either card. */
const fanFromData = (page, id, other = null) => page.evaluate(([x, y]) => {
  const D = window.HAI_DATA;
  const placed = new Map();
  [...D.PROJECTS, ...D.CLUSTERS, ...D.TEAMS, ...D.COMMONS, ...D.FRAMEWORKS]
    .forEach(d => placed.set(d.id, d.lat != null && d.lon != null));
  const drawn = [], groups = new Map();
  const add = (a, b) => {
    if (!placed.has(a) || !placed.has(b)) return -1;     // unresolvable: no link, no curve
    if (!(placed.get(a) && placed.get(b))) return -1;
    drawn.push({ a, b }); return drawn.length - 1;
  };
  D.EDGES.forEach(e => {
    const s = e.project || e.cluster;
    if (!placed.has(s) || !placed.has(e.team)) return;
    const key = s + '|' + (e.via || e.team);
    if (!groups.has(key)) groups.set(key, { members: [], lines: [] });
    const G = groups.get(key);
    G.members.push(e.team);
    const i = add(s, e.team);
    if (i >= 0) { if (e.via) G.lines.push(i); else G.lines.unshift(i); }
  });
  [...D.COMMONS, ...D.FRAMEWORKS].forEach(a => {
    (a.createdBy || []).forEach(u => add(u, a.id));
    (a.usedBy || []).forEach(u => add(a.id, u));
  });
  // One line per organisation (§4.3): every link has its path, and a group of
  // cards of one organisation shows one of them — its head's, or the focused
  // card's own path when the focus belongs to the group.
  const shown = new Set(drawn.map((_, i) => i));
  for (const G of groups.values()) {
    G.lines.forEach(i => { drawn[i].shared = G.members; shown.delete(i); });
    if (!G.lines.length) continue;
    const own = G.members.includes(x) ? G.lines.find(j => drawn[j].b === x) : undefined;
    shown.add(own != null ? own : G.lines[0]);
  }
  const on = (e, k) => e.a === k || e.b === k || (e.shared || []).includes(k);
  return [...shown].filter(i => on(drawn[i], x) && (!y || on(drawn[i], y))).length;
}, [id, other]);

/** The vocabulary table, which ships with the data (§3.4), and the lookup rule
 *  the spec states for it: the label for the reader's language, or the key with
 *  its underscores opened out when the taxonomy does not know it. Reading the
 *  table is reading the payload — choosing the right group for a field, and
 *  falling back when it misses, is the card's job and stays under test. */
const taxonomy = (page) => page.evaluate(() => window.HAI_DATA.TAXO || {});
const label = (taxo, group, key, lang = 'en') => {
  if (!key) return '';
  const e = taxo[group] && taxo[group][key];
  return e ? (e[lang] || e.en) : String(key).replace(/_/g, ' ');
};

/** §8's consortium row, as text: the partner's legal name, then the entity it
 *  resolves to when that name differs, then its role and its country. Built
 *  from the payload — which is what puts the row's contents on trial, rather
 *  than letting them agree with themselves. */
const consRowText = (c, names, taxo) => {
  const dest = c.ref ? names.get(c.ref) : null;
  const bits = [c.role ? label(taxo, 'role', c.role) : '', c.country].filter(Boolean).join(' · ');
  return `${c.org}${dest && dest !== c.org ? ` → ${dest}` : ''}${bits ? ` ${bits}` : ''}`;
};

/** §8's link text: the URL without scheme, "www." or trailing slash, elided
 *  past 38 characters. */
const linkText = (u) => {
  const txt = String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return txt.length > 38 ? txt.slice(0, 36) + '…' : txt;
};

/** §8's euro amount: whole euros, grouped, the symbol where the locale puts it.
 *  Built here from the figure in the payload rather than asked of the page's
 *  own `money()`, and normalised for the separator's code point only. */
const euros = (n, lang = 'en') => {
  const digits = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return lang === 'fr' ? `${digits} €` : `€${digits.replace(/ /g, ',')}`;
};

/** The identity rows §8 item 6 asks for, for one payload row: the labels in the
 *  spec's order, which doubles as a way to select a card by the *shape* of its
 *  identity grid rather than by id. */
const idLabels = (r) => FACT_ORDER.filter(([, has]) => has(r)).map(([l]) => l);

/** The payload row for one id, asserted present: a test about a named subject
 *  means nothing if that subject has left the map. */
const rowOf = (rows, id) => {
  const r = rows.find(x => x.id === id);
  expect(r, `${id} is in the payload`).toBeTruthy();
  return r;
};

/** Exactly one row of the corpus, by property rather than by id. The count is
 *  asserted so that a regeneration which makes the choice ambiguous says so
 *  here instead of quietly testing a different entity. */
const only = (rows, pred, why) => {
  const hit = rows.filter(pred);
  expect(hit.map(r => r.id), `exactly one entity ${why}`).toHaveLength(1);
  return hit[0];
};

/** The first row matching a property, in payload order, with the match count
 *  reported when there is none. */
const any = (rows, pred, why) => {
  const hit = rows.filter(pred);
  expect(hit.length > 0, `at least one entity ${why}`).toBe(true);
  return hit[0];
};

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
    // …and it really is this entity's card. Named from the payload: a literal
    // here goes vacuous the day the project is renamed upstream.
    await expect(page.locator(`${PANEL} .dt-name`))
      .toHaveText(await page.evaluate((id) => byId[id].d.name, PROJECT));

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
    // Picked for the property rather than by id — a framework with no
    // coordinates — so a regeneration moves the choice instead of voiding it.
    const fw = any(await corpus(page), r => r.layer === 'framework' && !r.geo,
      'is a framework with no coordinates');
    await open(page, fw.id, { fly: false });
    expect(await page.evaluate((id) => state.inView.has(id), fw.id)).toBe(false);
    expect(await page.evaluate((id) => byId[id].geo, fw.id)).toBe(false);

    expect(await page.locator(PANEL).innerHTML()).toBe(await page.locator(FEED_CARD).innerHTML());
    await expect(page.locator(`${FEED_CARD} .dt-name`)).toHaveText(fw.name);
  });

  test('inv5 survives a pin taken from one surface', async ({ page }) => {
    await openMap(page);
    const commons = only(await corpus(page), r => r.layer === 'commons' && !r.geo,
      'is a commons with no coordinates');
    await open(page, commons.id, { fly: false });
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
    const commons = any(await corpus(page), r => r.layer === 'commons', 'is a commons');
    await open(page, commons.id, { fly: false });
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
    await expect(page.locator(`${PANEL} .dt-name`))
      .toHaveText(await page.evaluate((id) => byId[id].d.name, TEAM));
    expect(await page.$$eval('.mk.focus', els => els.map(e => e.dataset.id))).toEqual([TEAM]);
    // §14: aria-expanded says which feed row carries the open card, and only one does.
    await expect(page.locator('.fd-item.open')).toHaveCount(1);
    expect(await page.$$eval('.fd-row[aria-expanded="true"]', bs => bs.map(b => b.dataset.open))).toEqual([TEAM]);
  });
});

// =========================================================================
test.describe('§8 organisation-level links', () => {
  // Derived from the payload: an organisation-level link that draws its own
  // line, the organisation its team card belongs to, and a unit-level link of
  // the same source when there is one.
  const pick = (page) => page.evaluate(() => {
    const e = DATA.EDGES.find((x) => x.org && !x.via);
    const src = e.project || e.cluster;
    const team = DATA.TEAMS.find((x) => x.id === e.team);
    const unit = DATA.EDGES.find((x) => !x.org && (x.project || x.cluster) === src);
    return { source: src, team: e.team, teamName: team.name, org: team.organisation.name,
      sourceName: byId[src].d.name, unit: unit ? unit.team : null };
  });
  const row = (page, id) => page.locator(`${PANEL} .rel-row[data-open="${id}"]`).first();

  test('§8 the row says "via its organisation", names the organisation on hover, and keeps the card name readable', async ({ page }) => {
    await openMap(page);
    await hideFeed(page);
    const fx = await pick(page);
    await open(page, fx.source, { fly: false });
    const r = row(page, fx.team);
    await expect(r.locator('.lvl')).toHaveText('via its organisation');
    await expect(r).toHaveAttribute('title',
      `${fx.org} takes part through a unit that has no card of its own; this card belongs to it.`);
    await expect(r.locator('.lvl')).toHaveAttribute('aria-label',
      `${fx.org} takes part through a unit that has no card of its own; this card belongs to it.`);
    // The tag sits under the name rather than beside it, so the name keeps the
    // row's width, and the full name is one hover away.
    await expect(r.locator('.nm')).toHaveAttribute('title', fx.teamName);
    expect((await r.locator('.nm').boundingBox()).width, 'the name is not squeezed by the tag')
      .toBeGreaterThan(100);
    if (fx.unit) await expect(row(page, fx.unit).locator('.lvl')).toHaveCount(0);

    // From the team's side the sentence turns round: its organisation takes
    // part, not necessarily the team.
    await open(page, fx.team, { fly: false });
    await expect(row(page, fx.source)).toHaveAttribute('title',
      `${fx.org}, this team\u2019s organisation, takes part — not necessarily this team itself.`);
  });

  test('§8 the organisation-level sentences are French in French', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    await hideFeed(page);
    const fx = await pick(page);
    await open(page, fx.source, { fly: false });
    await expect(row(page, fx.team).locator('.lvl')).toHaveText('via l\u2019organisation');
    await expect(row(page, fx.team)).toHaveAttribute('title',
      `${fx.org} participe par une unité qui n\u2019a pas de fiche ; cette fiche lui appartient.`);
  });
});

test.describe('§8 section order, and omission when empty', () => {
  test('§8 a project card renders the sections the spec lists, in that order', async ({ page }) => {
    await openMap(page);
    const row = rowOf(await corpus(page), PROJECT);
    await open(page, PROJECT, { fly: false });

    // Predicted from the payload through SEC_SOURCES — §8's sections, each with
    // what it is built from — rather than pinned to the shape this project
    // happens to have today: upstream owns the shape, the page owns the order
    // and the omissions, and only the latter is on trial here.
    expect(await sections(page)).toEqual(secsOf(row));
    // The whole skeleton, in order: eyebrow, name, place, tags, domains, one
    // paragraph per paragraph of description, actions, the identity grid when
    // §8 item 6 has anything to say (a project normally carries none of those
    // fields, so normally no grid), then the sections, then provenance.
    expect(await page.$$eval(`${PANEL} > *`, els => els.map(e => e.tagName.toLowerCase() + '.' + e.className)))
      .toEqual(skeletonOf(row));
  });

  test('§8 a team card puts its three related sections last, before provenance', async ({ page }) => {
    await openMap(page);
    // Chosen for the property the test is about: a team that sits on all three
    // sides of the relation graph — in consortia, having built assets, and
    // using them. Which team that is, is upstream's business.
    const row = any(await corpus(page), r => r.layer === 'team' && Object.keys(relOf(r)).length === 3,
      'is a team with all three related sections');
    await open(page, row.id, { fly: false });
    const rel = Object.keys(relOf(row));
    expect(await sections(page)).toEqual(secsOf(row));
    // Last, and in §8's order — not interleaved with the entity's own sections.
    expect((await sections(page)).slice(-rel.length)).toEqual(rel);
    expect(rel).toEqual(REL_ORDER.filter(h => rel.includes(h)));
    expect(await page.$$eval(`${PANEL} > *`, els => els[els.length - 1].className)).toBe('dt-prov');
  });

  test('§8 no card in the payload renders its sections out of order', async ({ page }) => {
    // The order is the claim for every card in the payload, not just the two
    // above: a new `dtSec()` call dropped in at the wrong line is exactly the
    // mistake §17 warns about, and it shows up nowhere else. Because the
    // expectation is now predicted from each entity's own payload, this also
    // says that no card grows a section the data has nothing for, or silently
    // drops one it does.
    await openMap(page);
    const rows = await corpus(page);
    const got = await page.evaluate(() => {
      const host = document.createElement('div');
      const o = {};
      items.forEach(it => {
        host.innerHTML = cardHtml(it);
        o[it.id] = [...host.querySelectorAll('.dt-sec h4')].map(h => {
          const em = h.querySelector('em');
          return em ? h.textContent.replace(em.textContent, '').trim() : h.textContent.trim();
        });
      });
      return o;
    });
    const bad = rows.filter(r => JSON.stringify(got[r.id]) !== JSON.stringify(secsOf(r)))
      .map(r => ({ id: r.id, want: secsOf(r), got: got[r.id] }));
    expect(bad).toEqual([]);
    // And the sequence itself, read off the rendered headings against §8's
    // canonical order — which catches a reordering that SEC_SOURCES and
    // `cardHtml()` would have to get wrong in the same way to hide.
    const outOfOrder = Object.entries(got).filter(([, titles]) => {
      let p = 0;
      return titles.some(title => {
        const at = CANON.indexOf(title, p);
        if (at < 0) return true;
        p = at + 1;
        return false;
      });
    });
    expect(outOfOrder).toEqual([]);
  });

  test('§8 an entity with nothing to show omits every empty section', async ({ page }) => {
    await openMap(page);
    // "Nothing to show" is the property, not the entity: a card whose payload
    // fills exactly two of §8's sections and whose relation graph is empty — no
    // consortium, no funding, no infrastructure, no neighbours. Those sections
    // must be absent, not present and empty.
    const bare = any(await corpus(page), r => secsOf(r).join('|') === 'Focus areas|Timeline',
      'has only its focus areas and its timeline to show');
    await open(page, bare.id, { fly: false });
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
    // section most likely to render as an empty heading. An entity with papers
    // and none of those four fields is the case: Publications appears, Other
    // links must not.
    await openMap(page);
    const row = any(await corpus(page), r => r.papers > 0 && r.otherLinks === 0,
      'has publications and no other links');
    await open(page, row.id, { fly: false });
    const secs = await sections(page);
    expect(secs).toContain('Publications');
    expect(secs).not.toContain('Other links');
    await expect(page.locator(`${PANEL} .dt-sec`).filter({ hasText: 'Publications' }).locator('li'))
      .toHaveCount(row.papers);
  });

  test('§8 the eyebrow, the name and the place line', async ({ page }) => {
    await openMap(page);
    // A placed project that carries a compact span, so all three parts of the
    // meta line are exercised; the strings themselves come from its payload.
    const row = any(await corpus(page), r => r.layer === 'project' && r.city && r.country && r.when,
      'is a placed project with a compact span');
    await open(page, row.id, { fly: false });
    await expect(page.locator(`${PANEL} .dt-kind`)).toHaveText('Project / programme');
    await expect(page.locator(`${PANEL} .dt-kind .glyph svg`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} .dt-name`)).toHaveText(row.name);
    // "city, country · span" — the span is the entity's compact `when`.
    await expect(page.locator(`${PANEL} .dt-meta`))
      .toHaveText(`${row.city}, ${row.country} · ${row.when}`);
  });

  test('§8 an entity with no coordinates says so instead of naming a place', async ({ page }) => {
    await openMap(page);
    const row = any(await corpus(page), r => !r.geo && !r.city && !r.country && !r.when,
      'has no coordinates and nothing else to put on the place line');
    await open(page, row.id, { fly: false });
    await expect(page.locator(`${PANEL} .dt-meta`)).toHaveText('No geographic anchor');
  });

  test('§8 the tags row is kind-or-type, status, tier — and only those present', async ({ page }) => {
    await openMap(page);
    const rows = await corpus(page);
    const taxo = await taxonomy(page);
    // The labels are §3.4 lookups in the vocabulary that ships with the data, so
    // the row is rebuilt here by the rule the spec states and compared whole.
    // Which entity has which tag is upstream's business; that a tier the data
    // does not carry must not appear is the page's.
    const tags = (r) => [r.kind ? label(taxo, 'kind', r.kind) : (r.type ? label(taxo, 'type', r.type) : ''),
      label(taxo, 'status', r.status), label(taxo, 'tier', r.tier)].filter(Boolean);
    const shown = () => page.$$eval(`${PANEL} .dt-tag`, ts => ts.map(t => t.textContent));

    const all3 = any(rows, r => r.kind && r.status && r.tier, 'carries a kind, a status and a tier');
    await open(page, all3.id, { fly: false });
    expect(tags(all3)).toHaveLength(3);
    expect(await shown()).toEqual(tags(all3));

    const noTier = any(rows, r => r.kind && r.status && !r.tier, 'carries no tier');
    await open(page, noTier.id, { fly: false });
    expect(tags(noTier)).toHaveLength(2);
    expect(await shown()).toEqual(tags(noTier));

    const typed = any(rows, r => !r.kind && r.type && r.status && !r.tier,
      'has a `type` where another has a `kind`');
    await open(page, typed.id, { fly: false });
    expect(tags(typed)).toHaveLength(2);
    expect(await shown()).toEqual(tags(typed));
  });

  test('§8 one domain badge per domain, in payload order, each with its dot', async ({ page }) => {
    await openMap(page);
    // A card spanning several domains, so "in payload order" has something to
    // say; §8's short badge labels are the page's own vocabulary, hence BADGE.
    const row = any(await corpus(page), r => (r.domains || []).length >= 3,
      'spans three or more domains');
    await open(page, row.id, { fly: false });
    const doms = await page.evaluate((id) => byId[id].domains, row.id);
    expect(doms).toEqual(row.domains);                  // the page's read of the payload
    expect(doms.filter(x => !BADGE[x])).toEqual([]);    // every domain has a badge label
    expect(await page.$$eval(`${PANEL} .dt-dom`, es => es.map(e => e.textContent)))
      .toEqual(doms.map(x => BADGE[x]));
    await expect(page.locator(`${PANEL} .dt-dom .dot`)).toHaveCount(doms.length);
  });

  test('§8 the facts grid names a framework\'s jurisdiction and issuing body', async ({ page }) => {
    await openMap(page);
    const taxo = await taxonomy(page);
    // Selected by the shape of its identity grid — jurisdiction and a linked
    // issuing body, and no section grid for factRows() to sweep up as well.
    const row = any(await corpus(page), r => r.layer === 'framework'
      && idLabels(r).join('|') === 'Jurisdiction|Issuing body'
      && r.issuer.url && !r.funding && !r.infra && r.otherLinks === 0,
      'has a jurisdiction and a linked issuing body and nothing else');
    await open(page, row.id, { fly: false });
    expect(await factRows(page)).toEqual({
      Jurisdiction: label(taxo, 'jurisdiction', row.jurisdiction),
      'Issuing body': row.issuer.org,
    });
    // The issuing body is a link out, not plain text.
    await expect(page.locator(`${PANEL} .dt-facts a`)).toHaveAttribute('href', row.issuer.url);
  });

  test('§8 the facts grid drops a row that only repeats what is already shown', async ({ page }) => {
    // Two guards in `cardHtml` exist so the grid does not restate the heading:
    // an affiliation identical to the name, and a repository identical to the
    // site already on the Visit button. Both are properties, so both are how
    // the entities below are found.
    await openMap(page);
    const rows = await corpus(page);
    const selfNamed = any(rows, r => r.affiliation && r.affiliation.org === r.name,
      'gives its own name as its affiliation');
    await open(page, selfNamed.id, { fly: false });
    expect(Object.keys(await factRows(page))).not.toContain('Affiliation');

    const selfHosted = any(rows, r => r.repo && r.repo === r.url
      && idLabels(r).join('|') === 'Licence|Maintainer' && !r.funding && !r.infra && r.otherLinks === 0,
      'points its repository at the site on its Visit button');
    await open(page, selfHosted.id, { fly: false });
    const grid = await factRows(page);
    expect(Object.keys(grid)).not.toContain('Repository');
    expect(grid).toEqual({ Licence: selfHosted.license, Maintainer: selfHosted.maintainer.org });
  });

  test('§8 the facts grid carries the identity fields the spec lists, in order', async ({ page }) => {
    await openMap(page);
    // The mirror of the card above: a repository that is *not* the site already
    // on the Visit button earns its row, and a reach follows it.
    const row = any(await corpus(page), r => idLabels(r).join('|') === 'Licence|Maintainer|Repository|Reach'
      && !r.funding && !r.infra && r.otherLinks === 0,
      'carries a licence, a maintainer, a repository of its own and a reach');
    await open(page, row.id, { fly: false });
    // Order follows §8 item 6; the repository reads as a URL stripped of its
    // scheme, which is §8's rule for every link in the grid.
    expect(Object.entries(await factRows(page))).toEqual([
      ['Licence', row.license],
      ['Maintainer', row.maintainer.org],
      ['Repository', linkText(row.repo)],
      ['Reach', row.size],
    ]);
  });

  test('§8 the facts grid carries all four of a standard\'s identity fields, in order', async ({ page }) => {
    // The two cards above cover six of §8 item 6's fields and neither
    // carries `legal` or `adopted`. A grid read back as an object compares
    // equal whatever the order, so this one reads it as a list: the sequence is
    // the claim, not just the contents.
    await openMap(page);
    const taxo = await taxonomy(page);
    const row = any(await corpus(page),
      r => idLabels(r).join('|') === 'Jurisdiction|Issuing body|Legal status|Adopted',
      'carries all four of a standard\'s identity fields');

    await open(page, row.id, { fly: false });
    expect(await identityRows(page)).toEqual([
      ['Jurisdiction', label(taxo, 'jurisdiction', row.jurisdiction)],
      ['Issuing body', row.issuer.org],
      ['Legal status', label(taxo, 'legal', row.legal)],
      ['Adopted', row.adopted],
    ]);
    // Both halves are vocabulary lookups, not raw keys: a raw "in_force"
    // reaching the reader is the §3.4 failure, and an & in the issuer name is
    // invariant 9's. The lookup has to move the string, or this says nothing.
    expect(label(taxo, 'legal', row.legal)).not.toBe(row.legal);
    await expect(page.locator(`${PANEL} > .dt-facts`)).not.toContainText(row.legal);
  });

  test('§8 no card in the payload drops or reorders an identity field', async ({ page }) => {
    // §8 item 6 lists its fields in one order, for every card in the payload.
    // The prediction is built here from the payload and from FACT_ORDER, so a
    // row deleted from
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
          o[it.id] = { layer: it.kind, organisation: d.organisation,
            name: d.name, url: d.url, affiliation: d.affiliation, jurisdiction: d.jurisdiction,
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
    // "Taxonomy labels" is the claim: the keys in the payload are
    // underscored (`decision_support`), and what the reader sees is the label
    // the shipped vocabulary gives for each, in payload order — §3.4's rule,
    // applied here rather than asked of the page.
    await openMap(page);
    const taxo = await taxonomy(page);
    const row = any(await corpus(page), r => (r.focus || []).some(k => k.includes('_'))
      && r.focus.length >= 3, 'carries three or more focus areas, underscored in the data');
    await open(page, row.id, { fly: false });
    const want = row.focus.map(k => label(taxo, 'focus', k));
    expect(want.filter(x => x.includes('_'))).toEqual([]);
    expect(await page.$$eval(`${PANEL} .dt-chip`, cs => cs.map(c => c.textContent))).toEqual(want);
  });

  test('§8 the timeline is a span, then the milestones on a rule', async ({ page }) => {
    await openMap(page);
    // An open-ended span — a start and no end — with milestones under it.
    const row = any(await corpus(page), r => r.timeline && r.timeline.start && !r.timeline.end
      && (r.timeline.milestones || []).length >= 2 && r.dateConf !== 'medium' && r.dateConf !== 'low',
      'has an open-ended, firmly dated timeline with milestones');
    await open(page, row.id, { fly: false });
    const sec = page.locator(`${PANEL} .dt-sec`).filter({ has: page.locator('h4', { hasText: 'Timeline' }) });
    await expect(sec.locator('.dt-span')).toHaveText(`${row.timeline.start} →`);   // no end date
    // Each milestone is its date and its label, in payload order, the date on
    // its own rule — which is why the two run together in textContent.
    expect(await sec.locator('.dt-ms li').allTextContents())
      .toEqual(row.timeline.milestones.map(m => `${m.date}${m.label}`));
  });

  test('§8 a start year that is not the entity\'s own is hedged in the card', async ({ page }) => {
    // §10.1: the hedging is the whole point of keeping these dates at all. A
    // medium/low confidence start gets "≈", and the reason is spelled out —
    // the host institution's founding year, or an estimate.
    await openMap(page);
    const rows = await corpus(page);
    const soft = r => r.dateConf === 'medium' || r.dateConf === 'low';
    const open_ = r => r.timeline && r.timeline.start && !r.timeline.end;

    const hosted = any(rows, r => r.dateHost && soft(r) && open_(r),
      'dates itself from the founding of its host institution');
    await open(page, hosted.id, { fly: false });
    await expect(page.locator(`${PANEL} .dt-span`)).toHaveText(`≈ ${hosted.timeline.start} →`);
    await expect(page.locator(`${PANEL} .dt-caveat`))
      .toHaveText(/^Founding year of the host institution/);

    const guessed = any(rows, r => !r.dateHost && r.dateConf === 'low' && open_(r),
      'has an estimated start and no host institution');
    await open(page, guessed.id, { fly: false });
    await expect(page.locator(`${PANEL} .dt-span`)).toHaveText(`≈ ${guessed.timeline.start} →`);
    await expect(page.locator(`${PANEL} .dt-caveat`))
      .toHaveText('Approximate date, reconstructed from indirect evidence.');

    const firm = any(rows, r => !r.dateHost && !soft(r) && r.timeline
      && r.timeline.start && r.timeline.end, 'is firmly dated at both ends');
    await open(page, firm.id, { fly: false });        // high confidence: no hedge, no caveat
    await expect(page.locator(`${PANEL} .dt-span`))
      .toHaveText(`${firm.timeline.start} → ${firm.timeline.end}`);
    await expect(page.locator(`${PANEL} .dt-caveat`)).toHaveCount(0);
  });

  test('§8 the infrastructure section names kind, operator, access and capacity', async ({ page }) => {
    // §3.2: an infrastructure entry whose facility belongs to a team already on
    // the map enriches that team's card instead of adding a second pin. This
    // section is where the merge becomes visible.
    await openMap(page);
    const taxo = await taxonomy(page);
    const row = any(await corpus(page),
      r => r.infra && r.infra.kind && r.infra.operator && r.infra.access && r.infra.capacity,
      'carries all four infrastructure fields');
    await open(page, row.id, { fly: false });
    expect(await sections(page)).toContain('Infrastructure');
    // Kind and access are vocabulary keys in the data, operator and capacity
    // are its own prose; all four are read back out of the payload.
    expect(await factRows(page, `${PANEL} .dt-sec:has(h4:text-is("Infrastructure"))`)).toEqual({
      Kind: label(taxo, 'kind', row.infra.kind),
      Operator: row.infra.operator.org,
      Access: label(taxo, 'access', row.infra.access),
      Capacity: row.infra.capacity,
    });
  });

  test('§8 demonstrators and deliverables are listed, linked when they have a URL', async ({ page }) => {
    await openMap(page);
    // One card holding both halves of the claim: demonstrators that all carry a
    // URL, deliverables that carry none.
    const row = only(await corpus(page), r => (r.demos || []).length > 1 && r.demos.every(x => x.url)
      && (r.delivs || []).length > 1 && r.delivs.every(x => !x.url),
      'lists linked demonstrators and unlinked deliverables');
    await open(page, row.id, { fly: false });
    const text = (x, key) => `${x[key] || ''}${x.date ? ` ${x.date}` : ''}`;

    const demos = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Demonstrators")) li`);
    expect(await demos.allTextContents()).toEqual(row.demos.map(x => text(x, 'label')));
    await expect(demos.locator('a')).toHaveCount(row.demos.length);
    await expect(demos.first().locator('a')).toHaveAttribute('href', row.demos[0].url);

    // The deliverables carry no URL: plain text, not empty links.
    const delivs = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Deliverables")) li`);
    expect(await delivs.allTextContents()).toEqual(row.delivs.map(x => text(x, 'title')));
    await expect(delivs.locator('a')).toHaveCount(0);
  });

  test('§8 "applies to" is a chip list, de-underscored when it is not vocabulary', async ({ page }) => {
    // §3.4: an unmapped key degrades to readable text rather than breaking.
    // `appliesTo` is free text in some entries and underscored keys in others,
    // and the card has to read as prose either way.
    await openMap(page);
    const rows = await corpus(page);
    const chips = () => page.$$eval(`${PANEL} .dt-sec:has(h4:text-is("Applies to")) .dt-chip`,
      cs => cs.map(c => c.textContent));
    // `appliesTo` is not looked up in any vocabulary, so the rule is the whole
    // of §3.4's fallback: the key with its underscores opened out, in order.
    const plain = v => String(v).replace(/_/g, ' ');

    const keys = any(rows, r => (r.appliesTo || []).length > 2 && r.appliesTo.every(v => v.includes('_')),
      'states its scope as underscored keys');
    await open(page, keys.id, { fly: false });
    expect(await chips()).toEqual(keys.appliesTo.map(plain));

    const prose = any(rows, r => (r.appliesTo || []).length > 2 && r.appliesTo.some(v => v.includes(' ')),
      'states its scope as free text');
    await open(page, prose.id, { fly: false });
    expect(await chips()).toEqual(prose.appliesTo.map(plain));
  });

  test('§8 "builds on" names the frameworks a framework rests on, and opens them', async ({ page }) => {
    await openMap(page);
    const row = any(await corpus(page), r => r.layer === 'framework' && r.resolvedRefs.length >= 2,
      'is a framework resting on two or more others');
    await open(page, row.id, { fly: false });
    const refs = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Builds on")) .dt-lk`);
    expect(await refs.evaluateAll(bs => bs.map(b => b.dataset.open))).toEqual(row.resolvedRefs);
    expect(await refs.allTextContents())
      .toEqual(await page.evaluate((ids) => ids.map(i => byId[i].d.name), row.resolvedRefs));

    await page.locator(`${FEED_CARD} .dt-sec:has(h4:text-is("Builds on")) .dt-lk`).first().click();
    expect((await snapshot(page)).focusId).toBe(row.resolvedRefs[0]);
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
    // The subject is a property, not an entity: whichever card carries the
    // longest English description is the one a cap would cut first. Which id
    // that is, and how long it runs, both move with every regeneration — so
    // both are read from the payload, and the rendering is then required to
    // match it to the character.
    const longest = (await corpus(page)).reduce((b, r) => (!b || r.enLen > b.enLen) ? r : b, null);
    expect(longest.enLen > 300).toBe(true);         // past the predecessor's 300-character cap
    const want = await page.evaluate((id) => byId[id].d.desc_en || byId[id].d.desc, longest.id);
    expect(want.length).toBe(longest.enLen);

    await open(page, longest.id, { fly: false });
    for (const root of [PANEL, FEED_CARD]) {
      const got = await page.$$eval(`${root} .dt-desc`, ps => ps.map(p => p.textContent).join('\n\n'));
      expect(got).toBe(want);
      expect(got.length).toBe(longest.enLen);
      expect(got).not.toContain('…');
    }
  });

  test('inv7 the longest French description renders in full', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    const longest = (await corpus(page)).reduce((b, r) => (!b || r.frLen > b.frLen) ? r : b, null);
    expect(longest.frLen > 300).toBe(true);
    const want = await page.evaluate((id) => byId[id].d.desc_fr || byId[id].d.desc, longest.id);
    expect(want.length).toBe(longest.frLen);

    await open(page, longest.id, { fly: false });
    const got = await page.$$eval(`${PANEL} .dt-desc`, ps => ps.map(p => p.textContent).join('\n\n'));
    expect(got).toBe(want);
    expect(got.length).toBe(longest.frLen);
  });

  test('inv7 paragraph breaks are preserved as paragraphs', async ({ page }) => {
    await openMap(page);
    const row = any(await corpus(page), r => r.enParas >= 2, 'reads in more than one paragraph');
    const want = await page.evaluate((id) => (byId[id].d.desc_en || byId[id].d.desc).split('\n\n'), row.id);
    expect(want).toHaveLength(row.enParas);

    await open(page, row.id, { fly: false });
    expect(await page.$$eval(`${PANEL} .dt-desc`, ps => ps.map(p => p.textContent))).toEqual(want);
    // A newline rendered as a newline inside one <p> would collapse in HTML —
    // the split has to produce real paragraphs, which is what §3.1 promises.
    expect(await page.locator(`${PANEL} .dt-desc`).count()).toBe(row.enParas);
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
    const row = any(await corpus(page), r => r.descOnly,
      'carries its description only under `desc`, in neither language');
    const raw = await page.evaluate((id) => {
      const d = byId[id].d;
      return { desc: d.desc, en: d.desc_en, fr: d.desc_fr };
    }, row.id);
    expect(raw.en).toBeUndefined();
    expect(raw.fr).toBeUndefined();

    await open(page, row.id, { fly: false });
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
    const rows = await corpus(page);
    const taxo = await taxonomy(page);
    const names = new Map(rows.map(r => [r.id, r.name]));
    const consSec = page.locator(`${PANEL} .dt-sec:has(h4:text-is("Consortium"))`);

    // A consortium every row of which resolves to an entity on the map: every
    // row is then a button.
    const whole = any(rows, r => (r.consortium || []).length > 5
      && r.consortium.length === r.resolvedCons.length, 'lists a consortium that resolves in full');
    await open(page, whole.id, { fly: false });
    await expect(consSec.locator('li')).toHaveCount(whole.consortium.length);
    await expect(consSec.locator('li button.dt-lk')).toHaveCount(whole.consortium.length);

    // And the hardest case the other way: the consortium with the most partners
    // the map does not know. Those rows are names, and must not pretend to be
    // links. Which project that is is upstream's business — that the two counts
    // part company exactly where the references stop resolving is the page's.
    const partial = rows.reduce((b, r) => {
      const dead = (r.consortium || []).length - r.resolvedCons.length;
      return (!b || dead > b.consortium.length - b.resolvedCons.length) ? r : b;
    }, null);
    expect(partial.consortium.length > partial.resolvedCons.length).toBe(true);
    await open(page, partial.id, { fly: false });
    await expect(consSec.locator('li')).toHaveCount(partial.consortium.length);
    await expect(consSec.locator('li button.dt-lk')).toHaveCount(partial.resolvedCons.length);
    await expect(consSec.locator('li').first())
      .toHaveText(consRowText(partial.consortium[0], names, taxo));
  });

  test('§8 a resolved row names its destination when the legal name differs', async ({ page }) => {
    await openMap(page);
    const rows = await corpus(page);
    const taxo = await taxonomy(page);
    const names = new Map(rows.map(r => [r.id, r.name]));
    // A consortium holding both cases at once: partners whose legal name is not
    // the name of the entity they resolve to — "Linkopings Universitet" against
    // a named group inside it, which is what the arrow is for — and at least
    // one where the two are the same string, where the arrow would be noise.
    const row = any(rows, r => r.resolvedCons.some(c => names.get(c.ref) !== c.org)
      && r.resolvedCons.some(c => names.get(c.ref) === c.org),
      'resolves partners both under their own name and under another');
    await open(page, row.id, { fly: false });

    // The whole list, rebuilt from the payload, in order — not a spot check.
    const got = await page.$$eval(`${PANEL} .dt-sec:has(h4:text-is("Consortium")) li`,
      lis => lis.map(li => li.textContent));
    expect(got).toEqual(row.consortium.map(c => consRowText(c, names, taxo)));
    expect(got.filter(x => x.includes('→')).length)
      .toBe(row.resolvedCons.filter(c => names.get(c.ref) !== c.org).length);
  });

  test('§8 a consortium row opens the entity it resolves to', async ({ page }) => {
    await openMap(page);
    // The consortium is the third of §8's sections and "Builds on" the tenth, so
    // the card's first `.dt-lk` is its first partner that resolves.
    const row = any(await corpus(page), r => r.resolvedCons.length > 0,
      'resolves at least one consortium partner');
    const target = row.resolvedCons[0].ref;
    await open(page, row.id, { fly: false });
    await page.locator(`${FEED_CARD} .dt-lk`).first().click();
    expect((await snapshot(page)).focusId).toBe(target);
    expect(await history(page)).toEqual({ ids: [row.id, target], i: 1 });
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
    // The counts come from the payload's own relations, so what this test says
    // is that they do not move — not that they are any particular number.
    const rel = relOf(rowOf(await corpus(page), PROJECT));
    const want = Object.fromEntries(Object.entries(rel).map(([head, ids]) => [head, ids.length]));
    const rowsShown = Object.values(rel).reduce((n, ids) => n + ids.length, 0);
    expect(rowsShown > 0).toBe(true);

    await open(page, PROJECT, { fly: false });
    expect(await relCounts(page)).toEqual(want);

    await unfilterNothing(page);                       // every domain off: nothing matches
    const s = await snapshot(page);
    expect(s.matchCount).toBe(0);
    expect(s.keptOpen).toBe(1);                        // only the open card survives (§6)

    expect(await relCounts(page)).toEqual(want);
    await expect(page.locator(`${PANEL} .rel-row`)).toHaveCount(rowsShown);
    // And the same in the feed, which is the surface the reader is looking at.
    expect(await relCounts(page, FEED_CARD)).toEqual(want);
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
    // One card of each shape that has neighbours at all: a project and a team
    // read their relations off the edge list, an asset off its own
    // cross-references, and the three go through different branches.
    const asset = any(await corpus(page), r => (r.layer === 'commons' || r.layer === 'framework')
      && r.createdHere.length + r.usedHere.length >= 2, 'is an asset with two or more neighbours');
    for (const id of [PROJECT, TEAM, asset.id]) {
      await open(page, id, { fly: false });
      const want = (await neighboursFromData(page, id)).sort();
      // De-duplicated: a team that both built an asset and uses it is listed
      // under both headings, which is the honest rendering of two different
      // relationships, not a double count.
      const got = await page.$$eval(`${PANEL} .rel-row`, bs => [...new Set(bs.map(b => b.dataset.open))].sort());
      expect(got, `related rows for ${id}`).toEqual(want);
    }
  });

  test('§8 a neighbour related twice over is listed under each heading', async ({ page }) => {
    // An asset that names the same team in both `createdBy` and `usedBy` —
    // OperatorFabric and the RTE group are one such pair. Collapsing the two
    // would lose the distinction the sections exist to draw.
    await openMap(page);
    const asset = any(await corpus(page), r => r.createdHere.some(x => r.usedHere.includes(x)),
      'names the same entity as both its creator and its user');
    const both = asset.createdHere.find(x => asset.usedHere.includes(x));

    await open(page, both, { fly: false });
    const where = await page.$$eval(`${PANEL} .dt-sec`, (ss, id) => ss
      .filter(s => s.querySelector(`[data-open="${id}"]`))
      .map(s => s.querySelector('h4').textContent.replace(/\s*\d+$/, '')), asset.id);
    expect(where).toEqual(['Created', 'Builds on']);
  });
});

// =========================================================================
test.describe('§7 selection and navigation', () => {
  test('§7 selecting highlights the marker, dims the rest, and draws its edges hot', async ({ page }) => {
    await openMap(page);
    await open(page, PROJECT, { fly: false });

    // Every figure below is read off the payload: how many neighbours this
    // project has, and how many curves they amount to, is upstream's to change.
    const nbrs = await neighboursFromData(page, PROJECT);
    expect(nbrs.length > 4).toBe(true);                // a fan, not a single line
    // Every one of them is placed, so the dimming arithmetic below is exact.
    expect(await page.evaluate((ns) => ns.every(n => byId[n].geo), nbrs)).toBe(true);
    const placed = await page.evaluate(() => items.filter(i => i.geo).length);
    const fan = await fanFromData(page, PROJECT);

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
    // neighbours is dimmed.
    expect(st.dimmedElsewhere).toBe(placed - 1 - nbrs.length);
    // The link mesh is off by default, so every drawn edge is one of this
    // entity's own — one per relation between two placed entities, which is
    // why `fan` is counted from the payload's edges rather than from `nbrs`: a
    // neighbour related twice over is two curves.
    expect(st.links).toBe(false);
    expect(st.onEdges).toBe(fan);
    expect(st.hot).toBe(fan);
    // One line per organisation: a neighbour whose edge names another card of
    // its organisation in `via` shares that card's curve instead of drawing one.
    const shared = await page.evaluate((id) => DATA.EDGES
      .filter(e => (e.project || e.cluster) === id && e.via).length, PROJECT);
    expect(fan + shared >= nbrs.length).toBe(true);
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

  test('§7 only the primary button selects, and only it closes', async ({ page }) => {
    // A right-click is the reader asking the *browser* for its context menu,
    // not asking the map for a different selection. Both halves of §7's
    // sentence — a marker opens, empty map closes — have to ignore it, or the
    // menu comes up over a card that silently opened or closed behind it.
    await openMap(page);
    const mk = await findPoint(page, true);
    expect(mk).not.toBeNull();

    for (const button of ['right', 'middle']) {
      await page.mouse.click(mk.x, mk.y, { button });
      expect((await snapshot(page)).focusId, `${button} button on a marker`).toBe(null);
    }
    await page.mouse.click(mk.x, mk.y);                // …and the primary one does select
    expect((await snapshot(page)).focusId).toBe(mk.id);

    const empty = await findPoint(page, false);        // scanned with the card open
    expect(empty).not.toBeNull();
    for (const button of ['right', 'middle']) {
      await page.mouse.click(empty.x, empty.y, { button });
      expect((await snapshot(page)).focusId, `${button} button on empty map`).toBe(mk.id);
    }
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
    // A wide fan at full strength is a hairball; pointing at a row is how a
    // reader picks one line out of it.
    await openMap(page);
    const fan = await fanFromData(page, PROJECT);
    await open(page, PROJECT, { fly: false });
    const before = await page.evaluate(() =>
      hotEdges.map(i => Number(edgeEls[i].getAttribute('stroke-opacity'))));
    expect(before).toHaveLength(fan);
    // §4.3's attenuation, computed for the fan this card actually has rather
    // than for the one it had when this test was written: the base opacity runs
    // from 0.85 at four neighbours or fewer down to 0.40 at sixteen or more,
    // and the longest hops are thinned by a further 40% on top of that.
    const base = 0.85 - 0.45 * Math.min(1, Math.max(0, (fan - 4) / 12));
    expect(Math.min(...before)).toBeGreaterThanOrEqual(base * 0.6 - 5e-4);
    expect(Math.max(...before)).toBeLessThanOrEqual(base + 5e-4);

    const row = page.locator(`${FEED_CARD} .rel-row`).first();
    const id = await row.getAttribute('data-open');
    const own = await fanFromData(page, PROJECT, id);   // curves between this pair alone
    expect(own > 0 && own < fan).toBe(true);
    await row.hover();

    const after = await page.evaluate((x) => hotEdges.map(i => ({
      mine: edges[i].a === x || edges[i].b === x,
      op: edgeEls[i].getAttribute('stroke-opacity'),
      w: edgeEls[i].getAttribute('stroke-width'),
    })), id);
    const mine = after.filter(e => e.mine);
    expect(mine).toHaveLength(own);
    expect(mine[0].op).toBe('0.950');                  // full strength, §4.3
    // The rest of the fan drops to a trace — 15% of what it was.
    expect(Math.max(...after.filter(e => !e.mine).map(e => Number(e.op)))).toBeLessThan(base * 0.16);
    expect(Number(mine[0].w)).toBeGreaterThan(Number(after.find(e => !e.mine).w));
  });

  test('§7 peeking an entity with no marker is harmless', async ({ page }) => {
    // Invariant 3 again: a framework with no coordinates still has rows to
    // hover, in its own card and in the cards of its neighbours.
    await openMap(page);
    const fw = any(await corpus(page), r => r.layer === 'framework' && !r.geo,
      'is a framework with no coordinates');
    await open(page, fw.id, { fly: false });
    expect(await page.evaluate((id) => mkEls[id], fw.id)).toBeFalsy();
    await page.evaluate((id) => peek(id, true), fw.id);
    expect(await page.evaluate(() => peekId)).toBe(fw.id);
    await page.evaluate((id) => peek(id, false), fw.id);
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

  test('§4.3 moving straight from one marker to its neighbour keeps the tooltip up', async ({ page }) => {
    // Markers overlap heavily after jitter(), so a cursor crossing a cluster
    // fires a pointerout/pointerover pair between every adjacent pair of them.
    // The keep-alive guard on `relatedTarget` is the only thing stopping the
    // tooltip from strobing off and on all the way across — and every content
    // assertion above looks at a single marker in isolation, where the guard
    // never comes into play.
    await openMap(page);
    await open(page, PROJECT, { fly: false });
    const [a, b] = (await neighboursFromData(page, PROJECT)).slice(0, 2);
    expect(await page.evaluate(([x, y]) => [!!mkEls[x], !!mkEls[y]], [a, b])).toEqual([true, true]);
    const names = await page.evaluate(([x, y]) => [byId[x].d.name, byId[y].d.name], [a, b]);

    // Read the tooltip after every single dispatch: a hide that is immediately
    // undone by the next pointerover is exactly what the reader sees as flicker,
    // and the end state alone cannot tell the two apart.
    const trace = await page.evaluate(([x, y]) => {
      const tip = document.getElementById('tooltip');
      const read = () => ({ shown: tip.style.display, peek: peekId,
        name: tip.querySelector('.tt-name').textContent });
      const over = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      const out = (el, to) => el.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, relatedTarget: to }));
      const steps = [];
      over(mkEls[x]); steps.push(read());
      out(mkEls[x], mkEls[y]); steps.push(read());          // straight into the neighbour
      over(mkEls[y]); steps.push(read());
      out(mkEls[y], document.getElementById('map')); steps.push(read());   // and off to bare map
      return steps;
    }, [a, b]);

    expect(trace.map(s => s.shown)).toEqual(['block', 'block', 'block', 'none']);
    expect(trace.map(s => s.name)).toEqual([names[0], names[0], names[1], names[1]]);
    // §4.3: one peek() drives the halo, so the emphasis hands over mid-sweep
    // rather than accumulating — the departed marker is released either way.
    expect(trace.map(s => s.peek)).toEqual([a, null, b, null]);
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
    const rows = await corpus(page);
    const second = any(rows, r => r.layer === 'commons', 'is a commons').id;
    const third = any(rows, r => r.layer === 'framework', 'is a framework').id;
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await open(page, second, { fly: false });
    await open(page, third, { fly: false });
    await page.click('#dt-back');                      // back to the second step
    await open(page, TEAM, { fly: false });
    expect(await history(page)).toEqual({ ids: [PROJECT, second, TEAM], i: 2 });
  });

  test('§7 a breadcrumb click walks back without dropping the steps ahead', async ({ page }) => {
    await openMap(page);
    const rows = await corpus(page);
    const second = any(rows, r => r.layer === 'commons', 'is a commons');
    const third = any(rows, r => r.layer === 'framework', 'is a framework');
    await hideFeed(page);
    await open(page, PROJECT, { fly: false });
    await open(page, second.id, { fly: false });
    await open(page, third.id, { fly: false });
    // The trail names the steps behind, in order, by the names in the payload.
    expect(await crumbs(page)).toEqual([rowOf(rows, PROJECT).name, second.name]);

    await page.locator('#dt-trail .dt-crumb').first().click();
    expect((await snapshot(page)).focusId).toBe(PROJECT);
    expect(await history(page)).toEqual({ ids: [PROJECT, second.id, third.id], i: 0 });
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
    const fw = any(await corpus(page), r => !r.geo, 'has no coordinates');
    const before = await page.evaluate(() => ({ ...view }));
    await open(page, fw.id);                           // fly not suppressed
    expect((await snapshot(page)).focusId).toBe(fw.id);
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

    // The query is the entity's own name out of the payload: a literal here
    // starts matching something else the day the project is renamed.
    await openViaSearch(page, rowOf(await corpus(page), PROJECT).name);
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
    const taxo = await taxonomy(page);
    // An entry that has been touched since it was added, so that the choice
    // between the two dates is visible at all — which entry that is, is not
    // this test's business.
    const row = any(await corpus(page), r => r.prov && r.prov.by && r.prov.src && r.prov.conf
      && r.prov.on && r.prov.upd && r.prov.on !== r.prov.upd,
      'has been updated since it was added');
    await open(page, row.id, { fly: false });
    const p = row.prov;

    const foot = page.locator(`${PANEL} .dt-prov`);
    await expect(foot).toContainText(
      `Added by ${p.by} · ${p.upd} · confidence ${label(taxo, 'confidence', p.conf)}`);
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
    // "Every entity" means the payload's, counted from the payload: §3.2 is
    // explicit that this figure moves with every regeneration, so a literal
    // here would only record when this file was last edited. The page's own
    // `items` is what is on trial, so the total it is held to is summed from
    // `window.HAI_DATA` — the merged payload the page actually loaded.
    const want = await page.evaluate(() => ['PROJECTS', 'CLUSTERS', 'TEAMS', 'COMMONS', 'FRAMEWORKS']
      .reduce((n, k) => n + window.HAI_DATA[k].length, 0));
    expect(await page.evaluate(() => items.length)).toBe(want);
  });

  test('§8/§12 provenance is in French in French, confidence label included', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    const taxo = await taxonomy(page);
    const row = any(await corpus(page), r => r.prov && r.prov.by && r.prov.src && r.prov.upd
      && r.prov.conf, 'carries a full provenance footer');
    await open(page, row.id, { fly: false });
    const p = row.prov;
    // The confidence is a vocabulary lookup in the reader's language, not the
    // raw key: "confiance high" would be the §3.4 failure.
    const conf = label(taxo, 'confidence', p.conf, 'fr');
    expect(conf).not.toBe(p.conf);
    await expect(page.locator(`${PANEL} .dt-prov`))
      .toContainText(`Ajouté par ${p.by} · ${p.upd} · confiance ${conf}`);
    await expect(page.locator(`${PANEL} .dt-prov .src`)).toHaveText(`Source : ${p.src}`);
  });
});

// =========================================================================
test.describe('§8 funding amounts are locale-formatted euros', () => {
  // The funded entity is picked for carrying the whole section — a source, a
  // grant, an amount and a funding page — and both tests pick the same way, so
  // "the same budget" below really is the same one.
  const funded = (rows) => any(rows, r => r.funding && r.funding.eur && r.funding.source
    && r.funding.grant && r.funding.url, 'carries a full funding section');

  test('§8 the budget reads as euros in English', async ({ page }) => {
    await openMap(page);
    const row = funded(await corpus(page));
    await open(page, row.id, { fly: false });
    const fn = row.funding;
    const sec = page.locator(`${PANEL} .dt-sec`).filter({ has: page.locator('h4', { hasText: 'Funding' }) });
    // Labels from §8, values from the payload: the amount grouped into whole
    // euros, the funding page stripped to its host and path.
    const want = { Source: fn.source, Grant: fn.grant, Budget: euros(fn.eur),
      'Funding page': linkText(fn.url) };
    if (fn.call) want.Call = fn.call;
    expect(await factRows(page, `${PANEL} .dt-sec:has(h4:text-is("Funding"))`)).toEqual(want);
    await expect(sec.locator('a')).toHaveAttribute('href', fn.url);
  });

  test('§8 the same budget reads as euros in French', async ({ page }) => {
    await openMap(page, { lang: 'fr' });
    const row = funded(await corpus(page));
    await open(page, row.id, { fly: false });
    const fn = row.funding;
    const rows = await factRows(page, `${PANEL} .dt-sec:has(h4:text-is("Financement"))`);
    // §8's rows in §8's order, in French — predicted from which of the fields
    // the payload fills rather than from this entity's shape.
    expect(Object.keys(rows)).toEqual([['source', 'Source'], ['call', 'Appel'],
      ['grant', 'Convention'], ['eur', 'Budget'], ['url', 'Page de financement']]
      .filter(([k]) => fn[k]).map(([, l]) => l));
    // French puts the symbol last and groups with a (narrow, non-breaking)
    // space; normalise the spacing rather than hard-coding the code point.
    expect(rows.Budget.replace(/[\s   ]/g, ' ')).toBe(euros(fn.eur, 'fr'));
  });

  test('§8 no funding amount is ever rendered as a bare number', async ({ page }) => {
    // Some amounts in the payload are given to the cent. A locale-formatted
    // figure keeps every euro, drops the cents and gains separators; the
    // `money()` fallback ("€" + n) would keep the raw number. Every amount the
    // payload carries is checked, so the claim does not rest on how many there
    // happen to be.
    await openMap(page);
    const withMoney = (await corpus(page)).filter(r => r.funding && r.funding.eur);
    expect(withMoney.length > 0).toBe(true);
    const got = await page.evaluate(() => {
      const host = document.createElement('div');
      const out = [];
      items.forEach(it => {
        const eur = it.d.funding && it.d.funding.eur;
        if (!eur) return;
        host.innerHTML = cardHtml(it);
        const row = [...host.querySelectorAll('.dt-facts div')]
          .find(d => d.querySelector('dt').textContent === 'Budget');
        out.push([it.id, row ? row.querySelector('dd').textContent : null]);
      });
      return out;
    });
    // The same set of entities, and for each of them the figure §8's rule asks
    // for — which is never the raw number, and never a bare one.
    expect(got.map(([id]) => id).sort()).toEqual(withMoney.map(r => r.id).sort());
    const shown = new Map(got);
    expect(withMoney.filter(r => shown.get(r.id) !== euros(r.funding.eur))
      .map(r => [r.id, shown.get(r.id)])).toEqual([]);
    expect(withMoney.filter(r => shown.get(r.id) === '€' + r.funding.eur).map(r => r.id)).toEqual([]);
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
    await expect(page.locator(`${FEED_CARD} .dt-name`))
      .toHaveText(await page.evaluate((id) => byId[id].d.name, PROJECT));
    await page.click(`${FEED_CARD} .dt-pin`);
    expect((await snapshot(page)).pins).toBe(1);
    await expect(page.locator(`${FEED_CARD} .dt-pin`)).toHaveText('★ Pinned');
  });

  test('§8/inv9 a name carrying an ampersand reads as one', async ({ page }) => {
    // Everything interpolated into the card goes through esc(); the failure
    // mode is a reader seeing "&amp;" in a project title.
    await openMap(page);
    const row = any(await corpus(page), r => String(r.name).includes('&'),
      'has an ampersand in its name');
    await open(page, row.id, { fly: false });
    const name = row.name;
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
      `${H} member ${H} mrole · ${H} mct`, `${H} demo`, `${H} deliv`, `${H} facility`]);
    expect(out.secFacts).toEqual([`${H} source`, `${H} call`, `${H} grant`,
      `${H} infra`, `${H} operator`, `${H} access`, `${H} capacity`, 'example.org/o']);
    expect(out.prov).toBe(`Added by ${H} by · ${H} upd · confidence ${H} confSource: ${H} src`);
    // Attributes too: a quote that survives unescaped ends the attribute early.
    expect(out.href).toBe(`https://example.org/?q=${H}`);

    // The same synthetic entity carries every one of §8 item 6's fields but a
    // cluster's membership at once,
    // which no card in the payload does — so this is also where the full list
    // and its order are pinned.
    expect(out.identity).toEqual([
      ['Organisation', `${H} organisation`],
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
    // Every label but a cluster's own: the synthetic entity is a commons, so its
    // size reads as Reach, not Membership.
    expect(out.identity.map(([k]) => k)).toEqual(FACT_ORDER.map(([k]) => k).filter(k => k !== 'Membership'));
  });

  test('§8 a card with one related entity still counts it, and says one', async ({ page }) => {
    // n=1 is where a count rendered as a label rather than a number would show.
    // The entity is found in the payload rather than by asking relSections()
    // which card has one row — a count checked against the function that
    // produced it agrees with itself no matter what either of them does.
    await openMap(page);
    // An asset built by one entity on the map and used by none of them, or the
    // other way about: one section, one row, and the heading says which
    // relationship it is. Found by that shape in the payload, not by id.
    const row = any(await corpus(page), r => (r.layer === 'commons' || r.layer === 'framework')
      && r.createdHere.length + r.usedHere.length === 1,
      'has exactly one neighbour, in exactly one role');
    const rel = relOf(row);
    expect(Object.values(rel).flat()).toHaveLength(1);

    await open(page, row.id, { fly: false });
    expect(await relCounts(page)).toEqual(
      Object.fromEntries(Object.entries(rel).map(([head, ids]) => [head, ids.length])));
    await expect(page.locator(`${PANEL} .rel-row`)).toHaveCount(1);
    expect(await page.$$eval(`${PANEL} .rel-row`, bs => bs.map(b => b.dataset.open)))
      .toEqual(Object.values(rel).flat());
  });
});
