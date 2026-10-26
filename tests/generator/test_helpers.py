"""The generator's pure helpers, exercised directly.

`scripts/build-map-data.py` is one flat script whose interesting behaviour lives
in a dozen small functions: the text normaliser that undoes YAML line wrapping,
the recursive pruner every emitted object passes through, the provenance-note
parser that decides whether a start year belongs to the work or only to the
institution that houses it, and the serialiser whose output has to stay
byte-stable so a no-op regeneration produces an empty diff (§3).

Testing them one by one rather than only through `build()` is deliberate. Each
encodes a rule from the specification — §3.1 on what regeneration must preserve,
§3.4 on the label vocabulary, §10.2 on unknown start dates — and a failure here
names the rule that broke instead of pointing at a 449-entity payload diff.

Nothing here reads the `eu-hai-collab-map` checkout: every input is built in the
test, and `resolve_source` is driven against temporary directories with the
candidate list patched out, so the suite runs on a machine that has never cloned
the data repository.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests._harness import load_generator, load_payload, map_script

MOD = load_generator()
PAYLOAD = load_payload()

# §3.4 names the ten vocabulary groups, in this order.
SPEC_TAXO_GROUPS = [
    "focus", "type", "kind", "status", "tier", "access", "legal", "role",
    "jurisdiction", "confidence",
]

# The infrastructure domain codes. §3.1.2: these may only ever come from the
# infrastructure layer, never from an entity's focus areas.
INFRA_CODES = {"compute", "cluster", "simulation"}


def make_checkout(parent: Path, name: str) -> Path:
    """A directory that looks like the data repository to `resolve_source`:
    the probe is `data/edges.yml`, nothing more."""
    root = parent / name
    (root / "data").mkdir(parents=True)
    (root / "data" / "edges.yml").write_text("[]\n", encoding="utf-8")
    return root


class NormText(unittest.TestCase):
    """§3.1.3 — descriptions are not truncated; paragraph breaks are preserved
    and wrapped lines re-joined."""

    def test_norm_text_rejoins_wrapped_lines_and_keeps_paragraph_breaks(self):
        # YAML block scalars arrive hard-wrapped at ~80 columns. A single
        # newline is wrapping and must vanish; a blank line is authorial and
        # must survive, because the card renders paragraphs.
        self.assertEqual(
            MOD.norm_text("one line\nwrapped here\n\nsecond paragraph\nalso wrapped"),
            "one line wrapped here\n\nsecond paragraph also wrapped")

    def test_norm_text_empty_none_and_whitespace_all_collapse_to_empty_string(self):
        for value in (None, "", "   ", "\n\n\t \n"):
            self.assertEqual(MOD.norm_text(value), "", repr(value))

    def test_norm_text_collapses_runs_of_blank_lines_to_one_break(self):
        # Three blank lines, and a paragraph made only of spaces, are not three
        # extra paragraphs: `clean`-style pruning happens inside norm_text too.
        self.assertEqual(MOD.norm_text("a\n\n\n\nb"), "a\n\nb")
        self.assertEqual(MOD.norm_text("a\n\n   \n\nb"), "a\n\nb")

    def test_norm_text_does_not_truncate(self):
        # The predecessor capped descriptions at 300 characters, cutting 29
        # English and 39 French ones mid-word (§3.1.3). Length must round-trip.
        body = " ".join(f"word{i}" for i in range(200))
        self.assertEqual(len(MOD.norm_text(body)), len(body))
        self.assertTrue(MOD.norm_text(body).endswith("word199"))

    def test_norm_text_normalises_tabs_carriage_returns_and_double_spaces(self):
        self.assertEqual(MOD.norm_text("a\r\n b\tc  d"), "a b c d")

    def test_norm_text_strips_leading_and_trailing_space_of_every_paragraph(self):
        self.assertEqual(MOD.norm_text("  a  \n\n   b   "), "a\n\nb")

    def test_norm_text_on_a_non_string_either_empties_or_raises(self):
        # Not a spec claim — a guard on the generator's contract. A falsy
        # non-string (a YAML `null`, an absent key defaulted to 0) normalises to
        # "", but a bare year where a description was expected raises rather
        # than silently emitting "1949" as an entity's prose.
        self.assertEqual(MOD.norm_text(0), "")
        self.assertEqual(MOD.norm_text(False), "")
        with self.assertRaises(AttributeError):
            MOD.norm_text(1949)


class Clean(unittest.TestCase):
    """`clean` is the last thing every emitted object passes through, so what it
    drops is what the page never sees, and what it keeps is payload weight."""

    def test_clean_drops_none_empty_string_list_and_dict(self):
        self.assertEqual(
            MOD.clean({"a": "x", "b": None, "c": "", "d": [], "e": {}}), {"a": "x"})

    def test_clean_keeps_zero_and_false(self):
        # Load-bearing: `geo` is emitted as the literal False, and a coordinate
        # on the equator or the prime meridian is 0. A pruner written as
        # `if not x` would delete both — the entity would lose its geo flag and
        # gain a phantom position. The test pins the `not in (None,"",[],{})`
        # form against a well-meaning "simplification".
        self.assertEqual(
            MOD.clean({"lat": 0.0, "lon": 0, "geo": False}),
            {"lat": 0.0, "lon": 0, "geo": False})

    def test_clean_is_recursive_and_drops_containers_that_empty_out(self):
        # An operator block whose org and url are both absent must not leave an
        # empty `operator: {}` behind for the card to render as a blank row.
        self.assertEqual(
            MOD.clean({"infra": {"operator": {"org": None, "url": ""}, "kind": "testbed"}}),
            {"infra": {"kind": "testbed"}})
        self.assertEqual(MOD.clean({"a": {"b": {"c": ""}}}), {})
        self.assertEqual(MOD.clean([[], [{}], [""]]), [])

    def test_clean_strips_strings_at_every_depth(self):
        self.assertEqual(
            MOD.clean({"a": "  x  ", "b": ["  y  ", {"c": " z "}]}),
            {"a": "x", "b": ["y", {"c": "z"}]})

    def test_clean_preserves_list_order_while_dropping_holes(self):
        self.assertEqual(MOD.clean(["a", None, "b", "", "c"]), ["a", "b", "c"])

    def test_clean_returns_scalars_and_unknown_containers_untouched(self):
        self.assertIsNone(MOD.clean(None))
        self.assertEqual(MOD.clean("  x  "), "x")
        self.assertEqual(MOD.clean(7), 7)
        self.assertEqual(MOD.clean(52.37), 52.37)
        self.assertEqual(MOD.clean((1, 2)), (1, 2))   # tuples pass through whole

    def test_clean_does_not_mutate_its_input(self):
        src = {"a": "x", "b": None, "l": ["y", ""]}
        MOD.clean(src)
        self.assertEqual(src, {"a": "x", "b": None, "l": ["y", ""]})


class Loc(unittest.TestCase):
    def test_loc_missing_none_and_empty_location_all_give_an_empty_dict(self):
        # `location: ~` in the YAML is as common as no key at all; both have to
        # reach `.get("lat")` without raising.
        for d in ({}, {"location": None}, {"location": {}}):
            self.assertEqual(MOD.loc(d), {}, repr(d))

    def test_loc_hands_back_the_location_mapping_itself(self):
        inner = {"city": "Delft", "country": "NL", "lat": 52.0, "lon": 4.36}
        self.assertIs(MOD.loc({"location": inner}), inner)


class Homepage(unittest.TestCase):
    """One URL per card, chosen from five possible authoring places."""

    FULL = {
        "homepage": "https://own/",
        "links": {"homepage": "https://links/"},
        "operator": {"url": "https://operator/"},
        "issuing_body": {"url": "https://issuer/"},
        "maintainer": {"url": "https://maintainer/"},
    }

    def test_homepage_precedence_is_own_links_operator_issuer_maintainer(self):
        d = dict(self.FULL)
        self.assertEqual(MOD.homepage(d), "https://own/")
        d.pop("homepage")
        self.assertEqual(MOD.homepage(d), "https://links/")
        d.pop("links")
        self.assertEqual(MOD.homepage(d), "https://operator/")
        d.pop("operator")
        self.assertEqual(MOD.homepage(d), "https://issuer/")
        d.pop("issuing_body")
        self.assertEqual(MOD.homepage(d), "https://maintainer/")

    def test_homepage_falls_through_a_higher_priority_field_left_empty(self):
        # An authored-but-blank `homepage: ""` must not win over a real
        # operator URL, or the card would show no link at all.
        self.assertEqual(
            MOD.homepage({"homepage": "", "links": {"homepage": None},
                          "operator": {"url": "https://operator/"}}),
            "https://operator/")

    def test_homepage_reads_each_source_in_isolation(self):
        cases = [
            ({"homepage": "https://a/"}, "https://a/"),
            ({"links": {"homepage": "https://b/"}}, "https://b/"),
            ({"operator": {"org": "X", "url": "https://c/"}}, "https://c/"),
            ({"issuing_body": {"org": "Y", "url": "https://d/"}}, "https://d/"),
            ({"maintainer": {"org": "Z", "url": "https://e/"}}, "https://e/"),
        ]
        for d, want in cases:
            self.assertEqual(MOD.homepage(d), want, repr(d))

    def test_homepage_is_empty_string_when_nothing_is_there(self):
        for d in ({}, {"links": {}}, {"links": None, "operator": None},
                  {"operator": {"org": "no url"}}):
            self.assertEqual(MOD.homepage(d), "", repr(d))

    def test_homepage_on_a_malformed_links_value_fails_loudly(self):
        # `links:` written as a sequence instead of a mapping is a data error
        # CI should catch upstream; the generator must not paper over it by
        # emitting an entity with a silently missing URL.
        with self.assertRaises(AttributeError):
            MOD.homepage({"links": ["https://a/"]})
        self.assertEqual(MOD.homepage({"links": []}), "")   # empty sequence is inert


class SectorsAndApproaches(unittest.TestCase):
    """§3.1.1 — the domain derivations are the legacy ones, so regeneration
    neither moves nor recolours a marker."""

    def test_sectors_maps_known_domains_and_drops_unknown_ones(self):
        self.assertEqual(
            MOD.sectors({"domains": ["energy", "nuclear", "water", "space", None]}),
            ["energy", "nuclear", "utility"])

    def test_sectors_keeps_duplicates_for_domain_list_to_fold(self):
        # `energy` and `power_grid` both map to "energy". sectors() is not the
        # place that dedupes — domain_list() is — and the order of first
        # appearance is what decides the lead colour, so both are asserted.
        self.assertEqual(
            MOD.sectors({"domains": ["power_grid", "energy", "rail"]}),
            ["energy", "energy", "rail"])

    def test_sectors_with_no_domains_at_all(self):
        for d in ({}, {"domains": None}, {"domains": []}):
            self.assertEqual(MOD.sectors(d), [], repr(d))

    def test_sectors_folds_critical_infrastructure_into_multi(self):
        self.assertEqual(MOD.sectors({"domains": ["critical_infrastructure"]}), ["multi"])

    def test_approaches_maps_known_focus_areas_and_drops_unknown_ones(self):
        self.assertEqual(
            MOD.approaches({"focus_areas": ["explainability", "cobots", "not_a_key"]}),
            ["xai", "manufacturing"])

    def test_approaches_with_no_focus_areas_at_all(self):
        for d in ({}, {"focus_areas": None}, {"focus_areas": []}):
            self.assertEqual(MOD.approaches(d), [], repr(d))

    def test_approaches_never_yields_an_infrastructure_code(self):
        # §3.1.2. `digital_twins` is deliberately absent from APPROACH: mapping
        # it to "simulation" would file every operator that mentions digital
        # twins under the research-infrastructure filters. The invariant is
        # stronger than that one key, so assert it over the whole table and
        # over a focus list that names every infrastructure-sounding area.
        self.assertNotIn("digital_twins", MOD.APPROACH)
        self.assertEqual(INFRA_CODES & set(MOD.APPROACH.values()), set())
        self.assertEqual(
            MOD.approaches({"focus_areas": ["digital_twins", "reinforcement_learning_ops"]}),
            ["multi"])

    def test_infrastructure_codes_come_only_from_the_infra_kind_table(self):
        self.assertEqual(set(MOD.INFRA_KIND.values()), INFRA_CODES)


class DomainList(unittest.TestCase):
    """`domains[]` drives the pie slices and the domain filters (§3.3)."""

    def test_domain_list_puts_the_lead_first_then_sectors_then_approaches(self):
        self.assertEqual(
            MOD.domain_list(["energy", "rail"], ["xai"], "compute"),
            ["compute", "energy", "rail", "xai"])

    def test_domain_list_dedupes_keeping_the_first_occurrence(self):
        # Equal pie slices, one per domain: a repeated code would draw a
        # duplicate slice and skew the split the reader is meant to see (§4.2).
        self.assertEqual(
            MOD.domain_list(["energy", "energy", "rail"], ["energy", "hf"], None),
            ["energy", "rail", "hf"])

    def test_domain_list_keeps_a_lead_that_is_also_a_sector_only_once_and_first(self):
        self.assertEqual(MOD.domain_list(["rail", "energy"], [], "energy"),
                         ["energy", "rail"])

    def test_domain_list_falls_back_to_multi_when_everything_is_empty(self):
        # Every marker needs at least one slice to be drawable at all.
        self.assertEqual(MOD.domain_list([], [], None), ["multi"])
        self.assertEqual(MOD.domain_list([], [], ""), ["multi"])
        self.assertEqual(MOD.domain_list([None, ""], [], None), ["multi"])

    def test_domain_list_does_not_mutate_its_inputs(self):
        sec, app = ["energy"], ["xai"]
        out = MOD.domain_list(sec, app, "compute")
        self.assertEqual((sec, app), (["energy"], ["xai"]))
        self.assertIsNot(out, sec)


class Primary(unittest.TestCase):
    """`domain` is the lead code; it drives the colour when an entity has one."""

    def test_primary_prefers_an_explicit_lead(self):
        self.assertEqual(MOD.primary(["energy", "rail"], "compute"), "compute")

    def test_primary_skips_multi_to_find_a_real_sector(self):
        # "multi" is a fallback, not a domain: an entity tagged
        # critical_infrastructure *and* rail is led by rail, so its marker is
        # rail-coloured rather than grey.
        self.assertEqual(MOD.primary(["multi", "rail"], None), "rail")

    def test_primary_returns_multi_when_that_is_all_there_is(self):
        self.assertEqual(MOD.primary(["multi"], None), "multi")
        self.assertEqual(MOD.primary(["multi", "multi"], None), "multi")

    def test_primary_on_an_empty_sector_list(self):
        self.assertEqual(MOD.primary([], None), "multi")
        self.assertEqual(MOD.primary([], ""), "multi")


class DateQuality(unittest.TestCase):
    """§10.2 — three cases, read out of the provenance note the dating pass
    wrote as `timeline.start (high|medium|low): <evidence>`."""

    @staticmethod
    def q(source):
        return MOD.date_quality({"provenance": {"source": source}})

    def test_no_provenance_no_source_and_no_note_emit_nothing(self):
        self.assertEqual(MOD.date_quality({}), {})
        self.assertEqual(MOD.date_quality({"provenance": None}), {})
        self.assertEqual(MOD.date_quality({"provenance": {}}), {})
        self.assertEqual(self.q(None), {})
        self.assertEqual(self.q("legacy flat YAML"), {})
        self.assertEqual(self.q("Review 2026-06 web verification — https://example.org/"), {})

    def test_a_high_confidence_note_emits_dateConf_only(self):
        # Row 3 of the §10.2 table with solid evidence: a firm date, drawn as one.
        self.assertEqual(
            self.q("legacy flat YAML · timeline.start (high): ASFINAG founded 1982"),
            {"dateConf": "high"})

    def test_a_note_admitting_the_units_own_date_was_not_found_sets_dateHost(self):
        # Row 2, and the TNO case the spec names: TNO Soesterberg dates from
        # 1949, the Human-Machine Teaming department does not. The year stays as
        # a lower bound, but the map must not draw it as the start of the work.
        self.assertEqual(
            self.q("legacy flat YAML · timeline.start (medium): TNO founded 1949; "
                   "the HMT department's date not found"),
            {"dateConf": "medium", "dateHost": True})

    def test_an_estimate_of_this_entrys_own_start_is_not_a_host_year(self):
        # Row 3 with a weak source. "Estimate: MAHALO started 2020" is an
        # estimate *of this entry*, so it filters normally — hidden before its
        # year — rather than becoming the tri-state host-year case.
        self.assertEqual(
            self.q("legacy flat YAML · timeline.start (low): Estimate: MAHALO started 2020"),
            {"dateConf": "low"})

    def test_not_published_phrasing_and_mixed_case_also_count_as_not_found(self):
        self.assertEqual(
            self.q("timeline.start (low): centre exists, its date not published")["dateHost"],
            True)
        self.assertEqual(
            self.q("timeline.start (medium): Date Not Found for the group itself")["dateHost"],
            True)

    def test_an_admission_phrased_without_date_right_before_not_found(self):
        # HOST_YEAR carries two alternatives, and the second one is
        # load-bearing: the dating pass also wrote the admission as "its date
        # *was* not found" and "its founding *year* not found", where the word
        # in front of "not found" is not "date". Narrowing the pattern to
        # `date not (found|published)` reads as a tidy-up and silently demotes
        # those notes to firm dates — `aalto-dt` in the committed payload is
        # exactly the first phrasing (§10.2, row 2).
        #
        # Both notes also open with an estimate, of the *host*: unlike
        # "Estimate: MAHALO started 2020" above, the sentence goes on to admit
        # the entry's own date is missing, which is what decides the case.
        self.assertEqual(
            self.q("timeline.start (low): Estimate: FCAI launched 2018 (aalto.fi); "
                   "the team's own founding date was not found"),
            {"dateConf": "low", "dateHost": True})
        self.assertEqual(
            self.q("timeline.start (medium): institute founded 1954; "
                   "the group's own founding year not found"),
            {"dateConf": "medium", "dateHost": True})

    def test_the_committed_payload_re_derives_from_the_notes_beside_it(self):
        # The shipped payload is an independent oracle for this parse: every
        # dateConf/dateHost in it was written by an earlier run of
        # date_quality(), and `prov.src` carries the very note it read. Running
        # the current function over all 449 notes checks the three tiers, the
        # " | " cut, the host-year probe and the medium/low gate against real
        # curator prose instead of against sentences written to suit the test —
        # which is what makes it catch a pattern narrowed in a way no invented
        # example happens to cover.
        conf_seen = host_seen = 0
        for layer in ("PROJECTS", "COMMONS", "TEAMS", "FRAMEWORKS"):
            for o in PAYLOAD[layer]:
                note = {"provenance": {"source": (o.get("prov") or {}).get("src") or ""}}
                want = {k: o[k] for k in ("dateConf", "dateHost") if k in o}
                if o.get("timeline"):
                    self.assertEqual(MOD.date_quality(note), want, o["id"])
                else:
                    # §3.3: both fields are derived, and base_entry only derives
                    # them for an entity that has a timeline at all.
                    self.assertEqual(want, {}, o["id"])
                conf_seen += "dateConf" in want
                host_seen += "dateHost" in want
        # Without both shapes present the loop above would be vacuous.
        self.assertTrue(conf_seen and host_seen, (conf_seen, host_seen))

    def test_note_capture_stops_at_the_pipe_separator(self):
        # Provenance strings concatenate review passes with " | ". Only the
        # dating pass's own sentence describes the start year, so a later
        # reviewer writing "not found" about something else must not turn a
        # firm date into a host year.
        out = self.q("legacy · timeline.start (medium): Maizières R&D campus founded 1946"
                     " | Review 2026-09: contact address not found")
        self.assertEqual(out, {"dateConf": "medium"})

    def test_a_wrapped_note_is_read_whole_and_a_trailing_newline_is_not(self):
        # The note is a YAML scalar and can be wrapped; the pattern is compiled
        # with re.S so the evidence after a line break still counts.
        self.assertEqual(
            self.q("timeline.start (medium): founded 1958;\nthe lab's own date not found"),
            {"dateConf": "medium", "dateHost": True})
        self.assertEqual(self.q("timeline.start (high): Founded 2015\n"),
                         {"dateConf": "high"})

    def test_an_unrecognised_confidence_word_is_no_note_at_all(self):
        # The pattern only admits the three tiers the dating pass used; a
        # malformed note is ignored rather than emitting a bogus dateConf.
        self.assertEqual(self.q("timeline.start (unknown): whatever"), {})
        self.assertEqual(self.q("timeline.start: 1982"), {})
        self.assertEqual(self.q("timeline.start (HIGH): founded 1982"), {})

    def test_not_founded_does_not_trip_the_host_year_probe(self):
        # `not found\b` is word-bounded on purpose: "not founded before 1970"
        # is evidence about this entry, not an admission that its date is
        # missing, and must stay a plain low-confidence date.
        self.assertEqual(
            self.q("timeline.start (low): the institute was not founded before 1970"),
            {"dateConf": "low"})

    def test_high_confidence_never_carries_dateHost(self):
        # SPEC-DEVIATION: the §10.2 table conditions `dateHost` only on the note
        # admitting the sub-unit's date was not found, but the code also
        # requires the confidence to be medium or low. No note in the committed
        # payload is both high-confidence and an admission (0 of 449), so the
        # gate changes nothing today; it would silently drop the host-year
        # treatment if the dating pass ever wrote one.
        self.assertEqual(
            self.q("timeline.start (high): ABB founded 1916; the lab's date not found"),
            {"dateConf": "high"})
        high_admissions = [
            o["id"]
            for layer in ("PROJECTS", "COMMONS", "TEAMS", "FRAMEWORKS")
            for o in PAYLOAD[layer]
            for m in [MOD.DATE_NOTE.search((o.get("prov") or {}).get("src") or "")]
            if m and m.group(1) == "high" and MOD.HOST_YEAR.search(m.group(2))
        ]
        self.assertEqual(high_admissions, [])

    def test_date_quality_never_emits_a_key_beyond_the_two(self):
        out = self.q("timeline.start (low): the unit's date not found")
        self.assertEqual(sorted(out), ["dateConf", "dateHost"])


class TimelineOf(unittest.TestCase):
    """`timeline{start,end,milestones[]}` (§3.3), pruned by `clean`."""

    def test_no_timeline_is_an_empty_dict_so_the_key_is_omitted(self):
        # base_entry only sets `timeline` when this returns something truthy,
        # so an empty dict is what keeps the field off the entity entirely.
        for d in ({}, {"timeline": None}, {"timeline": {}}):
            self.assertEqual(MOD.timeline_of(d), {}, repr(d))

    def test_years_become_strings_whatever_yaml_parsed_them_as(self):
        # YAML turns `start: 2018` into an int and `start: 2018-05-01` into a
        # datetime.date. The page compares and prints years as text.
        self.assertEqual(
            MOD.timeline_of({"timeline": {"start": 2018, "end": 2024}}),
            {"start": "2018", "end": "2024"})
        self.assertEqual(
            MOD.timeline_of({"timeline": {"start": datetime.date(2018, 5, 1)}}),
            {"start": "2018-05-01"})

    def test_an_open_ended_timeline_drops_the_end_key(self):
        self.assertEqual(MOD.timeline_of({"timeline": {"start": 2018, "end": None}}),
                         {"start": "2018"})
        self.assertEqual(MOD.timeline_of({"timeline": {"end": 2024}}), {"end": "2024"})

    def test_a_milestone_without_a_label_is_dropped(self):
        # A bare date with nothing to say about it has nothing to render.
        self.assertEqual(
            MOD.timeline_of({"timeline": {"milestones": [
                {"date": "2020-01-01"}, {"label": ""}, {"label": "   "}]}}),
            {})

    def test_milestone_labels_are_stripped_and_dates_stringified(self):
        self.assertEqual(
            MOD.timeline_of({"timeline": {"milestones": [
                {"label": "  pilot  ", "date": datetime.date(2020, 1, 2)},
                {"label": "review", "date": 2021},
                {"label": "close", "date": None}]}}),
            {"milestones": [
                {"date": "2020-01-02", "label": "pilot"},
                {"date": "2021", "label": "review"},
                {"label": "close"}]})

    def test_a_null_milestone_entry_is_skipped_rather_than_raising(self):
        # `milestones:` with a stray `-` produces a None element.
        self.assertEqual(
            MOD.timeline_of({"timeline": {"start": 2019, "milestones": [None, {"label": "x"}]}}),
            {"start": "2019", "milestones": [{"label": "x"}]})

    def test_a_zero_start_is_treated_as_absent(self):
        self.assertEqual(MOD.timeline_of({"timeline": {"start": 0, "end": 0}}), {})


class WhenOf(unittest.TestCase):
    """`when` — the compact span the marker tooltip and the print sheet use."""

    def test_when_of_renders_a_closed_span_with_an_en_dash(self):
        # U+2013, not a hyphen: the print sheet and the tooltip show it verbatim.
        self.assertEqual(MOD.when_of({"start": "2018", "end": "2024"}), "2018–2024")

    def test_when_of_leaves_an_open_span_trailing(self):
        self.assertEqual(MOD.when_of({"start": "2018"}), "2018–")
        self.assertEqual(MOD.when_of({"start": "2018", "end": ""}), "2018–")

    def test_when_of_is_empty_when_there_is_no_timeline(self):
        for tl in ({}, {"start": "", "end": ""}, {"milestones": [{"label": "x"}]}):
            self.assertEqual(MOD.when_of(tl), "", repr(tl))

    def test_when_of_on_an_end_without_a_start(self):
        # Degenerate but representable: a concluded entry whose start was never
        # established still says when it ended.
        self.assertEqual(MOD.when_of({"end": "2024"}), "–2024")


class ProvOf(unittest.TestCase):
    """`prov{by,on,upd,src,conf}` (§3.3) — the five fields the card credits."""

    def test_prov_of_maps_the_five_fields_and_carries_nothing_else(self):
        out = MOD.prov_of({"provenance": {
            "added_by": "curator", "added_on": datetime.date(2026, 1, 2),
            "last_updated": datetime.date(2026, 9, 3), "source": "  CORDIS  ",
            "confidence": "high", "review_notes": "internal, do not ship"}})
        self.assertEqual(out, {"by": "curator", "on": "2026-01-02",
                               "upd": "2026-09-03", "src": "CORDIS", "conf": "high"})

    def test_prov_of_on_an_absent_or_empty_provenance_block(self):
        for d in ({}, {"provenance": None}, {"provenance": {}}):
            self.assertEqual(MOD.prov_of(d), {}, repr(d))

    def test_prov_of_drops_the_fields_that_are_not_there(self):
        # `on` and `upd` go through str(), so an absent date must not become
        # the string "None" — that would poison AS_OF's max() (§3.5).
        out = MOD.prov_of({"provenance": {"added_by": "curator", "confidence": None}})
        self.assertEqual(out, {"by": "curator"})
        self.assertNotIn("None", json.dumps(out))


class LinksOf(unittest.TestCase):
    """`links{papers[],linkedin,twitter,docs,official}` (§3.3)."""

    def test_links_of_renames_official_text_and_ignores_unknown_keys(self):
        out = MOD.links_of({"links": {
            "papers": ["https://doi/1", "https://doi/2"], "linkedin": "https://li/",
            "twitter": "https://x/", "docs": "https://docs/",
            "official_text": "https://eur-lex/", "homepage": "https://own/",
            "slack": "https://slack/"}})
        self.assertEqual(out, {
            "papers": ["https://doi/1", "https://doi/2"], "linkedin": "https://li/",
            "twitter": "https://x/", "docs": "https://docs/", "official": "https://eur-lex/"})

    def test_links_of_filters_holes_out_of_the_paper_list(self):
        self.assertEqual(
            MOD.links_of({"links": {"papers": ["https://doi/1", None, ""]}}),
            {"papers": ["https://doi/1"]})

    def test_links_of_is_empty_when_only_the_homepage_was_authored(self):
        # homepage() already claims that field; a links block holding nothing
        # else must return {} so base_entry omits the `links` key and the card
        # renders no empty "Links" section.
        self.assertEqual(MOD.links_of({"links": {"homepage": "https://own/"}}), {})
        for d in ({}, {"links": None}, {"links": {}},
                  {"links": {"papers": [], "docs": None}}):
            self.assertEqual(MOD.links_of(d), {}, repr(d))


class JsArray(unittest.TestCase):
    """`js_array` writes the payload. §3: output is byte-stable across runs, so
    a no-op regeneration produces an empty diff."""

    SAMPLE = [{"id": "a", "name": "A", "lat": 52.0}, {"id": "b", "name": "B"}]

    def test_one_line_per_entity_two_space_indent_trailing_comma(self):
        lines = MOD.js_array(self.SAMPLE).split("\n")
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertTrue(line.startswith("  {"), line)
            self.assertTrue(line.endswith("},"), line)

    def test_every_line_is_json_and_round_trips_to_its_entity(self):
        # The line-per-entity shape is what makes the payload diffable and what
        # tests/_harness.py parses back without a JS runtime.
        for line, want in zip(MOD.js_array(self.SAMPLE).split("\n"), self.SAMPLE):
            self.assertEqual(json.loads(line.strip().rstrip(",")), want)

    def test_a_paragraph_break_inside_a_description_stays_on_one_line(self):
        # norm_text preserves "\n\n" (§3.1.3); json.dumps escapes it. If a real
        # newline reached the file, one entity would span several lines and the
        # array would no longer be readable line by line.
        out = MOD.js_array([{"desc": "one\n\ntwo"}])
        self.assertEqual(len(out.split("\n")), 1)
        self.assertIn("\\n\\n", out)
        self.assertEqual(json.loads(out.strip().rstrip(","))["desc"], "one\n\ntwo")

    def test_non_ascii_is_emitted_literally_not_escaped(self):
        # ensure_ascii=False. French descriptions and city names are most of the
        # payload; \u-escaping them would inflate the file and make it unreadable.
        out = MOD.js_array([{"city": "Liège", "desc": "Explicabilité"}])
        self.assertIn("Liège", out)
        self.assertIn("Explicabilité", out)
        self.assertNotIn("\\u", out)

    def test_an_empty_layer_renders_as_the_empty_string(self):
        self.assertEqual(MOD.js_array([]), "")

    def test_output_is_stable_across_calls(self):
        # Two calls agreeing proves only that the function is deterministic,
        # which it is by construction — so pin the bytes as well. The literal
        # carries the indent, the separators json.dumps was left to choose
        # (`", "` / `": "`, not the compact pair) and the trailing comma at
        # once, which is what "byte-stable across runs" means for a reader
        # diffing a regenerated payload (§3).
        self.assertEqual(
            MOD.js_array(self.SAMPLE),
            '  {"id": "a", "name": "A", "lat": 52.0},\n  {"id": "b", "name": "B"},')
        self.assertEqual(MOD.js_array(self.SAMPLE), MOD.js_array(self.SAMPLE))

    def test_key_order_follows_insertion_order_not_sorting(self):
        # Byte-stability comes from the generator always building entities in
        # the same field order, not from sorting at serialisation time. Pinning
        # that here is what makes the "empty diff" invariant checkable.
        self.assertEqual(MOD.js_array([{"b": 1, "a": 2}]).strip(), '{"b": 1, "a": 2},')

    def test_geo_false_and_zero_coordinates_survive_serialisation(self):
        out = MOD.js_array([{"id": "iso", "geo": False, "lat": 0, "lon": 0.0}])
        self.assertEqual(json.loads(out.strip().rstrip(",")),
                         {"id": "iso", "geo": False, "lat": 0, "lon": 0.0})


class TaxoPayload(unittest.TestCase):
    """§3.4 — DATA.TAXO carries English and French labels for every controlled
    value; an unmapped key falls back to its de-underscored form."""

    def setUp(self):
        self.taxo = MOD.taxo_payload()

    def test_the_groups_are_exactly_the_ten_the_spec_names(self):
        self.assertEqual(sorted(self.taxo), sorted(SPEC_TAXO_GROUPS))

    def test_every_value_carries_both_labels_and_nothing_else(self):
        for group, table in self.taxo.items():
            self.assertTrue(table, group)
            for key, entry in table.items():
                where = f"{group}.{key}"
                self.assertEqual(sorted(entry), ["en", "fr"], where)
                for lang in ("en", "fr"):
                    self.assertIsInstance(entry[lang], str, where)
                    self.assertTrue(entry[lang].strip(), where)

    def test_the_shipped_labels_are_verbatim(self):
        # Spot-checks rather than a copy of the table: enough to catch a group
        # renamed, a translation lost, or the en/fr pair swapped.
        self.assertEqual(self.taxo["kind"]["regulation"],
                         {"en": "Regulation", "fr": "Réglementation"})
        self.assertEqual(self.taxo["focus"]["explainability"],
                         {"en": "Explainability", "fr": "Explicabilité"})
        self.assertEqual(self.taxo["status"]["concluded"],
                         {"en": "Concluded", "fr": "Terminé"})
        self.assertEqual(self.taxo["access"]["gated"],
                         {"en": "On request", "fr": "Accès sur demande"})
        # Lowercase on purpose: the card reads "confidence high", a sentence.
        self.assertEqual(self.taxo["confidence"]["high"], {"en": "high", "fr": "élevée"})

    def test_the_shipped_payload_carries_exactly_these_labels(self):
        # The spot-checks above are five rows out of seventy-two, and the
        # mirror test below reads its expectations from MOD.TAXO — the same
        # table taxo_payload() transforms — so neither can see a label that was
        # edited in the generator. hai-data.js can: it was written by an earlier
        # run of this function, which makes it an independent record of every
        # EN/FR pair the page ships. A translation copy-pasted from the wrong
        # row, a French label replaced by its English twin, a key dropped or a
        # group reordered all surface here, without a copy of the table living
        # in the test file (§3.4, §12, invariant 1).
        self.assertEqual(self.taxo, PAYLOAD["TAXO"])
        self.assertEqual(list(self.taxo), list(PAYLOAD["TAXO"]))
        for group, table in PAYLOAD["TAXO"].items():
            self.assertEqual(list(self.taxo[group]), list(table), group)

    def test_the_values_left_untranslated_are_the_known_handful(self):
        # Six labels are identical in both languages because the French term is
        # the English one (Cobots, Horizon Europe, a benchmark). Freezing the
        # list means a seventh — a forgotten translation — shows up as a failure
        # rather than as English text in the French interface (§12).
        same = sorted((g, k) for g, table in self.taxo.items()
                      for k, e in table.items() if e["en"] == e["fr"])
        self.assertEqual(same, [
            ("focus", "cobots"), ("focus", "manufacturing"),
            ("jurisdiction", "international"), ("kind", "benchmark"),
            ("kind", "horizon_europe"), ("type", "infrastructure"),
        ])

    def test_the_payload_is_json_serialisable_and_stable(self):
        first = json.dumps(MOD.taxo_payload(), ensure_ascii=False, sort_keys=True)
        second = json.dumps(MOD.taxo_payload(), ensure_ascii=False, sort_keys=True)
        self.assertEqual(first, second)
        self.assertEqual(json.loads(first)["tier"]["core"]["fr"], "Cœur")

    def test_taxo_payload_mirrors_the_module_table_exactly(self):
        # The transformation is (en, fr) tuples -> {"en":…, "fr":…}; nothing may
        # be dropped or reordered on the way, or a card loses a label.
        self.assertEqual(sorted(self.taxo), sorted(MOD.TAXO))
        for group, table in MOD.TAXO.items():
            self.assertEqual(list(self.taxo[group]), list(table), group)
            for key, (en, fr) in table.items():
                self.assertEqual(self.taxo[group][key], {"en": en, "fr": fr})

    def test_every_group_the_page_asks_for_exists_in_the_payload(self):
        # The page calls taxo('role', …), taxo('confidence', …) and so on by
        # literal group name; a group renamed in the generator would make those
        # call sites silently fall back to raw keys for every value.
        asked = set(re.findall(r"taxo\(\s*'([a-z_]+)'", map_script()))
        self.assertTrue(asked, "no taxo() call sites found in the page")
        self.assertEqual(asked - set(self.taxo), set())

    def test_an_unmapped_key_gets_no_entry_so_the_page_can_fall_back(self):
        # §3.4/§17: the generator does not invent a label for a value it has
        # never heard of. The absence is the contract — the page turns the raw
        # key into readable text instead.
        for group in SPEC_TAXO_GROUPS:
            self.assertNotIn("a_brand_new_value", self.taxo[group], group)
        # A made-up key is absent from anything, so that line alone cannot fail.
        # These two are values the committed payload really carries without a
        # label, and the assertion is that the lookup *raises*: a table handed
        # back as a defaultdict, or pre-filled from the corpus, would still
        # answer "not in" for an invented string while quietly inventing a
        # label for these — which is the only way this claim can break.
        for group, value in (("role", "third_party"), ("access", "restricted")):
            with self.assertRaises(KeyError, msg=f"{group}.{value}"):
                self.taxo[group][value]

    def test_the_page_falls_back_to_the_de_underscored_key(self):
        # The rendering half of the §3.4 claim lives in the page's taxo(), so it
        # is asserted here against the shipped source: a missing entry must
        # de-underscore, not throw and not print "undefined".
        body = re.search(r"function taxo\(group, key\)\{(.*?)\n\}", map_script(), re.S)
        self.assertIsNotNone(body, "taxo() not found in the page")
        self.assertIn("String(key).replace(/_/g,' ')", body.group(1))

    def test_controlled_values_the_committed_payload_uses_without_a_label(self):
        # SPEC-DEVIATION: §3.4 and §12 claim every controlled vocabulary value
        # has both labels, but the committed payload carries seven that are not
        # in any TAXO table. They survive — the page de-underscores them, which
        # is the documented degradation — but they reach a French reader in
        # English ("third party", "restricted"), and the four jurisdictions are
        # country codes rather than vocabulary values at all. Snapshot of the
        # current payload; update it when the tables catch up.
        fields = [("type", "type"), ("kind", "kind"), ("status", "status"),
                  ("tier", "tier"), ("legal", "legal"), ("jurisdiction", "jurisdiction")]
        missing = set()
        for layer in ("PROJECTS", "COMMONS", "TEAMS", "FRAMEWORKS"):
            for o in PAYLOAD[layer]:
                for group, field in fields:
                    v = o.get(field)
                    if v and v not in self.taxo[group]:
                        missing.add((group, v))
                for v in o.get("focus", []):
                    if v not in self.taxo["focus"]:
                        missing.add(("focus", v))
                infra = o.get("infra") or {}
                for group, field in (("kind", "kind"), ("access", "access")):
                    v = infra.get(field)
                    if v and v not in self.taxo[group]:
                        missing.add((group, v))
                conf = (o.get("prov") or {}).get("conf")
                if conf and conf not in self.taxo["confidence"]:
                    missing.add(("confidence", conf))
                for c in o.get("consortium", []):
                    if c.get("role") and c["role"] not in self.taxo["role"]:
                        missing.add(("role", c["role"]))
        self.assertEqual(sorted(missing), [
            ("access", "commercial"), ("access", "restricted"),
            ("jurisdiction", "DE"), ("jurisdiction", "DK"),
            ("jurisdiction", "NL"), ("jurisdiction", "UK"),
            ("role", "third_party"),
        ])
        # Each of them still reads as text under the documented fallback.
        self.assertEqual(
            {v: v.replace("_", " ") for _, v in sorted(missing)},
            {"commercial": "commercial", "restricted": "restricted", "DE": "DE",
             "DK": "DK", "NL": "NL", "UK": "UK", "third_party": "third party"})


class DataAsOf(unittest.TestCase):
    """§3.5 — AS_OF is the most recent provenance touch across every entity."""

    @staticmethod
    def corpus(**layers):
        base = {"PROJECTS": [], "COMMONS": [], "TEAMS": [], "FRAMEWORKS": [], "EDGES": []}
        base.update(layers)
        return base

    def test_takes_the_maximum_across_every_layer_and_both_date_fields(self):
        data = self.corpus(
            PROJECTS=[{"prov": {"upd": "2026-01-15", "on": "2025-03-01"}}],
            TEAMS=[{"prov": {"on": "2026-09-03"}}],
            FRAMEWORKS=[{"prov": {"upd": "2024-12-31"}}])
        self.assertEqual(MOD.data_as_of(data), "2026-09-03")

    LAYERS = ("PROJECTS", "COMMONS", "TEAMS", "FRAMEWORKS")

    def test_every_one_of_the_four_entity_layers_is_consulted(self):
        # §3.5 says "every entity in every layer". In the committed corpus the
        # most recent touch sits in TEAMS and COMMONS, so dropping PROJECTS or
        # FRAMEWORKS from the loop changes nothing today — not the payload
        # check below, not the page — right up until an upstream edit makes a
        # framework the freshest thing on the map and the period axis quietly
        # stops a year short of it. Each layer gets its turn at holding the
        # winner, so a layer omitted from the scan fails here whatever the data
        # happens to look like.
        for layer in self.LAYERS:
            with self.subTest(layer=layer):
                data = self.corpus(**{
                    k: [{"prov": {"upd": "2026-12-31" if k == layer else "2024-01-01"}}]
                    for k in self.LAYERS})
                self.assertEqual(MOD.data_as_of(data), "2026-12-31")

    def test_an_added_on_later_than_every_last_updated_still_wins(self):
        # `added_on` counts as a touch: a brand-new entity makes the corpus
        # fresher even though nothing has been revised since.
        data = self.corpus(COMMONS=[{"prov": {"upd": "2025-01-01", "on": "2026-02-02"}}])
        self.assertEqual(MOD.data_as_of(data), "2026-02-02")

    def test_entities_without_provenance_are_ignored_not_fatal(self):
        data = self.corpus(TEAMS=[{"id": "a"}, {"id": "b", "prov": {}},
                                  {"id": "c", "prov": {"upd": "2026-04-04"}}])
        self.assertEqual(MOD.data_as_of(data), "2026-04-04")

    def test_an_empty_corpus_yields_the_empty_string(self):
        # Not a crash and not today's date: the page clamps YMAX off AS_OF and
        # has to cope with a corpus that says nothing about freshness.
        self.assertEqual(MOD.data_as_of(self.corpus()), "")

    def test_edges_are_not_consulted(self):
        # Edges have no provenance of their own; only the four entity layers
        # carry a date, and the spec says "every entity in every layer".
        data = self.corpus(TEAMS=[{"prov": {"upd": "2026-01-01"}}],
                           EDGES=[{"project": "p", "team": "t", "prov": {"upd": "2099-01-01"}}])
        self.assertEqual(MOD.data_as_of(data), "2026-01-01")

    def test_it_is_data_derived_not_wall_clock(self):
        # The docstring's reason: date.today() here would put a moving timestamp
        # in a generated file and break the empty-diff invariant (§16). The same
        # corpus must give the same answer, and one that is in the data.
        data = self.corpus(TEAMS=[{"prov": {"upd": "2020-06-06"}}])
        self.assertEqual(MOD.data_as_of(data), "2020-06-06")
        self.assertEqual(MOD.data_as_of(data), MOD.data_as_of(data))
        self.assertNotEqual(MOD.data_as_of(data), datetime.date.today().isoformat())

    def test_it_assumes_zero_padded_iso_dates(self):
        # max() over strings is only correct for ISO-8601 with padded months.
        # An unpadded "2026-9-03" would sort after "2026-10-01" — pinned so the
        # assumption is visible, since it is CI upstream that guarantees it.
        data = self.corpus(TEAMS=[{"prov": {"upd": "2026-9-03"}},
                                  {"prov": {"upd": "2026-10-01"}}])
        self.assertEqual(MOD.data_as_of(data), "2026-9-03")

    def test_the_committed_payload_matches_what_the_generator_would_compute(self):
        # The one end-to-end check in this file: AS_OF in hai-data.js is exactly
        # data_as_of() over the entities shipped beside it. If they disagree,
        # the file was hand-edited or generated from a different corpus, and the
        # period filter's upper bound (§10) no longer matches the data.
        self.assertEqual(MOD.data_as_of(PAYLOAD), PAYLOAD["AS_OF"])
        self.assertRegex(PAYLOAD["AS_OF"], r"^\d{4}-\d{2}-\d{2}$")


class ResolveSource(unittest.TestCase):
    """§3 — the source path comes from --source, then $EU_HAI_MAP_REPO, then a
    few conventional sibling locations; failing all three the script exits.

    Every test patches CANDIDATE_SOURCES, so a real checkout sitting beside the
    repository (or in the curator's home directory) cannot make a fall-through
    test pass for the wrong reason.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        os.environ.pop("EU_HAI_MAP_REPO", None)
        self.addCleanup(env.stop)
        cands = mock.patch.object(MOD, "CANDIDATE_SOURCES", [])
        cands.start()
        self.addCleanup(cands.stop)

    def test_the_source_argument_wins_over_the_env_var_and_the_candidates(self):
        want = make_checkout(self.tmp, "explicit")
        os.environ["EU_HAI_MAP_REPO"] = str(make_checkout(self.tmp, "from-env"))
        MOD.CANDIDATE_SOURCES[:] = [make_checkout(self.tmp, "sibling")]
        self.assertEqual(MOD.resolve_source(str(want)), want.resolve())

    def test_the_env_var_wins_over_the_candidates_when_there_is_no_argument(self):
        want = make_checkout(self.tmp, "from-env")
        os.environ["EU_HAI_MAP_REPO"] = str(want)
        MOD.CANDIDATE_SOURCES[:] = [make_checkout(self.tmp, "sibling")]
        self.assertEqual(MOD.resolve_source(None), want.resolve())

    def test_the_first_existing_candidate_is_used_when_nothing_else_is_given(self):
        missing = self.tmp / "not-cloned"
        first = make_checkout(self.tmp, "first")
        second = make_checkout(self.tmp, "second")
        MOD.CANDIDATE_SOURCES[:] = [missing, first, second]
        self.assertEqual(MOD.resolve_source(None), first.resolve())

    def test_an_argument_that_is_not_a_checkout_falls_through(self):
        # Deliberate leniency, worth pinning: a stale path in a shell alias
        # does not stop a regeneration that another source can satisfy. The
        # summary the script prints names the directory it actually read (§3).
        (self.tmp / "empty").mkdir()
        want = make_checkout(self.tmp, "real")
        MOD.CANDIDATE_SOURCES[:] = [want]
        self.assertEqual(MOD.resolve_source(str(self.tmp / "empty")), want.resolve())
        self.assertEqual(MOD.resolve_source(str(self.tmp / "does-not-exist")), want.resolve())

    def test_an_empty_env_var_is_ignored_rather_than_read_as_the_cwd(self):
        os.environ["EU_HAI_MAP_REPO"] = ""
        want = make_checkout(self.tmp, "sibling")
        MOD.CANDIDATE_SOURCES[:] = [want]
        self.assertEqual(MOD.resolve_source(None), want.resolve())

    def test_the_probe_is_data_edges_yml_specifically(self):
        # A directory with a data/ folder but no edges.yml is not the data
        # repository — this repo's own `tests/data/` would otherwise qualify.
        half = self.tmp / "half"
        (half / "data").mkdir(parents=True)
        (half / "data" / "teams").mkdir()
        real = make_checkout(self.tmp, "real")
        MOD.CANDIDATE_SOURCES[:] = [half, real]
        self.assertEqual(MOD.resolve_source(None), real.resolve())

    def test_a_tilde_is_expanded_in_both_the_argument_and_the_env_var(self):
        home = self.tmp / "home"
        home.mkdir()
        want = make_checkout(home, "eu-hai-collab-map")
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            self.assertEqual(MOD.resolve_source("~/eu-hai-collab-map"), want.resolve())
            os.environ["EU_HAI_MAP_REPO"] = "~/eu-hai-collab-map"
            self.assertEqual(MOD.resolve_source(None), want.resolve())

    def test_the_returned_path_is_absolute_and_normalised(self):
        want = make_checkout(self.tmp, "real")
        noisy = self.tmp / "real" / "data" / ".." / "." / ""
        got = MOD.resolve_source(str(noisy))
        self.assertTrue(got.is_absolute())
        self.assertEqual(got, want.resolve())
        self.assertNotIn("..", got.parts)

    def test_it_exits_with_instructions_when_no_source_can_be_found(self):
        # sys.exit, not a traceback: the message is the only documentation a
        # first-time contributor gets, so it has to name all three routes.
        MOD.CANDIDATE_SOURCES[:] = [self.tmp / "nope"]
        with self.assertRaises(SystemExit) as caught:
            MOD.resolve_source(None)
        message = str(caught.exception)
        self.assertIn("--source", message)
        self.assertIn("$EU_HAI_MAP_REPO", message)
        self.assertIn("git clone https://github.com/marota/eu-hai-collab-map.git", message)

    def test_it_exits_rather_than_falling_back_to_the_repo_itself(self):
        # This repository has a data-less `assets/` tree and a `tests/data/`
        # directory; neither may ever be mistaken for the source of truth.
        MOD.CANDIDATE_SOURCES[:] = []
        with self.assertRaises(SystemExit):
            MOD.resolve_source(str(Path(MOD.REPO)))

    def test_the_shipped_candidate_list_is_the_documented_one(self):
        # Patched out everywhere above, so assert the real list once, from a
        # freshly loaded module: two siblings of the repository and one
        # conventional home-directory path.
        real = load_generator().CANDIDATE_SOURCES
        self.assertEqual([p.name for p in real],
                         ["eu-hai-collab-map", "Map_Human_AI_Collaboration",
                          "Map_Human_AI_Collaboration"])
        self.assertEqual(real[0].parent, Path(MOD.REPO).parent)
        # Both siblings sit beside the repository; only the third is under
        # $HOME, so asserting the first one's parent is not enough to notice
        # the second being repointed.
        self.assertEqual(real[1].parent, Path(MOD.REPO).parent)
        self.assertEqual(real[2].parent,
                         Path.home() / "Documents" / "Claude" / "Projects")


if __name__ == "__main__":
    unittest.main()
