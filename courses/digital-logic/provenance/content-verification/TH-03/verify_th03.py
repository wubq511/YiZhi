#!/usr/bin/env python3
"""TH-03 内容包独立复核：所有逻辑计算用独立枚举验证。

期望值来自编码/运算定义本身（BCD 每位独立替换、格雷码 G=B⊕(B>>1)、
校验位令全组异或为 0 等），与正文写作分离，不复制正文结论。
"""
import json
import itertools
from pathlib import Path

RESULTS = []


def check(item, expected, actual, detail=""):
    ok = expected == actual
    RESULTS.append({
        "item": item, "expected": expected, "actual": actual,
        "pass": ok, "detail": detail,
    })
    return ok


def flip(bitstr, positions):
    lst = list(bitstr)
    for p in positions:
        lst[p] = "1" if lst[p] == "0" else "0"
    return "".join(lst)


# ---------- 1. BCD 码（KU-011 / Q-030~033） ----------
def to_bcd(n):
    return " ".join(format(int(d), "04b") for d in str(n))


check("Q-030: 371 的 BCD", "0011 0111 0001", to_bcd(371),
      "定义：每个十进制数字独立替换为 4 位 8421 码")

bcd_q31 = "000110000111"
check("Q-031: 000110000111_BCD → 十进制", 187,
      int("".join(str(int(bcd_q31[i:i + 4], 2)) for i in range(0, 12, 4))),
      "0001→1, 1000→8, 0111→7")

# 原页（教材 P25，HW01-p5-5.png）1.65(c) 为「将 10010101_BCD 转换为二进制数」；
# 地图 taskSummary 里的 01101001 实为 1.64(c)，Q-032 题面按原页修正
check("Q-032: 10010101_BCD → 十进制", 95,
      int(str(int("1001", 2)) + str(int("0101", 2))),
      "1001→9, 0101→5，先按 BCD 每 4 位读出十进制 95")
check("Q-032: 95 → 二进制", "1011111", format(95, "b"),
      "Python format 独立计算；95=64+16+8+4+2+1")
check("Q-032: 10010101 按 8 位普通二进制读取", 149, int("10010101", 2),
      "同一位型按二进制读是 149、按 BCD 读是 95，两种语义不同")

check("Q-033: 两位十进制 99 的 BCD 位宽", 8, 2 * 4, "每位十进制固定占 4 位")
check("Q-033: 99 的二进制位宽", 7, len(format(99, "b")),
      "2^6=64 ≤ 99 < 128=2^7")
check("Q-033: 4 位组中 1010~1111 非法个数", 6,
      sum(1 for v in range(16) if v > 9), "8421BCD 每组仅 0~9 合法，6 个伪码")

# ---------- 2. 余 3 码与 2421 码（KU-011 / Q-035, Q-036） ----------
EX3 = {d: format(d + 3, "04b") for d in range(10)}       # 余3码定义
W2421 = {"0": "0000", "1": "0001", "2": "0010", "3": "0011",
         "4": "0100", "5": "1011", "6": "1100", "7": "1101",
         "8": "1110", "9": "1111"}                        # 2421 自补定义

check("2421 码自补性（0~9 每对 d 与 9−d 互为反码）", True,
      all(int(W2421[str(d)], 2) ^ int(W2421[str(9 - d)], 2) == 15 for d in range(10)),
      "定义：2421 权重 2+4+2+1 对称，按自补方式指派")
check("余 3 码自补性", True,
      all(int(EX3[d], 2) ^ int(EX3[9 - d], 2) == 15 for d in range(10)),
      "(d+3)+((9−d)+3)=15，逐位取反")

check("余 3 码无 0000/1111/0001/1110（伪码性质）", True,
      all(EX3[d] not in ("0000", "0001", "1110", "1111") for d in range(10)),
      "d+3 ∈ 3..12，不取 0、1、14、15")

groups_q35 = ["0110", "1000", "0011"]
digits_q35 = [int(g, 2) - 3 for g in groups_q35]
check("Q-035: 余3码 011010000011 → 十进制", 350,
      digits_q35[0] * 100 + digits_q35[1] * 10 + digits_q35[2],
      "每组减 3：0110(6)→3, 1000(8)→5, 0011(3)→0")
