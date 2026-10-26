"""Generator: domain mapping — spec §3.1 points 1 and 2, and §3.2.

Three tables decide what colour a marker is, which pie slices it gets, and which
domain checkboxes reach it: `SECTOR` (YAML domain → sector code), `APPROACH`
(YAML focus area → research-axis code) and `INFRA_KIND` (infrastructure kind →
infrastructure code). §3.1 calls them load-bearing and says they are copied
verbatim from the legacy `sync_html_map.py`, because a silent edit moves or
recolours markers and no reader will report that as a bug. So they are pinned
here as literal dicts: an edit has to come with an edit to this file, which is
the point.

The other half is §3.2's infrastructure rule. Infrastructure is the one YAML
layer with no layer of its own on the map. An entry whose id matches a team
enriches that team — operator, access model, capacity, plus its infrastructure
domain code on the marker — and must not produce a second pin at the same place;
an entry with no matching team becomes a team-layer marker instead. Both
branches are exercised end to end against a small committed checkout under
`tests/fixtures/domainmap_infra/`, so the assertions read against real YAML
rather than against a hand-built dict.

The fixtures are deliberately synthetic: the upstream `eu-hai-collab-map`
checkout is not in CI and may not exist locally, so nothing here may depend on
it. The committed `assets/map/hai-data.js` stands in wherever a claim is only
interesting at production scale.
"""
from __future__ import annotations

import copy
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

import yaml

from tests._harness import REPO, load_generator, load_payload, map_script

GEN = load_generator()
FIXTURE = REPO / "tests" / "fixtures" / "domainmap_infra"

# The three codes that make up the "Research infrastructures" filter group in
# the page. §3.1 point 2 is a statement about exactly this set: no focus area
# may lead into it, only the infrastructure layer may.
INFRA_CODES = {"compute", "cluster", "simulation"}

_cache: dict = {}


def fixture_build() -> dict:
    """The fixture checkout, built once and handed out as a copy.

    Building is cheap but not free, and every test gets its own deep copy so a
    test that mutates the payload cannot leak into another. No test may depend
    on running before or after any other.
    """
    if "fixture" not in _cache:
        _cache["fixture"] = GEN.build(FIXTURE)
    return copy.deepcopy(_cache["fixture"])


def payload() -> dict:
    if "payload" not in _cache:
        _cache["payload"] = load_payload()
    return copy.deepcopy(_cache["payload"])


def by_id(entries: list[dict]) -> dict:
    return {e["id"]: e for e in entries}


def all_entities(data: dict) -> list[dict]:
    return [e for k in ("PROJECTS", "TEAMS", "COMMONS", "FRAMEWORKS") for e in data[k]]


def map_colors() -> dict:
    """`COLORS` from the page: the domain codes that have a marker colour."""
    src = map_script()
    block = re.search(r"const COLORS = \{(.*?)\};", src, re.S)
    assert block, "COLORS table not found in the map's inline script"
    return dict(re.findall(r"(\w+):'(#[0-9a-fA-F]{3,8})'", block.group(1)))


def map_dom_groups() -> dict:
    """`DOM_GROUPS` from the page: the three filter groups and their codes."""
    src = map_script()
    block = re.search(r"const DOM_GROUPS = \[(.*?)\];", src, re.S)
    assert block, "DOM_GROUPS not found in the map's inline script"
    groups = re.findall(r"key:'(\w+)',\s*doms:\[([^\]]*)\]", block.group(1))
    assert groups, "DOM_GROUPS parsed empty"
    return {key: re.findall(r"'([^']+)'", doms) for key, doms in groups}


