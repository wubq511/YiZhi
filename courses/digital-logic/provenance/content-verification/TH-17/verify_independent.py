#!/usr/bin/env python3
"""Read the candidate itself; compare with integer arithmetic, not copied answers.

Only TH-17 verification outputs are written. The authoritative map is queried
and deep-copied in memory for validate_reading; no package/import/build occurs.
Boolean formula parsing is deliberately independent of the provider and audits.
"""
import argparse
import ast
import copy
import hashlib
import importlib.util
import itertools
import json
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
UNIT_IDS = [f"KU-{x}" for x in ("070", "071", "072", "074", "075", "076")]
DATA = {u: json.loads((HERE / "units" / f"{u}.json").read_text()) for u in UNIT_IDS}
CHECKS = []


def flat(blocks):
    for block in blocks:
        yield block
        yield from flat(block.get("children", []))


def block(u, suffix):
    return next(b for b in flat(DATA[u]["reading"]["blocks"])
                if b["id"] == f"RB-TH-17-{u[3:]}-{suffix}")


def payload(u, suffix):
    return block(u, suffix)["payload"]


def compare(u, name, pairs):
    count, failures = 0, []
    for actual, expected, context in pairs:
        count += 1
        if actual != expected and len(failures) < 8:
            failures.append({"actual": actual, "expected": expected, "context": context})
    CHECKS.append({"unitId": u, "name": name, "cases": count,
                   "pass": count > 0 and not failures, "failures": failures})


def norm(tex):
    # Keep subscript names atomic before handling overbars and implicit AND.
    tex = re.sub(r"\\bar\{([A-Za-z])\}_([A-Za-z])", r"\\bar{\1\2}", tex)
    tex = re.sub(r"_\{([^{}]+)\}|_([A-Za-z0-9])", lambda m: m[1] or m[2], tex)
    tex = tex.replace(r"^{\prime}", "p")
    for _ in range(5):
        tex = re.sub(r"\\(?:bar|overline)\{([^{}]+)\}", r"!(\1)", tex)
    tex = tex.replace(r"\oplus", "^").replace("⊕", "^")
    tex = tex.replace(r"\cdot", "*").replace("·", "*").replace("¬", "!")
    return re.sub(r"\s+", "", tex.replace(r"\,", ""))


def boolean(expr, env):
    """Parse OR(+), XOR(^), AND(* or adjacency), NOT(!), parentheses."""
    expr, pos = norm(expr), 0
    names = sorted(env, key=len, reverse=True)

    def peek():
        return expr[pos] if pos < len(expr) else ""

    def atom():
        nonlocal pos
        if peek() == "!":
            pos += 1
            return 1 - atom()
        if peek() == "(":
            pos += 1
            value = disjunction()
            assert peek() == ")", (expr, pos)
            pos += 1
            return value
        for name in names:
            if expr.startswith(name, pos):
                pos += len(name)
                return int(env[name])
        if peek() in ("0", "1"):
            value = int(peek())
            pos += 1
            return value
        raise ValueError(f"Unknown boolean token at {expr[pos:]} in {expr}")

    def conjunction():
        nonlocal pos
        value = atom()
        while peek() and peek() not in "+^)":
            if peek() == "*":
                pos += 1
            value &= atom()
        return value

    def exclusive():
        nonlocal pos
        value = conjunction()
        while peek() == "^":
            pos += 1
            value ^= conjunction()
        return value

    def disjunction():
        nonlocal pos
        value = exclusive()
        while peek() == "+":
            pos += 1
            value |= exclusive()
        return value

    result = disjunction()
    assert pos == len(expr), (expr, pos)
    return result


def equations(u, suffix):
    parts = re.split(r",?\\quad", payload(u, suffix)["latex"])
    return {norm(p.split("=", 1)[0]): p.split("=")[1:]
            for p in parts if "=" in p}


def rhs(u, suffix, target):
    return equations(u, suffix)[target][-1]


def bit(n, i):
    return (n >> i) & 1


def signed(n, width=4):
    return n - (1 << width) if n & (1 << (width - 1)) else n


