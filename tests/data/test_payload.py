"""The committed payload, checked against itself and against what the page assumes.

`assets/map/hai-data.js` is generated (§3), committed, and never hand-edited — which
means nothing at view time validates it. The interface trusts it completely: it keys
`byId` off `id` with no collision check, reads `it.d.name.length` to draw a marker
label, colours a marker by `COLORS[domains[0]]` with a grey fallback that looks like
a design decision rather than a hole, and resolves `createdBy` / `usedBy` / `EDGES`
against `byId` by dropping whatever does not resolve. Every one of those failure
modes is silent. So the checks that would otherwise live in a runtime validator live
here instead.

Spec sections under test: §3.2 (layers), §3.3 (entity fields), §3.4 (vocabulary),
§3.5 (freshness), plus the §3.1 guarantees about descriptions, coordinates and the
infrastructure domain codes, which are claims about the payload itself.

Expectations are derived from a different file than the one under test wherever
possible: the layer figures and the vocabulary group list are parsed out of the spec,
the colour table and the domain filter groups out of the map's inline script, and
`AS_OF` and `TAXO` are recomputed with the generator's own functions. A hand-edit to
`hai-data.js` therefore fails here rather than passing by agreeing with itself.

`hai-data.js` is no longer the whole payload, either. The page loads it and then an
overlay — `hai-data-additions.js` — which merges entries added upstream since the
last regeneration into `window.HAI_DATA` by id. So there are two payloads here:
`GENERATED`, the generated file on its own, which is what §3.2's figures and §3.5's
snapshot date document and the only thing the generator can be re-run against; and
`PAYLOAD`, what the interface actually reads. Every count below is derived from one
of those two rather than written down, because §3.2 says what any figure in this
file would be worth: "Counts are a snapshot and move with every upstream
regeneration; the shape of the table is what is normative, not the figures."
"""
from __future__ import annotations

import datetime
import json
import re
import unittest
from collections import Counter

from tests._harness import MAP_HTML, SPEC, load_generator, load_payload, map_script

# ---------------------------------------------------------------- fixtures

SCRIPT = map_script()
SPEC_TEXT = SPEC.read_text(encoding="utf-8")

# The five layers that carry entities. EDGES is a relation, not a layer of cards,
# and `reg()` in the map registers exactly these five.
ENTITY_LAYERS = ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS")
# Everything the payload keys by name — the cards and the relation between them.
PAYLOAD_LAYERS = ENTITY_LAYERS + ("EDGES",)
# layer name -> the `kind` the map tags it with (`reg(DATA.PROJECTS,'project')`, …)
LAYER_KIND = {"PROJECTS": "project", "CLUSTERS": "cluster", "COMMONS": "commons",
              "TEAMS": "team", "FRAMEWORKS": "framework"}
# The generated payload, as the page spells it in its own `<script src>`.
GENERATED_SRC = "hai-data.js"

# `assets/map/hai-data.js` exactly as the generator wrote it.
GENERATED = load_payload()


def page_data_scripts() -> list:
    """Every `<script src="….js">` the page loads, in load order.

    The page is the authority on what `window.HAI_DATA` ends up holding: §2 has
    the data files loaded with plain `<script src>` before the inline module, so
    everything listed here has run before the interface reads a single entity.
    """
    return re.findall(r'<script src="([^"]+\.js)"',
                      MAP_HTML.read_text(encoding="utf-8"))


def overlay_scripts() -> list:
    """The data scripts the page loads on top of the generated payload.

    Today there is one, `hai-data-additions.js`: entries added to the private
    source repository after the last regeneration, merged into `window.HAI_DATA`
    by id. It says of itself that it is temporary — once `hai-data.js` has been
    regenerated it merges nothing and can be deleted — so it is discovered from
    the page rather than named here, and this whole layer disappears on its own
    when it goes.
    """
    return [s for s in page_data_scripts()
            if s.startswith("hai-data") and s != GENERATED_SRC]


def _json_object_after(text: str, marker: str) -> str:
    """The `{…}` literal following `marker`, sliced by balancing braces so that a
    brace inside a description string cannot end the slice early. Same ground
    `load_payload()` stands on: these files are JavaScript, but every value in
    them is a JSON literal, so they read back exactly without a JS runtime."""
    i = text.index(marker) + len(marker)
    depth, j, in_str, esc = 0, i, False, False
    while j < len(text):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[i:j + 1]
        j += 1
    raise AssertionError(f"unbalanced braces after {marker!r}")


def overlay_additions() -> dict:
    """Everything the overlays merge in, layer -> entries, pooled across them.

    Each overlay carries its payload as a single `var ADD = {…}` object literal.
    A key this file does not know about would land in the result unmerged, which
    is why `PendingOverlay` pins the set of keys an overlay may carry.
    """
    out = {name: [] for name in PAYLOAD_LAYERS}
    for src in overlay_scripts():
        add = json.loads(_json_object_after(
            (MAP_HTML.parent / src).read_text(encoding="utf-8"), "var ADD = "))
        for layer, entries in add.items():
            out.setdefault(layer, []).extend(entries)
    return out


ADDED = overlay_additions()


def edge_pair(e: dict) -> tuple:
    """An edge as (source, team): the source is a project or a cluster."""
    return (e.get("project") or e.get("cluster"), e.get("team"))


def page_payload() -> dict:
    """`window.HAI_DATA` as the interface finds it: the generated payload with
    every overlay merged in, by the rule the overlays state and `PendingOverlay`
    below checks against their source — an entry whose id is not already present
    is appended, an edge whose project/team pair is not already present is
    appended, nothing already there is ever replaced, and `AS_OF` moves to the
    latest provenance touch of the result.

    Deriving the merge here rather than reading the merged corpus back out of the
    page is the point: the interface tests compare the rendered view against
    `window.HAI_DATA`, and this file is what says `window.HAI_DATA` is the two
    committed files and nothing else.
    """
    merged = dict(GENERATED)
    for layer in ENTITY_LAYERS:
        have = {o["id"] for o in GENERATED[layer]}
        merged[layer] = list(GENERATED[layer]) + [o for o in ADDED[layer]
                                                  if o["id"] not in have]
    pairs = {edge_pair(e) for e in GENERATED["EDGES"]}
    merged["EDGES"] = list(GENERATED["EDGES"]) + [
        e for e in ADDED["EDGES"] if edge_pair(e) not in pairs]
    dates = [GENERATED["AS_OF"]]
    for layer in ENTITY_LAYERS:
        for o in ADDED[layer]:
            prov = o.get("prov") or {}
            dates += [d for d in (prov.get("upd"), prov.get("on")) if d]
    merged["AS_OF"] = max(d for d in dates if d)
    return merged


# What every test below reads, unless it is specifically about the generated file
# or about the overlay.
PAYLOAD = page_payload()


def entities():
    """(layer, entity) for every card-bearing entity, in registration order."""
    return [(layer, o) for layer in ENTITY_LAYERS for o in PAYLOAD[layer]]


def all_entities():
    return [o for _, o in entities()]


def by_id():
    return {o["id"]: o for o in all_entities()}


def ids_of(layer):
    return {o["id"] for o in PAYLOAD[layer]}


# ------------------------------------------------- parsing the implementation

def colors_table() -> dict:
    """The map's COLORS object — domain code -> hex. Colour encodes the domain
    (§4.2), so a code missing from this table renders `#999` grey and quietly
    breaks that channel for every entity carrying it."""
    body = re.search(r"const COLORS = \{(.*?)\};", SCRIPT, re.S).group(1)
    return dict(re.findall(r"([A-Za-z]\w*)\s*:\s*'(#[0-9a-fA-F]{3,8})'", body))


def dom_groups() -> dict:
    """The three filter groups of §4.2 — group key -> domain codes. A domain code
    in no group has no checkbox, so nothing carrying only that code can ever be
    filtered into view."""
    body = re.search(r"const DOM_GROUPS = \[(.*?)\];", SCRIPT, re.S).group(1)
    out = {}
    for key, doms in re.findall(r"\{\s*key:'(\w+)',\s*doms:\[([^\]]*)\]", body):
        out[key] = re.findall(r"'([\w]+)'", doms)
    return out


def i18n_domain_tables(name: str) -> list:
    """Both language copies of a single-line I18N domain table (`badge:{…}` or
    `dom:{…}`), as dicts. Returned unlabelled: the claim under test is that every
    domain code is present in *both*, whichever is which."""
    out = []
    for body in re.findall(name + r":\{([^}]*)\}", SCRIPT):
        out.append(dict(re.findall(r"(\w+):'((?:[^'\\]|\\.)*)'", body)))
    return out


def registered_layers() -> dict:
    """`reg(DATA.<LAYER>,'<kind>')` as the map actually spells it."""
    return dict(re.findall(r"reg\(DATA\.(\w+),\s*'(\w+)'\)", SCRIPT))


# ------------------------------------------------------- parsing the spec

def spec_section(start: str, end: str) -> str:
    return SPEC_TEXT.split(start, 1)[1].split(end, 1)[0]