class TempCheckout(unittest.TestCase):
    """Base class that can write a throwaway YAML checkout and build it.

    Several claims are about one field of one entry, and spelling those out as
    committed fixture files would bury them. They are written to a temp dir
    instead — the generator only ever reads `data/<layer>/*.yml` plus
    `data/edges.yml`, so a two-file checkout is a valid one.
    """

    maxDiff = None

    def build(self, *, edges=None, **layers) -> dict:
        root = Path(tempfile.mkdtemp(prefix="domainmap-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        (root / "data").mkdir()
        # edges.yml is read unconditionally, so it is always written; a test
        # that needs a link between two layers passes `edges=[...]`.
        (root / "data" / "edges.yml").write_text(
            yaml.safe_dump(edges, allow_unicode=True) if edges else "[]\n",
            encoding="utf-8")
        for layer, entries in layers.items():
            d = root / "data" / layer
            d.mkdir()
            for i, entry in enumerate(entries):
                (d / f"{i:02d}-{entry['id']}.yml").write_text(
                    yaml.safe_dump(entry, allow_unicode=True, sort_keys=False),
                    encoding="utf-8")
        return GEN.build(root)


# --------------------------------------------------------------------------
# §3.1 point 1 — the legacy tables, pinned
# --------------------------------------------------------------------------

class LegacyTablesArePinned(unittest.TestCase):
    """§3.1.1 "The SECTOR, APPROACH and INFRA_KIND tables are copied verbatim
    and must stay that way." These four tests are the enforcement: they fail on
    any edit, including an apparently harmless one, so the edit has to be
    deliberate."""

    def test_sector_table_is_verbatim(self):
        # §3.1 point 1 — YAML domain → sector code. Note power_grid aliasing
        # onto energy, water and gas both onto utility, and
        # critical_infrastructure landing in the catch-all rather than in a
        # sector of its own.
        self.assertEqual(GEN.SECTOR, {
            "energy": "energy", "power_grid": "energy", "nuclear": "nuclear",
            "aviation": "aviation", "rail": "rail", "transport": "transport",
            "maritime": "maritime", "telecom": "telecom", "water": "utility",
            "gas": "utility", "healthcare": "health",
            "manufacturing": "manufacturing", "defense": "defense",
            "critical_infrastructure": "multi",
        })

    def test_approach_table_is_verbatim(self):
        # §3.1 point 1 — YAML focus_area → research-axis code. Lossy on
        # purpose: it drives checkboxes only, the card reads the raw `focus`
        # list. digital_twins is absent by design (see §3.1 point 2 below).
        self.assertEqual(GEN.APPROACH, {
            "human_factors": "hf", "human_computer_partnerships": "hf",
            "explainability": "xai", "trust_calibration": "xai",
            "oversight": "xai", "uncertainty_communication": "xai",
            "mixed_initiative": "multi",
            "shared_situational_awareness": "multi",
            "cobots": "manufacturing",
            "reinforcement_learning_ops": "multi",
            "process_industry": "manufacturing", "power_grid": "energy",
            "energy_markets": "energy", "transport_ops": "transport",
            "healthcare_ops": "health", "defense": "defense",
        })

    def test_infra_kind_table_is_verbatim(self):
        # §3.1 point 1 — infrastructure kind → domain code. The two
        # counter-intuitive rows (cloud_platform and governance_body both
        # landing on `cluster`, testbed on `simulation`) are legacy and must not
        # be "fixed" silently: they decide which markers the Research
        # infrastructures filters reach.
        self.assertEqual(GEN.INFRA_KIND, {
            "compute_cluster": "compute", "cloud_platform": "cluster",
            "governance_body": "cluster", "testbed": "simulation",
            "hosting": "compute",
        })

    def test_table_sizes_are_pinned(self):
        # A dict comparison already catches an addition, but naming the sizes
        # makes a diff of this file say "a row was added" rather than only
        # "the table changed".
        self.assertEqual((len(GEN.SECTOR), len(GEN.APPROACH), len(GEN.INFRA_KIND)),
                         (14, 16, 5))


class TablesAgreeWithThePage(unittest.TestCase):
    """§3.1.1 — the derivation is only "exact" if every code the generator can
    emit is a code the page knows how to draw and to filter. The two halves
    live in different files with no shared source, so nothing but a test keeps
    them in step."""

    def emitted_codes(self) -> set:
        return set(GEN.SECTOR.values()) | set(GEN.APPROACH.values()) | set(GEN.INFRA_KIND.values())

    def test_every_emitted_code_has_a_marker_colour(self):
        missing = sorted(self.emitted_codes() - set(map_colors()))
        self.assertEqual(missing, [], "domain codes with no colour in COLORS")

    def test_every_emitted_code_sits_in_a_filter_group(self):
        # A code outside DOM_GROUPS would be undrawable *and* unreachable: the
        # domain filter starts as the set of all grouped codes, so an entity
        # holding only an ungrouped code would never match.
        grouped = {c for codes in map_dom_groups().values() for c in codes}
        self.assertEqual(sorted(self.emitted_codes() - grouped), [])

    def test_no_filter_checkbox_is_unreachable(self):
        # The reverse direction: a checkbox no entity can ever carry is dead
        # UI. The two sets must be equal, not merely nested.
        grouped = {c for codes in map_dom_groups().values() for c in codes}
        self.assertEqual(grouped, self.emitted_codes())
        self.assertEqual(len(grouped), 17)

    def test_colour_table_covers_exactly_the_emitted_codes(self):
        self.assertEqual(set(map_colors()), self.emitted_codes())

    def test_every_approach_key_is_a_real_focus_vocabulary_key(self):
        # A typo in an APPROACH key is silent: the mapping simply never fires.
        # Every key must exist in the focus vocabulary shipped to the page.
        unknown = sorted(set(GEN.APPROACH) - set(GEN.TAXO["focus"]))
        self.assertEqual(unknown, [])

    def test_authored_keys_only_ever_reach_the_industrial_and_research_groups(self):
        # The reader's mental model: the first two filter groups describe what an
        # entity works on (authored in the YAML), the third describes hardware
        # (derived from the infrastructure layer). Both authored tables must stay
        # out of the third group for that split to hold.
        groups = map_dom_groups()
        authored_groups = set(groups["industrial"]) | set(groups["research"])
        self.assertEqual(set(GEN.SECTOR.values()) - authored_groups, set())
        self.assertEqual(set(GEN.APPROACH.values()) - authored_groups, set())


class MarkerGeometryIsCopiedNotComputed(TempCheckout):
    """§3.1.1 "Marker geometry and colour are derived exactly as the legacy
    sync_html_map.py derived them." Geometry means the authored lat/lon travel
    through untouched — no rounding, no reprojection, no snapping."""

    def test_coordinates_pass_through_unchanged(self):
        data = self.build(teams=[{
            "id": "geo", "name": "Geo", "location": {
                "city": "Tromsø", "country": "NO",
                "lat": 69.649208123456, "lon": -18.955324987654},
            "domains": ["energy"]}])
        e = data["TEAMS"][0]
        self.assertEqual(e["lat"], 69.649208123456)
        self.assertEqual(e["lon"], -18.955324987654)

    def test_negative_and_zero_coordinates_survive_the_cleanup(self):
        # `clean()` drops empty values; 0.0 is falsy in Python and a longitude
        # of exactly 0 is a real place (Greenwich). If it were dropped the
        # entity would silently lose its pin.
        data = self.build(teams=[{
            "id": "meridian", "name": "Meridian", "location": {
                "city": "London", "country": "GB", "lat": 0.0, "lon": 0.0},
            "domains": ["telecom"]}])
        e = data["TEAMS"][0]
        self.assertEqual((e["lat"], e["lon"]), (0.0, 0.0))
        self.assertNotIn("geo", e)

    def test_unmapped_yaml_domain_is_dropped_not_forwarded(self):
        # An unknown key must not reach the page as an unknown colour code:
        # sectors() filters on the table, so the entity falls back to `multi`.
        data = self.build(teams=[{
            "id": "space", "name": "Space", "domains": ["astronautics"],
            "location": {"city": "Kiruna", "country": "SE", "lat": 67.9, "lon": 20.2}}])
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["multi"])
        self.assertEqual(e["domain"], "multi")

    def test_unmapped_focus_area_is_dropped_not_forwarded(self):
        data = self.build(teams=[{
            "id": "novel", "name": "Novel", "domains": ["rail"],
            "focus_areas": ["speculative_new_thing"],
            "location": {"city": "Wien", "country": "AT", "lat": 48.2, "lon": 16.4}}])
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["rail"])
        # …but the raw key is still carried for the card to label.
        self.assertEqual(e["focus"], ["speculative_new_thing"])


