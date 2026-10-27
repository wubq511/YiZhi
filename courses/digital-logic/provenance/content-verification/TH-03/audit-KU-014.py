#!/usr/bin/env python3
"""独立复核 KU-014 的格雷码转换、相邻性与例题/练习结果。"""
import itertools
import json
from pathlib import Path

results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({"item": item, "expected": expected, "actual": actual, "pass": ok, "detail": detail})
    return ok


def to_gray(bits):
    b = int(bits, 2)
    return format(b ^ (b >> 1), f"0{len(bits)}b")


def gray_to_bin(gray):
    b = 0
    carry = 0
    for ch in gray:
        carry ^= int(ch)
        b = (b << 1) | carry
    return format(b, f"0{len(gray)}b")


def hamming(a, b):
    return sum(x != y for x, y in zip(a, b))


g4 = [to_gray(format(i, "04b")) for i in range(16)]
check("4 位格雷码 0–15 无重复", 16, len(set(g4)), "一一映射")
check("相邻格雷码恰差 1 位", True, all(hamming(g4[i], g4[i + 1]) == 1 for i in range(15)),
      "定义性质")
check("循环相邻 15→0", True, hamming(g4[15], g4[0]) == 1, "1111→1000")
check("格雷码↔二进制往返 0–15", True,
      all(gray_to_bin(g4[i]) == format(i, "04b") for i in range(16)),
      "双向公式互逆")

check("0101→格雷码 0111", "0111", to_gray("0101"), "G=B⊕(B>>1)")
check("0111 格雷码→二进制 0101", "0101", gray_to_bin("0111"), "累次异或还原")

check("Q-038: 111110₂=62", 62, int("111110", 2), "按权展开")
check("Q-038: 62 的格雷码 100001", "100001", to_gray("111110"), "移位异或")
check("Q-038: 62 的 8421 码 0110 0010", "01100010",
      "".join(format(int(d), "04b") for d in str(62)), "逐位十进制编码")

check("Q-039: 1100110₂=102", 102, int("1100110", 2), "按权展开")
check("Q-039: 102 的格雷码 1010101", "1010101", to_gray("1100110"), "移位异或")
check("Q-039: 102 的 8421 码 0001 0000 0010", "000100000010",
      "".join(format(int(d), "04b") for d in str(102)), "逐位十进制编码")

check("4→5 格雷码只变 1 位", 1, hamming(g4[4], g4[5]), "0110→0111")
check("5→6 格雷码只变 1 位", 1, hamming(g4[5], g4[6]), "0111→0101")

# Q-080：M=1 二进制→格雷，M=0 格雷→二进制
def m1(bits):
    x = int("".join(map(str, bits)), 2)
    return tuple(int(c) for c in format(x ^ (x >> 1), "03b"))


def m0(bits):
    y = int("".join(map(str, bits)), 2)
    b2 = (y >> 2) & 1
    b1 = b2 ^ ((y >> 1) & 1)
    b0 = b1 ^ (y & 1)
    return (b2, b1, b0)


ok1 = all(m1(bits) == tuple(int(c) for c in format(int("".join(map(str, bits)), 2) ^ (int("".join(map(str, bits)), 2) >> 1), "03b"))
          for bits in itertools.product([0, 1], repeat=3))
check("Q-080: M=1 三位二进制→格雷码", True, ok1, "8 组全枚举")
ok0 = all(m0(tuple(int(c) for c in format(b ^ (b >> 1), "03b"))) == tuple(int(c) for c in format(b, "03b"))
          for b in range(8))
check("Q-080: M=0 三位格雷码→二进制往返", True, ok0, "8 组全枚举")

# Q-119：8421→格雷码合法域
ok119 = True
for x in range(10):
    b3, b2, b1, b0 = [(x >> k) & 1 for k in (3, 2, 1, 0)]
    g = tuple(int(c) for c in format(x ^ (x >> 1), "04b"))
    expected = (b3, b3 ^ b2, b2 ^ b1, b1 ^ b0)
    if g != expected:
        ok119 = False
check("Q-119: G3=B3,G2=B3⊕B2,G1=B2⊕B1,G0=B1⊕B0（0–9）", True, ok119, "合法域枚举")

summary = {
    "ticket": "02-TH-03",
    "unitId": "KU-014",
    "method": "独立格雷码定义与枚举计算，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-014.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