def spec_layer_rows() -> list:
    """The §3.2 table as a list of cell-lists, header and separator dropped."""
    sec = spec_section("### 3.2 Layers", "### 3.3 Entity fields")
    rows = [l.strip() for l in sec.splitlines() if l.strip().startswith("|")]
    cells = [[c.strip() for c in r.strip("|").split("|")] for r in rows]
    return cells[0], cells[2:]          # header, data rows (cells[1] is |---|)


def spec_domain_groups() -> list:
    """§4.2's three filter-group bullets — group label -> the domain names listed
    under it. The bullets name domains in prose ("AI networks", "multi-agent/
    other") where the script uses short codes, so what travels from here is the
    shape: three groups, in that order, with those sizes. Which codes are the
    infrastructure ones is §3.1.2's business, below."""
    # Anchored on the wording without its figure: the count in that sentence is
    # what `spec_domain_colour_count()` parses, and a slice that spelled it out
    # here would stop finding the section the moment the figure moved — turning
    # a disagreement about the count into a crash about the parse.
    sec = spec_section(" domain colours in three filter groups:", "Draw order")
    return [(m.group(1), [n.strip() for n in m.group(2).split(",")])
            for m in re.finditer(r"- \*\*(.+?)\*\* — (.+?)(?=\n- \*\*|\n\n)", sec, re.S)]


def spec_infra_domain_codes() -> set:
    """The codes §3.1.2 declares to be infrastructure categories, read out of the
    sentence that declares it, so this file never restates the list itself."""
    names = re.search(r"The ([\w\s/]+?) codes are infrastructure categories",
                      SPEC_TEXT, re.S).group(1)
    return {n.strip() for n in names.split("/")}


# The spec spells small figures out in words where it states them in prose.
NUMBER_WORDS = ("zero", "one", "two", "three", "four", "five", "six", "seven",
                "eight", "nine", "ten", "eleven", "twelve", "thirteen",
                "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
                "nineteen", "twenty")


def spec_domain_colour_count() -> int:
    """§4.2's own count of the domain colours, taken from the sentence that
    introduces the filter groups ("Seventeen domain colours in three filter
    groups"). Parsed rather than copied: the figure is a claim the spec makes
    about the payload, so it belongs in the spec and nowhere else."""
    word = re.search(r"(\w+) domain colours in \w+ filter groups", SPEC_TEXT).group(1)
    return NUMBER_WORDS.index(word.lower())


def spec_truncation_losses() -> tuple:
    """§3.1's count of what the predecessor's 300-character cap destroyed — the
    floor an untruncated payload has to clear, in English and in French."""
    m = re.search(r"cutting (\d+) English and (\d+) French descriptions mid-word",
                  SPEC_TEXT)
    return int(m.group(1)), int(m.group(2))


def spec_date_note_levels() -> tuple:
    """The confidence levels §10.2 says the dating pass wrote into the
    provenance note, read out of the pattern it quotes."""
    m = re.search(r"wrote as `timeline\.start \(([\w|]+)\): <evidence>`", SPEC_TEXT)
    return tuple(m.group(1).split("|"))


def spec_prose_figures(start: str, end: str) -> list:
    """Every integer stated in a stretch of spec prose, in order. The figures are
    a snapshot like §3.2's table, so where a test needs them it reads them from
    the sentence that documents them instead of restating them."""
    return [int(n) for n in re.findall(r"\b(\d+)\b", spec_section(start, end))]


ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Ids are used as object keys, as `data-id` / `data-open` attribute values, and in
# the shareable URL. Keep them to an unambiguous slug alphabet.
ID_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
# Europe with room to spare: Crete to the North Cape, the Azores-facing Atlantic to
# the eastern edge of the projection. Wide enough that no legitimate entity trips
# it, narrow enough that a swapped lat/lon pair or a stray 0,0 does.
LAT_RANGE = (34.0, 72.0)
LON_RANGE = (-25.0, 45.0)
# `byId` is a plain `{}`, so every Object.prototype key answers a lookup truthily.
# An entity or a cross-reference named one of these would be "resolvable" while
# resolving to a function, and `byId[x].d.name` would throw.
PROTO_KEYS = {
    "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__",
    "__lookupSetter__", "constructor", "hasOwnProperty", "isPrototypeOf",
    "propertyIsEnumerable", "toLocaleString", "toString", "valueOf",
}


class Identity(unittest.TestCase):
    """§3.3 — `id` is the primary key of the whole payload, across layers."""

    def test_3_3_every_id_is_unique_across_all_layers(self):
        # The map builds one flat `byId` from all four layers in sequence, so a
        # project and a team sharing an id do not conflict loudly: the second
        # registration overwrites the first and the first entity disappears from
        # every card link, every edge and every search result while still being
        # counted in TOTALS. Uniqueness has to hold globally, not per layer.
        ids = [o["id"] for o in all_entities()]
        dupes = sorted(i for i, n in Counter(ids).items() if n > 1)
        self.assertEqual(dupes, [])
        self.assertEqual(len(set(ids)), len(ids))

    def test_3_3_layer_sizes_sum_to_the_number_of_distinct_ids(self):
        # The same claim from the other side: TOTALS is built from layer lengths
        # while everything else is built from byId, and the two only agree while
        # no id is shared.
        total = sum(len(PAYLOAD[layer]) for layer in ENTITY_LAYERS)
        self.assertEqual(total, len({o["id"] for o in all_entities()}))

    def test_3_3_every_id_is_a_slug(self):
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertRegex(o["id"], ID_SLUG)

    def test_3_3_no_id_shadows_an_object_prototype_key(self):
        # `if (!byId[a]) return;` is the map's only existence check. An entity
        # called "constructor" would pass it everywhere and then explode on
        # `.d.name`; a *reference* to one would draw an edge to a function.
        offenders = sorted(o["id"] for o in all_entities() if o["id"] in PROTO_KEYS)
        self.assertEqual(offenders, [])

    def test_3_3_no_cross_reference_shadows_an_object_prototype_key(self):
        refs = set()
        for o in all_entities():
            refs.update(o.get("createdBy", []) or [])
            refs.update(o.get("usedBy", []) or [])
            refs.update(o.get("refs", []) or [])
            refs.update((o.get("infra") or {}).get("hosts", []) or [])
            for c in (o.get("consortium", []) or []) + (o.get("members", []) or []):
                if c.get("ref"):
                    refs.add(c["ref"])
        for e in PAYLOAD["EDGES"]:
            refs.update(edge_pair(e))
        self.assertEqual(sorted(refs & PROTO_KEYS), [])


class RequiredFields(unittest.TestCase):
    """§3.3 — the fields the interface reads without guarding first."""

    def test_3_3_every_entity_has_a_non_empty_trimmed_name(self):
        # Read unconditionally in at least three places: the marker label reads
        # `it.d.name.length`, the feed sorts on `a.d.name.localeCompare(...)`, and
        # search calls `norm(it.d.name)`. A missing name is a TypeError, not a
        # blank label.
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertIsInstance(o.get("name"), str)
                self.assertNotEqual(o["name"].strip(), "")
                self.assertEqual(o["name"], o["name"].strip())

    def test_3_3_every_entity_has_a_non_empty_domains_list(self):
        # `reg()` falls back to `[d.domain]` only when `domains` is absent or
        # empty; `matchesFilters` then tests `it.domains.some(...)`, so an entity
        # with neither can never match any domain filter and is invisible.
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertIsInstance(o.get("domains"), list)
                self.assertGreaterEqual(len(o["domains"]), 1)
                self.assertEqual(len(set(o["domains"])), len(o["domains"]))
                self.assertTrue(all(isinstance(x, str) and x for x in o["domains"]))

    def test_3_3_every_entity_has_a_lead_domain_and_a_description_and_a_url(self):
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertTrue(o.get("domain"))
                self.assertTrue(o.get("desc"))
                self.assertTrue(o.get("status"))
                self.assertRegex(o.get("url", ""), r"^https://|^http://")

    def test_3_3_every_entity_has_a_full_provenance_block(self):
        # provHtml() renders nothing at all unless `prov.by` is set, so a card
        # with no provenance simply looks unsourced. §3.3 lists all five keys.
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertEqual(sorted(o.get("prov", {})), ["by", "conf", "on", "src", "upd"])
                self.assertTrue(o["prov"]["by"])
                self.assertTrue(o["prov"]["src"])

    def test_3_3_every_entity_is_renderable_in_both_languages(self):
        # The card reads `d['desc_'+LANG] || d.desc`, so a missing translation
        # degrades to the source description rather than to the "no description"
        # placeholder — which is only true while `desc` is always populated.
        missing = sorted(o["id"] for o in all_entities()
                         if not (o.get("desc_en") and o.get("desc_fr")))
        # Four teams are still untranslated upstream; they fall back to `desc`.
        self.assertEqual(missing, ["epri-europe", "flatland-association",
                                   "polimi-airlab-rl", "uva-illc"])
        for o in all_entities():
            with self.subTest(id=o["id"]):
                self.assertTrue(o.get("desc_en") or o.get("desc"))
                self.assertTrue(o.get("desc_fr") or o.get("desc"))

    def test_3_3_timelines_carry_only_the_documented_keys_and_parseable_years(self):
        # `year()` in the map takes the leading four digits of start/end, and the
        # period filter is built entirely out of those two numbers.
        for layer, o in entities():
            tl = o.get("timeline")
            if tl is None:
                continue
            with self.subTest(layer=layer, id=o["id"]):
                self.assertLessEqual(set(tl), {"start", "end", "milestones"})
                for key in ("start", "end"):
                    if tl.get(key):
                        # Strings, not years: `str()` around the regex would have
                        # accepted an unstringified YAML `2019`, and the payload
                        # is read back as JSON, where 2019 and "2019" are two
                        # different values — `d.start.slice(0,4)` throws on one.
                        self.assertIsInstance(tl[key], str)
                        self.assertRegex(tl[key], r"^\d{4}(-\d{2}){0,2}$")
                for m in tl.get("milestones", []):
                    self.assertEqual(sorted(m), ["date", "label"])
                    self.assertTrue(m["label"].strip())
                    # The card prints a milestone date as it stands and the
                    # period axis takes its leading year, so it needs the same
                    # shape as start/end — which nothing checked before.
                    self.assertIsInstance(m["date"], str)
                    self.assertRegex(m["date"], r"^\d{4}(-\d{2}){0,2}$")

    def test_3_3_country_is_always_a_two_letter_code(self):
        # The "N countries" counter is a Set of raw `d.country` strings, so "FR"
        # and "France" would count as two countries.
        for layer, o in entities():
            if not o.get("country"):
                continue
            with self.subTest(layer=layer, id=o["id"]):
                self.assertRegex(o["country"], r"^[A-Z]{2}$")

    def test_3_3_city_and_country_travel_together(self):
        # Both are rendered as one `[city, country].filter(Boolean).join(', ')`
        # line; a city with no country reads as a bare place name with no anchor.
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertEqual(bool(o.get("city")), bool(o.get("country")))