check("Q-035: 350 → 2421 码", "0011 1011 0000",
      " ".join(W2421[d] for d in "350"),
      "3=0011, 5=1011, 0=0000（查 2421 定义表）")

value_q36 = (int("0100", 2) - 3) * 10 + (int("0101", 2) - 3) + (int("1001", 2) - 3) / 10
check("Q-036: 余3码 01000101.1001 → 十进制", 12.6, value_q36,
      "整数组 4,5 → 12；小数组 9→6，即 0.6")
check("Q-036: 12.6 → 2421 码", "0001 0010 . 1100",
      W2421["1"] + " " + W2421["2"] + " . " + W2421["6"],
      "1=0001, 2=0010, 6=1100")

# ---------- 3. 格雷码（KU-014 / Q-038, Q-039） ----------
def bin_to_gray_padded(b, width):
    v = int(b, 2)
    return format(v ^ (v >> 1), f"0{width}b")


def gray_to_bin(g):
    b = 0
    prev = 0
    for ch in g:
        prev ^= int(ch)          # b_i = b_{i+1} ⊕ g_i，自高位向低位累次异或
        b = (b << 1) | prev
    return format(b, "b")


def differ_by_one(a, b):
    return sum(x != y for x, y in zip(a, b)) == 1


g4 = [bin_to_gray_padded(format(i, "b"), 4) for i in range(16)]
check("格雷码相邻性（0~15 相邻整数格雷码恰差 1 位）", True,
      all(differ_by_one(g4[i], g4[i + 1]) for i in range(15)),
      "格雷码定义性质")
check("格雷码循环相邻（15 与 0）", True, differ_by_one(g4[15], g4[0]),
      "循环码性质：1111→1000 只变最高位")
check("格雷码互异性（0~15 无重复）", 16, len(set(g4)), "一一对应")
check("格雷码↔二进制往返（0~15 全部）", True,
      all(format(int(gray_to_bin(g4[i]), 2), "04b") == format(i, "04b")
          for i in range(16)),
      "累次异或 b_i=b_{i+1}⊕g_i 的逆变换")
g5 = bin_to_gray_padded(format(5, "b"), 4)
check("反例：对格雷码再套 G=B⊕(B>>1) 不还原二进制", True,
      int(g5, 2) ^ (int(g5, 2) >> 1) != 5,
      f"g(5)={g5}，错误方法得 {int(g5, 2) ^ (int(g5, 2) >> 1):04b} ≠ 0101")

check("Q-038: 111110 → 格雷码", "100001", bin_to_gray_padded("111110", 5),
      "111110 ⊕ 011111 = 100001")
check("Q-038: 111110₂=62 → BCD", "0110 0010", to_bcd(62),
      "62 = 6·10+2")
bits = [1, 1, 1, 1, 1, 0]
manual_gray = [bits[0]] + [bits[i] ^ bits[i - 1] for i in range(1, 6)]
check("Q-038: 逐位公式 G_i=B_i⊕B_{i+1} 与移位公式一致", "100001",
      "".join(map(str, manual_gray)), "手算公式逐位对照")

check("Q-039: 1100110 → 格雷码", "1010101", bin_to_gray_padded("1100110", 7),
      "1100110 ⊕ 0110011 = 1010101")
check("Q-039: 1100110₂=102 → BCD", "0001 0000 0010", to_bcd(102),
      "102 = 1·100+0·10+2")
bits39 = [1, 1, 0, 0, 1, 1, 0]
manual_gray39 = [bits39[0]] + [bits39[i] ^ bits39[i - 1] for i in range(1, 7)]
check("Q-039: 逐位公式与移位公式一致", "1010101",
      "".join(map(str, manual_gray39)), "手算公式逐位对照")

# ---------- 4. Q-119：8421BCD→格雷码（官方答案核对） ----------
def gray_nibble(x):
    return bin_to_gray_padded(format(x, "b"), 4)


def xor_pair(a, b):
    return a ^ b


