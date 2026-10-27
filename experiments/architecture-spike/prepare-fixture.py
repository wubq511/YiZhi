"""Read-only fixture export for the architecture experiment."""

import json
import subprocess
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
APP = PROJECT / 'legacy/review-board'
COURSE = PROJECT / 'courses/digital-logic'

graph = json.loads(subprocess.run(
    ["python3", str(PROJECT / "tools/digital-logic/知识地图.py"), "graph", "--view", "main"],
    cwd=COURSE, check=True, capture_output=True, text=True,
).stdout)
with urllib.request.urlopen("http://127.0.0.1:8769/api/v1/course", timeout=15) as response:
    view = json.load(response)["view"]
units = list(view["units"].values()) if isinstance(view["units"], dict) else view["units"]
assert {unit["id"] for unit in units} == {node["id"] for node in graph["nodes"]}
assert view["sourceHash"] == graph["sourceHash"]

kinds = Counter()
source_pages = set()

def count_blocks(blocks):
    for block in blocks:
        kinds[block["kind"]] += 1
        asset = block.get('payload', {}).get('asset', '')
        if asset.startswith('/source-pages/'):
            source_pages.add(asset)
        count_blocks(block.get("children", []))

for unit in units:
    count_blocks(unit.get("reading", {}).get("blocks", []))

def export_page(asset):
    target = (HERE / asset.lstrip('/')).resolve()
    assert target.is_relative_to(HERE / 'source-pages')
    with urllib.request.urlopen('http://127.0.0.1:8769' + asset, timeout=60) as response:
        pixels = response.read()
    assert pixels.startswith(b'\x89PNG\r\n\x1a\n'), asset
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(pixels)

with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(export_page, sorted(source_pages)))

fixture = {
    "purpose": "architecture-probe-only; replicated workloads are synthetic",
    "capturedAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
    "sourceHash": graph["sourceHash"],
    "unitCount": len(units),
    "blockKinds": dict(kinds),
    "sourcePageAssets": sorted(source_pages),
    "units": units,
    "edges": graph["edges"],
}
(HERE / "fixture.json").write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"units": len(units), "blocks": sum(kinds.values()), "kinds": dict(kinds)}, ensure_ascii=False))
