#!/usr/bin/env python3
"""独立复核 KU-012 正文中的 BCD 加减计算。

期望值来自普通十进制算术定义，不读取正文 JSON，也不把正文答案复制为 expected。
"""
import json
from pathlib import Path


def bcd_digit_add(a: int, b: int, carry_in: int = 0):
    raw = a + b + carry_in
    if raw > 9:
        corrected = raw + 6
        carry_out = corrected >> 4
        digit = corrected & 0xF
    else:
        corrected = raw
        carry_out = 0
        digit = raw
    return raw, corrected, digit, carry_out


def bcd_add(a: int, b: int, width: int):
    ad = [int(c) for c in str(a).zfill(width)]
    bd = [int(c) for c in str(b).zfill(width)]
    outs = [0] * width
    carry = 0
    stages = []
    for i in range(width - 1, -1, -1):
        raw, corrected, digit, carry = bcd_digit_add(ad[i], bd[i], carry)
        outs[i] = digit
        stages.append({
            "column_index": i,
            "digits": (ad[i], bd[i], carry),
            "raw": raw,
            "corrected": corrected,
            "digit": digit,
            "carry_out": carry,
        })
    value = 0
    for d in outs:
        value = value * 10 + d
    if carry:
        value += 10**width
    return value, outs, carry, stages


def tens_complement(n: int, width: int):
    return 10**width - n


results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({
        "item": item,
        "expected": expected,
        "actual": actual,
        "pass": ok,
        "detail": detail,
    })
    return ok


# 课件 P49 例：295 + 635
value, outs, carry, stages = bcd_add(295, 635, 3)
check("课件例 295+635 = 930", 930, value, "普通十进制加法对照")
check("295+635 三列结果 BCD 位串", ["1001", "0011", "0000"],
      [format(d, "04b") for d in outs],
      "每列独立按 S>9 时加 6，得到 9/3/0")
check("295+635 最终无百位以上额外进位", 0, carry, "结果仍为三位十进制数")

# 课件 P50 例：+257 + (−160)
comp = tens_complement(160, 3)
check("160 的三位十的补 = 840", 840, comp, "定义 10^3−160")
value, outs, carry, stages = bcd_add(257, comp, 3)
masked = value - 1000 if carry else value
check("+257−160 补码相加后的三位数值", 97,
      masked, "257+840=1097，十进制补码加法中最高位进位 1 丢弃后为 097")
check("补码相加产生最高位进位", 1, carry, "1097 的百位以上进位为 1，表示够减")

# 练习 47+58
value, outs, carry, stages = bcd_add(47, 58, 2)
check("练习 47+58 = 105", 105, value, "普通十进制加法对照")
check("47+58 各列十进制结果", [1, 0, 5], [carry] + outs, "百位进位 1、十位 0、个位 5")
check("47+58 个位 raw>9", True, stages[0]["raw"] > 9, "7+8=15，需要加 6")
check("47+58 十位已有进位且 raw=10", True, stages[1]["raw"] == 10 and stages[1]["carry_out"] == 1,
      "4+5+1=10，需要加 6")

# 练习 83−29
comp = tens_complement(29, 3)
check("29 的三位十的补 = 971", 971, comp, "定义 1000−29")
value, outs, carry, stages = bcd_add(83, comp, 3)
masked = value - 1000 if carry else value
check("83−29 补码相加后的三位数值", 54, masked, "83+971=1054，最高位进位丢弃后为 054")
check("83−29 产生最高位进位", 1, carry, "进位为 1 表示够减")

# BCD 与普通二进制读法边界
check("01000111 按普通二进制读 = 71", 71, int("01000111", 2),
      "同一位型按二进制读与按 BCD 读不同")
check("01000111 按 BCD 读 = 47", 47, int("0100", 2) * 10 + int("0111", 2),
      "每 4 位一组独立读十进制数字")

summary = {
    "ticket": "02-TH-03",
    "unitId": "KU-012",
    "method": "独立十进制加法/补码定义计算，不读取正文答案，不把正文文本作为期望值",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-012.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