class RegenerationIsStable(unittest.TestCase):
    """§3.1.1 "Regeneration after a data change should alter only the entities
    that changed." A generator that reshuffles or re-derives unrelated entries
    turns every data fix into an unreviewable diff."""

    def test_two_builds_of_the_same_source_are_identical(self):
        first = json.dumps(GEN.build(FIXTURE), ensure_ascii=False, sort_keys=True)
        second = json.dumps(GEN.build(FIXTURE), ensure_ascii=False, sort_keys=True)
        self.assertEqual(first, second)

    def test_editing_one_entity_leaves_every_other_byte_identical(self):
        root = Path(tempfile.mkdtemp(prefix="domainmap-regen-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        shutil.copytree(FIXTURE, root / "src")
        src = root / "src"
        before = GEN.build(src)

        f = src / "data" / "teams" / "alpha.yml"
        doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        doc["description"] = "Rewritten description, one entity only."
        f.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False),
                     encoding="utf-8")
        after = GEN.build(src)

        changed = []
        for layer in ("PROJECTS", "TEAMS", "COMMONS", "FRAMEWORKS", "EDGES"):
            self.assertEqual(len(before[layer]), len(after[layer]), layer)
            for a, b in zip(before[layer], after[layer]):
                if json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True):
                    changed.append(a.get("id"))
        self.assertEqual(changed, ["alpha"])
        self.assertEqual(by_id(after["TEAMS"])["alpha"]["desc"],
                         "Rewritten description, one entity only.")


# --------------------------------------------------------------------------
# §3.1 point 2 — digital_twins is never simulation
# --------------------------------------------------------------------------

