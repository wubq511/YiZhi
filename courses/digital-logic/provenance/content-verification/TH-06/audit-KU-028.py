#!/usr/bin/env python3
"""KU-028 独立复核：最小项/最大项性质与 Q-102 官方推导。

期望全部由与/或/非定义独立计算，不复制正文答案。
"""
import itertools
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
checks = []


def check(name, ok, detail=""):
    checks.append({"name": name, "pass": bool(ok), "detail": detail})


def AND(*xs):
    out = 1
    for x in xs:
        out &= x
    return out


def OR(*xs):
    out = 0
    for x in xs:
        out |= x
    return out


def NAND(*xs):
    out = 1
    for x in xs:
        out &= x
    return 1 - out


def NOT(x):
    return 1 - x


def minterm(i, n=3):
    """最小项 mi：n 变量与项，仅在二进制 i 时为 1。"""
    def fn(*xs):
        return 1 if tuple(xs) == tuple(map(int, bin(i)[2:].zfill(n))) else 0
    return fn


def maxterm(i, n=3):
    """最大项 Mi：n 变量或项，仅在二进制 i 时为 0。"""
    def fn(*xs):
        return 0 if tuple(xs) == tuple(map(int, bin(i)[2:].zfill(n))) else 1
    return fn


# 性质①：任意取值下，必有且仅有一个最小项为 1，一个最大项为 0
bad = []
for xs in itertools.product((0, 1), repeat=3):
    ones = sum(minterm(i)(*xs) for i in range(8))
    zeros = sum(1 for i in range(8) if maxterm(i)(*xs) == 0)
    if ones != 1 or zeros != 1:
        bad.append((xs, ones, zeros))
check("性质①：每组取值恰有 1 个最小项=1、1 个最大项=0（8 组）", not bad, str(bad or "通过"))

# 性质②：不同最小项之积为 0；不同最大项之和为 1（这里用逻辑与/或，即 OR/MAX，而不是算术和）
bad = []
for i, j in itertools.combinations(range(8), 2):
    for xs in itertools.product((0, 1), repeat=3):
        if minterm(i)(*xs) * minterm(j)(*xs) != 0:
            bad.append(("m", i, j, xs))
        if OR(maxterm(i)(*xs), maxterm(j)(*xs)) != 1:
            bad.append(("M", i, j, xs))
check("性质②：mi·mj=0 与 Mi+Mj=1（28 对×8 组，逻辑或）", not bad, str(bad or "通过"))

# 性质③：全体最小项之和=1；全体最大项之积=0
bad = []
for xs in itertools.product((0, 1), repeat=3):
    if sum(minterm(i)(*xs) for i in range(8)) != 1:
        bad.append(("Σm", xs))
    prod = 1
    for i in range(8):
        prod &= maxterm(i)(*xs)
    if prod != 0:
        bad.append(("ΠM", xs))
check("性质③：Σmi=1 与 ΠMi=0（8 组）", not bad, str(bad or "通过"))

# 性质④：mi = overline(Mi)
bad = []
for i in range(8):
    for xs in itertools.product((0, 1), repeat=3):
        if minterm(i)(*xs) != NOT(maxterm(i)(*xs)):
            bad.append((i, xs))
check("性质④：mi = overline(Mi)（8 项×8 组）", not bad, str(bad or "通过"))

# Q-102 官方推导：Y=(A+B)(Ā+B̄+C̄)，官方得 Σm(2,3,4,5,6)=ΠM(0,1,7)
def y_orig(a, b, c):
    return AND(OR(a, b), OR(NOT(a), NOT(b), NOT(c)))


official_min = {2, 3, 4, 5, 6}
official_max = {0, 1, 7}

bad_min = []
bad_max = []
for xs in itertools.product((0, 1), repeat=3):
    val = y_orig(*xs)
    idx = int(f"{xs[0]}{xs[1]}{xs[2]}", 2)
    if val == 1 and idx not in official_min:
        bad_min.append((xs, idx))
    if val == 0 and idx not in official_max:
        bad_max.append((xs, idx))
    if val == 1 and idx in official_max:
        bad_max.append(("in both", xs, idx))
    if val == 0 and idx in official_min:
        bad_min.append(("in both", xs, idx))
check("Q-102 Σm(2,3,4,5,6) 与原式真值表一致（8 组枚举）", not bad_min and not bad_max,
      f"Σm 异常={bad_min}, ΠM 异常={bad_max}")

# 官方 ΠM 三个最大项展开与原式等价
def y_pim(a, b, c):
    return AND(OR(a, b, c), OR(a, b, NOT(c)), OR(NOT(a), NOT(b), NOT(c)))


bad = []
for xs in itertools.product((0, 1), repeat=3):
    if y_pim(*xs) != y_orig(*xs):
        bad.append(xs)
check("Q-102 ΠM(0,1,7) 展开式与原式等价（8 组枚举）", not bad, str(bad or "通过"))

# 补集关系：official_min | official_max == {0..7}
check("Q-102 Σm 与 ΠM 下标集合互补", official_min | official_max == set(range(8)),
      f"并集={sorted(official_min | official_max)}")

result = {
    "unitId": "KU-028",
    "description": "最小项/最大项性质与 Q-102 独立枚举复核",
    "checks": checks,
    "allPass": all(c["pass"] for c in checks),
}
out = os.path.join(HERE, "audit-KU-028.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"allPass={result['allPass']} checks={len(checks)} -> {out}")
for c in checks:
    print(("PASS" if c["pass"] else "FAIL"), c["name"])
