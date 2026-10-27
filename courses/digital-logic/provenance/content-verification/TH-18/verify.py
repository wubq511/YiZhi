#!/usr/bin/env python3
import json
from pathlib import Path


def bcd(number):
    register = number
    trace = []
    for shift in range(1, 9):
        register <<= 1
        corrected = []
        if 3 <= shift <= 7:
            for index, position in enumerate((16, 12, 8)):
                if (register >> position) & 0xF >= 5:
                    register += 3 << position
                    corrected.append(index)
        trace.append({"shift": shift, "groups": [(register >> 16) & 0xF,
                      (register >> 12) & 0xF, (register >> 8) & 0xF],
                      "corrected": corrected})
    return [(register >> 16) & 0xF, (register >> 12) & 0xF, (register >> 8) & 0xF], trace


def four_bit(number):
    register = number
    for _ in range(4):
        register <<= 1
    for position in (8, 4):
        if (register >> position) & 0xF >= 10:
            register += 6 << position
    return [(register >> 8) & 0xF, (register >> 4) & 0xF]


def check(number, expected):
    groups, trace = bcd(number)
    assert groups == expected, (number, groups, expected)
    return trace


trace255 = check(255, [2, 5, 5])
trace128 = check(128, [1, 2, 8])
for number in range(256):
    check(number, [number // 100, (number // 10) % 10, number % 10])
for number in range(16):
    assert four_bit(number) == [number // 10, number % 10]
report = {"allPassed": True, "all8BitInputsChecked": 256, "all4BitInputsChecked": 16,
          "trace255": trace255, "trace128": trace128,
          "note": "每轮先移位；第3–7轮后检查各 BCD 列 >=5 加3；第8轮后停止修正。4位变体在第4次移位后 >=10 加6。"}
Path(__file__).with_name("verification.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"allPassed": True, "all8BitInputsChecked": 256,
                  "all4BitInputsChecked": 16, "trace255": trace255,
                  "trace128": trace128}, ensure_ascii=False))
