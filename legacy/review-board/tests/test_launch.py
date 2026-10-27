"""Real launcher processes, using copied course data and ephemeral ports only."""

import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.request import ProxyHandler, build_opener

from course_fixture import copy_runtime

from reviewboard.paths import APP_ROOT, DEFAULT_COURSE_ROOT

PROJECT_ROOT = DEFAULT_COURSE_ROOT
START = APP_ROOT / "start.py"
TIMEOUT = 8


class LauncherProcess:
    """Drain both pipes continuously, including when startup fails before a URL."""

    def __init__(self, course, port, *, start=START, default_course=False):
        environment = os.environ.copy()
        environment.update(PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1",
                           PYTHONWARNINGS="always::ResourceWarning",
                           NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
        self.process = subprocess.Popen(
            [sys.executable, "-u", str(start), *([] if default_course else ["--course", str(course)]),
             "--port", str(port), "--no-browser"],
            cwd=course, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8")
        self.stdout = []
        self.stderr = []
        self.lines = queue.Queue()
        self.readers = []
        for stream, collected, notify in (
            (self.process.stdout, self.stdout, True),
            (self.process.stderr, self.stderr, False),
        ):
            reader = threading.Thread(target=self._drain, args=(stream, collected, notify),
                                      daemon=True)
            reader.start()
            self.readers.append(reader)

    def _drain(self, stream, collected, notify):
        try:
            for line in stream:
                collected.append(line)
                if notify:
                    self.lines.put(line)
        finally:
            stream.close()
            if notify:
                self.lines.put(None)

    def diagnostics(self):
        return f"stdout:\n{''.join(self.stdout)}\nstderr:\n{''.join(self.stderr)}"

    def first_line(self):
        try:
            line = self.lines.get(timeout=TIMEOUT)
        except queue.Empty as exc:
            raise AssertionError(f"No startup URL within {TIMEOUT}s; {self.diagnostics()}") from exc
        if line is None:
            raise AssertionError(f"Launcher closed stdout before a URL; {self.diagnostics()}")
        return line

    def wait(self):
        try:
            result = self.process.wait(timeout=TIMEOUT)
        except subprocess.TimeoutExpired as exc:
            raise AssertionError(f"Launcher did not exit within {TIMEOUT}s; "
                                 f"{self.diagnostics()}") from exc
        for reader in self.readers:
            reader.join(timeout=1)
            if reader.is_alive():
                raise AssertionError("Launcher pipe reader did not finish")
        return result

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=2)
        finally:
            for reader in self.readers:
                reader.join(timeout=1)


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.course = Path(self.temporary.name) / "course"
        self.course.mkdir()
        shutil.copy2(PROJECT_ROOT / "课程.json", self.course / "课程.json")
        data = self.course / "期中/数据"
        data.mkdir(parents=True)
        for source in (PROJECT_ROOT / "期中/数据").glob("*.json"):
            shutil.copy2(source, data / source.name)
        # Copy every tool source, including new local imports such as 复习内容.py.
        shutil.copytree(PROJECT_ROOT / "期中/工具", self.course / "期中/工具",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.processes = []
        self.addCleanup(self.close_processes)
        self.client = build_opener(ProxyHandler({}))

    def close_processes(self):
        for launcher in reversed(self.processes):
            launcher.close()

    def launch(self, port=0):
        launcher = LauncherProcess(self.course, port)
        self.processes.append(launcher)
        return launcher

    def startup_url(self, launcher):
        line = launcher.first_line()
        match = re.search(r"http://127\.0\.0\.1:([0-9]+)/", line)
        self.assertIsNotNone(match, f"First stdout line must contain a loopback URL: {line!r}")
        self.assertGreater(int(match.group(1)), 0)
        return match.group(0)

    def get_json(self, url, path):
        with self.client.open(url + path, timeout=TIMEOUT) as response:
            self.assertEqual(response.status, 200)
            return json.load(response)

    def stop_gracefully(self, launcher):
        launcher.process.send_signal(signal.SIGTERM)
        self.assertEqual(launcher.wait(), 0, launcher.diagnostics())
        self.assertNotIn("Traceback", launcher.diagnostics())
        self.assertNotIn("ResourceWarning", launcher.diagnostics())
        self.assertFalse((self.course / ".review-board/runtime.json").exists())

    def test_start_reuse_sigterm_and_restart_release_course_lock_and_port(self):
        first = self.launch()
        url = self.startup_url(first)
        health = self.get_json(url, "api/v1/health")
        self.assertEqual(health["status"], "running")
        manifest = json.loads((self.course / "课程.json").read_text(encoding="utf-8"))
        self.assertEqual(health["courseId"], manifest["courseId"])
        # Opening the course also exercises real knowledge loading from copied tools/data.
        course = self.get_json(url, "api/v1/course")
        self.assertGreater(course["catalog"]["counts"]["units"], 0)
        self.assertEqual(course["state"]["documents"], {})

        duplicate = self.launch()
        self.assertEqual(self.startup_url(duplicate), url)
        self.assertEqual(duplicate.wait(), 0, duplicate.diagnostics())
        self.assertNotIn("ResourceWarning", duplicate.diagnostics())
        self.assertIsNone(first.process.poll())
        self.assertEqual(self.get_json(url, "api/v1/health"), health)

        self.stop_gracefully(first)
        port = int(url.rstrip("/").rsplit(":", 1)[1])
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as released:
            released.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            released.bind(("127.0.0.1", port))

        reopened = self.launch()
        reopened_url = self.startup_url(reopened)
        reopened_health = self.get_json(reopened_url, "api/v1/health")
        self.assertEqual(reopened_health["courseId"], health["courseId"])
        self.assertNotEqual(reopened_health["instanceId"], health["instanceId"])
        self.stop_gracefully(reopened)

    def test_occupied_port_exits_with_friendly_error_and_does_not_keep_lock(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            port = occupied.getsockname()[1]
            failed = self.launch(port)
            self.assertNotEqual(failed.wait(), 0, failed.diagnostics())
            error = "".join(failed.stderr)
            self.assertIn(f"端口 {port}", error)
            self.assertIn("占用", error)
            self.assertIn("--port 0", error)
            self.assertNotIn("Traceback", error)
            self.assertNotIn("ResourceWarning", failed.diagnostics())
            self.assertFalse((self.course / ".review-board/runtime.json").exists())

            # While the conflicting port is still occupied, reopening on port 0
            # proves the failed startup released the same course's lock.
            recovered = self.launch()
            url = self.startup_url(recovered)
            self.assertEqual(self.get_json(url, "api/v1/health")["status"], "running")
            self.stop_gracefully(recovered)

    def test_migrated_default_course_and_shared_resources_from_an_unrelated_cwd(self):
        repo = Path(self.temporary.name) / "repo"
        app = copy_runtime(repo)
        default = repo / "courses/digital-logic"
        default.parent.mkdir(parents=True)
        self.course.rename(default)
        self.course = default
        launcher = LauncherProcess(default, 0, start=app / "start.py", default_course=True)
        self.processes.append(launcher)
        url = self.startup_url(launcher)
        course = self.get_json(url, "api/v1/course")
        self.assertGreater(course["catalog"]["counts"]["units"], 0)
        self.assertFalse((default / "docs").exists())
        self.assertFalse((default / "experiments").exists())
        routes = {
            "/": app / "web/index.html",
            "/web/app.js": app / "web/app.js",
            "/assets/prototype/content.js": repo / "experiments/content-depth-prototype/content.js",
            "/assets/prototype/rough-browser.js": repo / "experiments/content-depth-prototype/rough-browser.js",
            "/assets/style/vendor/mathlive/mathlive.min.js": repo / "experiments/style-math-prototype/vendor/mathlive/mathlive.min.js",
            "/assets/style/handwriting.css": repo / "experiments/style-math-prototype/handwriting.css",
        }
        fonts = repo / "experiments/mux-skill-comparison/excalidraw-runtime/fonts"
        font = next(fonts.rglob("*.woff2"))
        routes["/assets/mux-skill-comparison/excalidraw-runtime/fonts/" + font.relative_to(fonts).as_posix()] = font
        pages = repo / "experiments/content-depth-prototype/sources"
        page = next(pages.glob("*.png"))
        routes["/sources/" + page.name] = page
        assets = default / "期中/资源"
        assets.mkdir(parents=True)
        (assets / "fixture.svg").write_bytes(b"<svg/>")
        routes["/course-assets/fixture.svg"] = assets / "fixture.svg"
        for route, expected in routes.items():
            with self.subTest(route=route), self.client.open(url.rstrip("/") + route, timeout=TIMEOUT) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), expected.read_bytes())
        self.stop_gracefully(launcher)


if __name__ == "__main__":
    unittest.main()
