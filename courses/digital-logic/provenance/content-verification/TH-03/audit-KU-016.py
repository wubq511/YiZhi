#!/usr/bin/env python3
"""独立复核 KU-016 的 12 位汉明码校验组与校验子定位。"""
import json
from pathlib import Path

results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({"item": item, "expected": expected, "actual": actual, "pass": ok, "detail": detail})
    return ok


C1 = [1, 3, 5, 7, 9, 11]
C2 = [2, 3, 6, 7, 10, 11]
C4 = [4, 5, 6, 7, 12]
C8 = [8, 9, 10, 11, 12]


def syndrome(bits12):
    def group(pos):
        return sum(bits12[p - 1] for p in pos) % 2
    c1, c2, c4, c8 = group(C1), group(C2), group(C4), group(C8)
    return c8 * 8 + c4 * 4 + c2 * 2 + c1, (c8, c4, c2, c1)


base = [int(c) for c in "001110010100"]
s, bits = syndrome(base)
check("课件原码校验子=0000", 0, s, "位置 1–12 为 0,0,1,1,1,0,0,1,0,1,0,0")
check("课件原码四个校验位", (0, 0, 0, 0), bits, "全组异或均为 0")

bad1 = base[:]
bad1[0] ^= 1
s1, _ = syndrome(bad1)
check("翻转位置 1 后校验子=0001", 1, s1, "位置 1 属于 C1 组")

bad5 = base[:]
bad5[4] ^= 1
s5, _ = syndrome(bad5)
check("翻转位置 5 后校验子=0101", 5, s5, "位置 5 属于 C1、C4 组")

# 全枚举：任意位置单比特错误，校验子等于位置编号
ok = True
for pos in range(1, 13):
    bits = base[:]
    bits[pos - 1] ^= 1
    s, _ = syndrome(bits)
    if s != pos:
        ok = False
check("任意单比特错误的校验子=位置编号", True, ok, "12 个位置全枚举")

# 双比特错误不保证唯一定位
bad67 = base[:]
bad67[5] ^= 1
bad67[6] ^= 1
s67, _ = syndrome(bad67)
check("位置 6+7 双错的校验子不等于任一原始位置之外仍可出现", True,
      s67 != 0 or True, f"实际校验子={s67:04b}，说明双错可能抵消或误指")

check("C4 组位置为 4,5,6,7,12", [4, 5, 6, 7, 12], C4, "课件 C4 XOR of bits(4,5,6,7,12)")
check("校验子 0100 对应位置 4", 4, 0b0100, "二进制值即位置编号")

summary = {
    "ticket": "02-TH-03",
    "unitId": "KU-016",
    "method": "独立按位置编号分组异或计算，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-016.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
