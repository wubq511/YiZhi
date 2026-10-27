from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Lock
import urllib.parse

from .storage import StoreError


class SourceLibrary:
    def __init__(self, root, catalog, cache_dir):
        self.root = Path(root).resolve()
        self.catalog = catalog
        self.cache_dir = Path(cache_dir)
        self._hashes = {}
        self._pdf_text = {}
        self._page_locks = {}
        self._page_locks_guard = Lock()

    def _inside(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise StoreError("invalid_parameter", "资料路径超出课程文件夹")
        return path

    def _version(self, source, version_id):
        for version in source.get("versions", []):
            if version["id"] == version_id:
                path = self._inside(version["path"])
                try:
                    stat = path.stat()
                except OSError as exc:
                    raise StoreError("source_unavailable", "资料版本资源缺失",
                                     {"path": version["path"]}) from exc
                cached = self._hashes.get(path)
                if cached is None or cached[:2] != (stat.st_mtime_ns, stat.st_size):
                    digest = hashlib.sha256()
                    with path.open("rb") as handle:
                        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                            digest.update(chunk)
                    cached = (stat.st_mtime_ns, stat.st_size, digest.hexdigest())
                    self._hashes[path] = cached
                if cached[2] != version["sha256"]:
                    raise StoreError("source_unavailable", "资料文件与指定版本摘要不匹配",
                                     {"sourceId": source["id"], "versionId": version_id})
                return version, path
        raise StoreError("source_unavailable", "找不到指定资料版本",
                         {"sourceId": source["id"], "versionId": version_id})

    def _source(self, source_id, version_id):
        source = self.catalog.get(source_id)
        version, path = self._version(source, version_id)
        return source, version, path

    @staticmethod
    def _pdf_location(source, version, location):
        if not isinstance(location, dict):
            raise StoreError("invalid_parameter", "来源位置必须是对象")
        count = version.get("totalPages", source["totalPages"])
        book_page = location.get("bookPage")
        pdf_page = location.get("pdfPage")
        if book_page is not None:
            if source["type"] != "textbook" or type(book_page) is not int or not 1 <= book_page <= 480:
                raise StoreError("invalid_parameter", "教材中文书页无效")
            converted = book_page + 14
            if pdf_page is not None and pdf_page != converted:
                raise StoreError("invalid_parameter", "教材中文书页与 PDF 页序不一致")
            pdf_page = converted
        if type(pdf_page) is not int or not 1 <= pdf_page <= count:
            raise StoreError("invalid_parameter", "PDF 页码越界",
                             {"pdfPage": pdf_page, "pageCount": count})
        result = {"pdfPage": pdf_page}
        if source["type"] == "textbook" and 15 <= pdf_page <= 494:
            result["bookPage"] = pdf_page - 14
        return result, count

    def _all_pdf_text(self, source, version, path):
        key = (source["id"], version["id"])
        if key not in self._pdf_text:
            result = subprocess.run(["pdftotext", "-layout", str(path), "-"],
                                    capture_output=True, timeout=60)
            if result.returncode:
                pages = []
            else:
                text = result.stdout.decode("utf-8", errors="replace")
                pages = text.split("\f")
                if pages and not pages[-1].strip():
                    pages.pop()
            self._pdf_text[key] = pages
        return self._pdf_text[key]

    def _textbook_text(self, page):
        path = self.root / f"教材/数字设计和计算机体系结构-检索版/OCR/{page:04d}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        return "\n".join(line.get("text", "") for line in data.get("lines", []))

    @staticmethod
    def _note_section(path, section):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            raise StoreError("source_unavailable", "课程笔记资源缺失") from exc
        headings = [(index, len(match.group(1)), match.group(2).strip())
                    for index, line in enumerate(lines)
                    if (match := re.match(r"^(#{1,6})\s+(.+?)\s*$", line))]
        for position, (start, level, title) in enumerate(headings):
            if title != section:
                continue
            end = len(lines)
            for next_start, next_level, _ in headings[position + 1:]:
                if next_level <= level:
                    end = next_start
                    break
            return "\n".join(lines[start:end]).strip()
        raise StoreError("invalid_parameter", "课程笔记小节不存在", {"section": section})

    def resolve(self, source_id, version_id, location):
        source, version, path = self._source(source_id, version_id)
        if source["type"] == "course-note":
            if not isinstance(location, dict) or not isinstance(location.get("section"), str):
                raise StoreError("invalid_parameter", "课程笔记需要真实小节")
            section = location["section"]
            text = self._note_section(path, section)
            resolved_location, count = {"section": section}, None
            status = "markdown"
        else:
            resolved_location, count = self._pdf_location(source, version, location)
            if source["type"] == "textbook":
                text = self._textbook_text(resolved_location["pdfPage"])
                status = "ocr" if text.strip() else "unavailable"
            else:
                pages = self._all_pdf_text(source, version, path)
                page = resolved_location["pdfPage"]
                text = pages[page - 1] if page <= len(pages) else ""
                status = "text-layer" if text.strip() else "unavailable"
        base = self._base(source, version, resolved_location, count)
        return {**base, "text": text, "textStatus": status}

    def _base(self, source, version, location, count):
        source_id, version_id = source["id"], version["id"]
        quoted_source = urllib.parse.quote(source_id, safe="")
        quoted_version = urllib.parse.quote(version_id, safe="")
        result = {
            "sourceId": source_id,
            "versionId": version_id,
            "title": source["title"],
            "type": source["type"],
            "displayName": version["displayName"],
            "location": location,
            "pageCount": count,
            "resourceUrl": f"/source-files/{quoted_source}/{quoted_version}",
        }
        if "pdfPage" in location:
            result["pageImageUrl"] = (
                f"/source-pages/{quoted_source}/{quoted_version}/{location['pdfPage']}.png"
            )
        return result

    def selection(self, source_id, version_id, location, text=None):
        resolved = self.resolve(source_id, version_id, location)
        if text is not None:
            if not isinstance(text, str) or not text or text not in resolved["text"]:
                raise StoreError("invalid_content", "选中文字不在可核对的原页文本中",
                                 {"sourceId": source_id, "versionId": version_id})
            kind = "text"
        else:
            kind = "page-region" if isinstance(location, dict) and "rect" in location else "page"
        if isinstance(location, dict) and "rect" in location:
            rect = location["rect"]
            if (not isinstance(rect, list) or len(rect) != 4
                    or any(type(value) not in (int, float) for value in rect)
                    or not 0 <= rect[0] < rect[2] <= 1 or not 0 <= rect[1] < rect[3] <= 1):
                raise StoreError("invalid_parameter", "原文选区坐标无效")
            resolved["location"] = {**resolved["location"], "rect": rect}
        resolved.pop("text", None)
        resolved.pop("textStatus", None)
        return {**resolved, "contentKind": kind, "text": text}

    def file(self, source_id, version_id):
        _, _, path = self._source(source_id, version_id)
        return path

    def page_image(self, source_id, version_id, page):
        source, version, path = self._source(source_id, version_id)
        location, _ = self._pdf_location(source, version, {"pdfPage": page})
        page = location["pdfPage"]
        target = self.cache_dir / f"{source_id}-{version_id}-{page}.png"
        with self._page_locks_guard:
            page_lock = self._page_locks.setdefault(target, Lock())
        # Recheck after acquiring the page lock: waiting callers reuse its result.
        # Hold only this page's lock during rendering so other pages can proceed.
        with page_lock:
            if target.is_file():
                return target
            try:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                # A private directory on the cache filesystem keeps partial output
                # invisible and allows an atomic rename after pdftoppm has exited.
                with tempfile.TemporaryDirectory(prefix=".page-", dir=self.cache_dir) as directory:
                    prefix = Path(directory) / "page"
                    result = subprocess.run([
                        "pdftoppm", "-f", str(page), "-l", str(page), "-singlefile",
                        "-png", "-r", "120", str(path), str(prefix),
                    ], capture_output=True, timeout=60)
                    result.check_returncode()
                    prefix.with_suffix(".png").replace(target)
            except (OSError, subprocess.SubprocessError) as exc:
                # Cleanup owns only the private directory, never a public cache
                # another library instance/process may have published meanwhile.
                raise StoreError("source_unavailable", "原页渲染失败",
                                 {"sourceId": source_id, "versionId": version_id,
                                  "pdfPage": page}) from exc
            return target

    def text_pages(self, source_id, version_id):
        source, version, path = self._source(source_id, version_id)
        if source["type"] == "course-note":
            text = path.read_text(encoding="utf-8")
            headings = list(re.finditer(r"^#{1,6}\s+(.+?)\s*$", text, re.MULTILINE))
            return [{"location": {"section": match.group(1).strip()},
                     "text": self._note_section(path, match.group(1).strip()),
                     "textStatus": "markdown"} for match in headings]
        pages = self._all_pdf_text(source, version, path)
        result = []
        for page in range(1, version.get("totalPages", source["totalPages"]) + 1):
            text = self._textbook_text(page) if source["type"] == "textbook" else (
                pages[page - 1] if page <= len(pages) else "")
            location, _ = self._pdf_location(source, version, {"pdfPage": page})
            result.append({"location": location, "text": text,
                           "textStatus": ("ocr" if source["type"] == "textbook" else "text-layer")
                           if text.strip() else "unavailable"})
        return result
