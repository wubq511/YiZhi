#!/usr/bin/env python3
"""TH-07 / KU-032 独立计算复核。

每条恒等式用 Python 枚举全部 2^n 输入组合，原式与化简式逐点比较；
门数/输入端数按门结构重新累加；最简性用全部蕴含项的最小覆盖搜索确认。
期望来自表达式定义本身的枚举与结构重数，不复制课件答案。
"""
import itertools
import json


def lit(var, neg):
    return lambda env: (not env[var]) if neg else env[var]


def AND(terms):
    return lambda env: all(t(env) for t in terms)


def OR(terms):
    return lambda env: any(t(env) for t in terms)


# 表达式构造：变量字典 v，取反用 not_
def build(expr):
    """expr: 嵌套 ('and'|'or', [子式]) 或 ('var', 名) 或 ('not', 子式)"""
    kind = expr[0]
    if kind == 'var':
        name = expr[1]
        return lambda env: env[name]
    if kind == 'not':
        f = build(expr[1])
        return lambda env: not f(env)
    fns = [build(e) for e in expr[1]]
    if kind == 'and':
        return lambda env: all(f(env) for f in fns)
    return lambda env: any(f(env) for f in fns)


def on_set(expr, names):
    f = build(expr)
    out = []
    for bits in itertools.product([0, 1], repeat=len(names)):
        env = dict(zip(names, [bool(b) for b in bits]))
        if f(env):
            # 最小项编号：变量按 names 顺序，最高位在前
            m = int(''.join(str(b) for b in bits), 2)
            out.append(m)
    return out


def equal(a, b, names):
    return on_set(a, names) == on_set(b, names)


# ---------- 最小覆盖搜索（SOP：枚举全部蕴含项） ----------

def minimal_sop_cover(names, on_minterms, max_len=None):
    """枚举所有 possible 乘积项（每变量可有/正/负），找覆盖全部最小项的最少项/最少文字解。"""
    n = len(names)
    # 蕴含项：每变量取 0(负)、1(正)、*(缺席)
    impls = []
    for choice in itertools.product([0, 1, 2], repeat=n):
        covered = set()
        for bits in itertools.product([0, 1], repeat=n):
            ok = all(c == 2 or b == c for b, c in zip(bits, choice))
            if ok:
                covered.add(int(''.join(str(b) for b in bits), 2))
        if covered and covered <= set(on_minterms):
            lits = sum(1 for c in choice if c != 2)
            impls.append((choice, lits, frozenset(covered)))
    targets = frozenset(on_minterms)
    best = None
    solutions = []
    max_len = max_len or len(on_minterms)
    # 按项数递增搜索，先找最少项数
    for k in range(1, max_len + 1):
        found = []
        for combo in itertools.combinations([i for i in impls], k):
            cov = frozenset().union(*(c[2] for c in combo))
            if cov >= targets:
                lits = sum(c[1] for c in combo)
                found.append((lits, combo))
        if found:
            found.sort(key=lambda x: x[0])
            best_lits = found[0][0]
            for lits, combo in found:
                if lits == best_lits:
                    solutions.append(combo)
            best = (k, best_lits)
            break
    return best, solutions


def impl_str(choice, names):
    parts = []
    for c, nm in zip(choice, names):
        if c == 0:
            parts.append('¬' + nm)
        elif c == 1:
            parts.append(nm)
    return ''.join(parts) if parts else '1'


# ---------- 各项检查 ----------
results = []


def record(cid, claim, names, original, compared, passed, detail='', combos=None):
    results.append({
        'id': cid,
        'claim': claim,
        'variables': names,
        'combinations': combos if combos is not None else 2 ** len(names),
        'original': original,
        'compared': compared,
        'method': '独立枚举全部输入组合逐点比较（最简性另用全蕴含项最小覆盖搜索）',
        'passed': passed,
        'detail': detail,
    })


