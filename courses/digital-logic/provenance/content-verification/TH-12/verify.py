#!/usr/bin/env python3
"""TH-12 / KU-051 独立复核：F1/F2 的稳态真值表、单变量翻转冒险扫描与冗余项消除效果。

方法与正文答案相互独立：
1. 稳态真值表：纯布尔枚举，不依赖任何时序假设。
2. 潜在冒险上下文：对每个输入变量 X，在所有其余变量组合下比较 X=0 与 X=1 的稳态输出，
   稳态不变的组合是潜在静态冒险点（是否真发生取决于门延迟）。
3. 门级时序仿真：固定电路结构（每变量一根共享反相器、每项一个 AND、一个 OR），
   给每道门独立随机延迟，翻转单个输入，观察输出序列是否出现与稳态不符的瞬态。
   多组随机延迟重复，只要出现一次即判定"可能产生冒险"。这是与代数法无关的独立判据。
4. 卡诺图相切独立判定：对每个相邻 1 格对，检查是否存在同时覆盖两格的乘积项。
"""
import itertools
import json
import random


def eval_sop(terms, env):
    """terms: list of list of literal (var, polarity: 1=原变量, 0=反变量). env: dict var->0/1."""
    return int(any(all(env[v] == p for v, p in term) for term in terms))


def truth_table(terms, order):
    rows = {}
    for bits in itertools.product((0, 1), repeat=len(order)):
        env = dict(zip(order, bits))
        rows[bits] = eval_sop(terms, env)
    return rows


def covers(term, minterm, order):
    env = dict(zip(order, minterm))
    return all(env[v] == p for v, p in term)


def adjacency_pair_coverage(terms, order):
    """相邻 1 格对中，是否存在同时覆盖两格的乘积项（无公共覆盖 = 相切 = 冒险）。"""
    tt = truth_table(terms, order)
    ones = [m for m, v in tt.items() if v == 1]
    tangent = []
    for a, b in itertools.combinations(ones, 2):
        if sum(1 for x, y in zip(a, b) if x != y) != 1:
            continue
        if not [t for t in terms if covers(t, a, order) and covers(t, b, order)]:
            tangent.append((a, b))
    return tangent


def gate_compute(kind, ins):
    if kind == "NOT":
        return 1 - ins[0]
    if kind == "AND":
        return int(all(ins))
    return int(any(ins))


def build_circuit(terms, order):
    """返回 (gates, out_name)；gate = (name, kind, inputs)。每变量共享一根反相器。"""
    gates = []
    nots = {}
    for v in order:
        nots[v] = f"n_not_{v}"
        gates.append((nots[v], "NOT", [v]))
    for i, term in enumerate(terms):
        ins = [v if p == 1 else nots[v] for v, p in term]
        gates.append((f"and{i}", "AND", ins))
    gates.append(("Y", "OR", [f"and{i}" for i in range(len(terms))]))
    return gates, "Y"


def steady_values(gates, env):
    vals = dict(env)
    while True:
        new = dict(vals)
        for name, kind, ins in gates:
            if all(x in vals for x in ins):
                new[name] = gate_compute(kind, [vals[x] for x in ins])
        if new == vals:
            return vals
        vals = new


def simulate_timed(terms, order, before_env, flip_var, delays, steps=60):
    """t=0 时刻翻转 flip_var，返回输出 Y 的时间序列（含翻转后的稳态尾段）。"""
    gates, out = build_circuit(terms, order)
    vals = steady_values(gates, before_env)
    vals[flip_var] ^= 1
    pending = {name: [] for name, _, _ in gates}
    seq = []
    for t in range(steps):
        for name, _, _ in gates:
            q = pending[name]
            due = [v for pt, v in q if pt <= t]
            if due:
                vals[name] = due[-1]
                pending[name] = [(pt, v) for pt, v in q if pt > t]
        seq.append(vals[out])
        for name, kind, ins in gates:
            newv = gate_compute(kind, [vals[x] for x in ins])
            q = pending[name]
            if not q or q[-1][1] != newv:
                q.append((t + delays[name], newv))
            pending[name] = q
    return seq


