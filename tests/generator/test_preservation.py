"""What the generator must preserve, and why its output has to be byte-stable.

Covers §3.1 points 3 and 4, §3.3 (the entity shape), §3.5 (freshness) and
invariant 1 of `docs/map-interface-spec.md`.

Everything here runs against synthetic fixture trees written under
`tests/fixtures/preserve_*`, so the tests never need the `eu-hai-collab-map`
checkout. The fixtures are raw YAML text rather than the output of a YAML
dumper, because two of the claims under test are about the *bytes* the
generator reads: only a literal block scalar (`|`) hands it a description whose
lines are still wrapped. A folded scalar (`>`) would have YAML re-join those
lines before `norm_text` ever saw them, and the test would be exercising PyYAML
instead of the rule it means to pin.

A handful of tests assert against the committed `hai-data.js` instead. Those are
the ones where the real corpus is the interesting witness: 449 entities, eleven
of them without coordinates, and descriptions nearly four times longer than the
cap the predecessor imposed.
"""
from __future__ import annotations

import json
import re
import shutil
import unittest
from collections import Counter
from datetime import date
from pathlib import Path

from tests._harness import DATA_JS, GENERATOR, REPO, load_generator, load_payload, map_script

GEN = load_generator()
FIXTURES = REPO / "tests" / "fixtures"
LAYERS = ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS")
DESC_FIELDS = ("desc", "desc_en", "desc_fr")
NOWHERE = Path("/nowhere/eu-hai-collab-map")


# --- fixture plumbing --------------------------------------------------------


def tree(name: str, files: dict[str, str]) -> Path:
    """Write a synthetic source checkout at `tests/fixtures/preserve_<name>`.

    Rebuilt from scratch on every call, so one test cannot inherit another's
    tree and the order the tests run in cannot matter.
    """
    root = FIXTURES / f"preserve_{name}"
    if root.exists():
        shutil.rmtree(root)
    for layer in ("teams", "projects", "infrastructure", "frameworks", "commons", "i18n"):
        (root / "data" / layer).mkdir(parents=True)
    pending = dict(files)
    (root / "data" / "edges.yml").write_text(
        pending.pop("data/edges.yml", "[]\n"), encoding="utf-8")
    for rel, text in pending.items():
        (root / rel).write_text(text, encoding="utf-8")
    return root


def literal_block(key: str, paragraphs, gaps=None) -> str:
    """`key: |` — a literal scalar whose line breaks survive YAML parsing.

    `gaps[i]` is how many blank lines separate paragraph i from i+1, so a
    fixture can hand the generator two blank lines where one paragraph break is
    meant and check that the extra one is not doubled into the output.
    """
    gaps = list(gaps if gaps is not None else [1] * (len(paragraphs) - 1))
    out = [f"{key}: |"]
    for i, para in enumerate(paragraphs):
        if i:
            out += [""] * gaps[i - 1]
        out += ["  " + line for line in para]
    return "\n".join(out) + "\n"


def find(data: dict, layer: str, eid: str) -> dict:
    for e in data[layer]:
        if e["id"] == eid:
            return e
    raise AssertionError(f"{eid} missing from {layer}: {[e['id'] for e in data[layer]]}")


def emit(data: dict, source: Path = NOWHERE) -> str:
    return GEN.render(data, source)


def parsed_array(rendered: str, name: str) -> list[dict]:
    """Read one `const NAME = [...]` array back out of rendered output.

    Each entity is emitted on its own line as a JSON object with a trailing
    comma, so parsing it back needs no JS runtime — and a round-trip that
    matches `build()` proves the emission step loses nothing either.
    """
    block = rendered.split(f"const {name} = [\n", 1)[1].split("\n];", 1)[0]
    return [json.loads(line.strip().rstrip(",")) for line in block.splitlines() if line.strip()]


def payload_prov_dates(payload: dict) -> list[str]:
    return [d for layer in LAYERS for e in payload[layer]
            for d in (e.get("prov", {}).get("upd"), e.get("prov", {}).get("on")) if d]


# --- §3.1.3 fixture: descriptions -------------------------------------------

# Three paragraphs, wrapped the way a curator wraps prose in a YAML file. The
# whole thing is far past 300 characters, and the third paragraph is separated
# by *two* blank lines so the collapse rule is visible.
LONG_PARAS = [
    (
        "The control room is run as a joint human-machine system: the optimiser",
        "proposes a redispatch, the operator accepts, amends or rejects it, and",
        "the reason for every override is logged for the next training round.",
    ),
    (
        "The team's own framing is that a recommendation nobody can refuse is not",
        "a recommendation but an instruction, so every screen carries an explicit",
        "disagree path and the disagreements are studied rather than suppressed.",
    ),
    (
        "Funded jointly by two national programmes; the 2026 phase adds two more",
        "control rooms and a shared benchmark of operator trust calibration.",
    ),
]
EXPECTED_LONG = "\n\n".join(" ".join(lines) for lines in LONG_PARAS)

# A word that straddles the old 300-character cap: it begins at index 294 and
# ends at 321, so a cap would have left "incon" behind and nothing else.
STRADDLE_WORD = "incontrovertibly-documented"
STRADDLE_TEXT = "detail " * 42 + STRADDLE_WORD + " end."

# 301 characters exactly — one past the cap, two words, no internal whitespace
# for the normaliser to touch, so only the cap could change its length.
BOUNDARY_TEXT = "x" * 150 + " " + "y" * 150

LONG_EN = [
    (
        "Grid operators across the Nordic synchronous area take part; the English",
        "description is deliberately longer than three hundred characters so that",
        "a reinstated cap would cut it, and it carries a paragraph break too.",
    ),
    (
        "The second paragraph exists only to be counted: one break in, one break",
        "out, and no wrapped line surviving as a line.",
    ),
]
LONG_FR = [
    (
        "Le centre de conduite est exploité comme un système humain–machine",
        "conjoint : l'optimiseur propose un redispatch, l'opérateur l'accepte,",
        "l'amende ou le refuse, et chaque refus est journalisé avec sa raison.",
    ),
    (
        "Deuxième paragraphe, avec accents et tirets cadratins — de quoi vérifier",
        "que rien n'est échappé ni tronqué à la sortie.",
    ),
]
EXPECTED_EN = "\n\n".join(" ".join(p) for p in LONG_EN)
EXPECTED_FR = "\n\n".join(" ".join(p) for p in LONG_FR)

DESC_TREE = {
    "data/teams/t-long.yml": (
        "id: t-long\n"
        "name: Nordic Control Room Lab\n"
        "location: {city: Oslo, country: 'NO', lat: 59.91, lon: 10.75}\n"
        + literal_block("description", LONG_PARAS, gaps=[1, 2])
    ),
    "data/teams/t-straddle.yml": (
        "id: t-straddle\n"
        "name: Straddle Lab\n"
        + literal_block("description", [(STRADDLE_TEXT,)])
    ),
    "data/teams/t-boundary.yml": (
        "id: t-boundary\n"
        "name: Boundary Lab\n"
        + literal_block("description", [(BOUNDARY_TEXT,)])
    ),
    "data/teams/t-wrap.yml": (
        "id: t-wrap\n"
        "name: Wrap Lab\n"
        "description: |\n"
        "  A sentence that the curator\n"
        "      wrapped and then indented\n"
        "  further than the block itself.\n"
    ),
    # Two "blank" separator lines that are not blank: five spaces where the
    # block is indented two, and a line holding a single tab. Editors leave the
    # indentation on empty lines all the time, and PyYAML blanks such a line
    # only when it is indented no further than the block itself — past that,
    # the leftover whitespace reaches the generator, which is the only thing
    # standing between the curator's paragraph break and one welded paragraph.
    "data/teams/t-gap.yml": (
        "id: t-gap\n"
        "name: Indented Gap Lab\n"
        "description: |\n"
        "  First paragraph, wrapped\n"
        "  across two lines.\n"
        "     \n"
        "  Second paragraph.\n"
        "  \t\n"
        "  Third paragraph.\n"
    ),
    "data/teams/t-blank.yml": (
        "id: t-blank\n"
        "name: Blank Lab\n"
        "description: '   '\n"
    ),
    "data/teams/t-none.yml": (
        "id: t-none\n"
        "name: No Desc Lab\n"
    ),
    "data/i18n/descriptions.en.yml": (
        literal_block("t-long", LONG_EN)
        + "t-none: ''\n"
    ),
    "data/i18n/descriptions.fr.yml": literal_block("t-long", LONG_FR),
}