class Geography(unittest.TestCase):
    """§3.1.4 / §3.3 — coordinates are both there or both absent, and plausible."""

    def test_3_3_lat_and_lon_are_either_both_present_or_both_absent(self):
        # `geo` is `d.lat!=null && d.lon!=null`. A half-placed entity would be
        # projected from `undefined` and land at NaN, i.e. nowhere, while still
        # counting as placed.
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertEqual("lat" in o, "lon" in o)

    def test_3_3_coordinates_are_finite_numbers_inside_Europe(self):
        for layer, o in entities():
            if "lat" not in o:
                continue
            with self.subTest(layer=layer, id=o["id"]):
                for key, (lo, hi) in (("lat", LAT_RANGE), ("lon", LON_RANGE)):
                    self.assertIsInstance(o[key], (int, float))
                    self.assertNotIsInstance(o[key], bool)
                    self.assertGreaterEqual(o[key], lo)
                    self.assertLessEqual(o[key], hi)

    def test_3_1_4_geo_is_present_only_when_false(self):
        # §3.3: "`geo` (only when false)". The map never reads it — it re-derives
        # geo from the coordinates — so a `geo:true` in the payload would be a
        # second, unread source of truth.
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                if "geo" in o:
                    self.assertIs(o["geo"], False)
                    self.assertNotIn("lat", o)
                else:
                    self.assertIn("lat", o)

    def test_3_1_4_entities_without_coordinates_are_kept_not_dropped(self):
        # The whole point of the flag: standards bodies have no address, and the
        # predecessor dropped them. They keep a card, a search entry and a row in
        # the off-the-map list.
        nogeo = [(layer, o) for layer, o in entities() if o.get("geo") is False]
        self.assertGreater(len(nogeo), 0)
        layers = Counter(layer for layer, _ in nogeo)
        # Only the two placeless layers: international standards (frameworks) and
        # one non-EU commons, as the map's own comment in `reg()` says. A project
        # or a team with no coordinates would be a data error, not a standard.
        self.assertEqual(sorted(layers), ["COMMONS", "FRAMEWORKS"])
        self.assertEqual(layers["COMMONS"], 1)
        for _, o in nogeo:
            with self.subTest(id=o["id"]):
                self.assertFalse(o.get("city"))
                self.assertFalse(o.get("country"))
                self.assertTrue(o.get("desc"))


class CrossReferences(unittest.TestCase):
    """§3.2 / §3.3 — every id the payload points at has to resolve."""

    def test_3_2_every_edge_resolves_to_a_project_or_a_cluster_and_a_team(self):
        # `DATA.EDGES.forEach` bails out silently on an unknown source
        # (`if (!p) return`) and `relate()` bails out on an unknown team, so a
        # broken reference costs a link with no error anywhere.
        sources = {"project": ids_of("PROJECTS"), "cluster": ids_of("CLUSTERS")}
        teams = ids_of("TEAMS")
        for e in PAYLOAD["EDGES"]:
            with self.subTest(edge=e):
                self.assertLessEqual(set(e), {"project", "cluster", "team", "org", "via"})
                kinds = [k for k in sources if k in e]
                self.assertEqual(len(kinds), 1, "one source, a project or a cluster")
                self.assertIn(e[kinds[0]], sources[kinds[0]])
                self.assertIn(e["team"], teams)
                if "org" in e:
                    self.assertIs(e["org"], True)

    def test_3_2_no_edge_is_duplicated_or_reflexive(self):
        # Consortium links are drawn one curve per entry; a duplicated pair draws
        # the same curve twice (visibly darker) and inflates the links count.
        pairs = [edge_pair(e) for e in PAYLOAD["EDGES"]]
        self.assertEqual(sorted(p for p, n in Counter(pairs).items() if n > 1), [])
        self.assertEqual([p for p in pairs if p[0] == p[1]], [])

    def test_3_2_an_organisation_level_link_names_its_organisation(self):
        # `level: organisation` upstream: the team card stands in for its
        # organisation, which takes part through a unit with no card. The card
        # says so by name, so the team has to carry the organisation it stands
        # in for — data/organisations.yml is what makes such a line valid.
        teams = {o["id"]: o for o in PAYLOAD["TEAMS"]}
        org_lines = [e for e in PAYLOAD["EDGES"] if e.get("org")]
        self.assertGreater(len(org_lines), 0)
        for e in org_lines:
            with self.subTest(edge=e):
                org = teams[e["team"]].get("organisation") or {}
                self.assertTrue(org.get("id") and org.get("name") and org.get("url"), org)

    def test_3_2_one_line_per_organisation_and_the_others_share_it(self):
        # The map draws one line per project (or cluster) and organisation. A
        # second card of the same organisation linked to the same source carries
        # `via`: the card whose line it shares, which belongs to the same
        # organisation, is linked to the same source and draws a line itself.
        teams = {o["id"]: o for o in PAYLOAD["TEAMS"]}
        org_of = lambda tid: (teams[tid].get("organisation") or {}).get("id") or tid
        drawn = {edge_pair(e) for e in PAYLOAD["EDGES"] if not e.get("via")}
        per_org = Counter((src, org_of(team)) for src, team in drawn)
        self.assertEqual(sorted(k for k, n in per_org.items() if n > 1), [])
        shared = [e for e in PAYLOAD["EDGES"] if e.get("via")]
        self.assertGreater(len(shared), 0)
        for e in shared:
            with self.subTest(edge=e):
                src, team = edge_pair(e)
                self.assertIn((src, e["via"]), drawn)
                self.assertEqual(org_of(e["via"]), org_of(team))
                self.assertNotEqual(e["via"], team)

    def test_3_2_the_shared_line_goes_to_the_participating_unit_then_to_the_named_card(self):
        # §4.3: of several cards of one organisation linked to one source, the
        # line goes first to a unit that takes part itself, then to the card the
        # partner list names (its coordinator first), then to the first in the
        # file. A reversed rule would draw it to a stand-in card while the
        # participating unit sat beside it.
        rank: dict = {}
        for layer, field in (("PROJECTS", "consortium"), ("CLUSTERS", "members")):
            for o in PAYLOAD[layer]:
                for row in o.get(field) or []:
                    if row.get("ref"):
                        r = 0 if row.get("role") == "coordinator" else 1
                        pair = (o["id"], row["ref"])
                        rank[pair] = min(r, rank.get(pair, r))
        index = {edge_pair(e): i for i, e in enumerate(PAYLOAD["EDGES"])}
        level = {edge_pair(e): bool(e.get("org")) for e in PAYLOAD["EDGES"]}
        order = lambda pair: (level[pair], rank.get(pair, 2), index[pair])
        shared = [e for e in PAYLOAD["EDGES"] if e.get("via")]
        self.assertGreater(len(shared), 0)
        for e in shared:
            src, team = edge_pair(e)
            with self.subTest(edge=e):
                self.assertLess(order((src, e["via"])), order((src, team)))

    def test_3_3_every_createdBy_and_usedBy_id_resolves(self):
        known = by_id()
        for layer in ("COMMONS", "FRAMEWORKS"):
            for o in PAYLOAD[layer]:
                for key in ("createdBy", "usedBy"):
                    for ref in o.get(key, []):
                        with self.subTest(layer=layer, id=o["id"], key=key, ref=ref):
                            self.assertIn(ref, known)

    def test_3_3_cross_references_never_point_at_the_entity_itself(self):
        # `relate(a, a, …)` would add a self-loop to `neighbors`, and the card
        # would list itself under "created by".
        for layer in ("COMMONS", "FRAMEWORKS"):
            for o in PAYLOAD[layer]:
                for key in ("createdBy", "usedBy"):
                    with self.subTest(layer=layer, id=o["id"], key=key):
                        self.assertNotIn(o["id"], o.get(key, []))

    def test_3_3_framework_refs_resolve(self):
        # `refsHtml()` filters unresolvable ids out, so a broken ref shows as a
        # shorter list rather than as a dead button — silent again.
        known = by_id()
        for o in PAYLOAD["FRAMEWORKS"]:
            for ref in o.get("refs", []):
                with self.subTest(id=o["id"], ref=ref):
                    self.assertIn(ref, known)

    def test_3_3_consortium_refs_all_resolve_so_no_card_shows_a_dead_link(self):
        # §3.3 states this as a guarantee of the generator: "`consortium[].ref` is
        # dropped when it does not resolve to a known entity, so the card never
        # renders a dead link." This is that guarantee checked on the output.
        known = by_id()
        for o in PAYLOAD["PROJECTS"]:
            for c in o.get("consortium", []):
                with self.subTest(id=o["id"], org=c.get("org")):
                    self.assertTrue(c.get("org"))
                    self.assertLessEqual(set(c), {"org", "role", "country", "ref"})
                    if "ref" in c:
                        self.assertIn(c["ref"], known)

    def test_3_2_infrastructure_hosts_resolve(self):
        # `infra.hosts` is the only reference the generator copies through
        # unfiltered; it drives the reciprocal "facilities" list on the hosting
        # team, so an unresolvable host silently loses that back-reference.
        known = by_id()
        for o in PAYLOAD["TEAMS"]:
            for host in (o.get("infra") or {}).get("hosts", []):
                with self.subTest(id=o["id"], host=host):
                    self.assertIn(host, known)