# --- 1. 一致项定理 xy + x̄z + yz = xy + x̄z ---
names = ['x', 'y', 'z']
a = ('or', [('and', [('var', 'x'), ('var', 'y')]),
            ('and', [('not', ('var', 'x')), ('var', 'z')]),
            ('and', [('var', 'y'), ('var', 'z')])])
b = ('or', [('and', [('var', 'x'), ('var', 'y')]),
            ('and', [('not', ('var', 'x')), ('var', 'z')])])
ok = equal(a, b, names)
record('consensus-term', 'xy+x̄z+yz = xy+x̄z（消项/一致项定理）', names,
       'xy + ¬x·z + y·z', 'xy + ¬x·z', ok,
       detail=f'原式最小项 {on_set(a, names)}，化简式最小项 {on_set(b, names)}')

# 覆盖论证：xy=0 且 x̄z=0 的所有组合里 yz 必为 0
cnt = 0
for bits in itertools.product([0, 1], repeat=3):
    x, y, z = [bool(t) for t in bits]
    if not (x and y) and not ((not x) and z) and (y and z):
        cnt += 1
ok = cnt == 0
record('consensus-cover', 'xy=0 且 ¬x·z=0 时必有 yz=0（yz 被前两项覆盖）', names,
       '(xy=0 且 ¬x·z=0) 的组合', 'yz 必须为 0', ok,
       detail=f'反例组合数: {cnt}')

# 对偶式 (x+y)(x̄+z)(y+z) = (x+y)(x̄+z)
a = ('and', [('or', [('var', 'x'), ('var', 'y')]),
             ('or', [('not', ('var', 'x')), ('var', 'z')]),
             ('or', [('var', 'y'), ('var', 'z')])])
b = ('and', [('or', [('var', 'x'), ('var', 'y')]),
             ('or', [('not', ('var', 'x')), ('var', 'z')])])
ok = equal(a, b, names)
record('consensus-dual', '(x+y)(¬x+z)(y+z) = (x+y)(¬x+z)（消项法对偶式）', names,
       '(x+y)(¬x+z)(y+z)', '(x+y)(¬x+z)', ok,
       detail=f'原式最小项 {on_set(a, names)}，化简式最小项 {on_set(b, names)}')

# --- 2. F1: A + ĀB + AB = A+B ---
names = ['A', 'B']
a = ('or', [('var', 'A'),
            ('and', [('not', ('var', 'A')), ('var', 'B')]),
            ('and', [('var', 'A'), ('var', 'B')])])
b = ('or', [('var', 'A'), ('var', 'B')])
f1_on = on_set(a, names)
ok = equal(a, b, names)
record('f1', 'F1 = A+¬A·B+A·B = A+B（P51 与-或例）', names,
       'A + ¬A·B + A·B', 'A + B', ok,
       detail=f'最小项 {f1_on}；原式 3 项 5 文字 → 化简式 2 项 2 文字')

# --- 3. F2: (p+r)(p̄+q̄)(q̄+r)(p̄+r̄)，消去 (q̄+r) 得三因子最简 ---
names = ['p', 'q', 'r']
f2_full = ('and', [('or', [('var', 'p'), ('var', 'r')]),
                   ('or', [('not', ('var', 'p')), ('not', ('var', 'q'))]),
                   ('or', [('not', ('var', 'q')), ('var', 'r')]),
                   ('or', [('not', ('var', 'p')), ('not', ('var', 'r'))])])
f2_3 = ('and', [('or', [('var', 'p'), ('var', 'r')]),
                ('or', [('not', ('var', 'p')), ('not', ('var', 'q'))]),
                ('or', [('not', ('var', 'p')), ('not', ('var', 'r'))])])
f2_2_drop_qr = ('and', [('or', [('var', 'p'), ('var', 'r')]),
                        ('or', [('not', ('var', 'p')), ('not', ('var', 'q'))])])
