"""The issue form: how a visitor proposes an entry without the chat (§18.7).

When the chat cannot serve a visitor, the map sends them to a GitHub issue form,
`.github/ISSUE_TEMPLATE/map-entry.yml`, or its French twin `map-entry-fr.yml`, and
the site page explains it under *Directly on GitHub*. Three things can drift there
without anything failing, because GitHub only reads a form when someone opens it:

- the form stops being one GitHub accepts, and the visitor silently gets a blank
  issue instead of the guidance;
- the two languages stop asking the same questions, and a French proposal arrives
  without what an English one carries;
- its choices stop being the map's words, and a proposal arrives in a vocabulary
  the review has to translate back.

The expected words are read from the map's own `I18N` and the payload's `TAXO`,
not written down here, so a renamed domain fails this file until the form follows.
"""
from __future__ import annotations

import json
import re
import unittest

import yaml

from tests._harness import REPO, load_chat, load_payload, map_script

FORMS = REPO / ".github" / "ISSUE_TEMPLATE"
FILES = {"en": "map-entry.yml", "fr": "map-entry-fr.yml"}
BOTH = {lang: yaml.safe_load((FORMS / name).read_text(encoding="utf-8"))
        for lang, name in FILES.items()}
EN, FR = BOTH["en"], BOTH["fr"]
NEW_ISSUE = "https://github.com/marota/human-ai-collaboration/issues/new"
SCRIPT = map_script()

# What GitHub reads in an issue form, and nothing else ("Syntax for issue forms").
TOP_KEYS = {"name", "description", "title", "labels", "assignees", "body", "projects", "type"}
FIELD_TYPES = {"input", "textarea", "dropdown", "checkboxes"}


def fields(form: dict) -> list[dict]:
    return [b for b in form["body"] if b["type"] != "markdown"]


def field(form: dict, fid: str) -> dict:
    return next(b for b in fields(form) if b["id"] == fid)


def required(b: dict) -> bool:
    return bool((b.get("validations") or {}).get("required"))


def words(lang: str) -> str:
    """The map's I18N block for one language, as source text."""
    fr, en = SCRIPT.index("\n  fr: {"), SCRIPT.index("\n  en: {")
    return SCRIPT[fr:en] if lang == "fr" else SCRIPT[en:SCRIPT.index("\n};", en)]


def js_string(s: str) -> str:
    return json.loads('"' + s.replace("\\'", "'").replace('"', '\\"') + '"')


def layer_names(lang: str) -> list[str]:
    """The layer names in the map's own order (KINDS), in one language."""
    kinds = re.findall(r"'(\w+)'", re.search(r"const KINDS = \[(.*?)\];", SCRIPT).group(1))
    names = dict(re.findall(r"'kinds\.(\w+)':'((?:[^'\\]|\\.)*)'", words(lang)))
    return [js_string(names[k]) for k in kinds]


def domain_names(lang: str) -> list[str]:
    body = re.search(r"\bdom:\{([^}]*)\}", words(lang)).group(1)
    return [js_string(v) for _, v in re.findall(r"(\w+):'((?:[^'\\]|\\.)*)'", body)]


class GitHubAcceptsIt(unittest.TestCase):
    """A form GitHub cannot read falls back to a blank issue, and says nothing."""

    def test_18_7_only_keys_github_reads(self):
        for lang, form in BOTH.items():
            with self.subTest(lang):
                self.assertLessEqual(set(form), TOP_KEYS)
                for key in ("name", "description", "body"):
                    self.assertTrue(form.get(key), key)

    def test_18_7_every_field_is_one_github_draws(self):
        for lang, form in BOTH.items():
            with self.subTest(lang):
                ids = [b["id"] for b in fields(form)]
                self.assertEqual(len(ids), len(set(ids)), "ids are unique")
                labels = [b["attributes"]["label"] for b in fields(form)]
                self.assertEqual(len(labels), len(set(labels)), "labels are unique")
                for b in form["body"]:
                    if b["type"] == "markdown":
                        self.assertTrue(b["attributes"]["value"].strip())
                        self.assertNotIn("validations", b)
                        continue
                    self.assertIn(b["type"], FIELD_TYPES)
                    self.assertRegex(b["id"], r"^[A-Za-z0-9_-]+$")
                    if b["type"] == "dropdown":
                        options = b["attributes"]["options"]
                        self.assertTrue(options)
                        self.assertEqual(len(options), len(set(options)))
                        # GitHub reserves "None" for a dropdown left empty.
                        self.assertNotIn("none", [o.strip().lower() for o in options])

    def test_18_7_the_chooser_offers_the_chat_and_keeps_blank_issues(self):
        config = yaml.safe_load((FORMS / "config.yml").read_text(encoding="utf-8"))
        self.assertLessEqual(set(config), {"blank_issues_enabled", "contact_links"})
        self.assertIs(config["blank_issues_enabled"], True)
        for link in config["contact_links"]:
            self.assertEqual(set(link), {"name", "url", "about"})
        self.assertTrue(any("eu-hai-map.html" in link["url"] and "chat=1" in link["url"]
                            for link in config["contact_links"]))