class DigitalTwinsIsNeverSimulation(TempCheckout):
    """§3.1.2 "`digital_twins` is never mapped to `simulation`. The compute /
    cluster / simulation codes are infrastructure categories and come only from
    the infrastructure layer. Otherwise every operator using digital twins
    would wrongly appear under the research-infrastructure filters."

    Digital twins are near-universal in this field — as of the committed
    payload 46 of the 449 entities declare the focus area — so mapping it to
    `simulation` would flood the "Research infrastructures" group with teams
    that run no facility at all, and the group would stop meaning anything."""

    def test_approach_has_no_digital_twins_key(self):
        self.assertNotIn("digital_twins", GEN.APPROACH)

    def test_no_focus_area_maps_into_the_infrastructure_group(self):
        # The claim generalised: not just digital_twins, *no* focus area may
        # produce an infrastructure code. This is the assertion that catches a
        # future `"testbed_work": "simulation"` row as well.
        self.assertEqual(set(GEN.APPROACH.values()) & INFRA_CODES, set())

    def test_no_yaml_domain_maps_into_the_infrastructure_group(self):
        # Same for SECTOR: the codes come only from INFRA_KIND.
        self.assertEqual(set(GEN.SECTOR.values()) & INFRA_CODES, set())

    def test_infra_kind_values_are_exactly_the_infrastructure_filter_group(self):
        # Grounds INFRA_CODES above in the page rather than in this file: the
        # group the spec calls "the research-infrastructure filters" is exactly
        # the value set of INFRA_KIND.
        self.assertEqual(set(GEN.INFRA_KIND.values()), INFRA_CODES)
        self.assertEqual(set(map_dom_groups()["infra"]), INFRA_CODES)

    def test_focus_keys_without_a_domain_code_are_the_expected_three(self):
        # decision_support is universal (it would discriminate nothing),
        # manufacturing duplicates the sector key, and digital_twins is the
        # load-bearing omission of §3.1 point 2. Pinning the set means adding
        # digital_twins back to APPROACH fails here too, with the reason in
        # plain sight.
        self.assertEqual(sorted(set(GEN.TAXO["focus"]) - set(GEN.APPROACH)),
                         ["decision_support", "digital_twins", "manufacturing"])

    def test_team_declaring_digital_twins_gets_no_simulation_domain(self):
        # End to end, from YAML: `alpha` declares digital_twins and
        # human_factors and runs no facility.
        alpha = by_id(fixture_build()["TEAMS"])["alpha"]
        self.assertIn("digital_twins", alpha["focus"])
        self.assertEqual(alpha["domains"], ["energy", "hf"])
        self.assertNotIn("simulation", alpha["domains"])
        self.assertEqual(set(alpha["domains"]) & INFRA_CODES, set())

    def test_digital_twins_alone_yields_the_catch_all_not_simulation(self):
        # The starkest case: digital_twins is the only focus area and there is
        # no sector. The entity must fall back to `multi`, never to an
        # infrastructure code.
        data = self.build(teams=[{
            "id": "twin-only", "name": "Twin Only",
            "focus_areas": ["digital_twins"],
            "location": {"city": "Aalborg", "country": "DK", "lat": 57.0, "lon": 9.9}}])
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["multi"])
        self.assertEqual(e["domain"], "multi")

    def test_the_rule_holds_on_every_layer_not_just_teams(self):
        # base_entry() is shared, so the mapping is layer-independent; a
        # project declaring digital twins must be as clean as a team.
        data = fixture_build()
        pi = by_id(data["PROJECTS"])["pi-project"]
        self.assertIn("digital_twins", pi["focus"])
        self.assertEqual(pi["domains"], ["manufacturing", "multi"])
        self.assertEqual(set(pi["domains"]) & INFRA_CODES, set())

    def test_an_infrastructure_entrys_own_digital_twins_adds_nothing(self):
        # `zeta` is an infrastructure entry (so it legitimately carries an
        # infrastructure code) that also declares digital_twins. Its code must
        # come from `kind`, and the focus area must contribute nothing on top.
        zeta = by_id(fixture_build()["TEAMS"])["zeta"]
        self.assertEqual(zeta["focus"], ["digital_twins"])
        self.assertEqual(zeta["infra"]["kind"], "compute_cluster")
        self.assertEqual(zeta["domains"], ["compute"])   # not ['compute','simulation']

    def test_digital_twins_keeps_its_label_in_the_vocabulary(self):
        # Withholding the domain mapping must not make the key illegible: the
        # card renders the raw focus list through TAXO, so the label has to
        # stay even though the filter code does not exist.
        self.assertEqual(GEN.TAXO["focus"]["digital_twins"],
                         ("Digital twins", "Jumeaux numériques"))

    def test_committed_payload_never_infers_simulation_from_digital_twins(self):
        # Production scale: of the entities declaring digital twins, the only
        # ones carrying an infrastructure code are those with an actual
        # infrastructure entry merged in. 28 of the 46 carry none at all.
        ents = all_entities(payload())
        declared = [e for e in ents if "digital_twins" in (e.get("focus") or [])]
        self.assertGreater(len(declared), 20, "payload lost its digital-twin entities")
        no_facility = [e for e in declared if not e.get("infra")]
        self.assertGreater(len(no_facility), 20)
        self.assertEqual(
            [e["id"] for e in no_facility if set(e["domains"]) & INFRA_CODES], [])

    def test_committed_payload_infra_codes_come_only_from_the_infra_layer(self):
        # The generalised guard on real data: an infrastructure code anywhere
        # in the payload must be backed by an `infra` block. If a focus area
        # ever started producing one, this is where it would surface.
        offenders = [e["id"] for e in all_entities(payload())
                     if set(e["domains"]) & INFRA_CODES and not e.get("infra")]
        self.assertEqual(offenders, [])

    def test_committed_payload_only_teams_carry_infra_blocks(self):
        # Corollary of §3.2: infrastructure merges into the team layer only. A
        # project or framework with an `infra` block would mean the merge had
        # leaked.
        data = payload()
        for layer in ("PROJECTS", "COMMONS", "FRAMEWORKS"):
            self.assertEqual([e["id"] for e in data[layer] if e.get("infra")], [],
                             f"{layer} carries an infra block")


# --------------------------------------------------------------------------
# domain_list / primary / sectors / approaches
# --------------------------------------------------------------------------

class SectorAndApproachMapping(unittest.TestCase):
    """The two mapping helpers in isolation: order preserved, unknown keys
    dropped, duplicates left for domain_list to collapse."""

    def test_sectors_preserves_yaml_order(self):
        self.assertEqual(GEN.sectors({"domains": ["nuclear", "energy", "rail"]}),
                         ["nuclear", "energy", "rail"])

    def test_sectors_drops_unknown_keys_keeping_the_rest_in_place(self):
        self.assertEqual(
            GEN.sectors({"domains": ["space", "energy", "quantum", "rail"]}),
            ["energy", "rail"])

    def test_sectors_maps_aliases_to_one_code_without_collapsing_them(self):
        # water and gas both mean utility; de-duplication is domain_list's job,
        # so the raw helper still returns both.
        self.assertEqual(GEN.sectors({"domains": ["water", "gas"]}),
                         ["utility", "utility"])

    def test_sectors_of_an_entity_with_no_domains_key(self):
        self.assertEqual(GEN.sectors({}), [])
        self.assertEqual(GEN.sectors({"domains": None}), [])
        self.assertEqual(GEN.sectors({"domains": []}), [])

    def test_approaches_preserves_focus_order_and_drops_unknowns(self):
        self.assertEqual(
            GEN.approaches({"focus_areas": [
                "decision_support", "explainability", "cobots", "human_factors"]}),
            ["xai", "manufacturing", "hf"])

    def test_approaches_of_an_entity_with_no_focus_areas(self):
        self.assertEqual(GEN.approaches({}), [])
        self.assertEqual(GEN.approaches({"focus_areas": None}), [])


