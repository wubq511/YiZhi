"""Read-only routes matching architecture-spike/start.py; OS-assigned loopback port."""
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
SAMPLE = HERE.parent / 'architecture-spike'
PROJECT = HERE.parents[1]
APP = PROJECT / 'legacy/review-board'
COURSE = PROJECT / 'courses/digital-logic'
ROUTES = {'/vendor/': HERE.parent / 'style-math-prototype/vendor',
          '/web/content/': APP / 'web/content',
          '/course-assets/': COURSE / '期中/资源'}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        for prefix, base in ROUTES.items():
            if path.startswith(prefix):
                relative = path[len(prefix):]
                break
        else:
            base, relative = SAMPLE, path.lstrip('/') or 'index.html'
        target = (base / relative).resolve()
        if not target.is_relative_to(base.resolve()) or 'node_modules' in target.parts:
            return str(HERE / 'not-found')
        return str(target)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)


class Server(ThreadingHTTPServer):
    # More headroom than the stdlib backlog of five for parallel initial asset requests.
    request_queue_size = 128


server = Server(('127.0.0.1', 0), Handler)
print(json.dumps({'port': server.server_address[1]}), flush=True)
server.serve_forever()
