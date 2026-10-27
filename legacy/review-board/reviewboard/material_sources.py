"""Uploaded material readers and identity-bound textbook OCR.

The fixed OCR directory belongs to the PDF path and digest in its manifest,
not to every version of a source whose type happens to be ``textbook``.
"""
import json
from pathlib import Path
import subprocess

from .sources import SourceLibrary
from .storage import StoreError


class MaterialSourceLibrary(SourceLibrary):
    _TEXTBOOK_OCR = Path("教材/数字设计和计算机体系结构-检索版")

    def _uses_textbook_ocr(self, source, version, path):
        if source["type"] != "textbook":
            return False
        try:
            manifest_path = self._inside(str(self._TEXTBOOK_OCR / "manifest.json"))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict):
                return False
            original = manifest.get("source_file")
            if not isinstance(original, str) or not original:
                return False
            original = (manifest_path.parent / original).resolve()
            # _source already verified the requested file against version.sha256.
            # Neither source.path nor versions[0] identifies the OCR's PDF.
            return (original.is_relative_to(self.root) and original == path.resolve()
                    and manifest.get("source_sha256") == version["sha256"])
        except (OSError, ValueError, StoreError):
            # An unverified/missing OCR manifest cannot authorize borrowed text.
            return False

    def _pdf_reader(self, source, version, path):
        if self._uses_textbook_ocr(source, version, path):
            return self._textbook_text, "ocr"
        try:
            pages = self._all_pdf_text(source, version, path)
        except (OSError, subprocess.TimeoutExpired):
            # Keep the actual version's resource/page-image URLs usable even if
            # the extractor is absent or cannot finish. Never borrow old OCR.
            pages = []
        return lambda page: pages[page - 1] if page <= len(pages) else "", "text-layer"

    def _version_location(self,source,version,path,location):
        if source["type"]=="textbook" and not self._uses_textbook_ocr(source,version,path):
            if isinstance(location,dict) and location.get("bookPage") is not None:
                raise StoreError("invalid_parameter", "此版本尚未核对书页与PDF页码的对应，请使用PDF页码")
            return self._pdf_location({**source,"type":"supplementary"},version,location)
        return self._pdf_location(source,version,location)

    def resolve(self, source_id, version_id, location):
        source, version, path = self._source(source_id, version_id)
        if source["type"] == "course-note":
            if isinstance(location, dict) and location.get("section") == "全文":
                try:
                    text = path.read_text(encoding="utf-8-sig")
                except (OSError, UnicodeError) as exc:
                    raise StoreError("source_unavailable", "无法读取这份文本资料") from exc
                return {**self._base(source, version, {"section": "全文"}, None),
                        "text": text, "textStatus": "markdown"}
            return super().resolve(source_id, version_id, location)
        resolved_location, count = self._version_location(source, version, path, location)
        read_page, status = self._pdf_reader(source, version, path)
        text = read_page(resolved_location["pdfPage"])
        return {**self._base(source, version, resolved_location, count),
                "text": text, "textStatus": status if text.strip() else "unavailable"}

    def text_pages(self, source_id, version_id):
        source, version, path = self._source(source_id, version_id)
        if source["type"] == "course-note":
            if version["path"].startswith(".review-board/materials/"):
                result = self.resolve(source_id, version_id, {"section": "全文"})
                return [{"location": result["location"], "text": result["text"], "textStatus": result["textStatus"]}]
            return super().text_pages(source_id, version_id)
        read_page, status = self._pdf_reader(source, version, path)
        result = []
        for page in range(1, version.get("totalPages", source["totalPages"]) + 1):
            text = read_page(page)
            location, _ = self._version_location(source, version, path, {"pdfPage": page})
            result.append({"location": location, "text": text,
                           "textStatus": status if text.strip() else "unavailable"})
        return result
