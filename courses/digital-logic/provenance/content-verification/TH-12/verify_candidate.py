"""独立检查覆盖/事件/路径，读取实际候选答案；不调用旧audit的硬编码结论。"""
import heapq
import importlib.util
import itertools
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('batch2_common', HERE.parent / 'TH-11/verify_candidate.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def static_gaps(expr, order, zero=False):
    terms = re.findall(r'\([^()]+\)', expr) if zero else expr.split('+')
    target = 0 if zero else 1
    term_asts = [v.parse(t) for t in terms]
    vals = [(env, v.calc(expr, env)) for env in v.valuations(order)]
    gaps = []
    for i, (a, fa) in enumerate(vals):
        for j in range(i+1, len(vals)):
            b, fb = vals[j]
            if fa != target or fb != target or sum(a[x] != b[x] for x in order) != 1:
                continue
            if not any(int(v.evaluate(t, a)) == int(v.evaluate(t, b)) == target for t in term_asts):
                gaps.append((i, j))
    return gaps


def algebraic_gaps(expr, order):
    """固定其余变量，逐项区分X/X′/独立常1，和邻格法独立交叉检查。"""
    terms = [v.normalize(t) for t in expr.split('+')]
    found = []
    for var in order:
        other = [x for x in order if x != var]
        for fixed in v.valuations(other):
            pos = neg = hold = False
            for term in terms:
                literals = re.findall(r"([A-Za-z]\d*)('?)", term)
                rest = [(x, int(not prime)) for x, prime in literals if x != var]
                if not all(fixed[x] == p for x, p in rest):
                    continue
                own = [prime for x, prime in literals if x == var]
                if not own:
                    hold = True
                elif own[0]:
                    neg = True
                else:
                    pos = True
            if pos and neg and not hold:
                a = {**fixed, var: 0}; b = {**fixed, var: 1}
                number = lambda env: int(''.join(str(env[x]) for x in order), 2)
                found.append(tuple(sorted((number(a), number(b)))))
    return sorted(found)


def gate_value(kind, args):
    if kind == 'NOT':
        return 1-args[0]
    if kind == 'BUF':
        return args[0]
    if kind == 'AND':
        return int(all(args))
    if kind == 'NAND':
        return int(not all(args))
    if kind == 'OR':
        return int(any(args))
    raise AssertionError(kind)


def simulate(gates, inputs, changes):
    """确定性传输延迟：同一时刻批量更新；理想门值改变后调度对应输出事件。"""
    values = dict(inputs)
    pending = dict(gates)
    while pending:
        ready = [name for name, (_, ins, _) in pending.items() if all(x in values for x in ins)]
        assert ready, 'not a combinational DAG'
        for name in ready:
            kind, ins, _ = pending.pop(name)
            values[name] = gate_value(kind, [values[x] for x in ins])
    ideal = {name: values[name] for name in gates}
    trace = [(-1, dict(values))]
    queue = list(changes)
    heapq.heapify(queue)
    iterations = 0
    while queue:
        time = queue[0][0]
        due = []
        while queue and queue[0][0] == time:
            due.append(heapq.heappop(queue))
        changed = set()
        for _, name, value in due:
            if values[name] != value:
                values[name] = value
                changed.add(name)
        for name, (kind, ins, delay) in gates.items():
            if not changed.intersection(ins):
                continue
            new = gate_value(kind, [values[x] for x in ins])
            if new != ideal[name]:
                ideal[name] = new
                heapq.heappush(queue, (time+delay, name, new))
        trace.append((time, dict(values)))
        iterations += 1
        assert iterations < 1000
    return trace


def edges(trace, output='Y'):
    out = []
    for time, env in trace:
        if not out or out[-1][1] != env[output]:
            out.append((time, env[output]))
    return out


def path_costs(graph, start, end):
    if start == end:
        return [0]
    return [prefix+cost for parent, cost in graph.get(end, {}).items()
            for prefix in path_costs(graph, start, parent)]


def main():
    docs, report = v.validate(HERE, [f'KU-{i:03}' for i in [51, 52, 53, 54]])
    byid = {b['id']: b for d in docs.values() for b in v.blocks(d['reading']['blocks'])}
    checks = 0

    def check(actual, expected, label):
        nonlocal checks
        assert actual == expected, (label, actual, expected)
        checks += 1

    def p(bid):
        return byid[bid]['payload']

    def equivalent(left, right, order):
        for env in v.valuations(order):
            check(v.calc(left, env), v.calc(right, env), ('equivalence', left, right, env))

    # 原题输入来自实际看过的HW04，而候选stem/卡诺图/解答均读当前文件。
    source_inputs = {'Q-084': 'AB+AC′+C′D', 'Q-085': 'AB+A′CD+BC'}
    found = {}
    for update in docs['KU-052']['questionUpdates']:
        qid = update['questionId']
        actual_expr = re.search(r'F[12]=(.+?)。', update['stem'])[1]
        equivalent(actual_expr, source_inputs[qid], 'ABCD')
        gaps = static_gaps(actual_expr, 'ABCD')
        check(gaps, algebraic_gaps(actual_expr, 'ABCD'), (qid, 'algebra vs adjacency'))
        # 候选文字明确说无需补项；用算法检查该说法，不把“无险”硬编码为公式答案。
        assert re.search('无需|无须', update['solution']), qid
        check(bool(gaps), False, (qid, 'candidate no-extra-term claim'))
        found[qid] = gaps
        for row in p('RB-TH-12-052-'+qid.lower()+'-kmap')['rows']:
            for cd, cell in zip(['00', '01', '11', '10'], row[1:]):
                env = dict(zip('ABCD', map(int, row[0]+cd)))
                check(int(cell), v.calc(source_inputs[qid], env), (qid, row[0]+cd))

    course = re.search('实现F=(.+?)，', p('RB-TH-12-052-example')['problem'])[1]
    course_gaps = static_gaps(course, 'ABC')
    check(course_gaps, algebraic_gaps(course, 'ABC'), 'P52 both methods')
    candidate_pair = re.search(r'm(\d+)↔m(\d+)', p('RB-TH-12-052-example-steps')['items'][1])
    check(course_gaps, [tuple(map(int, candidate_pair.groups()))], 'P52 actual claimed uncovered pair')
    for row in p('RB-TH-12-052-example-kmap')['rows']:
        for bc, cell in zip(['00', '01', '11', '10'], row[1:]):
            check(int(cell), v.calc(course, dict(zip('ABC', map(int, row[0]+bc)))), ('P52 actual kmap', row[0]+bc))

    y = 'A′B′+BC'
    safe_y = re.search('Y_safe=(.+?)。', p('RB-TH-12-053-example-steps')['items'][1])[1]
    equivalent(y, safe_y, 'ABC')
    check(static_gaps(safe_y, 'ABC'), [], 'bridge covers every adjacent 1 pair')
    h = '(A+B)(A′+C)'
    safe_h = re.search('H_safe=(.+?)。', p('RB-TH-12-052-pos-answer')['items'][1])[1]
    equivalent(h, safe_h, 'ABC')
    check(len(static_gaps(h, 'ABC', zero=True)), 1, 'POS uncovered adjacent zero pair')
    check(static_gaps(safe_h, 'ABC', zero=True), [], 'POS bridge zero coverage')
    bare = 'AB+A′CD'; fixed_bare = 'AB+A′CD+BCD'
    equivalent(bare, fixed_bare, 'ABCD')
    check(static_gaps(fixed_bare, 'ABCD'), [], 'bare variant bridge')
    pair = re.search(r'(\d{4})↔(\d{4})', p('RB-TH-12-053-practice-answer')['items'][0])
    check(static_gaps(bare, 'ABCD'), [tuple(int(x, 2) for x in pair.groups())], 'bare actual claimed pair')
    for row in p('RB-TH-12-053-kmap')['rows']:
        for ab, cell in zip(['00', '01', '11', '10'], row[1:]):
            check(int(cell), v.calc(y, dict(zip('ABC', map(int, ab+row[0])))), ('P53 actual kmap', row))

    # 原始课程电路的延迟数值从候选中读取，输出时间来自事件仿真。
    sentence = p('RB-TH-12-051-example-steps')['items'][2]
    inv = int(re.search(r'B反相器(\d+)ns', sentence)[1])
    conjunction = int(re.search(r'每个与门(\d+)ns', sentence)[1])
    disjunction = int(re.search(r'末级或门(\d+)ns', sentence)[1])

    def y_net(ni, ap, aq, out, bridge=False):
        gates = {'NA': ('NOT', ['A'], ni), 'NB': ('NOT', ['B'], ni),
                 'n1': ('AND', ['NA', 'NB'], ap), 'n2': ('AND', ['B', 'C'], aq)}
        names = ['n1', 'n2']
        if bridge:
            gates['R'] = ('AND', ['NA', 'C'], 1)
            names.append('R')
        gates['Y'] = ('OR', names, out)
        return gates

    trace = simulate(y_net(inv, conjunction, conjunction, disjunction), {'A': 0, 'B': 1, 'C': 1}, [(0, 'B', 0)])
    for row in p('RB-TH-12-051-wave')['rows']:
        time = -1 if row[0] == 't<0' else int(row[0])
        env = [env for t, env in trace if t <= time][-1]
        check(list(map(int, row[1:])), [env[x] for x in ['B', 'NB', 'n1', 'n2', 'Y']], ('actual wave', time))
    example_events = edges(trace)
    check(example_events[0][1], example_events[-1][1], 'static1 same endpoint')
    check(min(x[1] for x in example_events), 0, 'static1 actual glitch')
    # 有限延迟网格只作压力复核；所有正延迟下的两级静态保证由共同覆盖证明给出。
    simulations = glitches = fixed_glitches = 0
    for ni, ap, aq, out in itertools.product(range(1, 4), repeat=4):
        for env in v.valuations('ABC'):
            for variable in 'ABC':
                for bridge in [False, True]:
                    network = y_net(ni, ap, aq, out, bridge)
                    tr = simulate(network, env, [(0, variable, 1-env[variable])])
                    seq = edges(tr)
                    simulations += 1
                    final = {**env, variable: 1-env[variable]}
                    check(tr[-1][1]['Y'], v.calc(safe_y if bridge else y, final), ('settling', env, variable, bridge))
                    glitch = seq[0][1] == seq[-1][1] and len(seq) > 1
                    if glitch:
                        if bridge:
                            fixed_glitches += 1
                        else:
                            glitches += 1
    assert glitches > 0
    check(fixed_glitches, 0, 'bridge eliminates all static events in finite grid')

    # 静态0自测与动态自测的输出期望读取正文，而非在脚本写死答案波形。
    toy = p('RB-TH-12-051-practice')['problem']
    inv0 = int(re.search(r'经(\d+)ns反相器', toy)[1])
    and0 = int(re.search(r'接(\d+)ns与门', toy)[1])
    static0 = simulate({'N': ('NOT', ['X'], inv0), 'Y': ('AND', ['X', 'N'], and0)}, {'X': 0}, [(0, 'X', 1)])
    toy_answer = p('RB-TH-12-051-practice-answer')['items'][0]
    claimed_static0 = [(-1, 0)] + [(int(t), int(level)) for t, _, level in
                       re.findall(r't=(\d+) Y([升降])([01])', toy_answer)]
    check(edges(static0), claimed_static0, 'actual static0 answer times/values')
    dynamic_problem = p('RB-TH-12-053-dynamic')['problem']
    gates = {}
    for name, op, args, delay in re.findall(r'([nPQY])=(NOT|AND|BUF|OR)\(([^)]+)\)，延迟(\d+)ns', dynamic_problem):
        gates[name] = (op, args.split(','), int(delay))
    assert len(gates) == 4
    dynamic_trace = simulate(gates, {'A': 0}, [(0, 'A', 1)])
    answer = p('RB-TH-12-053-dynamic-answer')['items'][1]
    candidate_edges = [(-1, 0)] + [(int(time), int(direction == '升'))
                       for time, direction in re.findall(r'(\d+)ns(?:再)?([升降])1?', answer)]
    check(edges(dynamic_trace), candidate_edges, 'actual dynamic answer times/values')
    assert len(candidate_edges) > 2 and candidate_edges[0][1] != candidate_edges[-1][1]
    assert '动态冒险' in answer
    for a in [0, 1]:
        check(simulate(gates, {'A': a}, [])[0][1]['Y'], a, ('dynamic stable function', a))

    strobe = p('RB-TH-12-053-strobe')['problem']
    f1 = re.search('F1=(.+?)、', strobe)[1]
    f2 = re.search('F2=(.+?)，', strobe)[1]
    f = re.search('输出F=(.+?)。', strobe)[1]
    for env in v.valuations(['A', 'B', 'C', 'p']):
        actual = v.calc(f, {**env, 'F1': v.calc(f1, env), 'F2': v.calc(f2, env)})
        check(actual, v.calc('AB′+BC', env) if env['p'] else 1, ('strobe polarity', env))

    # 例2.15：用原图拓扑枚举每个输入的路径，比较候选真正列出的表。
    base_graph = {'n1': {'A': 1, 'B': 1}, 'n2': {'n1': 1, 'C': 1},
                  'n3': {'D': 1, 'E': 1}, 'Y': {'n2': 1, 'n3': 1}}
    statement = p('RB-TH-12-054-example')['problem']
    pd = int(re.search(r'tpd=(\d+)ps', statement)[1])
    cd = int(re.search(r'tcd=(\d+)ps', statement)[1])
    costs = {x: path_costs(base_graph, x, 'Y') for x in 'ABCDE'}
    table = p('RB-TH-12-054-path-table')['rows']
    for row, inputs in zip(table[:3], ['AB', 'C', 'DE']):
        for inp in inputs:
            check((int(row[2]), int(row[3])), (max(costs[inp])*pd, min(costs[inp])*cd), ('actual 2.15 table', inp))
    check(tuple(map(int, table[3][2:])),
          (max(max(x) for x in costs.values())*pd, min(min(x) for x in costs.values())*cd), 'actual overall bounds')

    # 自测按实际非等门延迟加权，不能只数三个门。
    text = p('RB-TH-12-054-practice')['problem']
    apd, acd = map(int, re.search(r'AND的tpd/tcd=(\d+)/(\d+)ns', text).groups())
    opd, ocd = map(int, re.search(r'OR的tpd/tcd=(\d+)/(\d+)ns', text).groups())
    def weighted(a, o):
        return {'n1': {'A': a, 'B': a}, 'n2': {'n1': o, 'C': o}, 'Y': {'n2': a, 'D': a}}
    mx = {x: max(path_costs(weighted(apd, opd), x, 'Y')) for x in 'ABCD'}
    mn = {x: min(path_costs(weighted(acd, ocd), x, 'Y')) for x in 'ABCD'}
    rows = p('RB-TH-12-054-practice-table')['rows']
    for row, inputs in zip(rows[:3], ['AB', 'C', 'D']):
        for inp in inputs:
            check(tuple(map(int, row[1:])), (mx[inp], mn[inp]), ('actual weighted table', inp))
    check(tuple(map(int, rows[3][1:])), (max(mx.values()), min(mn.values())), 'actual weighted overall')

    # MUX端口加权图：权值是原页给定器件/端口参数，不是最终路径答案。
    gate_delays = p('RB-TH-12-054-mux-steps')['items'][0]
    val = lambda pattern: int(re.search(pattern+r'=(\d+)ps', gate_delays)[1])
    nt, a2, a3, o4, td, te = [val(x) for x in ['NOT', '二输入AND', '三输入AND', '四输入OR', '三态缓冲数据到输出', '使能到输出']]
    graphs = [
        {'INV': {'S': nt}, 'AND': {'INV': a3, 'S': a3, 'D': a3}, 'Y': {'AND': o4}},
        {'INV': {'S': nt}, 'EN': {'INV': a2, 'S': a2}, 'Y': {'EN': te, 'D': td}},
        {'FIRST': {'S': te, 'D': td}, 'Y': {'FIRST': td}},
    ]
    for graph, row in zip(graphs, p('RB-TH-12-054-mux-table')['rows']):
        actual = (int(re.search(r'\d+', row[1])[0]), int(row[2]))
        check(actual, (max(path_costs(graph, 'S', 'Y')), max(path_costs(graph, 'D', 'Y'))), ('actual mux port table', row[0]))

    report.update(status='passed', calculationComparisons=checks,
                  staticGaps={**found, 'P52': course_gaps, 'bareVariant': static_gaps(bare, 'ABCD')},
                  eventSimulations=simulations, originalStaticGlitches=glitches, bridgedStaticGlitches=fixed_glitches,
                  exampleEvents=example_events, dynamicEvents=edges(dynamic_trace),
                  method='actual candidate statements/tables; adjacency plus fixed-variable algebra; deterministic transport events; weighted DAG paths',
                  limits='finite delay grid is stress verification; coverage gives two-level/single-input static guarantee; no analog capacitor model')
    (HERE / 'verification-candidate.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
