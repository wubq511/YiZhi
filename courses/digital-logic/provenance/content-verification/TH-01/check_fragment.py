#!/usr/bin/env python3
"""校验 TH-01 逐单元片段：把 reading 注入权威地图副本后调用 validate_reading 全图校验。
只读权威文件，不写回任何正式数据。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "期中/工具"))
from 复习内容 import validate_reading, ContentError

WORK = Path(__file__).resolve().parent

def main():
    unit_ids = sorted(p.stem for p in (WORK / "units").glob("*.json"))
    if not unit_ids:
        print("units/ 下没有片段")
        return 1
    data = json.loads((ROOT / "期中/数据/知识地图.json").read_text(encoding="utf-8"))
    for uid in unit_ids:
        frag = json.loads((WORK / "units" / f"{uid}.json").read_text(encoding="utf-8"))
        assert frag["unitId"] == uid
        for unit in data["units"]:
            if unit["id"] == uid:
                unit["reading"] = frag["reading"]
                break
        else:
            print(f"权威地图中不存在 {uid}")
            return 1
        questions_by_id = {q["id"]: q for q in data["questions"]}
        for update in frag.get("questionUpdates", []):
            qid = update["questionId"]
            if qid not in questions_by_id:
                print(f"权威地图中不存在题目 {qid}")
                return 1
            for key, value in update.items():
                if key != "questionId":
                    questions_by_id[qid][key] = value
    errors = []
    validate_reading(data, errors)
    for err in errors:
        print("ERROR:", err)
    if errors:
        return 1
    print(f"validate_reading OK: {len(unit_ids)} 个片段（{', '.join(unit_ids)}），0 errors")
    return 0

if __name__ == "__main__":
    sys.exit(main())
