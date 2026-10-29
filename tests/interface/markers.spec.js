// Markers, edges and zoom — the map's visual language.
//
// Spec: docs/map-interface-spec.md §3.2 (layers), §4.1 (projection and
// basemap), §4.2 (markers), §4.3 (edges), §4.4 (zoom thresholds), and
// invariants 2 (shape means layer, colour means domain) and 3 (an entity
// without coordinates has no marker but keeps everything else).
//
// Four habits run through the file:
//
//  * Expectations are derived from the payload on disk, re-implementing the
//    rule the spec states, rather than read back out of the page. The data
//    scripts are loaded here in Node, *before* the page's jitter pass mutates
//    the payload in place, so the tests can say what a marker's coordinates
//    ought to be and not merely that the page agrees with itself.
//  * No count is written down. §3.2 says the figures in the spec's own table
//    "are a snapshot and move with every upstream regeneration; the shape of
//    the table is what is normative, not the figures" — so a corpus size, an
//    off-map population, a fan width or a dashed-link count is computed from
//    the payload and the page is then held to it exactly. Where a count only
//    served to show a test was not vacuous, what is asserted is the thing it
//    stood for: that both branches of a partition are populated, that two sets
//    are the same set, that a fixture really sits on the boundary it was
//    chosen for.
//  * Fixtures are chosen by property — the widest domain split, the narrowest
//    fan, the longest name that still fits the label — rather than by id,
//    except where an entity is itself the subject of the test. A regeneration
//    that renames or retires an entity then re-picks the fixture instead of
//    silently voiding the test.
//  * Where a claim is visual, both halves are asserted: the internal state
//    (`edges`, `hotEdges`, `view.k`, `k0`) and the attribute a reader's eye
//    actually lands on (stroke-opacity, stroke-dasharray, display).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openMap, settleCounts, setLayers, toggleLayer, fitAll, snapshot, MAP_PATH } from './_map.js';

// ---------------------------------------------------------------- the payload

// Playwright compiles these specs to CommonJS, so __dirname is the honest way
// to reach the repository; import.meta is not available here.
const repoFile = (rel) => path.join(__dirname, '..', '..', rel);

// The page under test, as a repository path — the committed artefact, or the
// doctored copy a mutation run points MAP_PATH at. Its data scripts are read
// from its own directory, so a mutation copy is modelled from the same payload
// it loads.
const MAP_FILE = MAP_PATH.replace(/^\/+/, '').split(/[?#]/)[0];

/** The payload the page is given, as committed and unmutated.
 *
 *  It is no longer a single file: `hai-data-additions.js` merges further
 *  entities into `window.HAI_DATA` by id after `hai-data.js` has defined it,
 *  and says it becomes a no-op once the generated file catches up. So the
 *  payload is *every script the page loads that touches HAI_DATA*, applied in
 *  the page's own order — discovered by reading the page rather than named
 *  here, so a shim appearing, being renamed, or being folded back into the
 *  generated file cannot leave this model reasoning about half a corpus.
 *
 *  Nothing circular is going on: these files are the input the page is handed,
 *  not the code under test. The jitter pass, the projection and the edge list
 *  below are still re-implemented here from §4.1–§4.3, and a merge that lost or
 *  duplicated an entity would put the page and this model out of step — which
 *  the id-for-id comparisons in §4.1 and §4.2 are there to report. */
function loadPayload() {
  const page = fs.readFileSync(repoFile(MAP_FILE), 'utf8');
  const dir = path.dirname(MAP_FILE);
  const w = {};
  for (const [, src] of page.matchAll(/<script[^>]+\bsrc="([^"]+)"/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src)) continue;   // nothing off-site
    const js = fs.readFileSync(repoFile(path.join(dir, src)), 'utf8');
    if (!js.includes('HAI_DATA')) continue;                     // e.g. europe-geo.js
    new Function('window', js)(w);
  }
  if (!w.HAI_DATA) throw new Error(`${MAP_FILE} loads no script that defines HAI_DATA`);
  return w.HAI_DATA;
}

/** The basemap's calibration constants, read out of the pre-projected geometry
 *  file's header without parsing its megabyte of path data. */
function loadGeoConstants() {
  const head = fs.readFileSync(repoFile('assets/map/europe-geo.js'), 'utf8').slice(0, 2048);
  const num = (k) => {
    const m = new RegExp('"' + k + '":(-?[0-9.]+)').exec(head);
    if (!m) throw new Error('europe-geo.js header has no ' + k);
    return Number(m[1]);
  };
  return { W: num('W'), H: num('H'), LAM0: num('LAM0'), PHI1: num('PHI1'), S: num('S'), TX: num('TX'), TY: num('TY') };
}

/** The same file, parsed whole, so the drawn basemap can be compared with the
 *  geometry it is supposed to be. Read inside the one test that needs it: it is
 *  a megabyte of path data and every other test here wants only the header. */
function loadGeoFile() {
  const w = {};
  new Function('window', fs.readFileSync(repoFile('assets/map/europe-geo.js'), 'utf8'))(w);
  return w.HAI_GEO;
}

const RAW = loadPayload();
const G = loadGeoConstants();
const KINDS = ['project', 'team', 'cluster', 'commons', 'framework'];

// The seventeen domain colours, transcribed from §4.2's three groups. Kept here
// rather than read from the page so that "colour means domain" is checked
// against a table a human wrote, not against the table under test.
const SPEC_COLORS = {
  energy: '#f59e0b', aviation: '#3b82f6', rail: '#10b981', transport: '#84cc16',
  telecom: '#06b6d4', utility: '#92400e', health: '#ef4444', manufacturing: '#8b5cf6',
  maritime: '#0891b2', nuclear: '#a16207', defense: '#475569',
  hf: '#ec4899', xai: '#6b7280', multi: '#14b8a6',
  compute: '#581c87', cluster: '#4f46e5', simulation: '#facc15',
};
const SPEC_GROUPS = {
  industrial: ['energy', 'aviation', 'rail', 'transport', 'telecom', 'utility', 'health', 'manufacturing', 'maritime', 'nuclear', 'defense'],
  research: ['hf', 'xai', 'multi'],
  infra: ['compute', 'cluster', 'simulation'],
};
// §4.2's radius column, and §4.2's draw order.
const SPEC_R = { project: 8.5, cluster: 7, commons: 7.5, framework: 6, team: 4.5 };
const SPEC_DRAW_ORDER = ['team', 'commons', 'framework', 'cluster', 'project'];

/** The table above in the form CSS answers in. A marker's fill is an attribute
 *  and comes back as the hex that was written; a swatch's colour is a style and
 *  comes back resolved, so the two channels have to be compared through this. */
function rgbOf(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error('not a six-digit hex colour: ' + hex);
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

// §4.1's "twenty capital labels give orientation", with the coordinates written
// out by hand from an atlas. The page's own CAPITALS table is the thing under
// test here: checking a label's position against the latitude and longitude the
// page itself put in that table only proves the projection is self-consistent,
// and a copy-paste that gave Paris Berlin's coordinates would sail through it —
// the orientation chain below still holds, because Berlin is also east of
// Madrid and north of Athína. Tolerance is 0.15°, loose for a table typed from
// memory and an order of magnitude tighter than the gap between the closest two
// of these cities (Bruxelles and Amsterdam, 1.5° apart).
const REF_CAPITALS = {
  Paris: [48.86, 2.35], London: [51.51, -0.13], Berlin: [52.52, 13.40], Madrid: [40.42, -3.70],
  Roma: [41.90, 12.50], Wien: [48.21, 16.37], Warszawa: [52.23, 21.01], Stockholm: [59.33, 18.07],
  Oslo: [59.91, 10.75], Helsinki: [60.17, 24.94], København: [55.68, 12.57], Amsterdam: [52.37, 4.90],
  Bruxelles: [50.85, 4.35], Lisboa: [38.72, -9.14], Athína: [37.98, 23.73], Dublin: [53.35, -6.26],
  Praha: [50.08, 14.44], Budapest: [47.50, 19.04], Bern: [46.95, 7.45], Bucureşti: [44.43, 26.10],
};

// --------------------------------------------- a reference model of the page

const D2R = Math.PI / 180;

/** §4.1 Lambert azimuthal equal-area, λ₀ = 10°E, φ₁ = 52°N, written out from
 *  the spec rather than lifted from the page. */
function refProject(lon, lat) {
  const l = lon * D2R, p = lat * D2R, l0 = G.LAM0 * D2R, p1 = G.PHI1 * D2R;
  const dn = 1 + Math.sin(p1) * Math.sin(p) + Math.cos(p1) * Math.cos(p) * Math.cos(l - l0);
  const k = Math.sqrt(2 / Math.max(dn, 1e-9));
  return [
    G.TX + G.S * k * Math.cos(p) * Math.sin(l - l0),
    G.TY - G.S * k * (Math.cos(p1) * Math.sin(p) - Math.sin(p1) * Math.cos(p) * Math.cos(l - l0)),
  ];
}

/** Every entity, keyed by id, with its layer, its raw coordinates, the jitter
 *  group it belongs to (§4.2: "per layer group"), the coordinates the jitter
 *  pass should leave it at, and where that projects to. */
const MODEL = (() => {
  const clone = JSON.parse(JSON.stringify({
    project: RAW.PROJECTS, team: RAW.TEAMS, cluster: RAW.CLUSTERS, commons: RAW.COMMONS, framework: RAW.FRAMEWORKS,
  }));
  const byId = new Map();
  for (const kind of KINDS) {
    for (const d of clone[kind]) {
      const domains = (d.domains && d.domains.length) ? d.domains.slice() : [d.domain];
      byId.set(d.id, {
        id: d.id, kind, d, domains, lead: d.domain,
        placed: d.lat != null && d.lon != null,
        rawLat: d.lat, rawLon: d.lon,
      });
    }
  }
  // The jitter groups: projects, clusters and commons share one pass, teams
  // and frameworks have their own. Grouped on the coordinates rounded to 1/100°.
  const pass = (ids, label) => {
    const groups = new Map();
    for (const id of ids) {
      const m = byId.get(id);
      if (!m.placed) continue;
      const key = m.rawLat.toFixed(2) + ',' + m.rawLon.toFixed(2);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const [key, members] of groups) {
      members.forEach((m, i) => {
        m.group = label + ':' + key;
        m.groupSize = members.length;
        m.groupIndex = i;
        if (members.length === 1) { m.lat = m.rawLat; m.lon = m.rawLon; return; }
        const a = 2 * Math.PI * i / members.length;
        m.lat = m.rawLat + 0.18 * Math.sin(a);
        m.lon = m.rawLon + 0.18 * Math.cos(a);
      });
    }
    return groups;
  };
  const ids = (kind) => clone[kind].map((d) => d.id);
  const groups = {
    pc: pass([...ids('project'), ...ids('cluster'), ...ids('commons')], 'pc'),
    team: pass(ids('team'), 'team'),
    framework: pass(ids('framework'), 'framework'),
  };
  for (const m of byId.values()) {
    if (!m.placed) { m.X = 0; m.Y = 0; continue; }
    [m.X, m.Y] = refProject(m.lon, m.lat);
  }
  return { byId, groups, all: [...byId.values()] };
})();

const PLACED = MODEL.all.filter((m) => m.placed);
const UNPLACED = MODEL.all.filter((m) => !m.placed);

/** §4.3 the edge list the page should build, in the order it should build it:
 *  edges.yml first, then the commons and framework cross-references, created
 *  before used. `relate()` records adjacency for every pair that resolves but
 *  only draws a curve when both ends are placed. */
const RELATIONS = (() => {
  const drawn = [];
  const pairs = new Set();
  const groups = new Map();
  const relate = (a, b, rel, colorFrom, extra = {}) => {
    if (!MODEL.byId.has(a) || !MODEL.byId.has(b)) return -1;
    pairs.add([a, b].sort().join('::'));
    if (!(MODEL.byId.get(a).placed && MODEL.byId.get(b).placed)) return -1;
    drawn.push({ a, b, rel, color: SPEC_COLORS[MODEL.byId.get(colorFrom).lead] || null, ...extra });
    return drawn.length - 1;
  };
  // A line starts from a project or a cluster, and every link gets its path,
  // grouped by source and organisation: the card a `via` names heads its group.
  // The map shows one path per group (§4.3) — see shownWith() below.
  for (const e of RAW.EDGES) {
    const s = e.project || e.cluster;
    if (!MODEL.byId.has(s) || !MODEL.byId.has(e.team)) continue;   // the page bails on an unknown end
    const key = s + '|' + (e.via || e.team);
    if (!groups.has(key)) groups.set(key, { members: [], lines: [] });
    const G = groups.get(key);
    G.members.push(e.team);
    const i = relate(s, e.team, 'consortium', s, { alt: !!e.via });
    if (i >= 0) { if (e.via) G.lines.push(i); else G.lines.unshift(i); }
  }
  for (const G of groups.values()) for (const i of G.lines) drawn[i].shared = G.members;
  for (const asset of [...RAW.COMMONS, ...RAW.FRAMEWORKS]) {
    for (const uid of asset.createdBy || []) relate(uid, asset.id, 'createdBy', asset.id);
    for (const uid of asset.usedBy || []) relate(asset.id, uid, 'usedBy', asset.id);
  }
  for (const e of drawn) {
    const A = MODEL.byId.get(e.a), B = MODEL.byId.get(e.b);
    e.len = Math.hypot(B.X - A.X, B.Y - A.Y);
  }
  return { drawn, pairs, groups };
})();

const onLine = (e, id) => e.a === id || e.b === id || (e.shared || []).includes(id);

/** The paths the page shows with every marker on screen (§4.3, one line per
 *  organisation), as indices into RELATIONS.drawn: every relation outside a
 *  group, and one path per group — its head's, or the focused card's own when
 *  the focus belongs to the group. */
function shownWith(focus = null) {
  const shown = new Set();
  RELATIONS.drawn.forEach((e, i) => { if (!e.shared) shown.add(i); });
  for (const G of RELATIONS.groups.values()) {
    if (!G.lines.length) continue;
    const own = focus != null && G.members.includes(focus)
      ? G.lines.find((j) => RELATIONS.drawn[j].b === focus) : undefined;
    shown.add(own != null ? own : G.lines[0]);
  }
  return shown;
}
/** The indices a focus on `id` lights, and the lines themselves. */
const fanIdx = (id) => [...shownWith(id)].filter((i) => onLine(RELATIONS.drawn[i], id)).sort((a, b) => a - b);
const fanOf = (id) => fanIdx(id).map((i) => RELATIONS.drawn[i]);

/** §4.3's two attenuations, written out from the spec's prose: 0.85 at four
 *  neighbours or fewer, 0.40 at sixteen or more, and lighter still with length. */
function fanBase(n) {
  const fan = Math.min(1, Math.max(0, (n - 4) / 12));
  return { op: 0.85 - 0.45 * fan, w: 1.8 - 0.6 * fan };
}

/** Every entity that has a fan, widest first, ties to the lower id. */
const FAN_RANK = (() => {
  const n = MODEL.all.map((m) => [m.id, fanIdx(m.id).length]);
  return n.filter(([, k]) => k > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
})();
const widestFan = (ok = () => true) => FAN_RANK.find(([, n]) => ok(n));
const narrowestFan = (ok = () => true) => [...FAN_RANK].reverse().find(([, n]) => ok(n));

/** The places on §4.3's attenuation ramp worth a fixture, filled with whatever
 *  entity in today's payload sits there. The spec pins the ramp's ends — 0.85
 *  "at four neighbours or fewer", 0.40 "at sixteen or more" — so a fixture is
 *  chosen by where its fan falls rather than named, and a regeneration cannot
 *  quietly turn the sixteen-link fixture into a five-link one. Ties go to the
 *  lower id, so a regeneration that leaves the widths alone leaves the
 *  fixtures alone; a landmark the corpus does not reach drops out rather than
 *  being faked, and `fanFixture()` says so where a test depends on it. */
const FAN_LANDMARKS = {
  sole: { why: 'the narrowest fan there is', at: narrowestFan() },
  plateauHigh: { why: 'the widest fan still on the 0.85 plateau', at: widestFan((n) => n <= 4) },
  ramp: { why: 'the widest fan below sixteen', at: widestFan((n) => n > 4 && n < 16) },
  plateauLow: { why: 'the narrowest fan on the 0.40 plateau', at: narrowestFan((n) => n >= 16) },
  widest: { why: 'the widest fan in the corpus', at: widestFan() },
};
const fanFixture = (key) => {
  const f = FAN_LANDMARKS[key];
  if (!f.at) throw new Error(`no entity in this payload provides ${f.why}`);
  return { id: f.at[0], n: f.at[1], why: f.why };
};

/** The widest fan that reaches a team *and* something that is not a team —
 *  the fixture "an edge needs both ends visible" needs, because hiding the
 *  team layer has to leave part of that fan standing and take the rest. */
const MIXED_FAN = (() => {
  for (const [id, n] of FAN_RANK) {
    const ends = fanOf(id).map((e) => (e.a === id ? e.b : e.a));
    const teams = ends.filter((o) => MODEL.byId.get(o).kind === 'team').length;
    if (teams > 0 && teams < ends.length) return { id, n };
  }
  return null;
})();

/** The entity a test should reach for when it needs a marker of a given shape:
 *  the widest domain split in `kind`, which is the hardest case the payload
 *  offers and the one a silent cap on the domain list would show up in. Ties to
 *  the lower id, so the choice is stable across regenerations. */
const widestSplit = (ok) => MODEL.all
  .filter((m) => m.placed && ok(m))
  .sort((a, b) => b.domains.length - a.domains.length || (a.id < b.id ? -1 : 1))[0];

/** …and the counterpart: the plainest marker of a kind, for the single-domain
 *  cases. Payload order, so it is the same entity from run to run. */
const soleDomain = (kind) => MODEL.all.find((m) => m.placed && m.kind === kind && m.domains.length === 1);

/** The longest name of a labelled (that is, non-team) marker, optionally
 *  bounded — §4.2's truncation rule has a boundary at 34 characters and the
 *  corpus is what decides how close to it a test can get. */
const longestName = (ok = () => true) => MODEL.all
  .filter((m) => m.placed && m.kind !== 'team' && ok(m))
  .sort((a, b) => b.d.name.length - a.d.name.length || (a.id < b.id ? -1 : 1))[0];

// ------------------------------------------------------------ page-side reads

/** One marker, decomposed: the transparent hit target, the halo, the filled
 *  shapes, and whatever text it carries. */
function markerParts(page, id) {
  return page.evaluate((wanted) => {
    const el = mkEls[wanted];
    if (!el) return null;
    const kids = [...el.children];
    const body = kids[2];
    const shapes = body.tagName === 'g' ? [...body.children] : [body];
    const attrs = (s) => ({
      tag: s.tagName, fill: s.getAttribute('fill'), r: s.getAttribute('r'),
      x: s.getAttribute('x'), y: s.getAttribute('y'), width: s.getAttribute('width'),
      height: s.getAttribute('height'), rx: s.getAttribute('rx'), d: s.getAttribute('d'),
      stroke: s.getAttribute('stroke'), sw: s.getAttribute('stroke-width'),
      dash: s.getAttribute('stroke-dasharray'), points: s.getAttribute('points'),
    });
    const lbl = el.querySelector('text.lbl');
    return {
      domains: byId[wanted].domains.slice(),
      kind: byId[wanted].kind,
      transform: el.getAttribute('transform'),
      X: byId[wanted].X, Y: byId[wanted].Y,
      hit: attrs(kids[0]), halo: attrs(kids[1]),
      bodyTag: body.tagName,
      shapes: shapes.map(attrs),
      label: lbl ? lbl.textContent : null,
      star: !!el.querySelector('text.star'),
    };
  }, id);
}

/** Every drawn edge, paired with the model entry the page built it from. */
function edgeRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('#g-edges path.edge')].map((p, i) => ({
    a: edges[i].a, b: edges[i].b, len: edges[i].len,
    d: p.getAttribute('d'),
    stroke: p.getAttribute('stroke'),
    dash: p.getAttribute('stroke-dasharray'),
    on: p.classList.contains('on'),
    display: getComputedStyle(p).display,
    op: p.getAttribute('stroke-opacity') == null ? null : Number(p.getAttribute('stroke-opacity')),
    w: p.getAttribute('stroke-width') == null ? null : Number(p.getAttribute('stroke-width')),
  })));
}

