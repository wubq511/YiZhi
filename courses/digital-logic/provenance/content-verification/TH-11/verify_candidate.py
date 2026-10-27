"""TH11候选核验；通用求值器供本批TH12使用，不依赖第一批文件。"""
import copy
import hashlib
import itertools
import json
import pathlib
import re
import sys
import unicodedata

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]


def blocks(items):
    for item in items:
        yield item
        yield from blocks(item.get('children', []))


def normalize(text):
    while '\\overline{' in text:
        start = text.rfind('\\overline{')
        pos = start + len('\\overline{')
        end, level = pos, 1
        while level:
            if text[end] == '{':
                level += 1
            elif text[end] == '}':
                level -= 1
            end += 1
        text = text[:start] + '(' + text[pos:end-1] + ")'" + text[end:]
    text = re.sub(r'_\{(\d+)\}', r'\1', text)
    text = re.sub(r'_(\d+)', r'\1', text)
    for old, new in [('\\cdot', '*'), ('\\oplus', '^'), ('\\;', ''), ('\\quad', ';')]:
        text = text.replace(old, new)
    text = unicodedata.normalize('NFD', text).replace('\u0304', "'")
    return text.replace('′', "'").replace('·', '*').replace('⊕', '^').replace('¬', '~').replace(' ', '')


def parse(text):
    text = normalize(text)
    ts = re.findall(r"[A-Za-z]\d*|[01()+*^~']", text)
    assert ''.join(ts) == text, ('unsupported', text)
    i = 0

    def atom():
        nonlocal i
        t = ts[i]
        i += 1
        if t == '~':
            node = ('not', atom())
        elif t == '(':
            node = addition()
            assert ts[i] == ')'
            i += 1
        else:
            assert re.fullmatch(r'[A-Za-z]\d*|[01]', t), t
            node = ('value', t)
        while i < len(ts) and ts[i] == "'":
            node = ('not', node)
            i += 1
        return node

    def product():
        nonlocal i
        node = atom()
        while i < len(ts) and ts[i] not in [')', '+', '^']:
            if ts[i] == '*':
                i += 1
            node = ('and', node, atom())
        return node

    def addition():
        nonlocal i
        node = product()
        while i < len(ts) and ts[i] in ['+', '^']:
            op = ts[i]
            i += 1
            node = ('or' if op == '+' else 'xor', node, product())
        return node

    node = addition()
    assert i == len(ts), text
    return node


def evaluate(node, env):
    op, *args = node
    if op == 'value':
        return bool(int(args[0])) if args[0] in ['0', '1'] else bool(env[args[0]])
    if op == 'not':
        return not evaluate(args[0], env)
    a, b = (evaluate(x, env) for x in args)
    return a and b if op == 'and' else a or b if op == 'or' else a != b


def calc(expr, env):
    return int(evaluate(parse(expr), env))


def valuations(order):
    return [dict(zip(order, values)) for values in itertools.product((0, 1), repeat=len(order))]


