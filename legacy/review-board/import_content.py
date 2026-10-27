#!/usr/bin/env python3
"""Import #02 packages via the running course server or a CourseLock-owned service.

From the repo root: python3 legacy/review-board/import_content.py path/to/package.json
Use --course /path/to/copied-course for temporary-course checks.

The old tools/digital-logic/复习内容.py import CLI does not use .content.lock and still races
with live edits. #02 must use this entry point for serialized formal imports.
No fallback writer is started after a live server rejects/loses an HTTP request;
retry the same package to recover the durable OP-IMPORT-<packageId> receipt.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from reviewboard.storage import StoreError
from reviewboard.paths import DEFAULT_COURSE_ROOT


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _json_file(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _existing_server(root, opener):
    try:
        manifest = _json_file(root / "课程.json")
        runtime = _json_file(root / ".review-board/runtime.json")
        url = runtime["url"]
        parsed = urlsplit(url)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
                or runtime["courseId"] != manifest["courseId"]):
            return None
        url = f"http://127.0.0.1:{parsed.port}/"
        with opener.open(url + "api/v1/health", timeout=2) as response:
            health = json.load(response)
        if (isinstance(health, dict) and health.get("status") == "running" and health.get("instanceId") == runtime["instanceId"]
                and health.get("courseId") == manifest["courseId"]):
            return url, manifest["courseId"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def _forward(opener, server, package_path):
    url, course_id = server
    request = Request(url + "api/v1/content/import", method="POST",
                      data=json.dumps({"packagePath": str(package_path), "courseId": course_id},
                                      ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json", "Origin": url.rstrip("/")})
    try:
        with opener.open(request, timeout=60) as response:
            result = json.load(response)
    except HTTPError as exc:
        try:
            with exc:
                error = json.load(exc).get("error", {})
        except (ValueError, OSError, AttributeError):
            error = {}
        raise StoreError(error.get("code", "save_failed"), error.get("message", "课程服务拒绝导入"),
                         {**error.get("details", {}), "httpStatus": exc.code}) from exc
    except (OSError, ValueError, URLError) as exc:
        raise StoreError("save_failed", "导入回执未确认；请重试同一内容包，不启动第二写入者",
                         {"reason": str(exc)}) from exc
    if not isinstance(result, dict) or result.get("saved") is not True or result.get("courseId") != course_id:
        raise StoreError("save_failed", "课程服务未返回本课程的有效保存回执")
    return result


def import_course(course_root, package_path):
    """CLI orchestration, kept import-safe for targeted temporary-course tests."""
    root = Path(course_root).expanduser().resolve()
    package_path = Path(package_path).expanduser().resolve()
    if not root.is_dir():
        raise StoreError("not_found", "课程文件夹不存在", {"path": str(root)})
    if not package_path.is_file():
        raise StoreError("not_found", "内容包文件不存在", {"path": str(package_path)})
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    server = _existing_server(root, opener)
    if server is not None:
        return _forward(opener, server, package_path)
    # Import lazily: start.py imports HTTP/service, whose host may import the
    # content_imports adapter. The adapter itself never imports this launcher.
    from start import CourseLock
    lock = CourseLock(root / ".review-board/service.lock")
    service = None
    try:
        if not lock.acquire():
            server = _existing_server(root, opener)
            if server is None:
                raise StoreError("capability_unavailable", "课程写入者正在启动或无法连接，请稍后重试")
            return _forward(opener, server, package_path)
        # Also honor a validated live runtime started outside the normal launcher.
        server = _existing_server(root, opener)
        if server is not None:
            lock.close()
            lock = None
            return _forward(opener, server, package_path)
        from reviewboard.service import CourseService
        from reviewboard.content_imports import import_content_package
        service = CourseService(root)
        return import_content_package(service, package_path)
    finally:
        try:
            if service is not None:
                service.close()
        finally:
            if lock is not None:
                lock.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="通过课程统一命令串行导入 #02 正式内容包", epilog=(
        "已有课程服务时转发 /api/v1/content/import；否则持有 CourseLock 临时导入。"
        "原生tools/digital-logic/复习内容.py import 未参与内容锁，并发导入请改用本入口。"))
    parser.add_argument("package", type=Path, help="内容包 JSON 路径，相对当前工作目录解析")
    parser.add_argument("--course", type=Path, default=DEFAULT_COURSE_ROOT,
                        help="课程根目录，默认 courses/digital-logic；验证时指定临时副本")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(import_course(args.course, args.package), ensure_ascii=False, allow_nan=False))
        return 0
    except (StoreError, OSError, ValueError) as exc:
        error = {"code": getattr(exc, "code", "save_failed"), "message": str(exc),
                 "details": getattr(exc, "details", {})}
        print(json.dumps({"error": error}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
