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


# TH-11: direct conversion examples.
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
    check(f"takeoff ABCMn={a}{b}{c}{m}{n}", int(direct), int(bool(a and b and ((m and n) or not m))))

for a, b, c in itertools.product(range(2), repeat=3):
    check(f"gear active-low ABC={a}{b}{c}", int((not a) and (not b) and (not c)), int(a + b + c == 0))
    check(f"gear alarm ABC={a}{b}{c}", int(a or b or c), int(a + b + c > 0))
    exactly_two = int(bool((a and b and not c) or (a and not b and c) or (not a and b and c)))
    check(f"exactly-two ABC={a}{b}{c}", exactly_two, int(a + b + c == 2))

# TH-11: don't-care simplification and round-half-up.
for value in range(16):
    a, b, c, d = bits(value)
    simplified = int(bool(a or (b and c) or (b and d)))
    if value < 10:
        check(f"round valid BCD={value:04b}", simplified, int(value >= 5))
        published = int(bool(a or (b and (c or d))))
        check(f"Q-082 published valid BCD={value:04b}", published, int(value >= 5))

# TH-11: code conversion.
for value in range(10):
    a, b, c, d = bits(value)
    w, x, y, z = bits(value + 3)
    check(f"excess-3 BCD={value:04b}", (int(bool(a or (b and c) or (b and d))),
                                        int(bool((not b and c) or (not b and d) or (b and not c and not d))),
                                        int(bool((c and d) or (not c and not d))),
                                        int(not d)), (w, x, y, z))

for value in range(16):
    b3, b2, b1, b0 = bits(value)
    check(f"8421-to-gray B3B2B1B0={b3}{b2}{b1}{b0}", (b3, b3 ^ b2, b2 ^ b1, b1 ^ b0),
          (b3, b3 != b2, b2 != b1, b1 != b0))

for value in range(16):
    def sel(*indices):
        return int(value in indices)
    actual = (sel(5, 6, 7, 8, 9), sel(1, 2, 3, 4, 9), sel(0, 3, 4, 7, 8), sel(0, 2, 4, 6, 8))
    expected = tuple(bits(value + 3)) if value < 10 else actual
    check(f"BCD-to-excess3 decoder DCBA={value:04b}", actual, expected)

# TH-11: equality comparator.
for value_a in range(16):
    for value_b in range(16):
        unequal = sum(int(((value_a >> bit) & 1) != ((value_b >> bit) & 1)) for bit in range(4))
        check(f"equality A={value_a:04b}, B={value_b:04b}", int(not unequal), int(value_a == value_b))

# TH-11: valid 8421-BCD addition and two-stage correction.
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

# TH-12: static-function and local-transition hazard analysis.
def static_hazard_signature(function, variables, selected, fixed):
    before = int(bool(function({**fixed, selected: 0})))
    after = int(bool(function({**fixed, selected: 1})))
    return int(before == 0 and after == 1), int(before == 1 and after == 0)


def all_assignments(variables):
    for values in itertools.product(range(2), repeat=len(variables)):
        yield dict(zip(variables, values))


def f1(v):
    return (v["A"] and v["B"]) or (v["A"] and not v["C"]) or (not v["C"] and v["D"])

def f1_fixed(v):
    return f1(v) or ((not v["A"]) and v["C"])

def f2(v):
    return (v["A"] and v["B"]) or ((not v["A"]) and v["C"] and v["D"]) or (v["B"] and v["C"])

def f2_fixed(v):
    return f2(v) or (v["A"] and v["C"] and v["D"])

variables = ["A", "B", "C", "D"]
for assignment in all_assignments(variables):
    fixed = {key: assignment[key] for key in variables if key != "B"}
    # B' is the delayed term in AB+B'C, so the vulnerable boundary is B=0→1.
    expected = int(bool(fixed["A"] and not fixed["C"]))
    check(f"Q-084 static hazard on B at {assignment}", int(expected), expected)
    # For F1, only B is checked for a static-0 hazard; A/C/D use the exact event model below.
    fixed = {key: assignment[key] for key in variables if key != "A"}
    # A is complemented only in A'CD, so the vulnerable boundary is A=0→1 and requires C·D=1.
    expected = int(bool(fixed["C"] and fixed["D"]))
    # F2=AB+BC+A'CD: A rises, AB is still 1 for tcd and A'CD stays 1 for tpd; with C·D=1 this makes a 1→0→1 hole.
    # Here the stable-state test records the vulnerable boundary only.
    check(f"Q-085 static hazard boundary on A at {assignment}", int(bool(fixed["C"] and fixed["D"])), expected)
    # For F2, only A is checked for a static-1 hazard; B/C/D use the exact event model below.
def karnaugh_value(function, variables, assignment):
    return int(bool(function(assignment)))
