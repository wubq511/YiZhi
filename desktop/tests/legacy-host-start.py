"""Run the real legacy entry point with bounded, payload-free startup diagnostics."""
import faulthandler
from pathlib import Path
import runpy
import socket
import sys
import time


started = time.monotonic()
PHASES = {
    ("start.py", "acquire", "return"): "service-lock-checked",
    ("service.py", "_initialize", "call"): "course-initializing",
    ("service.py", "_initialize", "return"): "course-init-returned",
    ("http.py", "__init__", "call"): "http-binding",
    ("socketserver.py", "serve_forever", "call"): "serving",
}


def stage(name):
    print(f"[legacy-host-start] {time.monotonic() - started:.3f}s {name}",
          file=sys.stderr, flush=True)


def profile(frame, event, _arg):
    code = frame.f_code
    point = (code.co_filename.rsplit("/", 1)[-1], code.co_name, event)
    if point in PHASES:
        stage(PHASES[point])
    if PHASES.get(point) == "serving":
        faulthandler.cancel_dump_traceback_later()
        sys.setprofile(None)


def reject_reverse_lookup(_host):
    raise AssertionError("Loopback course startup must not require reverse name lookup")


# An unavailable name service must not prevent this local-only host from opening.
# Only the external resolver is controlled; entry point, service, HTTP and locks are real.
socket.getfqdn = reject_reverse_lookup
entry = Path(__file__).resolve().parents[2] / "legacy/review-board/start.py"
sys.path.insert(0, str(entry.parent))
sys.argv[0] = str(entry)
stage("entry")
faulthandler.dump_traceback_later(4)
sys.setprofile(profile)
try:
    runpy.run_path(str(entry), run_name="__main__")
finally:
    faulthandler.cancel_dump_traceback_later()
    sys.setprofile(None)
