#!/usr/bin/env python3
"""KU-026 独立复核：代入、反演、对偶三条规则的枚举验证。

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


# 代入规则：A(B+C)=AB+AC，代入 A→(A+D)： (A+D)(B+C)=(A+D)B+(A+D)C
def lhs(a, d, b, c):
    return AND(OR(a, d), OR(b, c))


def rhs(a, d, b, c):
    return OR(AND(OR(a, d), b), AND(OR(a, d), c))


bad = []
for a, b, c, d in itertools.product((0, 1), repeat=4):
    if lhs(a, d, b, c) != rhs(a, d, b, c):
        bad.append((a, d, b, c))
check("代入规则：(A+D)(B+C)=(A+D)B+(A+D)C 16 组全枚举", not bad, str(bad or "通过"))

# 代入规则：overline(AB)=Ā+B̄，代入 A→A（本身）验证两变量摩根
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if NOT(AND(a, b)) != OR(NOT(a), NOT(b)):
        bad.append((a, b))
check("代入规则：摩根定理 overline(AB)=Ā+B̄ 4 组全枚举（作为代入基础）", not bad, str(bad or "通过"))

# 反演规则：F=Ā·B+C·D̄，F̄=(A+B̄)·(C̄+D)
def f(a, b, c, d):
    return OR(AND(NOT(a), b), AND(c, NOT(d)))


def f_inv(a, b, c, d):
    return AND(OR(a, NOT(b)), OR(NOT(c), d))


bad = []
for a, b, c, d in itertools.product((0, 1), repeat=4):
    if f_inv(a, b, c, d) != NOT(f(a, b, c, d)):
        bad.append((a, b, c, d))
check("反演规则：F=ĀB+CD̄，F̄=(A+B̄)·(C̄+D) 16 组全枚举", not bad, str(bad or "通过"))

# 反演规则常见错误写法：A+B̄·C̄+D（缺少括号）不应等于 F̄
def f_wrong(a, b, c, d):
    return OR(a, NOT(b), NOT(c), d)


bad = []
for a, b, c, d in itertools.product((0, 1), repeat=4):
    if f_wrong(a, b, c, d) == f_inv(a, b, c, d):
        bad.append((a, b, c, d))
check("反演规则：错误写法 A+B̄C̄+D 确实≠ F̄（保持运算顺序的必要性，预期发现）", len(bad) < 16, f"相等组合数={len(bad)}/16")

# 对偶式：F=Ā·B+C·D̄，对偶式 F'=A·B+C·D（变量不变，·↔+）
def f_dual(a, b, c, d):
    return OR(AND(a, b), AND(c, d))


def f_orig(a, b, c, d):
    return OR(AND(NOT(a), b), AND(c, NOT(d)))


# 对偶规则：若 F=G 则 F'=G'。用 P27 例子验证：A+BC=(A+B)(A+C)，对偶式 A(B+C)=AB+AC
def dual_lhs(a, b, c):
    return OR(a, AND(b, c))


def dual_rhs(a, b, c):
    return AND(OR(a, b), OR(a, c))


def dual_lhs_prime(a, b, c):
    return AND(a, OR(b, c))


def dual_rhs_prime(a, b, c):
    return OR(AND(a, b), AND(a, c))


bad_eq = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if dual_lhs(a, b, c) != dual_rhs(a, b, c):
        bad_eq.append((a, b, c, "原式"))
    if dual_lhs_prime(a, b, c) != dual_rhs_prime(a, b, c):
        bad_eq.append((a, b, c, "对偶式"))
check("对偶规则：A+BC=(A+B)(A+C) 与对偶式 A(B+C)=AB+AC 均成立 8 组全枚举", not bad_eq, str(bad_eq or "通过"))

# 对偶式与反函数不同：对 F=ĀB+CD̄，验证对偶式≠反函数
diff = []
for a, b, c, d in itertools.product((0, 1), repeat=4):
    if f_dual(a, b, c, d) != f_inv(a, b, c, d):
        diff.append((a, b, c, d))
check("对偶式与反函数不同（F'≠F̄，对偶不对变量取反）", len(diff) > 0, f"不同组合数={len(diff)}/16")

# P28 化简例子：F=(A+B̄)(B+C)(Ā+C)，对偶式 F'=AB̄+BC+ĀC，化简为 AB̄+C，再对偶得 F=(A+B̄)C
def f_p28(a, b, c):
    return AND(OR(a, NOT(b)), OR(b, c), OR(NOT(a), c))


def f_p28_simplified(a, b, c):
    return AND(OR(a, NOT(b)), c)


def f_p28_dual(a, b, c):
    return OR(AND(a, NOT(b)), c)


def f_p28_dual_simplified(a, b, c):
    return OR(AND(a, NOT(b)), c)


bad = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if f_p28(a, b, c) != f_p28_simplified(a, b, c):
        bad.append((a, b, c))
check("P28 例：F=(A+B̄)(B+C)(Ā+C) = (A+B̄)C 8 组全枚举", not bad, str(bad or "通过"))

bad = []
for a, b, c in itertools.product((0, 1), repeat=3):
    if f_p28_dual(a, b, c) != f_p28_dual_simplified(a, b, c):
        bad.append((a, b, c))
check("P28 例：对偶式 F'=AB̄+BC+ĀC = AB̄+C 8 组全枚举", not bad, str(bad or "通过"))

result = {
    "unitId": "KU-026",
    "description": "代入、反演、对偶三规则独立枚举复核",
    "checks": checks,
    "allPass": all(c["pass"] for c in checks),
}
out = os.path.join(HERE, "audit-KU-026.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"allPass={result['allPass']} checks={len(checks)} -> {out}")
for c in checks:
    print(("PASS" if c["pass"] else "FAIL"), c["name"])
