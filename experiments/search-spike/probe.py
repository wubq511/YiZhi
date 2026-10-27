#!/usr/bin/env python3
"""Compare SQLite tokenizers against the existing substring search semantics.

Reads an exported, public course fixture. All databases are temporary. This is
an isolated recall experiment, not a backend migration or an API benchmark.
"""
from __future__ import annotations

import hashlib
import json
import platform
from pathlib import Path
import sqlite3
import tempfile
from datetime import datetime, timezone


HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "architecture-spike/fixture.json"
QUERIES = ["门", "码", "进位", "补码", "与门", "异或", "最小项", "卡诺图",
           "无关项", "二进制", "74LS138", "74HC138", "MUX", "A+B", "A⊕B",
           "KU-055", "不存在的查询词XYZ"]


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def records(unit, instance):
    # Keep the exported metadata and each body block independently locatable.
    yield f"{instance}:unit", " ".join(strings({k: v for k, v in unit.items() if k != "reading"}))

    def walk(block):
        yield f'{instance}:block:{block["id"]}', " ".join(strings(block.get("payload", {})))
        for child in block.get("children", []):
            yield from walk(child)

    for block in unit.get("reading", {}).get("blocks", []):
        yield from walk(block)


def run(fixture, count, temporary):
    documents = []
    for i in range(count):
        documents.extend(records(fixture["units"][i % len(fixture["units"])], i))
    normalized = {i: text.casefold() for i, (_, text) in enumerate(documents, 1)}
    db = sqlite3.connect(temporary / f"search-{count}.sqlite3")
    try:
        db.execute("CREATE TABLE source(id INTEGER PRIMARY KEY, identity TEXT, body TEXT)")
        db.executemany("INSERT INTO source VALUES (?, ?, ?)",
                       [(i, identity, normalized[i]) for i, (identity, _) in enumerate(documents, 1)])
        for tokenizer in ("unicode61", "trigram"):
            db.execute(f"CREATE VIRTUAL TABLE {tokenizer} USING fts5(body, content='source', content_rowid='id', tokenize='{tokenizer}')")
            db.execute(f"INSERT INTO {tokenizer}({tokenizer}) VALUES('rebuild')")
        db.commit()

        checks = []
        for query in QUERIES:
            folded = query.casefold()
            baseline = {i for i, text in normalized.items() if folded in text}
            phrase = '"' + folded.replace('"', '""') + '"'
            results = {}
            for tokenizer in ("unicode61", "trigram"):
                ids = {row[0] for row in db.execute(f"SELECT rowid FROM {tokenizer} WHERE {tokenizer} MATCH ?", (phrase,))}
                results[tokenizer] = {"hits": len(ids), "missing": len(baseline - ids), "extra": len(ids - baseline)}
                if tokenizer == "trigram":
                    tri_ids = ids
            combined = ({row[0] for row in db.execute("SELECT id FROM source WHERE instr(body, ?) > 0", (folded,))}
                        if len(folded) < 3 else tri_ids)
            checks.append({"query": query, "substringHits": len(baseline), **results,
                           "trigramWithShortQueryFallback": {"hits": len(combined), "matchesBaseline": combined == baseline}})

        before = {q: [row[0] for row in db.execute("SELECT rowid FROM trigram WHERE trigram MATCH ? ORDER BY rowid",
                                                  ('"' + q.casefold().replace('"', '""') + '"',))] for q in QUERIES}
        db.execute("DROP TABLE trigram")
        db.execute("CREATE VIRTUAL TABLE trigram USING fts5(body, content='source', content_rowid='id', tokenize='trigram')")
        db.execute("INSERT INTO trigram(trigram) VALUES('rebuild')")
        after = {q: [row[0] for row in db.execute("SELECT rowid FROM trigram WHERE trigram MATCH ? ORDER BY rowid",
                                                 ('"' + q.casefold().replace('"', '""') + '"',))] for q in QUERIES}
        summary = {
            "units": count, "documents": len(documents),
            "unicode61QueriesDifferentFromSubstring": sum(bool(c["unicode61"]["missing"] or c["unicode61"]["extra"]) for c in checks),
            "trigramQueriesDifferentFromSubstring": sum(bool(c["trigram"]["missing"] or c["trigram"]["extra"]) for c in checks),
            "trigramWithShortQueryFallbackMatchesAll": all(c["trigramWithShortQueryFallback"]["matchesBaseline"] for c in checks),
            "derivedIndexRebuildMatches": before == after,
        }
        return {"summary": summary, "queries": checks}
    finally:
        db.close()


def main():
    raw = FIXTURE.read_bytes()
    fixture = json.loads(raw)
    result = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "environment": {"python": platform.python_version(), "sqlite": sqlite3.sqlite_version,
                        "platform": platform.platform()},
        "fixtureSHA256": hashlib.sha256(raw).hexdigest(),
        "courseSourceHash": fixture["sourceHash"],
        "scriptSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "boundaries": [
            "84 real exported units; 500 repeats those units with independent experiment identities.",
            "Only exported unit metadata and body payloads; no personal notes, conversation history, or source-PDF corpus.",
            "Substring equivalence for 17 specified literal queries, not semantic relevance or general Chinese tokenization quality.",
            "No save latency, durability, concurrency, live-index consistency, or application integration claim.",
        ],
    }
    with tempfile.TemporaryDirectory(prefix="review-search-spike-") as directory:
        result["scenarios"] = [run(fixture, count, Path(directory)) for count in (84, 500)]
    result["passed"] = all(s["summary"]["trigramWithShortQueryFallbackMatchesAll"] and
                           s["summary"]["derivedIndexRebuildMatches"] for s in result["scenarios"])
    (HERE / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "scenarios": [s["summary"] for s in result["scenarios"]]}, ensure_ascii=False))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
