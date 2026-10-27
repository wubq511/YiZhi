import json
from pathlib import Path
import tempfile
import unittest

from reviewboard.knowledge import KnowledgeCatalog

from course_fixture import copy_course


class KnowledgeViewTests(unittest.TestCase):
    def setUp(self):
        self.root = copy_course(self)

    def test_complete_unit_publishes_identity_theme_and_reading(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "map.json"
            data = json.loads((self.root / "期中/数据/知识地图.json").read_text(encoding="utf-8"))
            unit = next(item for item in data["units"] if item["id"] == "KU-001")
            unit["reading"] = {"schemaVersion": "review-reading-1", "revision": 1,
                               "status": "complete", "blocks": [], "coverage": []}
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            view = KnowledgeCatalog(self.root, path).view()
            self.assertIn("KU-001", view["publishedIds"])
            self.assertIn("KU-001", {item["id"] for item in view["units"]})
            self.assertIn("TH-01", {item["id"] for item in view["themes"]})
            self.assertEqual(next(item for item in view["units"] if item["id"] == "KU-001")["reading"]["status"], "complete")
            self.assertNotIn("KU-049", view["publishedIds"])
            self.assertNotIn("KU-073", view["publishedIds"])

    def test_view_exposes_canonical_layout_and_reading_order(self):
        catalog = KnowledgeCatalog(self.root, self.root / "期中/数据/知识地图.json")
        view = catalog.view()
        self.assertEqual(view["layout"], catalog.graph("all")["layout"])
        nodes = {item["unitId"]: item for item in view["layout"]["nodes"]}
        groups = {item["themeId"]: item for item in view["layout"]["groups"]}
        self.assertLess(nodes["KU-042"]["x"], nodes["KU-043"]["x"])
        self.assertGreater(nodes["KU-044"]["y"], nodes["KU-042"]["y"])
        self.assertLess(groups["TH-01"]["x"], groups["TH-04"]["x"])


if __name__ == "__main__":
    unittest.main()
