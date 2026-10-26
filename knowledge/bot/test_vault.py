"""Tests for vault.py. Run: python3 -m unittest discover -s knowledge/bot"""

import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vault  # noqa: E402

NOTE = """---
type: concept
created: 2026-01-13
updated: 2026-01-13
status: draft
---
# Seasons come from axial tilt

Links to [[Earth|our planet]], [[raw/2026-01-04_planetarium_talk]], [[Nowhere#Heading]] and [[Note Title]].
"""


class Vault(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        v = self.v = Path(self.tmp.name)
        (v / "concepts" / "astronomy").mkdir(parents=True)
        (v / "entities").mkdir()
        (v / "raw").mkdir()
        (v / "concepts" / "astronomy" / "Seasons come from axial tilt.md").write_text(NOTE)
        (v / "entities" / "Earth.md").write_text("---\ntype: entity-moc\ncreated: 2025-12-01\nupdated: 2025-12-01\nstatus: draft\n---\n# Earth\n")
        (v / "entities" / "Old.md").write_text("no frontmatter here [[Gone]]\n")
        (v / "raw" / "2026-01-04_planetarium_talk.md").write_text("verbatim, no frontmatter needed")
        (v / "CLAUDE.md").write_text("templates like [[Nowhere-in-rules]] are ignored")

    def tearDown(self):
        self.tmp.cleanup()

    def test_check_splits_todays_problems_from_older_ones(self):
        fresh, old = vault.check(self.v, date(2026, 1, 13))
        self.assertEqual(fresh, ["concepts/astronomy/Seasons come from axial tilt.md: broken link [[Nowhere]]"])
        self.assertIn("entities/Old.md: no frontmatter", old)
        self.assertIn("entities/Old.md: broken link [[Gone]]", old)
        self.assertFalse(any("CLAUDE.md" in x or "raw/" in x for x in fresh + old))

    def test_duplicate_filenames_are_flagged(self):
        (self.v / "concepts" / "Earth.md").write_text("---\ntype: concept\nstatus: draft\n---\n")
        fresh, _ = vault.check(self.v, date(2026, 1, 13))
        self.assertTrue(any(x.startswith("duplicate filename (2x): Earth.md") for x in fresh))

    def test_stats_and_find(self):
        self.assertIn("1 concept", vault.stats(self.v))
        self.assertIn("To be filed: 0", vault.stats(self.v))
        self.assertEqual(vault.find(["seasons", "axial"], self.v)[0][1], "concepts/astronomy/Seasons come from axial tilt.md")
        self.assertEqual(vault.find(["nothing-like-this"], self.v), [])


if __name__ == "__main__":
    unittest.main()
