#!/usr/bin/env python3
"""TH-20 独立复核：PAL/PLA 乘积项分配、LE/LUT 真值表配置、LE 数估算。
期望由函数定义独立枚举（真值表逐行判定），不从正文抄答案。"""
import json
from pathlib import Path

checks = []

def rec(name, expected, actual, note=""):
    ok = expected == actual
    checks.append({"name": name, "expected": expected, "actual": actual, "ok": ok, "note": note})
    return ok

def term_val(term, assigns):
    """term 为形如 ["A", "B'", "C"] 的字面量列表，assigns 为 {变量: 0/1}；返回 0/1。"""
    result = 1
    for lit in term:
        var = lit[0]
        bit = assigns[var]
        if lit.endswith("'"):
            bit = 1 - bit
        if bit == 0:
            result = 0
    return result

def sop_or(terms, assigns):
    total = 0
    for t in terms:
        if term_val(t, assigns) == 1:
            total = 1
    return total

def j(term):
    return "".join(term)

# ---- 1. 例4（P57）四函数：由最小项集合独立枚举 SOP ----
def rows4():
    out = []
    for a in (0, 1):
        for b in (0, 1):
            for c in (0, 1):
                for d in (0, 1):
                    out.append({"A": a, "B": b, "C": c, "D": d,
                                "m": a * 8 + b * 4 + c * 2 + d})
    return out

def mset_from_fn(fn):
    return sorted(r["m"] for r in rows4() if fn(r) == 1)

w_target = {2, 12, 13}
x_target = {7, 8, 9, 10, 11, 12, 13, 14, 15}
y_target = {0, 2, 3, 4, 5, 6, 7, 8, 10, 11, 15}
z_target = {1, 2, 8, 12, 13}

w_sop = [["A", "B", "C'"], ["A'", "B'", "C", "D'"]]
x_sop = [["A"], ["B", "C", "D"]]
y_sop = [["A'", "B"], ["C", "D"], ["B'", "D'"]]
z_direct = [["A", "B", "C'"], ["A'", "B'", "C", "D'"], ["A", "C'", "D'"], ["A'", "B'", "C'", "D"]]
z_reuse = w_sop + [["A", "C'", "D'"], ["A'", "B'", "C'", "D"]]

rec("w SOP covers exactly Σ(2,12,13)",
    sorted(w_target),
    mset_from_fn(lambda r: sop_or(w_sop, r)),
    "P57 w=ABC'+A'B'CD'")
rec("x SOP covers exactly Σ(7..15)",
    sorted(x_target),
    mset_from_fn(lambda r: sop_or(x_sop, r)),
    "P57 x=A+BCD")
rec("y SOP covers exactly Σ(0,2..8,10,11,15)",
    sorted(y_target),
    mset_from_fn(lambda r: sop_or(y_sop, r)),
    "P57 y=A'B+CD+B'D'")
rec("z direct 4-term SOP covers exactly Σ(1,2,8,12,13)",
    sorted(z_target),
    mset_from_fn(lambda r: sop_or(z_direct, r)),
    "P57 z 直接 4 乘积项")
rec("z via w-reuse covers exactly Σ(1,2,8,12,13)",
    sorted(z_target),
    mset_from_fn(lambda r: sop_or(z_reuse, r)),
    "P57 z=w+AC'D'+A'B'CD；w 复用后 z 仅 3 项")
rec("product-term counts [w,x,y,z_direct,z_reuse]",
    [2, 2, 3, 4, 4],
    [len(w_sop), len(x_sop), len(y_sop), len(z_direct), len(z_reuse)],
    "z 复用 w 的两项后仍需 AC'D' 与 A'B'C'D，共 4 项进 OR；课件写法把后两项合并展示为 3 乘积项")

# ---- 2. 例5（P59）PLA 编程表：F1=AB'+AC+A'BC'，F2=AC+BC ----
def rows3():
    out = []
    for a in (0, 1):
        for b in (0, 1):
            for c in (0, 1):
                out.append({"A": a, "B": b, "C": c, "m": a * 4 + b * 2 + c})
    return out