class Domains(unittest.TestCase):
    """§3.2 / §4.2 — colour means domain, which needs a colour for every code."""

    def test_3_2_every_domain_code_used_by_an_entity_has_a_colour(self):
        colors = colors_table()
        used = sorted({x for o in all_entities() for x in o["domains"]})
        missing = [d for d in used if d not in colors]
        # A code with no entry renders `#999` — the same grey `xai` legitimately
        # uses — so the break is invisible: the marker looks deliberate.
        self.assertEqual(missing, [])
        # §4.2 both counts them — "Seventeen domain colours in three filter
        # groups" — and lists them group by group. Both readings are taken from
        # the spec rather than restated here: the bullets are summed, and the
        # prose figure is parsed out of the sentence above them. So the spec and
        # the payload cannot drift apart while this file keeps agreeing with
        # itself, and the one number that is a claim about the corpus lives in
        # the document that makes the claim.
        self.assertEqual(len(used), sum(len(n) for _, n in spec_domain_groups()))
        self.assertEqual(len(used), spec_domain_colour_count())

    def test_3_2_every_lead_domain_has_a_colour(self):
        # Edge colour follows the source entity's lead domain (§4.3):
        # `COLORS[p.d.domain]||'#999'`.
        colors = colors_table()
        for layer, o in entities():
            with self.subTest(layer=layer, id=o["id"]):
                self.assertIn(o["domain"], colors)

    def test_3_2_the_colour_table_has_no_unused_entries(self):
        # The legend is generated from the filter groups, so a colour nothing
        # carries is a checkbox that can only ever produce an empty view.
        used = {x for o in all_entities() for x in o["domains"]}
        self.assertEqual(sorted(set(colors_table()) - used), [])

    def test_4_2_every_domain_code_belongs_to_exactly_one_filter_group(self):
        groups = dom_groups()
        self.assertEqual(sorted(groups), ["industrial", "infra", "research"])
        flat = [d for doms in groups.values() for d in doms]
        self.assertEqual(sorted(flat), sorted(colors_table()))
        self.assertEqual(len(flat), len(set(flat)))
        # Set equality survives a code moved from one group to another: the flat
        # list is unchanged, so every checkbox still exists and every colour
        # still has one. What moves is the heading it sits under — an
        # infrastructure category behind a research checkbox, which also changes
        # what the "research infrastructure" filter selects. §4.2 fixes the three
        # groups, their order and their sizes; §3.1.2 fixes which codes are the
        # infrastructure ones.
        spec_groups = spec_domain_groups()
        self.assertEqual([label for label, _ in spec_groups],
                         ["Industrial", "Research focus", "Research infrastructure"])
        self.assertEqual([len(groups[k]) for k in ("industrial", "research", "infra")],
                         [len(names) for _, names in spec_groups])
        infra_codes = spec_infra_domain_codes()
        self.assertEqual(sorted(infra_codes), ["cluster", "compute", "simulation"])
        self.assertEqual(sorted(groups["infra"]), sorted(infra_codes))

    def test_3_2_every_domain_code_has_a_label_in_both_languages(self):
        codes = set(colors_table())
        for table_name in ("badge", "dom"):
            tables = i18n_domain_tables(table_name)
            self.assertEqual(len(tables), 2)      # one per language
            for tbl in tables:
                with self.subTest(table=table_name):
                    self.assertEqual(sorted(tbl), sorted(codes))
                    self.assertTrue(all(v.strip() for v in tbl.values()))

    def test_3_2_the_two_domain_label_tables_are_not_one_table_twice(self):
        # The parity check above is satisfied by two copies of the English table:
        # both carry every code and both are non-empty. `t('dom')[code]` would
        # then hand a French reader an English legend with nothing anywhere to
        # say so — the one failure mode a key-by-key comparison cannot see. What
        # makes the French side real is that it differs, everywhere except the
        # few terms that are the same word in both languages, which is a short
        # enough list to pin.
        for table, shared in (("badge", ["aviation", "compute", "hf", "manufacturing",
                                         "maritime", "xai"]),
                              ("dom", ["aviation", "manufacturing", "maritime"])):
            a, b = i18n_domain_tables(table)
            with self.subTest(table=table):
                self.assertEqual(sorted(k for k in a if a[k] == b[k]), shared)

    def test_3_1_2_infrastructure_domain_codes_come_only_from_the_infra_layer(self):
        # §3.1.2 is emphatic about this: compute / cluster / simulation are
        # infrastructure categories, and `digital_twins` must never be mapped to
        # `simulation`, or every operator running a digital twin would turn up
        # under the research-infrastructure filters. Checked on the output: an
        # entity carrying one of those codes must have an `infra` block to
        # justify it.
        infra_codes = spec_infra_domain_codes()
        # A parse that silently came back empty would make the loop below vacuous
        # — every `set(domains) & set()` is empty — so the parse is pinned first.
        self.assertEqual(sorted(infra_codes), ["cluster", "compute", "simulation"])
        twins = 0
        for layer, o in entities():
            if "digital_twins" in (o.get("focus") or []):
                twins += 1
            if set(o["domains"]) & infra_codes:
                with self.subTest(layer=layer, id=o["id"]):
                    self.assertEqual(layer, "TEAMS")
                    self.assertTrue(o.get("infra"))
        self.assertGreater(twins, 0)      # the claim is vacuous with no twins
        for layer, o in entities():
            if "digital_twins" in (o.get("focus") or []) and not o.get("infra"):
                with self.subTest(layer=layer, id=o["id"]):
                    self.assertNotIn("simulation", o["domains"])

    def test_3_3_the_lead_domain_is_one_of_the_entity_s_own_domains(self):
        # §3.3 calls `domain` the lead that "drives colour when single"; the
        # marker is painted from `domains[0]` and the lines from the lead, so the
        # two must agree. ELLIS declares no sector: its only domain is the "xai"
        # derived from its focus areas, and the lead now falls back to that rather
        # than to "multi". It used to call itself multi while drawn grey, which
        # did not matter while it had no edges; as a cluster it has member lines,
        # and they would have come out teal from a grey marker.
        odd = sorted(o["id"] for o in all_entities() if o["domain"] not in o["domains"])
        self.assertEqual(odd, [])
        ellis = by_id()["ellis-society"]
        self.assertEqual((ellis["domain"], ellis["domains"]), ("xai", ["xai"]))
        self.assertIn("ellis-society", {e.get("cluster") for e in PAYLOAD["EDGES"]})


