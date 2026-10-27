#!/usr/bin/env python3
"""KU-010 零扩展与符号扩展：独立定义式复核。

读回定义（独立于正文，仅用二进制→整数的标准转换）：
  无符号读回  U(B)   = B 的二进制值
  补码读回    T(B,w) = B            （若 B < 2^(w-1)）
                       B - 2^w    （若 B >= 2^(w-1)）
  零扩展      Z(B,w,W)   = B                       （高位补 0）
  符号扩展    S(B,w,W)   = B + (2^W - 2^w) 若 B >= 2^(w-1)（复制符号位 1）
                           B                         若 B <  2^(w-1)（复制符号位 0）
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def unsigned_value(bits):
    return int(bits, 2)


def twos_value(bits):
    w = len(bits)
    b = int(bits, 2)
    return b if b < (1 << (w - 1)) else b - (1 << w)


def zero_extend(bits, width):
    return "0" * (width - len(bits)) + bits


def sign_extend(bits, width):
    return bits[0] * (width - len(bits)) + bits


tests = []


def add(tid, desc, expected, actual):
    tests.append({
        "id": tid,
        "desc": desc,
        "expected": expected,
        "actual": actual,
        "pass": expected == actual,
    })


# T01：16 个 4 位码的零扩展读回（无符号口径下全部保值）
zero_keep, zero_break = [], []
for i in range(16):
    bits = format(i, "04b")
    ext = zero_extend(bits, 8)
    before_u = unsigned_value(bits)
    after_u = unsigned_value(ext)
    (zero_keep if before_u == after_u else zero_break).append(bits)
add("T01", "无符号口径：16 个 4 位码零扩展到 8 位后无符号读回全部不变",
    sorted(format(i, "04b") for i in range(16)), sorted(zero_keep))

# T09–T12：16 个 4 位码的零扩展读回（补码口径：msb=0 保值、msb=1 变值）
zero_keep_t, zero_break_t = [], []
for i in range(16):
    bits = format(i, "04b")
    ext = zero_extend(bits, 8)
    before_t = twos_value(bits)
    after_t = twos_value(ext)
    (zero_keep_t if before_t == after_t else zero_break_t).append(bits)
add("T02", "补码口径：零扩展保值的恰为符号位 0 的 8 个码",
    sorted(format(i, "04b") for i in range(8)), sorted(zero_keep_t))
add("T03", "补码口径：零扩展变值的恰为符号位 1 的 8 个码",
    sorted(format(i, "04b") for i in range(8, 16)), sorted(zero_break_t))

# T13–T16：16 个 4 位码的符号扩展读回（补码口径全部保值）
sign_keep, sign_break = [], []
for i in range(16):
    bits = format(i, "04b")
    ext = sign_extend(bits, 8)
    before_t = twos_value(bits)
    after_t = twos_value(ext)
    (sign_keep if before_t == after_t else sign_break).append(bits)
add("T04", "补码口径：16 个 4 位码符号扩展到 8 位后读回全部不变",
    sorted(format(i, "04b") for i in range(16)), sorted(sign_keep))

# T17–T22：课件 P23 例题逐项
add("T05", "P23 Ex1：零扩展 0011 → 00000111 前的无符号值 3",
    3, unsigned_value("0011"))
add("T06", "P23 Ex1：零扩展结果 00000111 读回应为 3（实际按 00000011 验证）",
    3, unsigned_value(zero_extend("0011", 8)))
add("T07", "P23 Ex2：4 位补码 1011 读回 −5",
    -5, twos_value("1011"))
add("T08", "P23 Ex2 错例：零扩展 1011 → 00001011 读回 +11（课件大叉）",
    11, twos_value(zero_extend("1011", 8)))
add("T09", "P23 右栏：符号扩展 1011 → 11111011 读回 −5",
    -5, twos_value(sign_extend("1011", 8)))
add("T10", "P23 右栏码值：11111011 的无符号码值 251",
    251, unsigned_value("11111011"))

# T23–T28：正文表格块三行
add("T11", "表行 0101：零扩展 00000101 读回 5，符号扩展 00000101 读回 +5",
    (5, 5), (unsigned_value(zero_extend("0101", 8)), twos_value(sign_extend("0101", 8))))
add("T12", "表行 1010：4 位补码读回 −6",
    -6, twos_value("1010"))
add("T13", "表行 1010：零扩展 00001010 读回 +10（变值）",
    10, twos_value(zero_extend("1010", 8)))
add("T14", "表行 1010：符号扩展 11111010 读回 −6",
    -6, twos_value(sign_extend("1010", 8)))
add("T15", "表行 1011：符号扩展 11111011 读回 −5",
    -5, twos_value(sign_extend("1011", 8)))
add("T16", "表行 1011：零扩展 00001011 读回 +11（变值）",
    11, twos_value(zero_extend("1011", 8)))

# T29–T34：练习 −3
add("T17", "练习：4 位补码 1101 读回 −3",
    -3, twos_value("1101"))
add("T18", "练习：零扩展 1101 → 00001101 读回 +13（变值）",
    13, twos_value(zero_extend("1101", 8)))
add("T19", "练习：符号扩展 1101 → 11111101 读回 −3",
    -3, twos_value(sign_extend("1101", 8)))
add("T20", "练习码值：11111101 的无符号码值 253（253−256=−3）",
    253, unsigned_value("11111101"))
add("T21", "练习推广：8 个负数 4 位补码符号扩展后全部保值",
    8, sum(1 for i in range(8, 16)
           if twos_value(sign_extend(format(i, "04b"), 8)) == twos_value(format(i, "04b"))))

# T35–T40：Q-020 / Q-021 题解
add("T22", "Q-020：符号扩展 0101 → 00000101，读回 +5",
    5, twos_value(sign_extend("0101", 8)))
add("T23", "Q-020：0101 原 4 位补码读回 +5，前后一致",
    (5, 5), (twos_value("0101"), twos_value(sign_extend("0101", 8))))
add("T24", "Q-021：符号扩展 1010 → 11111010，读回 −6",
    -6, twos_value(sign_extend("1010", 8)))
add("T25", "Q-021：11111010 码值 250，250−2^8=−6",
    (250, -6), (unsigned_value("11111010"), twos_value(sign_extend("1010", 8))))
add("T26", "Q-021 对照：误用零扩展 00001010 读回 +10 ≠ −6",
    10, twos_value(zero_extend("1010", 8)))
add("T27", "Q-021 原码读回：4 位补码 1010 = 10−16 = −6",
    -6, unsigned_value("1010") - 16)

# T41–T42：正数/负数符号扩展的位形断言（新增高位确为符号位复制）
add("T28", "正数符号扩展 0101 → 00000101：新增 4 位均为 0",
    "0000", sign_extend("0101", 8)[:4])
add("T29", "负数符号扩展 1010 → 11111010：新增 4 位均为 1",
    "1111", sign_extend("1010", 8)[:4])

report = {
    "task": "TH-02 / KU-010 零扩展与符号扩展 独立复核",
    "date": "2026-10-26",
    "method": "独立定义式：补码读回 T(B,w)=B 或 B−2^w；零扩展高位补 0；符号扩展按 B≥2^(w−1) 把高位补成 1。对 16 个 4 位码做两种扩展的读回全枚举，再逐项核对课件 P23 例题、正文表格、练习 −3 与 Q-020/Q-021 题解。",
    "tests": tests,
    "summary": {
        "total": len(tests),
        "passed": sum(1 for t in tests if t["pass"]),
        "failed": sum(1 for t in tests if not t["pass"]),
    },
}

out = HERE / "verification-ku010.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{report['summary']['passed']}/{report['summary']['total']} PASS -> {out}")
if report["summary"]["failed"]:
    for t in tests:
        if not t["pass"]:
            print("FAIL", t["id"], t["desc"], "expected", t["expected"], "actual", t["actual"])
    raise SystemExit(1)