/** A coordinate the page wrote with toFixed(1). Compared as a number against
 *  the value this test computed itself: Math.sin in two V8 builds may disagree
 *  in the last bit, and a string compare would turn that into a flake. */
function expectRounded(got, want, label) {
  expect(Math.abs(Number(got) - want), `${label}: ${got} is not ${want} rounded to a tenth`)
    .toBeLessThanOrEqual(0.0501);
}

const TRANSFORM = /^translate\((-?\d+\.\d),(-?\d+\.\d)\)(?: scale\(([\d.]+)\))?$/;
function expectMarkerAt(transform, X, Y, label) {
  const m = TRANSFORM.exec(transform);
  expect(m, `${label} transform "${transform}" must be translate(x,y) scale(k) at one decimal`).not.toBe(null);
  expectRounded(m[1], X, `${label} x`);
  expectRounded(m[2], Y, `${label} y`);
  return m[3] == null ? null : Number(m[3]);
}

const SLICE_D = /^M0,0 L(-?[\d.]+),(-?[\d.]+) A([\d.]+),([\d.]+) 0 ([01]),1 (-?[\d.]+),(-?[\d.]+) Z$/;
function parseSlice(d) {
  const m = SLICE_D.exec(d);
  if (!m) throw new Error('unexpected pie slice: ' + d);
  const [lx, ly, r1, r2] = m.slice(1, 5).map(Number);
  return { lx, ly, r1, r2, large: Number(m[5]), ex: Number(m[6]), ey: Number(m[7]) };
}

const EDGE_D = /^M(-?[\d.]+),(-?[\d.]+) Q(-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+)$/;
function parseEdge(d) {
  const m = EDGE_D.exec(d);
  if (!m) throw new Error('unexpected edge path: ' + d);
  const [ax, ay, cx, cy, bx, by] = m.slice(1).map(Number);
  return { ax, ay, cx, cy, bx, by };
}

const zoomState = (page) => page.evaluate(() => ({
  k: view.k, k0, z: view.k / k0,
  caps: getComputedStyle(document.getElementById('g-caps')).display,
  showLbl: document.getElementById('g-markers').classList.contains('show-lbl'),
}));

const setZ = async (page, z) => {
  await page.evaluate((f) => setView({ k: k0 * f, x: view.x, y: view.y }, false), z);
  await settleCounts(page);
};

/** Focus an entity without the flight: the fan's styling is what is under
 *  test, and a 520 ms animation is not something to wait on. */
const focusEntity = async (page, id) => {
  await page.evaluate((wanted) => openEntity(wanted, { fly: false }), id);
  await settleCounts(page);
};

/** The feed is open by default on a stage wider than 840px, and an open feed
 *  hides the floating panel — so which element holds the card depends on it.
 *  Note the asymmetry: with a card open, `body.detail-open` hides the floating
 *  clusters and with them the feed pill, so the feed is closed through its own
 *  close button. */
async function setFeedOpen(page, on) {
  if (await page.evaluate(() => state.feed) !== on) {
    await page.click(on ? '#feed-pill' : '#fd-close');
  }
  await settleCounts(page);
  expect(await page.evaluate(() => state.feed)).toBe(on);
}

/** Where the open card is rendered right now: the feed's copy when the feed is
 *  open, the floating panel's otherwise. Both come from cardHtml() (invariant 5),
 *  and bindCard() wires peek() into whichever one the reader is pointing at. */
const cardHost = (page) => page.evaluate(() => state.feed ? '#fd-list .fd-item.open .fd-card' : '#dt-body');

/** Markers overlap — that is what the jitter pass is for — so a fixture for a
 *  real pointer has to be chosen, not assumed. Returns the first of `ids` whose
 *  own centre is inside the stage and resolves to itself. */
async function pickHoverable(page, ids) {
  const found = await page.evaluate((wanted) => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    for (const id of wanted) {
      const el = mkEls[id];
      if (!el || el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < stage.left + 4 || x > stage.right - 4 || y < stage.top + 4 || y > stage.bottom - 4) continue;
      const hit = document.elementFromPoint(x, y);
      const mk = hit && hit.closest ? hit.closest('.mk') : null;
      if (mk && mk.dataset.id === id) return { id, x, y };
    }
    return null;
  }, ids);
  expect(found, `none of ${ids.length} candidate markers is reachable by pointer`).not.toBe(null);
  return found;
}

/** Move the real pointer onto a marker that pickHoverable() vouched for. */
async function hoverMarker(page, at) {
  await page.mouse.move(at.x, at.y);
}

/** `#map` is `inset:0` inside `#stage`, so one rectangle serves for both. It is
 *  needed by every gesture test because `view.x` is measured from that
 *  rectangle's top-left corner while a pointer event's `clientX` is measured
 *  from the viewport — and the 312 px sidebar of §5 is the whole of the
 *  difference. Converting between the two is what the handlers do with
 *  `- rect.left`, and getting it wrong moves every pointer zoom sideways by the
 *  width of the sidebar. */
const mapBox = (page) => page.evaluate(() => {
  const r = document.getElementById('map').getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
});

/** The world point under a point of the stage, and back again, from the view
 *  alone. "Zoomed about X" is the claim that one chosen point does not move. */
const worldUnder = (v, px, py) => [(px - v.x) / v.k, (py - v.y) / v.k];
const screenOf = (v, wx, wy) => [v.x + wx * v.k, v.y + wy * v.k];

const viewOf = (page) => page.evaluate(() => ({ x: view.x, y: view.y, k: view.k, k0, focus: state.focusId }));

/** Where a marker is on screen right now. */
const centreOf = (page, id) => page.evaluate((wanted) => {
  const r = mkEls[wanted].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, id);

/** Wait for a gesture to land. Playwright resolves `mouse.wheel()` and
 *  `mouse.dblclick()` when the event has been sent, not when the page has run
 *  its handler, so a read taken straight afterwards can be the view from
 *  before. */
const waitForK = (page, from) => page.waitForFunction((k) => view.k !== k, from);

/** A marker a real pointer can reach, with room around it for a gesture.
 *  Markers overlap — that is what the jitter pass is for — so the fixture has
 *  to be discovered rather than named, the same reason pickHoverable() exists;
 *  `pad` reserves the room the gesture needs on each side. Candidates are tried
 *  farthest from the stage centre first, because the centre is where #z-in,
 *  #z-out and fitView() all already anchor and so the one place where an
 *  anchoring bug cannot show. */
async function pickForGesture(page, pad = {}) {
  const want = { l: 90, r: 90, t: 90, b: 90, ...pad };
  const order = await page.evaluate((p) => {
    const st = document.getElementById('stage').getBoundingClientRect();
    const out = [];
    for (const id in mkEls) {
      const el = mkEls[id];
      if (el.style.display === 'none') continue;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < st.left + p.l || x > st.right - p.r || y < st.top + p.t || y > st.bottom - p.b) continue;
      out.push({ id, d: Math.hypot(x - (st.left + st.width / 2), y - (st.top + st.height / 2)) });
    }
    return out.sort((a, b) => b.d - a.d).map((o) => o.id);
  }, want);
  expect(order.length, 'no marker has room on the stage for this gesture').toBeGreaterThan(0);
  return pickHoverable(page, order);
}

/** A point of the stage over open water: inside #map, over no marker. */
async function pickEmptySea(page) {
  const sea = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    for (let fy = 0.18; fy < 0.9; fy += 0.06) {
      for (let fx = 0.12; fx < 0.9; fx += 0.06) {
        const x = Math.round(st.left + fx * st.width), y = Math.round(st.top + fy * st.height);
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest('#map') && !hit.closest('.mk')) return { x, y };
      }
    }
    return null;
  });
  expect(sea, 'no point of the stage is open water').not.toBe(null);
  return sea;
}

/** Every glyph of a key, in document order: the shapes inside its `.glyph` svg
 *  with the outline last, and the row's own label. The sidebar's layer rows and
 *  the legend on the map are both read through this one function, so the two
 *  keys are pinned to the same table and cannot drift apart. */
function glyphRows(page, rowSelector) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].map((row) => {
    const svg = row.querySelector('.glyph svg');
    const shapes = [...svg.querySelectorAll('circle,rect,path,polygon')];
    const o = shapes[shapes.length - 1];
    const lbl = row.querySelector('.lbl');
    return {
      key: row.dataset.layer || null,
      text: (lbl ? lbl.textContent : row.textContent).trim(),
      size: svg.getAttribute('width'),
      tags: shapes.map((s) => s.tagName),
      outline: o.tagName, r: o.getAttribute('r'), rx: o.getAttribute('rx'),
      dash: o.getAttribute('stroke-dasharray'), sw: o.getAttribute('stroke-width'),
    };
  }), rowSelector);
}

// =========================================================== §4.1 projection

test.describe('§4.1 projection and basemap', () => {
  test('§4.1 the canvas is 1000 × 710 and the projection is centred on 10°E / 52°N', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => ({ W: GEO.W, H: GEO.H, LAM0: GEO.LAM0, PHI1: GEO.PHI1 })))
      .toEqual({ W: 1000, H: 710, LAM0: 10, PHI1: 52 });
  });

  test('§4.1 the projection centre lands on the canvas anchor, exactly and repeatably', async ({ page }) => {
    await openMap(page);
    const r = await page.evaluate(() => ({
      centre: project(GEO.LAM0, GEO.PHI1),
      again: project(GEO.LAM0, GEO.PHI1),
      anchor: [GEO.TX, GEO.TY],
    }));
    expect(r.centre).toEqual(r.anchor);
    expect(r.again).toEqual(r.centre);          // no state, no drift between calls
  });

  test('§4.1 the projection is equal-area: a cell covers S² × its solid angle at every latitude', async ({ page }) => {
    // This is the claim §4.1 spends a sentence justifying — "a Mercator would
    // inflate the Nordics against Iberia and Italy". An equal-area projection
    // of a sphere of radius S maps a region of solid angle Ω onto exactly S²Ω
    // of canvas, whatever the latitude; a conformal one would not. The residual
    // below 1 is the straight-edged quadrilateral cutting the corners off the
    // curved cell, and that error must be the same at 40°N as at 68°N.
    await openMap(page);
    const cells = await page.evaluate(() => {
      const shoelace = (pts) => {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
          a += x1 * y2 - x2 * y1;
        }
        return Math.abs(a) / 2;
      };
      const out = [];
      for (const lat of [40, 52, 60, 68]) {
        for (const lon of [0, 10, 20]) {
          out.push({
            lat, lon,
            area: shoelace([project(lon, lat), project(lon + 1, lat), project(lon + 1, lat + 1), project(lon, lat + 1)]),
            S: GEO.S,
          });
        }
      }
      return out;
    });
    const ratios = cells.map((c) => {
      const rad = Math.PI / 180;
      const solid = rad * (Math.sin((c.lat + 1) * rad) - Math.sin(c.lat * rad));
      return c.area / (c.S * c.S * solid);
    });
    for (const [i, ratio] of ratios.entries()) {
      expect(ratio, `cell at ${cells[i].lat}°N ${cells[i].lon}°E`).toBeGreaterThan(0.9995);
      expect(ratio, `cell at ${cells[i].lat}°N ${cells[i].lon}°E`).toBeLessThan(1.0001);
    }
    // And the residual does not grow with latitude beyond the polygon error.
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1e-4);
  });

  test('§4.1 the central meridian is an axis of symmetry', async ({ page }) => {
    await openMap(page);
    const r = await page.evaluate(() => [5, 10, 20].map((d) => ({
      d, west: project(GEO.LAM0 - d, GEO.PHI1), east: project(GEO.LAM0 + d, GEO.PHI1), TX: GEO.TX,
    })));
    for (const { d, west, east, TX } of r) {
      expect(west[1], `±${d}° share a parallel`).toBeCloseTo(east[1], 10);
      expect(TX - west[0], `±${d}° mirror about the central meridian`).toBeCloseTo(east[0] - TX, 10);
    }
  });

  test('§4.1 east is right and north is up, monotonically', async ({ page }) => {
    await openMap(page);
    const r = await page.evaluate(() => ({
      xs: [-10, -5, 0, 5, 10, 15, 20, 25].map((lon) => project(lon, 50)[0]),
      ys: [36, 42, 48, 54, 60, 66].map((lat) => project(12, lat)[1]),
    }));
    for (let i = 1; i < r.xs.length; i++) expect(r.xs[i]).toBeGreaterThan(r.xs[i - 1]);
    for (let i = 1; i < r.ys.length; i++) expect(r.ys[i]).toBeLessThan(r.ys[i - 1]);
  });

  test('§4.1 the twenty capital labels sit at their own projected coordinates', async ({ page }) => {
    await openMap(page);
    const caps = await page.evaluate(() => [...document.querySelectorAll('#g-caps .cap')].map((el, i) => ({
      name: CAPITALS[i][0], lat: CAPITALS[i][1], lon: CAPITALS[i][2],
      transform: el.getAttribute('transform'),
      text: el.textContent,
      inv: Number((1 / view.k).toFixed(4)),
    })));
    expect(caps).toHaveLength(20);
    for (const c of caps) {
      const [x, y] = refProject(c.lon, c.lat);
      // The scale is required, not optional: the labels ride #world like the
      // markers do, so applyView() counter-scales them in the same pass, and a
      // transform without it means that pass stopped reaching them (§4.4).
      const at = /^translate\((-?[\d.]+),(-?[\d.]+)\) scale\(([\d.]+)\)$/.exec(c.transform);
      expect(at, `${c.name} transform "${c.transform}" must be translate(x,y) scale(1/k)`).not.toBe(null);
      expectRounded(at[1], x, `${c.name} x`);
      expectRounded(at[2], y, `${c.name} y`);
      expect(Number(at[3]), `${c.name} counter-scale`).toBe(c.inv);
      expect(c.text).toBe(c.name);
    }
    // The table itself, against coordinates nobody read off the page. Everything
    // above compares the page's rendering with the page's own latitudes, which a
    // transposition inside CAPITALS survives untouched.
    expect(caps.map((c) => c.name).sort()).toEqual(Object.keys(REF_CAPITALS).sort());
    for (const c of caps) {
      const [lat, lon] = REF_CAPITALS[c.name];
      expect(Math.abs(c.lat - lat), `${c.name} is at latitude ${c.lat}, not ${lat}`).toBeLessThan(0.15);
      expect(Math.abs(c.lon - lon), `${c.name} is at longitude ${c.lon}, not ${lon}`).toBeLessThan(0.15);
    }
    // Orientation, spelled out on real cities: Lisboa west of Madrid west of
    // Paris west of Helsinki; Helsinki north of Paris north of Athína.
    const at = (n) => caps.find((c) => c.name === n);
    const x = (n) => refProject(at(n).lon, at(n).lat)[0];
    const y = (n) => refProject(at(n).lon, at(n).lat)[1];
    expect(x('Lisboa')).toBeLessThan(x('Madrid'));
    expect(x('Madrid')).toBeLessThan(x('Paris'));
    expect(x('Paris')).toBeLessThan(x('Helsinki'));
    expect(y('Helsinki')).toBeLessThan(y('Paris'));
    expect(y('Paris')).toBeLessThan(y('Athína'));
  });

  test('§4.1 a Paris entity lands on Paris', async ({ page }) => {
    // The projection is only useful if a reader can find a city by eye. Every
    // entity whose city is Paris must land within a jitter radius of the Paris
    // capital label — 0.18° is a shade under 2 canvas units here.
    await openMap(page);
    const [px, py] = refProject(2.352, 48.857);
    const parisians = MODEL.all.filter((m) => m.placed && m.d.city === 'Paris');
    expect(parisians.length).toBeGreaterThan(5);
    const got = await page.evaluate((ids) => ids.map((id) => [byId[id].X, byId[id].Y]),
      parisians.map((m) => m.id));
    got.forEach(([x, y], i) => {
      expect(Math.hypot(x - px, y - py), parisians[i].id).toBeLessThan(4.5);
    });
    // …and Paris is in the left-of-centre, below-centre part of the canvas.
    expect(px).toBeGreaterThan(380); expect(px).toBeLessThan(450);
    expect(py).toBeGreaterThan(410); expect(py).toBeLessThan(470);
  });

  test('§4.1 every marker is placed by one trig pass over its own coordinates', async ({ page }) => {
    await openMap(page);
    const got = await page.evaluate(() => {
      const out = { inv: Number((1 / view.k).toFixed(4)) };
      for (const id in mkEls) out[id] = { X: byId[id].X, Y: byId[id].Y, transform: mkEls[id].getAttribute('transform') };
      return out;
    });
    expect(Object.keys(got).filter((k) => k !== 'inv').sort()).toEqual(PLACED.map((m) => m.id).sort());
    for (const m of PLACED) {
      const g = got[m.id];
      expect(g.X, `${m.id} X`).toBeCloseTo(m.X, 6);
      expect(g.Y, `${m.id} Y`).toBeCloseTo(m.Y, 6);
      expect(expectMarkerAt(g.transform, m.X, m.Y, m.id), `${m.id} counter-scale`).toBe(got.inv);
    }
  });

  test('§4.1 the basemap is the payload\'s own pre-projected geometry, drawn verbatim', async ({ page }) => {
    // "Geometry is pre-projected in europe-geo.js, so the runtime does one
    // trigonometric pass over the entity coordinates and nothing else."
    //
    // This is the one geometry channel on the page that was compared with
    // nothing. Every §4.1 projection test, every capital label, every marker
    // placement and all eleven §4.4 zoom tests read entity coordinates and
    // project(); the coastlines under them were only ever filtered for
    // escapable characters and counted (integrity.spec.js), and `#g-grat` was
    // not mentioned anywhere in the suite — the graticule was not asserted to
    // be drawn at all. Re-project, round, simplify or reorder the outlines at
    // runtime and a reader sees warped coastlines under correctly-placed
    // markers, which §3.1 says is exactly the kind of wrongness a reader will
    // not recognise as a bug.
    const GEOF = loadGeoFile();
    await openMap(page);
    const drawn = await page.evaluate(() => ({
      countries: [...document.querySelectorAll('#g-countries path.country')].map((p) => p.getAttribute('d')),
      grat: [...document.querySelectorAll('#g-grat path.grat')].map((p) => p.getAttribute('d')),
      tCountries: document.getElementById('g-countries').getAttribute('transform'),
      tGrat: document.getElementById('g-grat').getAttribute('transform'),
    }));
    // Not vacuous: both layers carry geometry to compare.
    expect(GEOF.countries.length).toBeGreaterThan(40);
    expect(GEOF.grat.length, 'a graticule of no lines would make the comparison empty').toBeGreaterThan(0);
    expect(drawn.countries).toHaveLength(GEOF.countries.length);
    expect(drawn.grat).toHaveLength(GEOF.grat.length);
    // Element for element *and* in order: later siblings paint on top, so a
    // reordering is as wrong as a reshaping. Compared one at a time because a
    // failing toEqual() over 65 half-kilobyte strings prints a diff nobody can
    // read; the message names the country instead.
    GEOF.countries.forEach((c, i) => {
      expect(drawn.countries[i] === c.d,
        `country ${i} should be ${c.n}: "${c.d.slice(0, 40)}…" but the page drew "${String(drawn.countries[i]).slice(0, 40)}…"`)
        .toBe(true);
    });
    GEOF.grat.forEach((d, i) => {
      expect(drawn.grat[i] === d,
        `graticule line ${i} should be "${d.slice(0, 40)}…" but the page drew "${String(drawn.grat[i]).slice(0, 40)}…"`)
        .toBe(true);
    });
    // And nothing is bent after the fact: a transform on either layer would
    // slide the coastlines out from under markers that are where they belong.
    expect([drawn.tCountries, drawn.tGrat]).toEqual([null, null]);
  });
});

