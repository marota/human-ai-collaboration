"""Chat: grounding — the chat answers from the map's payload and nothing else.

`chat/hai_data.py` is the only door between the chat and the data. If it reads
the payload wrongly, or retrieval misses what a reader obviously means, the
model has nothing to answer from and fills the gap from memory — which is the
one failure this whole feature is built to avoid. So these tests pin the parse
against the payload's own figures, and the ranking against questions a reader
would actually type, in both languages.

Nothing here needs a model or a network: the corpus is the committed
`assets/map/hai-data.js`.
"""
from __future__ import annotations

import unittest

from tests._harness import DATA_JS, load_payload

CHAT = None


def setUpModule() -> None:
    global CHAT
    from tests._harness import load_chat
    CHAT = load_chat()


class ParsesThePayload(unittest.TestCase):
    """The file is generated JavaScript; reading it back must be exact."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = CHAT.hai_data.load(DATA_JS)
        cls.payload = load_payload()

    def test_every_layer_arrives_whole(self):
        # The arrays end on a trailing comma, which a plain JSON decoder
        # refuses. A silent off-by-one here would drop the last entity of
        # every layer, which no interface test would notice.
        counts = self.corpus.counts()
        for const, layer in (("PROJECTS", "project"), ("TEAMS", "team"),
                             ("COMMONS", "commons"), ("FRAMEWORKS", "framework")):
            self.assertEqual(counts[layer], len(self.payload[const]), layer)
        self.assertEqual(counts["links"], len(self.payload["EDGES"]))
        self.assertEqual(self.corpus.as_of, self.payload["AS_OF"])

    def test_each_entity_carries_its_layer(self):
        self.assertEqual({e["kind"] for e in self.corpus.entities},
                         {"project", "team", "commons", "framework"})
        self.assertEqual(self.corpus.by_id["ai4realnet"]["kind"], "project")

    def test_ids_are_unique_so_a_link_is_unambiguous(self):
        self.assertEqual(len(self.corpus.by_id), len(self.corpus.entities))

    def test_the_vocabulary_comes_across(self):
        self.assertIn("decision_support", self.corpus.taxo["focus"])
        self.assertEqual(self.corpus.taxo["focus"]["oversight"]["fr"],
                         "Supervision humaine")

    def test_edges_become_neighbours_both_ways(self):
        # edges.yml records {project, team}; the chat needs the relation from
        # either end, since "who is in this project" and "which projects is
        # this team in" are the same edge read two ways.
        edge = next(e for e in self.corpus.edges
                    if e["project"] in self.corpus.by_id and e["team"] in self.corpus.by_id)
        self.assertIn(edge["team"],
                      [n["id"] for n in self.corpus.neighbours(edge["project"])])
        self.assertIn(edge["project"],
                      [n["id"] for n in self.corpus.neighbours(edge["team"])])


class FoldsTextForMatching(unittest.TestCase):
    def test_accents_and_case_fall_away(self):
        self.assertEqual(CHAT.hai_data.fold("Université Côte d'Azur"),
                         "universite cote d'azur")

    def test_tokens_drop_both_languages_filler(self):
        got = CHAT.hai_data.tokens("Qui travaille sur the grid in France ?")
        self.assertNotIn("qui", got)
        self.assertNotIn("the", got)
        self.assertIn("travaille", got)
        self.assertIn("grid", got)

    def test_one_letter_noise_is_dropped(self):
        self.assertEqual(CHAT.hai_data.tokens("a l'IA"), ["ia"])


class RanksWhatAReaderMeans(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = CHAT.hai_data.load(DATA_JS)

    def top(self, query, n=5):
        return [e["id"] for _, e in self.corpus.search(query, limit=n)]

    def test_naming_an_entity_puts_it_first(self):
        self.assertEqual(self.top("AI4REALNET")[0], "ai4realnet")
        self.assertEqual(self.top("Grid2Op")[0], "grid2op")

    def test_a_french_question_reaches_a_french_description(self):
        # The corpus carries desc_fr, and a reader asking in French must not be
        # ranked against English text alone.
        self.assertIn("rte-rd-grid-ai",
                      self.top("conduite du réseau électrique en France"))

    def test_an_english_question_reaches_the_same_subject(self):
        self.assertIn("rte-rd-grid-ai", self.top("power grid operations France", 8))

    def test_a_consortium_member_is_findable_by_its_own_name(self):
        # Partner organisations appear only inside a project's consortium list;
        # §16 of the spec treats that as searchable, and so must the chat.
        hits = self.top("Flatland Association", 8)
        self.assertTrue(hits, "a consortium partner must be reachable")

    def test_nothing_matches_nothing(self):
        self.assertEqual(self.corpus.search(""), [])
        self.assertEqual(self.corpus.search("qui est ce que"), [])

    def test_a_layer_filter_holds(self):
        hits = self.corpus.search("grid", limit=6, kinds=["commons"])
        self.assertTrue(hits)
        self.assertTrue(all(e["kind"] == "commons" for _, e in hits))

    def test_lookup_by_name_prefers_the_exact_card(self):
        found = self.corpus.find_by_name("Grid2Op")
        self.assertEqual(found["id"], "grid2op")
        self.assertIsNone(self.corpus.find_by_name(""))


class CountsRatherThanEstimates(unittest.TestCase):
    """The figures block exists because a model cannot count what it has not
    been shown, and will try anyway."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = CHAT.hai_data.load(DATA_JS)

    def test_a_country_named_in_english_or_french_is_counted(self):
        for question in ("how many teams in Germany?", "combien d'équipes en Allemagne ?"):
            self.assertIn("DE", CHAT.hai_data.countries_in(question), question)

    def test_french_prose_is_not_a_country_code(self):
        # "de", "en", "it", "la" are ordinary French words. Folded, they are
        # also country codes, and a chat that answers a question about France
        # with German figures has lost the reader's trust in one turn.
        codes = CHAT.hai_data.countries_in(
            "Qui travaille sur l'aide à la décision en France, dans le domaine de l'énergie ?")
        self.assertEqual(codes, ["FR"])

    def test_an_uppercase_code_still_counts(self):
        self.assertEqual(CHAT.hai_data.countries_in("teams in NL and SE"), ["NL", "SE"])

    def test_the_figures_match_the_corpus(self):
        text = CHAT.hai_data.figures(self.corpus, "teams in France")
        counts = self.corpus.counts()
        self.assertIn(f"{counts['team']} teams", text)
        self.assertIn(self.corpus.as_of, text)
        france = sum(1 for e in self.corpus.entities
                     if (e.get("country") or "").upper() == "FR")
        self.assertIn(f"{france} entities", text)

    def test_a_domain_in_the_question_is_tallied(self):
        text = CHAT.hai_data.figures(self.corpus, "what does the map hold on aviation")
        expect = sum(1 for e in self.corpus.entities
                     if "aviation" in (e.get("domains") or []))
        self.assertIn(f"Domain aviation: {expect} entities.", text)


class RendersCardsForTheModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = CHAT.hai_data.load(DATA_JS)

    def test_a_card_carries_what_an_answer_needs(self):
        text = CHAT.hai_data.render_entity(self.corpus, self.corpus.by_id["ai4realnet"])
        for expected in ("id: ai4realnet", "layer: project", "consortium:", "description:"):
            self.assertIn(expected, text)

    def test_the_description_follows_the_reader_s_language(self):
        card = self.corpus.by_id["3ia-saclay"]
        self.assertIn(card["desc_fr"][:40],
                      CHAT.hai_data.render_entity(self.corpus, card, "fr"))

    def test_an_entity_off_the_map_says_so_rather_than_claiming_a_place(self):
        off = next(e for e in self.corpus.entities if e.get("geo") is False)
        self.assertIn("off the map", CHAT.hai_data.render_entity(self.corpus, off))

    def test_the_retrieved_block_names_the_entities_it_rendered(self):
        block, entities = CHAT.hai_data.retrieved_block(self.corpus, "AI4REALNET", "en", 3)
        self.assertEqual(entities[0]["id"], "ai4realnet")
        self.assertIn("ai4realnet", block)

    def test_the_catalogue_is_one_exact_line_per_entity(self):
        lines = [l for l in CHAT.hai_data.catalogue(self.corpus).splitlines()
                 if l and not l.startswith("###")]
        self.assertEqual(len(lines), len(self.corpus.entities))
        self.assertTrue(all(line.count(" | ") == 2 for line in lines))


class ReadsCoordinatesFromTheCorpus(unittest.TestCase):
    """A proposal for a city the map already covers inherits its coordinates,
    because the alternative is a model inventing a latitude."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = CHAT.hai_data.load(DATA_JS)

    def test_a_known_city_resolves(self):
        cities = self.corpus.cities()
        delft = cities.get(("delft", "NL"))
        self.assertIsNotNone(delft)
        self.assertAlmostEqual(delft[0], 52.0, delta=0.3)
        self.assertAlmostEqual(delft[1], 4.4, delta=0.3)

    def test_an_unknown_city_resolves_to_nothing(self):
        self.assertIsNone(self.corpus.cities().get(("atlantis", "FR")))

    def test_every_coordinate_offered_is_real(self):
        for (city, country), (lat, lon) in self.corpus.cities().items():
            self.assertTrue(-90 <= lat <= 90, city)
            self.assertTrue(-180 <= lon <= 180, city)
            self.assertRegex(country, r"^[A-Z]{2}$")


if __name__ == "__main__":
    unittest.main()
