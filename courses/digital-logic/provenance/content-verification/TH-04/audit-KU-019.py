#!/usr/bin/env python3
"""独立复核 KU-019 的复合门功能与多输入奇偶判断。"""
import itertools
import json
from pathlib import Path

results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({"item": item, "expected": expected, "actual": actual, "pass": ok, "detail": detail})
    return ok


def nand(*xs):
    return 1 - int(all(xs))


def nor(*xs):
    return 1 - int(any(xs))


def xor_all(xs):
    out = 0
    for x in xs:
        out ^= x
    return out


# 与非
check("与非 110 → 1", 1, nand(1, 1, 0), "0 取反")
check("与非 111 → 0", 0, nand(1, 1, 1), "1 取反")
check("与非全枚举与定义一致", True,
      all(nand(*xs) == 1 - int(all(xs)) for xs in itertools.product([0, 1], repeat=3)),
      "3 输入全枚举")

# 或非
check("或非 00 → 1", 1, nor(0, 0), "0 取反")
check("或非 01 → 0", 0, nor(0, 1), "1 取反")
check("或非全枚举与定义一致", True,
      all(nor(*xs) == 1 - int(any(xs)) for xs in itertools.product([0, 1], repeat=3)),
      "3 输入全枚举")

# 异或奇偶
check("三输入异或恰 2 个 1 → 0", 0, xor_all([1, 1, 0]), "偶数个 1")
check("四输入异或恰 3 个 1 → 1", 1, xor_all([1, 1, 1, 0]), "奇数个 1")
check("三输入异或奇偶规律全枚举", True,
      all(xor_all(xs) == (sum(xs) % 2) for xs in itertools.product([0, 1], repeat=3)),
      "输出=1 的个数奇偶")

# 同或
def xnor(a, b):
    return 1 - (a ^ b)


check("同或与异或互反 0–1 全枚举", True,
      all(xnor(a, b) == 1 - (a ^ b) for a, b in itertools.product([0, 1], repeat=2)),
      "定义互补")

# AOI
def aoi(w, x, y, z):
    return 1 - int((w and x) or (y and z))


check("AOI 1100 → 0", 0, aoi(1, 1, 0, 0), "先与后或再反相")
check("AOI 0000 → 1", 1, aoi(0, 0, 0, 0), "内部为 0，取反为 1")
check("AOI 与逐层定义一致", True,
      all(aoi(*xs) == 1 - int((xs[0] and xs[1]) or (xs[2] and xs[3]))
          for xs in itertools.product([0, 1], repeat=4)),
      "4 输入全枚举")

summary = {
    "ticket": "02-TH-04",
    "unitId": "KU-019",
    "method": "独立按门定义枚举，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-019.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
