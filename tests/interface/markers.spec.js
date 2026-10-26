// Markers, edges and zoom — the map's visual language.
//
// Spec: docs/map-interface-spec.md §3.2 (layers), §4.1 (projection and
// basemap), §4.2 (markers), §4.3 (edges), §4.4 (zoom thresholds), and
// invariants 2 (shape means layer, colour means domain) and 3 (an entity
// without coordinates has no marker but keeps everything else).
//
// Two habits run through the file:
//
//  * Expectations are derived from the payload on disk, re-implementing the
//    rule the spec states, rather than read back out of the page. hai-data.js
//    is loaded here in Node, *before* the page's jitter pass mutates it in
//    place, so the tests can say what a marker's coordinates ought to be and
//    not merely that the page agrees with itself.
//  * Where a claim is visual, both halves are asserted: the internal state
//    (`edges`, `hotEdges`, `view.k`, `k0`) and the attribute a reader's eye
//    actually lands on (stroke-opacity, stroke-dasharray, display).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openMap, settleCounts, setLayers, toggleLayer, fitAll, snapshot } from './_map.js';

// ---------------------------------------------------------------- the payload

// Playwright compiles these specs to CommonJS, so __dirname is the honest way
// to reach the repository; import.meta is not available here.
const repoFile = (rel) => path.join(__dirname, '..', '..', rel);

/** hai-data.js as committed — the generated payload, unmutated. */
function loadPayload() {
  const w = {};
  new Function('window', fs.readFileSync(repoFile('assets/map/hai-data.js'), 'utf8'))(w);
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

const RAW = loadPayload();
const G = loadGeoConstants();
const KINDS = ['project', 'team', 'commons', 'framework'];

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
const SPEC_R = { project: 8.5, commons: 7.5, framework: 6, team: 4.5 };
const SPEC_DRAW_ORDER = ['team', 'commons', 'framework', 'project'];

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
    project: RAW.PROJECTS, team: RAW.TEAMS, commons: RAW.COMMONS, framework: RAW.FRAMEWORKS,
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
  // The jitter groups: projects and commons share one pass, teams and
  // frameworks have their own. Grouped on the coordinates rounded to 1/100°.
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
    pc: pass([...ids('project'), ...ids('commons')], 'pc'),
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
  const relate = (a, b, rel, colorFrom) => {
    if (!MODEL.byId.has(a) || !MODEL.byId.has(b)) return;
    pairs.add([a, b].sort().join('::'));
    if (MODEL.byId.get(a).placed && MODEL.byId.get(b).placed) {
      drawn.push({ a, b, rel, color: SPEC_COLORS[MODEL.byId.get(colorFrom).lead] || null });
    }
  };
  for (const e of RAW.EDGES) {
    if (!MODEL.byId.has(e.project)) continue;      // the page bails on an unknown project
    relate(e.project, e.team, 'consortium', e.project);
  }
  for (const asset of [...RAW.COMMONS, ...RAW.FRAMEWORKS]) {
    for (const uid of asset.createdBy || []) relate(uid, asset.id, 'createdBy', asset.id);
    for (const uid of asset.usedBy || []) relate(asset.id, uid, 'usedBy', asset.id);
  }
  for (const e of drawn) {
    const A = MODEL.byId.get(e.a), B = MODEL.byId.get(e.b);
    e.len = Math.hypot(B.X - A.X, B.Y - A.Y);
  }
  return { drawn, pairs };
})();

const fanOf = (id) => RELATIONS.drawn.filter((e) => e.a === id || e.b === id);

/** §4.3's two attenuations, written out from the spec's prose: 0.85 at four
 *  neighbours or fewer, 0.40 at sixteen or more, and lighter still with length. */
function fanBase(n) {
  const fan = Math.min(1, Math.max(0, (n - 4) / 12));
  return { op: 0.85 - 0.45 * fan, w: 1.8 - 0.6 * fan };
}

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
      dash: s.getAttribute('stroke-dasharray'),
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
});

// =============================================================== §4.2 jitter

