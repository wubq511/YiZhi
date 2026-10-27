#!/usr/bin/env python3
"""KU-029 独立复核：真值表与标准式互转、Q-102/Q-103/Q-115。

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


def NOT(x):
    return 1 - x


def minterm(i, n=3):
    bits = tuple(map(int, bin(i)[2:].zfill(n)))

    def fn(*xs):
        return 1 if tuple(xs) == bits else 0
    return fn


def maxterm(i, n=3):
    bits = tuple(map(int, bin(i)[2:].zfill(n)))

    def fn(*xs):
        return 0 if tuple(xs) == bits else 1
    return fn


# Q-103：恰有两个输入为高 → Σm(3,5,6)
def x_q103(a, b, c):
    return 1 if (a + b + c) == 2 else 0


official_min_103 = {3, 5, 6}
bad = []
for xs in itertools.product((0, 1), repeat=3):
    val = x_q103(*xs)
    idx = int(f"{xs[0]}{xs[1]}{xs[2]}", 2)
    if val == 1 and idx not in official_min_103:
        bad.append((xs, idx))
    if val == 0 and idx in official_min_103:
        bad.append(("in set", xs, idx))
check("Q-103 恰有两个高 → Σm(3,5,6) 与真值表一致（8 组枚举）", not bad, str(bad or "通过"))

# Q-102：Y=(A+B)(Ā+B̄+C̄) → Σm(2,3,4,5,6)=ΠM(0,1,7)
def y_q102(a, b, c):
    return AND(OR(a, b), OR(NOT(a), NOT(b), NOT(c)))


official_min_102 = {2, 3, 4, 5, 6}
official_max_102 = {0, 1, 7}
bad_min = []
bad_max = []
for xs in itertools.product((0, 1), repeat=3):
    val = y_q102(*xs)
    idx = int(f"{xs[0]}{xs[1]}{xs[2]}", 2)
    if val == 1 and idx not in official_min_102:
        bad_min.append((xs, idx))
    if val == 0 and idx not in official_max_102:
        bad_max.append((xs, idx))
check("Q-102 Σm(2,3,4,5,6)=ΠM(0,1,7) 与原式真值表一致", not bad_min and not bad_max,
      f"Σm 异常={bad_min}, ΠM 异常={bad_max}")

# Q-115：F1=AB+ĀB̄ = overline(A⊕B)
def f1(a, b):
    return OR(AND(a, b), AND(NOT(a), NOT(b)))


def f1_xor(a, b):
    return NOT(a ^ b)


bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if f1(a, b) != f1_xor(a, b):
        bad.append((a, b))
check("Q-115 F1=AB+ĀB̄ = overline(A⊕B) 4 组枚举", not bad, str(bad or "通过"))

# P38 方法1：Y=ABC̄+BC → Σm(3,6,7)
def y_p38(a, b, c):
    return OR(AND(a, b, NOT(c)), AND(b, c))


official_38 = {3, 6, 7}
bad = []
for xs in itertools.product((0, 1), repeat=3):
    val = y_p38(*xs)
    idx = int(f"{xs[0]}{xs[1]}{xs[2]}", 2)
    if (val == 1 and idx not in official_38) or (val == 0 and idx in official_38):
        bad.append((xs, val, idx))
check("P38 Y=ABC̄+BC → Σm(3,6,7) 真值表一致", not bad, str(bad or "通过"))

# P39 方法2 补因子：ABC̄+(A+Ā)BC = ABC̄+ABC+ĀBC，与原式等价
def y_p39(a, b, c):
    return OR(AND(a, b, NOT(c)), AND(a, b, c), AND(NOT(a), b, c))


bad = []
for xs in itertools.product((0, 1), repeat=3):
    if y_p39(*xs) != y_p38(*xs):
        bad.append(xs)
check("P39 补因子后 ABC̄+ABC+ĀBC 与原式等价", not bad, str(bad or "通过"))

# P41 方法1：Y=ĀB+AC → ΠM(0,1,4,6)
def y_p41(a, b, c):
    return OR(AND(NOT(a), b), AND(a, c))


official_41 = {0, 1, 4, 6}
bad = []
for xs in itertools.product((0, 1), repeat=3):
    val = y_p41(*xs)
    idx = int(f"{xs[0]}{xs[1]}{xs[2]}", 2)
    if (val == 1 and idx in official_41) or (val == 0 and idx not in official_41):
        bad.append((xs, val, idx))
check("P41 Y=ĀB+AC → ΠM(0,1,4,6) 真值表一致", not bad, str(bad or "通过"))

# P42 方法2：(A+B)(Ā+C)(B+C) 与原式等价
def y_p42(a, b, c):
    return AND(OR(a, b), OR(NOT(a), c), OR(b, c))


bad = []
for xs in itertools.product((0, 1), repeat=3):
    if y_p42(*xs) != y_p41(*xs):
        bad.append(xs)
check("P42 分配律展开 (A+B)(Ā+C)(B+C) 与原式等价", not bad, str(bad or "通过"))

# P40 练习1：F=A+B̄C → Σm(1,4,5,6,7)
def f_p40(a, b, c):
    return OR(a, AND(NOT(b), c))


official_40 = {1, 4, 5, 6, 7}
bad = []
for xs in itertools.product((0, 1), repeat=3):
    val = f_p40(*xs)
    idx = int(f"{xs[0]}{xs[1]}{xs[2]}", 2)
    if (val == 1 and idx not in official_40) or (val == 0 and idx in official_40):
        bad.append((xs, val, idx))
check("P40 F=A+B̄C → Σm(1,4,5,6,7) 真值表一致", not bad, str(bad or "通过"))

result = {
    "unitId": "KU-029",
    "description": "真值表与标准式互转独立枚举复核",
    "checks": checks,
    "allPass": all(c["pass"] for c in checks),
}
out = os.path.join(HERE, "audit-KU-029.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"allPass={result['allPass']} checks={len(checks)} -> {out}")
for c in checks:
    print(("PASS" if c["pass"] else "FAIL"), c["name"])
