#!/usr/bin/env python3
"""TH-02 有符号数与补码运算：独立计算复核。

期望值全部来自独立定义，不从正文抄写：
- 补码用「位权定义」与「模 2^n 同余类定义」两套独立定义互检；
- 原码/反码按各自的独立定义建表；
- 溢出用「真值和是否越界」这个原始定义作基准，再与
  符号判据（同号相加得异号）、进位判据（进符号位 ⊕ 出符号位）全枚举对拍；
- 加法进位链用一位全加器公式逐位模拟。
"""
import json
from fractions import Fraction
from pathlib import Path

RESULTS = []


def check(name, passed, details=""):
    RESULTS.append({"name": name, "passed": bool(passed), "details": details})


def twos(bits, n):
    """补码位权定义：MSB 权为 -2^(n-1)。"""
    return -int(bits[0]) * (1 << (n - 1)) + int(bits[1:], 2)


def twos_mod(bits, n):
    """补码模定义：无符号值在模 2^n 中取 [-2^(n-1), 2^(n-1)-1] 的代表。"""
    u = int(bits, 2)
    return u - (1 << n) if u >= (1 << (n - 1)) else u


def sign_mag(bits, n):
    """原码定义：符号位 + 绝对值。"""
    return -int(bits[1:], 2) if bits[0] == "1" else int(bits[1:], 2)


def ones_comp(bits, n):
    """反码定义：负数 = -(2^n - 1 - 无符号值)。"""
    u = int(bits, 2)
    return u if bits[0] == "0" else -((1 << n) - 1 - u)


def bits_of(value, n):
    """整数值 -> n 位补码编码（要求值在可表示范围内）。"""
    lo, hi = -(1 << (n - 1)), (1 << (n - 1)) - 1
    assert lo <= value <= hi, (value, n)
    return format(value & ((1 << n) - 1), f"0{n}b")


def ripple_carry(a, b):
    """4 位全加器逐位模拟：a、b 为 4 位串，返回 (sum4, c1..c4)。
    si = ai^bi^ci, ci+1 = ai*bi + ci*(ai^bi)，c0 = 0。
    """
    c = 0
    carries = []
    digits = []
    for i in reversed(range(4)):
        ai, bi = int(a[i]), int(b[i])
        s = ai ^ bi ^ c
        c_next = (ai & bi) | (c & (ai ^ bi))
        digits.append(str(s))
        carries.append(c_next)
        c = c_next
    return "".join(reversed(digits)), carries  # carries[0..3] = c1..c4


# ---------- 1. 4 位补码全表：两套独立定义互检 ----------
table_ok, table_rows = True, []
for u in range(16):
    b = format(u, "04b")
    va, vb = twos(b, 4), twos_mod(b, 4)
    table_rows.append((b, va))
    if va != vb:
        table_ok = False
check("4位补码：位权定义与模定义全表一致", table_ok,
      f"16 码字全部一致；1000->-8, 0111->+7")

# ---------- 2. (N)补 = 2^n - N 与 (N)补 = (N)反 + 1 ----------
# 恒等式 (N)补 = 2^n - N 只在 -N 可表示时适用：4 位补码范围 [-8, +7]，故 N 限 1..8
neg_ok = True
for n_val in range(1, 9):
    enc = format((1 << 4) - n_val, "04b")  # (N)补 = 2^n - N 的 4 位编码
    if twos(enc, 4) != -n_val:          # 读回应为 -N
        neg_ok = False
check("(N)补=2^n-N：N=1..8（可表示范围）全部成立", neg_ok)

# 口诀「(N)补 = (N)反 + 1」中 (N)反 是正数 N 的反码（N>0 时反码=原码=补码编码）
def flip(b):
    return "".join("1" if ch == "0" else "0" for ch in b)

comp_ok = all(
    format((int(flip(format(N, "04b")), 2) + 1) % 16, "04b") == bits_of(-N, 4)
    for N in range(1, 9))
check("负数区 (N)补=(N)反+1：N=1..8 位型全部成立（N=8 为 0111+1=1000 边界特例）",
      comp_ok,
      "例：0111 反码 1000 -> 补码 1001（对应 C01 P26 例）")

# ---------- 3. 4 位原码/反码表边界 ----------
sm_vals = {sign_mag(format(u, "04b"), 4) for u in range(16)}
check("4位原码：范围 -7..+7，含 +0/-0，无 -8",
      min(sm_vals) == -7 and max(sm_vals) == 7 and sm_vals == set(range(-7, 8)),
      "1000 原码读作 -0=0；1010 原码 = -2（Q-017 用）")
check("1010 补码 = -6（Q-014 用）", twos("1010", 4) == -6)
check("01110000 8位补码 = +112（Q-015 用）", twos("01110000", 8) == 112)
check("01110000 8位原码 = +112（Q-018 用）", sign_mag("01110000", 8) == 112)

