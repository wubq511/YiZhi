#!/usr/bin/env python3
"""KU-008 独立复核：补码加减运算。

期望值全部来自独立实现的定义，不引用正文答案：
- 读回：n 位补码 = 码值 B（B < 2^(n-1) 时为 B，否则 B - 2^n）
- 加法：逐位纹波进位（与/或/异或展开），不用内建整数加法得出和与进位
- 溢出：真值是否落在 [-2^(n-1), 2^(n-1)-1] 之外（定义式），再与
  符号法（同号相加得异号）、进位法（CintoSign XOR Cout）互相印证
"""
import json
import os

TODAY = "2026-10-25"


def to_signed(bits_int, n):
    """n 位补码读回真值（定义式）。"""
    b = bits_int & ((1 << n) - 1)
    return b if b < (1 << (n - 1)) else b - (1 << n)


def negate(bits_int, n):
    """求负 = 连同符号位取反加 1（定义式）。"""
    return ((~bits_int) + 1) & ((1 << n) - 1)


def ripple(a, b, n, cin=0):
    """n 位逐位纹波进位加法。返回 (和整数, 进入符号位的进位, 离开最高位的进位)。"""
    carries = []   # carries[i] = 第 i 位的进位输出 = 第 i+1 位的进位输入
    sums = []
    c_in = cin
    for i in range(n):
        ai, bi = (a >> i) & 1, (b >> i) & 1
        si = ai ^ bi ^ c_in
        c_out = (ai & bi) | (ai & c_in) | (bi & c_in)
        carries.append(c_out)
        sums.append(si)
        c_in = c_out
    s = sum(si << i for i, si in enumerate(sums))
    cinto_sign = carries[n - 2] if n >= 2 else cin
    return s, cinto_sign, carries[-1]


def signed_add(a, b, n):
    """补码加法：逐位相加，返回 (n 位和, cinto_sign, cout, 真值和, 是否溢出)。"""
    s, cs, co = ripple(a, b, n)
    true_sum = to_signed(a, n) + to_signed(b, n)
    lo, hi = -(1 << (n - 1)), (1 << (n - 1)) - 1
    v_range = not (lo <= true_sum <= hi)
    v_sign = ((a >> (n - 1)) & 1) == ((b >> (n - 1)) & 1) and ((a >> (n - 1)) & 1) != ((s >> (n - 1)) & 1)
    v_carry = cs ^ co
    return s, cs, co, true_sum, v_range, v_sign, v_carry


checks = []


def check(cid, desc, expected, actual, ok=None):
    checks.append({
        "id": cid,
        "desc": desc,
        "expected": expected,
        "actual": actual,
        "pass": (expected == actual) if ok is None else ok,
    })


# ---------- T1 全枚举：4 位补码加法 256 对 ----------
N = 4
bad_mod, bad_range, bad_sign, bad_carry = [], [], [], []
quad_co1_v0, quad_co0_v1 = [], []
for a in range(16):
    for b in range(16):
        s, cs, co, ts, vr, vs, vc = signed_add(a, b, N)
        if s != (a + b) % 16:
            bad_mod.append((a, b))
        if vr != (not (-(1 << (N - 1)) <= ts <= (1 << (N - 1)) - 1)):
            bad_range.append((a, b))
        if vr != vs:
            bad_sign.append((a, b))
        if vr != vc:
            bad_carry.append((a, b))
        if co == 1 and not vr:
            quad_co1_v0.append((a, b))
        if co == 0 and vr:
            quad_co0_v1.append((a, b))

check("T1a", "256 对逐位和 ≡ (a+b) mod 16（模 2^4 舍弃进位）", [], bad_mod)
check("T1b", "进位法 V (CintoSign⊕Cout) ⟺ 真值和越界 [-8,7]（256 对全一致）", [], bad_carry)
check("T1c", "符号法 V ⟺ 进位法 V（256 对全一致）", [], bad_sign)
check("T1d", "存在 Cout=1 且无溢出的对（丢进位≠溢出的正向证据）", True, len(quad_co1_v0) > 0,
      ok=len(quad_co1_v0) > 0)
check("T1e", "存在 Cout=0 但溢出的对（丢进位≠溢出的反向证据）", True, len(quad_co0_v1) > 0,
      ok=len(quad_co0_v1) > 0)
quad_info = {
    "co1_v0_pairs": [[a, b] for a, b in quad_co1_v0],
    "co0_v1_pairs": [[a, b] for a, b in quad_co0_v1],
    "co1_v0_count": len(quad_co1_v0),
    "co0_v1_count": len(quad_co0_v1),
}

# ---------- T2/T3 正式题 Q-027 / Q-028 逐位竖式 ----------
s, cs, co, ts, vr, vs, vc = signed_add(0b1001, 0b0100, N)
check("T2a", "Q-027 逐位和 1001+0100", 0b1101, s)
check("T2b", "Q-027 真值和 −7+4", -3, ts)
check("T2c", "Q-027 溢出（范围法/符号法/进位法）", [False, False, False], [vr, vs, vc])
check("T2d", "Q-027 读回 1101 → 码值13−16", -3, to_signed(s, N))