// =============================================================== §4.2 jitter

test.describe('§4.2 the jitter pass', () => {
  test('§4.2 co-located entities are spread on a 0.18° circle, one seat each', async ({ page }) => {
    // "a city with eight labs shows eight markers rather than one".
    await openMap(page);
    const crowded = MODEL.all.filter((m) => m.placed && m.groupSize > 1);
    expect(crowded.length).toBeGreaterThan(80);
    // The largest stack is four. It was five — coda, haiku, hucan, jarvis and
    // waterverse on Rome's centroid — until the October 2026 review moved
    // project pins to each coordinator's address, which takes two of them out.
    expect(Math.max(...crowded.map((m) => m.groupSize))).toBeGreaterThanOrEqual(4);
    const got = await page.evaluate((ids) => ids.map((id) => [byId[id].d.lat, byId[id].d.lon]),
      crowded.map((m) => m.id));
    got.forEach(([lat, lon], i) => {
      const m = crowded[i];
      const a = 2 * Math.PI * m.groupIndex / m.groupSize;
      expect(lat, `${m.id} latitude`).toBeCloseTo(m.rawLat + 0.18 * Math.sin(a), 10);
      expect(lon, `${m.id} longitude`).toBeCloseTo(m.rawLon + 0.18 * Math.cos(a), 10);
      // Every seat is off the centre, including the first: a group of n leaves
      // no member on the original pin.
      expect(Math.hypot(lat - m.rawLat, lon - m.rawLon)).toBeCloseTo(0.18, 10);
    });
  });

  test('§4.2 an entity alone in its cell is left exactly where the data put it', async ({ page }) => {
    await openMap(page);
    const alone = MODEL.all.filter((m) => m.placed && m.groupSize === 1);
    expect(alone.length).toBeGreaterThan(200);
    const got = await page.evaluate((ids) => ids.map((id) => [byId[id].d.lat, byId[id].d.lon]),
      alone.map((m) => m.id));
    got.forEach(([lat, lon], i) => {
      expect(lat, `${alone[i].id} latitude`).toBe(alone[i].rawLat);
      expect(lon, `${alone[i].id} longitude`).toBe(alone[i].rawLon);
    });
  });

  test('§4.2 no two markers of one jitter group land on the same projected point', async ({ page }) => {
    await openMap(page);
    const positions = await page.evaluate(() => {
      const out = {};
      for (const id in mkEls) out[id] = [byId[id].X, byId[id].Y];
      return out;
    });
    let checked = 0, closest = Infinity;
    for (const groups of Object.values(MODEL.groups)) {
      for (const members of groups.values()) {
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            const [ax, ay] = positions[members[i].id], [bx, by] = positions[members[j].id];
            checked++;
            closest = Math.min(closest, Math.hypot(ax - bx, ay - by));
            // Not merely distinct floats: distinct at the tenth of a unit the
            // marker transform is rounded to, or the two pins overlap on screen.
            expect(`${ax.toFixed(1)},${ay.toFixed(1)}`, `${members[i].id} vs ${members[j].id}`)
              .not.toBe(`${bx.toFixed(1)},${by.toFixed(1)}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect(closest).toBeGreaterThan(1);
  });

  test('§4.2 the jitter is per layer group, so a team and a project in one cell still overlap', async ({ page }) => {
    // The spec says "jittered … per layer group", and that is visible in the
    // data: a team and an entity of another layer can carry the very same
    // coordinates and still be alone in their own group, so neither moves and
    // the two markers coincide. Asserted so that widening the jitter to one
    // global pass — which would separate them — cannot happen unnoticed. The
    // pair is looked up in the payload rather than named, so a regeneration
    // that moves one of them re-picks another instead of voiding the test.
    await openMap(page);
    const cell = (m) => m.rawLat.toFixed(2) + ',' + m.rawLon.toFixed(2);
    const lone = PLACED.filter((m) => m.groupSize === 1);
    const found = lone
      .filter((m) => m.kind === 'team')
      .map((t) => [t, lone.find((o) => o.kind !== 'team' && cell(o) === cell(t))])
      .find(([, o]) => o);
    expect(found, 'no two layer groups share a cell, so nothing can overlap').not.toBe(undefined);
    const pair = found.map((m) => m.id);
    for (const id of pair) expect(MODEL.byId.get(id).groupSize, id).toBe(1);
    const got = await page.evaluate((ids) => ids.map((id) => ({
      lat: byId[id].d.lat, lon: byId[id].d.lon, X: byId[id].X, Y: byId[id].Y, kind: byId[id].kind,
    })), pair);
    expect(got[0].kind).toBe('team');
    expect(got[1].kind, `${pair[1]} must be in another layer group`).not.toBe('team');
    expect(got[0].lat).toBe(found[0].rawLat);
    expect(got[1].lat).toBe(found[1].rawLat);
    expect([got[0].X, got[0].Y]).toEqual([got[1].X, got[1].Y]);
  });

  test('§4.2 the jitter is applied once, before projection, and is stable across sessions', async ({ page }) => {
    // "This is applied once, before projection, and is therefore stable across
    // sessions" — no Math.random, no time seed. Two loads, identical geometry.
    await openMap(page);
    const first = await page.evaluate(() => {
      const out = {};
      for (const id in mkEls) out[id] = mkEls[id].getAttribute('transform');
      return out;
    });
    await page.reload();
    await expect(page.locator('#st-note')).not.toBeEmpty();
    const second = await page.evaluate(() => {
      const out = {};
      for (const id in mkEls) out[id] = mkEls[id].getAttribute('transform');
      return out;
    });
    expect(second).toEqual(first);
    // And it matches the jitter this test computed from the payload on disk.
    for (const m of PLACED) expectMarkerAt(first[m.id], m.X, m.Y, m.id);
  });
});

// ============================================== §4.2 markers · invariant 2

test.describe('§4.2 markers, and invariant 2', () => {
  test('§4.2 one marker per placed entity, and none for anything else', async ({ page }) => {
    await openMap(page);
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('#g-markers .mk')].map((el) => el.dataset.id));
    expect(ids).toHaveLength(PLACED.length);
    expect(new Set(ids).size).toBe(PLACED.length);
    expect([...ids].sort()).toEqual(PLACED.map((m) => m.id).sort());
  });

  test('inv.2 the silhouette is a function of the layer and nothing else', async ({ page }) => {
    // Invariant 2's first half. The fills are left out of the signature on
    // purpose: those are the domain channel. What is left — the hit target, the
    // halo, the outline's tag, size, corner radius, stroke weight and dash —
    // must come out identical for every entity of a layer, and different
    // between layers, or shape has started encoding something else.
    await openMap(page);
    const sil = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('#g-markers .mk')) {
        const it = byId[el.dataset.id];
        const kids = [...el.children];
        const body = kids[2];
        const shapes = body.tagName === 'g' ? [...body.children] : [body];
        const o = shapes[shapes.length - 1];
        const key = JSON.stringify({
          hit: kids[0].getAttribute('r'), halo: kids[1].getAttribute('r'),
          tag: o.tagName, r: o.getAttribute('r'), w: o.getAttribute('width'), pts: o.getAttribute('points'),
          rx: o.getAttribute('rx'), sw: o.getAttribute('stroke-width'),
          dash: o.getAttribute('stroke-dasharray'), stroke: o.getAttribute('stroke'),
        });
        (out[it.kind] = out[it.kind] || {})[key] = (out[it.kind][key] || 0) + 1;
      }
      return out;
    });
    for (const kind of KINDS) {
      expect(Object.keys(sil[kind]), `${kind} markers must share one silhouette`).toHaveLength(1);
    }
    const key = (kind) => Object.keys(sil[kind])[0];
    expect(new Set(KINDS.map(key)).size, 'each layer needs its own silhouette').toBe(KINDS.length);

    // And the silhouettes are the ones §4.2 tabulates.
    const parsed = Object.fromEntries(KINDS.map((k) => [k, JSON.parse(key(k))]));
    expect(parsed.project).toMatchObject({ tag: 'circle', r: String(SPEC_R.project), dash: null });
    expect(parsed.commons).toMatchObject({ tag: 'circle', r: String(SPEC_R.commons), dash: '3 2.4' });
    expect(parsed.team).toMatchObject({ tag: 'circle', r: String(SPEC_R.team), dash: null });
    // A framework is a rounded square: side = 2r, corner radius 2.5.
    expect(parsed.framework).toMatchObject({ tag: 'rect', w: String(2 * SPEC_R.framework), rx: '2.5' });
    // A cluster is a hexagon, its outline a polygon with no radius attribute.
    expect(parsed.cluster).toMatchObject({ tag: 'polygon', r: null, dash: null });
    // Teams carry the thinner stroke the table asks for; the rest a heavier one.
    expect(Number(parsed.team.sw)).toBeLessThan(Number(parsed.project.sw));
    expect(parsed.project.sw).toBe(parsed.commons.sw);
    // The halo clears the marker by the same margin whatever the layer.
    for (const kind of KINDS) {
      const r = kind === 'framework' || kind === 'cluster' ? SPEC_R[kind] : Number(parsed[kind].r);
      expect(Number(parsed[kind].halo), `${kind} halo`).toBe(r + 5);
    }
  });

  test('inv.2 every domain has exactly one colour, and it is the same in every layer', async ({ page }) => {
    // Invariant 2's second half, plus §4.2's "seventeen domain colours".
    await openMap(page);
    const seen = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('#g-markers .mk')) {
        const it = byId[el.dataset.id];
        const body = [...el.children][2];
        const shapes = body.tagName === 'g' ? [...body.children] : [body];
        it.domains.forEach((d, i) => {
          const fill = shapes[i].getAttribute('fill');
          out[d] = out[d] || { fills: [], kinds: [] };
          if (!out[d].fills.includes(fill)) out[d].fills.push(fill);
          if (!out[d].kinds.includes(it.kind)) out[d].kinds.push(it.kind);
        });
      }
      return out;
    });
    for (const [dom, info] of Object.entries(seen)) {
      expect(info.fills, `${dom} must have exactly one colour`).toHaveLength(1);
      expect(info.fills[0], `${dom} colour`).toBe(SPEC_COLORS[dom]);
    }
    // The 17 colours are pairwise distinct — two domains sharing one would make
    // colour unreadable as a domain.
    expect(new Set(Object.values(SPEC_COLORS)).size).toBe(17);
    expect(await page.evaluate(() => ({
      count: ALL_DOMS.length,
      groups: Object.fromEntries(DOM_GROUPS.map((g) => [g.key, g.doms])),
      colors: COLORS,
    }))).toEqual({ count: 17, groups: SPEC_GROUPS, colors: SPEC_COLORS });
    // Shape is not smuggling domain in: energy is drawn in all five layers,
    // the hexagons of LF Energy or CRESYM included, and so is the catch-all —
    // so the one-colour check above really did compare a hexagon with the rest.
    expect(seen.energy.kinds.sort()).toEqual([...KINDS].sort());
    expect(seen.multi.kinds.sort()).toEqual([...KINDS].sort());
  });

  test('inv.2 the domain key carries the marker colour — filter swatches and card badges', async ({ page }) => {
    // Invariant 2 is a claim about a channel, and a channel a reader cannot
    // decode is not one. Every colour assertion in the suite reads marker
    // fills; the two surfaces that say what a fill *means* are elsewhere — the
    // domain filter's swatch and the card's domain badges — and both were read
    // for their count and their text but never for their colour. Swapping two
    // entries so that the swatch disagreed with the marker, or collapsing
    // either site to a constant, left a key that lies about the map and failed
    // nothing.
    await openMap(page);
    const sw = await page.evaluate(() => [...document.querySelectorAll('#domain-groups input[data-dom]')].map((cb) => ({
      dom: cb.dataset.dom,
      bg: getComputedStyle(cb.parentNode.querySelector('.dot')).backgroundColor,
    })));
    expect(sw.map((x) => x.dom).sort()).toEqual(Object.keys(SPEC_COLORS).sort());
    for (const x of sw) expect(x.bg, `the ${x.dom} swatch`).toBe(rgbOf(SPEC_COLORS[x.dom]));
    // Seventeen swatches, seventeen colours: a table collapsed onto one colour
    // would satisfy every per-domain check above if the markers collapsed too.
    expect(new Set(sw.map((x) => x.bg)).size, 'the swatches must be pairwise distinct').toBe(17);

    // The card's badges, on the entity whose pie the slice test below pins —
    // the widest domain split in the corpus, so the badge row is the longest
    // the card ever draws. The expected order is the entity's own domain order
    // out of the payload, which is the order the slices are asserted in, so
    // swatch, badge and slice all hang off one table and cannot disagree.
    const subject = widestSplit((m) => m.kind !== 'framework');
    const id = subject.id;
    const want = MODEL.byId.get(id).domains;
    expect(want.length, `${id} must carry more than one domain to have a badge row`).toBeGreaterThan(1);
    await focusEntity(page, id);
    const host = await cardHost(page);
    const dots = await page.evaluate((sel) =>
      [...document.querySelectorAll(sel + ' .dt-dom .dot')].map((d) => getComputedStyle(d).backgroundColor), host);
    expect(dots).toHaveLength(want.length);
    want.forEach((dom, i) => {
      expect(dots[i], `${id} badge ${i} is the ${dom} badge`).toBe(rgbOf(SPEC_COLORS[dom]));
    });
  });

  test('inv.2 two entities of the same layer and domains draw the identical marker', async ({ page }) => {
    // The sharpest reading of "neither channel encodes anything else": if layer
    // and domain set are all that a marker shows, then two entities agreeing on
    // both must produce byte-identical markup. Status, tier, funding, date
    // confidence, pin count — none of them may reach the glyph. Scores of
    // groups in the corpus have more than one member and disagree on status or
    // tier, so a leak would be caught here rather than by eye; how many there
    // are today is computed below rather than written down.
    await openMap(page);
    const groups = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('#g-markers .mk')) {
        const it = byId[el.dataset.id];
        const copy = el.cloneNode(true);
        // The name label is the one per-entity thing a marker may carry.
        copy.querySelectorAll('text.lbl').forEach((n) => n.remove());
        const key = it.kind + '|' + it.domains.join(',');
        out[key] = out[key] || { markup: [], ids: [] };
        if (!out[key].markup.includes(copy.innerHTML)) out[key].markup.push(copy.innerHTML);
        out[key].ids.push(it.id);
      }
      return out;
    });
    const shared = Object.entries(groups).filter(([, v]) => v.ids.length > 1);
    for (const [key, v] of shared) {
      expect(v.markup, `${key} (${v.ids.slice(0, 3).join(', ')}…) must draw one marker`).toHaveLength(1);
    }
    // The groups the payload actually contains, so that the comparison above
    // covers every one of them: a page that drew half its markers into a
    // single group would satisfy the loop and fail here.
    const byLayerAndDomains = new Map();
    for (const m of PLACED) {
      const key = m.kind + '|' + m.domains.join(',');
      if (!byLayerAndDomains.has(key)) byLayerAndDomains.set(key, []);
      byLayerAndDomains.get(key).push(m.id);
    }
    const wantShared = [...byLayerAndDomains].filter(([, ids]) => ids.length > 1);
    expect(shared.length, 'layer + domain groups with more than one member').toBe(wantShared.length);
    expect(wantShared.length, 'the payload must contain at least one such group').toBeGreaterThan(0);
    expect(shared.map(([k]) => k).sort()).toEqual(wantShared.map(([k]) => k).sort());
    // Not vacuous: within those groups, entities really do differ in ways the
    // marker must ignore.
    const tell = (id) => {
      const m = MODEL.byId.get(id);
      return m.d.status + '/' + m.d.tier;
    };
    const varying = shared.filter(([, v]) => new Set(v.ids.map(tell)).size > 1);
    const wantVarying = wantShared.filter(([, ids]) => new Set(ids.map(tell)).size > 1);
    expect(varying.length, 'groups whose members disagree on status or tier').toBe(wantVarying.length);
    expect(wantVarying.length, 'some group must disagree, or the claim is untested').toBeGreaterThan(0);
  });

  test('§4.2 a multi-domain circle is equal pie slices, one per domain, in the entity\'s own order', async ({ page }) => {
    // "deliberately not a primary domain plus badges": n domains, n slices of
    // 2π/n, starting at twelve o'clock, coloured in the entity's domain order —
    // which is its lead domain first, not the palette's order.
    await openMap(page);
    // One fixture per circle layer — the widest domain split each of them
    // offers, which is the hardest pie that layer can be asked to draw.
    const pies = ['project', 'team', 'commons'].map((k) => widestSplit((m) => m.kind === k));
    pies.forEach((fx, i) => {
      expect(fx, `layer ${['project', 'team', 'commons'][i]} has no placed entity`).not.toBe(undefined);
      expect(fx.domains.length, `${fx.id} must be multi-domain to draw a pie at all`).toBeGreaterThan(1);
    });
    for (const { id } of pies) {
      const mk = await markerParts(page, id);
      // The domain list is the payload's, not whatever the page kept.
      expect(mk.domains, `${id} domains`).toEqual(MODEL.byId.get(id).domains);
      const n = mk.domains.length;
      expect(n, id).toBeGreaterThan(1);
      expect(mk.bodyTag, id).toBe('g');
      expect(mk.shapes, id).toHaveLength(n + 1);            // n wedges + the outline
      const r = SPEC_R[mk.kind];
      mk.domains.forEach((dom, i) => {
        const s = mk.shapes[i];
        expect(s.tag, `${id} slice ${i}`).toBe('path');
        expect(s.fill, `${id} slice ${i} colour`).toBe(SPEC_COLORS[dom]);
        // Equal slices: every wedge subtends 2π/n, the first opening at twelve
        // o'clock, and each is an arc of the marker's own radius.
        const a1 = 2 * Math.PI * i / n - Math.PI / 2, a2 = 2 * Math.PI * (i + 1) / n - Math.PI / 2;
        const g = parseSlice(s.d);
        expect(g.lx, `${id} slice ${i} start x`).toBeCloseTo(r * Math.cos(a1), 1);
        expect(g.ly, `${id} slice ${i} start y`).toBeCloseTo(r * Math.sin(a1), 1);
        expect(g.ex, `${id} slice ${i} end x`).toBeCloseTo(r * Math.cos(a2), 1);
        expect(g.ey, `${id} slice ${i} end y`).toBeCloseTo(r * Math.sin(a2), 1);
        expect([g.r1, g.r2], `${id} slice ${i} radii`).toEqual([r, r]);
        expect(g.large, `${id} slice ${i} large-arc flag`).toBe((a2 - a1) > Math.PI ? 1 : 0);
        expect(Math.hypot(g.lx, g.ly), `${id} slice ${i} sits on the rim`).toBeCloseTo(r, 1);
      });
      const outline = mk.shapes[n];
      expect(outline.fill, `${id} outline`).toBe('none');
      expect(outline.r, `${id} outline radius`).toBe(String(r));
    }
    // The wedge order is the entity's own domain list, not the palette's. The
    // fixture is the widest pie the palette would reorder — its lead domain
    // sits late in §4.2's table, so a palette-ordered pie would open on
    // another colour entirely.
    const PALETTE = [...SPEC_GROUPS.industrial, ...SPEC_GROUPS.research, ...SPEC_GROUPS.infra];
    const paletteOrder = (doms) => doms.slice().sort((a, b) => PALETTE.indexOf(a) - PALETTE.indexOf(b));
    const own = widestSplit((m) => m.kind !== 'framework' && m.domains.length > 1
      && paletteOrder(m.domains).join() !== m.domains.join());
    expect(own, 'no pie in this payload disagrees with the palette order').not.toBe(undefined);
    const wedges = await markerParts(page, own.id);
    expect(wedges.domains, `${own.id} domains`).toEqual(own.domains);
    expect(wedges.shapes.slice(0, own.domains.length).map((s) => s.fill))
      .toEqual(own.domains.map((d) => SPEC_COLORS[d]));
    // …and that really is a different pie from the palette-ordered one.
    expect(wedges.shapes.slice(0, own.domains.length).map((s) => s.fill))
      .not.toEqual(paletteOrder(own.domains).map((d) => SPEC_COLORS[d]));
  });

  test('§4.2 the widest domain split in the corpus gets one slice per domain, not a cap of five', async ({ page }) => {
    // A pie that silently truncated its domain list would still look
    // plausible, so count the wedges and the turn they close: n arcs of 2π/n
    // come back to the start. The fixture is whichever entity carries the most
    // domains today, since that is the only place a cap would show.
    await openMap(page);
    const fx = widestSplit((m) => m.kind !== 'framework');
    const n = fx.domains.length;
    expect(n, `${fx.id} carries the widest split in the payload`).toBeGreaterThan(5);
    const mk = await markerParts(page, fx.id);
    expect(mk.domains).toEqual(fx.domains);
    expect(mk.shapes.filter((s) => s.tag === 'path')).toHaveLength(n);
    const slices = mk.shapes.slice(0, n).map((s) => parseSlice(s.d));
    // Each slice starts where the previous one ended, and the last closes the
    // circle back onto the first — a truncated domain list would leave a gap.
    for (let i = 1; i < n; i++) {
      expect(slices[i].lx, `slice ${i} starts where ${i - 1} ended`).toBeCloseTo(slices[i - 1].ex, 1);
      expect(slices[i].ly, `slice ${i} starts where ${i - 1} ended`).toBeCloseTo(slices[i - 1].ey, 1);
    }
    expect(slices[n - 1].ex).toBeCloseTo(slices[0].lx, 1);
    expect(slices[n - 1].ey).toBeCloseTo(slices[0].ly, 1);
    expect(new Set(mk.shapes.slice(0, n).map((s) => s.fill)).size).toBe(n);
  });

  test('§4.2 a multi-domain framework is equal vertical bands under one rounded outline', async ({ page }) => {
    await openMap(page);
    // The widest framework split there is: the most bands the payload can ask
    // for under one outline.
    const fx = widestSplit((m) => m.kind === 'framework');
    expect(fx, 'no framework is placed, so no square is drawn').not.toBe(undefined);
    const mk = await markerParts(page, fx.id);
    expect(mk.domains, `${fx.id} domains`).toEqual(fx.domains);
    const n = mk.domains.length;
    expect(n, `${fx.id} must be multi-domain to band at all`).toBeGreaterThan(1);
    const r = SPEC_R.framework, w = 2 * r, bw = w / n;
    expect(mk.bodyTag).toBe('g');
    expect(mk.shapes).toHaveLength(n + 1);
    mk.domains.forEach((dom, i) => {
      const s = mk.shapes[i];
      expect(s.tag).toBe('rect');
      expect(s.fill, `band ${i}`).toBe(SPEC_COLORS[dom]);
      expect(s.x, `band ${i} left edge`).toBe((-r + i * bw).toFixed(2));
      expect(s.width, `band ${i} width`).toBe(bw.toFixed(2));
      expect(s.height, `band ${i} height`).toBe(String(w));
      expect(s.rx, `bands are not individually rounded`).toBe(null);
    });
    const outline = mk.shapes[n];
    expect(outline).toMatchObject({ tag: 'rect', fill: 'none', rx: '2.5', width: String(w) });
  });

  test('§4.2 a cluster is a hexagon, and several domains are vertical bands cut to its outline', async ({ page }) => {
    await openMap(page);
    // One domain: a single six-point polygon in that domain's colour.
    const solo = soleDomain('cluster');
    expect(solo, 'no placed cluster carries a single domain').not.toBe(undefined);
    const one = await markerParts(page, solo.id);
    expect(one.bodyTag, `${solo.id} is one shape, not a group`).toBe('polygon');
    expect(one.shapes).toHaveLength(1);
    expect(one.shapes[0]).toMatchObject({ tag: 'polygon', fill: SPEC_COLORS[solo.domains[0]] });
    expect(one.shapes[0].points.split(' ')).toHaveLength(6);
    // Several: one band per domain, then the hexagon outline on top.
    const fx = widestSplit((m) => m.kind === 'cluster');
    const mk = await markerParts(page, fx.id);
    const n = mk.domains.length;
    expect(n, `${fx.id} must be multi-domain to band at all`).toBeGreaterThan(1);
    expect(mk.bodyTag).toBe('g');
    expect(mk.shapes).toHaveLength(n + 1);
    mk.domains.forEach((dom, i) =>
      expect(mk.shapes[i], `band ${i}`).toMatchObject({ tag: 'polygon', fill: SPEC_COLORS[dom] }));
    expect(mk.shapes[n]).toMatchObject({ tag: 'polygon', fill: 'none' });
    expect(mk.shapes[n].points.split(' ')).toHaveLength(6);
    // The outline sits on its circumradius, and the bands tile it in equal
    // areas: equal widths would give a hexagon's middle band the most ink.
    const pts = (s) => s.points.split(' ').map((p) => p.split(',').map(Number));
    const area = (P) => Math.abs(P.reduce((a, p, i) => {
      const q = P[(i + 1) % P.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    for (const [x, y] of pts(mk.shapes[n])) expect(Math.hypot(x, y)).toBeCloseTo(SPEC_R.cluster * 1.08, 1);
    const whole = area(pts(mk.shapes[n]));
    const bands = mk.shapes.slice(0, n).map((s) => area(pts(s)));
    expect(bands.reduce((a, b) => a + b, 0)).toBeCloseTo(whole, 1);
    for (const b of bands) expect(Math.abs(b - whole / n), 'one band per domain, of equal area').toBeLessThan(whole * 0.01);
  });

  test('§4.2 a single-domain marker is one solid shape, not a one-slice pie', async ({ page }) => {
    await openMap(page);
    // One fixture per circle layer, each the first single-domain entity its
    // layer offers, with §4.2's dash column alongside: a plain marker is the
    // body shape itself, not a group holding a single wedge.
    const DASH = { project: null, team: null, commons: '3 2.4' };
    for (const kind of ['project', 'team', 'commons']) {
      const fx = soleDomain(kind);
      expect(fx, `no placed ${kind} carries a single domain`).not.toBe(undefined);
      const mk = await markerParts(page, fx.id);
      expect(mk.domains, `${fx.id} domains`).toEqual(fx.domains);
      expect(mk.bodyTag, `${fx.id} is one shape, not a group`).toBe('circle');
      expect(mk.shapes, fx.id).toHaveLength(1);
      expect(mk.shapes[0], fx.id).toMatchObject({
        tag: 'circle', r: String(SPEC_R[kind]), fill: SPEC_COLORS[fx.domains[0]], dash: DASH[kind],
      });
    }
  });

  test('§4.2 the draw order is team → commons → framework → cluster → project', async ({ page }) => {
    // "so the large, sparse markers sit above the dense small ones" — in SVG,
    // later siblings paint on top, so the document order *is* the stacking.
    await openMap(page);
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#g-markers .mk')].map((el) => byId[el.dataset.id].kind));
    const rank = order.map((k) => SPEC_DRAW_ORDER.indexOf(k));
    for (let i = 1; i < rank.length; i++) {
      expect(rank[i], `marker ${i} (${order[i]}) must not come before ${order[i - 1]}`)
        .toBeGreaterThanOrEqual(rank[i - 1]);
    }
    // All five layers really are present, so the check above is not vacuous.
    expect(new Set(order)).toEqual(new Set(KINDS));
    expect(rank[0]).toBe(0);
    expect(rank[rank.length - 1]).toBe(4);
  });

  test('§4.2 the halo is invisible until the marker is hovered or focused', async ({ page }) => {
    await openMap(page);
    // The halo fades over 150 ms, so every reading is polled rather than
    // snatched mid-transition.
    const opacity = (id) => page.evaluate((wanted) =>
      getComputedStyle(mkEls[wanted].querySelector('.halo')).opacity, id);
    // Any placed entity will do for the resting state; the payload's first.
    const resting = PLACED[0].id;
    expect(await opacity(resting)).toBe('0');

    // The hover half, driven by a real pointer. It is a separate mechanism from
    // the focus half — one CSS selector each, in one rule — and with no card
    // open there is nothing for peek() to light (§4.3), so hover is the only
    // thing that can raise the halo here. Dropping `.mk:hover` from that rule
    // is a plausible tidy-up and would otherwise leave the whole map inert
    // under the pointer.
    const at = await pickHoverable(page, PLACED.map((m) => m.id));
    await hoverMarker(page, at);
    expect(await page.evaluate(() => peekId), 'no card is open, so nothing is peeked').toBe(null);
    await expect.poll(() => opacity(at.id)).toBe('1');
    await page.mouse.move(4, 4);                      // off the stage entirely
    await expect.poll(() => opacity(at.id)).toBe('0');

    // …and the focus half, which survives the pointer being elsewhere.
    await focusEntity(page, resting);
    await expect.poll(() => opacity(resting)).toBe('1');
  });

  test('§4.2 marker names are truncated at 34 characters, and teams carry none', async ({ page }) => {
    // A team name on every one of the map's small circles would be a second
    // basemap, so teams get no label element at all — not one that is merely
    // hidden. The 34-character boundary is exact: 34 renders whole, 35 becomes
    // 32 characters plus an ellipsis.
    await openMap(page);
    // Every team, not a chosen pair: a label that reappeared on one team only
    // would otherwise slip through.
    const labelledTeams = await page.evaluate(() => [...document.querySelectorAll('#g-markers .mk')]
      .filter((el) => byId[el.dataset.id].kind === 'team' && el.querySelector('text.lbl'))
      .map((el) => el.dataset.id));
    expect(labelledTeams, 'teams carry no label element').toEqual([]);
    expect(PLACED.filter((m) => m.kind === 'team').length, 'and there are teams to carry none')
      .toBeGreaterThan(0);
    // The two sides of the boundary, as close to it as the corpus reaches: the
    // longest name that still fits whole, and the longest name there is.
    const short = longestName((m) => m.d.name.length <= 34);
    expect(short, 'no labelled entity has a name of 34 characters or fewer').not.toBe(undefined);
    expect(short.d.name.length, `${short.id} fits whole`).toBeLessThanOrEqual(34);
    expect((await markerParts(page, short.id)).label).toBe(short.d.name);
    const long = longestName();
    expect(long.d.name.length, `${long.id} must be long enough to truncate`).toBeGreaterThan(34);
    const drawn = (await markerParts(page, long.id)).label;
    expect(drawn).toBe(long.d.name.slice(0, 32) + '…');
    expect(drawn).toHaveLength(33);
    // No label anywhere exceeds the bound.
    const worst = await page.evaluate(() =>
      Math.max(...[...document.querySelectorAll('#g-markers .mk .lbl')].map((el) => el.textContent.length)));
    expect(worst).toBeLessThanOrEqual(34);
  });

  test('§4.2 every marker carries a pin star and an oversized hit target', async ({ page }) => {
    await openMap(page);
    // The floor comes from §4.2's radius column as transcribed above, not from
    // the page's own MK_R: a hit target measured against the very table that
    // sized it would agree with any radius the page happened to pick.
    const r = await page.evaluate((specR) => {
      const out = { missingStar: [], smallHit: [] };
      for (const el of document.querySelectorAll('#g-markers .mk')) {
        const it = byId[el.dataset.id];
        if (!el.querySelector('text.star')) out.missingStar.push(it.id);
        const hit = Number([...el.children][0].getAttribute('r'));
        if (hit < Math.max(specR[it.kind] + 6, 11)) out.smallHit.push(it.id);
        if (getComputedStyle(el.querySelector('text.star')).display !== 'none') out.missingStar.push('visible:' + it.id);
      }
      return out;
    }, SPEC_R);
    expect(r).toEqual({ missingStar: [], smallHit: [] });
    // The smallest markers get the largest relative target: a 4.5-unit team
    // circle is still an 11-unit tap. Read off a team taken from the payload
    // rather than a named one — every team draws the same silhouette, which is
    // what invariant 2's test above establishes.
    const anyTeam = PLACED.find((m) => m.kind === 'team');
    expect(anyTeam, 'no team is placed, so the floor is untested').not.toBe(undefined);
    const team = await markerParts(page, anyTeam.id);
    expect(Number(team.hit.r)).toBe(11);
    expect(team.hit.fill).toBe('transparent');
  });
});

// =============================================================== §3.2 layers

test.describe('§3.2 layers', () => {
  test('§3.2 there are exactly five layers, and infrastructure is not one of them', async ({ page }) => {
    // "Infrastructure has no layer of its own, by design." Its entries arrive
    // as teams: some merge into a team already on the map, the rest are
    // rendered as team markers of their own. How many fall either way is a
    // snapshot (§3.2), so the split is computed from the payload below.
    await openMap(page);
    expect(await page.evaluate(() => KINDS)).toEqual(KINDS);
    await expect(page.locator('#layer-rows .layer-row[data-layer]')).toHaveCount(5);
    const kindsSeen = await page.evaluate(() => [...new Set(items.map((it) => it.kind))].sort());
    expect(kindsSeen).toEqual([...KINDS].sort());

    const withInfra = MODEL.all.filter((m) => m.d.infra);
    expect(withInfra.every((m) => m.kind === 'team')).toBe(true);
    const ownPin = withInfra.filter((m) => m.d.type === 'infrastructure');
    const merged = withInfra.filter((m) => m.d.type !== 'infrastructure');
    // An exhaustive partition, and both halves occupied — which is the part of
    // §3.2's "23 … the other 18" that is normative rather than a snapshot.
    expect(ownPin.length + merged.length).toBe(withInfra.length);
    expect(ownPin.length, 'infrastructure entries rendered as a team of their own').toBeGreaterThan(0);
    expect(merged.length, 'infrastructure entries folded into a team already on the map').toBeGreaterThan(0);
    // …and the page carries exactly those entries, every one of them a team
    // marker rather than a shape of its own.
    const pageInfra = await page.evaluate(() =>
      items.filter((it) => it.d.infra).map((it) => it.id + '|' + it.kind).sort());
    expect(pageInfra).toEqual(withInfra.map((m) => m.id + '|team').sort());
    expect(await page.evaluate(() => Object.keys(TOTALS).length)).toBe(5);
  });

  test('§3.2 the layer counts and totals come from the five source collections', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => ({ ...TOTALS }))).toEqual({
      project: RAW.PROJECTS.length, team: RAW.TEAMS.length, cluster: RAW.CLUSTERS.length,
      commons: RAW.COMMONS.length, framework: RAW.FRAMEWORKS.length,
    });
  });

  test('§17 every layer-keyed table in the page covers exactly KINDS', async ({ page }) => {
    // §17 calls a new layer "the expensive one" and then hands the next author
    // the enumeration: "KINDS, TOTALS, MK_R, the draw order, shapeSvg(),
    // relSections(), the legend, the welcome rows and the generator all
    // enumerate the five current layers." Of those tables only KINDS and TOTALS
    // were ever read back from the page. MK_R, KIND_ORDER and drawOrder are
    // hand-written literals, and each fails silently in its own way: no MK_R
    // entry draws r="NaN", an invisible marker that still satisfies "one marker
    // per placed entity"; no KIND_ORDER entry makes the feed's comparator
    // return NaN and sort unstably; no drawOrder entry gives indexOf -1, which
    // paints the new layer under everything. The legend and the welcome rows
    // are already safe because they are KINDS.map(…) — which is exactly the
    // difference this test is meant to make for the rest.
    //
    // The key sets are compared against the page's own KINDS rather than this
    // file's copy, so the test fires on a real fifth layer instead of only on
    // the literal at the top of this file going stale.
    await openMap(page);
    const got = await page.evaluate(() => ({
      kinds: [...KINDS],
      tables: {
        MK_R: Object.keys(MK_R),
        KIND_ORDER: Object.keys(KIND_ORDER),
        drawOrder: [...drawOrder],
        TOTALS: Object.keys(TOTALS),
      },
      radii: KINDS.map((k) => MK_R[k]),
      ranks: KINDS.map((k) => KIND_ORDER[k]),
      // §17's header-tile rule: one per layer, addressed by kind rather than by
      // a hand-written list, so the id has to exist for every kind.
      tileless: KINDS.filter((k) => !document.getElementById('st-' + k)),
      // shapeSvg() and the glyph table inside glyphHtml() are layer-keyed too,
      // and a missing entry there throws rather than degrading.
      glyphs: KINDS.map((k) => {
        try { return glyphHtml(k, 16).length; } catch (e) { return 'threw: ' + e.message; }
      }),
    }));
    expect(got.kinds.length, 'the page must declare some layers').toBeGreaterThan(0);
    for (const [name, keys] of Object.entries(got.tables)) {
      expect([...keys].sort(), `${name} is keyed by layer, so it must cover every layer and no other`)
        .toEqual([...got.kinds].sort());
    }
    // A permutation, not merely the same set: the draw order is a stacking order.
    expect(got.tables.drawOrder, 'the draw order lists each layer once').toHaveLength(got.kinds.length);
    expect(new Set(got.tables.drawOrder).size).toBe(got.kinds.length);
    // Present is not enough; the values have to be usable.
    got.radii.forEach((r, i) => expect(r, `MK_R.${got.kinds[i]}`).toBeGreaterThan(0));
    got.ranks.forEach((n, i) => expect(Number.isFinite(n), `KIND_ORDER.${got.kinds[i]} is ${n}`).toBe(true));
    got.glyphs.forEach((g, i) => expect(g, `glyphHtml('${got.kinds[i]}')`).toBeGreaterThan(20));
    expect(got.tileless, 'layers with no st-<kind> header tile').toEqual([]);
  });

  test('§3.2 an infrastructure domain code only ever reaches a marker through an infrastructure entry', async ({ page }) => {
    // §3.1's second load-bearing rule, read off the markers: the compute /
    // cluster / simulation colours are infrastructure categories. Dozens of
    // entities work on digital twins; not one of them is coloured `simulation`
    // unless it actually runs a facility, which is what would happen if
    // `digital_twins` were mapped to `simulation` again.
    await openMap(page);
    const infraDoms = SPEC_GROUPS.infra;
    const coded = MODEL.all.filter((m) => m.domains.some((d) => infraDoms.includes(d)));
    // The two sets are one set, in both directions: every entity wearing an
    // infrastructure colour has an infrastructure entry behind it, and every
    // infrastructure entry shows up in that colour. Pinning the size of the
    // set would say less and would not survive a regeneration.
    expect(coded.map((m) => m.id).sort())
      .toEqual(MODEL.all.filter((m) => m.d.infra).map((m) => m.id).sort());
    expect(coded.length, 'the payload must colour something as infrastructure').toBeGreaterThan(0);
    expect(coded.every((m) => m.kind === 'team' && !!m.d.infra)).toBe(true);
    const twins = MODEL.all.filter((m) => (m.d.focus || []).includes('digital_twins'));
    expect(twins.length).toBeGreaterThan(20);
    expect(twins.filter((m) => m.domains.includes('simulation') && !m.d.infra)).toEqual([]);
    // The page agrees: no project, commons or framework marker wears one of the
    // three infrastructure colours.
    const offenders = await page.evaluate((doms) => items
      .filter((it) => it.kind !== 'team' && it.domains.some((d) => doms.includes(d)))
      .map((it) => it.id), infraDoms);
    expect(offenders).toEqual([]);
  });

  test('§3.2 each layer row shows the same shape as that layer\'s markers', async ({ page }) => {
    // The legend is only a legend if its glyph is the marker. Note that the
    // framework glyph is the one place a single-domain rounded square is drawn:
    // every framework in the corpus is multi-domain.
    await openMap(page);
    const rows = await glyphRows(page, '#layer-rows .layer-row[data-layer]');
    const glyphs = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Object.keys(glyphs).sort()).toEqual([...KINDS].sort());
    expect(glyphs.project.outline).toBe('circle');
    expect(glyphs.project.dash).toBe(null);
    expect(glyphs.project.tags.filter((t) => t === 'path').length).toBe(3);  // shown as a pie
    expect(glyphs.team).toMatchObject({ outline: 'circle', dash: null });
    expect(glyphs.commons).toMatchObject({ outline: 'circle', dash: '3 2.4' });
    expect(glyphs.framework).toMatchObject({ outline: 'rect', rx: '2.5' });
    expect(glyphs.cluster).toMatchObject({ outline: 'polygon', dash: null, rx: null });
  });

  test('§3.2 the legend on the map shows the five marker silhouettes, not five circles', async ({ page }) => {
    // The test above reads the sidebar's layer rows and says "the legend is
    // only a legend if its glyph is the marker" — but the key a reader actually
    // has in front of them while looking at the map is the floating legend, and
    // the suite only ever read its text and measured its box. Pointing
    // renderLegend()'s glyphHtml(k, 16) at one fixed kind would print four
    // identical circles in the key and fail nothing: the shape channel becomes
    // unreadable while every marker on the map is still correct.
    await openMap(page);
    await page.click('#legend summary');
    await expect(page.locator('#legend-rows')).toBeVisible();
    const legend = await glyphRows(page, '#legend-rows .legend-row');
    const sidebar = await glyphRows(page, '#layer-rows .layer-row[data-layer]');
    expect(legend).toHaveLength(KINDS.length);
    // Both keys are KINDS.map(…), so they come out in the same order with the
    // same labels; i18n.spec.js owns what those labels say in each language.
    expect(sidebar.map((r) => r.key)).toEqual(KINDS);
    expect(legend.map((r) => r.text)).toEqual(sidebar.map((r) => r.text));
    // The per-kind silhouette, the same table the marker test pins.
    const want = {
      project: { outline: 'circle', dash: null, rx: null },
      team: { outline: 'circle', dash: null, rx: null },
      commons: { outline: 'circle', dash: '3 2.4', rx: null },
      framework: { outline: 'rect', rx: '2.5', dash: null },
      cluster: { outline: 'polygon', rx: null, dash: null },
    };
    KINDS.forEach((k, i) => {
      expect(legend[i], `the ${k} legend row`).toMatchObject(want[k]);
      // …and the same silhouette the sidebar draws, read through one function.
      expect([legend[i].outline, legend[i].rx, legend[i].dash, legend[i].sw],
        `the ${k} legend glyph and the ${k} layer row must draw one shape`)
        .toEqual([sidebar[i].outline, sidebar[i].rx, sidebar[i].dash, sidebar[i].sw]);
      expect(legend[i].size, 'the legend draws at 16px, the sidebar at 18').toBe('16');
    });
    // Five distinct silhouettes. This is the assertion that five circles fail.
    const sig = legend.map((r) => JSON.stringify([r.outline, r.rx, r.dash, r.sw]));
    expect(new Set(sig).size, `the legend draws ${sig.join(' / ')}`).toBe(KINDS.length);
    // A team's outline is the thin one here too (§4.2's stroke column).
    expect(Number(legend[KINDS.indexOf('team')].sw))
      .toBeLessThan(Number(legend[KINDS.indexOf('project')].sw));
  });
});

// ====================================================== invariant 3: off map

test.describe('invariant 3: an entity without coordinates', () => {
  test('inv.3 the entities without coordinates are kept, flagged, and given no marker', async ({ page }) => {
    await openMap(page);
    // How many entities have no coordinates is a snapshot figure (§3.2), so it
    // is counted from the payload; what is asserted is that the page found the
    // same ones — identity, not merely a matching total, since a page that
    // dropped one and invented another would still agree on the count.
    expect(UNPLACED.length, 'the payload must contain entities with no coordinates').toBeGreaterThan(0);
    expect(await page.evaluate(() => NOGEO)).toBe(UNPLACED.length);
    expect(await page.evaluate(() => items.filter((it) => !it.geo).map((it) => it.id).sort()))
      .toEqual(UNPLACED.map((m) => m.id).sort());
    const r = await page.evaluate((ids) => ids.map((id) => ({
      id, present: !!byId[id], geo: byId[id].geo, X: byId[id].X, Y: byId[id].Y,
      marker: !!mkEls[id], anyMarker: !!document.querySelector(`#g-markers .mk[data-id="${id}"]`),
    })), UNPLACED.map((m) => m.id));
    for (const row of r) {
      expect(row.present, row.id).toBe(true);
      expect(row.geo, `${row.id} must be flagged geo:false`).toBe(false);
      expect(row.marker, `${row.id} must have no marker`).toBe(false);
      expect(row.anyMarker, `${row.id} must have no marker`).toBe(false);
      expect([row.X, row.Y], `${row.id} is not projected`).toEqual([0, 0]);
    }
    // They are in the corpus, so the totals still count them.
    expect(await page.evaluate(() => items.length)).toBe(MODEL.all.length);
  });

  test('inv.3 an off-the-map entity keeps a card, a search result, a feed row and an off-the-map row', async ({ page }) => {
    // The four things invariant 3 promises, on one real entity: ISO 9241-210
    // has no coordinates because a standard has no address.
    const id = 'iso-9241-210';
    const name = MODEL.byId.get(id).d.name;
    await openMap(page);

    // 1 — a search result, reached the way a reader reaches it.
    await page.fill('#search', 'iso 9241');
    const hit = page.locator(`.sd-item[data-open="${id}"]`);
    await expect(hit).toBeVisible();
    await expect(hit.locator('.nm')).toHaveText(name);
    await hit.click();

    // 2 — a feed row, even though the feed lists what is in view and this can
    //     never be in view. (The feed is open by default on a wide stage.)
    expect(await snapshot(page).then((s) => s.focusId)).toBe(id);
    await setFeedOpen(page, true);
    await expect(page.locator(`#fd-list .fd-item[data-id="${id}"]`)).toHaveCount(1);
    await expect(page.locator(`#fd-list .fd-item[data-id="${id}"] .nm`)).toBeVisible();
    await expect(page.locator(`#fd-list .fd-item[data-id="${id}"] .nm`)).toHaveText(name);
    expect(await page.evaluate(() => state.inView.has('iso-9241-210'))).toBe(false);

    // 3 — a card, in both of the places that render one (invariant 5): the
    //     feed's copy, which is what a reader sees while the feed is open, and
    //     the floating panel once it is closed.
    await expect(page.locator(`#fd-list .fd-item[data-id="${id}"] .fd-card .dt-name`)).toHaveText(name);
    await setFeedOpen(page, false);
    await expect(page.locator('#detail')).toHaveClass(/open/);
    await expect(page.locator('#dt-body .dt-name')).toBeVisible();
    await expect(page.locator('#dt-body .dt-name')).toHaveText(name);

    // 4 — a row in the off-the-map list, and it counts as matching the filters.
    await expect(page.locator('#f-nogeo')).not.toBeHidden();
    await expect(page.locator(`#nogeo-list [data-id="${id}"]`)).toHaveCount(1);
    await expect(page.locator('#nogeo-count')).toHaveText(String(UNPLACED.length));
    expect(await page.evaluate(() => state.inFilter.has('iso-9241-210'))).toBe(true);
    expect(await page.evaluate(() => state.offMapMatch)).toBe(UNPLACED.length);
  });

  test('inv.3 adjacency is recorded even when an end is off the map, but no curve is drawn', async ({ page }) => {
    // "An entity off the map still participates in the graph." No off-map
    // entity in today's payload has a relation, so the invariant is unobservable
    // from the data alone — which is exactly why it is worth pinning down at
    // the mechanism: relate() is driven directly, with one end unplaced.
    await openMap(page);
    const offMap = UNPLACED[0].id;
    expect(fanOf(offMap)).toEqual([]);
    const r = await page.evaluate((off) => {
      const before = edges.length;
      const partner = items.find((it) => it.geo).id;
      relate(off, partner, { color: '#000', dash: null });
      return {
        partner,
        edgesGrew: edges.length - before,
        offSeesPartner: nOf(off).has(partner),
        partnerSeesOff: nOf(partner).has(off),
      };
    }, offMap);
    expect(r.edgesGrew, 'geometry needs both ends placed').toBe(0);
    expect(r.offSeesPartner, 'adjacency is recorded regardless').toBe(true);
    expect(r.partnerSeesOff, 'adjacency is symmetric').toBe(true);
  });

  test('inv.3 flying to an entity with no coordinates leaves the view alone', async ({ page }) => {
    await openMap(page);
    const before = await page.evaluate(() => ({ ...view }));
    await focusEntity(page, UNPLACED[0].id);
    await page.evaluate((id) => flyTo(id), UNPLACED[0].id);
    expect(await page.evaluate(() => ({ ...view }))).toEqual(before);
  });
});