class Vocabulary(unittest.TestCase):
    """§3.4 — TAXO is the only source of human-readable labels for coded values."""

    # Which entity field feeds which TAXO group, as `cardHtml()` calls `taxo()`.
    def coded_values(self):
        out = {g: set() for g in PAYLOAD["TAXO"]}
        for o in all_entities():
            for group, value in (("type", o.get("type")), ("kind", o.get("kind")),
                                 ("status", o.get("status")), ("tier", o.get("tier")),
                                 ("legal", o.get("legal")),
                                 ("jurisdiction", o.get("jurisdiction"))):
                if value:
                    out[group].add(value)
            for f in o.get("focus", []) or []:
                out["focus"].add(f)
            inf = o.get("infra") or {}
            if inf.get("kind"):
                out["kind"].add(inf["kind"])       # one flat `kind` table
            if inf.get("access"):
                out["access"].add(inf["access"])
            for c in o.get("consortium", []) or []:
                if c.get("role"):
                    out["role"].add(c["role"])
            if (o.get("prov") or {}).get("conf"):
                out["confidence"].add(o["prov"]["conf"])
        return out

    def test_3_4_taxo_carries_exactly_the_groups_the_spec_lists_in_order(self):
        sentence = spec_section("### 3.4 Vocabulary", "### 3.5 Freshness")
        listed = re.findall(r"`(\w+)`", sentence.split(":", 1)[1].split(".", 1)[0])
        self.assertEqual(listed, ["focus", "type", "kind", "status", "tier",
                                  "access", "legal", "role", "jurisdiction",
                                  "confidence"])
        self.assertEqual(list(PAYLOAD["TAXO"]), listed)

    def test_3_4_every_taxo_entry_has_both_languages(self):
        # `taxo()` reads `e[LANG] || e.en`, so a missing French label silently
        # shows the English one and a missing English label shows nothing.
        for group, table in PAYLOAD["TAXO"].items():
            self.assertGreater(len(table), 0)
            for key, labels in table.items():
                with self.subTest(group=group, key=key):
                    self.assertEqual(sorted(labels), ["en", "fr"])
                    self.assertTrue(labels["en"].strip())
                    self.assertTrue(labels["fr"].strip())
                    self.assertNotIn("_", labels["en"])
                    self.assertNotIn("_", labels["fr"])

    def test_3_4_the_committed_taxo_is_exactly_what_the_generator_emits(self):
        # TAXO is not derived from the entities: it is a table in the generator
        # (English from taxonomy.yml, French hand-written). Recomputing it is the
        # only way to catch a hand-edit of the generated file.
        self.assertEqual(PAYLOAD["TAXO"], load_generator().taxo_payload())

    def test_3_4_focus_type_kind_status_tier_legal_confidence_are_fully_mapped(self):
        have = self.coded_values()
        for group in ("focus", "type", "kind", "status", "tier", "legal", "confidence"):
            with self.subTest(group=group):
                self.assertEqual(sorted(have[group] - set(PAYLOAD["TAXO"][group])), [])
                self.assertGreater(len(have[group]), 0)

    def test_3_4_access_jurisdiction_and_role_carry_values_TAXO_does_not_define(self):
        # SPEC-DEVIATION: §3.4 says TAXO carries labels "for every controlled
        # value". Two groups have values in the data that the table does not
        # define, so those render through the documented de-underscoring fallback
        # instead of a translated label — in French too, which is where it shows:
        # a `jurisdiction` of "DE" reads "DE" where a mapped value would read
        # "Allemagne". `role` left this list when `third_party` got its labels
        # ("Linked third party" / "Tiers lié"); it stays in the check so a new
        # role value without labels shows up here.
        have = self.coded_values()
        unmapped = {g: sorted(have[g] - set(PAYLOAD["TAXO"][g]))
                    for g in ("access", "jurisdiction", "role")}
        self.assertEqual(unmapped, {
            "access": ["commercial", "restricted"],
            "jurisdiction": ["DE", "DK", "NL", "UK"],
            "role": [],
        })

    def test_3_4_an_unmapped_key_degrades_to_readable_text(self):
        # The fallback the spec promises, checked in the implementation rather
        # than assumed: `taxo()` must look the key up in TAXO first and
        # de-underscore it when the lookup misses, because the payload above
        # relies on that for seven values.
        #
        # Checked inside `taxo()` rather than anywhere in the script, and
        # whitespace-tolerantly: the literal search this used to do would have
        # gone red on a reformat that put a space after the comma, while the
        # chip renderer's own copy of the expression would keep answering it if
        # `taxo()` ever grew a second one. The loop that followed it re-derived
        # `value.replace("_", " ")` and then asserted the result had no
        # underscore in it — a statement about this file, true by construction.
        body = re.search(r"function taxo\(group, key\)\{(.*?)\n\}", SCRIPT, re.S).group(1)
        self.assertIn("VOCAB[group]", body)          # the table wins when it has the key
        self.assertRegex(body, r"String\(key\)\.replace\(\s*/_/g\s*,\s*' '\s*\)")
        # No value that reaches the fallback today carries an underscore:
        # `third_party`, the one that did, now has its labels. The replace() is
        # what keeps the next unlabelled snake_case value from reading
        # "third_party" in both languages, so the check above stays; this one
        # pins that the payload currently leans on it for nothing.
        have = self.coded_values()
        unmapped = {v for g in ("access", "jurisdiction", "role")
                    for v in have[g] - set(PAYLOAD["TAXO"][g])}
        self.assertEqual(sorted(v for v in unmapped if "_" in v), [])

    def test_3_4_no_taxo_group_is_dead_weight(self):
        # Every group must be reachable from some entity field, or it is shipping
        # labels nothing can display.
        have = self.coded_values()
        empty = sorted(g for g, vals in have.items() if not vals)
        self.assertEqual(empty, [])


class Freshness(unittest.TestCase):
    """§3.5 — AS_OF is the data's own "now", and nothing else."""

    def prov_dates(self):
        out = []
        for o in all_entities():
            p = o.get("prov") or {}
            out += [d for d in (p.get("upd"), p.get("on")) if d]
        return out

    def test_3_5_as_of_is_one_iso_date(self):
        as_of = PAYLOAD["AS_OF"]
        self.assertRegex(as_of, ISO_DATE)
        self.assertEqual(datetime.date.fromisoformat(as_of).isoformat(), as_of)

    def test_3_5_every_provenance_date_is_a_real_iso_date(self):
        # `AS_OF` is a string `max()`, which only orders correctly while every
        # date is zero-padded ISO: "2026-9-3" would sort above "2026-12-01".
        for layer, o in entities():
            p = o["prov"]
            for key in ("on", "upd"):
                if p.get(key):
                    with self.subTest(layer=layer, id=o["id"], key=key):
                        self.assertRegex(p[key], ISO_DATE)
                        datetime.date.fromisoformat(p[key])

    def test_3_5_as_of_equals_the_most_recent_provenance_touch(self):
        dates = self.prov_dates()
        self.assertEqual(PAYLOAD["AS_OF"], max(dates))

    def test_3_5_as_of_is_not_in_the_future_of_any_provenance_entry(self):
        # Stated separately from the equality because these are the two halves a
        # reader relies on: the period axis stops at AS_OF and the freshness
        # bubble names it, so an AS_OF ahead of the data would promise currency
        # the payload does not have, and a date past AS_OF would be a touch the
        # axis cannot reach. The second half runs per entity, so a single
        # hand-bumped date is named rather than hidden inside a max().
        self.assertLessEqual(PAYLOAD["AS_OF"], max(self.prov_dates()))
        for layer, o in entities():
            for key in ("on", "upd"):
                if o["prov"].get(key):
                    with self.subTest(layer=layer, id=o["id"], key=key):
                        self.assertLessEqual(o["prov"][key], PAYLOAD["AS_OF"])

    def test_3_5_as_of_is_reproduced_by_the_generator_from_the_payload(self):
        # `data_as_of()` is deliberately not `date.today()` — a wall-clock value
        # would change on every no-op regeneration and break the empty-diff
        # invariant (§3). Running the real function over the committed payload
        # proves the committed value is the derived one.
        gen = load_generator()
        self.assertEqual(gen.data_as_of(GENERATED), GENERATED["AS_OF"])
        # And over the corpus the page ends up with: the overlay recomputes
        # `AS_OF` for itself, which §3.5's rule does not license it to do
        # differently just because the entries arrived in a second file. So the
        # generator's own function has to reproduce the date the reader is shown
        # as well as the one in the generated file.
        self.assertEqual(gen.data_as_of(PAYLOAD), PAYLOAD["AS_OF"])

    def test_3_5_as_of_is_drawn_from_every_layer_not_just_the_ones_that_win(self):
        # §3.5: "the most recent provenance.last_updated / added_on across every
        # entity in every layer". Neither check above can see a layer that is
        # skipped, because the maximum only ever sits in some of them: a
        # `data_as_of()` that stopped scanning FRAMEWORKS would still return the
        # same date and still agree with the payload. So each layer in turn is
        # given a date past the others, over the committed payload, and the
        # derived date has to follow it there.
        gen = load_generator()
        later = "2099-01-01"
        for layer in ENTITY_LAYERS:
            bumped = dict(PAYLOAD[layer][0])
            bumped["prov"] = dict(bumped["prov"], upd=later)
            data = dict(PAYLOAD, **{layer: [bumped] + PAYLOAD[layer][1:]})
            with self.subTest(layer=layer):
                self.assertEqual(gen.data_as_of(data), later)

    def test_3_5_last_updated_is_never_older_than_added_on(self):
        for layer, o in entities():
            p = o["prov"]
            if p.get("on") and p.get("upd"):
                with self.subTest(layer=layer, id=o["id"]):
                    self.assertGreaterEqual(p["upd"], p["on"])

    def test_3_5_the_freshness_date_is_carried_by_a_real_entity(self):
        # Otherwise AS_OF would be a floating claim: at least one card has to be
        # able to show the reader where the date came from.
        at_max = [o["id"] for o in all_entities()
                  if PAYLOAD["AS_OF"] in (o["prov"].get("upd"), o["prov"].get("on"))]
        self.assertGreater(len(at_max), 0)

    def test_3_2_the_spec_s_snapshot_date_is_the_payload_s_as_of(self):
        # §3.2 dates its counts; §3.5 defines AS_OF as the freshness date. The
        # table and the date describe the same snapshot of the same file, so they
        # have to agree — this is what catches a regeneration that updated the
        # figures in the table and left the date behind it. It is the generated
        # file's own AS_OF, for the same reason the figures above are the
        # generated file's own counts.
        m = re.search(r"Counts are a snapshot \((\d+) (\w+) (\d{4})\)", SPEC_TEXT)
        self.assertIsNotNone(m)
        day, month, yearv = m.groups()
        months = ["January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December"]
        dated = datetime.date(int(yearv), months.index(month) + 1, int(day))
        self.assertEqual(dated.isoformat(), GENERATED["AS_OF"])
        # The reader is shown the overlay's recomputed date instead, and an
        # overlay carries entries added *after* the regeneration it is waiting
        # for. So it can only move the freshness date forward. An overlay that
        # moved it back would be claiming the corpus got staler by growing, and
        # would pull the period axis in over entities it had just added.
        self.assertGreaterEqual(PAYLOAD["AS_OF"], GENERATED["AS_OF"])


