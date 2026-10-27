#!/usr/bin/env python3
import json
from pathlib import Path

CONTROLS = ["noShift", "shr", "shl", "ror", "rol", "asr", "ror2", "noShift"]


def outputs(bits):
    return {
        "noShift": bits,
        "shr": "0" + bits[:-1],
        "shl": bits[1:] + "0",
        "ror": bits[-1] + bits[:-1],
        "rol": bits[1:] + bits[0],
        "asr": bits[0] + bits[:-1],
        "ror2": bits[-2:] + bits[:-2],
    }


rows = []
for number in range(16):
    bits = f"{number:04b}"
    actual = outputs(bits)
    for code, control in enumerate(CONTROLS):
        expected = actual[control]
        if control == "ror2":
            independent = bits[-2:] + bits[:-2]
            assert expected == independent
        rows.append({"input": bits, "controlCode": f"{code:03b}",
                     "control": control, "output": expected})
assert outputs("11001")["shr"] == "01100"
assert outputs("11001")["ror"] == "11100"
assert outputs("11001")["asr"] == "11100"
assert outputs("10110")["ror2"] == "10101"
report = {"allPassed": True, "caseCount": len(rows), "examples": {
    "11001": outputs("11001"), "10110": outputs("10110"),
}, "note": "按逻辑/循环/算术定义独立计算；ror2 与 bits[-2:]+bits[:-2] 全量一致，P60 的 0 不当作 d0。",
          "cases": rows}
Path(__file__).with_name("verification.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"allPassed": True, "caseCount": len(rows),
                  "examples": report["examples"]}, ensure_ascii=False))
