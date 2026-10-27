#!/usr/bin/env python3
"""Run this local visual prototype. Ctrl-C stops the server."""
import argparse
import functools
import http.server
import pathlib
import threading
import webbrowser

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=0, help="Port to use; default picks an available port")
parser.add_argument("--no-browser", action="store_true")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
url = f"http://127.0.0.1:{server.server_port}/style-math-prototype/"
print(f"打开局部样例：{url}", flush=True)
if not args.no_browser:
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
