#!/usr/bin/env python3
import itertools
import json
from pathlib import Path

checks = []
package = json.loads(Path(__file__).with_name("package.json").read_text(encoding="utf-8"))


def add(name, actual, expected):
    assert actual == expected, (name, actual, expected)
    checks.append({"name": name, "pass": True, "actual": actual, "expect": expected})


def find_block(identifier):
    def walk(blocks):
        for block in blocks:
            if block["id"] == identifier:
                return block
            found = walk(block.get("children", []))
            if found:
                return found
        return None
    for unit in package["units"]:
        found = walk(unit["reading"]["blocks"])
        if found:
            return found
    raise KeyError(identifier)


for selector in range(4):
    a1, a0 = selector >> 1, selector & 1
    for data in range(16):
        x0, x1, x2, x3 = [(data >> i) & 1 for i in range(4)]
        gate = ((not a1 and not a0 and x0) or (not a1 and a0 and x1)
                or (a1 and not a0 and x2) or (a1 and a0 and x3))
        add(f"Q-117 A1A0={selector:02b}, X={data:04b}", int(bool(gate)), (data >> selector) & 1)

for a, b, c in itertools.product(range(2), repeat=3):
    gate = not ((not (a and b)) and (not ((a or b) and c)))
    add(f"Q-118 ABC={a}{b}{c}", int(gate), int(a + b + c >= 2))
    expanded = (b and c) or (a and not b and c) or (a and b and not c)
    add(f"majority-design ABC={a}{b}{c}", int(bool(expanded)), int(a + b + c >= 2))

for d in range(8):
    d2, d1, d0 = (d >> 2) & 1, (d >> 1) & 1, d & 1
    a_bits = [d0, d1, d2, 0]
    b_bits = [0, d0, d1, d2]
    carry, output = 0, 0
    for bit, (a, b) in enumerate(zip(a_bits, b_bits)):
        output |= (a ^ b ^ carry) << bit
        carry = (a & b) | (a & carry) | (b & carry)
    output |= carry << 4
    add(f"Q-121 D={d:03b}", output, 3 * d)

bcd_rows = find_block("RB-TH-10-044-answer-table")["payload"]["rows"]
for value in range(10):
    a3, a2, a1, a0 = [(value >> i) & 1 for i in (3, 2, 1, 0)]
    actual = int(bool(a3 or (a2 and (a1 or a0))))
    expected = int(value >= 5)
    add(f"Q-082 valid BCD={value:04b}", actual, expected)
    add(f"Q-082 published row={value}", bcd_rows[value], [str(value), f"{value:04b}", str(expected)])
add("Q-082 invalid inputs stay unspecified", bcd_rows[10], ["无效码字", "1010～1111", "d（未约束）"])

published_rows = find_block("RB-TH-10-043-answer-table")["payload"]["rows"]
for index, (a, b, c) in enumerate(itertools.product(range(2), repeat=3)):
    expected = int(len({a, b, c}) > 1)
    actual = (a ^ b) | (a ^ c)
    add(f"non-unanimous ABC={a}{b}{c}", actual, expected)
    add(f"non-unanimous published row={index}", published_rows[index],
        list(map(str, [a, b, c, a ^ b, a ^ c, expected])))

for value in range(16):
    d, c, b, a = [(value >> i) & 1 for i in (3, 2, 1, 0)]
    outputs = (int(bool((d and b and a) or (d and c))),
               int(bool((not d and c and b) or (d and not c and not b) or (d and not c and not a))),
               int(bool((not d and not c) or (not d and not b))))
    add(f"range-decoder DCBA={value:04b}", outputs,
        (int(value >= 11), int(6 <= value <= 10), int(value <= 5)))

report = {"allPassed": True, "count": len(checks),
          "note": "门级表达式/逐位全加器与独立功能定义比较；同时核对实际包中的非一致真值表和 BCD 输入约束表。BCD 10～15 不作为规定输出。",
          "checks": checks}
Path(__file__).with_name("verification.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"allPassed": True, "count": len(checks)}, ensure_ascii=False))