class DomainListOrdering(unittest.TestCase):
    """`domain_list` decides the pie slices and the filter matches, so its order
    is visible: the first code draws a single-domain marker, and the slices are
    drawn in this order."""

    def test_lead_comes_first(self):
        # The lead is the infrastructure code of a standalone infrastructure
        # entry; it must own the marker, not trail behind the sectors.
        self.assertEqual(GEN.domain_list(["energy"], ["hf"], "compute"),
                         ["compute", "energy", "hf"])

    def test_sectors_precede_approaches(self):
        self.assertEqual(GEN.domain_list(["energy", "rail"], ["hf", "xai"], None),
                         ["energy", "rail", "hf", "xai"])

    def test_duplicates_collapse_first_occurrence_wins(self):
        self.assertEqual(GEN.domain_list(["utility", "utility", "energy"], [], None),
                         ["utility", "energy"])

    def test_a_sector_and_a_focus_area_meeting_on_one_code_collapse(self):
        # healthcare (domain) and healthcare_ops (focus area) both mean health.
        self.assertEqual(GEN.domain_list(["health"], ["health", "xai"], None),
                         ["health", "xai"])

    def test_a_lead_already_present_is_not_repeated(self):
        self.assertEqual(GEN.domain_list(["energy"], ["energy"], "energy"),
                         ["energy"])

    def test_empty_everything_falls_back_to_multi(self):
        # Never an empty list: an entity with no codes would match no domain
        # filter and be permanently invisible.
        self.assertEqual(GEN.domain_list([], [], None), ["multi"])
        self.assertEqual(GEN.domain_list([], [], ""), ["multi"])

    def test_a_single_code_stays_a_single_code(self):
        self.assertEqual(GEN.domain_list(["maritime"], [], None), ["maritime"])

    def test_lead_alone_is_enough(self):
        self.assertEqual(GEN.domain_list([], [], "simulation"), ["simulation"])


class PrimaryDomain(unittest.TestCase):
    """`primary` becomes the entity's `domain`: the lead colour, used for the
    edges drawn around a selection."""

    def test_lead_wins_outright(self):
        self.assertEqual(GEN.primary(["energy", "rail"], "compute"), "compute")

    def test_first_specific_sector_beats_the_catch_all(self):
        # critical_infrastructure maps to `multi`. An entity that declares it
        # first and nuclear second is a nuclear entity for colouring purposes —
        # a teal "multi" dot would hide the one fact a reader scans for.
        self.assertEqual(GEN.primary(["multi", "nuclear"], None), "nuclear")

    def test_all_multi_sectors_stay_multi(self):
        self.assertEqual(GEN.primary(["multi", "multi"], None), "multi")

    def test_no_sector_at_all_is_multi(self):
        self.assertEqual(GEN.primary([], None), "multi")

    def test_sector_order_decides_between_two_specific_codes(self):
        self.assertEqual(GEN.primary(["rail", "energy"], None), "rail")

    def test_approaches_never_reach_primary(self):
        # SPEC-DEVIATION: §3.3 describes `domain` as "lead, drives colour when
        # single", but primary() only ever looks at sectors. An entity whose
        # only codes are research axes therefore gets domain='multi' while
        # domains=['xai'] — a `domain` that is not in its own `domains`. Benign
        # today because the marker reads domains[0] and only edge colours read
        # `domain`; recorded here as the current behaviour, not endorsed.
        self.assertEqual(GEN.primary([], None), "multi")
        odd = [e for e in all_entities(payload()) if e["domain"] not in e["domains"]]
        # Structural claim: the only way to get there is the empty-sector path,
        # so the stray value is always the catch-all.
        for e in odd:
            self.assertEqual(e["domain"], "multi", e["id"])
            self.assertEqual(set(e["domains"]) & set(GEN.SECTOR.values()), set(), e["id"])
        self.assertEqual(
            [e["id"] for e in odd], ["ellis-society"],
            "a new entity reached the sector-less path; review the data change, "
            "then update this pin")
        self.assertEqual(odd[0]["domains"], ["xai"])


class DomainMappingEndToEnd(TempCheckout):
    """The same rules, read out of built YAML rather than out of the helpers."""

    def test_aliased_domains_produce_one_slice(self):
        alpha = by_id(fixture_build()["TEAMS"])["alpha"]
        # energy + power_grid + human_factors → energy, hf
        self.assertEqual(alpha["domains"], ["energy", "hf"])
        self.assertEqual(alpha["domain"], "energy")

    def test_domain_and_focus_meeting_on_one_code_produce_one_slice(self):
        gamma = by_id(fixture_build()["TEAMS"])["gamma"]
        # healthcare + healthcare_ops → a single health slice (cluster comes
        # from the merged infrastructure entry, see §3.2 below).
        self.assertEqual(gamma["domains"], ["health", "cluster"])
        self.assertEqual(gamma["domains"].count("health"), 1)

    def test_catch_all_leads_the_pie_but_not_the_colour(self):
        delta = by_id(fixture_build()["TEAMS"])["delta"]
        self.assertEqual(delta["domains"], ["multi", "nuclear", "xai"])
        self.assertEqual(delta["domain"], "nuclear")

    def test_an_entity_with_no_sector_keeps_its_research_axes(self):
        data = self.build(teams=[{
            "id": "axes", "name": "Axes only",
            "focus_areas": ["explainability", "human_factors"],
            "location": {"city": "Tampere", "country": "FI", "lat": 61.5, "lon": 23.8}}])
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["xai", "hf"])
        self.assertEqual(e["domain"], "multi")      # see PrimaryDomain above

    def test_an_entity_with_nothing_to_map_is_still_filterable(self):
        data = self.build(teams=[{
            "id": "bare", "name": "Bare",
            "location": {"city": "Riga", "country": "LV", "lat": 56.9, "lon": 24.1}}])
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["multi"])
        self.assertEqual(e["domain"], "multi")

    def test_committed_payload_has_no_empty_or_unknown_domain_list(self):
        known = set(map_colors())
        for e in all_entities(payload()):
            self.assertTrue(e.get("domains"), f"{e['id']} has no domains")
            self.assertEqual(len(e["domains"]), len(set(e["domains"])),
                             f"{e['id']} repeats a domain code")
            self.assertEqual(set(e["domains"]) - known, set(), e["id"])


# --------------------------------------------------------------------------
# §3.2 — infrastructure has no layer of its own
# --------------------------------------------------------------------------