def half_full(u, half_table, full_table, half_formula, full_formula, subtract=False):
    def table_pairs(suffix, inputs):
        rows = payload(u, suffix)["rows"]
        expected_inputs = list(itertools.product((0, 1), repeat=inputs))
        yield [tuple(map(int, r[:inputs])) for r in rows], expected_inputs, "all rows, no duplicates"
        for row in rows:
            nums = list(map(int, row)); a, b = nums[:2]
            cin = nums[2] if inputs == 3 else 0
            total = a - b - cin if subtract else a + b + cin
            value, carry = total % 2, int(total < 0) if subtract else total // 2
            # HA table is Cout,S; all remaining tables are result,carry.
            expected = [carry, value] if inputs == 2 and not subtract else [value, carry]
            yield nums[inputs:], expected, row[:inputs]
    compare(u, "truth tables against integer arithmetic", itertools.chain(table_pairs(half_table, 2), table_pairs(full_table, 3)))
    tests = []
    for a, b in itertools.product((0, 1), repeat=2):
        total = a - b if subtract else a + b
        expected = {"D" if subtract else "S": total % 2,
                    "C" if subtract else "Cout": int(total < 0) if subtract else total // 2}
        for target, exprs in equations(u, half_formula).items():
            for expr in exprs:
                tests.append((boolean(expr, {"x": a, "y": b}), expected[target], [target, a, b, expr]))
    for a, b, c in itertools.product((0, 1), repeat=3):
        total = a - b - c if subtract else a + b + c
        env = {"Ai": a, "Bi": b, "Ci" if subtract else "Ci-1": c}
        expected = {"Di" if subtract else "Si": total % 2,
                    "Ci+1" if subtract else "Ci": int(total < 0) if subtract else total // 2}
        for target, exprs in equations(u, full_formula).items():
            for expr in exprs:
                tests.append((boolean(expr, env), expected[target], [target, a, b, c, expr]))
    compare(u, "actual displayed Boolean expressions", tests)


def ripple(u):
    tests = []
    for a, b, c0 in itertools.product(range(16), range(16), range(2)):
        c, result = c0, 0
        for i in range(4):
            env = {"Ai": bit(a, i), "Bi": bit(b, i), "Ci": c}
            result |= boolean(rhs(u, "recurrence", "Si"), env) << i
            c = boolean(rhs(u, "recurrence", "Ci+1"), env)
        tests.append((result + 16 * c, a + b + c0, [a, b, c0]))
    compare(u, "4-bit cascade read from candidate formula", tests)
    trace = []
    for line in payload(u, "example-solution")["items"]:
        m = re.match(r"i=(\d)：A\d=([01])、B\d=([01])、C\d=([01]) → S\d=([01])，C\d=([01])", line)
        if m:
            i, a, b, c, s, co = map(int, m.groups())
            trace.append(([s, co], [(a+b+c) % 2, (a+b+c)//2], i))
    compare(u, "existing example per-bit trace", trace)
    compare(u, "worst-case carry propagation: each incoming bit matters", [
        ([boolean(rhs(u,"recurrence","Ci+1"),{"Ai":1,"Bi":0,"Ci":c}) for c in (0,1)], [0,1], "propagate"),
        ([boolean(rhs(u,"recurrence","Ci+1"),{"Ai":0,"Bi":0,"Ci":c}) for c in (0,1)], [0,0], "kill"),
        ([boolean(rhs(u,"recurrence","Ci+1"),{"Ai":1,"Bi":1,"Ci":c}) for c in (0,1)], [1,1], "generate")])


def lookahead(u):
    tests, sums = [], []
    for a, b, c0 in itertools.product(range(16), range(16), range(2)):
        env = {"C0": c0}
        for i in range(1, 5):
            bits = {"Ai": bit(a,i-1), "Bi": bit(b,i-1)}
            env[f"G{i}"] = boolean(rhs(u,"gp","Gi"),bits)
            env[f"P{i}"] = boolean(rhs(u,"gp","Pi"),bits)
        for i in range(1, 5):
            mask = (1 << i) - 1
            expected = ((a & mask) + (b & mask) + c0) >> i
            for suffix in (f"expanded-c{i}", "lookahead"):
                tests.append((boolean(rhs(u,suffix,f"C{i}"),env),expected,[a,b,c0,i,suffix]))
        value = 0
        for i in range(1,5):
            incoming = c0 if i == 1 else boolean(rhs(u,f"expanded-c{i-1}",f"C{i-1}"),env)
            value |= boolean(rhs(u,"sum","Si"),{"Pi":env[f"P{i}"],"Ci-1":incoming}) << (i-1)
        sums.append((value,(a+b+c0)%16,[a,b,c0]))
    compare(u,"all nested and expanded carries vs independent low-bit integer sums",tests)
    compare(u,"actual sum expression uses entering carry",sums)
    compare(u,"G/P truth table", [([int(r[2]),int(r[3])],[int(r[0])*int(r[1]),(int(r[0])+int(r[1]))%2],r[:2]) for r in payload(u,"gp-table")["rows"]])
    q = next(q for q in DATA[u]["questionUpdates"] if q["questionId"] == "Q-099")
    wiring = dict(re.findall(r"B([0-3])=([^，。；]+)", q["solution"]))
    assert set(wiring) == set("0123"), wiring
    mode_rows = payload(u,"q099-control")["rows"]
    tests = []
    for m, n, bs, decimal, _ in mode_rows:
        env = {"M":int(m),"N":int(n)}
        value = sum(boolean(wiring[str(i)],env) << i for i in range(4))
        # Arithmetic identity is independent of a copied 4-row answer table.
        expected = 2*int(m)+3*int(n)
        tests.append(([value,int(bs,2),int(decimal)],[expected]*3,[m,n]))
        for a in range(16):
            total = a+value
            tests.append((16*(total//16)+total%16,a+expected,[a,m,n]))
    compare(u,"Q-099 actual gate expressions and mode table",tests)


def triple(u):
    q = next(q for q in DATA[u]["questionUpdates"] if q["questionId"] == "Q-121")
    wires = dict(re.findall(r"([AB][0-3])=(D[0-2]|0)",q["solution"]))
    assert len(wires) == 8, wires
    tests = []
    for d in range(8):
        env = {f"D{i}":bit(d,i) for i in range(3)}
        a = sum(boolean(wires[f"A{i}"],env)<<i for i in range(4))
        b = sum(boolean(wires[f"B{i}"],env)<<i for i in range(4))
        tests.append((a+b,3*d,d))
    compare(u,"Q-121 actual shared solution wiring for all D",tests)


def addsub(u):
    tests, signs = [], []
    for a, b, m in itertools.product(range(16), range(16),range(2)):
        c = boolean(rhs(u,"formula","C0"),{"M":m})
        s, cin_sign = 0, None
        for i in range(4):
            bp = boolean(rhs(u,"formula","Bip"),{"Bi":bit(b,i),"M":m})
            env = {"Ai":bit(a,i),"Bip":bp,"Ci":c}
            if i == 3:
                cin_sign = c
            s |= boolean(rhs(u,"bit-equations","Si"),env)<<i
            c = boolean(rhs(u,"bit-equations","Ci+1"),env)
        v = boolean(rhs(u,"v-formula","V"),{"Cn-1":cin_sign,"Cn":c})
        exact = signed(a) - signed(b) if m else signed(a)+signed(b)
        carry_expected = int(a>=b) if m else int(a+b>=16)
        tests.append(([s,c,v],[(a-b if m else a+b)%16,carry_expected,int(not -8<=exact<=7)],[a,b,m]))
        sexpr = rhs(u,"signed-formulas","Vsub" if m else "Vadd")
        signs.append((boolean(sexpr,{"a":bit(a,3),"b":bit(b,3),"s":bit(s,3)}),int(not -8<=exact<=7),[a,b,m]))
    compare(u,"all 512 add/sub inputs: actual formulas vs signed/unsigned integer arithmetic",tests)
    compare(u,"actual sign-test equations vs representable integer range",signs)
    tests=[]
    for row in payload(u,"flag-cases")["rows"]:
        a,b,m,s,c3,c4,v= row[:7]
        a,b,m=int(a,2),int(b,2),int(m)
        bp=15-b if m else b
        total=a+bp+m
        true_signed=signed(a)-signed(b) if m else signed(a)+signed(b)
        tests.append(([int(s,2),int(c3),int(c4),int(v)],[total%16,((a&7)+(bp&7)+m)//8,total//16,int(not -8<=true_signed<=7)],row))
    compare(u,"flag comparison table including minimum-negative operands",tests)
    for suffix in ("five-minus-three-bits","three-minus-five-bits","minimum-minus-one-bits"):
        table=payload(u,suffix);tests=[];last_c=1;a=bp=s=0
        for row in table["rows"]:
            i,ai,bi,ci,si,co=map(int,row)
            tests.append(([ci,si,co],[last_c,(ai+bi+ci)%2,(ai+bi+ci)//2],row))
            last_c=co;a|=ai<<i;bp|=bi<<i;s|=si<<i
        tests.append((s+16*last_c,a+bp+1,"complete sum"))
        title=table["title"]
        for pat,actual in [(r"A=([01]{4})",a),(r"B′=([01]{4})",bp)]:
            match=re.search(pat,title)
            if match:tests.append((actual,int(match[1],2),title))
        compare(u,"bit trace "+suffix,tests)


def arithmetic(expr,env):
    """Small AST interpreter for candidate integer formulas; no eval()."""
    expr=norm(expr).replace(r"\bmod","%").replace(r"\lfloor","floor(").replace(r"\rfloor",")")
    expr=re.sub(r"(\d)([A-Za-z])",r"\1*\2",expr)
    node=ast.parse(expr,mode="eval").body
    def go(n):
        if isinstance(n,ast.Constant) and isinstance(n.value,int):return n.value
        if isinstance(n,ast.Name):return env[n.id]
        if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=="floor" and len(n.args)==1:
            return int(go(n.args[0])//1)
        if isinstance(n,ast.BinOp):
            a,b=go(n.left),go(n.right)
            if isinstance(n.op,ast.Add):return a+b
            if isinstance(n.op,ast.Sub):return a-b
            if isinstance(n.op,ast.Mult):return a*b
            if isinstance(n.op,ast.Div):return a/b
            if isinstance(n.op,ast.Mod):return a%b
        raise ValueError(ast.dump(n))
    return go(node)


def multiply(u):
    tests=[]
    for a,b in itertools.product(range(4),range(4)):
        env={**{f"A{i}":bit(a,i) for i in range(2)},**{f"B{i}":bit(b,i) for i in range(2)}}
        for target,exprs in equations(u,"two-bit-formula").items():env[target]=boolean(exprs[-1],env)
        tests.append((sum(env[f"P{i}"]<<i for i in range(4)),a*b,[a,b]))
    compare(u,"2x2 actual partial-product/half-adder formulas",tests)
    formula=payload(u,"partial-products")["latex"]
    term,exponent=re.search(r"\(([^()]*)\)2\^\{([^{}]*)\}",formula).groups()
    tests=[]
    for m,n in ((2,2),(3,4),(4,4)):
        for a,b in itertools.product(range(1<<m),range(1<<n)):
            total=sum(boolean(term,{"Ai":bit(a,i),"Bj":bit(b,j)}) * 2**arithmetic(exponent,{"i":i,"j":j}) for i in range(m) for j in range(n))
            tests.append((total,a*b,[m,n,a,b]))
    compare(u,"actual partial-product term and bit-weight exponent",tests)
    tests=[];wtests=[]
    wires=payload(u,"four-by-three-wires")["rows"]
    for a,b in itertools.product(range(8),range(16)):
        env={f"R{i}":bit(a,i)*b for i in range(3)}
        for target,exprs in equations(u,"stage-formulas").items():env[target]=arithmetic(exprs[-1],env)
        tests.append(([env["C"],0<=env["T"]<32,0<=env["U"]<32],[a*b,True,True],[a,b]))
        bits={**{f"A{i}":bit(a,i) for i in range(3)},**{f"B{i}":bit(b,i) for i in range(4)}}
        def word(text):
            return sum(boolean(e,bits)<<(3-i) for i,e in enumerate(text.split("、")))
        t=word(wires[0][1])+word(wires[1][1]);bits.update({f"T{i}":bit(t,i) for i in range(5)})
        uu=word(wires[3][1])+word(wires[4][1])
        result=(bit(a,0)*bit(b,0))+2*bit(t,0)+4*uu
        wtests.append((result,a*b,[a,b]))
    compare(u,"4x3 candidate integer stage formulas and width",tests)
    compare(u,"4x3 candidate wiring table, including carried-out T4",wtests)
    for suffix in ("four-by-three-rows","four-by-four-rows","practice-rows"):
        tests=[];a=0;sum_rows=0;bvalues=set()
        for i,ai,b,product in payload(u,suffix)["rows"]:
            i,ai,b=int(i),int(ai),int(b,2)
            tests.append((int(product,2),ai*b*(1<<i),[i,ai,b,product]))
            a|=ai<<i;sum_rows+=int(product,2);bvalues.add(b)
        tests.append((sum_rows,a*next(iter(bvalues)),"complete aligned sum"))
        compare(u,"example partial-product table "+suffix,tests)


def binary_calculations(u):
    tests=[]
    # Only equations explicitly suffixed with binary base ₂; decimal prose is
    # not silently reinterpreted. Reads the displayed worked steps themselves.
    pattern=r"(?<![\w])([01]+(?:\+[01]+)+)=([01]+)₂"
    for b in flat(DATA[u]["reading"]["blocks"]):
        for text in [b["payload"].get("text","")]+b["payload"].get("items",[]):
            for m in re.finditer(pattern,text):
                tests.append((int(m[2],2),sum(int(x,2) for x in m[1].split("+")),[b["id"],m[0]]))
    if tests:compare(u,"literal binary arithmetic in worked prose",tests)


def geometry(u):
    tests=[]
    for b in flat(DATA[u]["reading"]["blocks"]):
        if b["kind"]!="figure":continue
        cfg=b["payload"]["config"];nodes=cfg["nodes"];byid={n["id"]:n for n in nodes}
        for n in nodes:
            tests.append((70<=n["x"]<=570 and 28<=n["y"]<=212,True,[b["id"],n["id"],"140x56 bounds"]))
            width=sum(18 if ord(c)>127 else 10 for c in n["label"])
            tests.append((width<=132,True,[b["id"],n["label"],"conservative label width",width]))
        for a,z in itertools.combinations(nodes,2):
            tests.append((abs(a["x"]-z["x"])>=140 or abs(a["y"]-z["y"])>=56,True,[b["id"],a["id"],z["id"],"non-overlap"]))
        for e in cfg["edges"]:
            a,z=byid[e["from"]],byid[e["to"]]
            for n in nodes:
                if n["id"] in (a["id"],z["id"]):continue
                # Sample the straight center-to-center line at sub-pixel steps.
                crossing=any(abs((a["x"]+(z["x"]-a["x"])*t/2000)-n["x"])<70 and abs((a["y"]+(z["y"]-a["y"])*t/2000)-n["y"])<28 for t in range(2001))
                tests.append((crossing,False,[b["id"],e,n["id"],"unrelated box crossing"]))
    compare(u,"semantic figure bounds, label widths, overlap and straight lines",tests)


def render_smoke():
    """Pure provider.render() HTML check; no DOM, server, browser or UI claim."""
    script = r'''
const fs = require('fs');
const path = require('path');
const root = process.argv[1], here = process.argv[2];
const provider = require(path.join(root, '复习画板/web/content/provider.js'));
const ids = ['070','071','072','074','075','076'];
const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const outputs = [];
const flatten = blocks => blocks.flatMap(b => [b, ...flatten(b.children || [])]);
for (const id of ids) {
  const d = JSON.parse(fs.readFileSync(path.join(here,'units','KU-'+id+'.json'),'utf8'));
  const unit = {reading: d.reading, questions: d.questionUpdates.map(q => ({questionId:q.questionId,question:q}))};
  const html = provider.render(unit), failures = [];
  for (const b of flatten(d.reading.blocks)) {
    if (!html.includes('"'+b.id+'"')) failures.push('missing block '+b.id);
    if ((b.kind === 'example' || b.kind === 'exercise') && b.payload.questionId) {
      const q = d.questionUpdates.find(q => q.questionId === b.payload.questionId);
      if (!q || !html.includes(escape(q.stem))) failures.push('missing shared stem '+b.id);
      if (!b.children?.length && !html.includes(escape(q.solution))) failures.push('missing shared solution '+b.id);
      if (b.children?.length && !b.children.some(c => c.kind === 'steps' && c.payload.items.length >= 3)) failures.push('children hide shared solution without full worked steps '+b.id);
    }
    // These steps are the actual solution when an example has child blocks.
    if (b.kind === 'steps') for (const item of b.payload.items) {
      if (!html.includes('<li>'+escape(item)+'</li>')) failures.push('missing visible step '+b.id);
    }
  }
  outputs.push({unitId:'KU-'+id,blocks:flatten(d.reading.blocks).length,htmlBytes:Buffer.byteLength(html),failures});
}
process.stdout.write(JSON.stringify(outputs));
'''
    result=json.loads(subprocess.check_output(["node","-e",script,str(ROOT),str(HERE)],text=True))
    compare("all","read-only provider.render static HTML includes full worked steps",[(r["failures"],[],r["unitId"]) for r in result])
    return result


def sensitivity():
    """Known wrong edits must be caught; mutations exist only in Python memory."""
    tests=[]
    scenarios=[
        ("KU-070","full-adder carry replaced by 0",lambda: payload("KU-070","fa-formula").update(latex=r"S_i=A_i\oplus B_i\oplus C_{i-1},\quad C_i=0"),lambda:half_full("KU-070","ha-table","fa-table","ha-formula","fa-formula")),
        ("KU-072","old Q-099 short-circuit interpretation",lambda:next(q for q in DATA["KU-072"]["questionUpdates"] if q["questionId"]=="Q-099").update(solution="B0=N，B1=N，B2=N，B3=0。"),lambda:lookahead("KU-072")),
        ("KU-075","wrong worked-table carry",lambda:payload("KU-075","three-minus-five-bits")["rows"][2].__setitem__(5,"1"),lambda:addsub("KU-075")),
        ("KU-076","shifted partial product loses one weight",lambda:payload("KU-076","partial-products").update(latex=payload("KU-076","partial-products")["latex"].replace("2^{i+j}","2^{i+j+1}")),lambda:multiply("KU-076")),
    ]
    for u,name,mutate,run in scenarios:
        backup=copy.deepcopy(DATA[u]);start=len(CHECKS)
        try:
            mutate();run()
            caught=any(not c["pass"] for c in CHECKS[start:])
        finally:
            DATA[u]=backup
            del CHECKS[start:]
        tests.append((caught,True,name))
    compare("all","in-memory sensitivity: known content mistakes are rejected",tests)


def schema_and_sources():
    authoritative=json.loads((ROOT/"期中/数据/知识地图.json").read_text())
    preview=copy.deepcopy(authoritative);units={u["id"]:u for u in preview["units"]};questions={q["id"]:q for q in preview["questions"]}
    q_updates={};cli_evidence=[]
    for u,d in DATA.items():
        entity=json.loads(subprocess.check_output([sys.executable,"-B",str(ROOT/"期中/工具/知识地图.py"),"get",u],cwd=ROOT))
        direct=json.loads(subprocess.check_output([sys.executable,"-B",str(ROOT/"期中/工具/知识地图.py"),"questions",u,"--role","direct"],cwd=ROOT))
        cli_evidence.append({"unitId":u,"kind":entity["kind"],"outcome":entity["outcome"],"internals":entity["internals"],"directQuestions":[item["questionId"] for item in direct["items"]]})
        compare(u,"formal CLI identity and goal coverage",[(d["unitId"],u,"identity"),(d["reading"]["coverage"][0]["goal"],entity["outcome"],"outcome")])
        units[u]["reading"]=copy.deepcopy(d["reading"])
        for q in d["questionUpdates"]:
            if q["questionId"] in q_updates:assert q_updates[q["questionId"]]==q, q["questionId"]
            q_updates[q["questionId"]]=q
            questions[q["questionId"]].update({k:v for k,v in q.items() if k!="questionId"})
    spec=importlib.util.spec_from_file_location("reading_validation",ROOT/"期中/工具/复习内容.py")
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    errors=[];module.validate_reading(preview,errors)
    compare("all","validate_reading on an in-memory copy with all six candidates",[(errors,[],"no writes to map")])
    sources={s["id"]:s for s in authoritative["sources"]};seen=set();source_evidence=[]
    for u,d in DATA.items():
        pairs=[]
        for b in flat(d["reading"]["blocks"]):
            for r in b["sourceRefs"]:
                s=sources[r["sourceId"]];v=next(v for v in s["versions"] if v["id"]==r["versionId"])
                pairs.append((all(1<=p<=v["totalPages"] for p in r["pdfPages"]),True,b["id"]))
                key=(s["id"],v["id"])
                if key not in seen:
                    seen.add(key);digest=hashlib.sha256((ROOT/v["path"]).read_bytes()).hexdigest()
                    source_evidence.append({"sourceId":s["id"],"versionId":v["id"],"path":v["path"],"sha256":digest})
                    pairs.append((digest,v["sha256"],key))
        for page in d["evidence"]["pages"]:pairs.append(((HERE/page).is_file(),True,page))
        kinds={m["kind"] for m in d["reading"]["coverage"][0]["materials"]}
        pairs.append((sorted(kinds),sorted(["figure","method","derivation","example","exercise","interactive"]),"coverage categories"))
        compare(u,"source versions, page bounds, viewed-image presence and coverage categories",pairs)
    return {"cliQueries":cli_evidence,"sources":source_evidence,"schemaErrors":errors,
            "mapMode":"in-memory deep copy only; no import/build/browser/package"}


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--unit",choices=UNIT_IDS);args=parser.parse_args()
    selected=[args.unit] if args.unit else UNIT_IDS
    for u in selected:
        if u=="KU-070":half_full(u,"ha-table","fa-table","ha-formula","fa-formula")
        elif u=="KU-071":ripple(u)
        elif u=="KU-072":lookahead(u);triple(u)
        elif u=="KU-074":half_full(u,"hs-table","fs-table","hs-formula","fs-formula",True)
        elif u=="KU-075":addsub(u)
        elif u=="KU-076":multiply(u);triple(u)
        binary_calculations(u);geometry(u)
    details=schema_and_sources()
    details["staticRender"]=render_smoke()
    if not args.unit:sensitivity()
    result={"allPass":all(c["pass"] for c in CHECKS),"checks":CHECKS,
            "checkCount":len(CHECKS),"caseCount":sum(c["cases"] for c in CHECKS),
            "candidateSha256":{u:hashlib.sha256((HERE/"units"/f"{u}.json").read_bytes()).hexdigest() for u in UNIT_IDS},
            "referenceMethod":"parse actual candidate formulas, tables and binary calculations; compare with independent integer addition/subtraction/multiplication and representable range",
            **details}
    out=HERE/(f"audit-{args.unit}.json" if args.unit else "verification.json")
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
    if not args.unit:
        for u in UNIT_IDS:
            checks=[c for c in CHECKS if c["unitId"] in (u,"all")]
            (HERE/f"audit-{u}.json").write_text(json.dumps({"unitId":u,"allPass":all(c["pass"] for c in checks),"candidateSha256":result["candidateSha256"][u],"checks":checks,"verificationSource":"verify_independent.py; verification.json"},ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({"allPass":result["allPass"],"checks":result["checkCount"],"cases":result["caseCount"],"schemaErrors":details["schemaErrors"],"output":str(out)},ensure_ascii=False))
    for c in CHECKS:
        if not c["pass"]:print(json.dumps(c,ensure_ascii=False))
    return 0 if result["allPass"] else 1


if __name__=="__main__":
    raise SystemExit(main())