// ================================================================ §4.3 edges

test.describe('§4.3 edges', () => {
  test('§4.3 one curve per relation that resolves and has both ends placed', async ({ page }) => {
    await openMap(page);
    const model = await page.evaluate(() => edges.map((e) => e.a + '>' + e.b));
    expect(model).toEqual(RELATIONS.drawn.map((e) => e.a + '>' + e.b));
    await expect(page.locator('#g-edges path.edge')).toHaveCount(RELATIONS.drawn.length);
    // Derived from the payload: the consortium links of edges.yml plus the
    // commons and framework cross-references that resolve.
    expect(RELATIONS.drawn.filter((e) => e.rel === 'consortium')).toHaveLength(RAW.EDGES.length);
    expect(RELATIONS.drawn.length).toBe(RAW.EDGES.length +
      [...RAW.COMMONS, ...RAW.FRAMEWORKS].reduce((n, a) => n + (a.createdBy || []).length + (a.usedBy || []).length, 0));
  });

  test('§4.3 adjacency and geometry are separate registers', async ({ page }) => {
    await openMap(page);
    const r = await page.evaluate(() => {
      const pairs = new Set();
      for (const [a, set] of neighbors) for (const b of set) pairs.add([a, b].sort().join('::'));
      return {
        pairs: pairs.size,
        edges: edges.length,
        bothPlaced: edges.every((e) => byId[e.a].geo && byId[e.b].geo),
      };
    });
    expect(r.pairs).toBe(RELATIONS.pairs.size);
    expect(r.edges).toBe(RELATIONS.drawn.length);
    expect(r.bothPlaced, 'every drawn curve joins two placed entities').toBe(true);
    // Some pairs are related twice — created one way, used the other — so the
    // curve count runs ahead of the adjacency count; pairs with an end off the
    // map are recorded but never drawn, and pull the other way. Both terms come
    // out of the model, so the gap is exact without a figure being written down.
    const drawnPairs = new Set(RELATIONS.drawn.map((e) => [e.a, e.b].sort().join('::')));
    const reciprocal = RELATIONS.drawn.length - drawnPairs.size;
    const undrawn = RELATIONS.pairs.size - drawnPairs.size;
    expect(r.edges - r.pairs).toBe(reciprocal - undrawn);
    expect(reciprocal, 'pairs related in both directions, which is what opens the gap')
      .toBeGreaterThan(0);
  });

  test('§4.3 consortium links are solid, "used by" links are dashed', async ({ page }) => {
    await openMap(page);
    const rows = await edgeRows(page);
    const expectDash = RELATIONS.drawn.map((e) => (e.rel === 'usedBy' ? '4 4' : null));
    expect(rows.map((r) => r.dash)).toEqual(expectDash);
    const dashed = expectDash.filter(Boolean).length;
    // How many of each there are is counted a second time, straight off the
    // payload's own `usedBy` lists rather than out of the edge list above, so
    // the two derivations have to agree: a "used by" curve for every placed
    // asset-and-user pair, and everything else solid.
    const usedByPairs = [...RAW.COMMONS, ...RAW.FRAMEWORKS]
      .flatMap((a) => (a.usedBy || []).map((uid) => [a.id, uid]))
      .filter(([a, b]) => MODEL.byId.has(a) && MODEL.byId.has(b)
        && MODEL.byId.get(a).placed && MODEL.byId.get(b).placed);
    expect(dashed).toBe(usedByPairs.length);
    expect(expectDash.length - dashed).toBe(RELATIONS.drawn.length - usedByPairs.length);
    // Both kinds of line are actually on the map, or the comparison above is
    // satisfied by a mesh that is all one thing.
    expect(dashed, 'dashed "used by" links').toBeGreaterThan(0);
    expect(expectDash.length - dashed, 'solid links').toBeGreaterThan(0);
  });

  test('§4.3 an edge takes its colour from the lead domain of the entity it belongs to', async ({ page }) => {
    // A consortium curve takes the funded project's colour; a cross-reference
    // curve takes the asset's. §4.3 calls that "the source entity's lead
    // domain", which for a createdBy link (drawn creator → asset) reads as the
    // creator's — but every createdBy link in this corpus joins two entities
    // that share a lead domain, so the two readings are indistinguishable here
    // and the assertion follows the code.
    await openMap(page);
    const rows = await edgeRows(page);
    expect(rows.map((r) => r.stroke)).toEqual(RELATIONS.drawn.map((e) => e.color));
    // Not vacuous: the colours really do vary, and a consortium link is
    // coloured by its project rather than by the team it reaches.
    expect(new Set(rows.map((r) => r.stroke)).size).toBeGreaterThan(6);
    const crossLead = RELATIONS.drawn
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.rel === 'consortium' && MODEL.byId.get(e.a).lead !== MODEL.byId.get(e.b).lead);
    expect(crossLead.length, 'consortium links whose ends disagree on lead domain').toBeGreaterThan(20);
    for (const e of crossLead) {
      expect(rows[e.i].stroke, `${e.a}→${e.b} takes the project's colour`)
        .toBe(SPEC_COLORS[MODEL.byId.get(e.a).lead]);
    }
  });

  test('§4.3 the control point is offset perpendicular to the chord by min(34, 0.14 × length)', async ({ page }) => {
    await openMap(page);
    const rows = await edgeRows(page);
    let clamped = 0, free = 0;
    rows.forEach((row, i) => {
      const g = parseEdge(row.d);
      const A = MODEL.byId.get(RELATIONS.drawn[i].a), B = MODEL.byId.get(RELATIONS.drawn[i].b);
      expectRounded(g.ax, A.X, `edge ${i} starts at ${A.id}`);
      expectRounded(g.ay, A.Y, `edge ${i} starts at ${A.id}`);
      expectRounded(g.bx, B.X, `edge ${i} ends at ${B.id}`);
      expectRounded(g.by, B.Y, `edge ${i} ends at ${B.id}`);
      const dx = B.X - A.X, dy = B.Y - A.Y;
      const len = Math.hypot(dx, dy) || 1;
      const off = Math.min(34, len * 0.14);
      if (len * 0.14 > 34) clamped++; else free++;
      const mx = (A.X + B.X) / 2, my = (A.Y + B.Y) / 2;
      expect(g.cx, `edge ${i} control x`).toBeCloseTo(mx - dy / len * off, 1);
      expect(g.cy, `edge ${i} control y`).toBeCloseTo(my + dx / len * off, 1);
      // Perpendicular: the control point's displacement from the midpoint has no
      // component along the chord. Measured as a fraction of the chord so that a
      // long edge is not judged by a rounding error multiplied by its length.
      const along = ((g.cx - mx) * dx + (g.cy - my) * dy) / len;
      expect(Math.abs(along), `edge ${i} offset is perpendicular`).toBeLessThan(0.11);
      // …and it is exactly as far out as the formula says. The edges whose two
      // markers coincide are the exception: with no chord there is no
      // perpendicular, and the control point stays on the midpoint.
      const bow = Math.hypot(dx, dy) === 0 ? 0 : off;
      expect(Math.abs(Math.hypot(g.cx - mx, g.cy - my) - bow), `edge ${i} bow`).toBeLessThan(0.11);
    });
    // Both branches of the min() are exercised by the corpus.
    expect(clamped, 'edges long enough for the 34-unit cap to bite').toBeGreaterThan(20);
    expect(free, 'edges short enough to bow by 0.14 × length').toBeGreaterThan(200);
  });

  test('§4.3 reciprocal links bow to opposite sides', async ({ page }) => {
    // The reason the offset exists. Some pairs are related in both directions
    // (A created it, it is used by A); swapping the ends flips the perpendicular,
    // so the two curves bracket the chord instead of lying on top of each other.
    // Which pairs those are, and how many of them have a chord to bow across,
    // comes out of the model below rather than being written down here.
    await openMap(page);
    const rows = await edgeRows(page);
    const byPair = new Map();
    RELATIONS.drawn.forEach((e, i) => {
      const k = [e.a, e.b].sort().join('::');
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(i);
    });
    const twins = [...byPair.values()].filter((v) => v.length === 2);
    expect(twins.length, 'pairs related in both directions').toBeGreaterThan(0);
    expect([...byPair.values()].filter((v) => v.length > 2),
      'a pair related more than twice would need a rule of its own').toEqual([]);
    // The chord each twin has to bow across, so the two cases below are counted
    // in advance instead of being accepted in whatever proportion turns up.
    const chordOf = (i) => {
      const A = MODEL.byId.get(RELATIONS.drawn[i].a), B = MODEL.byId.get(RELATIONS.drawn[i].b);
      return Math.hypot(B.X - A.X, B.Y - A.Y);
    };
    const wantSeparated = twins.filter(([i]) => chordOf(i) > 1).length;
    expect(wantSeparated, 'reciprocal pairs with a chord long enough to bow across')
      .toBeGreaterThan(0);
    let separated = 0, coincident = 0;
    for (const [i, j] of twins) {
      const gi = parseEdge(rows[i].d), gj = parseEdge(rows[j].d);
      expect([gi.ax, gi.ay], 'the twins run in opposite directions').toEqual([gj.bx, gj.by]);
      const A = MODEL.byId.get(RELATIONS.drawn[i].a), B = MODEL.byId.get(RELATIONS.drawn[i].b);
      const mx = (A.X + B.X) / 2, my = (A.Y + B.Y) / 2;
      const dx = B.X - A.X, dy = B.Y - A.Y, len = Math.hypot(dx, dy) || 1;
      const off = Math.min(34, len * 0.14);
      // The signed perpendicular offset of each control point, measured in the
      // same frame (A → B). One bows one way, the other the other.
      const side = (g) => ((g.cx - mx) * -dy + (g.cy - my) * dx) / len;
      if (Math.hypot(dx, dy) > 1) {
        expect(side(gi), 'one twin bows out').toBeGreaterThan(off * 0.5);
        expect(side(gj), 'the other bows back').toBeLessThan(-off * 0.5);
        expect(Math.abs(side(gi) + side(gj)), 'by the same amount').toBeLessThan(0.15);
        separated++;
      } else {
        // SPEC-DEVIATION (boundary, invisible): some of these pairs join
        // entities whose markers coincide — a team and the commons it publishes,
        // alone in their own jitter groups at the same address (§4.2's jitter is
        // per layer group). With a zero-length chord, 0.14 × length is zero,
        // so the reciprocal pair does not in fact separate. There is nothing to
        // see either way: the curve is a point under an overlapping marker.
        expect(rows[i].d, 'coincident ends collapse both curves onto the same point').toBe(rows[j].d);
        coincident++;
      }
    }
    expect(separated).toBe(wantSeparated);
    expect(coincident).toBe(twins.length - wantSeparated);
  });

  test('§4.3 no edge is drawn until a card is open or the links toggle is on', async ({ page }) => {
    await openMap(page);
    const rows = await edgeRows(page);
    expect(rows.filter((r) => r.on)).toHaveLength(0);
    expect(new Set(rows.map((r) => r.display))).toEqual(new Set(['none']));
    expect(await page.evaluate(() => hotEdges.length)).toBe(0);
    expect((await snapshot(page)).links).toBe(false);
  });

  test('§4.3 opening a card lights exactly that entity\'s edges', async ({ page }) => {
    await openMap(page);
    // The widest fan in the corpus: the most edges there are to get wrong, and
    // the most that must stay dark.
    const { id, n } = fanFixture('widest');
    const mine = new Set(fanIdx(id));
    expect(mine.size, `${id}'s fan`).toBe(n);
    expect(RELATIONS.drawn.length - mine.size, 'and edges that must stay dark').toBeGreaterThan(0);
    await focusEntity(page, id);
    const rows = await edgeRows(page);
    const lit = new Set(rows.map((r, i) => (r.on ? i : -1)).filter((i) => i >= 0));
    expect([...lit].sort((a, b) => a - b)).toEqual([...mine].sort((a, b) => a - b));
    expect(await page.evaluate(() => [...hotEdges].sort((a, b) => a - b)))
      .toEqual([...mine].sort((a, b) => a - b));
    for (const i of lit) expect(rows[i].display, `edge ${i}`).toBe('block');
  });

  test('§4.3 an edge needs both ends visible: hiding teams puts out a project\'s consortium fan', async ({ page }) => {
    // "only pushes a drawable edge when both ends have coordinates" is the
    // build-time half; refresh()'s `both` test is the live half. Invariant 6
    // keeps the focused project on the map, but its partners leave with their
    // layer and the curves go with them.
    await openMap(page);
    // The fixture has to reach teams *and* something else, or hiding the team
    // layer would prove nothing; MIXED_FAN is the widest fan in the payload
    // that does both.
    expect(MIXED_FAN, 'no fan in this payload reaches a team and a non-team').not.toBe(null);
    const { id, n } = MIXED_FAN;
    await focusEntity(page, id);
    expect(await page.evaluate(() => hotEdges.length)).toBe(n);
    await toggleLayer(page, 'team');
    await settleCounts(page);
    const survives = fanOf(id).filter((e) =>
      MODEL.byId.get(e.a).kind !== 'team' && MODEL.byId.get(e.b).kind !== 'team');
    // The fan is neither wholly out nor wholly in — which is what makes this a
    // test of `both` rather than of "a layer toggle hides everything".
    expect(survives.length).toBeGreaterThan(0);
    expect(survives.length).toBeLessThan(n);
    expect(await page.evaluate(() => hotEdges.length)).toBe(survives.length);
    expect(await page.evaluate((wanted) => state.inFilter.has(wanted) || state.keptOpen > 0, id)).toBe(true);
    const rows = await edgeRows(page);
    expect(rows.filter((r) => r.on)).toHaveLength(survives.length);
  });

  test('§4.3 the links toggle draws the whole mesh at a trace, fainter still behind an open card', async ({ page }) => {
    await openMap(page);
    await page.click('#links-row');
    await settleCounts(page);
    let rows = await edgeRows(page);
    // The whole mesh is one line per organisation: a card that shares its
    // organisation's line keeps its own path dark while the head is on screen.
    expect(rows.filter((r) => r.on)).toHaveLength(shownWith().size);
    expect(shownWith().size).toBeLessThan(RELATIONS.drawn.length);
    expect(new Set(rows.filter((r) => r.on).map((r) => r.op))).toEqual(new Set([0.28]));
    expect(new Set(rows.filter((r) => r.on).map((r) => r.w))).toEqual(new Set([0.8]));

    const { id, n } = fanFixture('widest');
    await focusEntity(page, id);
    rows = await edgeRows(page);
    const hotIdx = new Set(await page.evaluate(() => hotEdges));
    expect(hotIdx.size, `${id}'s fan`).toBe(n);
    const cold = rows.filter((r, i) => r.on && !hotIdx.has(i));
    expect(cold.length).toBe(shownWith(id).size - n);
    expect(cold.length, 'there must be a mesh left over to dim').toBeGreaterThan(0);
    expect(new Set(cold.map((r) => r.op)), 'the mesh gets out of the fan\'s way').toEqual(new Set([0.08]));
    expect(Math.min(...rows.filter((r, i) => hotIdx.has(i)).map((r) => r.op)))
      .toBeGreaterThan(0.08);
  });

  test('§4.3 edges keep their weight at any zoom', async ({ page }) => {
    // Counter-scaling markers (§4.4) would fatten every curve with the world
    // transform; non-scaling-stroke is what keeps a 0.8-unit trace a 0.8-pixel
    // trace at thirty times the scale.
    await openMap(page);
    // Read before the toggle as well as after it, and on every curve rather
    // than the first: the rule applies to `.edge`, and narrowing it to the lit
    // ones — `.edge.on` — would pass a check made with the mesh already on.
    const vectors = () => page.evaluate(() =>
      [...new Set([...document.querySelectorAll('#g-edges path.edge')]
        .map((p) => getComputedStyle(p).vectorEffect))]);
    expect(await vectors(), 'before the links toggle').toEqual(['non-scaling-stroke']);
    await page.click('#links-row');
    await settleCounts(page);
    expect(await vectors(), 'with the whole mesh drawn').toEqual(['non-scaling-stroke']);
    // And the weight itself is not quietly recomputed per zoom level, which
    // would be the other way to fake a constant trace.
    const widths = () => page.evaluate(() => [...document.querySelectorAll('#g-edges path.edge')]
      .map((p) => p.getAttribute('stroke-width')).join('|'));
    const before = await widths();
    await setZ(page, 9);
    expect(await widths(), 'nine times the scale, the same 0.8-unit trace').toBe(before);
  });
});

