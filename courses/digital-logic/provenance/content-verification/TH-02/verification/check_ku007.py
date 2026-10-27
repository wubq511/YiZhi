#!/usr/bin/env python3
"""KU-007（原码、反码、补码表示与转换）独立复核。

期望全部来自独立定义（枚举真值→按定义式生成机器码、按读回规则反推真值），
不引用 units/KU-007.json 正文或 questionUpdates 中的任何数字。
"""
import json
from pathlib import Path

FAIL = []


def check(name, ok, detail=""):
    if not ok:
        FAIL.append(name)
    print(("PASS" if ok else "FAIL") + f"  {name}" + (f"  [{detail}]" if detail else ""))


# ── 独立定义：真值 X，n 为数值位位数，机器码共 n+1 位 ─────────────────────────
def sm(X, n):    # 原码 [X]原 = X (0<=X<2^n)；2^n - X（符号位 1 + |X|）(-2^n<X<=0)
    if 0 <= X < 2 ** n:
        return format(X, f"0{n + 1}b")
    if -2 ** n < X <= 0:
        return format(2 ** (n + 1) - X - 2 ** n, f"0{n + 1}b")  # 1 后接 |X| 的 n 位
    return None

def oc(X, n):    # 反码 [X]反 = X (0<=X<2^n)；2^(n+1)-1+X (-2^n<X<=0)
    if 0 <= X < 2 ** n:
        return format(X, f"0{n + 1}b")
    if -2 ** n < X <= 0:
        return format(2 ** (n + 1) - 1 + X, f"0{n + 1}b")
    return None

def tc(X, n):    # 补码 [X]补 = X (0<=X<2^n)；2^(n+1)+X (-2^n<=X<0)
    if 0 <= X < 2 ** n:
        return format(X, f"0{n + 1}b")
    if -2 ** n <= X < 0:
        return format(2 ** (n + 1) + X, f"0{n + 1}b")
    return None


# ── 1. 正数 0..7（n=3）三码一致 ──────────────────────────────────────────────
agree = all(sm(X, 3) == oc(X, 3) == tc(X, 3) == format(X, "04b") for X in range(8))
check("1 正数 0..7 三码一致且等于自身 4 位二进制", agree)

# ── 2. P40 码表 4 位全表按定义式生成并比对 ────────────────────────────────────
table_p40 = {
    "+0": ("0000", "0000", "0000"),
    "-0": ("1000", "1111", None),   # -0：补码不存在
    -1: ("1001", "1110", "1111"),
    -2: ("1010", "1101", "1110"),
    -3: ("1011", "1100", "1101"),
    -4: ("1100", "1011", "1100"),
    -5: ("1101", "1010", "1011"),
    -6: ("1110", "1001", "1010"),
    -7: ("1111", "1000", "1001"),
    -8: (None,   None,   "1000"),  # 仅补码
}
ok = True
detail = []
for key, (s, o, t) in table_p40.items():
    if key == "+0":
        calc = (sm(0, 3), oc(0, 3), tc(0, 3))           # 正零直接代入定义式
    elif key == "-0":
        calc = ("1" + format(0, "03b"),                  # 负零：符号位 1 + 数值位 |−0|=0000
                format(2 ** 4 - 1, "04b"),               # 2^(n+1)−1+(−0) = 全 1
                None)                                    # 2^(n+1)+(−0)≡+0，补码不设负零
    elif key == -8:
        calc = (sm(-8, 3), oc(-8, 3), tc(-8, 3))         # 越界项：前两式应返回 None
    else:
        calc = (sm(key, 3), oc(key, 3), tc(key, 3))
    if calc != (s, o, t):
        ok = False; detail.append(f"{key}: {calc} != {(s, o, t)}")
check("2 P40 码表（含 −0 与 −8 仅补码）与定义式全等", ok, "; ".join(detail))