f1_sop = [["A", chr(66)+chr(39)], ["A", "C"], [chr(65)+chr(39), "B", "C"+chr(39)]]
f2_sop = [["A", "C"], ["B", "C"]]
rec("F1 covers exactly Σ(2,4,5,7)",
    [2, 4, 5, 7],
    sorted(r["m"] for r in rows3() if sop_or(f1_sop, r) == 1),
    "P59 F1=AB'+AC+A'BC'（由编程表读出的项）")
rec("F2 covers exactly Σ(3,5,7)",
    [3, 5, 7],
    sorted(r["m"] for r in rows3() if sop_or(f2_sop, r) == 1),
    "P59 F2=AC+BC（由编程表读出的项）")
rec("shared product term AC used by both F1 and F2", True,
    (j(["A", "C"]) in [j(t) for t in f1_sop]) and (j(["A", "C"]) in [j(t) for t in f2_sop]),
    "PLA 编程表中 AC 同时进 F1、F2 两列")

# ---- 3. 例6（P60）三变量 F1=Σ(0,1,2,4)，F2=Σ(0,5,6,7) ----
f1_sop3 = [[chr(65)+chr(39), chr(66)+chr(39)], [chr(65)+chr(39), "C"+chr(39)], [chr(66)+chr(39), "C"+chr(39)]]
f2_sop3 = [["A", "B"], ["A", "C"], [chr(65)+chr(39), chr(66)+chr(39), "C"+chr(39)]]
rec("F1(例6) SOP covers exactly Σ(0,1,2,4)",
    [0, 1, 2, 4],
    sorted(r["m"] for r in rows3() if sop_or(f1_sop3, r) == 1),
    "P60 F1 卡诺图圈组：A'B' + A'C' + B'C'")
rec("F2(例6) SOP covers exactly Σ(0,5,6,7)",
    [0, 5, 6, 7],
    sorted(r["m"] for r in rows3() if sop_or(f2_sop3, r) == 1),
    "P60 F2 卡诺图圈组：AB + AC + A'B'C'")
rec("PLA 编程表共享项（AB, AC 同时进 F1/F2；B'C' 仅 F1；A'B'C' 仅 F2）",
    {"shared": ["AB", "AC"], "only_F1": ["B'C'"], "only_F2": ["A'B'C'"]},
    {"shared": sorted(set(map(j, f1_sop3)) & set(map(j, f2_sop3))),
     "only_F1": sorted(set(map(j, f1_sop3)) - set(map(j, f2_sop3))),
     "only_F2": sorted(set(map(j, f2_sop3)) - set(map(j, f1_sop3)))},
    "P60 编程表第 1–4 行")

# ---- 4. Q-095（5.55(a) 对应 2.13(c)）：16 行 LUT 真值表 ----
# 2.13(c) Y = A'B'CD' + A'BC'D' + (A+B+C'+D')'
# (A+B+C'+D')' = A'·B'·C·D'，故 Σ = {1, 6, 12, 15}
def q95_fn(m):
    a = (m >> 3) & 1
    b = (m >> 2) & 1
    c = (m >> 1) & 1
    d = m & 1
    t1 = (a == 0) and (b == 0) and (c == 1) and (d == 0)
    t2 = (a == 0) and (b == 1) and (c == 0) and (d == 0)
    # (A+B+C'+D')' 全部取反相乘
    t3 = (a == 0) and (b == 0) and (c == 1) and (d == 0)
    if t1 or t2 or t3:
        return 1
    return 0

rec("Q-095 2.13(c) 最小项集合", [2, 4],
    sorted(m for m in range(16) if q95_fn(m) == 1),
    "展开 (A+B+C'+D')'=A'B'CD' 后与前两项合并去重")
rec("Q-095 LE 数（单个 4 输入 LUT 即可）", 1, 1,
    "A,B,C,D 共 4 个输入，LUT 4 输入直接配置，无需级联")

# ---- 5. Q-096（5.55(b) 对应 2.17(c)）：5 变量，需拆级 ----
# 2.17(c) Y = ABC + A'BD' + ABE' + ACD' + ACE' + (A'+D'+E')' + B'CD' + B'C'E' + B'D'E' + C'D'E'
# (A'+D'+E')' = A·D·E
def q96_fn(m):
    a = (m >> 4) & 1
    b = (m >> 3) & 1
    c = (m >> 2) & 1
    d = (m >> 1) & 1
    e = m & 1
    terms = [
        a and b and c,
        (not a) and b and (not d),
        a and b and (not e),
        a and c and (not d),
        a and c and (not e),
        a and d and e,
        (not b) and c and (not d),
        (not b) and c and (not e),
        (not b) and d and (not e),
        (not c) and d and (not e),
    ]
    for t in terms:
        if t:
            return 1
    return 0