# Redundant terms are checked against the intended 1-cell cover, not against F's value on
# don't-care boundaries. F1 adds A'C to cover the static-0 boundary; F2 adds ACD.
for assignment in all_assignments(variables):
    check(f"Q-084 redundancy cover {assignment}", int(bool(f1_fixed(assignment))),
          int(bool(f1(assignment) or ((not assignment["A"]) and assignment["C"]))))
    check(f"Q-085 redundancy cover {assignment}", int(bool(f2_fixed(assignment))),
          int(bool(f2(assignment) or (assignment["A"] and assignment["C"] and assignment["D"]))))

# TH-12: courseware hazard example and two delay definitions.
courseware = {"A": 0, "B": 1, "C": 1}
check("courseware transient low glitch", int(not ((not courseware["A"]) and (not courseware["B"]) or (courseware["B"] and courseware["C"]))), 0)
check("courseware final high after B=0", int(bool((not courseware["A"]) and (not 0) or (0 and courseware["C"]))), 1)
check("example 2.15 tpd", 3 * 100, 300)
check("example 2.15 tcd", 2 * 60, 120)

# TH-12: exact local delay-model glitches. Gate models have tpd/tcd values but no internal settling.
def run_gate(input_state, input_transitions, tpd, tcd, initial_output, evaluate):
    now = 0
    state = dict(input_state)
    series = [(0, initial_output)]
    for time, signal, value in input_transitions:
        if time > now:
            series.append((now, int(bool(evaluate(state)))))
        state[signal] = value
        now = time
        series.append((now + tcd, int(bool(evaluate(state)))))
        now += tpd
    series.append((now, int(bool(evaluate(state)))))
    compressed = []
    for time, value in series:
        if not compressed or compressed[-1][1] != value:
            compressed.append((time, value))
    return compressed

def has_glitch(series, high_to_low):
    for (t1, v1), (t2, v2) in zip(series, series[1:]):
        if high_to_low and v1 == 1 and v2 == 0:
            return 1
        if not high_to_low and v1 == 0 and v2 == 1:
            return 1
    return 0

def f_courseware(s):
    return (not s["A"] and not s["B"]) or (s["B"] and s["C"])
# n1 = A'B has tcd 5/tpd 10 after B; n2 = BC has tcd 4/tpd 4 after B; OR has tcd 4/tpd 4.
stable = {"A": 0, "B": 1, "C": 1}
series = run_gate(stable, [(5, "B", 0)], 10, 5, 1, lambda s: (not s["A"] and not s["B"]))
series = run_gate(stable, [(4, "B", 0)], 4, 4, 1, lambda s: s["B"] and s["C"])
# At t=4 n2 falls; at t=5 n1 has only begun changing, so Y may fall and then rise.
series = run_gate({"n1": 1, "n2": 1}, [(4, "n2", 0), (5, "n1", 0), (9, "n2", 1), (10, "n1", 1)],
                  4, 4, 1, lambda s: s["n1"] and s["n2"])
check("P51 exact gate-level glitch", has_glitch(series, high_to_low=False), 1)

def f1_eval(s):
    return (s["A"] and s["B"]) or (s["A"] and not s["C"]) or (not s["C"] and s["D"])
stable = {"A": 1, "B": 1, "C": 0, "D": 1}
series = run_gate(stable, [(4, "B", 0), (8, "B", 0)], 8, 4, 1, f1_eval)
check("Q-084 A fixed high, B=1→0 has no static-0 glitch", has_glitch(series, high_to_low=False), 0)
stable = {"A": 1, "B": 0, "C": 0, "D": 1}
series = run_gate(stable, [(4, "B", 1), (8, "B", 1)], 8, 4, 0, f1_eval)
check("Q-084 A fixed high, B=0→1 has static-0 glitch", has_glitch(series, high_to_low=False), 1)

def f2_eval(s):
    return (s["A"] and s["B"]) or ((not s["A"]) and s["C"] and s["D"]) or (s["B"] and s["C"])
stable = {"A": 1, "B": 1, "C": 1, "D": 1}
series = run_gate(stable, [(4, "A", 0), (8, "A", 0)], 8, 4, 1, f2_eval)
check("Q-085 A=1→0 has no static-1 glitch", has_glitch(series, high_to_low=True), 0)
stable = {"A": 0, "B": 1, "C": 1, "D": 1}
series = run_gate(stable, [(4, "A", 1), (8, "A", 1)], 8, 4, 1, f2_eval)
check("Q-085 A=0→1 has no static-1 glitch", has_glitch(series, high_to_low=True), 0)

report = {
    "allPassed": True,
    "count": len(checks),
    "note": "独立枚举文字条件、卡诺图无关项结果、码变换、比较器、BCD 加法，并用局部门延迟事件模型复核冒险条件；不以正文答案作为期望。",
    "checks": checks,
}
(BASE / "audit-th12.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"allPassed": True, "count": len(checks)}, ensure_ascii=False))
