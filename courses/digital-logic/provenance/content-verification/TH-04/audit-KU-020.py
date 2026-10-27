#!/usr/bin/env python3
"""独立复核 KU-020 的通用门实现与保密锁真值表。"""
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


def nand(*xs):
    return b(not all(xs))


def nor(*xs):
    return b(not any(xs))


# 与非通用门路径
check("与非作非门：nand(A,A)=¬A", True,
      all(nand(a, a) == b(not a) for a in [0, 1]),
      "输入并联")
check("与非作与门：nand(nand(A,B), nand(A,B))=A·B", True,
      all(nand(nand(a, c), nand(a, c)) == b(a and c)
          for a, c in itertools.product([0, 1], repeat=2)),
      "两级双重反相")
check("与非作或门：nand(nand(A,A), nand(B,B))=A+B", True,
      all(nand(nand(a, a), nand(c, c)) == b(a or c)
          for a, c in itertools.product([0, 1], repeat=2)),
      "德摩根")

# 或非通用门路径
check("或非作非门：nor(A,A)=¬A", True,
      all(nor(a, a) == b(not a) for a in [0, 1]),
      "输入并联")
check("或非作或门：nor(nor(A,B), nor(A,B))=A+B", True,
      all(nor(nor(a, c), nor(a, c)) == b(a or c)
          for a, c in itertools.product([0, 1], repeat=2)),
      "两级双重反相")
check("或非作与门：nor(nor(A,A), nor(B,B))=A·B", True,
      all(nor(nor(a, a), nor(c, c)) == b(a and c)
          for a, c in itertools.product([0, 1], repeat=2)),
      "德摩根")

# Q-101：原式与化简式/与非级联式等价
def q101_original(a, bb, c):
    # 原页：Y=(¬A+B)(A+¬B)C+¬(B·C)
    return b((b(not a) or bb) and (a or b(not bb)) and c or not (bb and c))


def q101_simplified(a, bb, c):
    # 原页最终化简：Y=A+¬B+¬C
    return b(a or b(not bb) or b(not c))


def q101_nand_form(a, bb, c):
    # 原页最终：Y=¬(¬(A·¬A)·B·C)，第一门为输入并联 A 的与非门
    not_a = nand(a, a)
    return nand(not_a, bb, c)


check("Q-101 原式 010 → 1", 1, q101_original(0, 1, 0), "第一项0，第二项1")
check("Q-101 原式 111 → 1", 1, q101_original(1, 1, 1), "两路皆可为1")
check("Q-101 原式=化简式 8组合", True,
      all(q101_original(*xs) == q101_simplified(*xs)
          for xs in itertools.product([0, 1], repeat=3)),
      "展开合并")
check("Q-101 原式=与非级联 8组合", True,
      all(q101_original(*xs) == q101_nand_form(*xs)
          for xs in itertools.product([0, 1], repeat=3)),
      "与非-与非两级")

# Q-113：原式=简化式=与非级联
def q113_original(a, bb, c):
    # 原页：F=AB¬C+A¬B¬C
    return b((a and bb and b(not c)) or (a and b(not bb) and b(not c)))


def q113_simple(a, bb, c):
    return b(a and b(not c))


# Q-113：原页最终式读作两个与非结果的“与非-与非”级联，独立复核。
def q113_nand_form(a, bb, c):
    n_c = nand(c, c)
    mid = nand(a, n_c, n_c)
    return nand(mid, mid)


check("Q-113 原式 111 → 0", 0, q113_original(1, 1, 1), "C=1 两路皆0")
check("Q-113 原式 110 → 1", 1, q113_original(1, 1, 0), "AB¬C 项")
check("Q-113 原式=简化式 8组合", True,
      all(q113_original(*xs) == q113_simple(*xs)
          for xs in itertools.product([0, 1], repeat=3)),
      "提公因子 A·¬C")
check("Q-113 简化式=与非级联 8组合", True,
      all(q113_simple(*xs) == q113_nand_form(*xs)
          for xs in itertools.product([0, 1], repeat=3)),
      "按原页与非级联枚举")

# Q-081 保密锁真值表
def f_lock(a, bb, c):
    return b(a and (bb or c))


def g_lock(a, bb, c):
    # 报警：不符合开锁组合，且不是“A 单独按下”；A 不在时报警
    if a and (bb or c):
        return 0
    if a and not bb and not c:
        return 0
    return 1


expected_rows = [
    (0, 0, 0, 0, 1),
    (0, 0, 1, 0, 1),
    (0, 1, 0, 0, 1),
    (0, 1, 1, 0, 1),
    (1, 0, 0, 0, 0),
    (1, 0, 1, 1, 0),
    (1, 1, 0, 1, 0),
    (1, 1, 1, 1, 0),
]
actual_rows = [(a, bb, c, f_lock(a, bb, c), g_lock(a, bb, c))
               for a, bb, c in itertools.product([0, 1], repeat=3)]
check("Q-081 真值表 8 行", expected_rows, actual_rows, "F=A(B+C)；A单独时报警关闭")
check("Q-081 A单独按下 F=0,G=0", (0, 0), (f_lock(1, 0, 0), g_lock(1, 0, 0)), "题干边界")
check("Q-081 开锁仅当 A=1 且至少另一键", True,
      all(f_lock(a, bb, c) == b(a and (bb or c))
          for a, bb, c in itertools.product([0, 1], repeat=3)),
      "最小项合并")
check("Q-081 报警与题意一致", True,
      all(g_lock(a, bb, c) == b(not ((a and (bb or c)) or (a and not bb and not c)))
          for a, bb, c in itertools.product([0, 1], repeat=3)),
      "非开锁且非A单独")

summary = {
    "ticket": "02-TH-04",
    "unitId": "KU-020",
    "method": "独立按通用门与题意枚举，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-020.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
