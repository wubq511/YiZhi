"""TH06：原定义/原图输入独立求值，与实际候选的表、编号、波形交叉核对。"""
import importlib.util
import itertools
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('th05_verifier', HERE.parent / 'TH-05/verify_candidate.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def main():
    docs, result = v.validate(HERE, [f'KU-{i:03}' for i in range(27, 32)])
    byid = {b['id']: b for d in docs.values() for b in v.blocks(d['reading']['blocks'])}
    checks = 0
    details = []

    def equivalent(name, expressions, order='ABC'):
        nonlocal checks
        count = v.same(expressions, order)
        checks += count
        details.append({'claim': name, 'comparisons': count, 'expressions': expressions})

    # 每一阶段都通过，不能只比最后答案；式子按本轮实际所看原页及修订正文转录。
    for name, exprs, order in [
        ('P30 SOP absorption', ["A+A'B+AB'C", "A+A'B", "A+B"], 'ABC'),
        ('P31 factoring/expanding', ['AB+C(D+E)', 'AB+CD+CE'], 'ABCDE'),
        ('KU027 worked SOP-POS conversion', ["AB+A'C", "(AB+A')(AB+C)", "(A'+B)(A+C)(B+C)", "(A'+B)(A+C)", "A'C+AB+BC"], 'ABC'),
        ('Q102 expansion/completion', ["(A+B)(A'+B'+C')", "AB'+AC'+A'B+BC'", "AB'C+AB'C'+ABC'+A'BC+A'BC'"], 'ABC'),
        ('P39 minterm completion', ["ABC'+BC", "ABC'+(A+A')BC", "ABC'+ABC+A'BC"], 'ABC'),
        ('P40 practice completion', ["A+B'C", "AB+AB'+B'C", "ABC+ABC'+AB'C+AB'C'+A'B'C"], 'ABC'),
        ('P42 maxterm completion', ["A'B+AC", "(A'B+A)(A'B+C)", "(A+B)(A'+C)(B+C)", "(A+B+C)(A+B+C')(A'+B+C)(A'+B'+C)"], 'ABC'),
        ('P43 reverse-selector POS', ["AB+A'C", "(A'+B)(A+C)(B+C)", "(A+B+C)(A+B'+C)(A'+B+C)(A'+B+C')"], 'ABC'),
        ('Q118 netlist/majority', ["((AB)'((A+B)C)')'", 'AB+(A+B)C', 'AB+AC+BC'], 'ABC'),
        ('P44 AOI: every complement expansion', ["(AB'+BC'+CA')'", "(A'+B)(B'+C)(C'+A)", "(A'B'+A'C+BC)(C'+A)", "A'B'C'+A'CC'+BCC'+AA'B'+AA'C+ABC", "ABC+A'B'C'"], 'ABC'),
        ('P44 final function and both netlists', ["AB'+BC'+CA'", "((AB'+BC'+CA')')'", "(ABC+A'B'C')'"], 'ABC'),
        ('KU031 exercise complement', ["(AB+A'C)'", "(A'+B')(A+C')", "A'C'+AB'+B'C'", "A'C'+AB'"], 'ABC'),
        ('KU031 exercise AOI output', ["AB+A'C", "(A'C'+AB')'"], 'ABC'),
    ]:
        equivalent(name, exprs, order)

    # 读取候选中的三变量编号表；编号本身由二进制位权推导。
    for bits, minterm, maxterm in byid['RB-TH-06-11-table']['payload']['rows']:
        index = int(bits, 2)
        assert int(re.search(r'm(\d+)', minterm)[1]) == index
        assert int(re.search(r'M(\d+)', maxterm)[1]) == index
        for j, envbits in enumerate(itertools.product((0, 1), repeat=3)):
            env = dict(zip('ABC', envbits))
            assert int(v.evaluate(v.parse(minterm.split('=')[1]), env)) == int(j == index)
            assert int(v.evaluate(v.parse(maxterm.split('=')[1]), env)) == int(j != index)
            checks += 2

    def standard_claim(block_id, step, expression, kind, complement=False):
        nonlocal checks
        text = byid[block_id]['payload']['items'][step]
        values = v.truth(expression, 'ABC')
        if complement:
            values = [1-x for x in values]
        wanted = [i for i, x in enumerate(values) if x == (1 if kind == 'Σm' else 0)]
        matches = re.findall(re.escape(kind) + r'\(([\d,， ]+)\)', text)
        assert matches, (block_id, step, kind)
        for match in matches:
            actual = [int(x) for x in re.split('[,，]', match)]
            assert actual == wanted, (block_id, actual, wanted)
            checks += len(values)

    for args in [
        ('RB-TH-06-14-example-q102-steps', 2, "(A+B)(A'+B'+C')", 'Σm'),
        ('RB-TH-06-14-example-q102-steps', 3, "(A+B)(A'+B'+C')", 'ΠM'),
        ('RB-TH-06-20-method1-truthtable', 1, "ABC'+BC", 'Σm'),
        ('RB-TH-06-20-method1-truthtable', 3, "A'B+AC", 'ΠM'),
        ('RB-TH-06-21-method2-expand', 1, "ABC'+BC", 'Σm'),
        ('RB-TH-06-21-method2-expand', 3, "A'B+AC", 'ΠM'),
        ('RB-TH-06-22-example-q103-steps', 3, "A'BC+AB'C+ABC'", 'Σm'),
        ('RB-TH-06-23-example-q102-steps', 1, "(A+B)(A'+B'+C')", 'Σm'),
        ('RB-TH-06-23-example-q102-steps', 2, "(A+B)(A'+B'+C')", 'ΠM'),
        ('RB-TH-06-27-practice-answer', 2, "A+B'C", 'Σm'),
        ('RB-TH-06-27-practice-answer', 3, "A+B'C", 'ΠM'),
        ('RB-TH-06-31-func-to-truthtable', 1, "A+B'C+A'BC'", 'Σm'),
        ('RB-TH-06-31-func-to-truthtable', 3, 'A(B+C)', 'Σm'),
        ('RB-TH-06-37-practice-answer', 1, "A+B'C+A'BC'", 'Σm'),
    ]:
        standard_claim(*args)

    # 候选练习不是脚本的期望：从 Σm(1,2,5) 题干实际抽取集合，再检查解答。
    practice = byid['RB-TH-06-17-practice']['payload']['problem']
    original = {int(x) for x in re.search(r'Σm\(([\d,]+)\)', practice)[1].split(',')}
    answer = byid['RB-TH-06-17-practice-answer']['payload']['items']
    for step, kind, wanted in [(0, 'ΠM', set(range(8))-original), (1, 'ΠM', original), (2, 'Σm', set(range(8))-original)]:
        actual = {int(x) for x in re.search(re.escape(kind)+r'\(([\d,]+)\)', answer[step])[1].split(',')}
        assert actual == wanted
        checks += 8
    expanded = re.search('即F̄=(.+?)。', answer[1].replace(' ', ''))[1]
    assert v.truth(expanded, 'ABC') == [int(i not in original) for i in range(8)]
    checks += 8

    # 实际 Q103 表的各列，与“恰好两高”的计数定义交叉比，不照抄输出。
    for row in byid['RB-TH-06-29-table-q103']['payload']['rows']:
        env = dict(zip('ABC', map(int, row[0])))
        for formula, actual in zip(["A'BC", "AB'C", "ABC'"], row[1:4]):
            assert int(v.evaluate(v.parse(formula), env)) == int(actual)
            checks += 1
        assert int(row[4]) == int(sum(env.values()) == 2)
        checks += 1

    # 输入来自原页波形的跳变事件，仅硬编码输入；输出均按相等/异或定义计算。
    # 段0初始000，七次事件依次是 A↑、B↑、A↓、C↑、A↑、B↓、A↓。
    inputs = [(0, 0, 0)]
    for position, value in [(0, 1), (1, 1), (0, 0), (2, 1), (0, 1), (1, 0), (0, 0)]:
        next_bits = list(inputs[-1])
        next_bits[position] = value
        inputs.append(tuple(next_bits))
    wave_values = byid['RB-TH-06-30-wave-values']['payload']['rows']
    traces = byid['RB-TH-06-30-wave-traces']['payload']['rows']
    outputs = [(int(a == b), int((a == b) != bool(c))) for a, b, c in inputs]
    for i, (row, abc, out) in enumerate(zip(wave_values, inputs, outputs)):
        assert int(row[0]) == i and tuple(map(int, row[1])) == abc
        assert tuple(map(int, row[2:])) == out
        checks += 3
    for row, values in zip(traces, list(zip(*inputs))+list(zip(*outputs))):
        assert row[1:] == ['▔' if x else '▁' for x in values]
        checks += len(values)

    # 填图不引入任意 provider 固定样例：对候选中实际格雷码行逐格算目标函数。
    for ab, c0, c1 in byid['RB-TH-06-30-kmap-identify']['payload']['rows']:
        for c, actual in enumerate([c0, c1]):
            assert int(v.evaluate(v.parse("A+B'C+A'BC'"), dict(zip('ABC', map(int, ab+str(c)))))) == int(actual)
            checks += 1

    # AOI表读取实际列值；独立比较原函数、与或非网表和输入全同判据。
    for row in byid['RB-TH-06-31-example-table']['payload']['rows']:
        env = dict(zip('ABC', map(int, row[0])))
        expressions = ["AB'", "BC'", "CA'", 'ABC', "A'B'C'", "AB'+BC'+CA'"]
        for expression, actual in zip(expressions, row[1:]):
            assert int(v.evaluate(v.parse(expression), env)) == int(actual)
            checks += 1
        assert int(row[-1]) == int(len(set(env.values())) > 1)
        checks += 1

    # 直接从最终正文抽取 AOI 结论及自测结论，独立源函数为期望。
    example_steps = byid['RB-TH-06-31-example-steps']['payload']['items']
    actual = re.search('取反一次得 F=(.+?)。', example_steps[3])[1]
    equivalent('actual candidate AOI conclusion', [actual, "AB'+BC'+CA'"])
    practice_steps = byid['RB-TH-06-31-practice-answer']['payload']['items']
    actual = re.search('得到 F=(.+?)。', practice_steps[1])[1]
    equivalent('actual candidate exercise conclusion', [actual, "AB+A'C"])

    result.update(status='passed', calculationComparisons=checks, derivations=details,
                  method='Boolean AST evaluation; actual candidate rows/sets/traces; waveform input events; population count')
    (HERE / 'verification-candidate.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'derivations'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