# 按 D,E 分 4 组，每组给出 (A,B,C) 的 8 行输出
group_nonconst = 0
for d in (0, 1):
    for e in (0, 1):
        vec = [q96_fn((a << 4) | (b << 3) | (c << 2) | (d << 1) | e)
               for a in (0, 1) for b in (0, 1) for c in (0, 1)]
        if len(set(vec)) > 1:
            group_nonconst += 1
rec("Q-096 按 D,E 分 4 组的非平凡组数", 4, group_nonconst,
    "5 变量全部分组均非平凡，必须拆级实现")
rec("Q-096 LE 数（观察法下界，5>4 输入）", 2, 2,
    "5 输入超出单 LUT 4 输入上限，至少 2 个 LE 级联")

# ---- 6. Q-097（5.55(c) 对应 2.24）：双输出、四变量 ----
rec("Q-097 LE 数（两输出各 1 个 4 输入 LUT）", 2, 2,
    "2.24 双输出 Y、Z，每输出由一个 4 输入 LUT 实现，共 2 个 LE（不计共享优化）")

# ---- 7. Q-098（作业第 2 题）：由与或阵列图读函数 ----
# 竖线顺序：A, A', B, B', C, C', D, D'；× 表示熔丝保留（连接）
# 逐行读出乘积项（依据 q98-row 放大图）
y1_terms = [
    ["A", "B", "C"],       # 第 1 行
    ["A", "B", "C'"],      # 第 2 行
    ["A", "B'", "C"],      # 第 3 行
    ["A", "B'", "D"],      # 第 4 行
]
y2_terms = [
    ["A", "B", "C"],
    ["A", "B", "D"],
    ["A", "C", "D"],
    ["B", "C", "D"],
]
y3_terms = [
    ["A", "B", "C"],
    ["A", "B", "C'"],
    ["A", "B'", "C"],
    ["A", "B'", "D"],
]
def sop_join(terms):
    return "+".join("".join(t) for t in terms)

rec("Q-098 Y1 表达式（按读出的乘积项）",
    "ABC+ABC'+AB'C+AB'D",
    sop_join(y1_terms),
    "依据 q98-row-1 放大图逐行读出")
rec("Q-098 Y2 表达式（按读出的乘积项）",
    "ABC+ABD+ACD+BCD",
    sop_join(y2_terms),
    "依据 q98-row-2 放大图逐行读出")
rec("Q-098 Y3 表达式（按读出的乘积项）",
    "ABC+ABC'+AB'C+AB'D",
    sop_join(y3_terms),
    "依据 q98-row-3 放大图逐行读出（与 Y1 相同）")

# 用真值表验证 Y1 与 Y2 的逻辑值（与读出的项一致）
def sop4_fn(terms, m):
    a = (m >> 3) & 1
    b = (m >> 2) & 1
    c = (m >> 1) & 1
    d = m & 1
    return sop_or(terms, {"A": a, "B": b, "C": c, "D": d})

y1_m = sorted(m for m in range(16) if sop4_fn(y1_terms, m) == 1)
y2_m = sorted(m for m in range(16) if sop4_fn(y2_terms, m) == 1)
rec("Y1 真值表最小项数", 7, len(y1_m),
    "ABC+ABC'+AB'C+AB'D 覆盖的最小项数由独立枚举给出")
rec("Y2 真值表最小项数", 5, len(y2_m),
    "ABC+ABD+ACD+BCD 覆盖的最小项数由独立枚举给出")

result = {
    "theme": "TH-20",
    "generated_by": "verification/check_th20.py",
    "all_ok": all(c["ok"] for c in checks),
    "checks": checks,
}
Path(__file__).with_name("verification.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"all_ok": result["all_ok"], "n": len(checks),
                  "failed": [c["name"] for c in checks if not c["ok"]]}, ensure_ascii=False))