# ---------- 4. 零扩展 / 符号扩展全枚举 ----------
sign_ok, zero_ok = True, True
examples = {}
for u in range(16):
    b4 = format(u, "04b")
    v4 = twos(b4, 4)
    ext_sign = b4 if b4[0] == "0" else "1111" + b4      # 符号扩展
    ext_zero = "0000" + b4                              # 零扩展
    if twos(ext_sign, 8) != v4:
        sign_ok = False
    if b4[0] == "0":
        if twos(ext_zero, 8) != v4:
            zero_ok = False
    else:  # 负数零扩展必须改变值
        if twos(ext_zero, 8) == v4:
            zero_ok = False
        examples[b4] = (v4, twos(ext_zero, 8), twos(ext_sign, 8))
check("符号扩展：16 码字值全部不变", sign_ok)
check("零扩展：正数不变、负数值全部改变", zero_ok,
      "例 1010: 原 -6, 零扩展 +10, 符号扩展 -6")
check("Q-020: 0101 -> 00000101（值 +5）",
      bits_of(5, 8) == "00000101" and twos("00000101", 8) == twos("0101", 4) == 5)
check("Q-021: 1010 -> 11111010（值 -6）",
      twos("11111010", 8) == twos("1010", 4) == -6)

# ---------- 5. 溢出：256 组三判据全枚举对拍 ----------
all_eq, unsign_ok, diff_sign_never = True, True, True
for ua in range(16):
    for ub in range(16):
        a, b = format(ua, "04b"), format(ub, "04b")
        s4, carries = ripple_carry(a, b)
        c3, c4 = carries[2], carries[3]  # 进符号位 / 出符号位
        sa, sb, ss = twos(a, 4), twos(b, 4), twos(s4, 4)
        v_range = not (-8 <= sa + sb <= 7)          # 原始定义：真值和越界
        v_sign = (a[0] == b[0]) and (s4[0] != a[0])  # 同号相加得异号
        v_carry = c3 ^ c4
        if not (v_range == v_sign == bool(v_carry) == (ss != sa + sb)):
            all_eq = False
        if bool(c4) != (ua + ub >= 16):              # 无符号溢出 = Cout
            unsign_ok = False
        if a[0] != b[0] and v_carry:                 # 异号相加不应溢出
            diff_sign_never = False
check("溢出：真值和越界 ≡ 同号异号判据 ≡ c3⊕c4 ≡ 截断改变真值（256 组）", all_eq)
check("无符号溢出：Cout=1 ⟺ 无符号和≥16（256 组）", unsign_ok)
check("异号相加永不溢出（128 组）", diff_sign_never)

# 课件/教材指定用例的进位与结论
def add_case(a, b, n):
    s, carries = ripple_carry(a, b)
    return {"sum": s, "value": twos(s, n), "c_in_sign": carries[n - 2],
            "c_out": carries[n - 1], "overflow": carries[n - 2] ^ carries[n - 1]}

q27 = add_case("1001", "0100", 4)
q28 = add_case("1101", "1011", 4)
check("Q-027: 1001+0100=1101(-3)，c3=0,c4=0，不溢出",
      q27 == {"sum": "1101", "value": -3, "c_in_sign": 0, "c_out": 0, "overflow": 0}
      and twos("1001", 4) + twos("0100", 4) == -3)
check("Q-028: 1101+1011=1000(-8)，c3=1,c4=1，边界值不是溢出",
      q28 == {"sum": "1000", "value": -8, "c_in_sign": 1, "c_out": 1, "overflow": 0}
      and twos("1101", 4) + twos("1011", 4) == -8)
p42 = add_case("0101", "0110", 4)
check("C01 P42: 5+6=11>7 越界，0101+0110=1011(-5)，c3=1,c4=0，溢出；无符号和 11≤15 不溢出",
      p42["overflow"] == 1 and p42["value"] == -5 and 5 + 6 > 7 and 5 + 6 <= 15)

# C06 P22 的 8 位四例（期望进位对来自独立计算，与原页核对）
def add8(a, b):
    ca = format(a, "08b")
    cb = format(b, "08b")
    c = 0
    carries = []
    for i in reversed(range(8)):
        ai, bi = int(ca[i]), int(cb[i])
        carries.append((ai & bi) | (c & (ai ^ bi)))
        c = carries[-1]
    return carries[6], carries[7]  # c7(进符号位), c8(出符号位)

four = {(70, 80): (1, 0, True), (-70, -80): (0, 1, True),
        (30, 40): (0, 0, False), (-30, -40): (1, 1, False)}
four_ok = True
for (x, y), (cin, cout, ovf_expected) in four.items():
    ax = x & 0xFF
    bx = y & 0xFF
    c_in_sign, c_out = add8(ax, bx)
    true_sum = x + y
    ovf = not (-128 <= true_sum <= 127)
    if (c_in_sign, c_out) != (cin, cout) or ovf != ovf_expected or (c_in_sign ^ c_out) != ovf:
        four_ok = False
