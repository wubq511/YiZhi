#!/usr/bin/env python3
"""独立复核 KU-015 的奇偶校验位与检错边界。"""
import json
from pathlib import Path

results = []


def check(item, expected, actual, detail):
    ok = expected == actual
    results.append({"item": item, "expected": expected, "actual": actual, "pass": ok, "detail": detail})
    return ok


def parity(data, odd=False):
    ones = data.count("1")
    if odd:
        return "0" if ones % 2 else "1"
    return "1" if ones % 2 else "0"


def check_group(code, odd=False):
    return code.count("1") % 2 == (1 if odd else 0)


check("1001 偶校验 P=0", "0", parity("1001"), "偶数个 1，偶校验补 0")
check("1001 奇校验 P=1", "1", parity("1001", odd=True), "奇数个 1 需补 1")
check("1001 偶校验 5 位码", "01001", parity("1001") + "1001", "P 在最左")
check("1001 奇校验 5 位码", "11001", parity("1001", odd=True) + "1001", "P 在最左")
check("0110 偶校验 5 位码", "00110", parity("0110") + "0110", "2 个 1，P=0")
check("0110 奇校验 5 位码", "10110", parity("0110", odd=True) + "0110", "需 P=1")
check("1111 偶校验 5 位码", "01111", parity("1111") + "1111", "4 个 1，P=0")

code = "010001"
single = code[:2] + ("1" if code[2] == "0" else "0") + code[3:]
double = single[:1] + ("1" if single[1] == "0" else "0") + single[2:]
check("偶校验：1 位翻转后不通过", False, check_group(single), "奇数个错误改变奇偶性")
check("偶校验：2 位翻转后通过", True, check_group(double), "偶数个错误不改变奇偶性")

# 通用枚举：4 位数据 + P，偶校验
for_bad = []
for d in range(16):
    data = format(d, "04b")
    code = parity(data) + data
    for i in range(5):
        bad = code[:i] + ("1" if code[i] == "0" else "0") + code[i + 1:]
        if not check_group(bad):
            pass
        else:
            for_bad.append((d, i))
check("任意 4 位数据的单比特错误均被偶校验发现", [], for_bad,
      "对 16×5=80 种单比特错误全枚举，均应报错")

double_bad_undetected = 0
for d in range(16):
    data = format(d, "04b")
    code = parity(data) + data
    for i in range(5):
        for j in range(i + 1, 5):
            bad = list(code)
            for k in (i, j):
                bad[k] = "1" if bad[k] == "0" else "0"
            if check_group("".join(bad)):
                double_bad_undetected += 1
check("任意 2 位错误均不被偶校验发现", 160, double_bad_undetected,
      "16 个数据 × C(5,2)=10 种双错，全部通过偶校验")

summary = {
    "ticket": "02-TH-03",
    "unitId": "KU-015",
    "method": "独立奇偶计数与全枚举，不读取正文 JSON",
    "total": len(results),
    "passed": sum(1 for r in results if r["pass"]),
    "failed": sum(1 for r in results if not r["pass"]),
    "allPass": all(r["pass"] for r in results),
    "results": results,
}
out = Path(__file__).with_name("audit-KU-015.json")
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"total={summary['total']} passed={summary['passed']} failed={summary['failed']}")
for r in results:
    if not r["pass"]:
        print("FAIL", r)