class TheMinimumThenWhatHelps(unittest.TestCase):
    """The minimum a reviewer needs is required; everything else is asked, not demanded."""

    MINIMUM = ["kind", "layer", "name", "source", "details"]

    def test_18_7_the_minimum_is_required_and_nothing_else_is(self):
        for lang, form in BOTH.items():
            with self.subTest(lang):
                self.assertEqual([b["id"] for b in fields(form) if required(b)], self.MINIMUM)

    def test_18_7_the_minimum_comes_first(self):
        for lang, form in BOTH.items():
            with self.subTest(lang):
                flags = [required(b) for b in fields(form)]
                self.assertEqual(flags, sorted(flags, reverse=True))

    def test_18_7_both_languages_ask_the_same_questions(self):
        def shape(form):
            return [(b["type"], b.get("id"), required(b), b["attributes"].get("multiple", False),
                     len(b["attributes"].get("options", []))) for b in form["body"]]
        self.assertEqual(shape(FR), shape(EN))

    def test_18_7_its_issues_sort_with_the_chats(self):
        # Both routes land in one tracker; the maintainer reads them under one title prefix.
        self.assertEqual(FR["title"], EN["title"])
        self.assertEqual(FR["labels"], EN["labels"])
        issues = load_chat().issues
        self.assertTrue(issues.title_for("add", "team", {"name": "X"}).startswith(EN["title"].strip()))
        self.assertTrue(issues.title_for("fix", "team", {"name": "X"}).startswith(EN["title"].strip()))


class TheMapsOwnWords(unittest.TestCase):
    """The choices are the map's vocabulary, in the form's language."""

    def test_18_7_layers_are_the_maps_layers_in_its_order(self):
        for lang, form in BOTH.items():
            with self.subTest(lang):
                options = field(form, "layer")["attributes"]["options"]
                self.assertEqual([o.split(" — ")[0] for o in options], layer_names(lang))

    def test_18_7_domains_are_the_maps_domains(self):
        for lang, form in BOTH.items():
            with self.subTest(lang):
                self.assertEqual(field(form, "domains")["attributes"]["options"], domain_names(lang))

    def test_18_7_research_axes_are_the_payloads_focus_areas(self):
        focus = load_payload()["TAXO"]["focus"]
        for lang, form in BOTH.items():
            with self.subTest(lang):
                self.assertEqual(field(form, "focus_areas")["attributes"]["options"],
                                 [entry[lang] for entry in focus.values()])


class EveryWayInLeadsToIt(unittest.TestCase):
    """The page, the chat and each form send a reader to the form in their language."""

    def test_18_7_the_site_page_links_both_forms(self):
        page = (REPO / "map.md").read_text(encoding="utf-8")
        for name in FILES.values():
            self.assertIn(f"{NEW_ISSUE}?template={name}", page)

    def test_18_7_the_chat_sends_each_language_to_its_form(self):
        chat = (REPO / "assets" / "map" / "hai-chat.js").read_text(encoding="utf-8")
        self.assertIn(f"const ISSUES = '{NEW_ISSUE}'", chat)
        for lang, form in BOTH.items():
            with self.subTest(lang):
                self.assertIn(f"'{FILES[lang]}'", chat)
                # The link reads as the name of the form it opens.
                self.assertIn(f"issueForm: '{form['name']}'", chat)

    def test_18_7_each_form_points_to_the_other_language(self):
        self.assertIn(f"{NEW_ISSUE}?template={FILES['fr']}", EN["body"][0]["attributes"]["value"])
        self.assertIn(f"{NEW_ISSUE}?template={FILES['en']}", FR["body"][0]["attributes"]["value"])


if __name__ == "__main__":
    unittest.main()