check("C06 P22 四例：进位对 (0,1)(1,0)(0,0)(1,1) 与溢出结论全部一致（8 位）", four_ok)
check("+70+80=+150>127 溢出；-70-80=-150<-128 溢出；+30+40=+70、-30-40=-70 不溢出",
      not (-128 <= 150 <= 127) and not (-128 <= -150 <= 127)
      and -128 <= 70 <= 127 and -128 <= -70 <= 127)

# ---------- 6. 5 位减法转加法（课件 P43/P44/P45 用例） ----------
def sub_via_add(a_val, b_val, n=5):
    """[a-b]补 = [a]补 + [-b]补，按 n 位加、丢弃最高进位。"""
    a_enc = bits_of(a_val, n)
    neg_b = (-b_val) & ((1 << n) - 1)  # [-b]补 的模定义编码
    total = int(a_enc, 2) + neg_b
    dropped = total >> n               # 被丢弃的最高进位
    return format(total & ((1 << n) - 1), f"0{n}b"), dropped

sub_cases = {
    "P45: 12-7=5": (12, 7, "00101", 1),
    "P43: 10-3=7": (10, 3, "00111", 1),
    "P44: 3-10=-7": (3, 10, "11001", 0),
    "P25: 12-9=3（4位示例对照组）": None,
}
s, d = sub_via_add(12, 7)
check("P45: 01100+11001=100101 丢 c5 -> 00101=+5", s == "00101" and d == 1 and twos(s, 5) == 5)
s, d = sub_via_add(10, 3)
check("P43: 01010+11101=100111 丢 c5 -> 00111=+7", s == "00111" and d == 1 and twos(s, 5) == 7)
s, d = sub_via_add(3, 10)
check("P44: 00011+10110=11001（不产生最高进位）-> 11001=-7，原码 10111=-0111",
      s == "11001" and d == 0 and twos(s, 5) == -7 and sign_mag("10111", 5) == -7)
check("P43: 10+3=13 -> 01010+00011=01101",
      twos("01010", 5) + twos("00011", 5) == 13 and twos("01101", 5) == 13)

# 全枚举：5 位减转加对 a,b ∈ 0..15 全部正确（丢进位后模 2^5 读回真值）
enum_ok = True
for aa in range(16):
    for bb in range(16):
        res, dropped = sub_via_add(aa, bb)
        if twos(res, 5) != aa - bb:
            enum_ok = False
check("5 位减转加：a-b 对 a,b∈0..15 全枚举 256 组读回正确", enum_ok)

# ---------- 7. 模 12 时钟与模 16 ----------
check("模12: 9-7 ≡ 9+5 (mod 12) = 14 ≡ 2；7 对 12 的补数是 5",
      (9 - 7) % 12 == (9 + 5) % 12 == 2 and (12 - 7) % 12 == 5)
check("模16: 7 的补码是 9；7-5 ≡ 7+11 ≡ 18 ≡ 2 (mod 16)",
      (16 - 7) % 16 == 9 and (7 - 5) % 16 == (7 + 11) % 16 == 2)

# ---------- 8. 小数补码例（C01 P39，比例因子 2^-4） ----------
x = Fraction(int("1101", 2), 16)          # +0.1101 = 13/16
y = Fraction(int("0110", 2), 16)          # +0.0110 = 6/16
neg_y = (Fraction(2) - y)                 # [-y]补 = 2 - 6/16 = 26/16 = 1.1010
total = x + neg_y                         # 39/16 = 2 + 7/16，丢符号位进位（整数 2）
result = total - 2
check("P39 小数例: 0.1101+1.1010=10.0111 丢整数位 -> 0.0111=7/16=13/16-6/16",
      neg_y == Fraction(26, 16) and result == Fraction(7, 16) == x - y
      and Fraction(int("0111", 2), 16) == Fraction(7, 16))

# ---------- 9. C01 P35 指定码字 ----------
check("P35: -1010 的 5 位编码 原11010/反10101/补10110",
      format(10 | 0b10000, "05b") == "11010"
      and format((~10) & 0b11111, "05b") == "10101"
      and bits_of(-10, 5) == "10110"
      and twos("10110", 5) == -10 and sign_mag("11010", 5) == -10
      and ones_comp("10101", 5) == -10)

# ---------- 汇总 ----------
summary = {
    "topic": "TH-02 有符号数与补码运算 独立复核",
    "totalChecks": len(RESULTS),
    "passed": sum(1 for r in RESULTS if r["passed"]),
    "failed": sum(1 for r in RESULTS if not r["passed"]),
    "allPassed": all(r["passed"] for r in RESULTS),
    "checks": RESULTS,
    "referenceCases": {"Q-027": q27, "Q-028": q28, "C01-P42": p42,
                       "negativeZeroExtension": examples},
}
out = Path(__file__).with_name("verification.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({k: summary[k] for k in ("totalChecks", "passed", "failed", "allPassed")},
                 ensure_ascii=False))
for r in RESULTS:
    print(("PASS" if r["passed"] else "FAIL"), r["name"])