// ============================================ §4.3 one line per organisation

test.describe('§4.3 one line per organisation', () => {
  // The fixture is derived: the first group in the payload where two cards of
  // one organisation are linked to the same source, each with a path.
  const FX = (() => {
    for (const G of RELATIONS.groups.values()) {
      if (G.lines.length < 2) continue;
      const head = RELATIONS.drawn[G.lines[0]], alt = RELATIONS.drawn[G.lines[1]];
      return { source: head.a, head: head.b, headIdx: G.lines[0], card: alt.b, cardIdx: G.lines[1] };
    }
    return null;
  })();

  test('§4.3 a source shows one line per organisation, to the card the data names', async ({ page }) => {
    expect(FX, 'no organisation has two cards linked to one source').not.toBe(null);
    await openMap(page);
    await focusEntity(page, FX.source);
    const hot = await page.evaluate(() => [...hotEdges]);
    expect(hot).toContain(FX.headIdx);
    expect(hot).not.toContain(FX.cardIdx);
    // Both cards stay neighbours, so the source's card lists them both.
    expect(await page.evaluate(([s, c]) => nOf(s).has(c), [FX.source, FX.card])).toBe(true);
  });

  test('§4.3 a card that shares its organisation\'s line lights its own path when focused', async ({ page }) => {
    await openMap(page);
    await focusEntity(page, FX.card);
    const hot = (await page.evaluate(() => [...hotEdges])).sort((a, b) => a - b);
    expect(hot).toEqual(fanIdx(FX.card));
    expect(hot).toContain(FX.cardIdx);
    expect(hot).not.toContain(FX.headIdx);
  });

  test('§4.3 pointing at the sharing card in the source\'s card lights the organisation\'s line', async ({ page }) => {
    await openMap(page);
    await focusEntity(page, FX.source);
    const host = await cardHost(page);
    await page.hover(`${host} .rel-row[data-open="${FX.card}"]`);
    await expect.poll(() => page.evaluate(() => peekId)).toBe(FX.card);
    const rows = await edgeRows(page);
    expect(rows[FX.headIdx].op).toBe(0.95);
  });

  test('§4.3 with the head off screen, the organisation keeps its line through the other card', async ({ page }) => {
    // My map with only the sharing card pinned: its source comes along as a
    // neighbour and the head does not, so the organisation's line has to be
    // the sharing card's own ("only your pins and their links", tour.4b).
    await openMap(page);
    await page.evaluate((c) => {
      state.pins = new Set([c]); state.myMap = true; state.links = true; refresh();
    }, FX.card);
    const rows = await edgeRows(page);
    expect(rows[FX.cardIdx].on).toBe(true);
    expect(rows[FX.headIdx].on).toBe(false);
  });
});

