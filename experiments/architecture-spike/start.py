"""Serve the isolated probe and explicitly allowed course presentation assets."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
APP = PROJECT / 'legacy/review-board'
COURSE = PROJECT / 'courses/digital-logic'
VENDOR = HERE.parent / 'style-math-prototype' / 'vendor'

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        routes = {'/vendor/': VENDOR, '/web/content/': APP / 'web/content',
                  '/course-assets/': COURSE / '期中/资源'}
        for prefix, base in routes.items():
            if path.startswith(prefix):
                relative = path[len(prefix):]
                break
        else:
            base, relative = HERE, path.lstrip('/') or 'index.html'
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

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8772)
args = parser.parse_args()
print(f'Architecture probe: http://127.0.0.1:{args.port}/ (isolated fixture, no course writes)', flush=True)
ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
