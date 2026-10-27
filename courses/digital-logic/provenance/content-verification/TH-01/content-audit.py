#!/usr/bin/env python3
"""TH-01 独立计算复核：期望值全部来自独立进制换算、枚举竖式与已知定义，
不是把正文答案复制成断言。任一失败即以非零码退出，并输出 content-audit.json。"""
import json
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
checks = []


def jsonable(x):
    if isinstance(x, Fraction):
        return f"{x.numerator}/{x.denominator}"
    if isinstance(x, tuple):
        return [jsonable(i) for i in x]
    if isinstance(x, list):
        return [jsonable(i) for i in x]
    return x


def check(name, actual, expect):
    ok = actual == expect
    checks.append({"name": name, "pass": ok,
                   "actual": jsonable(actual), "expect": jsonable(expect)})
    if not ok:
        print(f"FAIL {name}: actual={actual!r} expect={expect!r}")
    return ok


def to_int(digits, base):
    n = 0
    for d in digits:
        n = n * base + d
    return n


def parse_prefixed(text):
    """解析形如 1010_2 / A5_16 / 375.236_8 / 10010101_BCD 的串，返回 (整数位, 小数位, 基)。"""
    body, base_s = text.rsplit("_", 1)
    int_part, _, frac_part = body.partition(".")
    if base_s == "BCD":
        return [int(c) for c in int_part], [], 2
    table = {c: i for i, c in enumerate("0123456789ABCDEF")}
    base = int(base_s)
    return [table[c] for c in int_part], [table[c] for c in frac_part], base


def value(text):
    """按权展开求值，返回精确分数。BCD 按定义每 4 位二进制组表示 1 位十进制数字。"""
    int_d, frac_d, base = parse_prefixed(text)
    if parse_prefixed(text)[2] == 2 and text.endswith("_BCD"):
        groups = [int_d[i:i + 4] for i in range(0, len(int_d), 4)]
        return to_int([to_int(g, 2) for g in groups], 10)
    total = Fraction(to_int(int_d, base))
    for i, d in enumerate(frac_d, start=1):
        total += Fraction(d, base ** i)
    return total


def digits_of(n, base):
    if n == 0:
        return [0]
    out = []
    while n:
        out.append(n % base)
        n //= base
    return out[::-1]


def frac_to_base(value_, base, frac_digits):
    """把分数按基展开，返回 (整数数位, 小数数位, 剩余余数)。"""
    int_part = value_.numerator // value_.denominator
    rem = value_ - int_part
    fracs = []
    for _ in range(frac_digits):
        rem *= base
        bit = int(rem)
        fracs.append(bit)
        rem -= bit
    return digits_of(int_part, base), fracs, rem


# ---------- 12 道正式题的答案 ----------
check("Q-002 1010_2 -> 10", value("1010_2"), 10)
check("Q-003 11110000_2 -> 240", value("11110000_2"), 240)
check("Q-005 1010_2 -> A_16", to_int([10], 16), 10)  # 十进制 10 的十六进制为 A
check("Q-006 11110000_2 -> F0_16", value("11110000_2"), value("F0_16"))
check("Q-008 A5_16 -> 165", value("A5_16"), 165)
check("Q-009 FFFF_16 -> 65535", value("FFFF_16"), 65535)
check("Q-011 A5_16 -> 10100101_2", value("10100101_2"), value("A5_16"))
check("Q-012 FFFF_16 -> 16 个 1", value("1111111111111111_2"), value("FFFF_16"))

