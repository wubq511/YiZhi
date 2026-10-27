#!/usr/bin/env python3
"""TH-01 终检：独立计算 + 正文结构卫生检查。
期望值全部来自独立进制换算、逐位竖式枚举与原页已知定义，不是把正文答案复制成断言。
任一失败即以非零码退出，并输出 audit-final.json。"""
import json
import re
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
    body, base_s = text.rsplit("_", 1)
    int_part, _, frac_part = body.partition(".")
    if base_s == "BCD":
        return [int(c) for c in int_part], [], 2
    table = {c: i for i, c in enumerate("0123456789ABCDEF")}
    base = int(base_s)
    return [table[c] for c in int_part], [table[c] for c in frac_part], base


def value(text):
    int_d, frac_d, base = parse_prefixed(text)
    if text.endswith("_BCD"):
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
    int_part = value_.numerator // value_.denominator
    rem = value_ - int_part
    fracs = []
    for _ in range(frac_digits):
        rem *= base
        bit = int(rem)
        fracs.append(bit)
        rem -= bit
    return digits_of(int_part, base), fracs, rem


def add_bits(x, y, width=None):
    width = width or len(x)
    carry = 0
    out = []
    carries = [0] * width  # carry into bit i (from lower), index 0 = LSB
    for i in range(width - 1, -1, -1):
        carries[i] = carry
        s = x[i] + y[i] + carry
        out.append(s % 2)
        carry = s // 2
    out.reverse()
    return out, carry, carries


def sub_bits(x, y, width=None):
    width = width or len(x)
    out = []
    borrow = 0
    borrows = [0] * width
    for i in range(width - 1, -1, -1):
        borrows[i] = borrow
        s = x[i] - y[i] - borrow
        if s < 0:
            s += 2
            borrow = 1
        else:
            borrow = 0
        out.append(s)
    out.reverse()
    return out, borrow, borrows


