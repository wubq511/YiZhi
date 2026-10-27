import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import subprocess
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from reviewboard.knowledge import KnowledgeCatalog
from reviewboard.sources import SourceLibrary
from reviewboard.storage import StoreError

from course_fixture import copy_course

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==")


class PageImageCacheTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        pdf = self.root / "fixture.pdf"
        pdf.write_bytes(b"PDF fixture: subprocess is controlled by these tests")
        source = {"id": "SRC-test", "type": "supplementary", "totalPages": 2,
                  "versions": [{"id": "VER-test", "path": pdf.name,
                                "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest()}]}
        self.cache = self.root / "cache"
        self.library = SourceLibrary(self.root, {source["id"]: source}, self.cache)
        self.target = self.cache / "SRC-test-VER-test-1.png"

    def read_page(self, page=1):
        # Read immediately at the real call site, while the renderer may still run.
        return self.library.page_image("SRC-test", "VER-test", page).read_bytes()

    def test_same_page_waits_for_complete_image_and_renders_once(self):
        for partial_output in (False, True):
            with self.subTest(partial_output=partial_output):
                self.target.unlink(missing_ok=True)
                rendering, finish, second_validated, second_done = (Event() for _ in range(4))
                validate = self.library._pdf_location

                def tracked_validation(*args):
                    result = validate(*args)
                    if rendering.is_set():
                        second_validated.set()
                    return result

                def render(args, **kwargs):
                    output = Path(args[-1] + ".png")
                    if partial_output:
                        output.write_bytes(PNG[:len(PNG) // 2])
                    rendering.set()
                    if not finish.wait(5):
                        raise AssertionError("renderer was not released")
                    output.write_bytes(PNG)
                    return subprocess.CompletedProcess(args, 0)

                def second_reader():
                    try:
                        return self.read_page()
                    finally:
                        second_done.set()

                with patch.object(self.library, "_pdf_location", side_effect=tracked_validation), \
                        patch("reviewboard.sources.subprocess.run", side_effect=render) as run, \
                        ThreadPoolExecutor(max_workers=2) as pool:
                    try:
                        first = pool.submit(self.read_page)
                        self.assertTrue(rendering.wait(5))
                        second = pool.submit(second_reader)
                        self.assertTrue(second_validated.wait(5))
                        returned_early = second_done.wait(0.2)
                        visible_during_render = self.target.is_file()
                    finally:
                        finish.set()
                    first_bytes, second_bytes = first.result(5), second.result(5)
                self.assertEqual(second_bytes, PNG, "a concurrent caller read a partial PNG")
                self.assertFalse(returned_early, "same-page caller returned before render completed")
                self.assertFalse(visible_during_render, "unfinished render exposed a public cache file")
                self.assertEqual(first_bytes, PNG)
                self.assertEqual(run.call_count, 1, "same page rendered twice")
                self.assertEqual(self.read_page(), PNG)
                self.assertEqual(list(self.cache.iterdir()), [self.target])

    def test_different_pages_can_render_in_parallel(self):
        started = {page: Event() for page in (1, 2)}
        finish = Event()

        def render(args, **kwargs):
            started[int(args[args.index("-f") + 1])].set()
            if not finish.wait(5):
                raise AssertionError("renderer was not released")
            Path(args[-1] + ".png").write_bytes(PNG)
            return subprocess.CompletedProcess(args, 0)

        with patch("reviewboard.sources.subprocess.run", side_effect=render), \
                ThreadPoolExecutor(max_workers=2) as pool:
            try:
                futures = [pool.submit(self.read_page, page) for page in (1, 2)]
                self.assertTrue(started[1].wait(5))
                self.assertTrue(started[2].wait(5), "one page blocked a different page")
            finally:
                finish.set()
            self.assertEqual([future.result(5) for future in futures], [PNG, PNG])

    def test_render_failures_clean_temporary_files_and_allow_retry(self):
        for failure in ("exit", "missing", "timeout", "tool_missing", "os_error"):
            with self.subTest(failure=failure):
                self.target.unlink(missing_ok=True)

                def render(args, **kwargs):
                    if failure != "missing":
                        Path(args[-1] + ".png").write_bytes(PNG[:10])
                    if failure == "timeout":
                        raise subprocess.TimeoutExpired(args, 60)
                    if failure == "tool_missing":
                        raise FileNotFoundError("pdftoppm")
                    if failure == "os_error":
                        raise OSError("renderer could not start")
                    return subprocess.CompletedProcess(args, 1 if failure == "exit" else 0)

                with patch("reviewboard.sources.subprocess.run", side_effect=render):
                    with self.assertRaises(StoreError) as caught:
                        self.read_page()
                self.assertEqual(caught.exception.code, "source_unavailable")
                self.assertEqual(list(self.cache.iterdir()), [])

                def succeed(args, **kwargs):
                    Path(args[-1] + ".png").write_bytes(PNG)
                    return subprocess.CompletedProcess(args, 0)

                with patch("reviewboard.sources.subprocess.run", side_effect=succeed):
                    self.assertEqual(self.read_page(), PNG)
                self.assertEqual(list(self.cache.iterdir()), [self.target])

    def test_failed_renderer_does_not_remove_another_publishers_cache(self):
        for failure in ("exit", "timeout"):
            with self.subTest(failure=failure):
                self.target.unlink(missing_ok=True)

                def render(args, **kwargs):
                    Path(args[-1] + ".png").write_bytes(PNG[:10])
                    # Another publisher completes while this renderer is in flight.
                    self.target.write_bytes(PNG)
                    if failure == "timeout":
                        raise subprocess.TimeoutExpired(args, 60)
                    return subprocess.CompletedProcess(args, 1)

                with patch("reviewboard.sources.subprocess.run", side_effect=render) as run:
                    with self.assertRaises(StoreError) as caught:
                        self.read_page()
                    self.assertEqual(caught.exception.code, "source_unavailable")
                    self.assertEqual(self.read_page(), PNG)
                    self.assertEqual(run.call_count, 1)
                self.assertEqual(list(self.cache.iterdir()), [self.target])


class SourceLibraryTests(unittest.TestCase):
    def setUp(self):
        self.root = copy_course(self)
        self.catalog = KnowledgeCatalog(self.root, self.root / "期中/数据/知识地图.json")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = SourceLibrary(self.root, self.catalog, Path(self.tmp.name))
        source = self.catalog.get("SRC-C05")
        self.version = source["versions"][0]["id"]

    def test_resolve_checks_version_and_page_bounds(self):
        resolved = self.library.resolve("SRC-C05", self.version, {"pdfPage": 38})
        self.assertEqual(resolved["sourceId"], "SRC-C05")
        self.assertEqual(resolved["versionId"], self.version)
        self.assertEqual(resolved["location"]["pdfPage"], 38)
        self.assertEqual(resolved["pageCount"], 61)
        self.assertIn("74LS138", resolved["text"])
        with self.assertRaises(StoreError) as version_error:
            self.library.resolve("SRC-C05", "VER-old", {"pdfPage": 38})
        self.assertEqual(version_error.exception.code, "source_unavailable")
        for page in (0, 62):
            with self.subTest(page=page), self.assertRaises(StoreError) as page_error:
                self.library.resolve("SRC-C05", self.version, {"pdfPage": page})
            self.assertEqual(page_error.exception.code, "invalid_parameter")

    def test_selection_uses_real_text_or_explicit_page_region(self):
        selected = self.library.selection("SRC-C05", self.version,
                                          {"pdfPage": 38}, text="74LS138")
        self.assertEqual(selected["text"], "74LS138")
        self.assertEqual(selected["contentKind"], "text")
        with self.assertRaises(StoreError) as invalid:
            self.library.selection("SRC-C05", self.version,
                                   {"pdfPage": 38}, text="并未选中的捏造文字")
        self.assertEqual(invalid.exception.code, "invalid_content")
        region = self.library.selection("SRC-C05", self.version,
                                        {"pdfPage": 38, "rect": [0.1, 0.2, 0.8, 0.9]})
        self.assertIsNone(region["text"])
        self.assertEqual(region["contentKind"], "page-region")
        self.assertEqual(region["location"]["rect"], [0.1, 0.2, 0.8, 0.9])

    def test_render_page_uses_requested_source_version(self):
        image = self.library.page_image("SRC-C05", self.version, 38)
        self.assertTrue(image.is_file())
        self.assertEqual(image.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(image.parent, Path(self.tmp.name))


if __name__ == "__main__":
    unittest.main()