class NormalisedDescriptions(unittest.TestCase):
    """§3.1 point 3 / invariant 7 — descriptions are not truncated.

    The predecessor `sync_html_map.py` capped every description at 300
    characters, cutting 29 English and 39 French descriptions mid-word. These
    tests pin the two halves of the replacement rule: nothing is dropped, and
    the only whitespace change is that wrapped lines are re-joined while
    paragraph breaks survive.
    """

    @classmethod
    def setUpClass(cls):
        cls.root = tree("desc", DESC_TREE)
        cls.data = GEN.build(cls.root)
        cls.long = find(cls.data, "TEAMS", "t-long")

    def test_3_1_3_a_long_description_survives_at_full_length(self):
        self.assertEqual(self.long["desc"], EXPECTED_LONG)
        self.assertEqual(len(self.long["desc"]), len(EXPECTED_LONG))
        self.assertGreater(len(self.long["desc"]), 300)

    def test_3_1_3_paragraph_breaks_are_preserved(self):
        self.assertEqual(self.long["desc"].count("\n\n"), 2)
        self.assertEqual(
            self.long["desc"].split("\n\n"),
            [" ".join(lines) for lines in LONG_PARAS])

    def test_3_1_3_two_blank_lines_still_make_exactly_one_break(self):
        # The fixture separates its last paragraph by two blank lines. A
        # paragraph break is a break however many blank lines the curator left.
        self.assertNotIn("\n\n\n", self.long["desc"])

    def test_3_1_3_wrapped_lines_are_rejoined(self):
        # Every newline must be part of a paragraph break: a lone \n means a
        # wrapped line reached the page as a hard break.
        self.assertIsNone(re.search(r"(?<!\n)\n(?!\n)", self.long["desc"]))
        for para in self.long["desc"].split("\n\n"):
            self.assertNotIn("\n", para)
            self.assertNotIn("  ", para)

    def test_3_1_3_every_source_word_survives_in_order(self):
        source_words = [w for para in LONG_PARAS for line in para for w in line.split()]
        self.assertEqual(self.long["desc"].replace("\n\n", " ").split(), source_words)

    def test_3_1_3_no_word_is_cut_at_the_old_300_character_cap(self):
        desc = find(self.data, "TEAMS", "t-straddle")["desc"]
        self.assertEqual(desc, STRADDLE_TEXT)
        self.assertEqual(len(desc), 326)
        self.assertIn(STRADDLE_WORD, desc)          # not "incon"
        self.assertTrue(desc.endswith(" end."))

    def test_3_1_3_a_301_character_description_keeps_its_301st_character(self):
        desc = find(self.data, "TEAMS", "t-boundary")["desc"]
        self.assertEqual(len(desc), 301)
        self.assertEqual(desc, BOUNDARY_TEXT)
        self.assertEqual(desc[300], "y")

    def test_3_1_3_a_blank_line_with_whitespace_on_it_is_still_a_break(self):
        # Why this needs its own fixture: the gaps `literal_block` writes are
        # genuinely empty lines, so every other test here would pass a
        # generator that split on `\n\n` alone. t-gap separates its paragraphs
        # with an over-indented blank line and with a tab, which is what an
        # editor actually leaves behind — and splitting on `\n\n` welds those
        # paragraphs into one, losing the break without losing a character, so
        # no length or word-level assertion would notice.
        self.assertEqual(
            find(self.data, "TEAMS", "t-gap")["desc"],
            "First paragraph, wrapped across two lines.\n\n"
            "Second paragraph.\n\nThird paragraph.")

    def test_3_1_3_norm_text_splits_on_a_whitespace_only_line(self):
        # The same rule at the unit level, with nothing adjacent to hide it: a
        # single whitespace-bearing line between two paragraphs, which only
        # `\n\s*\n` recognises.
        for gap in ("   ", "\t", " \t ", " "):
            with self.subTest(gap=repr(gap)):
                self.assertEqual(GEN.norm_text(f"First.\n{gap}\nSecond."),
                                 "First.\n\nSecond.")

    def test_3_1_3_indented_continuation_lines_join_with_one_space(self):
        self.assertEqual(
            find(self.data, "TEAMS", "t-wrap")["desc"],
            "A sentence that the curator wrapped and then indented further than "
            "the block itself.")

    def test_3_1_3_translated_descriptions_are_preserved_too(self):
        # descriptions.<lang>.yml is where the 39 cut French descriptions lived;
        # load_descriptions() runs the same normaliser over them.
        self.assertEqual(self.long["desc_en"], EXPECTED_EN)
        self.assertEqual(self.long["desc_fr"], EXPECTED_FR)
        self.assertGreater(len(EXPECTED_EN), 300)
        self.assertGreater(len(EXPECTED_FR), 300)
        self.assertEqual(self.long["desc_fr"].count("\n\n"), 1)

    def test_3_3_translated_descriptions_are_keyed_by_id_and_ordered_fr_then_en(self):
        # LANGS = ("fr", "en"), and key order is part of the byte-stable output.
        keys = [k for k in self.long if k.startswith("desc_")]
        self.assertEqual(keys, ["desc_fr", "desc_en"])
        # An id with no entry in either file gets neither key.
        for key in ("desc_en", "desc_fr"):
            self.assertNotIn(key, find(self.data, "TEAMS", "t-straddle"))

    def test_3_3_an_empty_translation_is_not_a_translation(self):
        # `t-none: ''` in descriptions.en.yml must not add an empty desc_en.
        self.assertNotIn("desc_en", find(self.data, "TEAMS", "t-none"))

    def test_3_3_a_whitespace_only_description_yields_no_desc_key(self):
        self.assertNotIn("desc", find(self.data, "TEAMS", "t-blank"))
        self.assertNotIn("desc", find(self.data, "TEAMS", "t-none"))

    def test_3_1_3_norm_text_changes_whitespace_and_nothing_else(self):
        raw = "  First line\n  continues here\n\n\n  Second\tpara wrapped  \n\n   \n\nThird.  "
        self.assertEqual(
            GEN.norm_text(raw),
            "First line continues here\n\nSecond para wrapped\n\nThird.")
        self.assertEqual(GEN.norm_text(None), "")
        self.assertEqual(GEN.norm_text("   \n\n  "), "")

    def test_3_1_3_the_rendered_payload_carries_the_whole_description(self):
        # Truncation could also creep in at emission time; parse the emitted
        # line back and compare against the same expectation.
        out = emit(self.data)
        teams = {e["id"]: e for e in parsed_array(out, "TEAMS")}
        self.assertEqual(teams["t-long"]["desc"], EXPECTED_LONG)
        self.assertEqual(teams["t-long"]["desc_fr"], EXPECTED_FR)
        # ensure_ascii=False: accents stay legible in the diff rather than
        # becoming é escapes.
        self.assertIn("l'opérateur", out)
        self.assertNotIn("\\u00e9", out)


class DescriptionsInTheCommittedPayload(unittest.TestCase):
    """§3.1 point 3 / invariant 7, against the real 449-entity corpus."""

    @classmethod
    def setUpClass(cls):
        cls.payload = load_payload()

    def descriptions(self, field: str) -> list[str]:
        return [e[field] for layer in LAYERS for e in self.payload[layer] if e.get(field)]

    def test_3_1_3_the_longest_committed_description_is_well_past_the_old_cap(self):
        # `> 300` was the whole assertion, and a cap of 310 satisfies it: the
        # test said "not truncated at exactly the old constant" where the claim
        # is "not truncated". The floor belongs where the real corpus is —
        # 1 180 characters in English, 1 260 in French — so a cap reinstated at
        # any value below it fails here instead of passing by one character.
        longest = max(len(d) for f in DESC_FIELDS for d in self.descriptions(f))
        self.assertGreater(longest, 900)
        # …and the long tail is a population, not one survivor: 256 of the
        # 1 339 committed descriptions run past 600 characters today.
        self.assertGreaterEqual(
            sum(1 for f in DESC_FIELDS for d in self.descriptions(f) if len(d) > 600),
            100)

    def test_3_1_3_no_description_length_is_shared_by_a_crowd(self):
        # The general form of "no cap, at any value". Prose lengths scatter:
        # among the 462 committed descriptions past 280 characters, the most
        # crowded single length holds 7 of them. A cap — 300, 310, 1 000 —
        # stacks everything it touched on exactly one length, so this catches a
        # reinstated cap without the test having to guess its constant.
        lengths = Counter(len(d) for f in DESC_FIELDS for d in self.descriptions(f)
                          if len(d) > 280)
        length, crowd = lengths.most_common(1)[0]
        self.assertLess(crowd, 25,
                        f"{crowd} descriptions are exactly {length} characters long")

    def test_3_1_3_at_least_the_descriptions_the_cap_cut_are_still_over_300(self):
        # The spec names the damage: 29 English and 39 French descriptions cut
        # mid-word. Those are exactly the ones longer than the cap, so the
        # corpus must still hold at least that many of each.
        self.assertGreaterEqual(sum(1 for d in self.descriptions("desc_en") if len(d) > 300), 29)
        self.assertGreaterEqual(sum(1 for d in self.descriptions("desc_fr") if len(d) > 300), 39)

    def test_3_1_3_no_committed_description_stops_exactly_at_300_characters(self):
        # A reinstated cap would leave a telltale pile of exactly-300-character
        # strings; today there is not one.
        at_cap = [(e["id"], f) for layer in LAYERS for e in self.payload[layer]
                  for f in DESC_FIELDS if len(e.get(f) or "") == 300]
        self.assertEqual(at_cap, [])

    def test_3_1_3_no_committed_description_ends_in_an_ellipsis(self):
        cut = [(e["id"], f) for layer in LAYERS for e in self.payload[layer]
               for f in DESC_FIELDS if (e.get(f) or "").rstrip().endswith(("…", "..."))]
        self.assertEqual(cut, [])

    def test_3_1_3_every_committed_description_is_already_normalised(self):
        # norm_text is idempotent, so a description that differs from its own
        # normalisation means the committed file was not produced by this rule:
        # a stray hard break, a double space, or padding survived.
        offenders = [(e["id"], f) for layer in LAYERS for e in self.payload[layer]
                     for f in DESC_FIELDS
                     if (e.get(f) or "") != GEN.norm_text(e.get(f) or "")]
        self.assertEqual(offenders, [])

    def test_3_1_3_no_committed_description_carries_a_lone_newline(self):
        stray = [(e["id"], f) for layer in LAYERS for e in self.payload[layer]
                 for f in DESC_FIELDS
                 if re.search(r"(?<!\n)\n(?!\n)", e.get(f) or "")]
        self.assertEqual(stray, [])