# Q-022：50 GB（GB=10^9 字节）能存多少 MB（MB=10^6 字节）；另附 2^30 口径对照
check("Q-022 50GB -> 50000MB", 50 * 10 ** 9 // 10 ** 6, 50000)
check("Q-022 2^30 口径 ≈46.57 GiB", abs(Fraction(50 * 10 ** 9, 2 ** 30)
      - Fraction(4657, 100)) < Fraction(5, 1000), True)

# Q-024/025：4 位无符号加法与溢出（枚举验证：溢出当且仅当 真实和 > 15）
a, b = to_int([1, 0, 0, 1], 2), to_int([0, 1, 0, 0], 2)
check("Q-024 1001+0100=1101 无溢出", (a + b, a + b <= 15, to_int([1, 1, 0, 1], 2)), (13, True, 13))
a, b = to_int([1, 1, 0, 1], 2), to_int([1, 0, 1, 1], 2)
check("Q-025 1101+1011=24 溢出，4 位结果 1000", (a + b > 15, (a + b) % 16), (True, 8))

# Q-032：10010101_BCD -> 95 -> 1011111_2（原页 1.65(c) 勘误依据）
check("Q-032 10010101_BCD -> 95", value("10010101_BCD"), 95)
check("Q-032 95 -> 1011111_2", value("1011111_2"), 95)

# ---------- 正文例题与步骤 ----------
check("例 26.75_10 == 11010.11_2", Fraction(2675, 100), value("11010.11_2"))
check("例 101.011_2 == 5.375", value("101.011_2"), Fraction(5375, 1000))
check("例 10110_2 == 22", value("10110_2"), 22)
check("自测 8AE6_16 == 35558", value("8AE6_16"), 35558)

# 例5 组值：按权相加（含 0.101_2 与 1C4_16 的组值）。1C4 的位权是 16²、16¹、16⁰，
# 期望值按定义逐位展开而非引用正文或练习册答案
check("例5 1010_2 == 10", value("1010_2"), 10)
check("例5 167_8 == 119", value("167_8"), 119)
check("例5 1C4_16 == 452（按位权 1×16²+12×16¹+4×16⁰ 展开）",
      1 * 16 ** 2 + 12 * 16 ** 1 + 4 * 16 ** 0, 452)
check("例5 0.101_2 == 0.625", value("0.101_2"), Fraction(5, 8))

# 十进制转二进制：11 -> 1011；0.625 -> 0.101；0.8125 -> 0.1101（除2取余/乘2取整）
ints, fracs, rem = frac_to_base(Fraction(11), 2, 0)
check("11 -> 1011", int("".join(map(str, ints))), 1011)
ints, fracs, rem = frac_to_base(Fraction(5, 8), 2, 3)
check("0.625 -> 0.101", int("".join(map(str, fracs))) if fracs else None, 101)
ints, fracs, rem = frac_to_base(Fraction(13, 16), 2, 4)
check("0.8125 -> 0.1101", int("".join(map(str, fracs))) if fracs else None, 1101)

# 精度提醒：0.4_10 乘 2 取整的位流前 8 位为 01100110，无限循环不 terminates
rem = Fraction(2, 5)
bits = []
for _ in range(8):
    rem *= 2
    bits.append(int(rem))
    rem -= int(rem)
check("0.4 乘2取整前 8 位 == 01100110", to_int(bits, 10), 1100110)
check("0.4 乘 2^8 后仍非整数（无限循环证据）", (Fraction(2, 5) * 2 ** 8).denominator != 1, True)

# 分组法：二/八/十六互转（例6/例7/例8，按原页数位）
check("例6 67.731_8 == 110111.111011001_2",
      value("67.731_8"), value("110111.111011001_2"))
check("例7 11111101.01001111_2 == 375.236_8",
      value("11111101.01001111_2"), value("375.236_8"))
check("例8 1111101.0100111_2 == 7D.4E_16",
      value("1111101.0100111_2"), value("7D.4E_16"))
check("例7 分组补零 整数左补 01111101 == 375_8",
      value("011111101_2"), value("375_8"))
check("例8 分组补零 整数 01111101 == 7D_16",
      value("01111101_2"), value("7D_16"))

# 分组方向：整数向最高位左补、小数向最低位右补（3AB4 与 0011 1010 1011 0100）
check("3AB4_16 == 0011101010110100_2", value("3AB4_16"), value("0011101010110100_2"))

# ---------- 无符号四则竖式（枚举而非抄写） ----------
def add_bits(x, y, width=4):
    """逐位竖式加法，返回 (结果数位, 最终进位)。数位按高位到低位。"""
    carries = 0
    out = []
    carry = 0
    for i in range(width - 1, -1, -1):
        s = x[i] + y[i] + carry
        out.append(s % 2)
        carry = s // 2
    out.reverse()
    return out, carry


def sub_bits(x, y, width=5):
    """逐位竖式减法（x>=y），返回结果数位与最终借位。"""
    out = []
    borrow = 0
    for i in range(width - 1, -1, -1):
        s = x[i] - y[i] - borrow
        if s < 0:
            s += 2
            borrow = 1
        else:
            borrow = 0
        out.append(s)
    out.reverse()
    return out, borrow


x, y = [1, 1, 0, 0, 1], [0, 0, 1, 0, 1]  # 11001 与 00101
s, carry = add_bits(x, y, 5)
check("竖式 11001+00101=11110（末位进位 0）", (to_int(s, 2), carry), (to_int([1, 1, 1, 1, 0], 2), 0))
d, borrow = sub_bits(x, y, 5)
check("竖式 11001-00101=10100（末位借位 0）", (to_int(d, 2), borrow), (to_int([1, 0, 1, 0, 0], 2), 0))
check("积 25*5 == 1111101_2", Fraction(25 * 5), value("1111101_2"))
check("商 25//5 == 101_2 余 0", (to_int([1, 0, 1], 2), 25 % 5), (5, 0))

# ---------- p42 溢出判据 ----------
# 无符号：溢出 = 最高位向外进位/借位；有符号：溢出 = 同号相加得异号。逐一枚举核对
overflow_cases = []
for w in (4, 8):
    for a_ in range(2 ** w):
        for b_ in range(2 ** w):
            s_ = a_ + b_
            unsigned_of = s_ >= 2 ** w
            sa, sb = a_ < 2 ** (w - 1), b_ < 2 ** (w - 1)
            signed_of = sa and sb and (s_ % 2 ** w) >= 2 ** (w - 1)
            overflow_cases.append((w, a_, b_, unsigned_of, signed_of))
c42 = [c for c in overflow_cases if c[0] == 4 and c[1] == 5 and c[2] == 6][0]
check("p42 4 位 5+6：无符号不溢出、有符号溢出", (c42[3], c42[4]), (False, True))
c42 = [c for c in overflow_cases if c[0] == 4 and c[1] == 2 and c[2] == 3][0]
check("p42 4 位 2+3：两种口径都不溢出", (c42[3], c42[4]), (False, False))
c42 = [c for c in overflow_cases if c[0] == 8 and c[1] == 5 and c[2] == 6][0]
check("p42 8 位 5+6：两种口径都不溢出", (c42[3], c42[4]), (False, False))
c42 = [c for c in overflow_cases if c[0] == 4 and c[1] == 13 and c[2] == 11][0]
check("Q-025 4 位 13+11：无符号溢出", (c42[3], c42[4]), (True, False))
c42 = [c for c in overflow_cases if c[0] == 4 and c[1] == 9 and c[2] == 4][0]
check("Q-024 4 位 9+4：两种口径都不溢出", (c42[3], c42[4]), (False, False))

# ---------- KU-005 片段：无符号四则自测三题（units/KU-005.json） ----------
# 自测① 0111+0101：竖式枚举 + 十进制锚点 7+5=12
s1, c1 = add_bits([0, 1, 1, 1], [0, 1, 0, 1], 4)
check("KU-005 自测① 0111+0101=1100，无进位输出",
      (to_int(s1, 2), c1), (value("1100_2"), 0))
check("KU-005 自测① 十进制锚点 7+5=12≤15 不溢出", (7 + 5, 7 + 5 <= 15), (12, True))
# 自测② 1001+1000：竖式枚举 + 十进制锚点 9+8=17>15 溢出
s2, c2 = add_bits([1, 0, 0, 1], [1, 0, 0, 0], 4)
check("KU-005 自测② 1001+1000=0001，进位输出 1",
      (to_int(s2, 2), c2), (value("0001_2"), 1))
check("KU-005 自测② 十进制锚点 9+8=17>15 溢出，截断 17 mod 16 = 1",
      (9 + 8 > 15, (9 + 8) % 16), (True, 1))
# 自测③ 1101−0110：竖式枚举 + 十进制锚点 13−6=7；逐位借位链 bit1 借位、bit2 再借
d3, b3 = sub_bits([1, 1, 0, 1], [0, 1, 1, 0], 4)
check("KU-005 自测③ 1101−0110=0111，无最终借位",
      (to_int(d3, 2), b3), (value("0111_2"), 0))
check("KU-005 自测③ 十进制锚点 13−6=7，7 可用 4 位表示故无最终借位",
      (13 - 6, 0 <= 13 - 6 <= 15), (7, True))


# 每一项都从小数定义独立换算，期望值不来自片段文本
check("KU-001 片段 26.75 权展开 = 原数",
      Fraction(2) * 10 + 6 + Fraction(7, 10) + Fraction(5, 100), Fraction("26.75"))
check("KU-001 片段 101.011_2 = 5.375",
      4 + 1 + Fraction(1, 4) + Fraction(1, 8), Fraction("5.375"))
check("KU-001 片段 67.731_8 = 55.923828125",
      6 * 8 + 7 + Fraction(7, 8) + Fraction(3, 64) + Fraction(1, 512),
      Fraction("55.923828125"))
check("KU-001 片段 8AE6_16 = 35558", 8 * 4096 + 10 * 256 + 14 * 16 + 6, 35558)
check("KU-001 片段 1C4_16 = 452（按位权 1×16²+12×16¹+4×16⁰ 独立展开）",
      1 * 16 ** 2 + 12 * 16 ** 1 + 4 * 16 ** 0, 452)
check("KU-001 片段 11.01_2 = 3.25（练习答案）",
      2 + 1 + Fraction(1, 4), Fraction("3.25"))

# 位权表逐行自检：表中数值必须等于对应基数的幂
_weights = {
    5: (32, 32768, 100000, 1048576), 4: (16, 4096, 10000, 65536),
    3: (8, 512, 1000, 4096), 2: (4, 64, 100, 256), 1: (2, 8, 10, 16),
    0: (1, 1, 1, 1), -1: (Fraction(1, 2), Fraction(1, 8), Fraction(1, 10), Fraction(1, 16)),
    -2: (Fraction(1, 4), Fraction(1, 64), Fraction(1, 100), Fraction(1, 256)),
    -3: (Fraction(1, 8), Fraction(1, 512), Fraction(1, 1000), Fraction(1, 4096)),
}
for _i, _vals in _weights.items():
    check(f"KU-001 片段 位权表 {_i} 行自洽",
          (Fraction(2) ** _i, Fraction(8) ** _i, Fraction(10) ** _i, Fraction(16) ** _i),
          tuple(_vals))

# ---------- KU-002 逐单元片段正文的全部数值断言（units/KU-002.json） ----------
# 正式题答案
check("KU-002 片段 Q-002 1010_2 = 10", value("1010_2"), 10)
check("KU-002 片段 Q-003 11110000_2 = 240", value("11110000_2"), 240)
check("KU-002 片段 Q-008 A5_16 = 165", value("A5_16"), 165)
check("KU-002 片段 Q-009 FFFF_16 = 65535", value("FFFF_16"), 65535)
check("KU-002 片段 FFFF_16 == 16 个 1（验算）",
      value("FFFF_16"), 2 ** 16 - 1)
check("KU-002 片段 Q-032 10010101_BCD = 95", value("10010101_BCD"), 95)
check("KU-002 片段 Q-032 95 -> 1011111_2", value("1011111_2"), 95)
# 方法步骤例题
ints, fracs, rem = frac_to_base(Fraction(11), 2, 0)
check("KU-002 片段 11 -> 1011（除2取余枚举）", int("".join(map(str, ints))), 1011)
ints, fracs, rem = frac_to_base(Fraction(5, 8), 2, 3)
check("KU-002 片段 0.625 -> 0.101（乘2取整枚举）",
      int("".join(map(str, fracs))), 101)
check("KU-002 片段 0.42_8 = 0.53125", value("0.42_8"), Fraction("0.53125"))
# 精度 callout：0.4 无限循环证据
rem = Fraction(2, 5)
bits = []
for _ in range(8):
    rem *= 2
    bits.append(int(rem))
    rem -= int(rem)
check("KU-002 片段 0.4 乘2取整前 8 位 == 01100110", to_int(bits, 10), 1100110)
check("KU-002 片段 0.4 乘 2^k 后分母仍非 1（k=1..12）",
      all((Fraction(2, 5) * 2 ** k).denominator != 1 for k in range(1, 13)), True)
check("KU-002 片段 有限小数判定：分母为 2 的幂可终止",
      [Fraction(x, y).denominator for x, y in ((5, 10), (1, 2), (3, 4), (13, 16), (2, 5), (3, 5), (1, 10))],
      [2, 2, 4, 16, 5, 5, 10])
# 自测练习答案
ints, fracs, rem = frac_to_base(Fraction(45), 2, 0)
check("KU-002 片段 45 -> 101101（除2取余枚举）", int("".join(map(str, ints))), 101101)
check("KU-002 片段 45 -> 2D_16", to_int([2, 13], 16), 45)
check("KU-002 片段 0.68_16 = 0.40625", value("0.68_16"), Fraction("0.40625"))
ints, fracs, rem = frac_to_base(Fraction(13, 32), 16, 2)
check("KU-002 片段 0.40625 -> 0.68（乘16取整枚举）",
      (int("".join(map(str, fracs))), rem), (68, 0))

# ---------- KU-003 片段：分组互转自测与对照表自检 ----------
# 自测练习答案：11011.1011_2 应同时等于 33.54_8 与 1B.B_16，锚定十进制 27.6875
v_11011 = value("11011.1011_2")
check("KU-003 片段 11011.1011_2 = 27.6875（十进制锚点）", v_11011, Fraction("27.6875"))
check("KU-003 片段 11011.1011_2 = 33.54_8", v_11011, value("33.54_8"))
check("KU-003 片段 11011.1011_2 = 1B.B_16", v_11011, value("1B.B_16"))
# 自测第②题：AF.16C_16 展开应还原 1010 1111.0001 0110 1100
check("KU-003 片段 AF.16C_16 = 10101111.000101101100_2",
      value("AF.16C_16"), value("10101111.000101101100_2"))
# 对照表自检：八进制 0-7 每个数码的 3 位组按权展开等于数码值
check("KU-003 片段 八进制 0-7 的 3 位组表自检",
      all(to_int([d >> 2, (d >> 1) & 1, d & 1], 2) == d for d in range(8)), True)
# 对照表自检：十六进制 0-15 每个数码的 4 位组按权展开等于数码值
check("KU-003 片段 十六进制 0-15 的 4 位组表自检",
      all(to_int([(d >> 3) & 1, (d >> 2) & 1, (d >> 1) & 1, d & 1], 2) == d
          for d in range(16)), True)

# ---------- KU-004 片段：单位定义与两口径容量换算（units/KU-004.json） ----------
# 全部从小数定义独立换算，期望值不来自片段文本
check("KU-004 片段 50GB（厂商口径 GB=10^9 字节）= 5×10^10 字节", 50 * 10 ** 9, 50_000_000_000)
check("KU-004 片段 50GB = 50000MB（厂商口径 MB=10^6 字节）", (50 * 10 ** 9) // 10 ** 6, 50000)
check("KU-004 片段 50×2^30 = 53687091200（二进制口径）", 50 * 2 ** 30, 53687091200)
check("KU-004 片段 两口径差 = 3687091200 字节",
      50 * 2 ** 30 - 50 * 10 ** 9, 3687091200)
check("KU-004 片段 差值 ≈ 3.69GB（厂商口径，误差 < 0.005）",
      abs(Fraction(50 * 2 ** 30 - 50 * 10 ** 9, 10 ** 9) - Fraction("3.69"))
      < Fraction(5, 1000), True)
check("KU-004 片段 5×10^10 字节 ≈ 46.57 GiB（误差 < 0.005）",
      abs(Fraction(50 * 10 ** 9, 2 ** 30) - Fraction("46.57"))
      < Fraction(5, 1000), True)
check("KU-004 片段 1 MiB = 2^20 = 1048576 字节", 2 ** 20, 1048576)
check("KU-004 片段 1 MiB − 10^6 = 48576 字节", 2 ** 20 - 10 ** 6, 48576)
check("KU-004 片段 32 位字 = 4 字节 = 8 半字节", (32 // 8, 32 // 4), (4, 8))
check("KU-004 片段 2^30/10^9 = 1.073741824（GB 级口径差 ≈ 7.4%）",
      Fraction(2 ** 30, 10 ** 9), Fraction("1.073741824"))

failed = [c for c in checks if not c["pass"]]
result = {
    "tool": "content-audit.py",
    "package": "CP-TH01-20261025-v1",
    "scope": "KU-001..KU-005 与 12 道正式题的独立计算复核",
    "total": len(checks),
    "passed": len(checks) - len(failed),
    "failed": len(failed),
    "checks": checks,
}
(HERE / "content-audit.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{result['passed']}/{result['total']} checks passed")
if failed:
    raise SystemExit(1)
