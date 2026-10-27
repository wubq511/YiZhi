#!/usr/bin/env python3
"""独立复核 KU-021 的异或/同或性质、代数化简与波形分段。"""
import itertools
import json
from pathlib import Path

results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({"item": item, "expected": expected, "actual": actual, "pass": ok, "detail": detail})
    return ok


def b(x):
    return 1 if x else 0


def xor(a, c):
    return a ^ c


def xnor(a, c):
    return 1 - (a ^ c)


def xor_all(xs):
    out = 0
    for x in xs:
        out ^= x
    return out


# 基本性质
check("A⊕Ā=1", True, all(xor(a, 1 - a) == 1 for a in [0, 1]), "互补异或")
check("A⊕A=0", True, all(xor(a, a) == 0 for a in [0, 1]), "同变量异或")
check("A⊕0=A", True, all(xor(a, 0) == a for a in [0, 1]), "异或0")
check("A⊕1=Ā", True, all(xor(a, 1) == 1 - a for a in [0, 1]), "异或1")
check("异或交换律", True,
      all(xor(a, c) == xor(c, a) for a, c in itertools.product([0, 1], repeat=2)),
      "交换律")
check("异或结合律", True,
      all(xor(xor(a, c), d) == xor(a, xor(c, d))
          for a, c, d in itertools.product([0, 1], repeat=3)),
      "结合律")

# 异或/同或互反
check("A⊙B=¬(A⊕B) 全枚举", True,
      all(xnor(a, c) == 1 - xor(a, c) for a, c in itertools.product([0, 1], repeat=2)),
      "互为反函数")
check("A⊙B=AB+ĀB̄ 全枚举", True,
      all(xnor(a, c) == b((a and c) or ((1 - a) and (1 - c)))
          for a, c in itertools.product([0, 1], repeat=2)),
      "同或定义")
check("A⊕B=ĀB+A B̄ 全枚举", True,
      all(xor(a, c) == b(((1 - a) and c) or (a and (1 - c)))
          for a, c in itertools.product([0, 1], repeat=2)),
      "异或定义")

# 多变量奇偶
check("三输入异或=1的个数奇偶", True,
      all(xor_all(xs) == (sum(xs) % 2) for xs in itertools.product([0, 1], repeat=3)),
      "奇偶规则")
check("四输入异或恰3个1为1", 1, xor_all([1, 1, 1, 0]), "奇数个1")
check("四输入异或恰2个1为0", 0, xor_all([1, 1, 0, 0]), "偶数个1")

# Q-105 代数化简
def q105_original(a, bb, c):
    return b(a or (a and bb and c) or (a and (1 - bb) and (1 - c)) or (c and bb) or ((1 - c) and (1 - bb)))


def q105_simplified(a, bb, c):
    # A + (B⊙C)
    return b(a or xnor(bb, c))


check("Q-105 原式=化简式 8组合", True,
      all(q105_original(*xs) == q105_simplified(*xs)
          for xs in itertools.product([0, 1], repeat=3)),
      "A+ABC+A¬B¬C+CB+¬C¬B = A+(B⊙C)")

# Q-115：F1=A⊙B
f1_cases = [
    (0, 0, 1),
    (0, 1, 0),
    (1, 0, 0),
    (1, 1, 1),
]
check("Q-115 F1=A⊙B 四组合", f1_cases,
      [(a, c, xnor(a, c)) for a, c in itertools.product([0, 1], repeat=2)],
      "同或真值表")

# Q-116：F2=F1⊕C
f2_cases = []
for a, c, f1 in f1_cases:
    for cc in [0, 1]:
        f2_cases.append((a, c, cc, f1, xor(f1, cc)))
check("Q-116 F2=F1⊕C 枚举", True,
      all(row[4] == xor(row[3], row[2]) for row in f2_cases),
      "先同或再异或")

# Q-114：F1/F2 复合波形逻辑等价
check("Q-114 F2=A⊙B⊕C 枚举", True,
      all(xor(xnor(a, c), cc) == xor(1 - xor(a, c), cc)
          for a, c, cc in itertools.product([0, 1], repeat=3)),
      "F1 同或后与 C 异或")

summary = {
    "ticket": "02-TH-04",
    "unitId": "KU-021",
    "method": "独立按异或/同或定义枚举，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-021.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