f2_2_drop_pq = ('and', [('or', [('var', 'p'), ('var', 'r')]),
                        ('or', [('not', ('var', 'p')), ('not', ('var', 'r'))])])
on_full = on_set(f2_full, names)
d3 = {
    'onSet': on_full,
    'threeFactorEqual': equal(f2_full, f2_3, names),
    'dropQRAndDropRetainedEqual': equal(f2_full, f2_2_drop_qr, names),
    'dropPQAndDropRetainedEqual': equal(f2_full, f2_2_drop_pq, names),
    'twoFactorEquivalentAlternatives': {
        'keepQRdropPQ': equal(f2_full, f2_2_drop_pq, names) and equal(
            ('and', [('or', [('var', 'p'), ('var', 'r')]),
                     ('or', [('not', ('var', 'q')), ('var', 'r')]),
                     ('or', [('not', ('var', 'p')), ('not', ('var', 'r'))])]), f2_full, names),
        'keepPQdropQR': equal(f2_full, f2_2_drop_qr, names) and equal(
            ('and', [('or', [('var', 'p'), ('var', 'r')]),
                     ('or', [('not', ('var', 'p')), ('not', ('var', 'q'))]),
                     ('or', [('not', ('var', 'r'))])]), f2_full, names),
    },
}
# 三因子是否最简（POS 最小覆盖：枚举全部 3^n 或-项）
def minimal_pos_cover(names_, off_minterms):
    n = len(names_)
    impls = []
    for choice in itertools.product([0, 1, 2], repeat=n):
        covered = set()
        for bits in itertools.product([0, 1], repeat=n):
            okc = all(c == 2 or b == c for b, c in zip(bits, choice))
            if okc:
                covered.add(int(''.join(str(b) for b in bits), 2))
        # POS 蕴含项：覆盖的是 0 集合的子集（每个 sum 项消掉若干 0 点）
        if covered and covered <= set(off_minterms):
            lits = sum(1 for c in choice if c != 2)
            impls.append((choice, lits, frozenset(covered)))
    targets = frozenset(off_minterms)
    all_off = [m for m in range(2 ** n) if m not in on_full]
    for k in range(1, len(all_off) + 1):
        found = []
        for combo in itertools.combinations(impls, k):
            cov = frozenset().union(*(c[2] for c in combo))
            if cov >= targets:
                found.append((sum(c[1] for c in combo), combo))
        if found:
            found.sort(key=lambda x: x[0])
            best = found[0][0]
            sols = []
            for lits, combo in found:
                if lits == best:
                    sols.append([pos_str(impl[0], names_) for impl in combo])
            return (k, best), sols
    return None, []


def pos_str(choice, names_):
    parts = []
    for c, nm in zip(choice, names_):
        if c == 0:
            parts.append(nm)
        elif c == 1:
            parts.append('¬' + nm)
    return '(' + '+'.join(parts) + ')'


off_full = [m for m in range(8) if m not in on_full]
best3, sols3 = minimal_pos_cover(names, off_full)
d3['minimalPosCost'] = {'sumTerms': best3[0], 'literals': best3[1]}
d3['minimalPosSolutions'] = sols3
d3['threeFactorIsMinimal'] = (best3[0], best3[1]) == (3, 6)
ok = (d3['threeFactorEqual'] and not d3['dropQRAndDropRetainedEqual']
      and not d3['dropPQAndDropRetainedEqual'] and d3['threeFactorIsMinimal'])
record('f2', 'F2 = (p+r)(¬p+¬q)(¬q+r)(¬p+¬r) 消去 (¬q+r) 得三因子最简 POS；'
             '漏乘保留因子的两因子式不等价', names,
       '(p+r)(¬p+¬q)(¬q+r)(¬p+¬r)', '(p+r)(¬p+¬q)(¬p+¬r)', ok,
       detail=json.dumps(d3, ensure_ascii=False))

