"""候选核验：从定义计算，核对正文表格；只在内存调用正式 validator。"""
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


def parse(text):
    text = unicodedata.normalize('NFD', text).replace('\u0304', "'")
    text = text.replace('′', "'").replace('·', '*').replace(' ', '')
    text = text.replace('overline(', '~(').replace('¬', '~')
    tokens = re.findall(r"[A-Za-z01()+*~']", text)
    assert ''.join(tokens) == text, ('unsupported formula', text)
    i = 0

    def atom():
        nonlocal i
        t = tokens[i]
        i += 1
        if t == '~':
            node = ('not', atom())
        elif t == '(':
            node = union()
            assert tokens[i] == ')'
            i += 1
        else:
            assert t.isalpha() or t in '01', t
            node = ('value', t)
        while i < len(tokens) and tokens[i] == "'":
            node = ('not', node)
            i += 1
        return node

    def product():
        nonlocal i
        node = atom()
        while i < len(tokens) and tokens[i] not in [')', '+']:
            if tokens[i] == '*':
                i += 1
            node = ('and', node, atom())
        return node

    def union():
        nonlocal i
        node = product()
        while i < len(tokens) and tokens[i] == '+':
            i += 1
            node = ('or', node, product())
        return node

    node = union()
    assert i == len(tokens), text
    return node


def evaluate(node, env):
    op, *args = node
    if op == 'value':
        return bool(int(args[0])) if args[0] in '01' else bool(env[args[0]])
    if op == 'not':
        return not evaluate(args[0], env)
    left, right = (evaluate(x, env) for x in args)
    return (left and right) if op == 'and' else (left or right)


def truth(expr, order):
    node = parse(expr)
    return [int(evaluate(node, dict(zip(order, bits))))
            for bits in itertools.product((0, 1), repeat=len(order))]


def same(expressions, order):
    values = [truth(x, order) for x in expressions]
    assert all(x == values[0] for x in values), expressions
    return len(values[0]) * (len(expressions) - 1)