// ================================================== §4.3 the attenuated fan

test.describe('§4.3 the selection fan', () => {
  // Fixtures across the attenuation range, each one whatever entity sits at
  // that landmark in today's payload (see FAN_LANDMARKS): the spec pins 0.85
  // "at four neighbours or fewer" and 0.40 "at sixteen or more", so the
  // boundaries are the interesting part and are selected for by fan width
  // rather than named. A landmark this corpus does not reach leaves no test
  // behind rather than a test of something else.
  const FANS = ['sole', 'plateauHigh', 'ramp', 'plateauLow', 'widest']
    .filter((key) => FAN_LANDMARKS[key].at)
    .map((key) => fanFixture(key));

  for (const { id, n, why } of FANS) {
    test(`§4.3 a fan of ${n} is attenuated by its width and by each line's length (${id}, ${why})`, async ({ page }) => {
      await openMap(page);
      await focusEntity(page, id);
      const rows = await edgeRows(page);
      const hotIdx = await page.evaluate(() => hotEdges);
      expect(hotIdx).toHaveLength(n);
      const base = fanBase(n);
      for (const i of hotIdx) {
        const g = parseEdge(rows[i].d);
        // Length taken from the drawn path, not from the page's bookkeeping.
        const len = Math.hypot(g.bx - g.ax, g.by - g.ay);
        const far = Math.min(1, len / 600);
        expect(rows[i].op, `edge ${i} opacity`).toBeCloseTo(base.op * (1 - 0.4 * far), 2);
        expect(rows[i].w, `edge ${i} width`).toBeCloseTo(base.w, 5);
      }
      // The longest line in the fan is the faintest, the shortest the strongest.
      const sorted = hotIdx
        .map((i) => ({ len: (() => { const g = parseEdge(rows[i].d); return Math.hypot(g.bx - g.ax, g.by - g.ay); })(), op: rows[i].op }))
        .sort((a, b) => a.len - b.len);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].op, 'a longer line is never the stronger one').toBeLessThanOrEqual(sorted[i - 1].op);
      }
      if (sorted.length > 1 && sorted[0].len < sorted[sorted.length - 1].len) {
        expect(sorted[sorted.length - 1].op).toBeLessThan(sorted[0].op);
      }
    });
  }

  test('§4.3 the wider the fan the lighter and thinner each line', async ({ page }) => {
    // The claim as the spec phrases it, across fixtures rather than within one:
    // 0.85 at four or fewer, 0.40 at sixteen or more, monotone in between. The
    // ladder is the ramp's landmarks from its narrow end up, so it climbs by
    // construction whatever the payload holds.
    await openMap(page);
    const seen = new Set();
    const ladder = ['plateauHigh', 'ramp', 'plateauLow', 'widest']
      .filter((key) => FAN_LANDMARKS[key].at)
      .map((key) => fanFixture(key))
      .filter((f) => !seen.has(f.id) && seen.add(f.id));
    expect(ladder.length, 'the ramp needs two landmarks before it can be compared')
      .toBeGreaterThan(1);
    const fans = [];
    for (const { id, n } of ladder) {
      await focusEntity(page, id);
      const rows = await edgeRows(page);
      const hotIdx = await page.evaluate(() => hotEdges);
      expect(hotIdx).toHaveLength(n);
      // Divide the length attenuation back out to recover the fan's own base
      // opacity — the maxima are not comparable across fans, since which lengths
      // a fan happens to contain is an accident of geography.
      const bases = hotIdx.map((i) => {
        const g = parseEdge(rows[i].d);
        const far = Math.min(1, Math.hypot(g.bx - g.ax, g.by - g.ay) / 600);
        return rows[i].op / (1 - 0.4 * far);
      });
      expect(Math.max(...bases) - Math.min(...bases), `${id}: one base for the whole fan`).toBeLessThan(0.004);
      fans.push({ id, n, base: bases[0], w: rows[hotIdx[0]].w });
    }
    // Each fan is drawn at the width and the base opacity §4.3's formula gives
    // for its own size — the figures, not merely the ordering.
    fans.forEach((f) => {
      expect(f.w, `${f.id}'s ${f.n} lines`).toBeCloseTo(fanBase(f.n).w, 5);
      expect(f.base, `${f.id} base opacity`).toBeCloseTo(fanBase(f.n).op, 2);
    });
    // The spec's own two anchors and its two plateaus.
    expect(fanBase(4).op).toBeCloseTo(0.85, 10);
    expect(fanBase(16).op).toBeCloseTo(0.40, 10);
    expect(fanBase(1).op).toBe(fanBase(4).op);       // "four neighbours or fewer"
    expect(fanBase(17).op).toBe(fanBase(16).op);     // "sixteen or more"
    // And across the fixtures, never the wrong way round: a wider fan is
    // thinner, and lighter wherever the formula itself moves.
    for (let i = 1; i < fans.length; i++) {
      const prev = fans[i - 1], cur = fans[i];
      expect(cur.n, 'the ladder climbs').toBeGreaterThanOrEqual(prev.n);
      expect(cur.w, `${cur.id} is no thicker than ${prev.id}`).toBeLessThanOrEqual(prev.w);
      if (fanBase(cur.n).op < fanBase(prev.n).op) {
        expect(cur.base, `${cur.id} is lighter than ${prev.id}`).toBeLessThan(prev.base);
      } else {
        expect(cur.base, `${cur.id} and ${prev.id} sit on one plateau`).toBeCloseTo(prev.base, 2);
      }
    }
    // …and end to end that is the whole range the spec describes, whenever the
    // corpus reaches both plateaus.
    const lo = fans[0], hi = fans[fans.length - 1];
    if (lo.n <= 4 && hi.n >= 16) {
      expect(lo.base - hi.base, 'the full 0.85 → 0.40 range').toBeCloseTo(0.45, 2);
    }
  });

  test('§4.3 hovering a partner\'s row in the card isolates that one relationship', async ({ page }) => {
    // "One relationship can always be isolated" — and the card is where the
    // names are read, so the row has to do it, not only the marker.
    await openMap(page);
    // The widest fan there is: the one where isolating a single line matters
    // most, and where leaving the rest alone would be least visible.
    const { id, n } = fanFixture('widest');
    await focusEntity(page, id);
    const before = await edgeRows(page);
    const hotIdx = await page.evaluate(() => hotEdges);
    expect(hotIdx.length).toBe(n);
    expect(n, 'a fan of one has nothing to isolate from').toBeGreaterThan(1);

    const host = await cardHost(page);
    const partner = await page.evaluate((sel) => {
      const b = document.querySelector(sel + ' .rel-row[data-open]');
      return b ? b.dataset.open : null;
    }, host);
    expect(partner, 'the card lists its partners').not.toBe(null);
    // The partner's own line, or its organisation's line when it shares one.
    const mine = new Set(fanIdx(id).filter((i) => onLine(RELATIONS.drawn[i], partner)));
    expect(mine.size).toBeGreaterThan(0);

    await page.hover(`${host} .rel-row[data-open="${partner}"]`);
    await expect.poll(() => page.evaluate(() => peekId)).toBe(partner);
    const after = await edgeRows(page);
    for (const i of hotIdx) {
      if (mine.has(i)) {
        expect(after[i].op, `the isolated line ${i}`).toBe(0.95);
        expect(after[i].w, `the isolated line ${i} thickens`).toBeCloseTo(fanBase(n).w + 0.9, 5);
      } else {
        // Both readings are attributes the page wrote with toFixed(3), so the
        // product carries a rounding error of its own; 0.001 is tight enough to
        // pin the factor to within a couple of per cent.
        expect(Math.abs(after[i].op - before[i].op * 0.15), `the rest of the fan drops to a trace`)
          .toBeLessThan(0.001);
      }
    }
    // The same gesture haloes the partner's marker: peek() drives both.
    expect(await page.evaluate((p) => mkEls[p].classList.contains('peek'), partner)).toBe(true);
    await expect.poll(() => page.evaluate((p) =>
      getComputedStyle(mkEls[p].querySelector('.halo')).opacity, partner)).toBe('0.55');

    // Leaving the row restores the whole fan.
    await page.hover('#search');
    await expect.poll(() => page.evaluate(() => peekId)).toBe(null);
    const restored = await edgeRows(page);
    for (const i of hotIdx) expect(restored[i].op, `edge ${i} restored`).toBeCloseTo(before[i].op, 5);
    expect(await page.evaluate((p) => mkEls[p].classList.contains('peek'), partner)).toBe(false);
  });

  test('§4.3 hovering a partner\'s marker does the same thing as hovering its row', async ({ page }) => {
    // "peek() drives both the marker halo and the edge emphasis, so hovering
    // anywhere that names an entity does the same thing."
    await openMap(page);
    const fx = fanFixture('widest');
    const id = fx.id;
    await focusEntity(page, id);
    const hotIdx = await page.evaluate(() => hotEdges);
    const n = hotIdx.length;
    expect(n, `${id}'s fan`).toBe(fx.n);
    expect(n, 'a fan of one has nothing to isolate from').toBeGreaterThan(1);
    const before = await edgeRows(page);
    // Markers overlap, so the partner to point at is the first one the pointer
    // can actually reach.
    const at = await pickHoverable(page, fanOf(id).map((e) => (e.a === id ? e.b : e.a)));
    const mine = new Set(fanIdx(id).filter((i) => onLine(RELATIONS.drawn[i], at.id)));
    expect(mine.size).toBeGreaterThan(0);

    await hoverMarker(page, at);
    await expect.poll(() => page.evaluate(() => peekId)).toBe(at.id);
    const after = await edgeRows(page);
    for (const i of hotIdx) {
      if (mine.has(i)) {
        expect(after[i].op, `the isolated line ${i}`).toBe(0.95);
        expect(after[i].w, `the isolated line ${i} thickens`).toBeCloseTo(fanBase(n).w + 0.9, 5);
      } else {
        expect(Math.abs(after[i].op - before[i].op * 0.15), 'the rest of the fan drops to a trace')
          .toBeLessThan(0.001);
      }
    }
    expect(await page.evaluate((p) => mkEls[p].classList.contains('peek'), at.id)).toBe(true);

    // And moving off the marker puts it back.
    await page.mouse.move(4, 4);
    await expect.poll(() => page.evaluate(() => peekId)).toBe(null);
    const restored = await edgeRows(page);
    for (const i of hotIdx) expect(restored[i].op, `edge ${i} restored`).toBeCloseTo(before[i].op, 5);
  });

  test('§4.3 pointing at a marker with no card open changes nothing', async ({ page }) => {
    // peek() is about isolating one line *within* a fan; with no fan there is
    // nothing to isolate, and the map must not start flickering on mouse-over.
    await openMap(page);
    const at = await pickHoverable(page, MODEL.all.filter((m) => m.placed).map((m) => m.id));
    await hoverMarker(page, at);
    // The tooltip does appear — pointing at a marker still names it — but no
    // edge lights up and nothing is singled out.
    await expect(page.locator('#tooltip')).toBeVisible();
    expect(await page.evaluate(() => peekId)).toBe(null);
    expect((await edgeRows(page)).filter((r) => r.on)).toHaveLength(0);
  });
});