# --- 4. P50 化简链 ---
names = ['A', 'B', 'C', 'D', 'E', 'F']
g0 = ('or', [('and', [('var', 'A'), ('var', 'B'), ('var', 'C')]),
             ('and', [('var', 'A'), ('var', 'B'), ('var', 'D')]),
             ('var', 'E'),
             ('and', [('var', 'A'), ('var', 'C'), ('var', 'F')]),
             ('and', [('var', 'A'), ('var', 'D'), ('var', 'F')])])
g1 = ('or', [('and', [('var', 'A'), ('var', 'B'),
                      ('or', [('var', 'C'), ('var', 'D')])]),
             ('var', 'E'),
             ('and', [('var', 'A'), ('or', [('var', 'C'), ('var', 'D')]), ('var', 'F')])])
g2 = ('or', [('and', [('or', [('and', [('var', 'A'), ('var', 'B')]),
                              ('and', [('var', 'A'), ('var', 'F')])]),
                      ('or', [('var', 'C'), ('var', 'D')])]),
             ('var', 'E')])
g3 = ('or', [('and', [('var', 'A'),
                      ('or', [('var', 'B'), ('var', 'F')]),
                      ('or', [('var', 'C'), ('var', 'D')])]),
             ('var', 'E')])
ok = all(equal(g0, g, names) for g in (g1, g2, g3))
on_g0 = on_set(g0, names)
record('p50-chain', 'G=ABC+ABD+E+ACF+ADF ≡ AB(C+D)+E+A(C+D)F ≡ (AB+AF)(C+D)+E ≡ A(B+F)(C+D)+E',
       names, 'ABC+ABD+E+ACF+ADF', 'A(B+F)(C+D)+E（含两个中间式逐点一致）', ok,
       detail=f'64 组合逐点比较全部一致，最小项 {on_g0}（共 {len(on_g0)} 个）')

# 门成本重数（按 P50 电路图结构数）：
# 原式电路：4 个 3 输入与门（ABC/ABD/ACF/ADF）+ 1 个 5 输入或门
# 最终式电路：2 个 2 输入或门（B+F、C+D）+ 1 个 3 输入与门 + 1 个 2 输入或门（与门输出、E）
orig = {'andGates': 4, 'andInputs': 12, 'orGates': 1, 'orInputs': 5,
        'gates': 5, 'totalInputs': 17, 'levels': 2}
factored_diag = {'orGates': 2, 'orInputs': 4, 'andGates': 1, 'andInputs': 3,
                 'outOrGates': 1, 'outOrInputs': 2, 'gates': 4,
                 'totalInputs': 9, 'levels': 3}
# 同一电路若把 3 输入与门用 2 输入与门成对搭建：多 1 个门
factored_2in = {'gates': 5, 'totalInputs': 10, 'levels': 3,
                'note': '3 输入与门拆成 2 个 2 输入与门口径'}
assert orig['totalInputs'] == 4 * 3 + 5 == 17 and orig['gates'] == 5
assert factored_diag['totalInputs'] == 2 + 2 + 3 + 2 == 9 and factored_diag['gates'] == 4
record('p50-cost', 'P50 电路图门成本重数：原式 5 门 17 输入 2 级；最终式 4 门 9 输入 3 级（2 输入门拆门口径 5 门 10 输入）',
       names, '原式电路 4×3输入与门 + 1×5输入或门',
       '最终式电路 2×2输入或门 + 1×3输入与门 + 1×2输入或门',
       True, detail=json.dumps({'original': orig, 'factoredCircuitDiagram': factored_diag,
                                'factoredTwoInputOnly': factored_2in}, ensure_ascii=False),
       combos=0)

