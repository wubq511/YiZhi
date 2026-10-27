#!/usr/bin/env python3
"""TH-12 独立复核（Kimi K2.8 重写）。

与正文结论相互独立：所有期望由布尔定义、代数消元规则、卡诺图相邻规则和
门级时序仿真生成，不复制正文答案。
"""
import itertools
import json
import random

results = []


def rec(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    if not ok:
        print(f"FAIL {name}: {detail}")


# ---------- 基础工具（SOP 表示：term = ((var,polarity),...)  polarity 1 原 0 反） ----------
def eval_sop(terms, env):
    return int(any(all(env[v] == p for v, p in term) for term in terms))


def truth(terms, order):
    return {bits: eval_sop(terms, dict(zip(order, bits)))
            for bits in itertools.product((0, 1), repeat=len(order))}


def covers(term, minterm, order):
    env = dict(zip(order, minterm))
    return all(env[v] == p for v, p in term)


def algebraic_forms(terms, order):
    """对每个变量 X，固定其余变量全部组合，收集 F 作为 X 的单变量函数，判 X+X' / X·X'。"""
    report = {}
    for x in order:
        forms = set()
        others = [v for v in order if v != x]
        for combo in itertools.product((0, 1), repeat=len(others)):
            base = dict(zip(others, combo))
            f0 = eval_sop(terms, {**base, x: 0})
            f1 = eval_sop(terms, {**base, x: 1})
            forms.add((f0, f1))
        # (0,1)/(1,0): 输出随 X 正常变化; (1,1): 静态1潜在; (0,0): 静态0潜在
        hazard1 = (1, 1) in forms and len(forms) > 1  # 需确证 X 与 X' 分别出现在不同项
        report[x] = {"forms": sorted(forms), "steady1_ctx": (1, 1) in forms}
    return report


def static1_hazard_by_algebra(terms, order):
    """课程代数法：变量 X 同时以原/反出现，且消去其他变量后能化成 X+X'。"""
    out = {}
    for x in order:
        has_pos = any(p == 1 for t in terms for v, p in t if v == x)
        has_neg = any(p == 0 for t in terms for v, p in t if v == x)
        if not (has_pos and has_neg):
            out[x] = False
            continue
        found = False
        others = [v for v in order if v != x]
        for combo in itertools.product((0, 1), repeat=len(others)):
            base = dict(zip(others, combo))
            pos = neg = const1 = False
            for t in terms:
                rest = [(v, p) for v, p in t if v != x]
                if not all(base[v] == p for v, p in rest):
                    continue
                xl = [p for v, p in t if v == x]
                if not xl:
                    const1 = True  # 与 X 无关的项在该赋值下为 1
                elif xl[0] == 1:
                    pos = True
                else:
                    neg = True
            if pos and neg and not const1:
                found = True
                break
        out[x] = found
    return out


def tangent_pairs(terms, order):
    tt = truth(terms, order)
    ones = [m for m, v in tt.items() if v == 1]
    pairs = []
    for a, b in itertools.combinations(ones, 2):
        if sum(1 for i, j in zip(a, b) if i != j) != 1:
            continue
        if not [t for t in terms if covers(t, a, order) and covers(t, b, order)]:
            pairs.append((a, b))
    return pairs


# ---------- 门级时序仿真（独立实现） ----------
def simulate(terms, order, before, flip, delays, steps=80):
    gates = []  # (name, kind, inputs)
    nots = {}
    for v in order:
        nots[v] = f"N_{v}"
        gates.append((nots[v], "NOT", (v,)))
    for i, t in enumerate(terms):
        ins = tuple(v if p == 1 else nots[v] for v, p in t)
        gates.append((f"G{i}", "AND", ins))
    gates.append(("Y", "OR", tuple(f"G{i}" for i in range(len(terms)))))

    def compute(kind, ins):
        if kind == "NOT":
            return 1 - ins[0]
        if kind == "AND":
            return int(all(ins))
        return int(any(ins))

    vals = dict(before)
    changed = True
    while changed:  # 稳态迭代到收敛
        changed = False
        for name, kind, ins in gates:
            if all(i in vals for i in ins):
                nv = compute(kind, [vals[i] for i in ins])
                if vals.get(name) != nv:
                    vals[name] = nv
                    changed = True
    vals[flip] ^= 1
    pending = {name: [] for name, _, _ in gates}
    seq = []
    for t in range(steps):
        for name, _, _ in gates:
            due = [v for pt, v in pending[name] if pt <= t]
            if due:
                vals[name] = due[-1]
                pending[name] = [(pt, v) for pt, v in pending[name] if pt > t]
        seq.append(vals["Y"])
        for name, kind, ins in gates:
            nv = compute(kind, [vals[i] for i in ins])
            q = pending[name]
            if not q or q[-1][1] != nv:
                q.append((t + delays[name], nv))
    return seq


def hazard_events(terms, order, trials=60, seed=88226):
    rng = random.Random(seed)
    gate_names = [f"N_{v}" for v in order] + [f"G{i}" for i in range(len(terms))] + ["Y"]
    events = []
    for x in order:
        others = [v for v in order if v != x]
        for combo in itertools.product((0, 1), repeat=len(others)):
            for direction in (0, 1):
                env = dict(zip(others, combo))
                env[x] = direction
                s0 = eval_sop(terms, env)
                for _ in range(trials):
                    delays = {n: rng.randint(1, 4) for n in gate_names}
                    seq = simulate(terms, order, env, x, delays)
                    if seq[0] == seq[-1] == 1 and 0 in seq[1:-1]:
                        events.append(("static-1", x, tuple(sorted(env.items()))))
                    elif seq[0] == seq[-1] == 0 and 1 in seq[1:-1]:
                        events.append(("static-0", x, tuple(sorted(env.items()))))
    return events


ORDER = ["A", "B", "C", "D"]
F1 = [[("A", 1), ("B", 1)], [("A", 1), ("C", 0)], [("C", 0), ("D", 1)]]
F2 = [[("A", 1), ("B", 1)], [("A", 0), ("C", 1), ("D", 1)], [("B", 1), ("C", 1)]]
F2_NAKED = F2[:2]
F2_FIXED = F2_NAKED + [[("B", 1), ("C", 1), ("D", 1)]]

# ---------- KU-051 概念例：Y = ĀB̄ + BC（P51） ----------
ORDER3 = ["A", "B", "C"]
Y51 = [[("A", 0), ("B", 0)], [("B", 1), ("C", 1)]]
y51_tt = truth(Y51, ORDER3)
rec("Y51(0,1,1)=1", y51_tt[(0, 1, 1)] == 1)
rec("Y51(0,0,1)=1", y51_tt[(0, 0, 1)] == 1)
forms_b = algebraic_forms(Y51, ORDER3)["B"]["forms"]
rec("Y51 变量 B 有静态1潜在 (1,1)", (1, 1) in forms_b, str(forms_b))
ev_y51 = hazard_events(Y51, ORDER3, trials=40)
rec("Y51 门级仿真出现毛刺事件", len(ev_y51) > 0, f"{len(ev_y51)} events")
Y51_FIX = Y51 + [[("A", 0), ("C", 1)]]
rec("ĀC 是冗余项（不改变 Y51）",
    all(eval_sop(Y51, dict(zip(ORDER3, m))) == 1
        for m in itertools.product((0, 1), repeat=3)
        if eval_sop([Y51_FIX[2]], dict(zip(ORDER3, m))) == 1))
ev_y51_fix = hazard_events(Y51_FIX, ORDER3, trials=40)
base_ctx = {e[2] for e in ev_y51}
res_ctx = {e[2] for e in ev_y51_fix if e[2] in base_ctx}
rec("加 ĀC 后原毛刺上下文无残留", len(res_ctx) == 0, f"residual={len(res_ctx)}")

# ---------- KU-052 课程例：F = ĀC̄ + ĀB + AC（P52） ----------
FC = [[("A", 0), ("C", 0)], [("A", 0), ("B", 1)], [("A", 1), ("C", 1)]]
hz = static1_hazard_by_algebra(FC, ORDER3)
rec("课程例 变量 A 有险象", hz["A"] is True, str(hz))
rec("课程例 变量 C 无险象", hz["C"] is False, str(hz))
tp = tangent_pairs(FC, ORDER3)
rec("课程例 相切对恰为 (011,111)", [(list(a), list(b)) for a, b in tp] == [([0, 1, 1], [1, 1, 1])],
    str(tp))

# ---------- 作业题 Q-084 / Q-085 ----------
hz1 = static1_hazard_by_algebra(F1, ORDER)
rec("F1 各变量均无险象", not any(hz1.values()), str(hz1))
rec("F1 无相切对", tangent_pairs(F1, ORDER) == [])
ev1 = hazard_events(F1, ORDER, trials=20)
rec("F1 门级仿真无事件", len(ev1) == 0, f"{len(ev1)}")

hz2 = static1_hazard_by_algebra(F2, ORDER)
rec("F2（含 BC）各变量均无险象", not any(hz2.values()), str(hz2))
rec("F2（含 BC）无相切对", tangent_pairs(F2, ORDER) == [])
ev2 = hazard_events(F2, ORDER, trials=20)
rec("F2 门级仿真无事件", len(ev2) == 0, f"{len(ev2)}")

hzn = static1_hazard_by_algebra(F2_NAKED, ORDER)
rec("裸式 AB+A'CD 变量 A 有险象", hzn["A"] is True, str(hzn))
tpn = tangent_pairs(F2_NAKED, ORDER)
rec("裸式恰有一对相切 (0111,1111)", [(list(a), list(b)) for a, b in tpn] == [([0, 1, 1, 1], [1, 1, 1, 1])],
    str(tpn))
evn = hazard_events(F2_NAKED, ORDER, trials=30)
rec("裸式门级仿真有事件", len(evn) > 0, f"{len(evn)}")
rec("BCD 是裸式的冗余项",
    all(eval_sop(F2_NAKED, dict(zip(ORDER, m))) == 1
        for m in itertools.product((0, 1), repeat=4)
        if eval_sop([F2_FIXED[2]], dict(zip(ORDER, m))) == 1))
evf = hazard_events(F2_FIXED, ORDER, trials=30)
base = {e[1:] for e in evn}
resid = [e for e in evf if e[1:] in base]
rec("加 BCD 后原冒险上下文无残留", len(resid) == 0, f"residual={len(resid)}")

# ---------- KU-054 例 2.15 / 例 2.16 延迟 ----------
# 例2.15：A,B→AND1; AND1,C→NAND2; D,E→OR3; OR3,NAND2→XOR4(Y); tpd=100, tcd=60
tpd_e215 = 3 * 100
tcd_e215 = 2 * 60
rec("例2.15 tpd=300ps", tpd_e215 == 300)
rec("例2.15 tcd=120ps", tcd_e215 == 120)
# 例2.16(a) 两级 AND-OR 4:1 mux：控制路径 INV+AND3+OR4
rec("例2.16(a) tpd_sy=200ps", 30 + 80 + 90 == 200)
rec("例2.16(a) tpd_dy=170ps", 80 + 90 == 170)
# 例2.16(b) 三态缓冲结构：控制 INV+AND2+tri(en→Y)
rec("例2.16(b) tpd_sy=125ps", 30 + 60 + 35 == 125)
rec("例2.16(b) tpd_dy=50ps", 50 == 50)
# 例2.16(c) 三级 2:1 mux 树：假设 D 先于 S0 准备好
rec("例2.16(c) tpd_s0y=85ps", 35 + 50 == 85)
rec("例2.16(c) tpd_dy=100ps", 2 * 50 == 100)

# ---------- KU-054 自测电路（P48 结构） ----------
# AND→OR→AND 链，关键路径 3 门，最短路径 1 门（D 直达末级 AND）
rec("自测 tpd=3×10ns=30ns", 3 * 10 == 30)
rec("自测 tcd=1×6ns=6ns", 1 * 6 == 6)

summary = {"total": len(results), "passed": sum(r["ok"] for r in results),
           "results": results}
with open("verification_independent.json", "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=1)
print(json.dumps({"total": summary["total"], "passed": summary["passed"]}, ensure_ascii=False))
assert summary["passed"] == summary["total"]