class Descriptions(unittest.TestCase):
    """§3.1.3 — descriptions are not truncated. The old cap left a signature."""

    def desc_fields(self):
        for layer, o in entities():
            for field in ("desc", "desc_en", "desc_fr"):
                if o.get(field):
                    yield layer, o, field, o[field]

    def test_3_1_3_no_description_is_exactly_300_characters(self):
        # The predecessor's `[:300]` left descriptions sitting exactly on the cap.
        # One at 300 is the fingerprint of the truncation coming back.
        at_cap = [(o["id"], f) for _, o, f, s in self.desc_fields() if len(s) == 300]
        self.assertEqual(at_cap, [])

    def test_3_1_3_no_description_ends_in_an_ellipsis(self):
        # The other half of the fingerprint: a cut mid-word was papered over with
        # "…". A legitimate description ends in punctuation, not in an elision.
        cut = [(o["id"], f) for _, o, f, s in self.desc_fields()
               if s.rstrip().endswith(("…", "..."))]
        self.assertEqual(cut, [])

    def test_3_1_3_the_descriptions_the_old_cap_would_have_cut_are_intact(self):
        # §3.1.3 counts the damage precisely — so precisely that the two figures
        # are read out of the sentence that states them rather than copied here:
        # the cap cut N English and M French descriptions mid-word, so at least
        # that many must now run past 300 characters. This is the assertion that
        # actually fails if a cap is reintroduced, where "none is exactly 300"
        # would not.
        english, french = spec_truncation_losses()
        over = Counter(f for _, _, f, s in self.desc_fields() if len(s) > 300)
        self.assertGreaterEqual(over["desc_en"], english)
        self.assertGreaterEqual(over["desc_fr"], french)

    def test_3_1_3_paragraph_breaks_are_preserved_and_wrapped_lines_re_joined(self):
        # A YAML block scalar arrives hard-wrapped. §3.1.3: paragraph breaks are
        # kept, wrapped lines are re-joined — which in the payload means a lone
        # "\n" never survives, only the "\n\n" the card splits on.
        for layer, o, field, s in self.desc_fields():
            with self.subTest(layer=layer, id=o["id"], field=field):
                self.assertIsNone(re.search(r"(?<!\n)\n(?!\n)", s))
                self.assertNotIn("\n\n\n", s)
                self.assertNotIn("\r", s)
                self.assertEqual(s, s.strip())
        # And the capability is exercised, not just permitted.
        self.assertGreater(sum(1 for _, _, _, s in self.desc_fields() if "\n\n" in s), 0)


class LayerTable(unittest.TestCase):
    """§3.2 — the table's shape is normative; its figures are a snapshot."""

    def test_3_2_the_table_keeps_its_columns_and_row_order(self):
        header, rows = spec_layer_rows()
        self.assertEqual(header, ["Layer", "Count", "Marker", "Origin"])
        self.assertEqual([r[0] for r in rows],
                         ["Projects & programmes", "Teams", "Clusters", "Commons",
                          "Frameworks", "Links"])
        self.assertEqual([r[2] for r in rows],
                         ["large circle", "small circle", "hexagon", "dashed circle",
                          "square", "curved edge"])
        self.assertEqual([r[3] for r in rows], [
            "`data/projects/`",
            "`data/teams/` + infrastructure with no matching team",
            "`data/clusters/`",
            "`data/commons/`",
            "`data/frameworks/`",
            "`data/edges.yml`",
        ])
        for row in rows:
            with self.subTest(layer=row[0]):
                self.assertEqual(len(row), 4)
                self.assertGreater(int(row[1]), 0)

    def test_3_2_the_four_entity_rows_are_the_four_layers_the_map_registers(self):
        # The table's row order is the reader's mental model of the layers; the
        # map's own `KINDS` order drives the counter tiles and the search groups.
        # They need not be the same order, but they must be the same four layers.
        registered = registered_layers()
        self.assertEqual(registered, LAYER_KIND)
        kinds = re.search(r"const KINDS = \[(.*?)\];", SCRIPT).group(1)
        self.assertEqual(sorted(re.findall(r"'(\w+)'", kinds)),
                         sorted(LAYER_KIND.values()))

    def test_3_2_the_documented_figures_still_match_the_payload(self):
        # The figures are explicitly a snapshot, so this is a documentation-sync
        # check rather than an invariant: when an upstream regeneration moves a
        # count, update the table in §3.2 and this test will go green again. It
        # earns its place by also failing on the thing that must never happen —
        # a hand-edit of hai-data.js that adds or drops an entity.
        #
        # The table documents the generated file, which is what §3.2's own
        # pipeline diagram produces, so that is what it is compared against. The
        # corpus the reader actually sees is larger while an overlay is pending;
        # tying the two together is `PendingOverlay`'s job, below.
        _, rows = spec_layer_rows()
        documented = {r[0]: int(r[1]) for r in rows}
        self.assertEqual(documented, {
            "Projects & programmes": len(GENERATED["PROJECTS"]),
            "Teams": len(GENERATED["TEAMS"]),
            "Clusters": len(GENERATED["CLUSTERS"]),
            "Commons": len(GENERATED["COMMONS"]),
            "Frameworks": len(GENERATED["FRAMEWORKS"]),
            "Links": len(GENERATED["EDGES"]),
        })

    def test_3_2_infrastructure_has_no_layer_of_its_own(self):
        # The design commitment: infrastructure never becomes a fifth layer. Half
        # of it merges into the team that runs it (same id, so no duplicate pin),
        # the rest arrives as teams tagged `type: infrastructure`. Either way an
        # `infra` block only ever appears on a team.
        for layer in ("PROJECTS", "COMMONS", "FRAMEWORKS"):
            with self.subTest(layer=layer):
                self.assertEqual([o["id"] for o in PAYLOAD[layer] if o.get("infra")], [])
        infra = [o for o in PAYLOAD["TEAMS"] if o.get("infra")]
        merged = [o for o in infra if o.get("type") != "infrastructure"]
        standalone = [o for o in infra if o.get("type") == "infrastructure"]
        self.assertEqual(len(merged) + len(standalone), len(infra))
        # Documented split (same snapshot caveat as the figures above): N entries,
        # of which some merge into an existing team and the rest render as team
        # markers. All three figures are read out of the sentence that states
        # them, in the order it states them, so a regeneration that moves them
        # fails against the documentation rather than against this file — and the
        # arithmetic that makes the split a split is checked on those same
        # parsed figures.
        figures = spec_prose_figures(
            "**Infrastructure has no layer of its own**", "### 3.3 Entity fields")
        self.assertEqual(len(figures), 3)       # a fourth figure would go unread
        total, into_teams, as_markers = figures
        self.assertEqual(into_teams + as_markers, total)
        self.assertEqual([len(infra), len(merged), len(standalone)],
                         [total, into_teams, as_markers])

    def test_3_2_a_merged_infrastructure_entry_adds_its_domain_code_to_the_team(self):
        # §3.2: merging "adds their infrastructure domain code to its marker".
        # The code is derived from the facility kind through INFRA_KIND, with
        # `simulation` as the default, so the mapping is checked against the
        # generator's own table rather than restated here.
        infra_kind = load_generator().INFRA_KIND
        for o in PAYLOAD["TEAMS"]:
            inf = o.get("infra")
            if not inf:
                continue
            with self.subTest(id=o["id"], kind=inf.get("kind")):
                lead = infra_kind.get(inf.get("kind"), "simulation")
                self.assertIn(lead, o["domains"])

    def test_3_2_a_merged_infrastructure_entry_never_creates_a_second_pin(self):
        # "without creating a duplicate pin" — the merge is keyed on the shared
        # id, so the proof is that no two teams share a name *and* a location.
        seen = Counter((o.get("name"), o.get("lat"), o.get("lon"))
                       for o in PAYLOAD["TEAMS"] if o.get("lat") is not None)
        self.assertEqual(sorted(k for k, n in seen.items() if n > 1), [])