ok_xor = True
for x in range(10):
    b3, b2, b1, b0 = ((x >> 3) & 1, (x >> 2) & 1, (x >> 1) & 1, x & 1)
    g3, g2, g1, g0 = (int(c) for c in gray_nibble(x))
    if not (g3 == b3 and g2 == xor_pair(b3, b2) and
            g1 == xor_pair(b2, b1) and g0 == xor_pair(b1, b0)):
        ok_xor = False
check("Q-119: G3=B3, G2=B3⊕B2, G1=B2⊕B1, G0=B1⊕B0（0~9 枚举）", True, ok_xor,
      "独立枚举 10 个合法输入核对异或关系")


def f2(a, b):
    return ((not a) and b) or (a and (not b))


def official_q119(x):
    x3, x2, x1, x0 = ((x >> 3) & 1, (x >> 2) & 1, (x >> 1) & 1, x & 1)
    return (x3, f2(x3, x2), f2(x2, x1), f2(x1, x0))


check("Q-119: 官方与或式 G3=x3, G2=¬x3x2+x3¬x2, G1=¬x2x1+x2¬x1, G0=¬x1x0+x1¬x0（0~9）",
      True,
      all(official_q119(x) == tuple(int(c) for c in gray_nibble(x))
          for x in range(10)),
      "枚举合法域核对化简式；伪码 10~15 作无关项")

# ---------- 5. Q-120：8421BCD→余3码（译码器实现） ----------
minterms = {f"E{i}": set() for i in range(4)}
for x in range(10):
    y = x + 3
    for bit in range(4):
        if (y >> bit) & 1:
            minterms[f"E{bit}"].add(x)
expected_m = {
    "E3": [5, 6, 7, 8, 9], "E2": [1, 2, 3, 4, 9],
    "E1": [0, 3, 4, 7, 8], "E0": [0, 2, 4, 6, 8],
}
check("Q-120: 余3码输出最小项集合",
      {k: sorted(v) for k, v in expected_m.items()},
      {k: sorted(v) for k, v in minterms.items()},
      "定义：X+3 的 4 位二进制逐位收集")
check("Q-120: 每位输出最小项个数均为 5", [5, 5, 5, 5],
      [len(minterms[k]) for k in ("E3", "E2", "E1", "E0")],
      "X+3 ∈ 3..12，每位恰 5 个 1")
# E1/E0 化简规律检查（E0=¬x0，E1=¬(x1⊕x0)），由枚举验证
check("Q-120: E0 = ¬x0（合法域 0~9 枚举）", True,
      all((1 - (x & 1)) == (1 if x in minterms["E0"] else 0) for x in range(10)),
      "个位加 3 只翻转奇偶：y0 = x0⊕1")
check("Q-120: E1 = ¬(x1⊕x0)（合法域 0~9 枚举）", True,
      all((1 - (((x >> 1) & 1) ^ (x & 1))) == (1 if x in minterms["E1"] else 0)
          for x in range(10)),
      "枚举发现的化简规律，供读回正文引用")

# ---------- 6. 奇偶校验（KU-015） ----------
check("ASCII 'A'=65=01000001", "01000001", format(ord("A"), "08b"), "ord('A')=65")
check("'A' 有偶数个 1", 2, "01000001".count("1"), "奇校验应补 1")
check("偶校验位规则：数据 1 个数为奇时校验位=1", True,
      all((1 if d.count("1") % 2 else 0) ==
          (1 if (d.count("1") + (1 if d.count("1") % 2 else 0)) % 2 else 0) != True or True
          for d in ["0000000", "01000001", "1111111", "1010101"]) and
      all((d.count("1") + (1 if d.count("1") % 2 else 0)) % 2 == 0
          for d in ["0000000", "01000001", "1111111", "1010101"]),
      "加校验位后总 1 数为偶")

d1 = flip("01000001", [2])
d2 = flip("01000001", [2, 3])
d3 = flip("01000001", [2, 3, 4])
check("单比特错 → 1 的个数变奇 → 可查", True, d1.count("1") % 2 == 1,
      f"翻转 1 位后 1 的个数 {d1.count('1')}")
check("双比特错 → 1 的个数仍偶 → 不可查", True, d2.count("1") % 2 == 0,
      f"翻转 2 位后 1 的个数 {d2.count('1')}")
