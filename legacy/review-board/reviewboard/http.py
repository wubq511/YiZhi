"""Loopback HTTP adapter for CourseService and local reading resources."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import urllib.parse

from .service import inside
from .paths import EXPERIMENTS_ROOT
from .storage import StoreError


class CourseHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # A complete course opens content, state and source images in one burst.
    request_queue_size = 128

    def __init__(self, address, service, app_root, instance_id):
        self.service = service
        self.app_root = Path(app_root)
        self.instance_id = instance_id
        super().__init__(address, CourseHandler)


class CourseHandler(BaseHTTPRequestHandler):
    server_version = "ReviewBoard/1"

    def log_message(self, *_):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, exc):
        code = getattr(exc, "code", "invalid_parameter")
        details = getattr(exc, "details", {})
        status = {"not_found": 404, "revision_conflict": 409, "save_failed": 503,
                  "executor_unavailable": 503, "source_unavailable": 404,
                  "capability_unavailable": 501}.get(code, 400)
        self._json({"error": {"code": code, "message": str(exc), "details": details}}, status)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        params = urllib.parse.parse_qs(parsed.query)
        service = self.server.service
        try:
            if path == "/api/v1/health":
                return self._json({"status": "running", "courseId": service.manifest["courseId"],
                                   "instanceId": self.server.instance_id})
            if path == "/api/v1/course":
                course = service.open_course()
                if (self.server.app_root / "web/content/provider.js").is_file():
                    course["contentProvider"] = "/web/content/provider.js"
                return self._json(course)
            if path == "/api/v1/state":
                return self._json(service.store.snapshot())
            if path == "/api/v1/events":
                return self._json(service.store.events_since(int(params.get("after", [0])[0])))
            if path == "/api/v1/agent/state":
                return self._json(service.agent.state())
            if path == "/api/v1/agent/models":
                from .codex_executor import CodexExecutor
                executor = CodexExecutor(service.root)
                try:
                    executor.connect()
                    return self._json({"models": executor.models(), "cliVersion": executor.version})
                finally:
                    executor.close()
            if path.startswith("/api/v1/content/"):
                return self._json(service.content.get(path.rsplit("/", 1)[-1]))
            if path == "/api/v1/history":
                return self._json(service.content.history())
            if path == "/api/v1/materials":
                return self._json({"sources": [{"sourceId": source["id"], "title": source["title"],
                        "type": source["type"], "versions": source.get("versions", [])}
                        for source in service.catalog.store().sources.values()]})
            if path == "/api/v1/sources/resolve":
                location = {}
                for key in ("pdfPage", "bookPage"):
                    if key in params:
                        location[key] = int(params[key][0])
                if "section" in params:
                    location["section"] = params["section"][0]
                if "rect" in params:
                    location["rect"] = json.loads(params["rect"][0])
                return self._json(service.sources.resolve(
                    params.get("sourceId", [None])[0], params.get("versionId", [None])[0], location))
            if path == "/api/v1/search":
                scopes = params.get("scopes", [None])[0]
                return self._json(service.search.search(
                    params.get("q", [""])[0], scopes=scopes.split(",") if scopes else None,
                    mode=params.get("mode", ["keyword"])[0],
                    limit=int(params.get("limit", [50])[0])))
            if path.startswith("/api/v1/entities/"): 
                return self._json(service.catalog.get(path.rsplit("/", 1)[-1]))
            if path == "/api/v1/graph":
                return self._json(service.catalog.graph(params.get("view", ["main"])[0]))
            if path.startswith("/api/v1/knowledge/"):
                return self._json(service.catalog.query(path.rsplit("/", 1)[-1], params))
            if path.startswith("/api/"):
                raise StoreError("not_found", "找不到接口")
            return self._file(path)
        except (StoreError, ValueError, KeyError, OSError) as exc:
            if not isinstance(exc, StoreError):
                exc = StoreError("invalid_parameter", str(exc))
            self._error(exc)
        except service.catalog.module.MapError as exc:
            self._error(exc)

    def do_POST(self):
        try:
            path = urllib.parse.urlsplit(self.path).path
            if path not in {"/api/v1/commands", "/api/v1/source-selections",
                            "/api/v1/agent/requests", "/api/v1/agent/conversations",
                            "/api/v1/agent/control", "/api/v1/agent/prompts",
                            "/api/v1/agent/material-updates",
                            "/api/v1/materials/import", "/api/v1/content/import",
                            "/api/v1/history/undo", "/api/v1/history/restore"}:
                raise StoreError("not_found", "找不到接口")
            origin = self.headers.get("Origin")
            if origin and origin not in {
                f"http://127.0.0.1:{self.server.server_port}",
                f"http://localhost:{self.server.server_port}",
            }:
                raise StoreError("invalid_parameter", "请从当前课程页面提交修改")
            if self.headers.get_content_type() != "application/json":
                raise StoreError("invalid_parameter", "命令需使用 JSON")
            length = int(self.headers.get("Content-Length", 0))
            maximum = 64 * 1024 * 1024 if path == "/api/v1/materials/import" else 2_000_000
            if not 0 < length <= maximum:
                raise StoreError("invalid_parameter", "命令大小无效")
            command = json.loads(self.rfile.read(length),
                                 parse_constant=lambda _: (_ for _ in ()).throw(ValueError("非法数字")))
            if not isinstance(command, dict):
                raise StoreError("invalid_parameter", "请求必须是对象")
            if path == "/api/v1/source-selections":
                if not isinstance(command, dict):
                    raise StoreError("invalid_parameter", "原文选择必须是对象")
                if any(not isinstance(command.get(key),str) for key in ("sourceId","versionId")) or not isinstance(command.get("location"),dict):
                    raise StoreError("invalid_parameter", "原文选择缺少来源版本与位置")
                result = self.server.service.sources.selection(
                    command.get("sourceId"), command.get("versionId"),
                    command.get("location"), command.get("text"))
            elif path == "/api/v1/agent/requests":
                result = self.server.service.agent.submit(command)
            elif path == "/api/v1/agent/conversations":
                agent = self.server.service.agent
                identifier = command.get("conversationId")
                result = (agent.save_conversation(identifier, command.get("patch", {}))
                          if identifier is not None else agent.conversation())
            elif path == "/api/v1/agent/control":
                result = self.server.service.agent.control(command.get("taskId"), command.get("action"), command)
            elif path == "/api/v1/agent/prompts":
                result = self.server.service.agent.resolve_mastery(command.get("promptId"), command.get("status"))
            elif path == "/api/v1/agent/material-updates":
                result = self.server.service.agent.material_decision(command.get("updateId"), command.get("action"), command.get("conversationId"))
            elif path == "/api/v1/history/undo":
                result = self.server.service.content.undo(command.get("operationId"))
            elif path == "/api/v1/materials/import":
                service = self.server.service
                if not hasattr(service, "_material_importer"):
                    from .material_import import MaterialImporter
                    service._material_importer = MaterialImporter(service)
                result = service._material_importer.add(command)
            elif path == "/api/v1/content/import":
                from .content_imports import import_content_package
                service = self.server.service
                result = import_content_package(service, command.get("packagePath"), course_id=command.get("courseId"))
                if service._agent:
                    service._agent.notify_change({**result, "actor": "import"})
            elif path == "/api/v1/history/restore":
                if not isinstance(command.get("operationId"), str):
                    raise StoreError("invalid_parameter", "历史恢复缺少操作身份")
                result = self.server.service.content.restore(command.get("sequence"), {
                    "operationId": command["operationId"], "actor": "student", "generation": command.get("generation")})
                if self.server.service._agent:
                    self.server.service._agent.invalidate_generation()
            else:
                result = self.server.service.apply_command(command)
            self._json(result)
        except (StoreError, ValueError, OSError) as exc:
            self._error(exc if isinstance(exc, StoreError) else StoreError("invalid_parameter", str(exc)))
        except self.server.service.catalog.module.MapError as exc:
            self._error(exc)

    def _file(self, path):
        course_root = self.server.service.root
        prototype = EXPERIMENTS_ROOT / "content-depth-prototype"
        style = EXPERIMENTS_ROOT / "style-math-prototype"
        if path == "/":
            file = self.server.app_root / "web/index.html"
        elif path.startswith("/web/"):
            file = inside(self.server.app_root / "web", path[5:])
        elif path.startswith("/assets/prototype/"):
            file = inside(prototype, path[len("/assets/prototype/"):])
        elif path.startswith("/assets/style/"):
            file = inside(style, path[len("/assets/style/"):])
        elif path.startswith("/assets/mux-skill-comparison/excalidraw-runtime/fonts/"):
            fonts = style.parent / "mux-skill-comparison/excalidraw-runtime/fonts"
            file = inside(fonts, path[len("/assets/mux-skill-comparison/excalidraw-runtime/fonts/"):])
        elif path.startswith("/source-pages/"):
            parts = path.split("/")
            if len(parts) != 5 or not parts[4].endswith(".png"):
                raise StoreError("invalid_parameter", "原页资源路径无效")
            file = self.server.service.sources.page_image(
                parts[2], parts[3], int(parts[4][:-4]))
        elif path.startswith("/source-files/"):
            parts = path.split("/")
            if len(parts) != 4:
                raise StoreError("invalid_parameter", "资料资源路径无效")
            file = self.server.service.sources.file(parts[2], parts[3])
        elif path.startswith("/course-assets/"):
            file = inside(course_root / "期中/资源", path[len("/course-assets/"):])
        elif path.startswith("/sources/"):
            file = inside(prototype / "sources", path[len("/sources/"):])
        else:
            raise StoreError("not_found", "找不到本地资源")
        if not file.is_file():
            raise StoreError("not_found", "本地资源缺失", {"path": path})
        body = file.read_bytes()
        mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix in {".js", ".css", ".html", ".json"}:
            mime += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
