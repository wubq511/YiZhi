#!/usr/bin/env python3
import json
from pathlib import Path


def sender_parity(data):
    return int(bin(data).count("1") % 2 == 0)


def receiver_even(data, parity):
    return int((bin(data).count("1") + parity) % 2 == 0)


parity_cases = []
for data in range(256):
    parity = sender_parity(data)
    normal = receiver_even(data, parity)
    assert normal == 0
    for bit in range(8):
        one_error = data ^ (1 << bit)
        assert receiver_even(one_error, parity) == 1
        for other in range(bit + 1, 8):
            two_errors = one_error ^ (1 << other)
            assert receiver_even(two_errors, parity) == 0
    parity_cases.append({"data": f"{data:08b}", "parity": parity, "receiverEvenNormal": normal})


def compare4(a, b):
    x = [int(((a >> i) & 1) == ((b >> i) & 1)) for i in range(4)]
    a_bits = [(a >> i) & 1 for i in range(4)]
    b_bits = [(b >> i) & 1 for i in range(4)]
    greater = ((a_bits[3] and not b_bits[3])
               or (x[3] and a_bits[2] and not b_bits[2])
               or (x[3] and x[2] and a_bits[1] and not b_bits[1])
               or (x[3] and x[2] and x[1] and a_bits[0] and not b_bits[0]))
    less = ((not a_bits[3] and b_bits[3])
            or (x[3] and not a_bits[2] and b_bits[2])
            or (x[3] and x[2] and not a_bits[1] and b_bits[1])
            or (x[3] and x[2] and x[1] and not a_bits[0] and b_bits[0]))
    return int(bool(greater)), int(a == b), int(bool(less))


def compare8(a, b):
    hi = compare4(a >> 4, b >> 4)
    lo = compare4(a & 0xF, b & 0xF)
    if hi[1]:
        return lo
    return hi


comparator_cases = []
for a in range(256):
    for b in range(256):
        actual = compare8(a, b)
        expected = (int(a > b), int(a == b), int(a < b))
        assert actual == expected, (a, b, actual, expected)
        if a < 16 and b < 16:
            assert compare4(a, b) == expected
        if a < 16:
            valid = int(a >= 3 and a <= 12)
            direct = int((a > 3 or a == 3) and (a < 12 or a == 12))
            assert valid == direct
        comparator_cases.append({"a": a, "b": b, "outputs": actual})
report = {"allPassed": True,
          "parity": {"dataValues": 256, "singleBitErrorsDetected": 256 * 8,
                     "doubleBitErrorsMissed": 256 * 28,
                     "note": "奇校验发送位按数据 1 的个数生成；单位错误可检，双位错误漏检"},
          "comparator": {"pairs": len(comparator_cases), "validExcess3Range": "0011–1100",
                         "cascadeInitial": "低 4 位 a>b=0、a=b=1、a<b=0"},
          "parityCases": parity_cases}
Path(__file__).with_name("verification.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"allPassed": True, "parity": report["parity"],
                  "comparatorPairs": len(comparator_cases)}, ensure_ascii=False))
