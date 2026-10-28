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
names the rule that broke instead of pointing at a 460-entity payload diff.

The entry point is here too. `main()` is not a pure helper, but it is the only
thing a contributor runs, and the summary it prints — the regression signal §3
names — is computed with its own loops over the layers rather than read off
`build()`, so it is free to disagree with the payload written beside it.

Nothing here reads the `eu-hai-collab-map` checkout: every input is built in the
test, and `resolve_source` and `main()` are driven against temporary
directories with the candidate list patched out, so the suite runs on a machine
that has never cloned the data repository — and a run that was meant to fail
cannot be rescued by a checkout that happens to sit next door.
"""
from __future__ import annotations

import ast
import contextlib
import datetime
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

from tests._harness import GENERATOR, load_generator, load_payload, map_script

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


def filler(n: int) -> str:
    """A description of exactly `n` characters: one paragraph, single-spaced,
    never wrapped and never ending in a space, so `norm_text` hands it back
    unchanged and "longest description N chars" is a figure the test knows
    independently of the generator."""
    text = ("ha " * n)[:n]
    return text[:-1] + "h" if text.endswith(" ") else text


def write_entity(root: Path, layer: str, ident: str, *, desc: str = "",
                 lat=None, lon=None, updated: str = "2025-01-01") -> Path:
    """One YAML file under `root/data/<layer>/`, carrying the least the
    generator needs: an id, a name, a description and a provenance date.
    Dumped at a width no line can reach, so a folded line cannot change the
    description's length behind the test's back."""
    d = {
        "id": ident,
        "name": ident.upper(),
        "description": desc,
        "provenance": {"added_by": "fixture", "added_on": "2024-01-01",
                       "last_updated": updated, "confidence": "high"},
    }
    if lat is not None:
        d["location"] = {"city": "Delft", "country": "NL", "lat": lat, "lon": lon}
    path = root / "data" / layer / f"{ident}.yml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(d, width=4096, sort_keys=False, allow_unicode=True),
                    encoding="utf-8")
    return path


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
        # the current function over all 460 notes checks the three tiers, the
        # " | " cut, the host-year probe and the medium/low gate against real
        # curator prose instead of against sentences written to suit the test —
        # which is what makes it catch a pattern narrowed in a way no invented
        # example happens to cover.
        conf_seen = host_seen = 0
        for layer in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS"):
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
            for layer in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS")
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
        # Eight labels are identical in both languages because the French term is
        # the English one (Cobots, Horizon Europe, Horizon 2020, a benchmark, an
        # association). Freezing the list means a ninth — a forgotten translation —
        # shows up as a failure rather than as English text in the French
        # interface (§12).
        same = sorted((g, k) for g, table in self.taxo.items()
                      for k, e in table.items() if e["en"] == e["fr"])
        self.assertEqual(same, [
            ("focus", "cobots"), ("focus", "manufacturing"),
            ("jurisdiction", "international"), ("kind", "association"), ("kind", "benchmark"),
            ("kind", "horizon_2020"), ("kind", "horizon_europe"),
            ("type", "infrastructure"),
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
        for group, value in (("access", "commercial"), ("access", "restricted")):
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
        # has both labels, but the committed payload carries six that are not
        # in any TAXO table. They survive — the page de-underscores them, which
        # is the documented degradation — but they reach a French reader in
        # English ("commercial", "restricted"), and the four jurisdictions are
        # country codes rather than vocabulary values at all. Snapshot of the
        # current payload; update it when the tables catch up. The role table
        # caught up first: `third_party` went from 12 consortium lines to 115
        # when the October 2026 review aligned roles on CORDIS, so it now has
        # its labels.
        fields = [("type", "type"), ("kind", "kind"), ("status", "status"),
                  ("tier", "tier"), ("legal", "legal"), ("jurisdiction", "jurisdiction")]
        missing = set()
        for layer in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS"):
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
        ])
        # Each of them still reads as text under the documented fallback.
        self.assertEqual(
            {v: v.replace("_", " ") for _, v in sorted(missing)},
            {"commercial": "commercial", "restricted": "restricted", "DE": "DE",
             "DK": "DK", "NL": "NL", "UK": "UK"})

    def test_3_4_SPEC_DEVIATION_both_languages_are_hand_written_and_taxonomy_yml_is_never_read(self):
        # SPEC-DEVIATION: §3.4 says "English comes from `data/taxonomy.yml`;
        # French is a hand-written table in the generator". Both languages are
        # hand-written in the generator: TAXO holds `{key: (en, fr)}` literals
        # and the script never opens taxonomy.yml at all. §17 states the
        # accurate version — a new value goes "to `data/taxonomy.yml` and to
        # the matching TAXO table in the generator" — but nothing compares the
        # two, so an English label renamed upstream leaves the map's vocabulary
        # quietly disagreeing with the data repository's.
        #
        # The other §3.4 tests here cannot see that: they pin the emitted block
        # against MOD.TAXO, which is the table it was produced from. This one
        # pins the sourcing instead. Resolving the disagreement means editing
        # either the spec or the generator, and then this test fails and says
        # which claim moved.
        src = GENERATOR.read_text(encoding="utf-8")
        self.assertNotIn("taxonomy", src.lower())
        # Every YAML path the generator names: the per-layer glob, edges.yml
        # and the two description files. No vocabulary file among them.
        self.assertEqual(sorted(set(re.findall(r'"([^"\s]*\.yml)"', src))),
                         ["*.yml", "descriptions.{lang}.yml", "edges.yml", "organisations.yml"])
        self.assertEqual(re.findall(r'load_layer\(root, "(\w+)"\)', src),
                         ["teams", "projects", "infrastructure", "frameworks", "commons",
                          "clusters"])
        # And a checkout that does carry a taxonomy.yml is ignored: the emitted
        # block keeps the generator's English label, not the file's.
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        root = make_checkout(tmp, "with-taxonomy")
        (root / "data" / "taxonomy.yml").write_text(
            yaml.safe_dump({"status": {"concluded": "Finished"},
                            "tier": {"core": "Central"}}), encoding="utf-8")
        rendered = MOD.render(MOD.build(root), root)
        block = rendered.split("const TAXO = ", 1)[1].split(";\n\n", 1)[0]
        self.assertEqual(json.loads(block)["status"]["concluded"]["en"], "Concluded")
        self.assertEqual(json.loads(block)["tier"]["core"]["en"], "Core")
        self.assertNotIn("Finished", rendered)
        self.assertNotIn("Central", rendered)


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

    LAYERS = ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS")

    def test_every_one_of_the_five_entity_layers_is_consulted(self):
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


# The fixture behind the summary (§3). Per layer: entity id, description
# length, whether it has coordinates. The counts differ from layer to layer on
# purpose — five equal counts would let a mislabelled summary line print the
# right number anyway — and every layer holds one entity without coordinates,
# so a layer dropped from main()'s own geoless loop changes both the figure and
# the list of ids, whichever layer it is.
SUMMARY_FIXTURE = {
    "projects":   [("p1", 30, True), ("p2", 45, False)],
    "clusters":   [("k1", 40, True), ("k2", 55, False), ("k3", 65, True)],
    "commons":    [("c1", 90, False)],
    "teams":      [("t1", 60, True), ("t2", 0, True), ("t3", 75, False)],
    "frameworks": [("f1", 20, False), ("f2", 25, True),
                   ("f3", 35, True), ("f4", 50, True)],
}
SUMMARY_COUNTS = {"PROJECTS": 2, "CLUSTERS": 3, "COMMONS": 1, "TEAMS": 3, "FRAMEWORKS": 4,
                  "EDGES": 2}
# In the order main() walks the layers, which is not the order it prints them.
SUMMARY_GEOLESS = ["p2", "k2", "c1", "t3", "f1"]
# f4's English description, authored in data/i18n/descriptions.en.yml and
# longer than any `desc` in the fixture: main() reads `desc_en or desc`, and
# the longest thing on the map sits in the last layer its loop reaches.
SUMMARY_LONGEST = 137
SUMMARY_AS_OF = "2026-07-07"       # t2's last_updated — the freshest touch


class Main(unittest.TestCase):
    """§3 — the entry point a contributor actually types:
    `python3 scripts/build-map-data.py --source <checkout>`, which resolves the
    source, writes `assets/map/hai-data.js`, and prints a summary — "entities
    per layer, entities without coordinates, longest description — so a
    regression is visible at a glance".

    That summary is the mechanism §3 names, and main() computes two of its
    figures with its own loops over the four entity layers rather than reusing
    anything `build()` produced: a layer dropped from one of them makes the
    summary lie while every helper test above stays green. The argparse wiring
    and the post-write `stat()` are in the same position — the one command the
    README gives can break with no test to notice.

    Every test patches CANDIDATE_SOURCES and clears $EU_HAI_MAP_REPO, so a real
    checkout on the machine can neither be read instead of the fixture nor
    rescue a run that was meant to fail.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        os.environ.pop("EU_HAI_MAP_REPO", None)
        self.addCleanup(env.stop)
        cands = mock.patch.object(MOD, "CANDIDATE_SOURCES", [])
        cands.start()
        self.addCleanup(cands.stop)

    def checkout(self) -> Path:
        """A source checkout matching SUMMARY_FIXTURE."""
        root = make_checkout(self.tmp, "source")
        for layer, entities in SUMMARY_FIXTURE.items():
            for ident, length, located in entities:
                write_entity(root, layer, ident, desc=filler(length),
                             lat=52.0 if located else None,
                             lon=4.37 if located else None,
                             updated=SUMMARY_AS_OF if ident == "t2" else "2025-01-01")
        (root / "data" / "i18n").mkdir()
        (root / "data" / "i18n" / "descriptions.en.yml").write_text(
            yaml.safe_dump({"f4": filler(SUMMARY_LONGEST)}, width=4096),
            encoding="utf-8")
        (root / "data" / "edges.yml").write_text(
            "- project: p1\n  team: t1\n"               # kept
            "- cluster: k1\n  team: t1\n"               # kept: a cluster's member
            "- project: p1\n  team: no-such-team\n"     # dropped: unknown team
            "- project: f4\n  team: t1\n",              # dropped: not a project
            encoding="utf-8")
        return root

    def run_main(self, *argv) -> list[str]:
        printed = io.StringIO()
        with mock.patch.object(sys, "argv", ["build-map-data.py", *argv]), \
             contextlib.redirect_stdout(printed):
            MOD.main()
        return printed.getvalue().splitlines()

    def test_3_main_writes_the_payload_and_prints_the_summary_the_spec_names(self):
        root = self.checkout()
        out = self.tmp / "out" / "hai-data.js"
        out.parent.mkdir()
        lines = self.run_main("--source", str(root), "--out", str(out))

        # The entry point and the path every other test here drives have to
        # agree byte for byte: what render() is checked to produce is what the
        # command leaves on disk, with no second serialisation in between.
        data = MOD.build(root)
        self.assertEqual(out.read_text(encoding="utf-8"), MOD.render(data, root))

        self.assertEqual(lines[0], f"source  {root.resolve()}")
        # Outside the repository, so the path is printed whole (the relative
        # branch is the next test). The size is the file's, rounded the way the
        # summary rounds it; the fixture is past a kilobyte so the figure is a
        # real number rather than a floor-of-nothing zero.
        self.assertGreater(out.stat().st_size, 1024)
        self.assertEqual(lines[1],
                         f"out     {out}  ({out.stat().st_size / 1024:.0f} kB)")

        # One line per layer, in the printed order — which is neither the order
        # the loops walk nor the order render() emits — each with that layer's
        # count. The numbers come from the fixture, not from `data`; `data` is
        # then checked against the same numbers, so the two cannot drift
        # together into agreeing on something wrong.
        self.assertEqual(
            [l for l in lines if re.match(r"^  [a-z]+ +\d+$", l)],
            [f"  {name.lower():<11} {SUMMARY_COUNTS[name]}"
             for name in ("PROJECTS", "CLUSTERS", "TEAMS", "COMMONS", "FRAMEWORKS", "EDGES")])
        for name, count in SUMMARY_COUNTS.items():
            self.assertEqual(len(data[name]), count, name)

        # The entities without coordinates, counted and named (§3.1.4 keeps
        # them; the summary is how a curator sees how many there are).
        self.assertIn(
            f"  no lat/lon  {len(SUMMARY_GEOLESS)}  ({', '.join(SUMMARY_GEOLESS)})",
            lines)

        # The longest description. `filler` is unwrapped and single-spaced, so
        # norm_text returns it untouched and the character count is the
        # fixture's own — a loop missing a layer, or one that stopped reading
        # desc_en, reports 90 instead.
        self.assertEqual(len(MOD.norm_text(filler(SUMMARY_LONGEST))), SUMMARY_LONGEST)
        longest = next(l for l in lines if "longest description" in l)
        self.assertTrue(longest.startswith(f"  longest description  {SUMMARY_LONGEST} chars"),
                        longest)

        # And the freshness date the period filter's upper bound comes from.
        self.assertEqual(MOD.data_as_of(data), SUMMARY_AS_OF)
        as_of = next(l for l in lines if l.startswith("  as of"))
        self.assertTrue(as_of.startswith(f"  as of  {SUMMARY_AS_OF}"), as_of)

    def test_3_main_prints_the_out_path_relative_to_the_repository_when_it_is_inside_it(self):
        # Two branches behind one `is_relative_to`, and the usual run takes the
        # one the test above does not: `out  assets/map/hai-data.js`, not a
        # line of absolute path. REPO is patched rather than writing into the
        # real tree, which is the only way to reach that branch without a test
        # regenerating the committed payload.
        root = self.checkout()
        out = self.tmp / "assets" / "map" / "hai-data.js"
        out.parent.mkdir(parents=True)
        with mock.patch.object(MOD, "REPO", self.tmp):
            lines = self.run_main("--source", str(root), "--out", str(out))
        self.assertEqual(re.fullmatch(r"out +(\S+)  \(\d+ kB\)", lines[1]).group(1),
                         "assets/map/hai-data.js")
        self.assertTrue(out.exists())

    def test_3_main_writes_to_assets_map_hai_data_js_when_out_is_not_given(self):
        # §3's command line is `--source <checkout>` alone; the documented
        # destination lives in the --out default, not in the call.
        self.assertEqual(MOD.DEFAULT_OUT,
                         Path(MOD.REPO) / "assets" / "map" / "hai-data.js")
        root = self.checkout()
        stand_in = self.tmp / "default-out.js"
        with mock.patch.object(MOD, "DEFAULT_OUT", stand_in):
            lines = self.run_main("--source", str(root))
        self.assertTrue(stand_in.exists(), "nothing was written to the --out default")
        self.assertEqual(stand_in.read_text(encoding="utf-8"),
                         MOD.render(MOD.build(root), root))
        self.assertEqual(re.fullmatch(r"out +(\S+)  \(\d+ kB\)", lines[1]).group(1),
                         str(stand_in))

    def test_3_main_exits_with_the_three_routes_when_there_is_no_checkout(self):
        # Driven through main() rather than resolve_source() because this is
        # the shape of the failure a first-time contributor actually meets: a
        # non-zero exit with the message, before anything is written.
        (self.tmp / "not-a-checkout").mkdir()
        out = self.tmp / "unwritten.js"
        with self.assertRaises(SystemExit) as caught:
            self.run_main("--source", str(self.tmp / "not-a-checkout"),
                          "--out", str(out))
        self.assertNotIn(caught.exception.code, (0, None))
        message = str(caught.exception.code)
        self.assertIn("--source", message)
        self.assertIn("$EU_HAI_MAP_REPO", message)
        self.assertIn("git clone https://github.com/marota/eu-hai-collab-map.git", message)
        self.assertFalse(out.exists(), "a failed run must not leave a partial payload")

    def test_3_main_is_what_running_the_script_calls(self):
        # The tests above import the module and call main() directly; this is
        # the line that makes `python3 scripts/build-map-data.py` do the same.
        self.assertIn('if __name__ == "__main__":\n    main()\n',
                      GENERATOR.read_text(encoding="utf-8"))


class GeneratorDependencies(unittest.TestCase):
    """§3 — "The only dependency is PyYAML"."""

    def test_3_the_generator_imports_nothing_beyond_the_standard_library_and_pyyaml(self):
        # §1's no-dependencies commitment is proved exhaustively for the
        # published page; for the pipeline it means something just as concrete
        # — a contributor with PyYAML and nothing else can regenerate the
        # payload. A `requests`, `rich` or `python-dateutil` import added for
        # convenience breaks that for everyone cloning the repository, and the
        # only signal is an ImportError on someone else's machine.
        #
        # Parsed statically rather than read off the imported module, so a
        # convenience import tucked inside a function body counts too.
        tree = ast.parse(GENERATOR.read_text(encoding="utf-8"), str(GENERATOR))
        roots = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                # The script is standalone — it is loaded by path, not as part
                # of a package, so a relative import could not resolve at all.
                self.assertEqual(node.level, 0, ast.dump(node))
                roots.add((node.module or "").split(".")[0])
        self.assertIn("yaml", roots, "the generator stopped importing PyYAML")
        self.assertEqual(roots - set(sys.stdlib_module_names), {"yaml"})


if __name__ == "__main__":
    unittest.main()