class PerLayerFields(unittest.TestCase):
    """§3.3 — the per-layer field lists, and the legacy aliases."""

    # field -> the layers §3.3 allows it on
    PLACEMENT = {
        "when": {"PROJECTS"}, "funding": {"PROJECTS"}, "budget": {"PROJECTS"},
        "consortium": {"PROJECTS"}, "demos": {"PROJECTS"}, "delivs": {"PROJECTS"},
        "type": {"TEAMS"}, "affiliation": {"TEAMS"}, "facilities": {"TEAMS"},
        "infra": {"TEAMS"}, "organisation": {"TEAMS"}, "members": {"CLUSTERS"},
        "jurisdiction": {"FRAMEWORKS"}, "issuer": {"FRAMEWORKS"},
        "legal": {"FRAMEWORKS"}, "adopted": {"FRAMEWORKS"},
        "appliesTo": {"FRAMEWORKS"}, "refs": {"FRAMEWORKS"},
        "license": {"COMMONS"}, "maintainer": {"COMMONS"}, "repo": {"COMMONS"},
        "size": {"COMMONS", "CLUSTERS"},
        "kind": {"PROJECTS", "CLUSTERS", "COMMONS", "FRAMEWORKS"},
        "subSection": {"COMMONS", "FRAMEWORKS"},
        "usedBy": {"COMMONS", "FRAMEWORKS"},
    }

    def test_3_3_per_layer_fields_appear_only_on_their_own_layer(self):
        # The card renders a field wherever it finds it — `d.license` puts a
        # licence row on a project as happily as on a commons — so the layer
        # discipline is only enforced upstream.
        where = {}
        for layer, o in entities():
            for field in o:
                where.setdefault(field, set()).add(layer)
        for field, allowed in self.PLACEMENT.items():
            with self.subTest(field=field):
                self.assertEqual(where.get(field), allowed)

    def test_3_3_frameworks_never_carry_createdBy(self):
        # SPEC-DEVIATION: §3.3 lists `createdBy[]` among a framework's fields, but
        # the generator sets it to `[]` for every framework and `clean()` drops
        # empty lists, so no framework ever has one. The field is real for commons
        # only; a framework's provenance flows the other way, through `usedBy`.
        self.assertEqual([o["id"] for o in PAYLOAD["FRAMEWORKS"] if "createdBy" in o], [])
        self.assertGreater(len([o for o in PAYLOAD["COMMONS"] if o.get("createdBy")]), 0)
        self.assertGreater(len([o for o in PAYLOAD["FRAMEWORKS"] if o.get("usedBy")]), 0)

    def test_3_3_subSection_is_the_documented_alias_of_kind(self):
        for layer in ("COMMONS", "FRAMEWORKS"):
            for o in PAYLOAD[layer]:
                with self.subTest(layer=layer, id=o["id"]):
                    self.assertEqual(o["subSection"], o["kind"])

    def test_3_3_budget_is_the_legacy_alias_of_the_funding_line(self):
        # §3.3 calls `budget` a "legacy alias". It aliases the funding *label*
        # (grant, else source), not the amount — `funding.eur` is what money()
        # formats — so a reader of the card sees the grant number twice, never a
        # number where a name belongs.
        for o in PAYLOAD["PROJECTS"]:
            fn = o.get("funding") or {}
            with self.subTest(id=o["id"]):
                self.assertEqual(o.get("budget", ""), fn.get("grant") or fn.get("source") or "")

    def test_3_3_when_is_the_compact_span_of_the_timeline(self):
        # `when` is what the tooltip and the print sheet show; it must never
        # disagree with the timeline the card renders below it.
        for o in PAYLOAD["PROJECTS"]:
            tl = o.get("timeline") or {}
            start, end = tl.get("start", ""), tl.get("end", "")
            expected = "" if not (start or end) else (f"{start}–{end}" if end else f"{start}–")
            with self.subTest(id=o["id"]):
                self.assertEqual(o.get("when", ""), expected)

    def test_3_3_nested_objects_carry_only_the_documented_keys(self):
        shapes = {
            "funding": {"source", "call", "grant", "eur", "url"},
            "links": {"papers", "linkedin", "twitter", "docs", "official"},
            "prov": {"by", "on", "upd", "src", "conf"},
            "infra": {"kind", "operator", "access", "capacity", "hosts"},
            "affiliation": {"org", "parent", "url"},
            "issuer": {"org", "url"},
            "maintainer": {"org", "url"},
        }
        for layer, o in entities():
            for field, allowed in shapes.items():
                if isinstance(o.get(field), dict):
                    with self.subTest(layer=layer, id=o["id"], field=field):
                        self.assertLessEqual(set(o[field]), allowed)

    def test_3_3_every_named_organisation_object_has_an_org(self):
        # The card renders `esc(d.issuer.org)` / `extUrl(url, org)` as soon as the
        # object exists, so an object with only a `url` renders an empty link.
        for layer, o in entities():
            for field in ("issuer", "maintainer", "affiliation"):
                if o.get(field):
                    with self.subTest(layer=layer, id=o["id"], field=field):
                        self.assertTrue(o[field].get("org"))
        for o in PAYLOAD["TEAMS"]:
            op = (o.get("infra") or {}).get("operator")
            if op:
                with self.subTest(id=o["id"], field="infra.operator"):
                    self.assertTrue(op.get("org"))

    def test_3_3_funding_amounts_are_numbers(self):
        # `money()` hands `fn.eur` to Intl.NumberFormat; a string would format as
        # NaN €, and a string with a comma would format as something worse.
        zeros = []
        for o in PAYLOAD["PROJECTS"]:
            eur = (o.get("funding") or {}).get("eur")
            if eur is not None:
                with self.subTest(id=o["id"]):
                    self.assertIsInstance(eur, (int, float))
                    self.assertNotIsInstance(eur, bool)
                    self.assertGreaterEqual(eur, 0)
                if eur == 0:
                    zeros.append(o["id"])
        # No project carries a 0 any more: r2dato's placeholder was replaced by
        # its published budget in the 2026-10 review. The card reads
        # `fn.eur ? …`, so a zero would be falsy and the budget row omitted
        # rather than rendering "€0" — the right reading of "amount unknown".
        # Pinned so a new zero is a decision, not an accident.
        self.assertEqual(zeros, [])

    def test_3_3_link_values_that_are_not_urls_are_a_known_and_bounded_set(self):
        # `extUrl()` wraps whatever it is given in an `<a href>`, so a value that
        # is not a URL becomes a link to a relative path that does not exist. §3.3
        # states the dead-link guarantee only for `consortium[].ref`, and these
        # eight values are the places it does not reach: three bibliographic
        # citations in `links.papers` (papers with no DOI URL upstream) and five
        # bare social handles. Pinned rather than fixed, so a regression widens
        # the set and fails here.
        offenders = []
        for o in all_entities():
            lk = o.get("links") or {}
            for key in ("linkedin", "twitter", "docs", "official"):
                if lk.get(key) and not re.match(r"^https?://", lk[key]):
                    offenders.append((o["id"], key))
            for paper in lk.get("papers", []):
                if not re.match(r"^https?://", paper):
                    offenders.append((o["id"], "papers"))
        self.assertEqual(sorted(offenders), [
            ("dfki-trustworthy-ai", "linkedin"),
            ("dfki-trustworthy-ai", "twitter"),
            ("ellis-society", "twitter"),
            ("lf-energy", "linkedin"),
            ("lf-energy", "twitter"),
            ("meaningful-human-control", "papers"),
            ("ten-challenges-team-player", "papers"),
            ("trust-in-automation-lee-see", "papers"),
        ])

    def test_3_3_repo_and_url_and_nested_urls_are_absolute(self):
        for layer, o in entities():
            for field in ("url", "repo"):
                if o.get(field):
                    with self.subTest(layer=layer, id=o["id"], field=field):
                        self.assertRegex(o[field], r"^https?://")
            for field in ("issuer", "maintainer", "affiliation", "funding"):
                url = (o.get(field) or {}).get("url")
                if url:
                    with self.subTest(layer=layer, id=o["id"], field=field):
                        self.assertRegex(url, r"^https?://")

    def test_3_3_dateConf_and_dateHost_are_derived_not_authored(self):
        # §3.3: both are parsed out of the provenance note. So `dateConf` must be
        # one of the three confidence levels the note can carry, `dateHost` only
        # ever `true` and only alongside a medium/low confidence — the map keys
        # `vague` off it, and a `dateHost` on a high-confidence date would move an
        # entity out of the period filter's solid range for no reason.
        # §10.2 names the levels firmest first, which is the order the host-year
        # case needs: it is the one that is never the firmest reading of a start.
        firmest, *softer = spec_date_note_levels()
        levels = (firmest,) + tuple(softer)
        for layer, o in entities():
            if "dateConf" in o:
                with self.subTest(layer=layer, id=o["id"]):
                    self.assertIn(o["dateConf"], levels)
                    self.assertRegex(o["prov"].get("src", ""), r"timeline\.start \(")
            if "dateHost" in o:
                with self.subTest(layer=layer, id=o["id"]):
                    self.assertIs(o["dateHost"], True)
                    # Everything but the firmest level: §10.2's host-year case is
                    # a note that admits the sub-unit's own date was not found,
                    # which is never a high-confidence start.
                    self.assertIn(o.get("dateConf"), softer)
                    self.assertNotEqual(o["dateConf"], firmest)
                    self.assertTrue((o.get("timeline") or {}).get("start"))

    def test_3_3_dateConf_and_dateHost_reproduce_the_note_they_were_parsed_from(self):
        # "Derived, not authored" is only checked above as far as the shape of
        # the value: that `dateConf` is one of the three levels and `dateHost`
        # only joins a medium or low one. A hand-edit from "low" to "high" on an
        # entity with no `dateHost`, or a `date_quality()` that lost its
        # host-year branch and stopped emitting `dateHost` at all, satisfies
        # every one of those and changes what the period filter draws as firm.
        #
        # The stronger reading of §3.3 is that both fields are a function of
        # `prov.src` alone, so they are recomputed from it with the generator's
        # own parser — the same move `AS_OF` and `TAXO` get above — and have to
        # come back identical for every entity — including the majority, which
        # carry no date note and must therefore carry neither field.
        gen = load_generator()
        for layer, o in entities():
            got = {k: o[k] for k in ("dateConf", "dateHost") if k in o}
            recomputed = gen.date_quality({"provenance": {"source": o["prov"].get("src", "")}})
            with self.subTest(layer=layer, id=o["id"]):
                self.assertEqual(got, recomputed)
        # Per-entity equality still holds if a regeneration dropped the notes and
        # the fields together, so the volume is checked too — but derived from
        # the notes rather than pinned to a figure, because the population moves
        # with every regeneration exactly as §3.2's table does.
        #
        # The derivation goes round `date_quality()` instead of through it. The
        # note is matched with the generator's own two patterns, `DATE_NOTE` and
        # `HOST_YEAR` — the same move §3.2's INFRA_KIND check makes — and the
        # branching that turns a match into a field is re-stated here. A
        # `date_quality()` that lost its host-year branch would agree with the
        # payload entity by entity above and disagree with this.
        #
        # First, that `DATE_NOTE` reads the form §10.2 documents — "the dating
        # pass wrote `timeline.start (high|medium|low): <evidence>`" — for each
        # level the spec names, so the pattern cannot be quietly narrowed to a
        # subset of the notes and take the derivation below with it.
        firmest, *softer = spec_date_note_levels()
        levels = (firmest,) + tuple(softer)
        for level in levels:
            probe = f"timeline.start ({level}): Estimate: Example started 2020"
            with self.subTest(level=level):
                m = gen.DATE_NOTE.search(probe)
                self.assertIsNotNone(m)
                self.assertEqual(m.group(1), level)
        notes = {}
        for o in all_entities():
            m = gen.DATE_NOTE.search(o["prov"].get("src", ""))
            if m:
                notes[o["id"]] = (m.group(1), m.group(2).strip())
        self.assertEqual(sorted(notes),
                         sorted(o["id"] for o in all_entities() if "dateConf" in o))
        self.assertEqual({i: c for i, (c, _) in notes.items()},
                         {o["id"]: o["dateConf"] for o in all_entities()
                          if "dateConf" in o})
        # All three levels are in use, so none of the three branches is dead.
        self.assertEqual(sorted({c for c, _ in notes.values()}), sorted(levels))
        self.assertEqual(sorted(o["id"] for o in all_entities() if o.get("dateHost")),
                         sorted(i for i, (c, note) in notes.items()
                                if c in softer and gen.HOST_YEAR.search(note)))
        # And the host-year case is populated: an empty one would make the line
        # above an equality between two empty lists.
        self.assertGreater(sum(1 for o in all_entities() if o.get("dateHost")), 0)