class InfrastructureHasNoLayerOfItsOwn(TempCheckout):
    """§3.2 "**Infrastructure has no layer of its own**, by design. […] they
    enrich that team's card with operator, access model and capacity, and add
    their infrastructure domain code to its marker, without creating a
    duplicate pin. The other 18 are rendered as team markers. This keeps 'who
    is doing the work' and 'what they run it on' in one place."

    Two pins at the same address for the same organisation is exactly the kind
    of duplicate a reader reads as a data error, which is why the merge branch
    gets its own tests."""

    def test_build_emits_five_layers_and_no_infrastructure_key(self):
        self.assertEqual(sorted(fixture_build()),
                         ["COMMONS", "EDGES", "FRAMEWORKS", "PROJECTS", "TEAMS"])

    def test_matching_infrastructure_entry_creates_no_second_pin(self):
        teams = fixture_build()["TEAMS"]
        self.assertEqual([e["id"] for e in teams if e["id"] == "beta"], ["beta"])
        self.assertEqual(len(teams), len(by_id(teams)))

    def test_the_teams_own_geometry_wins_over_the_facilitys(self):
        # beta-testbed.yml sits at Schiphol; the team sits in Amsterdam. One
        # pin means one set of coordinates, and it is the team's.
        beta = by_id(fixture_build()["TEAMS"])["beta"]
        self.assertEqual((beta["city"], beta["lat"], beta["lon"]),
                         ("Amsterdam", 52.3702, 4.8952))

    def test_the_merge_keeps_the_teams_name_and_type(self):
        beta = by_id(fixture_build()["TEAMS"])["beta"]
        self.assertEqual(beta["name"], "Beta Air Traffic Group")
        self.assertEqual(beta["type"], "industrial_rd")

    def test_the_merge_attaches_operator_access_and_capacity(self):
        beta = by_id(fixture_build()["TEAMS"])["beta"]
        self.assertEqual(beta["infra"], {
            "kind": "testbed",
            "operator": {"org": "Beta Operations BV",
                         "url": "https://example.org/beta-ops"},
            "access": "gated",
            "capacity": "3 tower positions, 12 pseudo-pilots",
            "hosts": ["delta"],
        })

    def test_the_merge_adds_the_infra_domain_code_to_the_marker(self):
        beta = by_id(fixture_build()["TEAMS"])["beta"]
        # kind: testbed → simulation, appended after the team's own codes…
        self.assertEqual(beta["domains"], ["aviation", "xai", "simulation"])
        # …and the lead colour is untouched, so the marker still reads aviation.
        self.assertEqual(beta["domain"], "aviation")

    def test_a_merged_entry_with_a_thinner_block_omits_the_empty_fields(self):
        # gamma-cloud.yml has no capacity indicator and no operator url;
        # clean() drops them rather than shipping empty strings the card would
        # have to guard against.
        gamma = by_id(fixture_build()["TEAMS"])["gamma"]
        self.assertEqual(gamma["infra"], {
            "kind": "cloud_platform", "operator": {"org": "Gamma Hospital Trust"},
            "access": "open"})

    def test_the_merge_fills_a_missing_description(self):
        # gamma.yml carries none; the facility's text is better than nothing.
        gamma = by_id(fixture_build()["TEAMS"])["gamma"]
        self.assertEqual(
            gamma["desc"],
            "A federated platform hosting de-identified clinical imaging cohorts.")

    def test_the_merge_never_overwrites_an_existing_description(self):
        beta = by_id(fixture_build()["TEAMS"])["beta"]
        self.assertEqual(
            beta["desc"],
            "Controller-facing explanation interfaces for arrival management.")

    def test_an_unmatched_entry_becomes_a_team_layer_marker(self):
        zeta = by_id(fixture_build()["TEAMS"])["zeta"]
        self.assertEqual(zeta["type"], "infrastructure")
        self.assertEqual(zeta["name"], "Zeta AI Factory")
        self.assertEqual((zeta["city"], zeta["lat"], zeta["lon"]),
                         ("Espoo", 60.2055, 24.6559))
        # Its own kind is the lead, so the marker is coloured as compute.
        self.assertEqual(zeta["domain"], "compute")
        self.assertEqual(zeta["domains"], ["compute"])

    def test_the_teams_layer_is_teams_plus_unmatched_infrastructure(self):
        # §3.2's table row: "Teams | data/teams/ + infrastructure with no
        # matching team". Four team files, three infrastructure entries of
        # which two match a team, so five markers and no more.
        teams = fixture_build()["TEAMS"]
        self.assertEqual(sorted(e["id"] for e in teams),
                         ["alpha", "beta", "delta", "gamma", "zeta"])
        self.assertEqual(len(teams), 4 + 1)

    def test_the_merge_leaves_the_other_layers_alone(self):
        data = fixture_build()
        self.assertEqual([e["id"] for e in data["PROJECTS"]], ["pi-project"])
        self.assertEqual(data["COMMONS"], [])
        self.assertEqual(data["FRAMEWORKS"], [])

    def test_hosts_travel_with_the_entry_and_name_the_host_team(self):
        # "what they run it on in one place", read from the other end: the host
        # team lists the facilities pointed at it. A merged entry contributes
        # the operating team's name (that is the entity on the map), an
        # unmatched one its own.
        delta = by_id(fixture_build()["TEAMS"])["delta"]
        self.assertEqual(delta["facilities"], ["Beta Air Traffic Group", "Zeta AI Factory"])

    def test_a_facility_hosted_by_itself_is_not_listed_on_itself(self):
        data = self.build(
            teams=[{"id": "solo", "name": "Solo", "domains": ["energy"],
                    "location": {"city": "Porto", "country": "PT", "lat": 41.1, "lon": -8.6}}],
            infrastructure=[{"id": "solo", "name": "Solo Rig", "kind": "testbed",
                             "related_initiative_ids": ["solo"]}])
        solo = data["TEAMS"][0]
        self.assertEqual(solo["infra"]["hosts"], ["solo"])
        self.assertNotIn("facilities", solo)

    def test_a_teams_own_infrastructure_list_becomes_facilities(self):
        data = self.build(teams=[{
            "id": "listy", "name": "Listy", "domains": ["energy"],
            "infrastructure": ["Bench A", "Bench B"],
            "location": {"city": "Genève", "country": "CH", "lat": 46.2, "lon": 6.1}}])
        self.assertEqual(data["TEAMS"][0]["facilities"], ["Bench A", "Bench B"])

    def test_two_entries_for_one_team_neither_duplicate_the_pin_nor_the_code(self):
        # Contrived but it is the guard `if lead not in t["domains"]` exists
        # for: nothing stops the upstream repo holding two infrastructure files
        # for the same operator. One pin, one simulation slice.
        data = self.build(
            teams=[{"id": "twice", "name": "Twice", "domains": ["energy"],
                    "location": {"city": "Bilbao", "country": "ES", "lat": 43.2, "lon": -2.9}}],
            infrastructure=[
                {"id": "twice", "name": "Rig One", "kind": "testbed",
                 "access_model": "open"},
                {"id": "twice", "name": "Rig Two", "kind": "testbed",
                 "access_model": "gated"}])
        self.assertEqual(len(data["TEAMS"]), 1)
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["energy", "simulation"])
        self.assertEqual(e["infra"]["access"], "gated")   # last write wins

    def test_an_unmatched_entry_is_a_team_id_an_edge_can_name(self):
        # §3.2's table reads "Teams | `data/teams/` + infrastructure with no
        # matching team", and the Links row resolves both of its ends against
        # the layers. So an unmatched entry is a team in full, not a
        # second-class marker: a hand-curated link in `edges.yml` that names it
        # has to survive. The only thing that makes that true is the order of
        # two statements — the team index is frozen *after* the infrastructure
        # pass — so an innocuous-looking hoist would silently drop those links.
        data = self.build(
            projects=[{"id": "p1", "name": "Project One", "domains": ["energy"],
                       "location": {"city": "Oslo", "country": "NO",
                                    "lat": 59.91, "lon": 10.75}}],
            infrastructure=[{"id": "rig", "name": "Rig", "kind": "compute_cluster",
                             "location": {"city": "Bergen", "country": "NO",
                                          "lat": 60.39, "lon": 5.32}}],
            edges=[{"project": "p1", "team": "rig"}])
        self.assertEqual([e["id"] for e in data["TEAMS"]], ["rig"])
        self.assertEqual(data["EDGES"], [{"project": "p1", "team": "rig"}])

    def test_an_unmatched_entrys_type_is_pinned_not_read_from_its_yaml(self):
        # `type` is what the card and the type filter use to say that this pin
        # is a facility rather than a team, and `infrastructure` is assigned
        # here, never inherited: an upstream entry that also carries a `type:`
        # of its own must not override it, or a compute cluster would appear on
        # the map as a research lab. The fixture entries carry no `type:`, so
        # only an entry that does can tell the two readings apart.
        e = self.build(infrastructure=[{
            "id": "rig", "name": "Rig", "kind": "compute_cluster",
            "type": "research_lab",
            "location": {"city": "Uppsala", "country": "SE",
                         "lat": 59.86, "lon": 17.64}}])["TEAMS"][0]
        self.assertEqual(e["type"], "infrastructure")
        self.assertEqual(e["domain"], "compute")

    def test_two_unmatched_entries_for_one_facility_still_make_one_pin(self):
        # The mirror of the two-entries case above. There, the first entry
        # found a team to merge into; here there is no team at all, so the first
        # entry *creates* the pin and the second has to find that pin — which
        # only works because a new marker is registered in the team index as it
        # is appended. Drop the bookkeeping and two files for one facility put
        # two markers on the same spot, the duplicate §3.2 exists to prevent.
        data = self.build(infrastructure=[
            {"id": "rig", "name": "Rig One", "kind": "compute_cluster",
             "access_model": "open",
             "location": {"city": "Aarhus", "country": "DK",
                          "lat": 56.16, "lon": 10.20}},
            {"id": "rig", "name": "Rig Two", "kind": "testbed",
             "access_model": "gated"}])
        self.assertEqual(len(data["TEAMS"]), 1)
        e = data["TEAMS"][0]
        self.assertEqual(e["domains"], ["compute", "simulation"])
        self.assertEqual(e["domain"], "compute")        # the first entry leads
        self.assertEqual(e["infra"]["access"], "gated")  # last write wins
        self.assertEqual((e["city"], e["lat"]), ("Aarhus", 56.16))

    def test_an_unmatched_entry_can_host_another_unmatched_entry(self):
        # "who is doing the work" and "what they run it on" in one place, with
        # neither end matching a team: the hosting marker only learns about the
        # facility if the facility's own marker is in the team index by the time
        # the back-references are resolved. Both existing host tests point at a
        # real team file, so neither exercises that.
        data = self.build(infrastructure=[
            {"id": "centre", "name": "National Centre", "kind": "governance_body",
             "location": {"city": "Tallinn", "country": "EE",
                          "lat": 59.44, "lon": 24.75}},
            {"id": "bench", "name": "Bench Nine", "kind": "testbed",
             "related_initiative_ids": ["centre"],
             "location": {"city": "Tartu", "country": "EE",
                          "lat": 58.38, "lon": 26.72}}])
        self.assertEqual(sorted(e["id"] for e in data["TEAMS"]), ["bench", "centre"])
        self.assertEqual(by_id(data["TEAMS"])["centre"]["facilities"], ["Bench Nine"])

    def test_committed_payload_splits_infrastructure_into_both_branches(self):
        # §3.2 in figures: "Of its 41 entries, 23 describe a facility run by a
        # team already on the map […] The other 18 are rendered as team
        # markers." That split *is* the output of the two branches of the merge,
        # so pinning it is the only production-scale check that both of them
        # still fire. The bounds this replaces — each branch merely non-empty,
        # and the two of them summing to their own total — could not fail: the
        # sum was a tautology, and a merge that fired once would have passed.
        #
        # Which branch an entry came from is read off its marker, not off its
        # `type`: a merged entry is coloured by its own sectors, because
        # primary() never sees an infrastructure code, while a standalone entry
        # is coloured by its kind. Selecting on `type` and then asserting on
        # `type` is reading the answer back out of the line under test.
        teams = payload()["TEAMS"]
        with_infra = [e for e in teams if e.get("infra")]
        standalone = [e for e in with_infra if e["domain"] in INFRA_CODES]
        merged = [e for e in with_infra if e["domain"] not in INFRA_CODES]
        self.assertEqual((len(with_infra), len(merged), len(standalone)),
                         (41, 23, 18),
                         "the infrastructure split moved; if that is an upstream "
                         "data change, update §3.2's figures and this pin together")
        # One marker per entry, and no entry landed in the layer twice.
        self.assertEqual(len(teams), len({e["id"] for e in teams}))

    def test_committed_payload_marks_every_standalone_entry_as_infrastructure(self):
        # An unmatched entry is given type 'infrastructure' so the card and the
        # type vocabulary can say what it is; the code is in the shipped
        # vocabulary, not a bare key.
        #
        # Asserted in both directions, and from the marker rather than from
        # `type` (see the split test above). The version this replaces selected
        # the entries whose type was already 'infrastructure' and then checked
        # that they were infrastructure-ish, so an entry that lost the type
        # simply left the sample and nothing failed.
        data = payload()
        self.assertIn("infrastructure", data["TAXO"]["type"])
        for e in data["TEAMS"]:
            # Scoped to entries that actually carry a facility: `infrastructure`
            # is an ordinary value of the type vocabulary (§3.4) and a team's own
            # YAML may claim it. One does — `dlr-gsoc` is typed infrastructure
            # with no infrastructure entry behind it — so "typed infrastructure"
            # and "came from the infrastructure layer" are not the same set.
            if not e.get("infra"):
                continue
            standalone = e["domain"] in INFRA_CODES
            self.assertEqual(e["type"] == "infrastructure", standalone, e["id"])
            kind_code = GEN.INFRA_KIND.get(e["infra"].get("kind"), "simulation")
            if standalone:
                # Its own kind is the lead: it owns the colour and heads the pie.
                self.assertEqual(e["domains"][0], e["domain"], e["id"])
                self.assertEqual(e["domain"], kind_code, e["id"])
            else:
                # A merged entry's code is appended, never substituted, so the
                # team it enriched still colours the marker (§3.2).
                self.assertEqual(e["domains"][-1], kind_code, e["id"])