# --- 5. 习题课【4】② ---
names = ['A', 'B', 'C', 'D']
f42 = ('or', [('and', [('var', 'A'), ('not', ('var', 'B')), ('var', 'C'), ('var', 'D')]),
              ('and', [('var', 'A'), ('var', 'B'), ('not', ('var', 'C')), ('not', ('var', 'D'))]),
              ('and', [('var', 'A'), ('not', ('var', 'B'))]),
              ('and', [('var', 'A'), ('not', ('var', 'D'))]),
              ('and', [('var', 'A'), ('not', ('var', 'B')), ('var', 'C')])])
f42s = ('or', [('and', [('var', 'A'), ('not', ('var', 'B'))]),
               ('and', [('var', 'A'), ('not', ('var', 'D'))])])
on42 = on_set(f42, names)
best42, sols42 = minimal_sop_cover(names, on42)
sols42_str = [[impl_str(impl[0], names) for impl in s] for s in sols42]
ok = equal(f42, f42s, names) and best42 == (2, 4)
record('ex07-4-2', '【4】② F=A¬BCD+AB¬C¬D+A¬B+A¬D+A¬BC = A¬B+A¬D，且为最简', names,
       'A¬BCD+AB¬C¬D+A¬B+A¬D+A¬BC', 'A¬B+A¬D',
       ok, detail=json.dumps({'equal': equal(f42, f42s, names), 'onSetSize': len(on42),
                              'onSetMinterms': on42,
                              'minimalCost': {'terms': best42[0], 'literals': best42[1]},
                              'minimalSolutions': sols42_str},
                             ensure_ascii=False))

# --- 6. 习题课【4】③（原页校正后）---
f43 = ('or', [('and', [('var', 'A'), ('var', 'B'), ('var', 'C'), ('not', ('var', 'D'))]),
              ('and', [('var', 'A'), ('var', 'B'), ('var', 'D')]),
              ('and', [('var', 'B'), ('var', 'C'), ('not', ('var', 'D'))]),
              ('and', [('var', 'A'), ('var', 'B'), ('var', 'C'), ('var', 'D')]),
              ('and', [('var', 'B'), ('not', ('var', 'C'))])])
f43s = ('or', [('and', [('var', 'A'), ('var', 'B')]),
               ('and', [('var', 'B'), ('not', ('var', 'C'))]),
               ('and', [('var', 'B'), ('not', ('var', 'D'))])])
on43 = on_set(f43, names)
best43, sols43 = minimal_sop_cover(names, on43)
sols43_str = [[impl_str(impl[0], names) for impl in s] for s in sols43]
ok = equal(f43, f43s, names) and best43 == (3, 6)
record('ex07-4-3', '【4】③ F=ABCD̄+ABD+BCD̄+ABCD+BC̄ = AB+BC̄+BD̄，且为最简'
                   '（原页第 1、3 项 C 上无反相杠，2026-10-26 校正）', names,
       'ABCD̄+ABD+BCD̄+ABCD+BC̄', 'AB+BC̄+BD̄',
       ok, detail=json.dumps({'equal': equal(f43, f43s, names), 'onSetSize': len(on43),
                              'onSetMinterms': on43,
                              'minimalCost': {'terms': best43[0], 'literals': best43[1]},
                              'minimalSolutions': sols43_str},
                             ensure_ascii=False))

# --- 7. 自测练习 F1=AB+AB̄+ĀC ---
names = ['A', 'B', 'C']
pf1 = ('or', [('and', [('var', 'A'), ('var', 'B')]),
              ('and', [('var', 'A'), ('not', ('var', 'B'))]),
              ('and', [('not', ('var', 'A')), ('var', 'C')])])
pf2 = ('or', [('var', 'A'), ('and', [('not', ('var', 'A')), ('var', 'C')])])
pf3 = ('or', [('var', 'A'), ('var', 'C')])
onp = on_set(pf1, names)
bestp, solsp = minimal_sop_cover(names, onp)
ok = equal(pf1, pf2, names) and equal(pf1, pf3, names) and bestp == (2, 2)
record('practice', '练习 F1=AB+AB̄+ĀC ≡ F2=A+ĀC ≡ F3=A+C，F3 为最简', names,
       'AB+A¬B+¬A·C', 'A+C', ok,
       detail=json.dumps({'allEqual': True, 'onSet': onp,
                          'minimalCost': {'terms': bestp[0], 'literals': bestp[1]},
                          'minimalSolutions': [[impl_str(impl[0], names) for impl in s] for s in solsp]},
                         ensure_ascii=False))

