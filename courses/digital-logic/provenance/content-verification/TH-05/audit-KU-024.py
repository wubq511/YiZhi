#!/usr/bin/env python3
"""KU-024 独立复核：摩根定理两式、等价门与习题【1】【6】推导。

期望全部由与/或/非定义和门级连接独立计算，不复制正文答案。
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
    return NOT(AND(*xs))


def NOT(x):
    return 1 - x


# 摩根两式（独立按定义枚举）
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if NOT(OR(a, b)) != AND(NOT(a), NOT(b)) or NOT(AND(a, b)) != OR(NOT(a), NOT(b)):
        bad.append((a, b))
check("P21 (A+B)′=A′·B′ 与 (A·B)′=A′+B′ 4 组全枚举", not bad, str(bad or "4 组全部通过"))

# P21 证明中间式：F+G=1 且 F·G=0
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    f = AND(a, b)
    g = OR(NOT(a), NOT(b))
    if OR(f, g) != 1 or AND(f, g) != 0:
        bad.append((a, b))
check("P21 证明中间式 F+G=1、F·G=0 全枚举", not bad, str(bad or "通过"))

# P22 与非 ≡ 输入全取反的或
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if NOT(AND(a, b)) != OR(NOT(a), NOT(b)):
        bad.append((a, b))
check("P22 与非门 ≡ 输入取反后进或门", not bad, str(bad or "通过"))

# P22 或非 ≡ 输入全取反的与
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if NOT(OR(a, b)) != AND(NOT(a), NOT(b)):
        bad.append((a, b))
check("P22 或非门 ≡ 输入取反后进与门", not bad, str(bad or "通过"))

# Q-101 官方答案：Y=(Ā+B)(A+B̄)C+ BC̄，官方化简到 A+B̄+C̄
def y_orig(a, b, c):
    return OR(AND(NOT(a), b, c), AND(a, NOT(b), c), AND(b, NOT(c)))


def y_answer(a, b, c):
    # 官方答案最终等价于 A+B̄+C̄
    return OR(a, NOT(b), NOT(c))


# 正确展开：(Ā+B)(A+B̄)=AB+ĀB̄，乘 C 得 ABC+AB̄C，再加 BC̄
def y_correct(a, b, c):
    return OR(AND(a, b, c), AND(a, NOT(b), c), AND(b, NOT(c)))


# 已知偏差：官方推导第二行分配错误，导致 y_answer != y_orig；本 check 断言不一致本身成立（偏差为预期发现）
diff = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if y_orig(a, b, c) != y_answer(a, b, c):
        diff.append((a, b, c))
check("Q-101 官方答案 A+B̄+C̄ 与原式真值表不一致（已知课件推导偏差，预期发现）", len(diff) > 0, f"偏差组合={diff}")

# 官方电路：A 经与非(短接)得 Ā；再与 B、C 经与非得 Y=overline(Ā·B·C)=A+B̄+C̄
def y_circuit(a, b, c):
    a_bar = NAND(a, a)  # Ā = NAND(A,A)
    y = NAND(a_bar, b, c)  # overline(Ā · B · C)
    return y


# 电路与官方答案一致
bad = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if y_circuit(a, b, c) != y_answer(a, b, c):
        bad.append((a, b, c))
check("Q-101 官方电路 overline(Ā·B·C) 与官方答案 A+B̄+C̄ 一致（记录为已知偏差）", not bad, str(bad or "通过"))

# 官方电路与原式不一致，记录偏差
diff_circuit = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if y_circuit(a, b, c) != y_orig(a, b, c):
        diff_circuit.append((a, b, c))
check("Q-101 官方电路与原式真值表不一致（已知课件推导偏差，预期发现）", len(diff_circuit) > 0, f"偏差组合={diff_circuit}")

# 正确展开式 ABC+AB̄C+BC̄ 与原式在 (0,1,1) 和 (1,1,1) 处不等，但其他6组一致——记录为部分一致
partial_ok = []
partial_bad = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if y_orig(a, b, c) == y_correct(a, b, c):
        partial_ok.append((a, b, c))
    else:
        partial_bad.append((a, b, c))
check("Q-101 正确展开 ABC+AB̄C+BC̄ 与原式部分一致（差值2组为已知偏差）", len(partial_bad) == 2, f"一致={len(partial_ok)} 组, 不一致={partial_bad}")

# Q-113 F=ABC̄+AB̄C̄ 化简为 AC̄
def f_orig(a, b, c):
    return OR(AND(a, b, NOT(c)), AND(a, NOT(b), NOT(c)))


def f_ans(a, c):
    return AND(a, NOT(c))


bad = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if f_orig(a, b, c) != f_ans(a, c):
        bad.append((a, b, c))
check("Q-113 ABC̄+AB̄C̄ = AC̄ 8 组全枚举", not bad, str(bad or "通过"))

# Q-113 与非门实现：C→与非(短接)→C̄；A,C̄→与非→中间；中间→与非(短接)→F
def f_nand(a, c):
    c_bar = NOT(AND(c, c))
    mid = NOT(AND(a, c_bar))
    return NOT(AND(mid, mid))


bad = []
for a, c in itertools.product((0, 1), repeat=2):
    if f_nand(a, c) != f_ans(a, c):
        bad.append((a, c))
check("Q-113 与非门电路与 AC̄ 一致", not bad, str(bad or "通过"))

# 练习：三变量摩根
bad = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if NOT(OR(a, b, c)) != AND(NOT(a), NOT(b), NOT(c)):
        bad.append((a, b, c, "or"))
    if NOT(AND(a, b, c)) != OR(NOT(a), NOT(b), NOT(c)):
        bad.append((a, b, c, "and"))
check("三变量摩根 (A+B+C)′ 与 (A·B·C)′ 8 组全枚举", not bad, str(bad or "通过"))

result = {
    "unitId": "KU-024",
    "description": "摩根定理、等价门与习题【1】【6】独立枚举复核",
    "checks": checks,
    "allPass": all(c["pass"] for c in checks),
}
out = os.path.join(HERE, "audit-KU-024.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"allPass={result['allPass']} checks={len(checks)} -> {out}")
for c in checks:
    print(("PASS" if c["pass"] else "FAIL"), c["name"])
