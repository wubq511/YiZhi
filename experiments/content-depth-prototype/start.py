#!/usr/bin/env python3
"""Serve the reading prototype and its local font dependencies."""
import argparse
import functools
import http.server
import pathlib
import threading
import webbrowser

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=0)
parser.add_argument("--no-browser", action="store_true")
args = parser.parse_args()
here = pathlib.Path(__file__).resolve().parent
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(here.parent))
server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
url = f"http://127.0.0.1:{server.server_port}/content-depth-prototype/"
print(f"阅读原型：{url}", flush=True)
if not args.no_browser:
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