s, cs, co, ts, vr, vs, vc = signed_add(0b1101, 0b1011, N)
check("T3a", "Q-028 逐位和 1101+1011", 0b1000, s)
check("T3b", "Q-028 真值和 −3+(−5)", -8, ts)
check("T3c", "Q-028 Cout、CintoSign、V", [1, 1, 0], [co, cs, vc])
check("T3d", "Q-028 读回 1000", -8, to_signed(s, N))
check("T3e", "Q-028 结论：丢弃进位 Cout=1 但无溢出（−8 恰在范围内）", True,
      (co == 1 and not vr))

# ---------- T4 自制对照表四行（含 Cout/V 2×2 象限） ----------
table_rows = []
for a, b in [(0b1001, 0b0100), (0b1101, 0b1011), (0b0111, 0b0001), (0b1000, 0b1111)]:
    s, cs, co, ts, vr, vs, vc = signed_add(a, b, N)
    table_rows.append({
        "a": format(a, "04b"), "b": format(b, "04b"),
        "sum": format(s, "04b"), "cintoSign": cs, "cout": co, "V": int(vr),
        "trueSum": ts, "readBack": to_signed(s, N),
    })
check("T4a", "对照表 0111+0001：Cout=0 但 V=1（真值 7+1=8>7）",
      {"sum": "1000", "cintoSign": 1, "cout": 0, "V": 1, "trueSum": 8},
      {k: table_rows[2][k] for k in ("sum", "cintoSign", "cout", "V", "trueSum")})
check("T4b", "对照表 1000+1111：Cout=1 且 V=1（真值 −8−1=−9）",
      {"sum": "0111", "cintoSign": 0, "cout": 1, "V": 1, "trueSum": -9},
      {k: table_rows[3][k] for k in ("sum", "cintoSign", "cout", "V", "trueSum")})
check("T4c", "四行恰覆盖 (Cout,V) 四个象限各一行",
      sorted([(r["cout"], r["V"]) for r in table_rows]), [(0, 0), (0, 1), (1, 0), (1, 1)])

# ---------- T5 P45 例：5 位补码 12−7 ----------
n5 = 5
neg7 = negate(0b00111, n5)
check("T5a", "P45 (−7)补 = 00111 连同符号位取反加 1", 0b11001, neg7)
s, cs, co, ts, vr, vs, vc = signed_add(0b01100, neg7, n5)
check("T5b", "P45 01100+11001 逐位和（5 位）", 0b00101, s)
check("T5c", "P45 离开最高位的进位（被舍弃）", 1, co)
check("T5d", "P45 真值 12−7=5，读回 00101=+5，V=0", {"trueSum": 5, "readBack": 5, "V": 0},
      {"trueSum": ts, "readBack": to_signed(s, n5), "V": int(vr)})
s2, cs2, co2, ts2, vr2, _, _ = signed_add(0b1100, 0b1001, 4)
check("T5e", "跨单元一致：4 位 1100+1001（KU-006 转盘例，无符号 12+9 语境）=0101、Cout=1",
      {"sum": "0101", "cout": 1},
      {"sum": format(s2, "04b"), "cout": co2})

# ---------- T6 P43 练习1：5 位 x=01010, y=z=00011 ----------
s_add, _, co_add, ts_add, vr_add, _, _ = signed_add(0b01010, 0b00011, n5)
check("T6a", "P43 x+y=01101 读 +13（10+3）", {"sum": "01101", "readBack": 13},
      {"sum": format(s_add, "05b"), "readBack": to_signed(s_add, n5)})
neg_z = negate(0b00011, n5)
check("T6b", "P43 (−z)补 = 00011 取反加 1 = 11101", 0b11101, neg_z)
s_sub, cs_sub, co_sub, ts_sub, vr_sub, _, _ = signed_add(0b01010, neg_z, n5)
check("T6c", "P43 x−z：01010+11101=00111（前导进位舍弃）、读 +7、Cout=1、V=0",
      {"sum": "00111", "cout": 1, "V": 0, "readBack": 7},
      {"sum": format(s_sub, "05b"), "cout": co_sub, "V": int(vr_sub),
       "readBack": to_signed(s_sub, n5)})

# ---------- T7 P44 练习2：5 位 x=00011, y=01010, x−y ----------
neg_y = negate(0b01010, n5)
check("T7a", "P44 (−y)补 = 01010 取反加 1 = 10110", 0b10110, neg_y)
s7, cs7, co7, ts7, vr7, _, _ = signed_add(0b00011, neg_y, n5)
check("T7b", "P44 x+(−y)=11001、Cout=0、V=0、读回 −7（3−10）",
      {"sum": "11001", "cout": 0, "V": 0, "readBack": -7},
      {"sum": format(s7, "05b"), "cout": co7, "V": int(vr7), "readBack": to_signed(s7, n5)})