def validate(chapter, target):
    sys.path.insert(0, str(ROOT / '期中/工具'))
    import 复习内容
    source = ROOT / '期中/数据/知识地图.json'
    before = source.read_bytes()
    data = json.loads(before)
    data = copy.deepcopy(data)
    units = {u['id']: u for u in data['units']}
    questions = {q['id']: q for q in data['questions']}
    files = sorted((chapter / 'units').glob('KU-*.json'))
    docs = {p.stem: json.loads(p.read_text()) for p in files}
    assert set(docs) == set(target), (set(docs), target)
    updates = {}
    for uid, doc in docs.items():
        assert uid == doc['unitId']
        units[uid]['reading'] = doc['reading']
        for q in doc.get('questionUpdates', []):
            qid = q['questionId']
            assert qid not in updates or updates[qid] == q, qid
            updates[qid] = q
            questions[qid].update({k: v for k, v in q.items() if k != 'questionId'})
        for page in doc['evidence']['pages']:
            assert (chapter / page).is_file(), page
        for b in blocks(doc['reading']['blocks']):
            if b['kind'] == 'figure':
                nodes = b['payload'].get('config', {}).get('nodes', [])
                for node in nodes:
                    assert 70 <= node['x'] <= 570 and 28 <= node['y'] <= 212
                for a, z in itertools.combinations(nodes, 2):
                    assert abs(a['x']-z['x']) >= 140 or abs(a['y']-z['y']) >= 56
    errors = []
    复习内容.validate_reading(data, errors)
    assert not errors, errors
    assert source.read_bytes() == before
    return docs, {
        'schemaErrors': errors,
        'unitIds': sorted(docs),
        'sourceSHA256': hashlib.sha256(before).hexdigest(),
        'fragmentSHA256': {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        'scope': 'candidate-only; memory copy; no browser/import/server',
    }


def main():
    docs, result = validate(HERE, [f'KU-{i:03}' for i in range(23, 27)])
    checks = 0
    byid = {b['id']: b for d in docs.values() for b in blocks(d['reading']['blocks'])}
    # 真正读取候选中的公式表，逐等号计算；不使用旧 audit 的硬编码输出。
    for bid in ['RB-TH-05-02-axioms', 'RB-TH-05-03-theorems', 'RB-TH-05-26-05-dual-table']:
        for row in byid[bid]['payload']['rows']:
            cells = row[1:] if bid != 'RB-TH-05-26-05-dual-table' else row
            for cell in cells:
                for chain in re.split('[,，]', cell):
                    if '=' not in chain:
                        continue
                    expressions = chain.split('=')
                    order = sorted(set(re.findall('[A-Z]', chain)))
                    checks += same(expressions, order)
    table = byid['RB-TH-05-08-example-truthtable-table']['payload']['rows']
    for row in table:
        env = dict(zip('BCD', map(int, row[:3])))
        for expr, value in zip(["BC+B'D+CD", "BC+B'D"], row[3:]):
            assert int(evaluate(parse(expr), env)) == int(value), row
            checks += 1
    for exprs, order in [
        (["(A+B')(B+C)(A'+C)", "(A+B')C", "AC+B'C"], 'ABC'),
        (["AB'+BC+A'C", "AB'+(B+A')C", "AB'+C"], 'ABC'),
        (["((A+B)C')'", "A'B'+C"], 'ABC'),
        (["(A'B+CD')'", "(A+B')(C'+D)"], 'ABCD'),
        (["(A'+B)(A+B')C+(BC)'", "ABC+A'B'C+B'+C'", "A+B'+C'", "(A'BC)'", "((AA)'BC)'"], 'ABC'),
        (["ABC'+AB'C'", "AC'(B+B')", "AC'", "(((A(CC)')')((A(CC)')'))'"], 'ABC'),
        (["((AB)'(CD)')'", "AB+CD"], 'ABCD'),
        (["(((((ABC)'D)')+((E+FG)'))')'", "ABC+D'+E'(F'+G')"], 'ABCDEFG'),
        (["(A+D)(B+C)", "(A+D)B+(A+D)C"], 'ABCD'),
        (["xy+x'z+yzw", "xy+x'z"], 'xyzw'),
    ]:
        checks += same(exprs, order)
    # 关键修订的答案从实际片段抽取。若正文回退为旧错误，不能只靠下面的
    # 独立等价式仍然通过：必须让“候选声称的式子”与原图函数相等。
    actual_steps = byid['RB-TH-05-24-09-example-q101-steps']['payload']['items']
    q101 = re.search('Y=(.+?)，', actual_steps[0])[1]
    checks += same([q101, "((AA)'BC)'"], 'ABC')
    actual_steps = byid['RB-TH-05-25-07-example-q077-steps']['payload']['items']
    q077 = re.search('所以 Y=(.+?)，', actual_steps[4])[1]
    checks += same([q077, "(((((ABC)'D)')+((E+FG)'))')'"], 'ABCDEFG')
    practice = byid['RB-TH-05-26-08-practice-answer']['payload']['items']
    inverse = re.search('F̄=(.+?)；', practice[0])[1]
    actual_dual = re.search('Fᵈ=(.+?)，', practice[1])[1]
    checks += same([inverse, "((A+B)C')'"], 'ABC')
    assert truth(actual_dual, 'ABC') == [1-x for x in reversed(truth("(A+B)C'", 'ABC'))]
    checks += 8
    actual_steps = byid['RB-TH-05-26-04-dual']['payload']['items']
    chain = re.search('Fᵈ=(.+?)。', actual_steps[3])[1].split('=')
    checks += same(chain, 'ABC')
    # 对偶式的定义独立于候选答案：Fᵈ(x)=¬F(¬x)。
    f = truth("(A+B)C'", 'ABC')
    dual = truth("AB+C'", 'ABC')
    assert dual == [1-v for v in reversed(f)]
    checks += len(f)
    result.update(calculationComparisons=checks, status='passed',
                  method='Boolean AST evaluator; exhaustive valuations; actual candidate tables; circuit netlists')
    (HERE / 'verification-candidate.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