def scan(terms, order, trials=40, seed=20261025):
    """返回 (潜在静态冒险上下文列表, 实测冒险事件列表)。"""
    latent, events = [], []
    rng = random.Random(seed)
    gates, _ = build_circuit(terms, order)
    for x in order:
        others = [v for v in order if v != x]
        for combo in itertools.product((0, 1), repeat=len(others)):
            env0 = dict(zip(others, combo))
            env0[x] = 0
            s0 = eval_sop(terms, env0)
            env1 = dict(env0)
            env1[x] = 1
            s1 = eval_sop(terms, env1)
            if s0 == s1:
                latent.append((x, dict(env0), s0))
            for _ in range(trials):
                delays = {}
                for name, kind, _ in gates:
                    if kind == "NOT":
                        delays[name] = rng.choice((1, 1, 2))
                    elif kind == "AND":
                        delays[name] = rng.choice((1, 2, 3))
                    else:
                        delays[name] = rng.choice((1, 1, 2))
                for direction in (0, 1):
                    e0 = dict(env0)
                    e0[x] = direction
                    seq = simulate_timed(terms, order, e0, x, delays)
                    start, end = seq[0], seq[-1]
                    mid = seq[2:-2] if len(seq) > 4 else []
                    if start == end == 1 and 0 in mid:
                        events.append(("static-1", x, dict(env0), "1->0->1"))
                    elif start == end == 0 and 1 in mid:
                        events.append(("static-0", x, dict(env0), "0->1->0"))
                    elif start != end:
                        flips = sum(1 for a, b in zip(seq, seq[1:]) if a != b)
                        if flips > 1:
                            events.append(("dynamic", x, dict(env0), f"{flips} flips"))
    return latent, events


def check_remediation(name, base_terms, extra_terms, order, trials=40, seed=20261025):
    """验证：加入冗余项后，原冒险上下文中不再仿真出冒险。"""
    base_latent, base_events = scan(base_terms, order, trials=trials, seed=seed)
    fixed_terms = base_terms + extra_terms
    # 冗余项判据：加入项对 base 函数是冗余的（任意使加入项为 1 的点 base 已为 1）
    redundancy_ok = all(
        eval_sop(base_terms, dict(zip(order, m))) == 1
        for m in itertools.product((0, 1), repeat=len(order))
        if eval_sop(extra_terms, dict(zip(order, m))) == 1
    )
    _, fixed_events = scan(fixed_terms, order, trials=trials, seed=seed)
    # fixed_events 只统计 base 冒险上下文内的事件
    ctx_of = lambda e: (e[1], tuple(sorted(e[2].items())))
    base_ctxs = {ctx_of(e) for e in base_events}
    residual = [e for e in fixed_events if ctx_of(e) in base_ctxs]
    print(f"== {name}")
    print(f"   base: events={len(base_events)}")
    print(f"   加入项是冗余项(不改变函数)={redundancy_ok}, 原冒险点残留事件={len(residual)}")
    for e in residual[:6]:
        print("   residual:", e)
    return {
        "base_events": len(base_events),
        "extra_term_redundant": redundancy_ok,
        "residual_events": len(residual),
    }


