#!/usr/bin/env python3
"""独立复核 KU-013 的 ASCII 与奇偶校验计算。"""
import json
from pathlib import Path

results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({"item": item, "expected": expected, "actual": actual, "pass": ok, "detail": detail})
    return ok


def ascii7(ch):
    return format(ord(ch), "07b")


def parity_bit(data7, odd=False):
    ones = data7.count("1")
    if odd:
        return "0" if ones % 2 else "1"
    return "1" if ones % 2 else "0"


check("ASCII '5' = 53 = 0110101", "0110101", ascii7("5"), "ord('5')=53")
check("ASCII 'a' = 97 = 1100001", "1100001", ascii7("a"), "ord('a')=97")
check("ASCII space = 32 = 0100000", "0100000", ascii7(" "), "ord(' ')=32")
check("ASCII 'A' = 65 = 1000001", "1000001", ascii7("A"), "ord('A')=65")
check("大小写字母码差 32", 32, ord("a") - ord("A"), "第 5 位（权 32）之差")
check("'A' 7 位码有偶数个 1", True, ascii7("A").count("1") % 2 == 0,
      "1000001 共 2 个 1，偶校验位为 0")
check("'A' 偶校验 8 位码", "01000001", parity_bit(ascii7("A")) + ascii7("A"),
      "偶校验要求总 1 数为偶")
check("'A' 奇校验 8 位码", "11000001", parity_bit(ascii7("A"), odd=True) + ascii7("A"),
      "奇校验要求总 1 数为奇")
check("'5' 偶校验 8 位码", "00110101", parity_bit(ascii7("5")) + ascii7("5"),
      "0110101 共 3 个 1，偶校验补 1")
check("'5' 奇校验 8 位码", "10110101", parity_bit(ascii7("5"), odd=True) + ascii7("5"),
      "0110101 共 3 个 1，奇校验补 0")
check("01100101 偶校验通过", True, "01100101".count("1") % 2 == 0,
      "共 4 个 1，符合偶校验")
check("数值 5 的二进制与 ASCII 不同", True, format(5, "07b") != ascii7("5"),
      "字符编号 53 与数值 5 语义不同")

summary = {
    "ticket": "02-TH-03",
    "unitId": "KU-013",
    "method": "独立使用 ord() 与奇偶计数规则计算，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-013.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