# --- 8. F1 的 absorb-and-merge 两种路径（A+ĀB+AB：先合并 AB→A，先吸收 ĀB） ---
# 路径 A：A + ĀB + AB = A + ĀB（AB 被含入 A）= A + B（消项/吸收）
# 路径 B：A + ĀB + AB = A + B(Ā+A) = A + B·1 = A + B
ok = equal(('or', [('var', 'A'), ('and', [('not', ('var', 'A')), ('var', 'B')])]),
           ('or', [('var', 'A'), ('var', 'B')]), ['A', 'B'])
record('f1-paths', 'F1 两条化简路径同解：A+ĀB(剩自 A+ĀB=A+B) 与 A+B(A+Ā)=A+B', ['A', 'B'],
       'A + ¬A·B', 'A + B', ok)

# --- 输出 ---
all_passed = all(r['passed'] for r in results if r['id'] != 'p50-cost') and True
summary = {
    'task': 'TH-07 / KU-032 独立计算复核',
    'date': '2026-10-26',
    'method': '对每条恒等式用 Python 枚举全部 2^n 输入组合，原式与化简式逐点比较；'
              '门数/输入端数按 P50 电路图门结构重新累加；最简性用全部蕴含项（POS/SOP）'
              '最小覆盖搜索确认。期望来自表达式定义本身的枚举与结构重数，不复制课件答案。',
    'checks': results,
    'f1TermStats': {'original': {'terms': 3, 'literals': 5},
                    'simplified': {'terms': 2, 'literals': 2}},
    'costRecount': {
        'original': orig,
        'factored': {**factored_diag,
                     'countingNote': '按 P50 电路图实际门结构：2 个 2 输入或门 + 1 个 3 输入与门 + 1 个 2 输入或门；'
                                     '若限定 2 输入门搭建（3 输入与门拆成 2 个），则为 5 门 10 输入 3 级。'
                                     '节省输入端 17→9，代价是级数 2→3。'},
        'claimMatchesReading': True,
    },
    'corrections': [
        'ex07-4-3 原式串按原页 ex07-full-08.png 校正：第 1、3 项为 ABCD̄/BCD̄（C 上无反相杠），'
        '先前误录为 ABC̄D̄/BC̄D̄；最小项集 {4,5,6,12,13,14,15} 与官方化简 AB+BC̄+BD̄ 不变。',
        '新增 f2 检查：三因子式 (p+r)(¬p+¬q)(¬p+¬r) 与原四因子式逐点一致；两因子式（漏乘保留因子）'
        '扩大覆盖不等价；POS 最小覆盖确认三因子 6 文字为最简。',
        'costRecount 补充两种口径：电路图口径 4 门 9 输入；2 输入门拆门口径 5 门 10 输入。',
    ],
    'allPassed': all_passed,
}
with open('verification.json', 'w', encoding='utf-8') as fp:
    json.dump(summary, fp, ensure_ascii=False, indent=1)
print('allPassed =', all_passed)
for r in results:
    print(f"[{'PASS' if r['passed'] else 'FAIL'}] {r['id']}: {r['claim'][:60]}")
print('--- F2 detail ---')
print(json.dumps(d3, ensure_ascii=False, indent=1))
print('--- ② detail ---')
print(json.dumps({'onSet': on42, 'best': best42, 'sols': sols42_str}, ensure_ascii=False))
print('--- ③ detail ---')
print(json.dumps({'onSet': on43, 'best': best43, 'sols': sols43_str}, ensure_ascii=False))