# --- §3.1.4 fixture: entities without coordinates ---------------------------

GEO_TREE = {
    "data/teams/t-nowhere.yml": (
        "id: t-nowhere\n"
        "name: International Standards Body\n"
        "type: network\n"
        "location: {city: Geneva, country: CH}\n"
        "description: No coordinates on record.\n"
    ),
    "data/teams/t-half.yml": (
        "id: t-half\n"
        "name: Half A Coordinate\n"
        "location: {city: Rome, country: IT, lat: 41.9}\n"
    ),
    "data/teams/t-zero.yml": (
        "id: t-zero\n"
        "name: Null Island Lab\n"
        "location: {city: Nowhere, country: XX, lat: 0, lon: 0}\n"
    ),
    "data/projects/p-nowhere.yml": (
        "id: p-nowhere\n"
        "name: Placeless Programme\n"
        "kind: other\n"
        "consortium:\n"
        "  - {org: A Body, role: member, initiative_id: t-nowhere}\n"
    ),
    "data/frameworks/f-nowhere.yml": (
        "id: f-nowhere\n"
        "name: ISO 9241-210\n"
        "jurisdiction: international\n"
    ),
    "data/commons/c-nowhere.yml": (
        "id: c-nowhere\n"
        "name: Overseas Benchmark\n"
        "kind: benchmark\n"
        "related_initiative_ids: [t-nowhere]\n"
        "related_project_ids: [p-nowhere]\n"
    ),
    "data/edges.yml": "- {project: p-nowhere, team: t-nowhere}\n",
}


class EntitiesWithoutCoordinates(unittest.TestCase):
    """§3.1 point 4 / §3.3 `geo` / invariant 3.

    An entity with no lat/lon is kept and flagged, never dropped: international
    standards (ISO, IEC, IEEE, SAE) have no address, and dropping them would
    delete the frameworks half of the map. The page draws no marker for them and
    counts them under "off the map" instead.
    """

    @classmethod
    def setUpClass(cls):
        cls.data = GEN.build(tree("geo", GEO_TREE))

    def test_3_1_4_a_geoless_entity_is_kept_in_every_layer(self):
        self.assertEqual([e["id"] for e in self.data["PROJECTS"]], ["p-nowhere"])
        self.assertEqual([e["id"] for e in self.data["COMMONS"]], ["c-nowhere"])
        self.assertEqual([e["id"] for e in self.data["FRAMEWORKS"]], ["f-nowhere"])
        self.assertEqual(
            [e["id"] for e in self.data["TEAMS"]], ["t-half", "t-nowhere", "t-zero"])

    def test_3_1_4_a_geoless_entity_is_flagged_geo_false(self):
        for layer, eid in (("TEAMS", "t-nowhere"), ("PROJECTS", "p-nowhere"),
                           ("COMMONS", "c-nowhere"), ("FRAMEWORKS", "f-nowhere")):
            with self.subTest(layer=layer):
                # `is False`, not falsy: the page tests `!it.geo`, and a 0 or an
                # empty string would read the same there but not in a diff.
                self.assertIs(find(self.data, layer, eid)["geo"], False)

    def test_3_1_4_a_geoless_entity_carries_no_lat_or_lon_key(self):
        e = find(self.data, "TEAMS", "t-nowhere")
        self.assertNotIn("lat", e)
        self.assertNotIn("lon", e)
        # …and keeps everything a card, a search result and a feed row need.
        self.assertEqual(e["name"], "International Standards Body")
        self.assertEqual((e["city"], e["country"]), ("Geneva", "CH"))
        self.assertEqual(e["desc"], "No coordinates on record.")

    def test_3_3_an_entity_with_coordinates_has_no_geo_key_at_all(self):
        # §3.3 lists `geo` as present "only when false".
        e = find(self.data, "TEAMS", "t-zero")
        self.assertNotIn("geo", e)
        flagged = [x["id"] for layer in LAYERS for x in self.data[layer] if "geo" in x]
        self.assertEqual(sorted(flagged),
                         ["c-nowhere", "f-nowhere", "p-nowhere", "t-half", "t-nowhere"])

    def test_3_1_4_zero_zero_is_a_real_coordinate(self):
        # `lat is None`, not `if not lat`: 0°N 0°E is in the Gulf of Guinea, but
        # it is a coordinate, and a truthiness check would have hidden the pin.
        e = find(self.data, "TEAMS", "t-zero")
        self.assertEqual((e["lat"], e["lon"]), (0, 0))

    def test_3_1_4_half_a_coordinate_is_no_coordinate(self):
        # A latitude with no longitude cannot be projected, so the entity is
        # flagged like any other geoless one; the half that exists is kept
        # rather than being silently blanked.
        e = find(self.data, "TEAMS", "t-half")
        self.assertIs(e["geo"], False)
        self.assertEqual(e["lat"], 41.9)
        self.assertNotIn("lon", e)

    def test_invariant_3_a_geoless_entity_keeps_its_graph_edges(self):
        # Adjacency and geometry are separate: the generator records the link
        # even when one end can never be drawn (§4.3).
        self.assertEqual(self.data["EDGES"], [{"project": "p-nowhere", "team": "t-nowhere"}])

    def test_invariant_3_a_geoless_entity_still_resolves_as_a_reference(self):
        commons = find(self.data, "COMMONS", "c-nowhere")
        self.assertEqual(commons["createdBy"], ["t-nowhere"])
        self.assertEqual(commons["usedBy"], ["p-nowhere"])
        project = find(self.data, "PROJECTS", "p-nowhere")
        self.assertEqual(project["consortium"], [
            {"org": "A Body", "role": "member", "ref": "t-nowhere"}])

    def test_3_1_4_nothing_is_dropped_from_any_layer(self):
        # Six YAML entities in, six entities out — the claim is "kept", so the
        # count is the assertion.
        self.assertEqual(sum(len(self.data[layer]) for layer in LAYERS), 6)

    def test_3_1_4_the_flag_reaches_the_rendered_payload_as_json_false(self):
        teams = {e["id"]: e for e in parsed_array(emit(self.data), "TEAMS")}
        self.assertIs(teams["t-nowhere"]["geo"], False)
        self.assertNotIn("geo", teams["t-zero"])


class GeolessEntitiesInTheCommittedPayload(unittest.TestCase):
    """§3.1 point 4, against the committed payload."""

    @classmethod
    def setUpClass(cls):
        cls.payload = load_payload()
        cls.geoless = [e for layer in LAYERS for e in cls.payload[layer]
                       if e.get("geo") is False]

    def test_3_1_4_the_corpus_still_carries_geoless_entities(self):
        # `> 0` survives dropping ten of the eleven: the one non-European
        # commons alone would keep it green while every international standard
        # vanished — which is precisely the regression §3.1.4 exists to
        # prevent, since "dropping them would delete the frameworks half of the
        # map". So the four families the spec names are asserted by name, and
        # the layer that would have been emptied is counted separately.
        self.assertGreaterEqual(len(self.geoless), 8)
        ids = [e["id"] for e in self.geoless]
        for family in ("iso-", "iec-", "ieee-", "sae-"):
            with self.subTest(family=family):
                self.assertTrue([i for i in ids if i.startswith(family)],
                                f"no geoless entity from {family}: {ids}")
        self.assertGreaterEqual(
            sum(1 for e in self.payload["FRAMEWORKS"] if e.get("geo") is False), 8)

    def test_3_1_4_no_geoless_entity_kept_a_stale_coordinate(self):
        for e in self.geoless:
            with self.subTest(id=e["id"]):
                self.assertNotIn("lat", e)
                self.assertNotIn("lon", e)
                self.assertNotEqual(e["name"], "")

    def test_3_3_no_committed_entity_carries_geo_true(self):
        flagged = [e["id"] for layer in LAYERS for e in self.payload[layer]
                   if "geo" in e and e["geo"] is not False]
        self.assertEqual(flagged, [])

    def test_3_1_4_every_geoless_entity_is_still_addressable(self):
        # Kept means usable: an id the page can open, and a card worth opening.
        # `assertTrue(e["id"])` and `assertTrue(e["domains"])` used to stand
        # here and neither could ever come out false — load_layer only accepts
        # a file that has an id, and domain_list always falls back to
        # ["multi"]. The assertions below can: the id has to survive a round
        # trip through the URL (§13 deep-links by id), and an entity with no
        # marker has nothing but its card, so the card needs a name, a lead
        # domain that is one of its own, and prose.
        ids = [e["id"] for e in self.geoless]
        self.assertEqual(len(ids), len(set(ids)))
        for e in self.geoless:
            with self.subTest(id=e["id"]):
                self.assertRegex(e["id"], r"^[a-z0-9][a-z0-9._-]*$")
                self.assertTrue(e["name"].strip())
                self.assertIn(e["domain"], e["domains"])
                self.assertTrue((e.get("desc") or e.get("desc_en") or "").strip())


