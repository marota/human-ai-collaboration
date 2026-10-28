"""The citation GitHub offers as "Cite this repository", built from CITATION.cff.

GitHub formats the file's `preferred-citation` when there is one, and otherwise
the file itself, as software. It ends the citation with the DOI if there is one,
else with `repository-code`, else with `url`. Without `preferred-citation`, the
repository's address in the file sent readers of the series to its code, so
this file checks what a reader gets: the series, by its author, at the site's
address or, once deposited, at its DOI.
"""
from __future__ import annotations

import unittest

import yaml

from tests._harness import REPO

CFF = yaml.safe_load((REPO / "CITATION.cff").read_text(encoding="utf-8"))
CONFIG = yaml.safe_load((REPO / "_config.yml").read_text(encoding="utf-8"))
SITE = CONFIG["url"] + CONFIG["baseurl"]

# The types the Citation File Format 1.2.0 allows for the file itself.
FILE_TYPES = {"software", "dataset"}
# The reference types GitHub labels "[Computer software]" ("About CITATION files").
SOFTWARE = {"software", "software-code", "software-container",
            "software-executable", "software-virtual-machine"}


def cited_at(ref: dict) -> str:
    """The address GitHub puts at the end of the citation."""
    if ref.get("doi"):
        return f"https://doi.org/{ref['doi']}"
    return ref.get("repository-code") or ref.get("url", "")


class CiteThisRepository(unittest.TestCase):
    def test_the_file_is_one_the_format_allows(self):
        self.assertEqual(CFF["cff-version"], "1.2.0")
        self.assertIn(CFF.get("type", "software"), FILE_TYPES)

    def test_github_cites_the_series_not_the_code(self):
        series = CFF.get("preferred-citation")
        self.assertIsNotNone(series, "without it, GitHub cites the repository as software")
        self.assertNotIn(series["type"], SOFTWARE)
        self.assertEqual(series["title"], CFF["title"])
        self.assertEqual(series["authors"], CFF["authors"])
        self.assertIsInstance(series.get("year"), int, "the citation's year")

    def test_it_sends_the_reader_to_the_site_or_the_doi(self):
        self.assertEqual(CFF["url"].rstrip("/"), SITE)
        address = cited_at(CFF["preferred-citation"])
        if not address.startswith("https://doi.org/"):
            self.assertEqual(address.rstrip("/"), SITE)


if __name__ == "__main__":
    unittest.main()