// ====================================================== §4.4 zoom thresholds

test.describe('§4.4 zoom thresholds', () => {
  test('§4.4 k₀ is the scale that fits the canvas, and the default view is k₀ × 1.22', async ({ page }) => {
    await openMap(page);
    await fitAll(page);
    const r = await page.evaluate(() => {
      const box = document.getElementById('stage').getBoundingClientRect();
      return { k: view.k, k0, w: box.width, h: box.height, W: GEO.W, H: GEO.H };
    });
    expect(r.k0).toBeCloseTo(Math.min(r.w / r.W, r.h / r.H), 10);
    expect(r.k / r.k0).toBeCloseTo(1.22, 10);
  });

  test('§4.4 capital labels appear at k₀ × 1.7 and not a hair before', async ({ page }) => {
    await openMap(page);
    expect((await zoomState(page)).caps).toBe('none');       // the 1.22 default is below
    await setZ(page, 1.69);
    expect((await zoomState(page)).caps).toBe('none');
    await setZ(page, 1.70);
    expect((await zoomState(page)).caps).not.toBe('none');
    await setZ(page, 1.60);
    expect((await zoomState(page)).caps).toBe('none');
  });

  test('§4.4 marker labels appear at k₀ × 4.2 and not a hair before', async ({ page }) => {
    await openMap(page);
    const lblDisplay = () => page.evaluate(() =>
      getComputedStyle(document.querySelector('#g-markers .mk .lbl')).display);
    expect((await zoomState(page)).showLbl).toBe(false);
    expect(await lblDisplay()).toBe('none');
    await setZ(page, 4.19);
    expect((await zoomState(page)).showLbl).toBe(false);
    expect(await lblDisplay()).toBe('none');
    await setZ(page, 4.20);
    expect((await zoomState(page)).showLbl).toBe(true);
    expect(await lblDisplay()).toBe('block');
    // Capitals, which came in at 1.7, are still there at 4.2.
    expect((await zoomState(page)).caps).not.toBe('none');
  });

  test('§4.4 zooming out stops at k₀ × 0.7', async ({ page }) => {
    await openMap(page);
    for (let i = 0; i < 6; i++) await page.click('#z-out');
    await settleCounts(page);
    const r = await zoomState(page);
    expect(r.k).toBe(r.k0 * 0.7);
    // One more click cannot go below the floor.
    await page.click('#z-out');
    await settleCounts(page);
    expect((await zoomState(page)).k).toBe(r.k0 * 0.7);
  });

  test('§4.4 zooming in stops at k₀ × 30', async ({ page }) => {
    await openMap(page);
    for (let i = 0; i < 14; i++) await page.click('#z-in');
    await settleCounts(page);
    const r = await zoomState(page);
    expect(r.k).toBe(r.k0 * 30);
    await page.click('#z-in');
    await settleCounts(page);
    expect((await zoomState(page)).k).toBe(r.k0 * 30);
    // At the ceiling both label layers are long since in.
    expect(r.showLbl).toBe(true);
  });

  test('§4.4 flying to a selection zooms to at least k₀ × 3.2, and never zooms back out', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });   // the flight, not its easing
    await openMap(page);
    await page.evaluate(() => openEntity('adra'));
    await settleCounts(page);
    let r = await zoomState(page);
    expect(r.k).toBe(r.k0 * 3.2);
    // The marker is brought to the centre of the stage.
    const centred = await page.evaluate(() => {
      const box = document.getElementById('stage').getBoundingClientRect();
      const it = byId['adra'];
      return { sx: view.x + it.X * view.k, sy: view.y + it.Y * view.k, cx: box.width / 2, cy: box.height / 2 };
    });
    expect(centred.sx).toBeCloseTo(centred.cx, 6);
    expect(centred.sy).toBeCloseTo(centred.cy, 6);

    // Already closer in: the flight must not pull the reader back out.
    await setZ(page, 8);
    await page.evaluate(() => openEntity('unikassel'));
    await settleCounts(page);
    r = await zoomState(page);
    expect(r.k).toBe(r.k0 * 8);
  });

  test('§4.4 markers are counter-scaled by 1/k, so they keep a constant screen size', async ({ page }) => {
    await openMap(page);
    await fitAll(page);
    const pick = await page.evaluate(() => {
      // A marker near the middle of the stage, so it stays measurable at both scales.
      const box = document.getElementById('stage').getBoundingClientRect();
      let best = null;
      for (const id in mkEls) {
        const it = byId[id];
        const d = Math.hypot(view.x + it.X * view.k - box.width / 2, view.y + it.Y * view.k - box.height / 2);
        if (!best || d < best.d) best = { id, d };
      }
      const el = mkEls[best.id];
      const r = el.getBoundingClientRect();
      return { id: best.id, w: r.width, h: r.height, transform: el.getAttribute('transform'), k: view.k };
    });
    expect(pick.transform).toContain(`scale(${(1 / pick.k).toFixed(4)})`);
    await setZ(page, 3);
    const after = await page.evaluate((id) => {
      const el = mkEls[id], r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, transform: el.getAttribute('transform'), k: view.k };
    }, pick.id);
    expect(after.k / pick.k).toBeGreaterThan(2);           // really did zoom
    expect(after.transform).toContain(`scale(${(1 / after.k).toFixed(4)})`);
    expect(after.w).toBeCloseTo(pick.w, 1);
    expect(after.h).toBeCloseTo(pick.h, 1);
  });

  test('§4.4 the capital labels are counter-scaled too, so they do not grow with the zoom', async ({ page }) => {
    // §4.1 puts the twenty labels there to "give orientation without a label
    // layer", and they live inside #world: without their own 1/k they would
    // swell with every zoom step until three city names covered the continent.
    // applyView() re-lays them out in the same pass as the markers, and that is
    // the half the §4.1 test cannot see — it reads one transform at one scale,
    // and before this test existed deleting the capitals from that pass broke
    // nothing in the suite.
    await openMap(page);
    await setZ(page, 1.7);                              // the threshold where they appear
    const read = () => page.evaluate(() => {
      const el = document.querySelector('#g-caps .cap');
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, transform: el.getAttribute('transform'), k: view.k };
    });
    const near = await read();
    expect(near.w, 'a label has to be measurable for its size to be worth checking').toBeGreaterThan(10);
    expect(near.transform).toContain(`scale(${(1 / near.k).toFixed(4)})`);
    await setZ(page, 6);
    const far = await read();
    expect(far.k / near.k, 'really did zoom').toBeGreaterThan(3);
    expect(far.transform).toContain(`scale(${(1 / far.k).toFixed(4)})`);
    expect(far.w, 'the label must not be three times as wide at three times the zoom')
      .toBeCloseTo(near.w, 0);
    expect(far.h).toBeCloseTo(near.h, 0);
  });

  test('§4.4 the counter-scale pass is skipped when k moved less than 0.1 %', async ({ page }) => {
    // "which keeps panning free of layout work" — the guard is what makes a
    // drag cheap, and it is only correct because a sub-0.1 % scale change is
    // invisible at marker size. A regression here shows up as either jitter on
    // pan or stale marker sizes after a zoom.
    await openMap(page);
    await fitAll(page);
    const read = () => page.evaluate(() => ({
      marker: mkEls[Object.keys(mkEls)[0]].getAttribute('transform'),
      world: document.getElementById('world').getAttribute('transform'),
    }));
    const before = await read();
    await page.evaluate(() => setView({ k: view.k * 1.0005, x: view.x, y: view.y }, false));
    const tiny = await read();
    expect(tiny.marker, `a 0.05 % change must not re-lay-out ${PLACED.length} markers`).toBe(before.marker);
    expect(tiny.world, 'but the world transform follows immediately').not.toBe(before.world);
    // Just over the threshold: 0.2 % must already re-scale them, or the guard
    // has been loosened into visibly stale markers.
    await page.evaluate(() => setView({ k: view.k * 1.002, x: view.x, y: view.y }, false));
    const just = await read();
    expect(just.marker, 'a 0.2 % change is over the threshold').not.toBe(before.marker);
    await page.evaluate(() => setView({ k: view.k * 1.02, x: view.x, y: view.y }, false));
    const big = await read();
    expect(big.marker, 'a 2 % change must re-scale them').not.toBe(just.marker);
    await settleCounts(page);
  });

  test('§4.4 the thresholds are relative, so a phone and a wide monitor behave alike', async ({ page }) => {
    // "k₀ is the scale that fits the whole canvas, so thresholds are relative
    // to the viewport." Two very different stages, same reading.
    await openMap(page);
    const k0s = [];
    for (const size of [{ width: 420, height: 700 }, { width: 1600, height: 1000 }]) {
      await page.setViewportSize(size);
      await expect.poll(() => page.evaluate(() => Math.abs(view.k / k0 - 1.22) < 1e-9)).toBe(true);
      await settleCounts(page);
      const fit = await zoomState(page);
      expect(fit.caps, `capitals hidden at the fit view (${size.width}px)`).toBe('none');
      expect(fit.showLbl).toBe(false);
      await setZ(page, 1.7);
      expect((await zoomState(page)).caps, `capitals shown at 1.7 k₀ (${size.width}px)`).not.toBe('none');
      await setZ(page, 4.2);
      expect((await zoomState(page)).showLbl, `labels shown at 4.2 k₀ (${size.width}px)`).toBe(true);
      k0s.push(fit.k0);
    }
    // k₀ itself differs between the two stages, and by a lot — which is what
    // makes the three identical readings above a test of *relative* thresholds
    // rather than of absolute ones that happen to agree. (`toBeGreaterThan(0)`
    // stood here, which is true of any scale the page could possibly compute.)
    expect(k0s[1] / k0s[0], `k₀ went from ${k0s[0]} to ${k0s[1]}: the stages must differ`)
      .toBeGreaterThan(1.5);
  });

  test('§4.4 every marker stays where it was projected, whatever the zoom', async ({ page }) => {
    // Zoom must move the world transform, never the geometry: a marker whose
    // projected coordinates drifted with the scale would be a different place.
    await openMap(page);
    await setLayers(page, KINDS);
    const before = await page.evaluate(() => {
      const out = {};
      for (const id in mkEls) out[id] = [byId[id].X, byId[id].Y];
      return out;
    });
    await setZ(page, 12);
    await setZ(page, 0.8);
    const after = await page.evaluate(() => {
      const out = {};
      for (const id in mkEls) out[id] = [byId[id].X, byId[id].Y];
      return out;
    });
    expect(after).toEqual(before);
  });
});

// =========================================== §4.4 the gestures on the stage