# --- invariant 1 fixture: determinism ---------------------------------------

STABLE_TREE = {
    # Written in an order that matches neither the filename order nor the id
    # order, so "sorted by filename" is the only rule that produces the
    # expected output sequence.
    "data/teams/z-first.yml": (
        "id: a-one\n"
        "name: Alpha Lab\n"
        "type: research_lab\n"
        "location: {city: Turku, country: FI, lat: 60.45, lon: 22.27}\n"
        "domains: [energy]\n"
        "framework_ids: [f-shared]\n"
        "provenance: {added_on: 2026-01-10, last_updated: 2026-02-10}\n"
    ),
    "data/teams/a-second.yml": (
        "id: z-two\n"
        "name: Zeta Lab\n"
        "type: industrial_rd\n"
        "location: {city: Porto, country: PT, lat: 41.15, lon: -8.61}\n"
        "framework_ids: [f-shared]\n"
        "provenance: {added_on: 2026-01-11}\n"
    ),
    "data/teams/_template.yml": (
        "id: t-template\n"
        "name: TEMPLATE — copy me\n"
    ),
    "data/teams/no-id.yml": "name: Nameless, idless\n",
    "data/teams/a-list.yml": "- not a mapping\n",
    "data/frameworks/f-shared.yml": (
        "id: f-shared\n"
        "name: Shared Guideline\n"
        "kind: guideline\n"
        "jurisdiction: EU\n"
        "provenance: {last_updated: 2026-02-11}\n"
    ),
    "data/edges.yml": "[]\n",
}

# Ten teams declaring one framework and one commons, so both reverse indexes
# are built from a ten-element set.
#
# `used_by` is a dict of sets, and CPython randomises string hashing per
# process: a two-element set comes out in sorted order for roughly half of the
# possible hash seeds. A fixture with two declaring ids therefore notices a
# dropped `sorted()` on about half the machines that run it — green on the
# developer's laptop, red in CI, or the other way round, which reads as
# flakiness rather than as the regression it is. Ten ids make the coincidence
# one in 10! instead of one in two.
SORTED_IDS = ("mu", "kappa", "alpha", "omega", "delta",
              "sigma", "beta", "tau", "iota", "rho")
SORTED_TREE = {
    f"data/teams/{name}.yml": (
        f"id: {name}\n"
        f"name: {name.title()} Lab\n"
        "framework_ids: [f-shared]\n"
        "commons_ids: [c-shared]\n"
    )
    for name in SORTED_IDS
}
SORTED_TREE["data/frameworks/f-shared.yml"] = (
    "id: f-shared\n"
    "name: Shared Guideline\n"
)
SORTED_TREE["data/commons/c-shared.yml"] = (
    "id: c-shared\n"
    "name: Shared Benchmark\n"
)


