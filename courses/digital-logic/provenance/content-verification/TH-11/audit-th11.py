#!/usr/bin/env python3
import itertools
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
checks = []


def check(name, actual, expected):
    assert actual == expected, f"{name}: actual={actual!r}, expected={expected!r}"
    checks.append({"name": name, "pass": True, "actual": actual, "expected": expected})


def bits(value, width=4):
    return [(value >> i) & 1 for i in range(width - 1, -1, -1)]


# KU-045: direct conversion examples.
for a, b, c in itertools.product(range(2), repeat=3):
    direct = (a and b) or (a and c) or (b and c)
    minterms = (not a and b and c) or (a and not b and c) or (a and b and not c) or (a and b and c)
    check(f"majority direct ABC={a}{b}{c}", int(direct), int(a + b + c >= 2))
    check(f"majority minterms ABC={a}{b}{c}", int(minterms), int(a + b + c >= 2))

for x1, x2, y1, y2 in itertools.product(range(2), repeat=4):
    x = 2 * x1 + x2
    y = 2 * y1 + y2
    direct = (x1 and x2 and y1 and not y2) or (x1 and not y1) or ((not x1) and x2 and not y1 and not y2)
    check(f"X>Y x1x2={x1}{x2}, y1y2={y1}{y2}", int(direct), int(x > y))

for a, b, c, m, n in itertools.product(range(2), repeat=5):
    direct = a and b and ((m and n) or (not m))
    seats = a and b and ((m and n) or not m) and ((n) or (not m))
    check(f"takeoff ABCMn={a}{b}{c}{m}{n}", int(direct), int(seats))

for a, b, c in itertools.product(range(2), repeat=3):
    check(f"gear active-low ABC={a}{b}{c}", int((not a) and (not b) and (not c)), int(a + b + c == 0))
    check(f"gear alarm ABC={a}{b}{c}", int(a or b or c), int(a + b + c > 0))

for a, b, c in itertools.product(range(2), repeat=3):
    x = int(a and b and not c) or int(a and not b and c) or int(not a and b and c)
    check(f"exactly-two ABC={a}{b}{c}", x, int(a + b + c == 2))

# KU-046: don't-care simplifications and the existing derived round-half-up expression.
for value in range(16):
    a, b, c, d = bits(value)
    required = int(value >= 5) if value < 10 else None
    simplified = int(bool(a or (b and c) or (b and d)))
    published = int(bool(a or (b and (c or d))))
    if required is not None:
        check(f"round valid BCD={value:04b}", simplified, required)
        check(f"Q-082 published valid BCD={value:04b}", published, required)
check("round don't-cares accepted as 1", [int(bool(10 <= v and (bits(v)[0] or (bits(v)[1] and (bits(v)[2] or bits(v)[3]))))) for v in range(10, 16)], [1] * 6)

# KU-047: both code-conversion routes.
for value in range(10):
    a, b, c, d = bits(value)
    excess = value + 3
    w, x, y, z = bits(excess)
    check(f"excess-3 BCD={value:04b}", (int(bool(a or (b and c) or (b and d))),
                                         int(bool((not b and c) or (not b and d) or (b and not c and not d))),
                                         int(bool((c and d) or (not c and not d))),
                                         int(not d)), (w, x, y, z))

for value in range(16):
    b3, b2, b1, b0 = bits(value)
    g3, g2, g1, g0 = b3, b3 ^ b2, b2 ^ b1, b1 ^ b0
    check(f"8421-to-gray B3B2B1B0={b3}{b2}{b1}{b0}", (g3, g2, g1, g0),
          (b3, int(bin(value)[2:].count("1") % 2 == 0 and False or (b3 != b2)), b2 != b1, b1 != b0))

for value in range(16):
    d3, d2, d1, d0 = bits(value)
    a, b, c, a0 = d0, d1, d2, d3  # EX07 uses decoder address A,B,C,D = LSB..MSB.
    def sel(*indices):
        return int(value in indices)
    wxyx = (sel(5, 6, 7, 8, 9), sel(1, 2, 3, 4, 9), sel(0, 3, 4, 7, 8), sel(0, 2, 4, 6, 8))
    check(f"BCD-to-excess3 decoder DCBA={value:04b}", wxyx,
          tuple(bits(value + 3)) if value < 10 else wxyx)

# KU-048: equality comparator.
for value_a in range(16):
    for value_b in range(16):
        unequal = 0
        for bit in range(4):
            ai, bi = (value_a >> bit) & 1, (value_b >> bit) & 1
            unequal |= int(ai != bi)
        check(f"equality A={value_a:04b}, B={value_b:04b}", int(not unequal), int(value_a == value_b))

# KU-050: valid 8421-BCD addition and its two-stage correction.
for a in range(10):
    for b in range(10):
        for carry_in in (0, 1):
            binary = a + b + carry_in
            binary_sum = binary & 15
            k = int(binary > 15)
            z8, z4, z2, z1 = bits(binary_sum)
            correction = int(bool(k or (z8 and z4) or (z8 and z2)))
            stage2 = (binary_sum + 6) & 15 if correction else binary_sum
            expected_carry = int(binary > 9)
            expected_sum = binary - 10 if binary > 9 else binary
            check(f"BCD add A={a},B={b},Cin={carry_in}", (correction, stage2, expected_carry),
                  (expected_carry, expected_sum, expected_carry))

report = {
    "allPassed": True,
    "count": len(checks),
    "note": "独立枚举文字条件、卡诺图无关项结果、码变换真值表、比较器和两级 BCD 加法；期望由定义/算术规则生成，不从正文复制。",
    "checks": checks,
}
(BASE / "audit-th11.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"allPassed": True, "count": len(checks)}, ensure_ascii=False))
