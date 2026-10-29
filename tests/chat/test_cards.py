"""Chat: the proposed card — its field table, its checks, and its YAML.

A proposal leaves the chat as YAML in a GitHub issue, and the next pair of eyes
on it is a maintainer deciding whether to commit it. So two things have to
hold. The checks must be the ones upstream CI would run — a proposal that
passes here and fails there wastes the contributor's goodwill and the
maintainer's time. And the YAML must read like the hand-written files it will
sit beside: same field names, same order, same block scalars.

`chat/cards.py` has no model and no network in it, which is why all of this is
assertable from a committed payload alone.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import unittest
from pathlib import Path

from tests._harness import DATA_JS, load_generator, load_payload

CHAT = None
GEN = load_generator()


def setUpModule() -> None:
    global CHAT
    from tests._harness import load_chat
    CHAT = load_chat()


def corpus():
    return CHAT.hai_data.load(DATA_JS)


def upstream_schema(name):
    """A JSON Schema from the eu-hai-collab-map checkout, when there is one here.

    Looked for where the generator looks for the checkout ($EU_HAI_MAP_REPO,
    then the usual places), so a test that needs it runs wherever the map can
    be built and is skipped, saying so, everywhere else.
    """
    roots = [Path(os.environ["EU_HAI_MAP_REPO"]).expanduser()] \
        if os.environ.get("EU_HAI_MAP_REPO") else []
    for root in roots + list(GEN.CANDIDATE_SOURCES):
        path = root / "schemas" / name
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return None


def cluster_card():
    """A whole cluster card, with every value YAML 1.1 likes to misread."""
    return {
        "id": "example-water-cluster",
        "name": "Example Water Cluster",
        "kind": "project_cluster",
        "status": "active",
        "homepage": "https://example.org/cluster",
        "location": {"country": "NO", "city": "Oslo", "lat": 59.91, "lon": 10.75},
        "timeline": {"start": "2019"},
        "members": [{"org": "Example University", "role": "founder", "country": "NO"},
                    {"org": "Example Utility", "role": "member", "country": "DE"}],
        "size_indicator": "180",
        "description": "A cluster of funded projects on decision support for water networks.",
        "provenance": {"added_by": "someone", "source": "https://example.org/cluster",
                       "confidence": "medium"},
    }


class VocabularyStaysInStepWithTheGenerator(unittest.TestCase):
    """The one place the chat repeats something the repository already knows."""

    def test_the_domain_list_is_the_generator_s_own(self):
        # `SECTOR` maps every upstream `domains` value to a sector code, so its
        # keys are the authority on what that field may contain. cards.DOMAINS
        # is a copy, for a server that must run without PyYAML; this test is
        # what keeps the copy honest. A domain added upstream changes SECTOR,
        # fails here, and the form gains the value in the same commit.
        self.assertEqual(sorted(CHAT.cards.DOMAINS), sorted(GEN.SECTOR))

    def test_the_focus_vocabulary_is_read_from_the_payload_not_copied(self):
        fields = {f["path"]: f for f in CHAT.cards.spec("team", corpus(), "en")}
        self.assertEqual(sorted(fields["focus_areas"]["vocab"]),
                         sorted(GEN.TAXO["focus"]))

    def test_statuses_and_types_match_the_schemas_upstream(self):
        self.assertEqual(sorted(CHAT.cards.STATUSES), sorted(GEN.TAXO["status"]))
        self.assertTrue(set(CHAT.cards.TEAM_TYPES) <= set(GEN.TAXO["kind"])
                        | set(GEN.TAXO["type"]))

    def test_the_cluster_vocabularies(self):
        self.assertEqual(CHAT.cards.KINDS["cluster"], ("association", "network", "project_cluster"))
        self.assertEqual(CHAT.cards.CLUSTER_ROLES, ("founder", "member"))
        on_map = {e["kind"] for e in load_payload()["CLUSTERS"] if e.get("kind")}
        self.assertTrue(on_map <= set(CHAT.cards.KINDS["cluster"]), on_map)

    def test_the_cluster_vocabularies_are_the_data_repository_s(self):
        schema = upstream_schema("cluster.schema.json")
        if schema is None:
            self.skipTest("no eu-hai-collab-map checkout with schemas/cluster.schema.json")
        self.assertEqual(list(CHAT.cards.KINDS["cluster"]), schema["properties"]["kind"]["enum"])
        roles = schema["properties"]["members"]["items"]["properties"]["role"]["enum"]
        self.assertEqual(list(CHAT.cards.CLUSTER_ROLES), [r for r in roles if r is not None])


class TheFieldTableDrivesTheForm(unittest.TestCase):
    def test_every_layer_has_a_table(self):
        for layer in CHAT.hai_data.LAYERS:
            fields = CHAT.cards.spec(layer, corpus(), "en")
            self.assertTrue(fields, layer)
            paths = [f["path"] for f in fields]
            self.assertEqual(len(paths), len(set(paths)), f"{layer} repeats a field")
            self.assertIn("description", paths)
            self.assertIn("provenance.source", paths)

    def test_the_labels_are_translated(self):
        en = {f["path"]: f["label"] for f in CHAT.cards.spec("team", corpus(), "en")}
        fr = {f["path"]: f["label"] for f in CHAT.cards.spec("team", corpus(), "fr")}
        self.assertEqual(en["location.country"], "Country")
        self.assertEqual(fr["location.country"], "Pays")

    def test_required_fields_are_the_schema_s_required_fields(self):
        required = {f["path"] for f in CHAT.cards.spec("team", corpus(), "en")
                    if f["required"]}
        # team.schema.json: id, name, type, status, location, affiliation,
        # focus_areas, domains, links, description, provenance.
        for path in ("id", "name", "type", "status", "location.city",
                     "location.country", "affiliation.org", "links.homepage",
                     "focus_areas", "domains", "description"):
            self.assertIn(path, required)

    def test_an_unknown_layer_is_refused_rather_than_guessed(self):
        with self.assertRaises(ValueError):
            CHAT.cards.spec("campus", corpus(), "en")


def good_card():
    return {
        "id": "example-grid-lab",
        "name": "Example Grid Lab",
        "type": "research_lab",
        "status": "active",
        "location": {"country": "NL", "city": "Delft", "lat": 52.0, "lon": 4.37},
        "affiliation": {"org": "Example University", "url": "https://example.org"},
        "focus_areas": ["decision_support"],
        "domains": ["power_grid"],
        "links": {"homepage": "https://example.org/lab"},
        "description": "A lab working on control-room decision support for grid operators.",
        "provenance": {"added_by": "someone", "source": "https://example.org/lab",
                       "confidence": "medium"},
    }


class ChecksWhatUpstreamWouldCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def check(self, card, mode="add", lang="en", layer="team"):
        return CHAT.cards.validate(layer, card, self.corpus, mode, lang)

    def paths(self, report):
        return {e["path"] for e in report.errors}

    def test_a_complete_card_passes(self):
        self.assertTrue(self.check(good_card()).ok)

    def test_a_missing_required_field_is_named(self):
        card = good_card()
        del card["type"]
        self.assertIn("type", self.paths(self.check(card)))

    def test_the_message_follows_the_reader_s_language(self):
        card = good_card()
        del card["type"]
        self.assertIn("obligatoire", self.check(card, lang="fr").errors[0]["message"])

    def test_an_id_already_on_the_map_is_refused(self):
        card = good_card()
        card["id"] = "ai4realnet"
        self.assertIn("id", self.paths(self.check(card)))

    def test_a_slug_with_spaces_or_capitals_is_refused(self):
        for bad in ("Example Lab", "example_lab", "-example", "éxample"):
            card = good_card()
            card["id"] = bad
            self.assertIn("id", self.paths(self.check(card)), bad)

    def test_a_focus_area_outside_the_vocabulary_is_refused(self):
        card = good_card()
        card["focus_areas"] = ["decision_support", "vibes"]
        report = self.check(card)
        self.assertIn("focus_areas", self.paths(report))
        self.assertIn("vibes", report.errors[0]["message"])

    def test_a_url_without_a_scheme_is_refused(self):
        card = good_card()
        card["links"]["homepage"] = "example.org/lab"
        self.assertIn("links.homepage", self.paths(self.check(card)))

    def test_a_country_must_be_two_capitals(self):
        card = good_card()
        card["location"]["country"] = "Netherlands"
        self.assertIn("location.country", self.paths(self.check(card)))

    def test_coordinates_off_the_globe_are_refused(self):
        card = good_card()
        card["location"]["lat"] = 152
        self.assertIn("location.lat", self.paths(self.check(card)))

    def test_a_description_too_short_to_be_one_is_refused(self):
        card = good_card()
        card["description"] = "A lab."
        self.assertIn("description", self.paths(self.check(card)))

    def test_a_project_id_that_names_no_card_is_refused(self):
        card = good_card()
        card["project_ids"] = ["ai4realnet", "not-a-project"]
        report = self.check(card)
        self.assertIn("project_ids", self.paths(report))
        self.assertIn("not-a-project", report.errors[0]["message"])

    def test_a_correction_is_not_asked_for_fields_it_does_not_touch(self):
        # The whole point of a correction is to carry the few fields that
        # change. Demanding the rest would make every typo a full re-entry.
        partial = {"id": "ai4realnet", "name": "AI4RealNet", "status": "concluded"}
        self.assertTrue(self.check(partial, mode="fix", layer="project").ok)

    def test_a_consortium_row_without_an_organisation_is_refused(self):
        card = {"id": "x-project", "name": "X", "status": "active",
                "homepage": "https://example.org", "timeline": {"start": "2024"},
                "description": "A project about operator decision support in grids.",
                "provenance": {"added_by": "a", "source": "b", "confidence": "low"},
                "consortium": [{"role": "partner", "country": "FR"}]}
        self.assertIn("consortium", self.paths(
            CHAT.cards.validate("project", card, self.corpus, "add", "en")))

    def test_a_consortium_role_outside_the_vocabulary_is_refused(self):
        card = {"id": "x-project", "name": "X", "status": "active",
                "homepage": "https://example.org", "timeline": {"start": "2024"},
                "description": "A project about operator decision support in grids.",
                "provenance": {"added_by": "a", "source": "b", "confidence": "low"},
                "consortium": [{"org": "Someone", "role": "sponsor"}]}
        self.assertIn("consortium", self.paths(
            CHAT.cards.validate("project", card, self.corpus, "add", "en")))

    def test_the_project_schema_roles_third_party_and_observer_are_accepted(self):
        # The data repository's project schema allows both, and since the
        # October 2026 review a CORDIS linked third party is written
        # `third_party` on 115 consortium lines. Refusing them here would turn
        # every correction to one of those projects into an error the
        # contributor cannot fix from the form.
        card = {"id": "x-project", "name": "X", "status": "active",
                "homepage": "https://example.org", "timeline": {"start": "2024"},
                "description": "A project about operator decision support in grids.",
                "provenance": {"added_by": "a", "source": "b", "confidence": "low"},
                "consortium": [{"org": "A", "role": "coordinator", "country": "FR"},
                               {"org": "B", "role": "third_party", "country": "DE"},
                               {"org": "C", "role": "observer", "country": "BE"}]}
        self.assertNotIn("consortium", self.paths(
            CHAT.cards.validate("project", card, self.corpus, "add", "en")))

    def test_a_complete_cluster_card_passes(self):
        card = CHAT.cards.fill_defaults("cluster", cluster_card(), self.corpus)
        self.assertTrue(self.check(card, layer="cluster").ok)

    def test_a_cluster_member_may_be_a_founder(self):
        card = cluster_card()
        card["members"] = [{"org": "Example University", "role": "founder", "country": "FI"}]
        self.assertNotIn("members", self.paths(self.check(card, layer="cluster")))

    def test_a_cluster_member_is_no_coordinator(self):
        # A cluster's members founded it or joined it; a consortium's roles
        # are refused, with the message that names the cluster's own.
        card = cluster_card()
        card["members"] = [{"org": "Example University", "role": "coordinator"}]
        errors = [e for e in self.check(card, layer="cluster").errors if e["path"] == "members"]
        self.assertEqual([e["message"] for e in errors], [CHAT.cards._MSG["role_cluster"][0]])
        self.assertIn("founder/member", errors[0]["message"])
        fr = self.check(card, lang="fr", layer="cluster").errors
        self.assertIn(CHAT.cards._MSG["role_cluster"][1], [e["message"] for e in fr])

    def test_an_organisation_row_s_country_is_two_capitals(self):
        for layer, key in (("cluster", "members"), ("project", "consortium")):
            for bad in ("no", "Norway", "N0"):
                card = cluster_card() if layer == "cluster" else {
                    "id": "x-project", "name": "X", "status": "active",
                    "homepage": "https://example.org", "timeline": {"start": "2024"},
                    "description": "A project about operator decision support in grids.",
                    "provenance": {"added_by": "a", "source": "b", "confidence": "low"}}
                card[key] = [{"org": "A", "country": bad}]
                with self.subTest(layer=layer, country=bad):
                    errors = [e for e in self.check(card, layer=layer).errors
                              if e["path"] == key]
                    self.assertEqual([e["message"] for e in errors],
                                     [CHAT.cards._MSG["country"][0]])


class WarnsWhereAMaintainerWould(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def warnings(self, card):
        return [w["message"] for w in
                CHAT.cards.validate("team", card, self.corpus, "add", "en").warnings]

    def test_a_card_that_already_exists_under_another_name_is_flagged(self):
        card = good_card()
        card["id"] = "rte-grid"
        card["name"] = "RTE — R&D Grid AI"
        self.assertTrue(any("Similar cards" in w for w in self.warnings(card)))

    def test_a_shared_ordinary_word_is_not_a_duplicate(self):
        # "grid" appears in dozens of names. A warning that fires on every
        # proposal is a warning nobody reads.
        card = good_card()
        card["name"] = "Example Grid Lab"
        self.assertFalse(any("Similar cards" in w for w in self.warnings(card)))

    def test_low_confidence_is_allowed_and_explained(self):
        card = good_card()
        card["provenance"]["confidence"] = "low"
        report = CHAT.cards.validate("team", card, self.corpus, "add", "en")
        self.assertTrue(report.ok)
        self.assertTrue(any("Low confidence" in w["message"] for w in report.warnings))


class FillsInWhatItCanCompute(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def test_a_slug_is_derived_from_the_name(self):
        card = CHAT.cards.fill_defaults(
            "team", {"name": "Université Côte d'Azur — Grid AI"}, self.corpus)
        self.assertEqual(card["id"], "universite-cote-d-azur-grid-ai")

    def test_a_slug_never_collides_with_the_map(self):
        taken = self.corpus.by_id
        self.assertEqual(CHAT.cards.slugify("Grid2Op", taken), "grid2op-2")

    def test_coordinates_come_from_a_city_the_map_already_knows(self):
        card = CHAT.cards.fill_defaults(
            "team", {"name": "New Lab", "location": {"city": "Delft", "country": "NL"}},
            self.corpus)
        self.assertAlmostEqual(card["location"]["lat"], 52.0, delta=0.3)

    def test_an_unknown_city_leaves_the_coordinates_for_the_contributor(self):
        card = CHAT.cards.fill_defaults(
            "team", {"name": "New Lab", "location": {"city": "Atlantis", "country": "FR"}},
            self.corpus)
        self.assertNotIn("lat", card["location"])

    def test_the_date_is_today_and_the_source_is_the_reference(self):
        card = CHAT.cards.fill_defaults("team", {"name": "New Lab"}, self.corpus,
                                        {"url": "https://example.org", "confirms": True})
        self.assertEqual(card["provenance"]["added_on"], dt.date.today().isoformat())
        self.assertEqual(card["provenance"]["source"], "https://example.org")
        self.assertEqual(card["provenance"]["confidence"], "medium")

    def test_without_a_reference_the_confidence_is_low(self):
        card = CHAT.cards.fill_defaults("team", {"name": "New Lab"}, self.corpus)
        self.assertEqual(card["provenance"]["confidence"], "low")

    def test_a_cluster_s_homepage_is_top_level_as_its_schema_has_it(self):
        card = CHAT.cards.fill_defaults("cluster", {"name": "New Cluster"}, self.corpus,
                                        {"url": "https://example.org", "confirms": True})
        self.assertEqual(card["homepage"], "https://example.org")
        self.assertNotIn("links", card)

    def test_what_the_contributor_wrote_is_never_overwritten(self):
        card = CHAT.cards.fill_defaults(
            "team", {"name": "New Lab", "id": "my-own-slug",
                     "provenance": {"confidence": "high", "source": "a paper"}},
            self.corpus, {"url": "https://example.org", "confirms": True})
        self.assertEqual(card["id"], "my-own-slug")
        self.assertEqual(card["provenance"]["confidence"], "high")
        self.assertEqual(card["provenance"]["source"], "a paper")


class ReadsACardBackForCorrection(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def test_the_map_s_compact_keys_come_back_as_upstream_field_names(self):
        card = self.corpus.by_id["rte-rd-grid-ai"]
        values = CHAT.cards.current_values("team", card)
        self.assertEqual(values["description"], card["desc"])
        self.assertEqual(values["focus_areas"], card["focus"])
        self.assertEqual(values["location"]["city"], card["city"])
        self.assertEqual(values["provenance"]["added_by"], card["prov"]["by"])
        self.assertEqual(values["links"]["homepage"], card["url"])

    def test_a_project_s_homepage_is_top_level_as_its_schema_has_it(self):
        values = CHAT.cards.current_values("project", self.corpus.by_id["ai4realnet"])
        self.assertIn("homepage", values)
        self.assertNotIn("links", values)
        self.assertTrue(values["consortium"][0]["org"])

    def test_a_cluster_comes_back_with_its_kind_and_a_top_level_homepage(self):
        # The layer used to overwrite the payload's kind, so a correction to a
        # cluster had an empty required Kind, and its YAML no `kind` at all.
        raw = next(e for e in load_payload()["CLUSTERS"] if e["id"] == "adra")
        values = CHAT.cards.current_values("cluster", self.corpus.by_id["adra"])
        self.assertEqual(values["kind"], "association")
        self.assertEqual(values["kind"], raw["kind"])
        self.assertEqual(values["homepage"], raw["url"])
        self.assertNotIn("links", values)
        if raw.get("size"):
            self.assertEqual(values["size_indicator"], raw["size"])
        else:
            self.assertNotIn("size_indicator", values)

    def test_a_cluster_s_membership_and_members_come_back(self):
        clusters = load_payload()["CLUSTERS"]
        sized = [e for e in clusters if e.get("size")]
        self.assertTrue(sized, "some cluster on the map records its membership")
        for raw in sized:
            values = CHAT.cards.current_values("cluster", self.corpus.by_id[raw["id"]])
            self.assertEqual(values["size_indicator"], raw["size"], raw["id"])
        for raw in (e for e in clusters if e.get("members")):
            values = CHAT.cards.current_values("cluster", self.corpus.by_id[raw["id"]])
            self.assertEqual([m["org"] for m in values["members"]],
                             [m["org"] for m in raw["members"]], raw["id"])

    def test_every_layer_with_a_kind_reads_its_own_back(self):
        payload = load_payload()
        for const, layer in (("PROJECTS", "project"), ("CLUSTERS", "cluster"),
                             ("COMMONS", "commons"), ("FRAMEWORKS", "framework")):
            with self.subTest(layer):
                raws = [e for e in payload[const] if e.get("kind") in CHAT.cards.KINDS[layer]]
                self.assertTrue(raws)
                for raw in raws:
                    values = CHAT.cards.current_values(layer, self.corpus.by_id[raw["id"]])
                    self.assertEqual(values.get("kind"), raw["kind"], raw["id"])
        # A team has a type, not a kind, and is never handed one.
        team = next(e for e in self.corpus.entities if e["kind"] == "team")
        self.assertNotIn("kind", CHAT.cards.current_values("team", team))

    def test_a_team_s_type_and_a_commons_size_come_back(self):
        # Both forms ask for these, and both are on the card the reader saw; a
        # correction that started without them had a blank required Type.
        payload = load_payload()
        for raw in payload["TEAMS"][:20]:
            values = CHAT.cards.current_values("team", self.corpus.by_id[raw["id"]])
            self.assertEqual(values.get("type"), raw.get("type") or None, raw["id"])
        sized = [e for e in payload["COMMONS"] if e.get("size")]
        self.assertTrue(sized, "some commons on the map records its size")
        for raw in sized:
            values = CHAT.cards.current_values("commons", self.corpus.by_id[raw["id"]])
            self.assertEqual(values["size_indicator"], raw["size"], raw["id"])

    def test_a_cluster_read_back_passes_its_own_checks(self):
        for e in (e for e in self.corpus.entities if e["kind"] == "cluster"):
            values = CHAT.cards.current_values("cluster", e)
            report = CHAT.cards.validate("cluster", values, self.corpus, "fix", "en")
            self.assertTrue(report.ok, (e["id"], report.errors))

    def test_a_diff_names_only_what_moved(self):
        before = CHAT.cards.current_values("team", self.corpus.by_id["rte-rd-grid-ai"])
        after = dict(before, status="concluded")
        rows = CHAT.cards.diff(before, after, "team")
        self.assertEqual([r["path"] for r in rows], ["status"])
        self.assertEqual(rows[0]["before"], "active")

    def test_an_empty_proposed_value_is_not_a_change(self):
        before = CHAT.cards.current_values("team", self.corpus.by_id["rte-rd-grid-ai"])
        after = dict(before)
        after["status"] = ""
        self.assertEqual(CHAT.cards.diff(before, after, "team"), [])


class WritesYamlThatReadsLikeTheRepository(unittest.TestCase):
    def test_the_key_order_is_the_template_s(self):
        text = CHAT.cards.to_yaml(good_card(), "team")
        order = [line.split(":")[0] for line in text.splitlines()
                 if line and not line.startswith((" ", "-"))]
        self.assertEqual(order[:4], ["id", "name", "type", "status"])
        self.assertEqual(order[-2:], ["description", "provenance"])

    def test_nested_objects_are_indented_not_inlined(self):
        text = CHAT.cards.to_yaml(good_card(), "team")
        # country before city, as data/teams/_template.yml writes it.
        self.assertIn("location:\n  country: NL\n  city: Delft\n", text)
        self.assertIn("focus_areas:\n  - decision_support\n", text)

    def test_a_long_description_becomes_a_block_scalar(self):
        card = good_card()
        card["description"] = ("A lab working on control-room decision support for grid "
                               "operators, with a long enough description that keeping it "
                               "on one line would wrap badly in a diff.")
        text = CHAT.cards.to_yaml(card, "team")
        self.assertIn("description: |\n  A lab working", text)

    def test_a_value_that_could_break_yaml_is_quoted(self):
        card = good_card()
        card["name"] = "Lab: the sequel"
        self.assertIn('name: "Lab: the sequel"', CHAT.cards.to_yaml(card, "team"))

    def test_a_consortium_is_a_list_of_mappings(self):
        card = {"id": "x", "name": "X",
                "consortium": [{"org": "A", "role": "coordinator", "country": "FR"},
                               {"org": "B", "role": "partner", "country": "DE"}]}
        text = CHAT.cards.to_yaml(card, "project")
        self.assertIn("consortium:\n  - org: A\n", text)
        self.assertIn("    role: coordinator\n", text)

    def test_empty_values_are_left_out_rather_than_written_as_blanks(self):
        card = good_card()
        card["tier"] = ""
        card["project_ids"] = []
        text = CHAT.cards.to_yaml(card, "team")
        self.assertNotIn("tier", text)
        self.assertNotIn("project_ids", text)

    def test_the_french_description_is_not_in_the_card(self):
        # Upstream keeps translations in data/i18n/descriptions.fr.yml, keyed on
        # the slug. Writing it into the card would fail schema validation on a
        # field that does not exist there.
        card = good_card()
        card["description_fr"] = "Un laboratoire."
        self.assertNotIn("description_fr", CHAT.cards.to_yaml(card, "team"))

    def test_the_yaml_round_trips_through_a_real_parser(self):
        import yaml
        card = good_card()
        card["description"] = "A lab working on grid decision support.\n\nSecond paragraph."
        card["name"] = "Lab: the sequel — \"quoted\""
        loaded = yaml.safe_load(CHAT.cards.to_yaml(card, "team"))
        self.assertEqual(loaded["name"], card["name"])
        self.assertEqual(loaded["location"]["lat"], 52.0)
        self.assertEqual(loaded["focus_areas"], ["decision_support"])
        self.assertIn("Second paragraph.", loaded["description"])

    def test_a_string_yaml_would_read_as_something_else_is_quoted(self):
        # Written plain, a year is an int, a date a date, Norway's code a
        # boolean and "null" nothing — each one fails a schema that asks for a
        # string.
        import yaml
        for value in ("2019", "2026-10-28", "NO", "no", "Yes", "off", "TRUE", "null", "y",
                      "180", "1.5", "1_000", "0x1F", "1e5", "Lab "):
            with self.subTest(value):
                text = CHAT.cards.to_yaml({"id": "x", "name": value}, "team")
                self.assertEqual(yaml.safe_load(text)["name"], value)
        # …and one that reads back as itself stays plain, so the file keeps the
        # look of the hand-written ones beside it.
        for value in ("NL", "Delft", "2018-12", "research_lab", "CC-BY-4.0"):
            self.assertIn(f"name: {value}\n",
                          CHAT.cards.to_yaml({"id": "x", "name": value}, "team"))

    def cluster_yaml(self):
        import yaml
        card = CHAT.cards.fill_defaults("cluster", cluster_card(), corpus())
        return yaml.safe_load(CHAT.cards.to_yaml(card, "cluster"))

    def test_a_cluster_card_comes_back_with_strings_where_its_schema_wants_them(self):
        loaded = self.cluster_yaml()
        self.assertEqual(loaded["timeline"]["start"], "2019")
        self.assertEqual(loaded["provenance"]["added_on"], dt.date.today().isoformat())
        self.assertEqual(loaded["location"]["country"], "NO")
        self.assertEqual([m["country"] for m in loaded["members"]], ["NO", "DE"])
        self.assertEqual(loaded["size_indicator"], "180")
        self.assertEqual(loaded["location"]["lat"], 59.91)

    def test_a_cluster_card_validates_against_the_data_repository_s_schema(self):
        schema = upstream_schema("cluster.schema.json")
        if schema is None:
            self.skipTest("no eu-hai-collab-map checkout with schemas/cluster.schema.json")
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema is not installed")
        validator = jsonschema.Draft202012Validator(
            schema, format_checker=jsonschema.FormatChecker())
        errors = [f"{'.'.join(map(str, e.absolute_path))}: {e.message}"
                  for e in validator.iter_errors(self.cluster_yaml())]
        self.assertEqual(errors, [])

    def test_a_cluster_s_members_are_written_where_the_template_has_them(self):
        text = CHAT.cards.to_yaml(cluster_card(), "cluster")
        order = [line.split(":")[0] for line in text.splitlines()
                 if line and not line.startswith((" ", "-"))]
        self.assertLess(order.index("members"), order.index("timeline"))
        self.assertEqual(order[-2:], ["description", "provenance"])


if __name__ == "__main__":
    unittest.main()