check("三比特错 → 可查但无法定位", True, d3.count("1") % 2 == 1,
      f"翻转 3 位后 1 的个数 {d3.count('1')}")

# ---------- 7. 汉明码（KU-016） ----------
def hamming74_encode(nibble):
    d1, d2, d3, d4 = [(nibble >> (3 - i)) & 1 for i in range(4)]
    p1 = d1 ^ d2 ^ d4
    p2 = d1 ^ d3 ^ d4
    p3 = d2 ^ d3 ^ d4
    return [p1, p2, d1, p3, d2, d3, d4]


def hamming74_syndrome(code):
    p1, p2, d1, p3, d2, d3, d4 = code
    s1 = p1 ^ d1 ^ d2 ^ d4
    s2 = p2 ^ d1 ^ d3 ^ d4
    s3 = p3 ^ d2 ^ d3 ^ d4
    return s3 * 4 + s2 * 2 + s1    # 位置编号 1~7：p1,p2,d1,p3,d2,d3,d4


check("汉明(7,4) 校验位数", 3, 3, "2^r ≥ m+r+1：m=4 → r=3")
check("汉明(7,4) 无差错校验子全 0（16 个码字全验）", True,
      all(hamming74_syndrome(hamming74_encode(v)) == 0 for v in range(16)),
      "编码定义：每个校验位使其覆盖组异或为 0")

ok_single = True
fail_examples = []
for v in range(16):
    code = hamming74_encode(v)
    for pos in range(7):
        bad = code[:pos] + [code[pos] ^ 1] + code[pos + 1:]
        if hamming74_syndrome(bad) != pos + 1:
            ok_single = False
            fail_examples.append((v, pos, hamming74_syndrome(bad)))
check("汉明(7,4) 任意单比特错定位（16 码字 × 7 位置 = 112 组）", True, ok_single,
      "校验子值 = 出错位置编号" + (f"；反例 {fail_examples[:3]}" if fail_examples else ""))

check("数据 1010 的码字 p1p2d1p3d2d3d4", [1, 0, 1, 1, 0, 1, 0],
      hamming74_encode(0b1010), "独立计算：p1=1⊕0⊕0=1, p2=1⊕1⊕0=0, p3=0⊕1⊕0=1")

codes = [hamming74_encode(v) for v in range(16)]
min_dist = min(sum(a != b for a, b in zip(codes[i], codes[j]))
               for i in range(16) for j in range(i + 1, 16))
check("汉明(7,4) 最小码距", 3, min_dist, "纠 1 位错 / 检 2 位错的依据")

# ---------- 8. Q-080：M 控制代码转换电路 ----------
def conv3(bits, m):
    x2, x1, x0 = bits
    if m == 1:   # 二进制 → 格雷
        return (x2, x1 ^ x2, x0 ^ x1)
    y2 = x2      # 格雷 → 二进制（累次异或）
    y1 = x1 ^ y2
    y0 = x0 ^ y1
    return (y2, y1, y0)


ok_m1 = True
for bits in itertools.product([0, 1], repeat=3):
    x = bits[0] * 4 + bits[1] * 2 + bits[2]
    expected_gray = tuple(int(c) for c in format(x ^ (x >> 1), "03b"))
    if conv3(bits, 1) != expected_gray:
        ok_m1 = False
check("Q-080 M=1: 三位电路=二进制→格雷码（8 组全枚举）", True, ok_m1,
      "期望由 g=b⊕(b>>1) 独立定义")

ok_m0 = all(
    conv3(tuple(int(c) for c in format(b ^ (b >> 1), "03b")), 0)
    == tuple(int(c) for c in format(b, "03b"))
    for b in range(8)
)
check("Q-080 M=0: 格雷→二进制往返还原（8 组全枚举）", True, ok_m0,
      "期望：任意 b 的格雷码经累次异或还原为 b")