def main():
    order = ["A", "B", "C", "D"]
    f1 = [
        [("A", 1), ("B", 1)],
        [("A", 1), ("C", 0)],
        [("C", 0), ("D", 1)],
    ]
    f2 = [
        [("A", 1), ("B", 1)],
        [("A", 0), ("C", 1), ("D", 1)],
        [("B", 1), ("C", 1)],
    ]
    report = {}
    for name, terms in (("F1 = AB + AC' + C'D", f1), ("F2 = AB + A'CD + BC", f2)):
        latent, events = scan(terms, order)
        tangent = adjacency_pair_coverage(terms, order)
        report[name] = {
            "terms": [[[v, p] for v, p in t] for t in terms],
            "latent_static_contexts": [
                {"var": x, "env": ctx, "steady": s} for x, ctx, s in latent
            ],
            "simulated_hazard_events": [
                {"kind": k, "var": x, "env": ctx, "detail": d}
                for k, x, ctx, d in events
            ][:40],
            "hazard_context_summary": sorted(
                {f"{x}@{ctx}" for _, x, ctx, _ in events}
            ),
            "tangent_pairs_no_common_cover": [[list(a), list(b)] for a, b in tangent],
        }
        print(f"== {name}")
        print(f"   latent static ctx: {len(latent)}; sim hazard events: {len(events)}; "
              f"tangent pairs: {len(tangent)}")
        print("   contexts:", report[name]["hazard_context_summary"])
        for p in tangent[:8]:
            print("   tangent pair:", p)
    # F1：卡诺图无相切对 → 无需冗余项（结论单独记录，不做无意义的"加已存在项"）
    report["F1_conclusion"] = {
        "tangent_pairs": 0,
        "simulated_hazard_events": 0,
        "needs_redundancy": False,
        "note": "F1 已含 AB，且全部相邻 1 格对有公共覆盖项，无静态险象，无需加冗余项",
    }
    # F2 设问点验证：去掉 BC 的裸式 AB + A'CD 存在冒险，加冗余项 BC 后消除
    f2_naked = [
        [("A", 1), ("B", 1)],
        [("A", 0), ("C", 1), ("D", 1)],
    ]
    latent_n, events_n = scan(f2_naked, order)
    tangent_n = adjacency_pair_coverage(f2_naked, order)
    report["F2_without_BC = AB + A'CD"] = {
        "terms": [[[v, p] for v, p in t] for t in f2_naked],
        "simulated_hazard_events": [
            {"kind": k, "var": x, "env": ctx, "detail": d}
            for k, x, ctx, d in events_n
        ][:40],
        "hazard_context_summary": sorted({f"{x}@{ctx}" for _, x, ctx, _ in events_n}),
        "tangent_pairs_no_common_cover": [[list(a), list(b)] for a, b in tangent_n],
    }
    print("== F2 without BC")
    print(f"   sim hazard events: {len(events_n)}; tangent pairs: {len(tangent_n)}")
    print("   contexts:", report["F2_without_BC = AB + A'CD"]["hazard_context_summary"])
    report["F2_remediation (加 consensus 冗余项 BCD)"] = check_remediation(
        "F2 without BC + BCD", f2_naked, [[("B", 1), ("C", 1), ("D", 1)]], order)
    # 对照：BC 虽也能覆盖切对消除险象，但它不是冗余项（额外覆盖 0110 格，改变函数）
    report["F2_remediation_check (对照：加 BC)"] = check_remediation(
        "F2 without BC + BC (changes function)", f2_naked, [[("B", 1), ("C", 1)]], order)
    with open("verification_raw.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("saved verification_raw.json")


if __name__ == "__main__":
    main()

# ---- 真值表抽查（验证题解结论的抽样点，独立于 main 的扫描逻辑）----
F1_TERMS = [[("A", 1), ("B", 1)], [("A", 1), ("C", 0)], [("C", 0), ("D", 1)]]
F2_TERMS = [[("A", 1), ("B", 1)], [("A", 0), ("C", 1), ("D", 1)], [("B", 1), ("C", 1)]]
F2_NAKED = [[("A", 1), ("B", 1)], [("A", 0), ("C", 1), ("D", 1)]]

def _f(terms, a, b, c, d):
    return eval_sop(terms, {"A": a, "B": b, "C": c, "D": d})

spot_checks = [
    ("F1(1101)=1（AB 项）", _f(F1_TERMS, 1, 1, 0, 1), 1),
    ("F1(0101)=1（C'D 项）", _f(F1_TERMS, 0, 1, 0, 1), 1),
    ("F1(0110)=0（三与项均为 0）", _f(F1_TERMS, 0, 1, 1, 0), 0),
    ("F2(0110)=1（BC 项）", _f(F2_TERMS, 0, 1, 1, 0), 1),
    ("F2(0110)：AB=0 且 A'CD=0，仅 BC 覆盖", int(_f(F2_NAKED, 0, 1, 1, 0) == 0), 1),
    ("裸式F2(0110)=0（去掉 BC 后该格变 0）", _f(F2_NAKED, 0, 1, 1, 0), 0),
    ("BCD 是冗余项：裸式F2(0111)=1 已由 AB 覆盖", _f(F2_NAKED, 0, 1, 1, 1), 1),
    ("裸式F2(1111)=1（A 变化切对两格均为 1）", _f(F2_NAKED, 1, 1, 1, 1), 1),
]
spot_results = []
for name, got, want in spot_checks:
    ok = got == want
    spot_results.append({"check": name, "got": got, "want": want, "ok": ok})
    if not ok:
        print(f"SPOT FAIL: {name}: got {got}, want {want}")
if not all(r["ok"] for r in spot_results):
    sys.exit(1)
print(f"Spot checks passed: {len(spot_results)}")

from pathlib import Path as _P
raw = json.loads(_P("verification_raw.json").read_text(encoding="utf-8"))
raw["spot_checks"] = spot_results
raw["spot_checks_summary"] = {"total": len(spot_results), "passed": sum(r["ok"] for r in spot_results)}
_P("verification.json").write_text(json.dumps(raw, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print("saved verification.json")