class PendingOverlay(unittest.TestCase):
    """§2 / §3.2 — the payload arrives in two files, and the second only adds.

    `hai-data.js` is generated from the private source repository; entries added
    there since the last regeneration reach the reader through an overlay script
    that merges them into `window.HAI_DATA`. Everything above derives its figures
    from that merge, so the merge rule itself is what has to hold: if an overlay
    replaced or dropped an entry instead of appending one, `page_payload()` would
    be modelling a corpus the page never has, and every count in this file would
    be measured against the wrong population.

    These checks read the overlay's own source, not `page_payload()`'s output.
    """

    def overlay_sources(self):
        return [(src, (MAP_HTML.parent / src).read_text(encoding="utf-8"))
                for src in overlay_scripts()]

    def test_2_every_overlay_is_loaded_after_the_generated_payload(self):
        # Load order is the whole mechanism: the overlay reads `window.HAI_DATA`
        # and returns early if it is not there yet (`if (!D) return;`), so an
        # overlay placed above `hai-data.js` would merge nothing at all and fail
        # silently — the page would render the generated corpus and look fine.
        srcs = page_data_scripts()
        self.assertIn(GENERATED_SRC, srcs)
        for src in overlay_scripts():
            with self.subTest(overlay=src):
                self.assertGreater(srcs.index(src), srcs.index(GENERATED_SRC))
                self.assertTrue((MAP_HTML.parent / src).is_file())

    def test_3_2_an_overlay_carries_only_the_layers_the_payload_keys(self):
        # A key this file does not merge would sit in the overlay unread: new
        # TAXO groups that never reach `taxo()`, or a sixth layer with no `reg()`
        # call behind it. §3.4's vocabulary tests read the generated TAXO table
        # directly, which is only sound while no overlay ships one.
        for src, text in self.overlay_sources():
            add = json.loads(_json_object_after(text, "var ADD = "))
            with self.subTest(overlay=src):
                self.assertLessEqual(set(add), set(PAYLOAD_LAYERS))
                self.assertGreater(len(add), 0)
                for layer in ENTITY_LAYERS:
                    self.assertTrue(all(o.get("id") for o in add.get(layer, [])))
                for edge in add.get("EDGES", []):
                    self.assertIn(sorted(edge), (["project", "team"], ["cluster", "team"]))

    def test_3_2_an_overlay_appends_and_never_rewrites_what_it_merges_into(self):
        # The merge is append-only by construction: it pushes onto the arrays
        # already on `window.HAI_DATA` and never assigns one, splices one or
        # drops an element. That is what makes the corpus the page holds the
        # union of the two files rather than whichever of them ran last, and it
        # is also what makes the overlay a harmless no-op once `hai-data.js` has
        # been regenerated with the same entries in it.
        for src, text in self.overlay_sources():
            with self.subTest(overlay=src):
                self.assertRegex(text, r"\.push\(")
                for destructive in (r"D\[\s*layer\s*\]\s*=[^=]", r"D\.EDGES\s*=[^=]",
                                    r"\.splice\(", r"\.shift\(", r"\.pop\(\s*\)\s*;",
                                    r"delete\s+D"):
                    self.assertNotRegex(text, destructive)

    def test_3_2_an_overlay_never_ships_the_same_entry_twice(self):
        # Within one overlay, and across several: a repeated id reaches the merge
        # as two entries, the second of which is dropped on the `have` check, so
        # a duplicate is invisible in the rendered map and visible only as a
        # discrepancy between the file and what it contributes. A repeated edge
        # pair would be dropped the same way. Checked on the pooled additions so
        # that two overlays colliding with each other is caught as well.
        for layer in ENTITY_LAYERS:
            ids = [o["id"] for o in ADDED[layer]]
            with self.subTest(layer=layer):
                self.assertEqual(sorted(i for i, n in Counter(ids).items() if n > 1), [])
        pairs = [edge_pair(e) for e in ADDED["EDGES"]]
        self.assertEqual(sorted(p for p, n in Counter(pairs).items() if n > 1), [])


if __name__ == "__main__":
    unittest.main()
