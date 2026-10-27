#!/usr/bin/env python3
"""TH-19 独立复核：门电平表、二极管状态区、三极管开关边界、CMOS 串并联。
期望由理想开关/阈值模型直接推导，不从正文抄答案。"""
import json
from pathlib import Path

out = {}
checks = []

def rec(name, expected, actual, note=""):
    ok = expected == actual
    checks.append({"name": name, "expected": expected, "actual": actual, "ok": ok, "note": note})
    return ok

# ---- 1. P49 二极管与门/或门电平表（理想二极管：导通=0 压降短路）----
and_levels = []
or_levels = []
for A in (0, 5):
    for B in (0, 5):
        # 与门：二极管 F->输入，上拉 +5V。输入为 0 的支路导通把 F 钳到 0；全为 5 时全部截止，F=5
        if 0 in (A, B):
            F = 0
        else:
            F = 5
        and_levels.append([A, B, F])
        # 或门：二极管 输入->F，下拉到地。任一输入 5 时该支路导通把 F 抬到 5
        F = 5 if 5 in (A, B) else 0
        or_levels.append([A, B, F])

table_and = [[0, 0, 0], [0, 5, 0], [5, 0, 0], [5, 5, 5]]
table_or = [[0, 0, 0], [0, 5, 5], [5, 0, 5], [5, 5, 5]]
rec("AND level table (ideal diode)", table_and, and_levels, "SRC-C06 P49")
rec("OR level table (ideal diode)", table_or, or_levels, "SRC-C06 P49")

# 真值表翻译 高=1
rec("AND truth table", [0, 0, 0, 1], [int(f == 5) for _, _, f in and_levels])
rec("OR truth table", [0, 1, 1, 1], [int(f == 5) for _, _, f in or_levels])

# ---- 2. 三极管非门（饱和=短路到地，截止=上拉到 VCC）----
not_rows = []
for A in (0, 5):
    on = A == 5              # 基极有电流才饱和
    F = 0 if on else 5
    not_rows.append([A, F])
rec("NOT level table", [[0, 5], [5, 0]], not_rows, "SRC-C06 P49")

# ---- 3. 二极管工作区判定（阈值模型）----
VF_SI, VBR = 0.7, -50.0
def region(v):
    if v >= VF_SI:
        return "forward-on"
    if v < VBR:
        return "breakdown"
    if v < 0:
        return "reverse-off"
    return "below-threshold"   # 正偏但未达 V_F：曲线弯曲段，近似不导通

rec("diode regions",
    {"+0.5V": "below-threshold", "-1V": "reverse-off", "-60V": "breakdown"},
    {k: region(float(k.replace("V", "").replace("+", ""))) for k in ("+0.5V", "-1V", "-60V")},
    "0.5<0.7 未导通; -1 在截止区; -60 < V_BR 击穿")

# 导通压降后的节点电平（硅 0.7 / 锗 0.3）
rec("node level after diode drop (Si/Ge)",
    [4.3, 4.7], [round(5 - 0.7, 1), round(5 - 0.3, 1)])

# ---- 4. 三极管灯电路（基极控制）----
lamp = {}
for sw in ("closed", "open"):
    base_current = sw == "closed"
    lamp[sw] = {"base_current": base_current,
                "state": "saturation" if base_current else "cutoff",
                "ce": "short" if base_current else "open",
                "lamp": "on" if base_current else "off"}
rec("lamp circuit", 
    {"closed": {"base_current": True, "state": "saturation", "ce": "short", "lamp": "on"},
     "open":   {"base_current": False, "state": "cutoff", "ce": "open", "lamp": "off"}},
    lamp, "SRC-C06 P48")