def validate(chapter, ids):
    sys.path.insert(0, str(ROOT / '期中/工具'))
    import 复习内容
    source = ROOT / '期中/数据/知识地图.json'
    before = source.read_bytes()
    data = copy.deepcopy(json.loads(before))
    units = {u['id']: u for u in data['units']}
    questions = {q['id']: q for q in data['questions']}
    files = sorted((chapter / 'units').glob('KU-*.json'))

    def unique(pairs):
        d = {}
        for k, value in pairs:
            assert k not in d, k
            d[k] = value
        return d

    docs = {p.stem: json.loads(p.read_text(), object_pairs_hook=unique) for p in files}
    assert sorted(docs) == sorted(ids), (sorted(docs), ids)
    updates = {}
    for uid, d in docs.items():
        assert d['unitId'] == uid and uid != 'KU-049'
        units[uid]['reading'] = d['reading']
        flat = list(blocks(d['reading']['blocks']))
        assert any(b['kind'] == 'example' and b.get('children') for b in flat), uid
        assert any(b['kind'] == 'exercise' and b.get('children') for b in flat), uid
        for q in d.get('questionUpdates', []):
            qid = q['questionId']
            assert qid not in updates or updates[qid] == q, qid
            updates[qid] = q
            questions[qid].update({k: v for k, v in q.items() if k != 'questionId'})
        assert d['evidence']['pages']
        for page in d['evidence']['pages']:
            assert (chapter / page).is_file(), page
        for b in flat:
            if b['kind'] != 'figure':
                continue
            nodes = b['payload']['config']['nodes']
            for n in nodes:
                assert 70 <= n['x'] <= 570 and 28 <= n['y'] <= 212, n
            for a, z in itertools.combinations(nodes, 2):
                assert abs(a['x']-z['x']) >= 140 or abs(a['y']-z['y']) >= 56, (a, z)
    errors = []
    复习内容.validate_reading(data, errors)
    assert not errors, errors
    assert source.read_bytes() == before
    return docs, {
        'unitIds': sorted(docs), 'schemaErrors': errors,
        'sourceSHA256': hashlib.sha256(before).hexdigest(),
        'fragmentSHA256': {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        'scope': 'candidate-only; memory validation; no canonical/browser/server/import',
    }


def main():
    docs, report = validate(HERE, [f'KU-{i:03}' for i in [45, 46, 47, 48, 50]])
    byid = {b['id']: b for d in docs.values() for b in blocks(d['reading']['blocks'])}
    checks = 0

    def check(actual, expected, label):
        nonlocal checks
        assert actual == expected, (label, actual, expected)
        checks += 1

    def payload(bid):
        return byid[bid]['payload']

    majority = payload('RB-TH-11-045-majority')['latex'].split('=')[1]
    xy = payload('RB-TH-11-045-x-y')['latex'].split('=')[1]
    for env in valuations('ABC'):
        check(calc(majority, env), int(sum(env.values()) >= 2), ('majority', env))
    for env in valuations(['x1', 'x2', 'y1', 'y2']):
        check(calc(xy, env), int(2*env['x1']+env['x2'] > 2*env['y1']+env['y2']), ('xy', env))
    for row in payload('RB-TH-11-045-example-table')['rows']:
        check(int(row[-1]), int(sum(map(int, row[:3])) == 2), ('Q103', row))
    for row in payload('RB-TH-11-045-lock-table')['rows']:
        a, b, c = map(int, row[0])
        check(tuple(map(int, row[1:])), (int(a and (b or c)), int(not a)), ('lock', row))
    seat = payload('RB-TH-11-045-takeoff-steps')['items'][1]
    seat_expr = re.search(r'Hi=(.+?)。', seat)[1].replace('Mi', 'M').replace('Ni', 'N')
    for env in valuations(['S', 'A', 'B', 'M1', 'N1', 'M2', 'N2']):
        actual = env['S'] * env['A'] * env['B']
        for i in [1, 2]:
            actual *= calc(seat_expr, {'M': env[f'M{i}'], 'N': env[f'N{i}']})
        requirement = all([env['S'], env['A'], env['B']]) and all(
            not env[f'M{i}'] or env[f'N{i}'] for i in [1, 2])
        check(actual, int(requirement), ('takeoff', env))
    # 电平谓词与驱动输出分别从实际正文抽式，并独立核对灯的接法。
    text = payload('RB-TH-11-045-active-low')['text']
    green = re.search('G_on=(.+?)，', text)[1]
    red = re.search('R_on=(.+?)。', text)[1]
    red_pin = re.search('F2=(.+?)=', text)[1]
    for env in valuations('ABC'):
        check(calc(green, env), int(not any(env.values())), ('green', env))
        check(calc(red, env), int(any(env.values())), ('red condition', env))
        check(1-calc(red_pin, env), int(any(env.values())), ('red active-low pin', env))

    rounding = payload('RB-TH-11-046-formula')['latex'].split('=')[1]
    for value in range(10):
        check(calc(rounding, dict(zip('ABCD', map(int, format(value, '04b'))))), int(value >= 5), ('round', value))
    for row in payload('RB-TH-11-046-kmap')['rows']:
        for cd, cell in zip(['00', '01', '11', '10'], row[1:]):
            value = int(row[0]+cd, 2)
            check(cell, 'd' if value >= 10 else str(int(value >= 5)), ('round kmap', value))
    leap = dict(payload('RB-TH-11-046-leap-formulas')['rows'])
    for year in range(1582, 10000):
        env = {}
        for digit, val in zip('MHTO', map(int, str(year))):
            for weight in [8, 4, 2, 1]:
                env[digit+str(weight)] = int(bool(val & weight))
        for label in ['D4', 'D100', 'D400', 'Leap']:
            actual = calc(leap[label], env)
            expected = int(year % int(label[1:]) == 0) if label != 'Leap' else int(
                year % 4 == 0 and (year % 100 != 0 or year % 400 == 0))
            check(actual, expected, (label, year))
            env[label] = actual

    formulas = normalize(payload('RB-TH-11-047-formulas')['latex'])
    output_exprs = dict(re.findall(r'(W|X|Y|Z|G[0-3])=([^,;]+)', formulas))
    for row in payload('RB-TH-11-047-table')['rows']:
        number = int(row[0])
        env = dict(zip('ABCD', map(int, row[1])))
        check(int(row[1], 2), number, ('BCD order', row))
        actual = ''.join(str(calc(output_exprs[x], env)) for x in 'WXYZ')
        expected = format(number+3, '04b')
        check(actual, expected, ('excess formulas', number))
        check(row[2], expected, ('actual excess table', number))
    for row in payload('RB-TH-11-047-gray-table')['rows']:
        number = int(row[0])
        env = dict(zip(['B3', 'B2', 'B1', 'B0'], map(int, row[1])))
        check(''.join(str(calc(output_exprs['G'+str(i)], env)) for i in [3, 2, 1, 0]),
              format(number ^ (number >> 1), '04b'), ('gray formulas', number))
        check(row[2], format(number ^ (number >> 1), '04b'), ('gray table', number))
    sol = ' '.join(payload('RB-TH-11-047-practice-answer')['items'])
    sets = {key: {int(x) for x in value.split(',')} for key, value in re.findall(r'([WXYZ])=Σm\(([\d,]+)\)', sol)}
    nand_exprs = dict(re.findall(r'([WXYZ])=(\(L[\dL]+\)′)', sol))
    assert len(sets) == len(nand_exprs) == 4
    for number in range(10):
        expected = format(number+3, '04b')
        env = {f'L{i}': int(i != number) for i in range(16)}
        for bit, key in enumerate('WXYZ'):
            check(int(number in sets[key]), int(expected[bit]), ('decoder minterms', number, key))
            check(calc(nand_exprs[key], env), int(expected[bit]), ('decoder NAND active low', number, key))

    text = payload('RB-TH-11-048-formula')['latex'].replace('\\qquad', ';')
    neq_expr = text.split('=')[1].split(',')[0].replace('A_i', 'A').replace('B_i', 'B')
    eq_expr = text.split('=')[2]
    for row in payload('RB-TH-11-048-mx-table')['rows']:
        check(calc(neq_expr, dict(zip('AB', map(int, row[:2])))), int(row[2]), ('MX table', row))
    for a, b in itertools.product(range(16), repeat=2):
        ns = {f'N{i}': calc(neq_expr, {'A': (a >> i) & 1, 'B': (b >> i) & 1}) for i in range(4)}
        check(calc(eq_expr, ns), int(a == b), ('hierarchical comparator', a, b))

    text = payload('RB-TH-11-050-formula')['latex']
    correction_expr = text.split('=')[1].split(',')[0]
    match = re.search(r'S=\(Z\+(\d+)C\)\\bmod(\d+)', text)
    assert match
    addend, modulus = map(int, match.groups())
    for a, b, cin in itertools.product(range(10), range(10), range(2)):
        raw = a+b+cin
        z = raw & 15
        env = {'K': raw >> 4, **{f'Z{i}': int(bool(z & i)) for i in [8, 4, 2, 1]}}
        c = calc(correction_expr, env)
        s = (z+addend*c) % modulus
        check((c, s), divmod(raw, 10), ('BCD add actual formula', a, b, cin))
    for row in payload('RB-TH-11-050-all-results')['rows']:
        t = int(row[0]); z = t % 16; c = int(t >= 10); corrected = z+addend*c
        expected = [str(t), str(t//16), format(z, '04b'), str(c), format(corrected, '05b'),
                    format(corrected % modulus, '04b'), str(corrected//16)]
        check(row, expected, ('BCD actual 20-row table', t))
    report.update(status='passed', calculationComparisons=checks,
                  method='actual candidate formula/table extraction; arithmetic and Boolean definitions; 1582-9999 leap enumeration')
    (HERE / 'verification-candidate.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
