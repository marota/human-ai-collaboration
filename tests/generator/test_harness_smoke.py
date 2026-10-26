"""Exemplar: proves the Python harness can reach the generator and the payload."""
import unittest

from tests._harness import load_generator, load_payload, map_script


class HarnessSmoke(unittest.TestCase):
    def test_generator_imports(self):
        mod = load_generator()
        self.assertTrue(callable(mod.build))
        self.assertIn("energy", mod.SECTOR.values())

    def test_payload_parses(self):
        data = load_payload()
        self.assertEqual(
            sorted(data), ["AS_OF", "COMMONS", "EDGES", "FRAMEWORKS", "PROJECTS", "TAXO", "TEAMS"])
        self.assertGreater(len(data["TEAMS"]), 0)

    def test_inline_script_is_reachable(self):
        self.assertIn("function matchesFilters", map_script())


if __name__ == "__main__":
    unittest.main()