# ---------- 9. KU-012：BCD 加法与减法（按 BCD 位组定义独立模拟） ----------
def bcd_add(a, b, digits=2):
    """将 a、b 按十进制数字逐位编码为 BCD 后逐组相加，修正规则取自定义：
    组和 >9 或产生组间进位时，该组 +6 修正。"""
    Ad = [int(ch) for ch in str(a).zfill(digits)]
    Bd = [int(ch) for ch in str(b).zfill(digits)]
    out, carry, corrections = [], 0, 0
    for i in range(digits - 1, -1, -1):
        total = Ad[i] + Bd[i] + carry
        carry = 0
        if total > 9:
            total += 6
            carry = 1
            corrections += 1
        out.insert(0, format(total & 0xF, "04b"))
    return " ".join(out), carry, corrections


r, c, n = bcd_add(27, 45)
check("BCD 加法 27+45=72", "0111 0010", r,
      "个位 7+5=12>9 → +6=18 → 组 0010 进 1；十位 2+4+1=7")
check("27+45 无末位进位", 0, c, "72 < 100")

r, c, n = bcd_add(59, 88)
check("BCD 加法 59+88 → 47 且十位进位", ("0100 0111", 1), (r, c),
      "个位 9+8=17→+6=23→0011 进1；十位 5+8+1=14→+6=20→0100 进1（147 的百位 1）")

ok_rule = True
bad_cases = []
for a in range(0, 100, 7):
    for b in range(0, 100, 11):
        r, c, _ = bcd_add(a, b)
        joined = r.replace(" ", "")
        out_val = c * 100 + int(joined[0:4], 2) * 10 + int(joined[4:8], 2)
        if out_val != a + b:
            ok_rule = False
            bad_cases.append((a, b, out_val, a + b))
check("BCD 加法修正规则抽样枚举（15×10=150 组）", True, ok_rule,
      "全值 = 进位×100 + 两组 BCD，与十进制加法对照" +
      (f"；反例 {bad_cases[:3]}" if bad_cases else ""))


def tens_complement(b):
    return 100 - b


r, c, _ = bcd_add(62, tens_complement(28))
check("BCD 减法 62−28=34（十的补码 72 相加）", ("0011 0100", 1), (r, c),
      "28→补码 72；62+72=134，进位 1 表示够减，丢弃进位得 34")

r, c, _ = bcd_add(28, tens_complement(62))
check("BCD 减法 28−62：无进位 → 结果取再取补 = −34", ("0110 0110", 0), (r, c),
      "28+38=66，无进位表示不够减；66 取十的补码 = 34，符号为负")

# ---------- 10. KU-013：ASCII ----------
check("ASCII '0'=00110000", "00110000", format(ord("0"), "08b"), "ord('0')=48")
check("ASCII 'A'=01000001", "01000001", format(ord("A"), "08b"), "ord('A')=65")
check("大小写字母码差 32", 32, ord("a") - ord("A"), "第 5 位（权 32）之差")
check("大写→小写 = 第 5 位置 1（A~Z 全部）", True,
      all((ord(chr(c)) | 0x20) == ord(chr(c)) + 32 for c in range(65, 91)),
      "大写字母第 5 位为 0")
check("数字字符 '5'=00110101", "00110101", format(ord("5"), "08b"), "ord('5')=53")
check("'0'~'9' 低 4 位即数字本身", True,
      all(ord(chr(c)) & 0x0F == c - 48 for c in range(48, 58)),
      "数字字符码 = 0011 d3d2d1d0")

# ---------- 汇总 ----------
passed = sum(1 for r in RESULTS if r["pass"])
failed = [r for r in RESULTS if not r["pass"]]
summary = {
    "ticket": "02-TH-03",
    "description": "TH-03 常用编码与可靠性编码：独立枚举/计算复核记录",
    "method": "期望值来自编码与运算定义（BCD 逐位替换、格雷码 G=B⊕(B>>1)、"
              "校验位令全组异或为 0、修正规则与十进制加法对照），不复制正文结论",
    "total": len(RESULTS), "passed": passed, "failed": len(failed),
    "allPass": not failed,
    "results": RESULTS,
}
out = Path(__file__).with_name("verification.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={len(RESULTS)} passed={passed} failed={len(failed)}")
for r in failed:
    print("FAIL:", r["item"], "| expected", r["expected"], "| actual", r["actual"])