// The pointer layer had no test at all: nothing in the suite fired a wheel
// event, dragged the map, pinched it or double-clicked it. Everything above
// reaches the view through setView(), fitView() and #z-in / #z-out — and those
// three all pass the stage centre, which is already stage-relative and already
// the fixed point of the zoom. So the conversion every pointer handler shares,
// `clientX - rect.left`, was exercised by nothing, and the width of §5's 312 px
// sidebar is the size of the error it hides. The same gap hid the pan path, the
// `moved <= 4` tap guard that keeps a pan from opening a card, the pointercancel
// wiring, and the two-finger branch.
test.describe('§4.4 the gestures on the stage', () => {
  test('§4.4 the wheel zooms in on a scroll up and out on a scroll down', async ({ page }) => {
    // The tour promises it in so many words: "Scroll to zoom, drag to pan"
    // (tour.2b). §4.4 tabulates the ladder but names no wheel factor, so the
    // base below is transcribed from the handler rather than derived; what is
    // derived, and what a reader would actually notice, is the shape of the
    // rule — the sign of the exponent, and that equal and opposite scrolls
    // compose back to where they started.
    await openMap(page);
    const at = await pickForGesture(page);
    await page.mouse.move(at.x, at.y);
    const start = (await viewOf(page)).k;
    await page.mouse.wheel(0, -240);
    await waitForK(page, start);
    await settleCounts(page);
    const zoomedIn = (await viewOf(page)).k;
    expect(zoomedIn, 'scrolling up zooms in').toBeGreaterThan(start);
    expect(zoomedIn / start).toBeCloseTo(Math.pow(1.0016, 240), 9);
    await page.mouse.wheel(0, 240);
    await waitForK(page, zoomedIn);
    await settleCounts(page);
    const back = (await viewOf(page)).k;
    expect(back, 'scrolling down zooms out').toBeLessThan(zoomedIn);
    expect(back, 'the factor is exponential in the delta, so the two cancel').toBeCloseTo(start, 9);
  });

  test('§4.4 the wheel zooms about the pointer, not the stage centre', async ({ page }) => {
    // The claim that nothing else in the page can test: `zoomAt()` wants a
    // point on the stage and the wheel event carries a point in the viewport,
    // so the handler subtracts the rectangle's own origin. Its only other
    // callers hand it `w/2, h/2` out of stageSize(), which is stage-relative
    // already — drop the conversion and every wheel zoom drifts by the sidebar.
    await openMap(page);
    const at = await pickForGesture(page);
    const box = await mapBox(page);
    // A real pointer lands on a whole pixel — the browser rounds the coordinate
    // on its way in — so the cursor goes to the pixel nearest the marker's
    // centre and the arithmetic below is done on that pixel, not on the
    // marker's own fractional position.
    const cursor = { x: Math.round(at.x), y: Math.round(at.y) };
    const before = await viewOf(page);
    const was = await centreOf(page, at.id);
    const px = cursor.x - box.left, py = cursor.y - box.top;
    // Measured away from the centre on purpose: at the centre an anchor that is
    // 312 px out and an anchor that is right would barely differ.
    expect(Math.abs(px - box.w / 2), 'the fixture must be off the stage centre').toBeGreaterThan(60);
    const [wx, wy] = worldUnder(before, px, py);
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.wheel(0, -240);
    await waitForK(page, before.k);
    await settleCounts(page);
    const after = await viewOf(page);
    expect(after.k).toBeGreaterThan(before.k);
    const [sx, sy] = screenOf(after, wx, wy);
    expect(sx, 'the point under the cursor is the fixed point of the zoom').toBeCloseTo(px, 3);
    expect(sy).toBeCloseTo(py, 3);
    // The reader's own version of the same sentence: the marker they were
    // pointing at has not slid out from under the pointer. Its centre may drift
    // by the fraction of a pixel between it and the cursor, never by the 312 px
    // a missing `- rect.left` would cost.
    const now = await centreOf(page, at.id);
    expect(Math.abs(now.x - was.x), `${at.id} must stay under the cursor`).toBeLessThan(1);
    expect(Math.abs(now.y - was.y)).toBeLessThan(1);
  });

  test('§4.4 the wheel zoom cancels the scroll it was handed', async ({ page }) => {
    // The map ships inside an iframe on the site (see playwright.config.js) and
    // its own document cannot scroll — `body{overflow:hidden}` — so the thing a
    // missing preventDefault() would move is the host article, which this
    // harness has no way to put around the page. What it can see is whether the
    // event was cancelled, which is the same claim one step earlier, and it
    // catches the other half too: a listener registered without
    // `{passive:false}` has its preventDefault() ignored, so the event would
    // come back uncancelled with the call still sitting in the source.
    await openMap(page);
    const r = await page.evaluate(() => {
      const before = view.k;
      const e = new WheelEvent('wheel', { deltaY: -240, cancelable: true, bubbles: true, clientX: 500, clientY: 300 });
      const notCancelled = document.getElementById('map').dispatchEvent(e);
      return { notCancelled, defaultPrevented: e.defaultPrevented, zoomed: view.k !== before };
    });
    // `zoomed` keeps it honest: a handler that never ran would also never scroll.
    expect(r).toEqual({ notCancelled: false, defaultPrevented: true, zoomed: true });
  });

  test('§4.4 a double-click on empty map zooms 1.7× about the point clicked', async ({ page }) => {
    await openMap(page);
    const sea = await pickEmptySea(page);
    const box = await mapBox(page);
    const before = await viewOf(page);
    const px = sea.x - box.left, py = sea.y - box.top;
    expect(Math.abs(px - box.w / 2), 'the fixture must be off the stage centre').toBeGreaterThan(60);
    const [wx, wy] = worldUnder(before, px, py);
    await page.mouse.dblclick(sea.x, sea.y);
    await waitForK(page, before.k);
    await settleCounts(page);
    const after = await viewOf(page);
    expect(after.k, 'one step of the ladder per double-click').toBeCloseTo(before.k * 1.7, 9);
    const [sx, sy] = screenOf(after, wx, wy);
    expect(sx, 'the point clicked is the fixed point').toBeCloseTo(px, 3);
    expect(sy).toBeCloseTo(py, 3);
    // Two taps on open water with no card open are two no-ops (§7).
    expect(after.focus).toBe(null);
  });

  test('§4.4 a double-click on a marker zooms too: the pointer capture carries the event past the .mk guard', async ({ page }) => {
    // SPEC-DEVIATION. The dblclick handler opens with `if
    // (e.target.closest('.mk')) return;` — an exemption so that double-clicking
    // a marker opens its card without also yanking the view. The guard is
    // written correctly and can never fire: the pointerdown handler calls
    // `svg.setPointerCapture(e.pointerId)`, and pointer capture retargets every
    // later event of that pointer — pointerup, click and dblclick among them —
    // to the capturing element. By the time the dblclick is dispatched its
    // target is `#map` itself, never a marker. (The pointerup handler is
    // written around this: it ignores `e.target` and asks
    // document.elementFromPoint() instead.)
    //
    // What a reader gets today is both: the card opens, and the map zooms 1.7×
    // about the click as if on open water. From the default fit view the
    // zoomAt() also cancels the flight still in progress, so the selection
    // settles near k₀ × 2.074 and never reaches §7's "minimum of k₀ × 3.2" —
    // and the entity it flew for is left off-centre. The arithmetic below is
    // pinned on a view where that race cannot decide the answer: the entity is
    // already open and already parked exactly where flyTo() would leave it, so
    // the flight the double-click triggers is a no-op and the only thing left
    // moving is the zoom under test.
    await openMap(page);
    const parked = await page.evaluate(() => {
      const st = document.getElementById('stage').getBoundingClientRect();
      const [w, h] = stageSize();
      for (const id in mkEls) {
        const it = byId[id], k = k0 * 3.2;
        setView({ k, x: w / 2 - it.X * k, y: h / 2 - it.Y * k }, false);   // flyTo()'s own target
        openEntity(id, { fly: false });
        const cx = st.left + w / 2, cy = st.top + h / 2;
        const hit = document.elementFromPoint(cx, cy);
        const mk = hit && hit.closest ? hit.closest('.mk') : null;
        if (mk && mk.dataset.id === id) return { id, cx, cy, x: view.x, y: view.y, k: view.k };
      }
      return null;
    });
    expect(parked, 'no marker is the topmost thing at the centre of its own flight').not.toBe(null);
    await settleCounts(page);
    await page.mouse.dblclick(parked.cx, parked.cy);
    await waitForK(page, parked.k);
    await settleCounts(page);
    const after = await viewOf(page);
    expect(after.focus, 'the card does open').toBe(parked.id);
    expect(after.k, 'and the marker is zoomed exactly as open water would be').toBeCloseTo(parked.k * 1.7, 9);
    expect(after.k / after.k0, '§4.4 has no k₀ × 5.44 rung').toBeCloseTo(3.2 * 1.7, 9);
    // The clicked point is still the fixed point, so the marker stays centred —
    // the reader is left looking at the right place at the wrong scale.
    const centred = await page.evaluate((id) => {
      const [w, h] = stageSize(); const it = byId[id];
      return { sx: view.x + it.X * view.k, sy: view.y + it.Y * view.k, cx: w / 2, cy: h / 2 };
    }, parked.id);
    expect(centred.sx).toBeCloseTo(centred.cx, 3);
    expect(centred.sy).toBeCloseTo(centred.cy, 3);

    // The other half of the deviation: the guard itself is sound. Dispatch a
    // dblclick whose target really is inside the marker — the one thing the
    // pointer capture prevents a real gesture from producing — and the view is
    // left alone. So this is a wiring fault, not a missing branch.
    const guard = await page.evaluate((id) => {
      const el = mkEls[id], r = el.getBoundingClientRect();
      const was = { x: view.x, y: view.y, k: view.k };
      el.querySelector('circle').dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return { was, now: { x: view.x, y: view.y, k: view.k } };
    }, parked.id);
    expect(guard.now, 'the exemption works when the event target is the marker').toEqual(guard.was);
  });

  test('§4.4 dragging pans the map by the pointer\'s own delta', async ({ page }) => {
    // "the counter-scale pass is skipped when k moved less than 0.1 %, which
    // keeps panning free of layout work" — the test above pins the guard; this
    // one pins the pan it was written for. Drag is how a reader moves the map:
    // break it and the map is immovable except through fitView() and the two
    // zoom buttons. Every panning test in the suite calls setView() directly,
    // which exercises the consequences of a changed view and never the handler
    // that produces one.
    await openMap(page);
    const at = await pickForGesture(page, { r: 180, t: 140 });
    const before = await viewOf(page);
    expect(await page.evaluate(() => document.getElementById('map').classList.contains('dragging'))).toBe(false);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 60, at.y - 40);
    const mid = await page.evaluate(() => ({
      x: view.x, y: view.y, k: view.k,
      dragging: document.getElementById('map').classList.contains('dragging'),
    }));
    await page.mouse.move(at.x + 120, at.y - 80);
    await page.mouse.up();
    await settleCounts(page);
    const after = await page.evaluate(() => ({
      x: view.x, y: view.y, k: view.k, ptrs: ptrs.size, dragStart,
      dragging: document.getElementById('map').classList.contains('dragging'),
      focus: state.focusId,
    }));
    expect(mid.dragging, 'the grabbing cursor is on for the whole gesture').toBe(true);
    // Each move is measured from where the finger went down, not from the last
    // move: 60 then 120, not 60 then 180.
    expect(mid.x - before.x).toBeCloseTo(60, 6);
    expect(mid.y - before.y).toBeCloseTo(-40, 6);
    expect(after.x - before.x, 'the pan follows the pointer, one canvas unit per pixel').toBeCloseTo(120, 6);
    expect(after.y - before.y).toBeCloseTo(-80, 6);
    expect(after.k, 'a drag is not a zoom').toBe(before.k);
    // And the gesture is put away: a drag that leaves dragStart set keeps
    // panning on every later move with no button held.
    expect(after.dragging).toBe(false);
    expect(after.ptrs).toBe(0);
    expect(after.dragStart).toBe(null);
  });

  test('§7 a drag that ends on a marker does not open it, and a 4 px wobble still does', async ({ page }) => {
    // The subtler half of the pan path. Grabbing a marker drags the map, and
    // the map carries the marker along, so the marker is still under the
    // pointer when the drag is released — which is the case `moved <= 4` exists
    // for. Without it every pan that happens to start on a marker opens that
    // marker's card and flies the view away, and panning across a cluster
    // becomes unusable.
    await openMap(page);
    const at = await pickForGesture(page, { r: 190, t: 150 });
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 60, at.y - 40);
    await page.mouse.move(at.x + 120, at.y - 80);
    const release = { x: at.x + 120, y: at.y - 80 };
    const under = (x, y) => page.evaluate(([px, py]) => {
      const hit = document.elementFromPoint(px, py);
      const mk = hit && hit.closest ? hit.closest('.mk') : null;
      return mk ? mk.dataset.id : null;
    }, [x, y]);
    expect(await under(release.x, release.y),
      'the marker travelled with the map, so the release really is on it').toBe(at.id);
    await page.mouse.up();
    await settleCounts(page);
    expect((await viewOf(page)).focus, 'a pan is not a selection').toBe(null);

    // The boundary, exactly where the handler puts it: |dx| + |dy| of 6 is a
    // drag, 4 is a tap. Both end over the marker, for the same reason — and
    // each is checked before the release, because a tap opens the card and
    // flies the map, which takes the marker away from the release point.
    await page.mouse.down();
    await page.mouse.move(release.x + 3, release.y + 3);
    expect(await under(release.x + 3, release.y + 3)).toBe(at.id);
    await page.mouse.up();
    await settleCounts(page);
    expect((await viewOf(page)).focus, 'six pixels of travel is still a drag').toBe(null);

    await page.mouse.down();
    await page.mouse.move(release.x + 5, release.y + 5);
    expect(await under(release.x + 5, release.y + 5)).toBe(at.id);
    await page.mouse.up();
    await settleCounts(page);
    expect((await viewOf(page)).focus, 'four pixels is a tap, and a tap selects').toBe(at.id);
  });

  test('§7 a cancelled pointer ends the drag instead of leaving it live', async ({ page }) => {
    // endPtr() is the only thing that clears dragStart and takes the grabbing
    // cursor off when the browser revokes a pointer mid-gesture — a touch
    // interrupted by a system gesture, a context menu, the capture being lost.
    // If that wiring broke, dragStart would stay set and every later
    // pointermove would keep panning with nothing held down: the map follows
    // the cursor for ever, with a grabbing cursor to advertise it. The guard
    // exists for a state the happy path cannot reach, which is why it has to be
    // dispatched rather than performed.
    await openMap(page);
    const r = await page.evaluate(() => {
      const svg = document.getElementById('map');
      const st = svg.getBoundingClientRect();
      const x0 = st.left + st.width / 2, y0 = st.top + st.height / 2;
      const ev = (type, cx, cy, buttons) => svg.dispatchEvent(new PointerEvent(type, {
        pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
        clientX: cx, clientY: cy, button: 0, buttons,
      }));
      const before = { x: view.x, y: view.y };
      ev('pointerdown', x0, y0, 1);
      const down = {
        ptrs: ptrs.size, held: !!dragStart,
        dragging: svg.classList.contains('dragging'),
      };
      ev('pointermove', x0 + 50, y0 + 30, 1);
      const panned = { x: view.x, y: view.y };
      ev('pointercancel', x0 + 50, y0 + 30, 0);
      const cancelled = {
        ptrs: ptrs.size, dragStart, dragging: svg.classList.contains('dragging'),
        x: view.x, y: view.y,
      };
      // The move that a live dragStart would have acted on.
      ev('pointermove', x0 + 250, y0 + 200, 0);
      return { before, down, panned, cancelled, ghost: { x: view.x, y: view.y } };
    });
    expect(r.down, 'the drag really did start').toEqual({ ptrs: 1, held: true, dragging: true });
    expect(r.panned.x - r.before.x, 'and really did pan').toBeCloseTo(50, 6);
    expect(r.panned.y - r.before.y).toBeCloseTo(30, 6);
    expect(r.cancelled).toMatchObject({ ptrs: 0, dragStart: null, dragging: false });
    // The cancel itself moves nothing, and the map stops following the pointer.
    expect(r.cancelled.x).toBeCloseTo(r.panned.x, 6);
    expect(r.cancelled.y).toBeCloseTo(r.panned.y, 6);
    expect(r.ghost.x, 'a move after the cancel must not pan').toBeCloseTo(r.panned.x, 6);
    expect(r.ghost.y).toBeCloseTo(r.panned.y, 6);
    await settleCounts(page);
  });

  test('§4.4 a two-finger pinch zooms about the fingers\' midpoint, and is never read as a tap', async ({ page }) => {
    // §5 makes the phone a documented target, and on a phone pinch is the zoom.
    // The `.ctl-br` buttons do survive below 840 px, so a broken pinch degrades
    // rather than dead-ends; `moved = 10` is the part that would bite. It is
    // the only thing stopping the finger that lifts last from being read as a
    // tap, and a pinch whose fingers happen to lift near a marker would then
    // open a card the reader never asked for, mid-zoom.
    //
    // Only one finger travels. Each pointermove re-reads the pair's midpoint,
    // so a gesture where both fingers move has a different anchor at every
    // step; with one finger still there is exactly one zoomAt(), its factor is
    // the ratio of the two spans and its anchor is the midpoint at that moment
    // — all three checkable to the last digit. The still finger is parked at
    // M + 50 precisely so that doubling about M − 50 brings the marker to it:
    // the last lift lands on a marker, which is what makes the tap guard the
    // subject of the test rather than a footnote.
    //
    // The third thing on that line, `pinchD || d`, has no test and cannot have
    // one: pinchD is set whenever ptrs reaches two, and a third finger leaves
    // ptrs at three so the branch is skipped entirely, so there is no sequence
    // of events that reaches the division with pinchD still zero. It is a
    // guard against a state the handlers cannot produce.
    await openMap(page);
    const at = await pickForGesture(page, { l: 220, r: 90 });
    const r = await page.evaluate(([id, mx, my]) => {
      const svg = document.getElementById('map');
      const st = svg.getBoundingClientRect();
      const ev = (type, pointerId, cx, cy, buttons) => svg.dispatchEvent(new PointerEvent(type, {
        pointerId, pointerType: 'touch', isPrimary: pointerId === 1, bubbles: true, cancelable: true,
        clientX: cx, clientY: cy, button: 0, buttons,
      }));
      const before = { x: view.x, y: view.y, k: view.k };
      ev('pointerdown', 1, mx - 50, my, 1);
      ev('pointerdown', 2, mx + 50, my, 1);
      const down = { ptrs: ptrs.size, pinchD, moved };
      ev('pointermove', 1, mx - 150, my, 1);
      const after = { x: view.x, y: view.y, k: view.k, moved, pinchD };
      ev('pointerup', 1, mx - 150, my, 0);
      const half = { ptrs: ptrs.size, focus: state.focusId };
      const hit = document.elementFromPoint(mx + 50, my);
      const mk = hit && hit.closest ? hit.closest('.mk') : null;
      ev('pointerup', 2, mx + 50, my, 0);
      const box = mkEls[id].getBoundingClientRect();
      return {
        left: st.left, top: st.top, before, down, after, half,
        underLift: mk ? mk.dataset.id : null,
        marker: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        end: {
          ptrs: ptrs.size, dragStart, focus: state.focusId,
          dragging: svg.classList.contains('dragging'),
        },
      };
    }, [at.id, at.x, at.y]);
    expect(r.down, 'two fingers 100 px apart, and nothing moved yet').toEqual({ ptrs: 2, pinchD: 100, moved: 0 });
    expect(r.after.pinchD, 'the span is carried forward for the next move').toBe(200);
    expect(r.after.k / r.before.k, 'a span from 100 px to 200 px is a zoom of two').toBeCloseTo(2, 9);
    // The anchor is the midpoint of the pair as it stood for that move, in
    // stage coordinates — the same `- rect.left` the wheel does.
    const px = at.x - 50 - r.left, py = at.y - r.top;
    const [wx, wy] = worldUnder(r.before, px, py);
    const [sx, sy] = screenOf(r.after, wx, wy);
    expect(sx, 'the midpoint is the fixed point of the pinch').toBeCloseTo(px, 3);
    expect(sy).toBeCloseTo(py, 3);
    // Which puts the marker under the finger that never moved.
    expect(r.marker.x).toBeCloseTo(at.x + 50, 0);
    expect(r.marker.y).toBeCloseTo(at.y, 0);
    // And the tap guard: the last lift is on a marker and still opens nothing.
    expect(r.after.moved, 'a pinch counts as having moved, whatever the fingers did').toBe(10);
    expect(r.underLift, 'the last finger really does come up on a marker').toBe(at.id);
    expect(r.half.focus).toBe(null);
    expect(r.end.focus, 'and lifting on it opens no card').toBe(null);
    expect(r.end).toMatchObject({ ptrs: 0, dragStart: null, dragging: false });
    await settleCounts(page);
  });
});