class Determinism(unittest.TestCase):
    """Invariant 1 — regenerating without a source change produces an empty diff.

    Everything the generator emits has to be a pure function of the YAML tree:
    no wall-clock stamp, no absolute path from whoever ran it, no set iteration
    order leaking into a list, no filesystem order deciding which entity comes
    first. A single unstable byte turns every regeneration into a diff nobody
    can review, which is how a real data change gets lost in the noise.
    """

    @classmethod
    def setUpClass(cls):
        cls.root = tree("stable", STABLE_TREE)

    def test_invariant_1_rendering_twice_is_byte_identical(self):
        first = emit(GEN.build(self.root))
        second = emit(GEN.build(self.root))
        self.assertEqual(first, second)
        self.assertEqual(len(first), len(second))

    def test_invariant_1_key_order_is_identical_across_runs(self):
        # Equal dicts are not enough: JSON is emitted in insertion order, so
        # two runs that agree on values but not on order still diff.
        first = json.dumps(GEN.build(self.root), ensure_ascii=False, sort_keys=False)
        second = json.dumps(GEN.build(self.root), ensure_ascii=False, sort_keys=False)
        self.assertEqual(first, second)

    def test_invariant_1_entity_order_follows_the_filename_not_the_filesystem(self):
        # z-first.yml holds id "a-one" and a-second.yml holds "z-two", and the
        # files were written in the other order again — so filename order is
        # distinguishable from both id order and creation order.
        data = GEN.build(self.root)
        self.assertEqual([e["id"] for e in data["TEAMS"]], ["z-two", "a-one"])

    def test_3_3_underscore_prefixed_files_are_templates_not_entities(self):
        data = GEN.build(self.root)
        ids = [e["id"] for e in data["TEAMS"]]
        self.assertNotIn("t-template", ids)
        # A file with no id, and a file that is not a mapping at all, are
        # skipped rather than crashing the build.
        self.assertEqual(len(ids), 2)

    def test_invariant_1_set_derived_used_by_is_sorted(self):
        # `used_by` is a dict of sets, so only the sort makes the emitted list
        # reproducible. Both teams declare the framework; sorted order is
        # "a-one", "z-two" whatever the set iteration order was.
        fw = find(GEN.build(self.root), "FRAMEWORKS", "f-shared")
        self.assertEqual(fw["usedBy"], ["a-one", "z-two"])
        self.assertEqual(fw["usedBy"], sorted(fw["usedBy"]))

    def test_invariant_1_a_set_derived_list_is_sorted_and_not_hash_ordered(self):
        # The sharp version of the test above, and the reason SORTED_TREE
        # exists: with only two declaring ids, hash order agrees with sorted
        # order for about half of CPython's per-process hash seeds, so dropping
        # the `sorted()` call stays invisible on half the runs. Ten ids make
        # "it happened to come out sorted" a one-in-10! coincidence, and the
        # expectation is spelled out rather than compared against
        # `sorted(result)`, which any order would satisfy.
        data = GEN.build(tree("sorted", SORTED_TREE))
        expected = ["alpha", "beta", "delta", "iota", "kappa",
                    "mu", "omega", "rho", "sigma", "tau"]
        # Both reverse indexes are derived from the same set of sets: the
        # framework's whole list, and the half of a commons' list that is
        # derived rather than declared.
        self.assertEqual(find(data, "FRAMEWORKS", "f-shared")["usedBy"], expected)
        self.assertEqual(find(data, "COMMONS", "c-shared")["usedBy"], expected)

    def test_invariant_1_the_source_path_never_reaches_the_output(self):
        # render() takes the source path but must not print it: otherwise the
        # file would differ between two checkouts of the same data.
        data = GEN.build(self.root)
        out = emit(data, Path("/home/alice/eu-hai-collab-map"))
        self.assertEqual(out, emit(data, Path("/opt/bob/clone")))
        self.assertNotIn("alice", out)
        self.assertNotIn(str(self.root), out)

    def test_invariant_1_no_wall_clock_stamp_reaches_the_output(self):
        out = emit(GEN.build(self.root))
        today = date.today()
        self.assertNotIn(today.isoformat(), out)
        self.assertNotIn(f"{today:%Y-%m}", out)
        for word in ("Generated on", "generated at", "Built on"):
            self.assertNotIn(word, out)

    def test_invariant_1_the_generator_cannot_read_the_clock(self):
        # The spec spells out why (§10): deriving the freshness date from
        # date.today() would put a changing timestamp in a generated file and
        # break this invariant outright. The structural version of that promise
        # is that the generator imports no clock at all — and the file's single
        # mention of date.today() is the comment explaining the choice.
        src = GENERATOR.read_text(encoding="utf-8")
        self.assertIsNone(
            re.search(r"^\s*(?:import|from)\s+(?:datetime|time|calendar)\b", src, re.M))
        self.assertEqual(src.count("date.today"), 1)
        self.assertIn("`date.today()` here would put a changing timestamp", src)

    def test_invariant_1_the_output_shape_is_fixed(self):
        out = emit(GEN.build(self.root))
        lines = out.splitlines()
        self.assertEqual(lines[0], "// GENERATED FILE — do not edit by hand.")
        self.assertEqual(len([l for l in lines[:6] if l.startswith("//")]), 5)
        self.assertEqual(
            [m for m in re.findall(r"^const (\w+) = ", out, re.M)],
            ["PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS", "EDGES", "TAXO", "AS_OF"])
        self.assertTrue(out.endswith(
            "window.HAI_DATA = { PROJECTS, CLUSTERS, COMMONS, TEAMS, FRAMEWORKS, EDGES, TAXO, AS_OF };\n"))

    def test_invariant_1_one_entity_per_line_keeps_diffs_readable(self):
        # A changed entity should be a one-line diff. js_array indents by two
        # and appends a comma per entity, so the line count equals the entity
        # count for every layer.
        data = GEN.build(self.root)
        out = emit(data)
        for name in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS", "EDGES"):
            with self.subTest(layer=name):
                block = out.split(f"const {name} = [\n", 1)[1].split("\n];", 1)[0]
                rows = [l for l in block.splitlines() if l.strip()]
                self.assertEqual(len(rows), len(data[name]))
                for row in rows:
                    self.assertTrue(row.startswith("  {"))
                    self.assertTrue(row.endswith("},"))

    def test_invariant_1_the_rendered_output_round_trips_to_the_same_objects(self):
        data = GEN.build(self.root)
        out = emit(data)
        for name in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS", "EDGES"):
            with self.subTest(layer=name):
                self.assertEqual(parsed_array(out, name), data[name])

    def test_invariant_1_the_taxo_block_is_stable_and_ordered(self):
        first, second = emit(GEN.build(self.root)), emit(GEN.build(self.root))
        block = first.split("const TAXO = ", 1)[1].split(";\n\n", 1)[0]
        self.assertEqual(block, second.split("const TAXO = ", 1)[1].split(";\n\n", 1)[0])
        taxo = json.loads(block)
        # Declaration order, not sorted order — and spelled out rather than
        # read back from `GEN.TAXO`, which is the table that produced the
        # block: comparing the output against its own source agreed with any
        # reordering of it. This is the order §3.4 lists the groups in.
        self.assertEqual(list(taxo), [
            "focus", "type", "kind", "status", "tier",
            "access", "legal", "role", "jurisdiction", "confidence"])
        self.assertEqual(sorted(taxo["status"]["active"]), ["en", "fr"])

    def test_invariant_1_the_committed_payload_is_what_the_generator_emits(self):
        # The strong form of the invariant, on the real artifact: re-render the
        # committed payload with the committed generator and compare bytes. A
        # mismatch means hai-data.js and build-map-data.py have drifted — that
        # someone hand-edited the generated file, or regenerated it with a
        # different version of the script — and the next honest regeneration
        # would produce a diff nobody asked for.
        payload = load_payload()
        data = {k: payload[k] for k in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS", "EDGES")}
        self.assertEqual(emit(data), DATA_JS.read_text(encoding="utf-8"))


# --- §3.5 fixtures: freshness ------------------------------------------------

def asof_tree(name: str, *, team_upd: str = "2026-04-05", fw_upd: str = "2026-02-02",
              desc: str = "Original wording.") -> Path:
    """A tree whose most recent provenance touch is the team's `last_updated`.

    The max deliberately sits in TEAMS, which `data_as_of()` scans third of
    four, so a "last layer wins" bug cannot pass. The project is funded through
    2032 to prove the timeline is not consulted.
    """
    return tree(name, {
        "data/teams/t-fresh.yml": (
            "id: t-fresh\n"
            "name: Fresh Lab\n"
            "type: research_lab\n"
            "location: {city: Aachen, country: DE, lat: 50.78, lon: 6.08}\n"
            f"description: {desc}\n"
            "provenance:\n"
            "  added_by: curator\n"
            "  added_on: 2025-01-01\n"
            f"  last_updated: {team_upd}\n"
        ),
        "data/projects/p-future.yml": (
            "id: p-future\n"
            "name: Long Grant\n"
            "kind: horizon_europe\n"
            "location: {city: Madrid, country: ES, lat: 40.42, lon: -3.7}\n"
            "timeline: {start: 2024, end: 2032}\n"
            "provenance: {added_on: 2026-01-03}\n"
        ),
        "data/frameworks/f-old.yml": (
            "id: f-old\n"
            "name: Older Guideline\n"
            f"provenance: {{last_updated: {fw_upd}}}\n"
        ),
        "data/commons/c-added.yml": (
            "id: c-added\n"
            "name: Added Only\n"
            "kind: dataset\n"
            "provenance: {added_on: 2026-03-09}\n"
        ),
    })


class Freshness(unittest.TestCase):
    """§3.5 — `AS_OF` is the data's own notion of "now".

    It is the most recent `provenance.last_updated` / `provenance.added_on`
    across every entity, and the page reads its year as the period slider's
    ceiling (§10). The spec is explicit about why it is not `date.today()`: a
    wall-clock date in a generated file breaks invariant 1, and the axis would
    creep forward on every rebuild whether or not anybody touched the data.
    """

    @classmethod
    def setUpClass(cls):
        cls.data = GEN.build(asof_tree("asof"))

    def test_3_5_as_of_is_the_most_recent_provenance_touch(self):
        self.assertEqual(GEN.data_as_of(self.data), "2026-04-05")

    def test_3_5_as_of_reads_added_on_when_last_updated_is_missing(self):
        # c-added has only added_on; make it the winner and watch it win.
        data = GEN.build(asof_tree("asof_added_on", team_upd="2026-01-02"))
        self.assertEqual(GEN.data_as_of(data), "2026-03-09")

    def test_3_5_as_of_ignores_the_timeline(self):
        # §10: the axis stops at "now", not at the furthest funded end date.
        # p-future runs to 2032; AS_OF must not notice.
        self.assertEqual(find(self.data, "PROJECTS", "p-future")["timeline"]["end"], "2032")
        self.assertEqual(GEN.data_as_of(self.data), "2026-04-05")
        self.assertNotIn("2032", GEN.data_as_of(self.data))

    def test_3_5_as_of_is_not_the_wall_clock(self):
        as_of = GEN.data_as_of(self.data)
        self.assertNotEqual(as_of, date.today().isoformat())
        self.assertRegex(as_of, r"^\d{4}-\d{2}-\d{2}$")

    def test_invariant_1_as_of_is_identical_across_two_runs(self):
        root = asof_tree("asof_twice")
        self.assertEqual(GEN.data_as_of(GEN.build(root)), GEN.data_as_of(GEN.build(root)))

    def test_3_5_as_of_moves_when_a_provenance_date_moves(self):
        before = GEN.data_as_of(GEN.build(asof_tree("asof_bump")))
        after = GEN.data_as_of(GEN.build(asof_tree("asof_bump", team_upd="2026-06-30")))
        self.assertEqual((before, after), ("2026-04-05", "2026-06-30"))

    def test_3_5_as_of_moves_when_the_new_max_is_in_another_layer(self):
        data = GEN.build(asof_tree("asof_layer", team_upd="2026-01-01", fw_upd="2026-05-05"))
        self.assertEqual(GEN.data_as_of(data), "2026-05-05")

    def test_3_5_as_of_does_not_move_when_only_a_description_changes(self):
        # The other half of "only moves when provenance does": editing prose
        # must leave the freshness date, and therefore the period ceiling,
        # exactly where it was.
        first = emit(GEN.build(asof_tree("asof_reword")))
        second = emit(GEN.build(asof_tree("asof_reword", desc="Rewritten wording entirely.")))
        self.assertNotEqual(first, second)
        self.assertEqual(
            re.search(r"^const AS_OF = (.*);$", first, re.M).group(1),
            re.search(r"^const AS_OF = (.*);$", second, re.M).group(1))
        # …and the diff is confined to the one entity that changed.
        changed = [(a, b) for a, b in zip(first.splitlines(), second.splitlines()) if a != b]
        self.assertEqual(len(changed), 1)

    def test_3_5_as_of_is_empty_when_no_entity_has_provenance(self):
        data = GEN.build(tree("asof_empty", {
            "data/teams/t-bare.yml": "id: t-bare\nname: Bare Lab\n",
        }))
        self.assertEqual(GEN.data_as_of(data), "")
        self.assertIn('const AS_OF = "";', emit(data))

    def test_3_5_as_of_survives_unquoted_yaml_dates(self):
        # An unquoted 2026-04-05 in YAML parses as a datetime.date, not a
        # string; prov_of() stringifies it, so AS_OF stays comparable and the
        # payload stays JSON-serialisable.
        e = find(self.data, "TEAMS", "t-fresh")
        self.assertEqual(e["prov"]["upd"], "2026-04-05")
        self.assertIsInstance(e["prov"]["upd"], str)
        self.assertIn('"upd": "2026-04-05"', emit(self.data))

    def test_3_5_as_of_is_rendered_as_a_json_string(self):
        self.assertIn('const AS_OF = "2026-04-05";', emit(self.data))

    def test_3_5_the_committed_as_of_is_the_payloads_own_maximum(self):
        # Derived from the parsed payload rather than from data_as_of(), so the
        # test cannot agree with the code by running it.
        payload = load_payload()
        dates = payload_prov_dates(payload)
        self.assertGreater(len(dates), 0)
        self.assertRegex(payload["AS_OF"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(payload["AS_OF"], max(dates))

    def test_3_5_the_committed_as_of_belongs_to_a_real_entity(self):
        # Not a synthesised or rounded date: some entity on the map was
        # actually touched on the day the page reports as its freshness.
        payload = load_payload()
        owners = [e["id"] for layer in LAYERS for e in payload[layer]
                  if payload["AS_OF"] in (e.get("prov", {}).get("upd"),
                                          e.get("prov", {}).get("on"))]
        self.assertGreater(len(owners), 0)

    def test_3_5_the_period_ceiling_on_the_page_is_derived_from_as_of(self):
        # §3.5 calls AS_OF "the only data-derived (not wall-clock) notion of
        # 'now' the page has". So the period-bounds block must read AS_OF and
        # nothing from the clock — YMAX used to be Math.max(...YEARS), which
        # stretched the axis a decade past the present.
        script = map_script()
        bounds = script.split("const YEARS", 1)[1].split("const UNDATED", 1)[0]
        self.assertIn("const AS_OF_YEAR = DATA.AS_OF", bounds)
        self.assertIn("AS_OF_YEAR ||", bounds)
        self.assertIn("startYears", bounds)          # clamped to the latest start
        for clock in ("Date.now(", "new Date()", "getFullYear"):
            with self.subTest(call=clock):
                self.assertNotIn(clock, bounds)


# --- §3.3 fixture: the entity shape -----------------------------------------

FIELDS_TREE = {
    "data/teams/a-lab.yml": (
        "id: a-lab\n"
        "name: '  Human Factors Lab  '\n"
        "type: research_lab\n"
        "location: {city: Delft, country: NL, lat: 52.0, lon: 4.36}\n"
        "domains: [aviation, power_grid]\n"
        "focus_areas: [explainability, cobots]\n"
        "status: active\n"
        "tier: core\n"
        "homepage: https://example.org/a-lab\n"
        "affiliation: {org: TU Delft, parent: 4TU, url: https://tudelft.example}\n"
        "infrastructure: [Simulator hall]\n"
        "timeline:\n"
        "  start: 1998\n"
        "  end: 2026\n"
        "  milestones:\n"
        "    - {date: 2019, label: '  First trial  '}\n"
        "    - {date: 2020}\n"
        "links:\n"
        "  papers: ['https://doi.example/1', null, '']\n"
        "  linkedin: https://linkedin.example/a-lab\n"
        "  official_text: https://example.org/text\n"
        "provenance:\n"
        "  added_by: curator\n"
        "  added_on: 2026-01-05\n"
        "  last_updated: 2026-02-06\n"
        "  source: \"timeline.start (medium): TU Delft founded 1842; the lab's own date not found\"\n"
        "  confidence: medium\n"
        "description: One line.\n"
    ),
    "data/teams/b-lab.yml": (
        "id: b-lab\n"
        "name: B Lab\n"
        "type: industrial_rd\n"
        "location: {city: Berlin, country: DE, lat: 52.52, lon: 13.4}\n"
        "framework_ids: [f-guide]\n"
        "commons_ids: [c-bench]\n"
        "dateConf: authored-by-hand\n"
        "dateHost: true\n"
        "provenance: {added_by: curator, last_updated: 2026-02-01}\n"
    ),
    "data/infrastructure/a-lab.yml": (
        "id: a-lab\n"
        "name: Simulator hall\n"
        "kind: testbed\n"
        "description: The hall's own description.\n"
        "operator: {org: TU Delft, url: https://tudelft.example/sim}\n"
        "access_model: gated\n"
        "capacity_indicator: 12 seats\n"
        "related_initiative_ids: [b-lab]\n"
    ),
    "data/infrastructure/c-rig.yml": (
        "id: c-rig\n"
        "name: C Rig\n"
        "kind: compute_cluster\n"
        "location: {city: Espoo, country: FI, lat: 60.2, lon: 24.7}\n"
        "description: A cluster.\n"
        "access_model: open\n"
        "capacity_indicator: 4 PFLOPS\n"
        "related_initiative_ids: [a-lab, c-rig]\n"
        "provenance: {added_on: 2026-01-20}\n"
    ),
    "data/projects/p-full.yml": (
        "id: p-full\n"
        "name: Full Project\n"
        "kind: horizon_europe\n"
        "location: {city: Paris, country: FR, lat: 48.85, lon: 2.35}\n"
        "domains: [rail]\n"
        "timeline: {start: 2024, end: 2027}\n"
        "funding:\n"
        "  source: Horizon Europe\n"
        "  call: HORIZON-CL5-2023\n"
        "  grant: '101112131'\n"
        "  budget_eur: 4200000\n"
        "  url: https://cordis.example/1\n"
        "consortium:\n"
        "  - {org: Rail Co, role: coordinator, country: FR, initiative_id: a-lab}\n"
        "  - {org: Ghost SA, role: partner, country: DE, initiative_id: does-not-exist}\n"
        "  - {org: Standards Org, role: member, initiative_id: f-guide}\n"
        "  - {org: Bench Keeper, initiative_id: c-bench}\n"
        "  - {role: partner, country: IT}\n"
        "demonstrators:\n"
        "  - {label: Lyon pilot, url: https://example.org/lyon}\n"
        "  - {url: https://example.org/orphan}\n"
        "deliverables:\n"
        "  - {title: D1.1 Concept, url: https://example.org/d11, date: 2025-06-30}\n"
        "  - {url: https://example.org/untitled}\n"
        "framework_ids: [f-guide]\n"
        "commons_ids: [c-bench]\n"
        "provenance: {added_on: 2026-01-01}\n"
    ),
    "data/projects/p-bare.yml": (
        "id: p-bare\n"
        "name: Bare Project\n"
        "location: {city: Lisbon, country: PT, lat: 38.72, lon: -9.14}\n"
        "funding: {source: National programme}\n"
    ),
    "data/frameworks/f-guide.yml": (
        "id: f-guide\n"
        "name: Teaming Guideline\n"
        "jurisdiction: EU\n"
        "issuing_body: {org: CEN, url: https://cen.example}\n"
        "legal_status: in_force\n"
        "adoption_date: 2023-11-02\n"
        "applies_to: [aviation, rail]\n"
        "references: ['ISO 9241-210']\n"
        "provenance: {last_updated: 2026-02-02}\n"
    ),
    "data/commons/c-bench.yml": (
        "id: c-bench\n"
        "name: Grid Benchmark\n"
        "kind: benchmark\n"
        "location: {city: Paris, country: FR, lat: 48.86, lon: 2.34}\n"
        "license: CC-BY-4.0\n"
        "maintainer: {org: Grid Op, url: https://gridop.example}\n"
        "repository_url: https://github.example/bench\n"
        "size_indicator: 2 GB\n"
        "related_initiative_ids: [a-lab, f-guide, ghost]\n"
        "related_project_ids: [p-full]\n"
        "provenance: {added_on: 2026-03-03, last_updated: 2026-03-04}\n"
    ),
    "data/commons/c-plain.yml": (
        "id: c-plain\n"
        "name: Plain Commons\n"
    ),
    "data/edges.yml": (
        "- {project: p-full, team: a-lab}\n"
        "- {project: p-full, team: ghost}\n"
        "- {project: ghost, team: a-lab}\n"
        "- not-a-mapping\n"
    ),
}


class EntityShape(unittest.TestCase):
    """§3.3 — the fields every entity carries, and the ones it must not."""

    @classmethod
    def setUpClass(cls):
        cls.data = GEN.build(tree("fields", FIELDS_TREE))

    def test_3_3_the_common_field_order_is_the_documented_shape(self):
        # Key order is part of the byte-stable output, and it is the order §3.3
        # lists the fields in: identity, place, colour, text, status, provenance.
        self.assertEqual(list(find(self.data, "TEAMS", "a-lab")), [
            "id", "name", "city", "country", "lat", "lon", "domain", "domains",
            "url", "desc", "focus", "status", "tier", "prov",
            "timeline", "dateConf", "dateHost", "links",
            "type", "affiliation", "facilities", "infra",
        ])

    def test_3_3_the_common_fields_carry_the_authored_values(self):
        e = find(self.data, "TEAMS", "a-lab")
        self.assertEqual(e["id"], "a-lab")
        self.assertEqual(e["name"], "Human Factors Lab")     # clean() strips
        self.assertEqual((e["city"], e["country"]), ("Delft", "NL"))
        self.assertEqual((e["lat"], e["lon"]), (52.0, 4.36))
        self.assertEqual(e["url"], "https://example.org/a-lab")
        self.assertEqual(e["desc"], "One line.")
        self.assertEqual(e["focus"], ["explainability", "cobots"])
        self.assertEqual((e["status"], e["tier"]), ("active", "core"))

    def test_3_3_domain_leads_and_domains_drive_colour_and_filters(self):
        # domain is the lead (drives colour when single); domains is the pie and
        # the filter axis, sector codes first, then approach codes, deduped.
        e = find(self.data, "TEAMS", "a-lab")
        self.assertEqual(e["domain"], "aviation")
        self.assertEqual(e["domains"],
                         ["aviation", "energy", "xai", "manufacturing", "simulation"])

    def test_3_3_an_entity_with_no_domain_at_all_falls_back_to_multi(self):
        e = find(self.data, "COMMONS", "c-plain")
        self.assertEqual(e["domain"], "multi")
        self.assertEqual(e["domains"], ["multi"])

    def test_3_3_clean_drops_every_empty_field(self):
        # A bare entity should carry only what was authored: no empty strings,
        # no empty lists, no empty dicts to render a blank card section from.
        e = find(self.data, "COMMONS", "c-plain")
        # createdBy / usedBy are set for every commons, and dropped again when
        # nothing references it.
        self.assertEqual(list(e), ["id", "name", "domain", "domains", "geo",
                                   "kind", "subSection"])
        self.assertNotIn("createdBy", e)
        self.assertNotIn("usedBy", e)
        for absent in ("city", "country", "url", "desc", "focus", "status",
                       "tier", "prov", "timeline", "links", "license", "repo",
                       "size", "maintainer"):
            with self.subTest(field=absent):
                self.assertNotIn(absent, e)

    def test_3_3_clean_keeps_false_and_zero(self):
        # `geo: false` and a zero budget are values, not emptiness — a
        # falsiness test instead of an emptiness test would delete both.
        self.assertIs(find(self.data, "COMMONS", "c-plain")["geo"], False)
        self.assertEqual(GEN.clean({"eur": 0, "flag": False, "n": 0.0}),
                         {"eur": 0, "flag": False, "n": 0.0})

    def test_3_3_clean_prunes_nested_emptiness_recursively(self):
        self.assertEqual(
            GEN.clean({"a": {"b": "", "c": {"d": []}}, "e": ["  x  ", "", None, {}],
                       "f": "  y  "}),
            {"e": ["x"], "f": "y"})

    def test_3_3_clean_strips_strings_inside_lists(self):
        # The facilities back-reference copies a name before clean() runs, so
        # the strip has to reach into lists as well as dicts.
        self.assertEqual(find(self.data, "TEAMS", "b-lab")["facilities"],
                         ["Human Factors Lab"])

    def test_3_3_timeline_of_stringifies_years_and_needs_a_label(self):
        tl = find(self.data, "TEAMS", "a-lab")["timeline"]
        self.assertEqual(tl, {"start": "1998", "end": "2026",
                              "milestones": [{"date": "2019", "label": "First trial"}]})
        # A milestone with a date but no label carries nothing a card could
        # show, so it is dropped rather than rendered as an empty row.
        self.assertEqual(len(tl["milestones"]), 1)

    def test_3_3_timeline_is_absent_when_no_date_was_authored(self):
        self.assertNotIn("timeline", find(self.data, "PROJECTS", "p-bare"))
        self.assertEqual(GEN.timeline_of({}), {})
        self.assertEqual(GEN.timeline_of({"timeline": {"start": None, "end": ""}}), {})

    def test_3_3_when_is_the_compact_span_with_an_en_dash(self):
        self.assertEqual(find(self.data, "PROJECTS", "p-full")["when"], "2024–2027")
        self.assertEqual(GEN.when_of({"start": "2019"}), "2019–")
        self.assertEqual(GEN.when_of({}), "")
        # No dates at all means no span, and `when` is dropped by clean().
        self.assertNotIn("when", find(self.data, "PROJECTS", "p-bare"))

    def test_3_3_when_of_an_end_without_a_start_is_an_open_left_edge(self):
        # Current behaviour, asserted so a change to it is deliberate: an end
        # date with no start renders as "–2030" rather than as an empty span.
        self.assertEqual(GEN.when_of({"start": "", "end": "2030"}), "–2030")

    def test_3_3_date_quality_is_derived_from_the_provenance_note(self):
        e = find(self.data, "TEAMS", "a-lab")
        self.assertEqual(e["dateConf"], "medium")
        self.assertIs(e["dateHost"], True)

    def test_3_3_date_quality_is_derived_not_authored(self):
        # b-lab authors `dateConf` and `dateHost` in its YAML. They are derived
        # fields (§3.3): the generator ignores what was written there.
        e = find(self.data, "TEAMS", "b-lab")
        self.assertNotIn("dateConf", e)
        self.assertNotIn("dateHost", e)

    def test_3_3_date_host_marks_only_a_borrowed_year(self):
        # "date not found" / "date not published" means the year on record
        # belongs to the host institution, so the map must not draw it as the
        # entity's own (invariant 4). An estimate of *this* entity's start is a
        # different thing and stays a plain low-confidence date.
        note = "timeline.start ({}): {}"
        cases = {
            note.format("high", "Grant agreement lists 2019"): {"dateConf": "high"},
            note.format("medium", "Estimate: MAHALO started 2020"): {"dateConf": "medium"},
            note.format("medium", "Inst founded 1949; the HMT dept's date not found"):
                {"dateConf": "medium", "dateHost": True},
            note.format("low", "date not published anywhere"):
                {"dateConf": "low", "dateHost": True},
            # high confidence is never a borrowed year, whatever the wording.
            note.format("high", "department date not found"): {"dateConf": "high"},
        }
        for src, expected in cases.items():
            with self.subTest(src=src):
                self.assertEqual(GEN.date_quality({"provenance": {"source": src}}), expected)

    def test_3_3_date_quality_reads_only_its_own_note(self):
        # Provenance notes are pipe-separated. "not found" belonging to a later
        # note (here, about confidence) must not turn the start year into a
        # host year.
        src = ("timeline.start (low): Founded 2001 per company registry"
               " | provenance.confidence (low): the department's own date not found")
        self.assertEqual(GEN.date_quality({"provenance": {"source": src}}),
                         {"dateConf": "low"})

    def test_3_3_no_note_means_no_date_quality(self):
        self.assertEqual(GEN.date_quality({}), {})
        self.assertEqual(GEN.date_quality({"provenance": {"source": "scraped homepage"}}), {})
        self.assertEqual(
            GEN.date_quality({"provenance": {"source": "timeline.start: 1999"}}), {})

    def test_3_3_date_quality_needs_a_timeline_to_describe(self):
        # base_entry only asks for date quality when there is a date: a note
        # about a start year on an entity with no timeline describes nothing.
        data = GEN.build(tree("fields_nodate", {
            "data/teams/t-note.yml": (
                "id: t-note\n"
                "name: Note Without Date\n"
                "provenance: {source: 'timeline.start (low): date not found'}\n"
            ),
        }))
        e = find(data, "TEAMS", "t-note")
        self.assertNotIn("dateConf", e)
        self.assertNotIn("dateHost", e)

    def test_3_3_prov_renames_the_provenance_fields(self):
        self.assertEqual(find(self.data, "TEAMS", "a-lab")["prov"], {
            "by": "curator", "on": "2026-01-05", "upd": "2026-02-06",
            "src": "timeline.start (medium): TU Delft founded 1842;"
                   " the lab's own date not found",
            "conf": "medium",
        })
        self.assertEqual(GEN.prov_of({"provenance": {"added_by": "x", "confidence": "low"}}),
                         {"by": "x", "conf": "low"})
        self.assertEqual(GEN.prov_of({}), {})

    def test_3_3_links_keeps_the_five_documented_channels(self):
        self.assertEqual(find(self.data, "TEAMS", "a-lab")["links"], {
            "papers": ["https://doi.example/1"],         # null and '' filtered out
            "linkedin": "https://linkedin.example/a-lab",
            "official": "https://example.org/text",      # renamed from official_text
        })
        self.assertEqual(GEN.links_of({}), {})
        self.assertEqual(GEN.links_of({"links": {"papers": [None, ""]}}), {})

    def test_3_3_homepage_falls_back_through_the_documented_chain(self):
        chain = [
            ({"homepage": "H", "links": {"homepage": "L"}}, "H"),
            ({"links": {"homepage": "L"}, "operator": {"url": "O"}}, "L"),
            ({"operator": {"url": "O"}, "issuing_body": {"url": "I"}}, "O"),
            ({"issuing_body": {"url": "I"}, "maintainer": {"url": "M"}}, "I"),
            ({"maintainer": {"url": "M"}}, "M"),
            ({}, ""),
        ]
        for d, expected in chain:
            with self.subTest(source=sorted(d)):
                self.assertEqual(GEN.homepage(d), expected)

    def test_3_3_url_comes_from_the_issuer_when_a_framework_has_no_homepage(self):
        self.assertEqual(find(self.data, "FRAMEWORKS", "f-guide")["url"],
                         "https://cen.example")
        self.assertEqual(find(self.data, "COMMONS", "c-bench")["url"],
                         "https://gridop.example")

    def test_3_3_loc_supplies_city_and_country(self):
        self.assertEqual(GEN.loc({}), {})
        self.assertEqual(GEN.loc({"location": {"city": "Oslo"}}), {"city": "Oslo"})
        e = find(self.data, "COMMONS", "c-plain")     # no location block at all
        self.assertNotIn("city", e)
        self.assertNotIn("country", e)


class PerLayerFields(unittest.TestCase):
    """§3.3 — the extra fields each layer adds, and the references it resolves."""

    @classmethod
    def setUpClass(cls):
        cls.data = GEN.build(tree("fields_layers", FIELDS_TREE))

    def test_3_3_a_project_carries_its_own_seven_extra_fields(self):
        e = find(self.data, "PROJECTS", "p-full")
        self.assertEqual(e["kind"], "horizon_europe")
        self.assertEqual(e["when"], "2024–2027")
        self.assertEqual(e["funding"], {
            "source": "Horizon Europe", "call": "HORIZON-CL5-2023",
            "grant": "101112131", "eur": 4200000, "url": "https://cordis.example/1"})
        self.assertEqual(e["demos"], [
            {"label": "Lyon pilot", "url": "https://example.org/lyon"}])
        self.assertEqual(e["delivs"], [
            {"title": "D1.1 Concept", "url": "https://example.org/d11",
             "date": "2025-06-30"}])

    def test_3_3_budget_is_the_legacy_alias_for_the_grant(self):
        self.assertEqual(find(self.data, "PROJECTS", "p-full")["budget"], "101112131")
        # Falls back to the funding source when there is no grant number.
        self.assertEqual(find(self.data, "PROJECTS", "p-bare")["budget"],
                         "National programme")

    def test_3_3_a_demonstrator_or_deliverable_without_a_name_is_dropped(self):
        # A row whose only content is a URL has nothing to label it with in a
        # card, so it is not emitted.
        e = find(self.data, "PROJECTS", "p-full")
        self.assertEqual(len(e["demos"]), 1)
        self.assertEqual(len(e["delivs"]), 1)

    def test_3_3_a_consortium_member_needs_an_org(self):
        orgs = [c["org"] for c in find(self.data, "PROJECTS", "p-full")["consortium"]]
        self.assertEqual(orgs, ["Rail Co", "Ghost SA", "Standards Org", "Bench Keeper"])

    def test_3_3_a_consortium_ref_that_resolves_is_kept(self):
        cons = find(self.data, "PROJECTS", "p-full")["consortium"]
        self.assertEqual(cons[0], {"org": "Rail Co", "role": "coordinator",
                                   "country": "FR", "ref": "a-lab"})
        self.assertEqual(cons[3], {"org": "Bench Keeper", "ref": "c-bench"})

    def test_3_3_a_consortium_ref_that_resolves_to_nothing_is_dropped(self):
        # "so the card never renders a dead link" — the org is still listed,
        # just not as a link.
        cons = find(self.data, "PROJECTS", "p-full")["consortium"]
        self.assertEqual(cons[1], {"org": "Ghost SA", "role": "partner", "country": "DE"})

    def test_3_3_a_consortium_ref_to_a_framework_is_dropped(self):
        # SPEC-DEVIATION: §3.3 says a consortium ref is dropped only "when it
        # does not resolve to a known entity", and a framework is a known
        # entity with a card of its own. The generator's `anchors` set is
        # teams | projects | commons, so a ref to a framework id is stripped
        # even though the target exists and is reachable. Asserted as-is: the
        # only visible effect is a missing link on a partner row.
        cons = find(self.data, "PROJECTS", "p-full")["consortium"]
        self.assertEqual(cons[2], {"org": "Standards Org", "role": "member"})
        self.assertEqual([e["id"] for e in self.data["FRAMEWORKS"]], ["f-guide"])

    def test_3_3_a_team_carries_type_affiliation_and_facilities(self):
        e = find(self.data, "TEAMS", "a-lab")
        self.assertEqual(e["type"], "research_lab")
        self.assertEqual(e["affiliation"], {
            "org": "TU Delft", "parent": "4TU", "url": "https://tudelft.example"})
        # Its own `infrastructure` list plus the rig that names it as a host.
        self.assertEqual(e["facilities"], ["Simulator hall", "C Rig"])

    def test_3_3_an_infrastructure_entry_merges_into_the_team_it_mirrors(self):
        # §3.2: one entity, one marker. The infra metadata travels with the
        # team rather than creating a duplicate pin.
        e = find(self.data, "TEAMS", "a-lab")
        self.assertEqual(e["infra"], {
            "kind": "testbed",
            "operator": {"org": "TU Delft", "url": "https://tudelft.example/sim"},
            "access": "gated", "capacity": "12 seats", "hosts": ["b-lab"]})
        self.assertEqual([x["id"] for x in self.data["TEAMS"]].count("a-lab"), 1)

    def test_3_3_a_merged_infrastructure_entry_never_overwrites_a_description(self):
        # Preservation again: the team's own words win. The hall's description
        # is only a fallback for a team that has none.
        self.assertEqual(find(self.data, "TEAMS", "a-lab")["desc"], "One line.")

    def test_3_3_a_merged_entry_adds_its_infrastructure_domain_code(self):
        # The infra kind reaches the marker through `domains` — "testbed" maps
        # to the simulation code — and it is appended, never substituted.
        domains = find(self.data, "TEAMS", "a-lab")["domains"]
        self.assertEqual(domains[-1], "simulation")
        self.assertEqual(domains[0], "aviation")

    def test_3_3_an_unmatched_infrastructure_entry_becomes_a_team(self):
        e = find(self.data, "TEAMS", "c-rig")
        self.assertEqual(e["type"], "infrastructure")
        self.assertEqual(e["domain"], "compute")          # compute_cluster → compute
        self.assertEqual(e["desc"], "A cluster.")
        self.assertEqual(e["infra"]["hosts"], ["a-lab", "c-rig"])

    def test_3_3_a_facility_never_lists_itself(self):
        # c-rig names itself among its hosts; the back-reference skips that,
        # otherwise its card would advertise itself as its own facility.
        self.assertNotIn("facilities", find(self.data, "TEAMS", "c-rig"))

    def test_3_3_a_framework_carries_its_own_eight_extra_fields(self):
        e = find(self.data, "FRAMEWORKS", "f-guide")
        self.assertEqual(e["kind"], "guideline")           # default when unset
        self.assertEqual(e["subSection"], e["kind"])       # legacy alias
        self.assertEqual(e["jurisdiction"], "EU")
        self.assertEqual(e["issuer"], {"org": "CEN", "url": "https://cen.example"})
        self.assertEqual(e["legal"], "in_force")
        self.assertEqual(e["adopted"], "2023-11-02")
        self.assertEqual(e["appliesTo"], ["aviation", "rail"])
        self.assertEqual(e["refs"], ["ISO 9241-210"])

    def test_3_3_a_framework_is_used_by_the_teams_and_projects_that_declare_it(self):
        # The reverse index is built from sets, so the sort is what makes this
        # list the same on every run.
        self.assertEqual(find(self.data, "FRAMEWORKS", "f-guide")["usedBy"],
                         ["b-lab", "p-full"])
        # createdBy is always empty for a framework, so clean() removes it.
        self.assertNotIn("createdBy", find(self.data, "FRAMEWORKS", "f-guide"))

    def test_3_3_a_commons_carries_its_own_eight_extra_fields(self):
        e = find(self.data, "COMMONS", "c-bench")
        self.assertEqual(e["kind"], "benchmark")
        self.assertEqual(e["subSection"], "benchmark")
        self.assertEqual(e["license"], "CC-BY-4.0")
        self.assertEqual(e["maintainer"], {"org": "Grid Op", "url": "https://gridop.example"})
        self.assertEqual(e["repo"], "https://github.example/bench")
        self.assertEqual(e["size"], "2 GB")

    def test_3_3_a_commons_defaults_to_software_and_a_framework_to_guideline(self):
        self.assertEqual(find(self.data, "COMMONS", "c-plain")["kind"], "software")
        self.assertEqual(find(self.data, "COMMONS", "c-plain")["subSection"], "software")

    def test_3_3_commons_cross_references_resolve_or_disappear(self):
        e = find(self.data, "COMMONS", "c-bench")
        # createdBy keeps only ids that name a team or a project: "ghost" does
        # not exist, and a framework is not an author.
        self.assertEqual(e["createdBy"], ["a-lab"])
        # usedBy is the declared list first, then the ids that declared it,
        # sorted — declaration order for the authored half, deterministic for
        # the derived half.
        self.assertEqual(e["usedBy"], ["p-full", "b-lab"])

    def test_3_3_an_edge_needs_both_ends_on_the_map(self):
        # edges.yml is curated by hand, so it can name an id that no longer
        # exists; those rows are dropped rather than producing a dangling edge.
        self.assertEqual(self.data["EDGES"], [{"project": "p-full", "team": "a-lab"}])
        self.assertEqual(list(self.data["EDGES"][0]), ["project", "team"])


if __name__ == "__main__":
    unittest.main()
