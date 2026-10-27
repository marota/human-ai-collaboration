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

import re
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

    def test_a_question_about_age_gets_the_ends_of_the_timeline(self):
        # No card contains the word "oldest", so retrieval returns noise and a
        # model held to its cards says the map holds no dates — while the
        # period filter of §10 is built on them.
        text = CHAT.hai_data.figures(self.corpus, "quel est le projet le plus ancien ?")
        self.assertIn("Earliest projects by start year:", text)
        self.assertIn("Most recent projects:", text)

    def test_the_earliest_are_in_order_and_are_really_the_earliest(self):
        text = CHAT.hai_data.figures(self.corpus, "what is the oldest team?")
        line = next(l for l in text.splitlines() if l.startswith("Earliest"))
        years = [int(y) for y in re.findall(r", (\d{4})\)?", line)]
        self.assertEqual(years, sorted(years))
        teams = [(CHAT.hai_data._start_year(e), e) for e in self.corpus.entities
                 if e["kind"] == "team" and not e.get("dateHost")]
        truly = min(y for y, _ in teams if y is not None)
        self.assertEqual(years[0], truly)

    def test_a_host_institution_s_founding_year_is_never_read_as_the_entity_s(self):
        # §10.1: that year is a floor, not a start. A university founded in
        # 1923 must not be reported as the oldest lab on the map.
        text = CHAT.hai_data.figures(self.corpus, "oldest entity on the map?")
        line = next(l for l in text.splitlines() if l.startswith("Earliest"))
        for e in self.corpus.entities:
            if e.get("dateHost"):
                self.assertNotIn(f"(#{e['id']})", line, e["id"])
        self.assertIn("host institution's founding rather than their own", text)

    def test_the_entities_are_written_as_card_links(self):
        # A model copies the shape it is given: `Name (#id)` copied verbatim is
        # a dead string where `[Name](#id)` is a card the reader can open.
        text = CHAT.hai_data.figures(self.corpus, "oldest project?")
        line = next(l for l in text.splitlines() if l.startswith("Earliest"))
        ids = re.findall(r"\[[^\]]+\]\(#([a-z0-9-]+)\)", line)
        self.assertTrue(ids)
        for entity_id in ids:
            self.assertIn(entity_id, self.corpus.by_id)

    def test_a_layer_named_in_the_question_narrows_the_answer(self):
        text = CHAT.hai_data.figures(self.corpus, "la plus ancienne équipe ?")
        line = next(l for l in text.splitlines() if l.startswith("Earliest"))
        for entity_id in re.findall(r"\(#([a-z0-9-]+)\)", line):
            self.assertEqual(self.corpus.by_id[entity_id]["kind"], "team")

    def placeless(self, layer=None):
        return {e["id"] for e in self.corpus.entities if e.get("geo") is False
                and (layer is None or e["kind"] == layer)}

    def offmap_lines(self, question):
        text = CHAT.hai_data.figures(self.corpus, question)
        return [l for l in text.splitlines() if "off the map" in l.lower()]

    def test_a_question_about_the_entities_off_the_map_gets_them_listed(self):
        # "map", "carte", "sans" and "pas" are stopwords, so retrieval searched
        # "which frameworks are off the map?" as "off" and found offshore
        # vessels; the model then said the thing "is not on the map".
        for question in ("Which frameworks are off the map?",
                         "Quels cadres sont hors carte ?",
                         "quels référentiels n’ont pas de coordonnées ?",
                         "which entities have no coordinates",
                         "Lesquels ne sont pas sur la carte ?",
                         "frameworks that aren’t on the map",
                         "les fiches sans localisation"):
            with self.subTest(question):
                self.assertTrue(self.offmap_lines(question), question)

    def test_every_placeless_entity_is_listed_and_no_other(self):
        lines = self.offmap_lines("which entities are off the map?")
        listed = set(re.findall(r"\]\(#([a-z0-9-]+)\)", "\n".join(lines)))
        self.assertTrue(self.placeless(), "the corpus has entities with no coordinates")
        self.assertEqual(listed, self.placeless())

    def test_the_count_is_the_one_the_interface_shows(self):
        # The sidebar caption says "N off the map"; the chat must give the same N.
        head = self.offmap_lines("how many are off the map?")[0]
        self.assertIn(f"{len(self.placeless())} entities have no coordinates", head)

    def test_a_layer_named_in_the_question_narrows_the_list(self):
        lines = self.offmap_lines("Quels cadres sont hors carte ?")
        listed = set(re.findall(r"\]\(#([a-z0-9-]+)\)", "\n".join(lines[1:])))
        self.assertEqual(listed, self.placeless("framework"))

    def test_a_layer_with_none_off_the_map_says_so_rather_than_nothing(self):
        # Silence would leave the model to guess, and guessing is how a chat
        # names a team that has a marker as one that does not.
        empty = [k for k in CHAT.hai_data.LAYERS if not self.placeless(k)]
        self.assertTrue(empty)
        plural = {"project": "projects", "team": "teams", "commons": "commons",
                  "framework": "frameworks"}
        for layer in empty:
            lines = self.offmap_lines(f"which {plural[layer]} are off the map?")
            self.assertIn(f"No {plural[layer]} are off the map", "\n".join(lines))

    def test_each_is_a_card_link_with_who_issued_it(self):
        lines = self.offmap_lines("which frameworks are off the map?")
        rows = lines[1].split(": ", 1)[1].split("; ")
        for row in rows:
            m = re.match(r"\[[^\]]+\]\(#([a-z0-9-]+)\)( — .+)?", row)
            self.assertTrue(m, row)
            self.assertIn(m.group(1), self.corpus.by_id)
        issuers = sum(1 for row in rows if " — " in row)
        self.assertEqual(issuers, len(rows), "every framework has an issuing body")

    def test_why_comes_from_the_recorded_jurisdictions(self):
        # "No coordinates" answers "why" with the question. The jurisdictions
        # the cards record are the reason, counted rather than asserted.
        lines = self.offmap_lines("pourquoi ces fiches sont hors carte ?")
        text = CHAT.hai_data.figures(self.corpus, "pourquoi ces fiches sont hors carte ?")
        expect: dict[str, int] = {}
        for e in self.corpus.entities:
            if e.get("geo") is False and e.get("jurisdiction"):
                expect[e["jurisdiction"]] = expect.get(e["jurisdiction"], 0) + 1
        self.assertTrue(lines)
        for jurisdiction, n in expect.items():
            self.assertIn(f"{n} {jurisdiction}", text)

    def test_a_question_about_places_on_the_map_carries_no_list(self):
        for question in ("who works on grids in France?", "what is on the map in Delft",
                         "quelles équipes sont sur la carte en Suède ?",
                         "a project with a good position on safety"):
            with self.subTest(question):
                self.assertEqual(self.offmap_lines(question), [], question)

    def test_a_retrieved_card_with_no_place_says_so_in_the_reader_s_language(self):
        e = self.corpus.by_id[next(iter(sorted(self.placeless())))]
        self.assertIn("location: hors carte (sans coordonnées)",
                      CHAT.hai_data.render_entity(self.corpus, e, "fr"))
        self.assertIn("location: off the map (no coordinates)",
                      CHAT.hai_data.render_entity(self.corpus, e, "en"))

    def test_a_question_with_no_dates_in_it_carries_no_timeline(self):
        text = CHAT.hai_data.figures(self.corpus, "who works on grids in France?")
        self.assertNotIn("Earliest", text)

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
