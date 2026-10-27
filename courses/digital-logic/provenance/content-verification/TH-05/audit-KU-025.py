#!/usr/bin/env python3
"""KU-025 独立复核：气泡搬运规则与课件 P24 两级与非链等价枚举。

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
    out = 1
    for x in xs:
        out &= x
    return 1 - out


def NOT(x):
    return 1 - x


# P23 Backward：与非 ≡ 输入全取反的或
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if NAND(a, b) != OR(NOT(a), NOT(b)):
        bad.append((a, b))
check("P23 Backward：与非 ≡ 输入取反后进或门", not bad, str(bad or "通过"))

# P23 Backward：或非 ≡ 输入全取反的与
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if NOT(OR(a, b)) != AND(NOT(a), NOT(b)):
        bad.append((a, b))
check("P23 Backward：或非 ≡ 输入取反后进与门", not bad, str(bad or "通过"))

# P23 Forward：输入全取反进或门 ≡ 与非
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if OR(NOT(a), NOT(b)) != NAND(a, b):
        bad.append((a, b))
check("P23 Forward：输入取反后进或门 ≡ 与非", not bad, str(bad or "通过"))

# P23 Forward：输入全取反进与门 ≡ 或非
bad = []
for a, b in itertools.product((0, 1), repeat=2):
    if AND(NOT(a), NOT(b)) != NOT(OR(a, b)):
        bad.append((a, b))
check("P23 Forward：输入取反后进与门 ≡ 或非", not bad, str(bad or "通过"))

# P24 原电路：Y = NAND(NAND(a,b), NAND(c,d))
def y_orig(a, b, c, d):
    return NAND(NAND(a, b), NAND(c, d))


def y_target(a, b, c, d):
    return OR(AND(a, b), AND(c, d))


bad = []
for a, b, c, d in itertools.product((0, 1), repeat=4):
    if y_orig(a, b, c, d) != y_target(a, b, c, d):
        bad.append((a, b, c, d))
check("P24 两级与非链 overline(overline(AB)·overline(CD)) = AB+CD 16 组全枚举", not bad, str(bad or "通过"))

# P24 右图（气泡消去后）：与-或实现
def y_right(a, b, c, d):
    return OR(AND(a, b), AND(c, d))


bad = []
for a, b, c, d in itertools.product((0, 1), repeat=4):
    if y_right(a, b, c, d) != y_target(a, b, c, d):
        bad.append((a, b, c, d))
check("P24 右图与-或实现与化简式一致", not bad, str(bad or "通过"))

result = {
    "unitId": "KU-025",
    "description": "推气泡法搬运规则与 P24 等价独立枚举复核",
    "checks": checks,
    "allPass": all(c["pass"] for c in checks),
}
out = os.path.join(HERE, "audit-KU-025.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"allPass={result['allPass']} checks={len(checks)} -> {out}")
for c in checks:
    print(("PASS" if c["pass"] else "FAIL"), c["name"])
