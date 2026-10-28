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
import unittest

from tests._harness import DATA_JS, load_generator

CHAT = None
GEN = load_generator()


def setUpModule() -> None:
    global CHAT
    from tests._harness import load_chat
    CHAT = load_chat()


def corpus():
    return CHAT.hai_data.load(DATA_JS)


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


if __name__ == "__main__":
    unittest.main()