class InfraKindLead(TempCheckout):
    """§3.2 + §3.1.1 — the kind of an infrastructure entry is the only source of
    an infrastructure code, so each row of INFRA_KIND is checked end to end."""

    def one(self, kind: str | None) -> dict:
        entry = {"id": "facility", "name": "Facility",
                 "location": {"city": "Trondheim", "country": "NO",
                              "lat": 63.43, "lon": 10.39}}
        if kind is not None:
            entry["kind"] = kind
        return self.build(infrastructure=[entry])["TEAMS"][0]

    def test_compute_cluster_leads_compute(self):
        self.assertEqual(self.one("compute_cluster")["domain"], "compute")

    def test_hosting_leads_compute(self):
        self.assertEqual(self.one("hosting")["domain"], "compute")

    def test_cloud_platform_leads_cluster(self):
        self.assertEqual(self.one("cloud_platform")["domain"], "cluster")

    def test_governance_body_leads_cluster(self):
        # Counter-intuitive and deliberate: a governance body is filed under
        # AI networks & platforms, not under simulation.
        self.assertEqual(self.one("governance_body")["domain"], "cluster")

    def test_testbed_leads_simulation(self):
        self.assertEqual(self.one("testbed")["domain"], "simulation")

    def test_an_unknown_kind_falls_back_to_simulation(self):
        # `INFRA_KIND.get(kind, "simulation")`: a new upstream kind still gets a
        # marker and a filter rather than vanishing.
        self.assertEqual(self.one("quantum_annealer")["domain"], "simulation")

    def test_a_missing_kind_falls_back_to_simulation(self):
        e = self.one(None)
        self.assertEqual(e["domain"], "simulation")
        self.assertEqual(e["domains"], ["simulation"])
        self.assertNotIn("kind", e.get("infra", {}))

    def test_the_lead_survives_alongside_the_entrys_own_sectors(self):
        # An unmatched entry may also declare domains and focus areas; the
        # infrastructure code still leads.
        e = self.build(infrastructure=[{
            "id": "mixed", "name": "Mixed", "kind": "cloud_platform",
            "domains": ["energy"], "focus_areas": ["explainability"],
            "location": {"city": "Graz", "country": "AT", "lat": 47.07, "lon": 15.44},
        }])["TEAMS"][0]
        self.assertEqual(e["domains"], ["cluster", "energy", "xai"])
        self.assertEqual(e["domain"], "cluster")


if __name__ == "__main__":
    unittest.main()