# ── 3. 例题 −1101（n=4 数值位，5 位码）定义式与取反+1 两路一致 ────────────────
X = -0b1101  # -13
s, o, t = sm(X, 4), oc(X, 4), tc(X, 4)
check("3a −1101 原码 = 1 1101", s == "11101", s)
check("3b −1101 反码 = 1 0010", o == "10010", o)
check("3c −1101 补码 = 1 0011", t == "10011", t)
check("3d 取反+1 与定义式一致", format(int(t, 2) - int(o, 2), "05b") == "00001")
check("3e 补码读回 2^5−19 = 13（数值部分）", 2 ** 5 + X == int(t, 2))

# ── 4. 练习 −20 的 8 位三码 ──────────────────────────────────────────────────
s20, o20, t20 = sm(-20, 7), oc(-20, 7), tc(-20, 7)
check("4a −20 八位原码 = 1001 0100", s20 == "10010100", s20)
check("4b −20 八位反码 = 1110 1011", o20 == "11101011", o20)
check("4c −20 八位补码 = 1110 1100", t20 == "11101100", t20)
check("4d 补码=反码+1", int(t20, 2) == int(o20, 2) + 1)

# ── 5. 四道 direct 题读值（按读回规则独立计算）──────────────────────────────
# Q-014: 1010 按 4 位补码 → 符号位 1，码值 10−16
q14 = int("1010", 2) - 2 ** 4
check("5a Q-014 1010 补码读值 = −6", q14 == -6, str(q14))
# 交叉验证：补码读回 = −(数值位取反加 1)
check("5a' 补码读回两路一致", -(int(format((~int("1010", 2)) & 0b111, "03b"), 2) + 1) == q14)
# Q-015: 01110000 按 8 位补码，符号位 0 → 正数
q15 = int("01110000", 2)
check("5b Q-015 01110000 补码读值 = +112", q15 == 112, str(q15))
# Q-017: 1010 按 4 位原码 → −|010|
q17 = -int("010", 2)
check("5c Q-017 1010 原码读值 = −2", q17 == -2, str(q17))
check("5c' 同一码型补码 −6 与原码 −2 不同", q14 != q17)
# Q-018: 01110000 按 8 位原码，正数
q18 = int("1110000", 2)
check("5d Q-018 01110000 原码读值 = +112", q18 == 112, str(q18))

# ── 6. 负数反码=数值位逐位取反（n=3 全枚举交叉验证）──────────────────────────
ok = True
for X in range(-7, 0):
    if format(~int(format(-X, "03b"), 2) & 0b111, "03b") != oc(X, 3)[1:]:
        ok = False
check("6 负数反码数值位 = |X| 数值位逐位取反（−1..−7 全枚举）", ok)

# ── 7. 表示范围断言 ─────────────────────────────────────────────────────────
check("7a n=4 时原码/反码范围 ±(2^4−1)=±15，补码 [−16, +15]",
      all((sm(X, 4) is not None) == (-15 <= X <= 15) for X in range(-20, 21))
      and all((oc(X, 4) is not None) == (-15 <= X <= 15) for X in range(-20, 21))
      and all((tc(X, 4) is not None) == (-16 <= X <= 15) for X in range(-20, 21)))
check("7b −16 补码 = 10000", tc(-16, 4) == "10000", str(tc(-16, 4)))
check("7c −16 无原码/反码", sm(-16, 4) is None and oc(-16, 4) is None)
check("7d 零的补码唯一：+0 三码同为 0000",
      (sm(0, 3), oc(0, 3), tc(0, 3)) == ("0000", "0000", "0000"))

# ── 8. 补码减 1 回反码（n=3 负数全枚举）─────────────────────────────────────
ok = all(format(int(tc(X, 3), 2) - 1, "04b") == oc(X, 3) for X in range(-7, 0))
check("8 负数补码−1 = 反码（−1..−7 全枚举）", ok)

# ── 输出 ────────────────────────────────────────────────────────────────────
result = {
    "unit": "KU-007",
    "script": "verification/check_ku007.py",
    "checks": 8,
    "failed": FAIL,
    "status": "PASS" if not FAIL else "FAIL",
}
out = Path(__file__).resolve().parent / "verification-ku007.json"
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"\n=> {out}  status={result['status']}  failed={FAIL}")