# ---- 5. CMOS 串并联与逻辑（P52 放大核对）----
# P52 虚线框 NAND：两 pMOS 并联 + 两 nMOS 串联；右侧 NOR：两 pMOS 串联 + 两 nMOS 并联
def cmos_from_structure(p_series, n_parallel):
    """p_series=True 表示 pMOS 串联（需全导通才上拉），否则 pMOS 并联（任一导通上拉）。
       n_parallel=True 表示 nMOS 并联（任一导通下拉），否则 nMOS 串联（需全导通下拉）。"""
    rows = []
    for A in (0, 1):
        for B in (0, 1):
            pA = (A == 0)
            pB = (B == 0)
            nA = (A == 1)
            nB = (B == 1)
            if p_series:
                pull_up = pA and pB
            else:
                pull_up = pA or pB
            if n_parallel:
                pull_down = nA or nB
            else:
                pull_down = nA and nB
            if pull_up and pull_down:
                C = "invalid"
            elif pull_up:
                C = 1
            elif pull_down:
                C = 0
            else:
                C = "float"
            rows.append([A, B, C])
    return rows
nand_actual = cmos_from_structure(False, False)   # p 并联、n 串联 -> NAND
nor_actual = cmos_from_structure(True, True)      # p 串联、n 并联 -> NOR
rec("CMOS NAND (parallel-p series-n)", [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]],
    nand_actual, "P52 虚线框 NAND：两 pMOS 并联、两 nMOS 串联；期望由与非定义独立枚举")
rec("CMOS NOR (series-p parallel-n)", [[0, 0, 1], [0, 1, 0], [1, 0, 0], [1, 1, 0]],
    nor_actual, "P52 右侧 NOR：两 pMOS 串联、两 nMOS 并联；期望由或非定义独立枚举")

# ---- 5b. P52 符号链 A,B -> C -> D 的真值表（由 A·B 定义独立枚举）----
# P52 顶部符号链：C=¬(A·B)（NAND），D=¬C=A·B（NOT 接在 NAND 后）
chain_expect = [[0, 0, 1, 0], [0, 1, 1, 0], [1, 0, 1, 0], [1, 1, 0, 1]]
chain_actual = []
for _a in (0, 1):
    for _b in (0, 1):
        if _a == 1 and _b == 1:
            _c = 0
        else:
            _c = 1
        if _c == 0:
            _d = 1
        else:
            _d = 0
        chain_actual.append([_a, _b, _c, _d])
rec("NAND->NOT chain truth table", chain_expect, chain_actual,
    "期望由 A·B 定义独立枚举：C=¬(A·B)、D=A·B")

# ---- 6. MOS 管开关极性（P51）----
rec("nMOS conducts at G=1", [1, 0], [1 if g else 0 for g in (1, 0)], "nMOS: G=1 通, G=0 断")
rec("pMOS conducts at G=0", [0, 1], [1 if not g else 0 for g in (1, 0)], "pMOS: G=0 通, G=1 断")

# ---- 7. 二极管导通压降对电平表的影响（理想表 vs 含压降）----
def and_level(a, b, vd):
    if min(a, b) == 0:          # 有输入为低：该支路导通，F = 低电平 + vd
        return min(a, b) + vd
    return 5.0                  # 全高：全部截止，F 由上拉保持 5
def or_level(a, b, vd):
    if max(a, b) == 5:          # 有输入为高：该支路导通，F = 高电平 - vd
        return max(a, b) - vd
    return 0.0                  # 全低：全部截止，F 由下拉保持 0

rec("AND with 0.7V drop", [0.7, 0.7, 0.7, 5.0],
    [and_level(a, b, 0.7) for a in (0, 5) for b in (0, 5)],
    "有低时钳位点被抬高 vd；全高时上拉到 5")
rec("OR with 0.7V drop", [0.0, 4.3, 4.3, 4.3],
    [or_level(a, b, 0.7) for a in (0, 5) for b in (0, 5)],
    "有高时输出被压低 vd；全低时下拉到 0")

result = {
    "theme": "TH-19",
    "generated_by": "verification/check_th19.py",
    "all_ok": all(c["ok"] for c in checks),
    "checks": checks,
}
Path(__file__).with_name("verification.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"all_ok": result["all_ok"], "n": len(checks),
                  "failed": [c["name"] for c in checks if not c["ok"]]}, ensure_ascii=False))
