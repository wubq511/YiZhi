#!/usr/bin/env python3
"""Start (or reopen) one local CourseService for the selected course folder."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import sys
import threading
import urllib.request
import uuid
import webbrowser

from reviewboard.http import CourseHTTPServer
from reviewboard.paths import APP_ROOT, DEFAULT_COURSE_ROOT
from reviewboard.service import CourseService
from reviewboard.storage import StoreError


class CourseLock:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = path.open("a+b")

    def acquire(self):
        try:
            if sys.platform == "win32":
                import msvcrt
                self.handle.seek(0)
                if not self.handle.read(1):
                    self.handle.write(b"0")
                    self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def close(self):
        self.handle.close()


def existing_url(runtime_path):
    try:
        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
        url = runtime["url"]
        if not url.startswith("http://127.0.0.1:"):
            return None
        with urllib.request.urlopen(url + "api/v1/health", timeout=2) as response:
            health = json.load(response)
        if (health.get("instanceId") == runtime["instanceId"]
                and health.get("courseId") == runtime["courseId"]):
            return url
    except (OSError, ValueError, KeyError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description="启动本地复习画板")
    parser.add_argument("--course", type=Path, default=DEFAULT_COURSE_ROOT,
                        help="包含知识数据及资料的课程文件夹")
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    root = args.course.resolve()
    if not root.is_dir():
        parser.error("课程文件夹不存在")
    if not 0 <= args.port <= 65535:
        parser.error("端口应在 0–65535 之间")
    app_root = APP_ROOT
    runtime_path = root / ".review-board/runtime.json"
    lock = CourseLock(root / ".review-board/service.lock")
    if not lock.acquire():
        url = existing_url(runtime_path)
        lock.close()
        if not url:
            print("课程服务正在启动或已有实例占用，请稍后重试。", file=sys.stderr)
            return 1
        print(f"课程已经打开：{url}", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        return 0
    service = server = None
    instance_id = str(uuid.uuid4())
    try:
        service = CourseService(root)
        server = CourseHTTPServer(("127.0.0.1", args.port), service, app_root, instance_id)
        url = f"http://127.0.0.1:{server.server_port}/"
        runtime_path.write_text(json.dumps({"url": url, "instanceId": instance_id,
                                           "courseId": service.manifest["courseId"]}),
                                encoding="utf-8")
        print(f"本地复习画板：{url}", flush=True)
        print(f"课程文件夹：{root}", flush=True)
        print("笔记、复习状态和阅读位置自动保存。终端按 Ctrl-C 停止服务。", flush=True)
        if not args.no_browser:
            threading.Timer(.15, lambda: webbrowser.open(url)).start()

        def stop(_signum, _frame):
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        try:
            server.serve_forever(poll_interval=.2)
        except KeyboardInterrupt:
            pass
        return 0
    except (OSError, StoreError, ValueError) as exc:
        if isinstance(exc, OSError) and getattr(exc, "errno", None) in (48, 98, 10048):
            print(f"端口 {args.port} 已被其他程序占用，可用 --port 0 自动选择端口。", file=sys.stderr)
        else:
            print(f"无法启动课程：{exc}", file=sys.stderr)
        return 1
    finally:
        if server:
            server.server_close()
        if service:
            try:
                service.close()
            except StoreError as exc:
                print(f"关闭时保存未确认，请保留课程文件夹并重新打开：{exc}", file=sys.stderr)
        try:
            runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
            if runtime.get("instanceId") == instance_id:
                runtime_path.unlink()
        except (OSError, ValueError):
            pass
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