test.describe('§4.2 the jitter pass', () => {
  test('§4.2 co-located entities are spread on a 0.18° circle, one seat each', async ({ page }) => {
    // "a city with eight labs shows eight markers rather than one".
    await openMap(page);
    const crowded = MODEL.all.filter((m) => m.placed && m.groupSize > 1);
    expect(crowded.length).toBeGreaterThan(80);
    expect(Math.max(...crowded.map((m) => m.groupSize))).toBeGreaterThanOrEqual(5);
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
    // data: Aalto's digital-twin team and the FCAI programme carry the very
    // same coordinates, each alone in its own group, so neither moves and the
    // two markers coincide. Asserted so that widening the jitter to one global
    // pass — which would separate them — cannot happen unnoticed.
    await openMap(page);
    const pair = ['aalto-dt', 'fcai'];
    for (const id of pair) expect(MODEL.byId.get(id).groupSize, id).toBe(1);
    const got = await page.evaluate((ids) => ids.map((id) => ({
      lat: byId[id].d.lat, lon: byId[id].d.lon, X: byId[id].X, Y: byId[id].Y, kind: byId[id].kind,
    })), pair);
    expect(got[0].kind).toBe('team');
    expect(got[1].kind).toBe('project');
    expect(got[0].lat).toBe(MODEL.byId.get('aalto-dt').rawLat);
    expect(got[1].lat).toBe(MODEL.byId.get('fcai').rawLat);
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
          tag: o.tagName, r: o.getAttribute('r'), w: o.getAttribute('width'),
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
    expect(new Set(KINDS.map(key)).size, 'each layer needs its own silhouette').toBe(4);

    // And the silhouettes are the ones §4.2 tabulates.
    const parsed = Object.fromEntries(KINDS.map((k) => [k, JSON.parse(key(k))]));
    expect(parsed.project).toMatchObject({ tag: 'circle', r: String(SPEC_R.project), dash: null });
    expect(parsed.commons).toMatchObject({ tag: 'circle', r: String(SPEC_R.commons), dash: '3 2.4' });
    expect(parsed.team).toMatchObject({ tag: 'circle', r: String(SPEC_R.team), dash: null });
    // A framework is a rounded square: side = 2r, corner radius 2.5.
    expect(parsed.framework).toMatchObject({ tag: 'rect', w: String(2 * SPEC_R.framework), rx: '2.5' });
    // Teams carry the thinner stroke the table asks for; the rest a heavier one.
    expect(Number(parsed.team.sw)).toBeLessThan(Number(parsed.project.sw));
    expect(parsed.project.sw).toBe(parsed.commons.sw);
    // The halo clears the marker by the same margin whatever the layer.
    for (const kind of KINDS) {
      const r = kind === 'framework' ? SPEC_R.framework : Number(parsed[kind].r);
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
    // Shape is not smuggling domain in: energy is drawn in all four layers.
    expect(seen.energy.kinds.sort()).toEqual([...KINDS].sort());
  });

  test('inv.2 two entities of the same layer and domains draw the identical marker', async ({ page }) => {
    // The sharpest reading of "neither channel encodes anything else": if layer
    // and domain set are all that a marker shows, then two entities agreeing on
    // both must produce byte-identical markup. Status, tier, funding, date
    // confidence, pin count — none of them may reach the glyph. Seventy groups
    // in the corpus have more than one member, and half of those disagree on
    // status or tier, so a leak would be caught here rather than by eye.
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
    expect(shared.length, 'layer + domain groups with more than one member').toBeGreaterThan(50);
    for (const [key, v] of shared) {
      expect(v.markup, `${key} (${v.ids.slice(0, 3).join(', ')}…) must draw one marker`).toHaveLength(1);
    }
    // Not vacuous: within those groups, entities really do differ in ways the
    // marker must ignore.
    const varying = shared.filter(([, v]) =>
      new Set(v.ids.map((id) => {
        const m = MODEL.byId.get(id);
        return m.d.status + '/' + m.d.tier;
      })).size > 1);
    expect(varying.length, 'groups whose members disagree on status or tier').toBeGreaterThan(20);
  });

  test('§4.2 a multi-domain circle is equal pie slices, one per domain, in the entity\'s own order', async ({ page }) => {
    // "deliberately not a primary domain plus badges": n domains, n slices of
    // 2π/n, starting at twelve o'clock, coloured in the entity's domain order —
    // which is its lead domain first, not the palette's order.
    await openMap(page);
    for (const id of ['tailor', 'ai4realnet', 'tecnatom-simulators', 'aicrowd']) {
      const mk = await markerParts(page, id);
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
    // The wedge order is the entity's own domain list. TAILOR leads on `multi`,
    // which sits fourteenth in the palette, so a palette-ordered pie would put
    // hf or xai first.
    const tailor = await markerParts(page, 'tailor');
    expect(tailor.domains).toEqual(['multi', 'xai', 'hf']);
    expect(tailor.shapes.slice(0, 3).map((s) => s.fill))
      .toEqual([SPEC_COLORS.multi, SPEC_COLORS.xai, SPEC_COLORS.hf]);
  });

  test('§4.2 a seven-domain marker gets seven equal slices, not a cap of five', async ({ page }) => {
    // The widest split in the corpus. A pie that silently truncated its domain
    // list would still look plausible, so count the wedges and the turn they
    // close: seven arcs of 2π/7 come back to the start.
    await openMap(page);
    const mk = await markerParts(page, 'tecnatom-simulators');
    expect(mk.domains).toHaveLength(7);
    expect(mk.shapes.filter((s) => s.tag === 'path')).toHaveLength(7);
    const slices = mk.shapes.slice(0, 7).map((s) => parseSlice(s.d));
    // Each slice starts where the previous one ended, and the seventh closes
    // the circle back onto the first — a truncated domain list would leave a gap.
    for (let i = 1; i < 7; i++) {
      expect(slices[i].lx, `slice ${i} starts where ${i - 1} ended`).toBeCloseTo(slices[i - 1].ex, 1);
      expect(slices[i].ly, `slice ${i} starts where ${i - 1} ended`).toBeCloseTo(slices[i - 1].ey, 1);
    }
    expect(slices[6].ex).toBeCloseTo(slices[0].lx, 1);
    expect(slices[6].ey).toBeCloseTo(slices[0].ly, 1);
    expect(new Set(mk.shapes.slice(0, 7).map((s) => s.fill)).size).toBe(7);
  });

  test('§4.2 a multi-domain framework is equal vertical bands under one rounded outline', async ({ page }) => {
    await openMap(page);
    const mk = await markerParts(page, 'aletheia-framework');
    const n = mk.domains.length;
    expect(n).toBe(4);
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

  test('§4.2 a single-domain marker is one solid shape, not a one-slice pie', async ({ page }) => {
    await openMap(page);
    const project1 = await markerParts(page, 'adra');
    expect(project1.domains).toEqual(['multi']);
    expect(project1.bodyTag).toBe('circle');
    expect(project1.shapes).toHaveLength(1);
    expect(project1.shapes[0]).toMatchObject({
      tag: 'circle', r: String(SPEC_R.project), fill: SPEC_COLORS.multi, dash: null,
    });
    const team1 = await markerParts(page, 'unikassel');
    expect(team1.shapes[0]).toMatchObject({ tag: 'circle', r: String(SPEC_R.team), fill: SPEC_COLORS.energy });
    const commons1 = await markerParts(page, 'ellis-society');
    expect(commons1.shapes[0]).toMatchObject({
      tag: 'circle', r: String(SPEC_R.commons), fill: SPEC_COLORS.xai, dash: '3 2.4',
    });
  });

  test('§4.2 the draw order is team → commons → framework → project', async ({ page }) => {
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
    // All four layers really are present, so the check above is not vacuous.
    expect(new Set(order)).toEqual(new Set(KINDS));
    expect(rank[0]).toBe(0);
    expect(rank[rank.length - 1]).toBe(3);
  });

  test('§4.2 the halo is invisible until the marker is hovered or focused', async ({ page }) => {
    await openMap(page);
    // The halo fades over 150 ms, so every reading is polled rather than
    // snatched mid-transition.
    const opacity = (id) => page.evaluate((wanted) =>
      getComputedStyle(mkEls[wanted].querySelector('.halo')).opacity, id);
    expect(await opacity('adra')).toBe('0');

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
    await focusEntity(page, 'adra');
    await expect.poll(() => opacity('adra')).toBe('1');
  });

  test('§4.2 marker names are truncated at 34 characters, and teams carry none', async ({ page }) => {
    // 268 team names at marker size would be a second basemap, so teams get no
    // label element at all — not one that is merely hidden. The 34-character
    // boundary is exact: 34 renders whole, 35 becomes 32 characters plus an
    // ellipsis.
    await openMap(page);
    expect((await markerParts(page, 'unikassel')).label).toBe(null);
    expect((await markerParts(page, 'db-netz')).label).toBe(null);
    const short = MODEL.byId.get('generative-theories');
    expect(short.d.name).toHaveLength(34);
    expect((await markerParts(page, 'generative-theories')).label).toBe(short.d.name);
    const long = MODEL.byId.get('adra');
    expect(long.d.name.length).toBeGreaterThan(34);
    const drawn = (await markerParts(page, 'adra')).label;
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
    // circle is still an 11-unit tap.
    const team = await markerParts(page, 'unikassel');
    expect(Number(team.hit.r)).toBe(11);
    expect(team.hit.fill).toBe('transparent');
  });
});

// =============================================================== §3.2 layers

test.describe('§3.2 layers', () => {
  test('§3.2 there are exactly four layers, and infrastructure is not one of them', async ({ page }) => {
    // "Infrastructure has no layer of its own, by design." Its entries arrive
    // as teams: 23 merge into a team already on the map, the other 18 are
    // rendered as team markers of their own.
    await openMap(page);
    expect(await page.evaluate(() => KINDS)).toEqual(KINDS);
    await expect(page.locator('#layer-rows .layer-row[data-layer]')).toHaveCount(4);
    const kindsSeen = await page.evaluate(() => [...new Set(items.map((it) => it.kind))].sort());
    expect(kindsSeen).toEqual([...KINDS].sort());

    const withInfra = MODEL.all.filter((m) => m.d.infra);
    expect(withInfra).toHaveLength(41);
    expect(withInfra.every((m) => m.kind === 'team')).toBe(true);
    expect(withInfra.filter((m) => m.d.type === 'infrastructure')).toHaveLength(18);
    expect(withInfra.filter((m) => m.d.type !== 'infrastructure')).toHaveLength(23);
    // …and the page renders all 41 as team markers, none as a fifth shape.
    const shapes = await page.evaluate((ids) => ids.map((id) => byId[id].kind), withInfra.map((m) => m.id));
    expect(new Set(shapes)).toEqual(new Set(['team']));
    expect(await page.evaluate(() => Object.keys(TOTALS).length)).toBe(4);
  });

  test('§3.2 the layer counts and totals come from the four source collections', async ({ page }) => {
    await openMap(page);
    expect(await page.evaluate(() => ({ ...TOTALS }))).toEqual({
      project: RAW.PROJECTS.length, team: RAW.TEAMS.length,
      commons: RAW.COMMONS.length, framework: RAW.FRAMEWORKS.length,
    });
  });

  test('§3.2 an infrastructure domain code only ever reaches a marker through an infrastructure entry', async ({ page }) => {
    // §3.1's second load-bearing rule, read off the markers: the compute /
    // cluster / simulation colours are infrastructure categories. Forty-six
    // entities work on digital twins; not one of them is coloured `simulation`
    // unless it actually runs a facility, which is what would happen if
    // `digital_twins` were mapped to `simulation` again.
    await openMap(page);
    const infraDoms = SPEC_GROUPS.infra;
    const coded = MODEL.all.filter((m) => m.domains.some((d) => infraDoms.includes(d)));
    expect(coded).toHaveLength(41);
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
    const glyphs = await page.evaluate(() => {
      const out = {};
      for (const row of document.querySelectorAll('#layer-rows .layer-row[data-layer]')) {
        const svg = row.querySelector('.glyph svg');
        const shapes = [...svg.querySelectorAll('circle,rect,path')];
        const o = shapes[shapes.length - 1];
        out[row.dataset.layer] = {
          tags: shapes.map((s) => s.tagName),
          outline: o.tagName, rx: o.getAttribute('rx'), dash: o.getAttribute('stroke-dasharray'),
        };
      }
      return out;
    });
    expect(glyphs.project.outline).toBe('circle');
    expect(glyphs.project.dash).toBe(null);
    expect(glyphs.project.tags.filter((t) => t === 'path').length).toBe(3);  // shown as a pie
    expect(glyphs.team).toMatchObject({ outline: 'circle', dash: null });
    expect(glyphs.commons).toMatchObject({ outline: 'circle', dash: '3 2.4' });
    expect(glyphs.framework).toMatchObject({ outline: 'rect', rx: '2.5' });
  });
});

// ====================================================== invariant 3: off map

test.describe('invariant 3: an entity without coordinates', () => {
  test('inv.3 the entities without coordinates are kept, flagged, and given no marker', async ({ page }) => {
    await openMap(page);
    expect(UNPLACED.length).toBe(11);
    expect(await page.evaluate(() => NOGEO)).toBe(UNPLACED.length);
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
    // Derived from the payload: 299 consortium links from edges.yml plus the
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
    // Five pairs are related twice — created one way, used the other — so the
    // curve count runs ahead of the adjacency count rather than behind it.
    expect(r.edges - r.pairs).toBe(5);
  });

  test('§4.3 consortium links are solid, "used by" links are dashed', async ({ page }) => {
    await openMap(page);
    const rows = await edgeRows(page);
    const expectDash = RELATIONS.drawn.map((e) => (e.rel === 'usedBy' ? '4 4' : null));
    expect(rows.map((r) => r.dash)).toEqual(expectDash);
    const dashed = expectDash.filter(Boolean).length;
    expect(dashed).toBe(26);
    expect(expectDash.length - dashed).toBe(326);
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
      // …and it is exactly as far out as the formula says. The fourteen edges
      // whose two markers coincide are the exception: with no chord there is no
      // perpendicular, and the control point stays on the midpoint.
      const bow = Math.hypot(dx, dy) === 0 ? 0 : off;
      expect(Math.abs(Math.hypot(g.cx - mx, g.cy - my) - bow), `edge ${i} bow`).toBeLessThan(0.11);
    });
    // Both branches of the min() are exercised by the corpus.
    expect(clamped, 'edges long enough for the 34-unit cap to bite').toBeGreaterThan(20);
    expect(free, 'edges short enough to bow by 0.14 × length').toBeGreaterThan(200);
  });

  test('§4.3 reciprocal links bow to opposite sides', async ({ page }) => {
    // The reason the offset exists. Five pairs are related in both directions
    // (A created it, it is used by A); swapping the ends flips the perpendicular,
    // so the two curves bracket the chord instead of lying on top of each other.
    await openMap(page);
    const rows = await edgeRows(page);
    const byPair = new Map();
    RELATIONS.drawn.forEach((e, i) => {
      const k = [e.a, e.b].sort().join('::');
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(i);
    });
    const twins = [...byPair.values()].filter((v) => v.length === 2);
    expect(twins).toHaveLength(5);
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
        // SPEC-DEVIATION (boundary, invisible): two of the five pairs join
        // entities whose markers coincide — a team and the commons it publishes,
        // alone in their own jitter groups at the same address (§4.2's jitter is
        // per layer group). With a zero-length chord, 0.14 × length is zero,
        // so the reciprocal pair does not in fact separate. There is nothing to
        // see either way: the curve is a point under an overlapping marker.
        expect(rows[i].d, 'coincident ends collapse both curves onto the same point').toBe(rows[j].d);
        coincident++;
      }
    }
    expect(separated).toBe(3);
    expect(coincident).toBe(2);
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
    const id = 'twineu';
    const mine = new Set(RELATIONS.drawn.map((e, i) => [e, i]).filter(([e]) => e.a === id || e.b === id).map(([, i]) => i));
    expect(mine.size).toBe(16);
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
    const id = 'twineu';
    await focusEntity(page, id);
    expect(await page.evaluate(() => hotEdges.length)).toBe(16);
    await toggleLayer(page, 'team');
    await settleCounts(page);
    const survives = fanOf(id).filter((e) =>
      MODEL.byId.get(e.a).kind !== 'team' && MODEL.byId.get(e.b).kind !== 'team');
    // TwinEU reaches both teams and a commons, so the fan is neither wholly out
    // nor wholly in — which is what makes this a test of `both` rather than of
    // "a layer toggle hides everything".
    expect(survives.length).toBeGreaterThan(0);
    expect(survives.length).toBeLessThan(16);
    expect(await page.evaluate(() => hotEdges.length)).toBe(survives.length);
    expect(await page.evaluate(() => state.inFilter.has('twineu') || state.keptOpen > 0)).toBe(true);
    const rows = await edgeRows(page);
    expect(rows.filter((r) => r.on)).toHaveLength(survives.length);
  });

  test('§4.3 the links toggle draws the whole mesh at a trace, fainter still behind an open card', async ({ page }) => {
    await openMap(page);
    await page.click('#links-row');
    await settleCounts(page);
    let rows = await edgeRows(page);
    expect(rows.filter((r) => r.on)).toHaveLength(RELATIONS.drawn.length);
    expect(new Set(rows.filter((r) => r.on).map((r) => r.op))).toEqual(new Set([0.28]));
    expect(new Set(rows.filter((r) => r.on).map((r) => r.w))).toEqual(new Set([0.8]));

    await focusEntity(page, 'twineu');
    rows = await edgeRows(page);
    const hotIdx = new Set(await page.evaluate(() => hotEdges));
    expect(hotIdx.size).toBe(16);
    const cold = rows.filter((r, i) => r.on && !hotIdx.has(i));
    expect(cold.length).toBe(RELATIONS.drawn.length - 16);
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

// ================================================== §4.3 the attenuated fan

test.describe('§4.3 the selection fan', () => {
  // Four fixtures across the attenuation range, with the neighbour count each
  // one has in the payload: the spec pins 0.85 "at four neighbours or fewer"
  // and 0.40 "at sixteen or more", so the boundaries are the interesting part.
  const FANS = [
    { id: 'unikassel', n: 1 },
    { id: 'db-netz', n: 4 },
    { id: 'tailor', n: 15 },
    { id: 'twineu', n: 16 },
    { id: 'ai4realnet', n: 25 },
  ];

  for (const { id, n } of FANS) {
    test(`§4.3 a fan of ${n} is attenuated by its width and by each line's length (${id})`, async ({ page }) => {
      expect(fanOf(id), `${id} must still have ${n} links`).toHaveLength(n);
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
    // 0.85 at four or fewer, 0.40 at sixteen or more, monotone in between.
    await openMap(page);
    const fans = [];
    for (const { id, n } of [{ id: 'db-netz', n: 4 }, { id: 'tailor', n: 15 }, { id: 'twineu', n: 16 }, { id: 'ai4realnet', n: 25 }]) {
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
    expect(fans.map((f) => f.w)).toEqual([1.8, 1.25, 1.2, 1.2]);
    fans.forEach((f) => expect(f.base, `${f.id} base opacity`).toBeCloseTo(fanBase(f.n).op, 2));
    expect(fanBase(4).op).toBeCloseTo(0.85, 10);
    expect(fanBase(16).op).toBeCloseTo(0.40, 10);
    expect(fanBase(1).op).toBe(fanBase(4).op);       // "four neighbours or fewer"
    expect(fanBase(25).op).toBe(fanBase(16).op);     // "sixteen or more"
    expect(fans[0].base).toBeGreaterThan(fans[1].base);
    expect(fans[1].base).toBeGreaterThan(fans[2].base);
    expect(fans[3].base).toBeCloseTo(fans[2].base, 2);
    expect(fans[0].base - fans[3].base).toBeCloseTo(0.45, 2);
  });

  test('§4.3 hovering a partner\'s row in the card isolates that one relationship', async ({ page }) => {
    // "One relationship can always be isolated" — and the card is where the
    // names are read, so the row has to do it, not only the marker.
    await openMap(page);
    const id = 'ai4realnet';
    await focusEntity(page, id);
    const before = await edgeRows(page);
    const hotIdx = await page.evaluate(() => hotEdges);
    expect(hotIdx.length).toBe(25);

    const host = await cardHost(page);
    const partner = await page.evaluate((sel) => {
      const b = document.querySelector(sel + ' .rel-row[data-open]');
      return b ? b.dataset.open : null;
    }, host);
    expect(partner, 'the card lists its partners').not.toBe(null);
    const mine = new Set(RELATIONS.drawn
      .map((e, i) => [e, i])
      .filter(([e]) => (e.a === partner || e.b === partner) && (e.a === id || e.b === id))
      .map(([, i]) => i));
    expect(mine.size).toBeGreaterThan(0);

    await page.hover(`${host} .rel-row[data-open="${partner}"]`);
    await expect.poll(() => page.evaluate(() => peekId)).toBe(partner);
    const after = await edgeRows(page);
    for (const i of hotIdx) {
      if (mine.has(i)) {
        expect(after[i].op, `the isolated line ${i}`).toBe(0.95);
        expect(after[i].w, `the isolated line ${i} thickens`).toBeCloseTo(fanBase(25).w + 0.9, 5);
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
    const id = 'ai4realnet';
    await focusEntity(page, id);
    const hotIdx = await page.evaluate(() => hotEdges);
    const n = hotIdx.length;
    expect(n).toBe(25);
    const before = await edgeRows(page);
    // Markers overlap, so the partner to point at is the first one the pointer
    // can actually reach.
    const at = await pickHoverable(page, fanOf(id).map((e) => (e.a === id ? e.b : e.a)));
    const mine = new Set(RELATIONS.drawn
      .map((e, i) => [e, i])
      .filter(([e]) => (e.a === at.id || e.b === at.id) && (e.a === id || e.b === id))
      .map(([, i]) => i));
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
    expect(tiny.marker, 'a 0.05 % change must not re-lay-out 438 markers').toBe(before.marker);
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
