"""Version-bound textbook text/search, using actual tiny PDFs and local OCR."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reviewboard.material_sources import MaterialSourceLibrary
from reviewboard.search import CourseSearch
from reviewboard.storage import StoreError


OCR_ROOT = Path("教材/数字设计和计算机体系结构-检索版")


def pdf_bytes(text, color):
    """Real one-page PDF with an embedded standard font and actual xref offsets."""
    content = f"{color} rg 20 20 70 70 re f\n".encode()
    if text is not None:
        content += f"0 0 0 rg BT /F1 16 Tf 20 200 Td ({text}) Tj ET\n".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
               b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream"]
    data, offsets = b"%PDF-1.4\n", [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(data)
    data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    return data + f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()


class Catalog:
    def __init__(self, source):
        self.source = source

    def get(self, identifier):
        if identifier != self.source["id"]:
            raise StoreError("not_found", "fixture source not found")
        return deepcopy(self.source)

    def store(self):
        digest = hashlib.sha256(json.dumps(self.source, sort_keys=True).encode()).hexdigest()
        return SimpleNamespace(hash=digest, sources={self.source["id"]: deepcopy(self.source)},
                               themes={}, units={}, questions={})


class MaterialSourceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="material-sources-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.index = self.root / OCR_ROOT
        (self.index / "OCR").mkdir(parents=True)
        self.old = self.root / "教材/original.pdf"
        self.new = self.root / ".review-board/materials/new.pdf"
        self.new.parent.mkdir(parents=True)
        self.old.write_bytes(pdf_bytes("ORIGINALPDF", "1 0 0"))
        self.new.write_bytes(pdf_bytes("NEWVERSIONTEXT", "0 0 1"))
        self.manifest = {"source_file": "../original.pdf", "source_sha256": self.digest(self.old), "pdf_pages": 1}
        self.save_manifest()
        (self.index / "OCR/0001.json").write_text(json.dumps({"pdf_page": 1,
            "lines": [{"text": "ORIGINALOCR"}]}), encoding="utf-8")
        # Deliberately put new first, and point source.path at the new version.
        # OCR identity must be independent of either mutable catalog convention.
        self.source = {"id": "SRC-BOOK", "type": "textbook", "title": "fixture textbook",
                       "path": str(self.new.relative_to(self.root)), "totalPages": 1,
                       "versions": [self.version("VER-new", self.new), self.version("VER-old", self.old)]}
        self.catalog = Catalog(self.source)
        self.library = MaterialSourceLibrary(self.root, self.catalog, self.root / "cache")
        self.search = CourseSearch(self.catalog, self.library, lambda: {"sequence": 0, "documents": {}})

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def version(self, identifier, path):
        return {"id": identifier, "path": str(path.relative_to(self.root)), "sha256": self.digest(path),
                "displayName": identifier, "totalPages": 1}

    def save_manifest(self):
        (self.index / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def require_poppler(self, *commands):
        if not all(shutil.which(command) for command in commands):
            self.skipTest("real PDF regression requires " + ", ".join(commands))

    def test_resolve_real_pdf_versions_keeps_ocr_on_original_only(self):
        self.require_poppler("pdftotext")
        old = self.library.resolve("SRC-BOOK", "VER-old", {"pdfPage": 1})
        new = self.library.resolve("SRC-BOOK", "VER-new", {"pdfPage": 1})
        self.assertEqual(old["text"], "ORIGINALOCR")
        self.assertEqual(old["textStatus"], "ocr")
        self.assertIn("NEWVERSIONTEXT", new["text"])
        self.assertNotIn("ORIGINALOCR", new["text"])
        self.assertEqual(new["textStatus"], "text-layer")
        self.assertIn("/VER-new/", new["pageImageUrl"])

    def test_real_search_separates_old_and_new_version_hits(self):
        self.require_poppler("pdftotext")
        old = self.search.search("ORIGINALOCR", scopes=["sources"])
        new = self.search.search("NEWVERSIONTEXT", scopes=["sources"])
        self.assertEqual([hit["version"] for hit in old["items"]], ["VER-old"])
        self.assertEqual([hit["version"] for hit in new["items"]], ["VER-new"])
        self.assertEqual(self.library.text_pages("SRC-BOOK", "VER-old")[0]["textStatus"], "ocr")
        self.assertEqual(self.library.text_pages("SRC-BOOK", "VER-new")[0]["textStatus"], "text-layer")

    def test_real_scanned_new_version_unavailable_and_actual_png_remains(self):
        self.require_poppler("pdftotext", "pdftoppm")
        self.new.write_bytes(pdf_bytes(None, "0 0 1"))
        self.source["versions"][0] = self.version("VER-new", self.new)
        resolved = self.library.resolve("SRC-BOOK", "VER-new", {"pdfPage": 1})
        self.assertEqual(resolved["textStatus"], "unavailable")
        self.assertFalse(resolved["text"].strip())
        result = self.search.search("ORIGINALOCR", scopes=["sources"])
        self.assertEqual([hit["version"] for hit in result["items"]], ["VER-old"])
        self.assertEqual(len(result["sourceWarnings"]), 1)
        warning = result["sourceWarnings"][0]
        self.assertEqual((warning["sourceId"], warning["versionId"]), ("SRC-BOOK", "VER-new"))
        self.assertEqual(warning["code"], "source_unavailable")
        self.assertEqual(warning["unavailablePages"], 1)
        self.assertEqual(warning["location"], {"pdfPages": [1]})
        self.assertIn("没有可用文本", warning["message"])
        new_image = self.library.page_image("SRC-BOOK", "VER-new", 1)
        old_image = self.library.page_image("SRC-BOOK", "VER-old", 1)
        self.assertEqual(new_image.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        self.assertNotEqual(new_image.read_bytes(), old_image.read_bytes())
        selection = self.library.selection("SRC-BOOK", "VER-new", {"pdfPage": 1})
        self.assertEqual(selection["contentKind"], "page")
        self.assertEqual(selection["pageImageUrl"], resolved["pageImageUrl"])

    def test_pdf_extraction_failure_never_falls_back_to_unrelated_ocr(self):
        for failure in (FileNotFoundError("pdftotext"), subprocess.TimeoutExpired("pdftotext", 60)):
            with self.subTest(failure=type(failure).__name__), patch.object(
                    self.library, "_all_pdf_text", side_effect=failure):
                resolved = self.library.resolve("SRC-BOOK", "VER-new", {"pdfPage": 1})
                self.assertEqual(resolved["textStatus"], "unavailable")
                self.assertEqual(resolved["text"], "")
                self.assertIn("pageImageUrl", resolved)
                self.assertEqual(self.library.text_pages("SRC-BOOK", "VER-new")[0]["textStatus"], "unavailable")
                self.assertEqual(self.library.resolve("SRC-BOOK", "VER-old", {"pdfPage": 1})["text"], "ORIGINALOCR")

    def test_ocr_requires_manifest_path_and_digest_both(self):
        cases = ({"source_file": "../other.pdf"}, {"source_sha256": "0" * 64})
        for changes in cases:
            with self.subTest(changes=changes):
                self.manifest.update(changes)
                self.save_manifest()
                with patch.object(self.library, "_all_pdf_text", return_value=["VERIFIEDPDF"]):
                    self.assertEqual(self.library.resolve("SRC-BOOK", "VER-old", {"pdfPage": 1})["text"], "VERIFIEDPDF")
                self.manifest = {"source_file": "../original.pdf", "source_sha256": self.digest(self.old), "pdf_pages": 1}
        self.save_manifest()
        # Even byte-identical copied paths are not the fixed OCR's bound path.
        self.new.write_bytes(self.old.read_bytes())
        self.source["versions"][0] = self.version("VER-new", self.new)
        with patch.object(self.library, "_all_pdf_text", return_value=["COPIEDPDF"]):
            self.assertEqual(self.library.resolve("SRC-BOOK", "VER-new", {"pdfPage": 1})["text"], "COPIEDPDF")

    def test_missing_or_malformed_manifest_uses_pdf_without_claiming_ocr(self):
        for raw in (None, "{bad-json", "[]", '{"source_file":null,"source_sha256":null}'):
            with self.subTest(raw=raw):
                path = self.index / "manifest.json"
                if raw is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(raw, encoding="utf-8")
                with patch.object(self.library, "_all_pdf_text", return_value=["ACTUALPDF"]):
                    resolved = self.library.resolve("SRC-BOOK", "VER-old", {"pdfPage": 1})
                    self.assertEqual(resolved["text"], "ACTUALPDF")
                    self.assertEqual(resolved["textStatus"], "text-layer")

    def test_version_digest_and_page_bounds_still_enforced(self):
        for location in ({"pdfPage": 0}, {"pdfPage": 2}):
            with self.subTest(location=location), self.assertRaises(StoreError) as caught:
                self.library.resolve("SRC-BOOK", "VER-new", location)
            self.assertEqual(caught.exception.code, "invalid_parameter")
        self.source["versions"][0]["sha256"] = "0" * 64
        with self.assertRaises(StoreError) as caught:
            self.library.resolve("SRC-BOOK", "VER-new", {"pdfPage": 1})
        self.assertEqual(caught.exception.code, "source_unavailable")

    def test_new_edition_does_not_inherit_old_book_page_offset(self):
        self.source['versions'][0]['totalPages']=20
        with patch.object(self.library,'_all_pdf_text',return_value=['NEW']*20):
            page=self.library.resolve('SRC-BOOK','VER-new',{'pdfPage':15})
            self.assertEqual(page['location'],{'pdfPage':15})
            self.assertEqual(self.library.text_pages('SRC-BOOK','VER-new')[14]['location'],{'pdfPage':15})
            with self.assertRaises(StoreError) as caught:
                self.library.resolve('SRC-BOOK','VER-new',{'bookPage':1})
            self.assertEqual(caught.exception.code,'invalid_parameter')


if __name__ == "__main__":
    unittest.main()