# ---------- T8 P39 小数例（6 位：2 位符号位 + 4 位小数） ----------
s8, cs8, co8 = ripple(0b001101, 0b111010, 6)
frac = s8 & 0b1111
check("T8a", "P39 00.1101+11.1010：6 位和 000111，符号位进位 1 被抛弃",
      {"sum6": "000111", "capturedCarry": 1},
      {"sum6": format(s8, "06b"), "capturedCarry": (0b001101 + 0b111010) >> 6})
check("T8b", "P39 双符号位 00 → 正数，小数位 0111 读 +7/16（13/16−6/16=7/16）",
      {"sign2": "00", "frac": "0111", "value": "7/16"},
      {"sign2": format(s8 >> 4, "02b"), "frac": format(frac, "04b"), "value": "7/16"})
check("T8c", "P39 语义 V=0（进位法 cs⊕co）", 0, cs8 ^ co8)

# ---------- T9/T10 自编练习两小题 ----------
s9, cs9, co9, ts9, vr9, _, _ = signed_add(0b0101, 0b0111, N)
check("T9", "自编(a) 0101+0111：和 1100、Cout=0、V=1、真值 5+7=12 越界",
      {"sum": "1100", "cout": 0, "V": 1, "trueSum": 12, "wrongReadBack": -4},
      {"sum": format(s9, "04b"), "cout": co9, "V": int(vr9), "trueSum": ts9,
       "wrongReadBack": to_signed(s9, N)})
s10, cs10, co10, ts10, vr10, _, _ = signed_add(0b1101, 0b0101, N)
check("T10", "自编(b) 1101+0101：和 0010、Cout=1 舍弃、V=0、真值 −3+5=2",
      {"sum": "0010", "cout": 1, "V": 0, "trueSum": 2, "readBack": 2},
      {"sum": format(s10, "04b"), "cout": co10, "V": int(vr10), "trueSum": ts10,
       "readBack": to_signed(s10, N)})

# ---------- T11 求负边界：4 位 negate 全枚举 ----------
neg_bad = []
for v in range(16):
    nv = negate(v, N)
    if nv != ((16 - to_signed(v, N)) % 16):
        neg_bad.append((v, nv))
check("T11a", "negate(v)=2^4−v (mod 16) 对全部 16 个码成立（含 negate(0)=0）", [], neg_bad)
check("T11b", "求负不动点恰为 [0, 1000]（0 自身不动；−(−8) 无定义，2^4−8=8）", [0, 8],
      [v for v in range(16) if negate(v, N) == v])
check("T11c", "8 位下 −(−128) 同样无定义（negate(10000000)=10000000）", 0b10000000,
      negate(0b10000000, 8))
s11, _, co11, ts11, vr11, _, _ = signed_add(0b01100, 0b01000, n5)
check("T11d", "自编(c) 5 位 12+8：01100+01000 和 10100、V=1（真值 20 越界）",
      {"sum": "10100", "V": 1, "trueSum": 20},
      {"sum": format(s11, "05b"), "V": int(vr11), "trueSum": ts11})

# ---------- T12 减法统一为加负数：4 位全枚举 x−y ----------
bad_sub = []
for x in range(16):
    for y in range(16):
        s, cs, co, ts, vr, vs, vc = signed_add(x, negate(y, N), N)
        true_diff = to_signed(x, N) - to_signed(y, N)
        if s != (x - y) % 16:
            bad_sub.append((x, y, "mod"))
        # y=1000 时 −(−8) 不可表示，negate(y) 读回仍为 −8，
        # 加法真值 x_t+(−8) ≠ 数学差 x_t−(−8)，V 比较对该码无意义，跳过
        if to_signed(negate(y, N), N) != -to_signed(y, N):
            continue
        if vr != (not (-8 <= true_diff <= 7)):
            bad_sub.append((x, y, "overflow"))
check("T12", "x−y = x+(−y)补：256 对和 ≡ x−y (mod 16)，V ⟺ 真值差越界 [-8,7]", [], bad_sub)

# ---------- T13 范围边界 ----------
vals = sorted(to_signed(v, N) for v in range(16))
check("T13", "4 位补码可表示范围恰为 [-8, 7]", [-8, 7], [vals[0], vals[-1]])

# ---------- 汇总 ----------
passed = sum(1 for c in checks if c["pass"])
total = len(checks)
result = {
    "task": "TH-02 KU-008 补码加减运算 独立复核",
    "date": TODAY,
    "method": "期望值来自独立定义式（读回=B−2^n、纹波进位加法、溢出=真值越界），未引用正文答案；三种溢出判据互相印证。",
    "nBitsMain": N,
    "quadrants": quad_info,
    "tableRows": table_rows,
    "checks": checks,
    "summary": {"total": total, "passed": passed, "failed": total - passed},
}
out = os.path.join(os.path.dirname(__file__), "verification-ku008.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"{passed}/{total} PASS")
for c in checks:
    print(("PASS" if c["pass"] else "FAIL"), c["id"], c["desc"])
if passed != total:
    raise SystemExit(1)
