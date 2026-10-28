"""Chat: the proposal pipeline — intent, grammar, reference, issue.

Three claims are worth pinning here, and none of them needs the model to be
running.

The **grammar** the drafter is constrained to is generated from the same field
table as the form, so the two cannot drift. It also decides what a small model
bothers to fill in: a field that is merely optional comes back empty, and the
contributor inherits the work the draft was supposed to save them.

The **intent** detection has two halves — a control line the model emits, and a
pattern over the reader's own words as a backstop. Both only ever open a panel
the reader can close, so a false positive is cheap and a miss is not.

The **issue** is the only thing this feature produces. It has to carry the YAML,
the reference and its verdict, what changed for a correction, and the review bar
from the data repository's CONTRIBUTING.md — and it must never read as though
the map had already been changed.
"""
from __future__ import annotations

import unittest

from tests._harness import DATA_JS

CHAT = None


def setUpModule() -> None:
    global CHAT
    from tests._harness import load_chat
    CHAT = load_chat()


def corpus():
    return CHAT.hai_data.load(DATA_JS)


class TheGrammarComesFromTheFieldTable(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def schema(self, layer="team", mode="add"):
        return CHAT.prompts.schema_for(layer, self.corpus, mode)

    def test_every_form_field_is_in_the_grammar(self):
        # Otherwise the model cannot fill a field the form shows, and the
        # contributor has to type something the page already knew.
        for layer in CHAT.hai_data.LAYERS:
            schema = self.schema(layer)
            paths = {f["path"] for f in CHAT.cards.spec(layer, self.corpus, "en")}
            for path in paths - {"id", "provenance.added_on", "provenance.added_by",
                                 "location.lat", "location.lon"}:
                node = schema["properties"]
                for part in path.split("."):
                    self.assertIn(part, node, f"{layer}.{path}")
                    node = node[part].get("properties", {})

    def test_coordinates_are_not_in_the_grammar_at_all(self):
        # A model asked for a latitude invents one, and an invented latitude
        # puts a marker in a field outside Ghent. They are looked up from the
        # city instead.
        location = self.schema()["properties"]["location"]["properties"]
        self.assertNotIn("lat", location)
        self.assertNotIn("lon", location)

    def test_the_facts_a_page_always_states_are_required(self):
        schema = self.schema()
        self.assertEqual(set(schema["required"]),
                         {"name", "type", "status", "location", "affiliation",
                          "links", "focus_areas", "domains", "description"})
        # …including inside the nested objects, or a model satisfies the
        # grammar with an empty `location: {}`.
        self.assertEqual(set(schema["properties"]["location"]["required"]),
                         {"country", "city"})
        self.assertEqual(set(schema["properties"]["affiliation"]["required"]),
                         {"org", "url"})

    def test_a_correction_requires_only_the_name(self):
        self.assertEqual(self.schema(mode="fix")["required"], ["name"])

    def test_the_vocabularies_are_enumerated_so_a_code_cannot_be_invented(self):
        schema = self.schema()
        self.assertEqual(set(schema["properties"]["focus_areas"]["items"]["enum"]),
                         set(self.corpus.taxo["focus"]))
        self.assertEqual(set(schema["properties"]["domains"]["items"]["enum"]),
                         set(CHAT.cards.DOMAINS))
        self.assertEqual(set(schema["properties"]["type"]["enum"]),
                         set(CHAT.cards.TEAM_TYPES))

    def test_a_consortium_row_is_shaped_in_the_grammar(self):
        rows = self.schema("project")["properties"]["consortium"]["items"]
        self.assertEqual(rows["required"], ["org"])
        self.assertEqual(set(rows["properties"]["role"]["enum"]), set(CHAT.cards.ROLES))

    def test_a_cluster_member_row_takes_the_cluster_s_own_roles(self):
        # Held to the consortium's roles, the drafter could never write
        # `founder`, and any role but `member` then failed validation.
        rows = self.schema("cluster")["properties"]["members"]["items"]
        self.assertEqual(rows["required"], ["org"])
        self.assertEqual(rows["properties"]["role"]["enum"], list(CHAT.cards.CLUSTER_ROLES))

    def test_a_cluster_s_kind_is_required_and_enumerated(self):
        schema = self.schema("cluster")
        self.assertIn("kind", schema["required"])
        self.assertEqual(schema["properties"]["kind"]["enum"], list(CHAT.cards.KINDS["cluster"]))
        self.assertIn("homepage", schema["required"])
        self.assertNotIn("links", schema["properties"])


class TheSystemPromptHoldsTheModelToTheMap(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def test_it_stays_small_enough_for_a_local_model(self):
        # The catalogue of 450 entities used to live in here. A 12B model handed
        # that much context answers a one-line question by reciting it, which
        # is what a chat that appears to hang actually is.
        text = CHAT.prompts.answer_system(self.corpus, "fr")
        self.assertLess(len(text), 6000)
        self.assertNotIn("3ia-cotedazur", text)

    def test_it_names_the_reader_s_language_and_the_snapshot(self):
        self.assertIn("French", CHAT.prompts.answer_system(self.corpus, "fr"))
        self.assertIn("English", CHAT.prompts.answer_system(self.corpus, "en"))
        self.assertIn(self.corpus.as_of, CHAT.prompts.answer_system(self.corpus, "en"))

    def test_the_figures_and_the_cards_ride_on_the_last_turn(self):
        # The system prompt has to stay byte-identical between turns for
        # Ollama to reuse its cached prefix, which is most of the per-turn cost.
        history = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"},
                   {"role": "user", "content": "who works on grids?"}]
        msgs = CHAT.prompts.answer_messages(self.corpus, history, "en",
                                            "id: rte-rd-grid-ai", "Whole map: 1 team")
        self.assertEqual(msgs[0]["content"], CHAT.prompts.answer_system(self.corpus, "en"))
        self.assertIn("rte-rd-grid-ai", msgs[-1]["content"])
        self.assertIn("Whole map: 1 team", msgs[-1]["content"])
        self.assertIn("who works on grids?", msgs[-1]["content"])

    def test_an_empty_retrieval_says_so_rather_than_leaving_a_blank(self):
        msgs = CHAT.prompts.answer_messages(
            self.corpus, [{"role": "user", "content": "who works on cheese?"}], "en", "")
        self.assertIn("not on the map", msgs[-1]["content"])


class ReadsAnIntentToContribute(unittest.TestCase):
    def test_the_control_line_is_matched_and_stripped(self):
        for text, mode, target in (
                ("[PROPOSE:add:team]\n\nYou want to add…", "add", "team"),
                ("[PROPOSE:fix:rte-rd-grid-ai]\n\nThe status is wrong…", "fix",
                 "rte-rd-grid-ai"),
                ("  [propose:ADD:project] something", "ADD", "project")):
            m = CHAT.prompts.PROPOSE_RE.match(text)
            self.assertIsNotNone(m, text)
            self.assertEqual(m.group(1).lower(), mode.lower())
            self.assertEqual(m.group(2), target)
            self.assertNotIn("PROPOSE", text[m.end():].upper())

    def test_a_token_in_the_middle_of_a_reply_is_not_a_control_line(self):
        self.assertIsNone(CHAT.prompts.PROPOSE_RE.match(
            "I could do that. [PROPOSE:add:team]"))

    def test_the_backstop_reads_both_languages(self):
        for text in ("it is missing from the map", "could you add the L2S team",
                     "il manque le laboratoire X", "ajoute cette équipe"):
            self.assertEqual(CHAT.prompts.sniff_intent(text)[0], "add", text)
        for text in ("the status is wrong", "this is outdated",
                     "la date est fausse", "il faudrait corriger la fiche"):
            self.assertEqual(CHAT.prompts.sniff_intent(text)[0], "fix", text)

    def test_an_ordinary_question_proposes_nothing(self):
        for text in ("who works on grids in France?",
                     "quelles équipes travaillent sur l'aviation ?"):
            self.assertIsNone(CHAT.prompts.sniff_intent(text), text)

    def test_the_name_is_read_from_the_reader_s_own_capitals(self):
        # Only a hint: it pre-fills the name field so the contributor confirms
        # instead of typing. Wrong is cheap; empty is a form asking for
        # something the conversation already said.
        self.assertEqual(
            CHAT.prompts.guess_name("Il manque le groupe Intelligent and Autonomous "
                                    "Systems du CWI, il faudrait l'ajouter."),
            "Intelligent and Autonomous Systems du CWI")
        self.assertEqual(
            CHAT.prompts.guess_name("Il faudrait ajouter le Laboratoire "
                                    "d'Informatique de Grenoble"),
            "Laboratoire d'Informatique de Grenoble")
        # An acronym is a whole name, even alone.
        self.assertEqual(CHAT.prompts.guess_name("ajoute le projet TRUST-AI"), "TRUST-AI")
        self.assertEqual(CHAT.prompts.guess_name("Il manque RTE."), "RTE")

    def test_a_sentence_with_no_name_in_it_yields_none(self):
        # The first word of a sentence is capitalised and is not a name.
        for text in ("the status is wrong", "cette fiche est fausse",
                     "Il faudrait corriger cette fiche"):
            self.assertEqual(CHAT.prompts.guess_name(text), "", text)

    def test_the_layer_is_read_from_the_words_used_for_it(self):
        self.assertEqual(CHAT.prompts.guess_layer("add the AI4REALNET project"), "project")
        self.assertEqual(CHAT.prompts.guess_layer("ajoute le consortium TRUST-AI"), "project")
        self.assertEqual(CHAT.prompts.guess_layer("add the ISO 9241 standard"), "framework")
        self.assertEqual(CHAT.prompts.guess_layer("ajoute ce jeu de données"), "commons")
        self.assertEqual(CHAT.prompts.guess_layer("add Wendy Mackay's group"), "team")

    def test_a_cluster_is_read_before_the_words_its_name_carries(self):
        # A cluster's name holds the other layers' words — projects, Horizon
        # Europe, a community — so it is looked for first.
        for text in ("Il manque le réseau de projets ICT4Water",
                     "add ICT4Water, the cluster of EU-funded water projects",
                     "Il manque l'association ADRA, le côté privé du partenariat "
                     "Horizon Europe sur l'IA",
                     "the Gaia-X association, a community of cloud providers",
                     "add the IDS Association e.V. in Dortmund",
                     "add BDVA, the Big Data Value aisbl",
                     "add CAIRNE, a network of research labs",
                     "il manque le réseau de laboratoires CAIRNE",
                     "ajoute les clusters de projets du programme"):
            with self.subTest(text):
                self.assertEqual(CHAT.prompts.guess_layer(text), "cluster")

    def test_words_that_only_look_like_a_cluster_do_not_make_one(self):
        for text in ("add the Jean Zay GPU cluster at IDRIS",
                     "the clustering research group at Inria",
                     "add the human factors lab at ONERA, which works in association "
                     "with Airbus",
                     "il manque l'équipe X, qui travaille en association avec Airbus",
                     "il manque le réseau électrique de RTE",
                     "add the power network operator Elia"):
            with self.subTest(text):
                self.assertEqual(CHAT.prompts.guess_layer(text), "team")

    def test_the_transcript_keeps_the_conversation_and_drops_the_tokens(self):
        text = CHAT.prompts.transcript_of([
            {"role": "user", "content": "il manque le labo X"},
            {"role": "assistant", "content": "[PROPOSE:add:team]\n\nQuelle page ?"}])
        self.assertIn("Contributor: il manque le labo X", text)
        self.assertIn("Assistant: Quelle page ?", text)
        self.assertNotIn("PROPOSE", text)


class ReadsAReferencePage(unittest.TestCase):
    """The fetch itself needs the network; the reading of a page does not."""

    def test_the_title_and_the_text_come_out_and_the_scripts_do_not(self):
        html = ("<html><head><title>Example Lab — Home</title>"
                "<meta name='description' content='A lab on grid decision support.'>"
                "<style>body{color:red}</style></head>"
                "<body><script>var x = 'not text';</script>"
                "<h1>Example Lab</h1><p>We study control rooms.</p>"
                "<p>And &amp; entities.</p></body></html>")
        title, text = CHAT.reference._text_of(html)
        self.assertEqual(title, "Example Lab — Home")
        self.assertIn("We study control rooms.", text)
        self.assertIn("And & entities.", text)
        self.assertNotIn("not text", text)
        self.assertNotIn("color:red", text)
        self.assertIn("A lab on grid decision support.", text)

    def test_a_page_about_the_entity_confirms_it(self):
        self.assertTrue(CHAT.reference._confirms(
            "CWI — Intelligent and Autonomous Systems",
            "Intelligent and Autonomous Systems group at CWI in Amsterdam"))

    def test_a_page_about_something_else_does_not(self):
        self.assertFalse(CHAT.reference._confirms(
            "Example Grid Lab", "Recipes for sourdough bread, and a newsletter"))

    def test_an_accented_name_still_matches(self):
        self.assertTrue(CHAT.reference._confirms(
            "Université Côte d'Azur", "universite cote d azur campus"))

    def test_a_host_inside_this_machine_is_refused(self):
        # A chat box that will fetch any URL must not become a way to read the
        # network the server sits on.
        for url in ("http://localhost:8765/api/health", "http://127.0.0.1/",
                    "http://[::1]:22/"):
            with self.assertRaises(CHAT.reference.ReferenceError, msg=url):
                CHAT.reference._check_host(url)

    def test_a_scheme_that_is_not_the_web_is_refused(self):
        for url in ("file:///etc/passwd", "ftp://example.org/x", "data:text/html,x"):
            with self.assertRaises(CHAT.reference.ReferenceError, msg=url):
                CHAT.reference._check_host(url)

    def test_the_verdict_is_a_sentence_the_contributor_can_act_on(self):
        ok = {"ok": True, "confirms": True, "title": "Example Lab"}
        self.assertIn("Example Lab", CHAT.reference.summary(ok, "Example Lab", "en"))
        miss = {"ok": True, "confirms": False, "title": "Something else"}
        self.assertIn("does not appear", CHAT.reference.summary(miss, "Example Lab", "en"))
        broken = {"ok": False, "error": "The page answered 404."}
        self.assertIn("404", CHAT.reference.summary(broken, "Example Lab", "en"))
        self.assertIn("404", CHAT.reference.summary(broken, "Example Lab", "fr"))


def good_card():
    return {
        "id": "example-grid-lab", "name": "Example Grid Lab", "type": "research_lab",
        "status": "active",
        "location": {"country": "NL", "city": "Delft", "lat": 52.0, "lon": 4.37},
        "affiliation": {"org": "Example University", "url": "https://example.org"},
        "focus_areas": ["decision_support"], "domains": ["power_grid"],
        "links": {"homepage": "https://example.org/lab"},
        "description": "A lab working on control-room decision support for grid operators.",
        "provenance": {"added_by": "someone", "source": "https://example.org/lab",
                       "confidence": "medium"},
    }


class WritesAnIssueAMaintainerCanActuponWithoutAsking(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = corpus()

    def body(self, mode="add", layer="team", card=None, **kw):
        card = card if card is not None else good_card()
        opts = {"reference": {"url": "https://example.org/lab", "title": "Example Lab",
                              "confirms": True, "status": 200,
                              "fetched_at": "2026-10-26T12:00:00"},
                "report": CHAT.cards.validate(layer, card, self.corpus, mode, "en").as_json(),
                "changed": None, "transcript": "Contributor: it is missing",
                "lang": "en", "as_of": self.corpus.as_of}
        opts.update(kw)
        return CHAT.issues.body_for(mode, layer, card, **opts)

    def test_the_title_says_what_it_is(self):
        self.assertEqual(
            CHAT.issues.title_for("add", "team", good_card()),
            "Map data: add Example Grid Lab (team)")
        self.assertIn("fix status", CHAT.issues.title_for(
            "fix", "team", good_card(), [{"path": "status"}]))

    def test_the_yaml_is_in_the_body_as_yaml(self):
        body = self.body()
        self.assertIn("```yaml", body)
        self.assertIn("id: example-grid-lab", body)

    def test_the_file_it_would_become_is_named_in_the_data_repository(self):
        body = self.body()
        self.assertIn("data/teams/example-grid-lab.yml", body)
        self.assertIn(CHAT.issues.DATA_REPO, body)

    def test_the_reference_and_its_verdict_are_both_recorded(self):
        self.assertIn("the page names the entity", self.body())
        self.assertIn("does not name the entity",
                      self.body(reference={"url": "https://example.org", "confirms": False,
                                           "status": 200, "fetched_at": "x"}))

    def test_a_proposal_with_no_reference_says_so_plainly(self):
        self.assertIn("None supplied", self.body(reference=None))

    def test_a_correction_carries_a_before_and_after_table(self):
        body = self.body(mode="fix", changed=[
            {"path": "status", "before": "active", "after": "concluded"}])
        self.assertIn("| Field | On the map | Proposed |", body)
        self.assertIn("| `status` | active | concluded |", body)
        self.assertIn(self.corpus.as_of, body)

    def test_a_pipe_in_a_value_cannot_break_the_table(self):
        body = self.body(mode="fix", changed=[
            {"path": "name", "before": "A | B", "after": "C"}])
        self.assertIn("A \\| B", body)

    def test_the_review_bar_is_the_data_repository_s_own(self):
        body = self.body()
        for item in ("Scope fit", "Verifiability", "Taxonomy", "Coordinates"):
            self.assertIn(item, body)

    def test_failed_checks_are_shown_rather_than_hidden(self):
        card = good_card()
        del card["type"]
        body = self.body(card=card)
        self.assertIn("**fail**", body)
        self.assertIn("`type`", body)

    def test_the_french_description_is_routed_to_the_i18n_file(self):
        card = good_card()
        card["description_fr"] = "Un laboratoire sur la conduite de réseau."
        body = self.body(card=card)
        self.assertIn("data/i18n/descriptions.fr.yml", body)
        self.assertIn("example-grid-lab: |", body)

    def test_the_conversation_is_attached_but_folded_away(self):
        self.assertIn("<details><summary>", self.body())
        self.assertIn("Contributor: it is missing", self.body())

    def test_it_never_claims_the_map_was_changed(self):
        # The chat has no write access to anything. An issue that reads as a
        # fait accompli would get committed without the review it needs.
        body = self.body()
        self.assertIn("Nothing has been changed on the map.", body)
        self.assertIn("reviewed on screen by the contributor", body)


if __name__ == "__main__":
    unittest.main()