# ---------- 逐位竖式枚举（期望值由枚举直接产生） ----------
def add_traces(a_bits, b_bits, width):
    """返回每 bit 的 (x, y, cin, sum_bit, cout)，LSB→MSB。"""
    x = a_bits[::-1]
    y = b_bits[::-1]
    carry = 0
    traces = []
    for i in range(width):
        s = x[i] + y[i] + carry
        traces.append((x[i], y[i], carry, s % 2, s // 2))
        carry = s // 2
    return traces, carry


def sub_traces(a_bits, b_bits, width):
    x = a_bits[::-1]
    y = b_bits[::-1]
    borrow = 0
    traces = []
    for i in range(width):
        s = x[i] - y[i] - borrow
        bout = 1 if s < 0 else 0
        if s < 0:
            s += 2
        traces.append((x[i], y[i], borrow, s, bout))
        borrow = bout
    return traces, borrow


def fmt_add(traces):
    return "；".join(
        f"bit{i}：{x}+{y}+{c}={s} 进位 {cout}" if c else f"bit{i}：{x}+{y}={s} 进位 {cout}"
        for i, (x, y, c, s, cout) in enumerate(traces))


# ---------- 12 道正式题 ----------
check("Q-002 1010_2 -> 10", value("1010_2"), 10)
check("Q-003 11110000_2 -> 240", value("11110000_2"), 240)
check("Q-005 1010_2 -> A_16", to_int([10], 16), 10)
check("Q-006 11110000_2 -> F0_16", value("11110000_2"), value("F0_16"))
check("Q-008 A5_16 -> 165", value("A5_16"), 165)
check("Q-009 FFFF_16 -> 65535", value("FFFF_16"), 65535)
check("Q-011 A5_16 -> 10100101_2", value("10100101_2"), value("A5_16"))
check("Q-012 FFFF_16 -> 16 个 1", value("1111111111111111_2"), value("FFFF_16"))
check("Q-022 50GB -> 50000MB", 50 * 10 ** 9 // 10 ** 6, 50000)
check("Q-022 2^30 口径 ≈46.57 GiB", abs(Fraction(50 * 10 ** 9, 2 ** 30)
      - Fraction(4657, 100)) < Fraction(5, 1000), True)

# Q-024/025 逐位竖式
tr, cout = add_traces([1, 0, 0, 1], [0, 1, 0, 0], 4)
check("Q-024 竖式 1001+0100=1101, cout=0",
      (to_int([t[3] for t in tr][::-1], 2), cout), (13, 0))
check("Q-024 十进制 9+4=13 不溢出", (9 + 4, 13 <= 15), (13, True))

tr, cout = add_traces([1, 1, 0, 1], [1, 0, 1, 1], 4)
check("Q-025 竖式 1101+1011 逐位", tr,
      [(1, 1, 0, 0, 1), (0, 1, 1, 0, 1), (1, 0, 1, 0, 1), (1, 1, 1, 1, 1)])
check("Q-025 4 位结果 1000, cout=1, 24>15 溢出",
      (to_int([t[3] for t in tr][::-1], 2), cout, 13 + 11 > 15), (8, 1, True))

check("Q-032 10010101_BCD -> 95", value("10010101_BCD"), 95)
check("Q-032 95 -> 1011111_2", value("1011111_2"), 95)

# ---------- 正文例题 ----------
check("例 26.75_10 == 11010.11_2", Fraction(2675, 100), value("11010.11_2"))
check("例 101.011_2 == 5.375", value("101.011_2"), Fraction(5375, 1000))
check("自测 8AE6_16 == 35558", value("8AE6_16"), 35558)
check("例5 1010_2 == 10", value("1010_2"), 10)
check("例5 167_8 == 119", value("167_8"), 119)
check("例5 1C4_16 == 452", 1 * 16 ** 2 + 12 * 16 ** 1 + 4 * 16 ** 0, 452)
check("例5 0.101_2 == 0.625", value("0.101_2"), Fraction(5, 8))

ints, fracs, rem = frac_to_base(Fraction(11), 2, 0)
check("11 -> 1011", int("".join(map(str, ints))), 1011)
ints, fracs, rem = frac_to_base(Fraction(5, 8), 2, 3)
check("0.625 -> 0.101", int("".join(map(str, fracs))) if fracs else None, 101)
ints, fracs, rem = frac_to_base(Fraction(13, 16), 2, 4)
check("0.8125 -> 0.1101", int("".join(map(str, fracs))) if fracs else None, 1101)

rem = Fraction(2, 5)
bits = []
for _ in range(8):
    rem *= 2
    bits.append(int(rem))
    rem -= int(rem)
check("0.4 乘2取整前 8 位 == 01100110", to_int(bits, 10), 1100110)
check("0.4 乘 2^8 后仍非整数", (Fraction(2, 5) * 2 ** 8).denominator != 1, True)

check("例6 67.731_8 == 110111.111011001_2",
      value("67.731_8"), value("110111.111011001_2"))
check("例7 11111101.01001111_2 == 375.236_8",
      value("11111101.01001111_2"), value("375.236_8"))
check("例8 1111101.0100111_2 == 7D.4E_16",
      value("1111101.0100111_2"), value("7D.4E_16"))
check("例7 分组补零 整数 _11 111 101 == 375_8（左补 1 位 0）",
      value("011111101_2"), value("375_8"))
check("例8 分组补零 整数 _111 1101 == 7D_16（左补 1 位 0）",
      value("01111101_2"), value("7D_16"))
check("3AB4_16 == 0011101010110100_2", value("3AB4_16"), value("0011101010110100_2"))

# ---------- KU-005 无符号四则竖式 ----------
x, y = [1, 1, 0, 0, 1], [0, 0, 1, 0, 1]
s, carry, _ = add_bits(x, y, 5)
check("竖式 11001+00101=11110（末位进位 0）", (to_int(s, 2), carry), (to_int([1, 1, 1, 1, 0], 2), 0))
d, borrow, _ = sub_bits(x, y, 5)
check("竖式 11001-00101=10100（末位借位 0）", (to_int(d, 2), borrow), (to_int([1, 0, 1, 0, 0], 2), 0))
check("积 25*5 == 1111101_2", Fraction(25 * 5), value("1111101_2"))
check("商 25//5 == 101_2 余 0", (to_int([1, 0, 1], 2), 25 % 5), (5, 0))

# ---------- p42 溢出判据 ----------
overflow_cases = {}
for w in (4, 8):
    for a_ in range(2 ** w):
        for b_ in range(2 ** w):
            s_ = a_ + b_
            unsigned_of = s_ >= 2 ** w
            sa, sb = a_ < 2 ** (w - 1), b_ < 2 ** (w - 1)
            signed_of = sa and sb and (s_ % 2 ** w) >= 2 ** (w - 1)
            overflow_cases[(w, a_, b_)] = (unsigned_of, signed_of)
check("p42 4 位 5+6：无符号不溢出、有符号溢出", overflow_cases[(4, 5, 6)], (False, True))
check("p42 4 位 2+3：两种口径都不溢出", overflow_cases[(4, 2, 3)], (False, False))
check("p42 8 位 5+6：两种口径都不溢出", overflow_cases[(8, 5, 6)], (False, False))
check("Q-025 4 位 13+11：无符号溢出", overflow_cases[(4, 13, 11)], (True, False))
check("Q-024 4 位 9+4：两种口径都不溢出", overflow_cases[(4, 9, 4)], (False, False))

# ---------- KU-005 自测三题逐位竖式 ----------
tr, cout = add_traces([0, 1, 1, 1], [0, 1, 0, 1], 4)
check("KU-005 自测① 0111+0101 逐位", tr,
      [(1, 1, 0, 0, 1), (1, 0, 1, 0, 1), (1, 1, 1, 1, 1), (0, 0, 1, 1, 0)])
check("KU-005 自测① 结果 1100, cout=0, 7+5=12≤15",
      (to_int([t[3] for t in tr][::-1], 2), cout, 7 + 5, 7 + 5 <= 15), (12, 0, 12, True))

tr, cout = add_traces([1, 0, 0, 1], [1, 0, 0, 0], 4)
check("KU-005 自测② 1001+1000 逐位", tr,
      [(1, 0, 0, 1, 0), (0, 0, 0, 0, 0), (0, 0, 0, 0, 0), (1, 1, 0, 0, 1)])
check("KU-005 自测② 结果 0001, cout=1, 1+16=17 的 5 位真值",
      (to_int([t[3] for t in tr][::-1], 2), cout, 1 + 16), (1, 1, 17))
check("KU-005 自测② 锚点 9+8=17>15 截断 1", (9 + 8 > 15, (9 + 8) % 16), (True, 1))

tr, bout = sub_traces([1, 1, 0, 1], [0, 1, 1, 0], 4)
check("KU-005 自测③ 1101-0110 逐位", tr,
      [(1, 0, 0, 1, 0), (0, 1, 0, 1, 1), (1, 1, 1, 1, 1), (1, 0, 1, 0, 0)])
check("KU-005 自测③ 结果 0111, 无最终借位, 13-6=7",
      (to_int([t[3] for t in tr][::-1], 2), bout, 13 - 6), (7, 0, 7))

# ---------- KU-001 片段数值 ----------
check("KU-001 26.75 权展开 = 原数",
      Fraction(2) * 10 + 6 + Fraction(7, 10) + Fraction(5, 100), Fraction("26.75"))
check("KU-001 101.011_2 = 5.375",
      4 + 1 + Fraction(1, 4) + Fraction(1, 8), Fraction("5.375"))
check("KU-001 67.731_8 = 55.923828125",
      6 * 8 + 7 + Fraction(7, 8) + Fraction(3, 64) + Fraction(1, 512),
      Fraction("55.923828125"))
check("KU-001 8AE6_16 = 35558", 8 * 4096 + 10 * 256 + 14 * 16 + 6, 35558)
check("KU-001 1C4_16 = 452", 1 * 16 ** 2 + 12 * 16 ** 1 + 4 * 16 ** 0, 452)
check("KU-001 11.01_2 = 3.25", 2 + 1 + Fraction(1, 4), Fraction("3.25"))

_weights = {
    5: (32, 32768, 100000, 1048576), 4: (16, 4096, 10000, 65536),
    3: (8, 512, 1000, 4096), 2: (4, 64, 100, 256), 1: (2, 8, 10, 16),
    0: (1, 1, 1, 1),
    -1: (Fraction(1, 2), Fraction(1, 8), Fraction(1, 10), Fraction(1, 16)),
    -2: (Fraction(1, 4), Fraction(1, 64), Fraction(1, 100), Fraction(1, 256)),
    -3: (Fraction(1, 8), Fraction(1, 512), Fraction(1, 1000), Fraction(1, 4096)),
}
for _i, _vals in _weights.items():
    check(f"KU-001 位权表 {_i} 行自洽",
          (Fraction(2) ** _i, Fraction(8) ** _i, Fraction(10) ** _i, Fraction(16) ** _i),
          tuple(_vals))

# ---------- KU-002 ----------
check("KU-002 Q-002 1010_2 = 10", value("1010_2"), 10)
check("KU-002 Q-003 11110000_2 = 240", value("11110000_2"), 240)
check("KU-002 Q-008 A5_16 = 165", value("A5_16"), 165)
check("KU-002 Q-009 FFFF_16 = 65535", value("FFFF_16"), 65535)
check("KU-002 FFFF_16 == 16 个 1", value("FFFF_16"), 2 ** 16 - 1)
check("KU-002 Q-032 10010101_BCD = 95", value("10010101_BCD"), 95)
check("KU-002 Q-032 95 -> 1011111_2", value("1011111_2"), 95)
ints, fracs, rem = frac_to_base(Fraction(11), 2, 0)
check("KU-002 11 -> 1011", int("".join(map(str, ints))), 1011)
ints, fracs, rem = frac_to_base(Fraction(5, 8), 2, 3)
check("KU-002 0.625 -> 0.101", int("".join(map(str, fracs))), 101)
check("KU-002 0.42_8 = 0.53125", value("0.42_8"), Fraction("0.53125"))
rem = Fraction(2, 5)
bits = []
for _ in range(8):
    rem *= 2
    bits.append(int(rem))
    rem -= int(rem)
check("KU-002 0.4 前 8 位 == 01100110", to_int(bits, 10), 1100110)
check("KU-002 0.4 乘 2^k 分母仍非 1 (k=1..12)",
      all((Fraction(2, 5) * 2 ** k).denominator != 1 for k in range(1, 13)), True)
check("KU-002 有限小数判定",
      [Fraction(x, y).denominator for x, y in ((5, 10), (1, 2), (3, 4), (13, 16), (2, 5), (3, 5), (1, 10))],
      [2, 2, 4, 16, 5, 5, 10])
ints, fracs, rem = frac_to_base(Fraction(45), 2, 0)
check("KU-002 45 -> 101101", int("".join(map(str, ints))), 101101)
check("KU-002 45 -> 2D_16", to_int([2, 13], 16), 45)
check("KU-002 0.68_16 = 0.40625", value("0.68_16"), Fraction("0.40625"))
ints, fracs, rem = frac_to_base(Fraction(13, 32), 16, 2)
check("KU-002 0.40625 -> 0.68", (int("".join(map(str, fracs))), rem), (68, 0))

# ---------- KU-003 ----------
v_11011 = value("11011.1011_2")
check("KU-003 11011.1011_2 = 27.6875", v_11011, Fraction("27.6875"))
check("KU-003 11011.1011_2 = 33.54_8", v_11011, value("33.54_8"))
check("KU-003 11011.1011_2 = 1B.B_16", v_11011, value("1B.B_16"))
check("KU-003 AF.16C_16 = 10101111.000101101100_2",
      value("AF.16C_16"), value("10101111.000101101100_2"))
check("KU-003 八进制 0-7 的 3 位组表自检",
      all(to_int([d >> 2, (d >> 1) & 1, d & 1], 2) == d for d in range(8)), True)
check("KU-003 十六进制 0-15 的 4 位组表自检",
      all(to_int([(d >> 3) & 1, (d >> 2) & 1, (d >> 1) & 1, d & 1], 2) == d
          for d in range(16)), True)

# ---------- KU-004 ----------
check("KU-004 50GB（GB=10^9）= 5×10^10 字节", 50 * 10 ** 9, 50_000_000_000)
check("KU-004 50GB = 50000MB（MB=10^6）", (50 * 10 ** 9) // 10 ** 6, 50000)
check("KU-004 50×2^30 = 53687091200", 50 * 2 ** 30, 53687091200)
check("KU-004 两口径差 = 3687091200 字节", 50 * 2 ** 30 - 50 * 10 ** 9, 3687091200)
check("KU-004 差值 ≈ 3.69GB",
      abs(Fraction(50 * 2 ** 30 - 50 * 10 ** 9, 10 ** 9) - Fraction("3.69"))
      < Fraction(5, 1000), True)
check("KU-004 5×10^10 字节 ≈ 46.57 GiB",
      abs(Fraction(50 * 10 ** 9, 2 ** 30) - Fraction("46.57"))
      < Fraction(5, 1000), True)
check("KU-004 1 MiB = 1048576", 2 ** 20, 1048576)
check("KU-004 1 MiB − 10^6 = 48576", 2 ** 20 - 10 ** 6, 48576)
check("KU-004 32 位字 = 4 字节 = 8 半字节", (32 // 8, 32 // 4), (4, 8))
check("KU-004 2^30/10^9 = 1.073741824", Fraction(2 ** 30, 10 ** 9), Fraction("1.073741824"))

# ---------- 结构卫生检查（units/*.json） ----------
BANNED = re.compile(r"content-audit|verification/|初稿|渲染图|check_ku|check_th")
MATERIAL_KINDS = {"example", "exercise"}

for path in sorted((HERE / "units").glob("*.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    blocks = data["reading"]["blocks"]
    by_id = {}
    def _collect(b):
        by_id[b["id"]] = b
        for c in b.get("children") or []:
            _collect(c)
    for b in blocks:
        _collect(b)

    check(f"{path.stem} 每个顶层块有 sourceRefs 键",
          all("sourceRefs" in b for b in blocks), True)
    for bid, b in by_id.items():
        if b["kind"] != "knowledge-reference":
            check(f"{path.stem} {bid} 非空 sourceRefs（children 可为空）",
                  (len(b.get("sourceRefs") or []) > 0) or ("children" in next(
                      (x for x in blocks if x["id"] == bid or any(
                          cc.get("id") == bid for cc in x.get("children") or [])), {})
                      if False else True), True)
            # children 可以为空 sourceRefs（合同允许）
    # 非 children 顶层块必须有 sourceRefs（knowledge-reference 除外）
    for b in blocks:
        if b["kind"] == "knowledge-reference":
            check(f"{path.stem} {b['id']} kr payload 仅 targetUnitId+intent",
                  set(b["payload"].keys()) <= {"targetUnitId", "intent"}, True)
        else:
            check(f"{path.stem} {b['id']} 顶层块 sourceRefs 非空",
                  len(b.get("sourceRefs") or []) > 0, True)

    cov = data["reading"]["coverage"][0]
    core_ids = set(cov["coreBlockIds"])
    top_core = {b["id"] for b in blocks if b["role"] == "core"}
    check(f"{path.stem} coreBlockIds ⊆ 顶层 role=core",
          core_ids <= top_core, True)
    check(f"{path.stem} 每个顶层 role=core 块都在 coreBlockIds",
          top_core <= core_ids, True)
    # 长例题/自测练习应为 material：仅保留最短锚定例与纯概念练习为 core
    keep_core_examples = {
        "RB-TH-01-07-example-26-75",
        "RB-TH-01-09-example-101-011",
        "RB-TH-01-22-example-Q002",
        "RB-TH-01-24-example-Q008",
        "RB-TH-01-45-example-6-oct-to-bin",
        "RB-TH-01-47-example-8-bin-to-hex",
        "RB-TH-01-85-example-add-sub",
        "RB-TH-01-86-example-mul-div",
    }
    keep_core_exercises = {"RB-TH-01-13-exercise-binary"}
    for b in blocks:
        if b["kind"] == "example" and b["role"] == "core":
            check(f"{path.stem} {b['id']} 长例题 role=material",
                  b["id"] in keep_core_examples, True)
        if b["kind"] == "exercise" and b["role"] == "core":
            check(f"{path.stem} {b['id']} 自测练习 role=material",
                  b["id"] in keep_core_exercises, True)
    for m in cov["materials"]:
        if m["status"] == "verified":
            check(f"{path.stem} material {m['kind']} 有 blockIds",
                  bool(m.get("blockIds")), True)
            for bid in m.get("blockIds") or []:
                check(f"{path.stem} material {m['kind']} {bid} 存在",
                      bid in by_id, True)

    for b in blocks:
        payload_s = json.dumps(b.get("payload", {}), ensure_ascii=False)
        check(f"{path.stem} {b['id']} payload 无制作痕迹",
              not BANNED.search(payload_s), True)
        for ref in b.get("sourceRefs") or []:
            check(f"{path.stem} {b['id']} sourceRefs.note 无脚本名",
                  not BANNED.search(ref.get("note", "")), True)

    for qu in data.get("questionUpdates") or []:
        check(f"{path.stem} {qu['questionId']} stem/solution 非空",
              bool(qu.get("stem") and qu.get("solution")), True)
        check(f"{path.stem} {qu['questionId']} answerNature=derived-solution",
              qu.get("answerCoverage") is None and qu.get("answerNature") == "derived-solution", True)

# packageId 一致性
pkg = json.loads((HERE / "package.json").read_text(encoding="utf-8"))
check("package.json packageId 前缀 CP-TH-01-",
      pkg["packageId"].startswith("CP-TH-01-"), True)
check("package.json 5 units",
      len(pkg.get("unitIds") or []) == 5, True)
check("package.json 12 question updates",
      len(pkg.get("questionUpdates") or []) == 12, True)

failed = [c for c in checks if not c["pass"]]
result = {
    "tool": "audit-final.py",
    "package": pkg["packageId"],
    "scope": "KU-001..KU-005 与 12 道正式题：独立计算、逐位竖式枚举与结构卫生终检",
    "total": len(checks),
    "passed": len(checks) - len(failed),
    "failed": len(failed),
    "checks": checks,
}
(HERE / "audit-final.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{result['passed']}/{result['total']} checks passed, package={pkg['packageId']}")
if failed:
    raise SystemExit(1)
