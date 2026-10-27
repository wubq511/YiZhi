#!/usr/bin/env python3
"""核对实际候选；预期来自地址/算术定义和实际目视的原页输入，不写死最终答案。
不启动服务、不写课程地图。旧 audit 入口调用本脚本对应单元。
"""
import argparse
import copy
import hashlib
import itertools as it
import json
from pathlib import Path
import re
import sys
import unicodedata
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
TARGETS = ['KU-057', 'KU-058', 'KU-059']


def normalized(s):
    s = unicodedata.normalize('NFD', s)
    return re.sub(r'([A-Za-z])\u0304(\d*)', r'¬\1\2', s).replace(' ', '')


def boolean(expr, env):
    """有限布尔式解析器：与/或/非/括号/隐式相乘；不执行代码。"""
    expr = normalized(expr)
    names = '|'.join(re.escape(k) for k in sorted(env, key=len, reverse=True))
    tokens = re.findall('(?:'+names+r')|[01]|[¬+·*()]', expr)
    if ''.join(tokens) != expr:
        raise ValueError(f'Unsupported expression {expr!r}')
    pos = 0
    def unary():
        nonlocal pos
        t = tokens[pos]; pos += 1
        if t == '¬': return 1-unary()
        if t == '(':
            v = disjunction()
            assert tokens[pos] == ')'; pos += 1
            return v
        return int(t) if t in ('0','1') else int(env[t])
    def conjunction():
        nonlocal pos
        v = unary()
        while pos < len(tokens) and tokens[pos] not in ('+', ')'):
            if tokens[pos] in ('·','*'): pos += 1
            v &= unary()
        return v
    def disjunction():
        nonlocal pos
        v = conjunction()
        while pos < len(tokens) and tokens[pos] == '+':
            pos += 1; v |= conjunction()
        return v
    value = disjunction()
    assert pos == len(tokens)
    return value


def flat(blocks):
    for b in blocks:
        yield b
        yield from flat(b.get('children', []))


def load(number):
    return json.loads((HERE/'units'/f'KU-{number:03}.json').read_text())


def get(d, suffix):
    return next(b for b in flat(d['reading']['blocks']) if b['id'].endswith(suffix))


def compare(checks, unit, name, pairs):
    count = 0; bad = []
    for case, actual, expected in pairs:
        count += 1
        if actual != expected and len(bad)<8: bad.append({'case':case,'actual':actual,'expected':expected})
    checks.append({'unitId':unit,'name':name,'cases':count,'pass':count>0 and not bad,'failures':bad})


def mappings(text, prefix):
    return dict(re.findall(r'('+prefix+r'[0-3])=([^，。；]+)', normalized(text)))


def mux2(s,a,b): return ((1-s)&a)|(s&b)


def verify57(checks):
    d=load(57); unit=d['unitId'];text=get(d,'007-cascade')['payload']['text']
    formulas={name:re.search(rf'{name}\s*=\s*([^，。；]+)',text).group(1) for name in ['Z','v','w']}
    pairs=[]
    for bits in it.product((0,1),repeat=6):
        c=bits[:4]; s0,s1=bits[4:];env={f'C{i}':v for i,v in enumerate(c)}|{'S0':s0,'S1':s1}
        env['v']=boolean(formulas['v'],env);env['w']=boolean(formulas['w'],env)
        pairs.append((bits,boolean(formulas['Z'],env),c[int(f'{s1}{s0}',2)]))
    compare(checks,unit,'读取正文级联公式，对照直接地址选择',pairs)
    rows=get(d,'005-fn-table')['payload']['rows'];pairs=[]
    for bits in it.product((0,1),repeat=7):
        a,b,*rest=bits;c=rest[:4];g=rest[4]
        values={'A':a,'B':b,**{f'C{i}':v for i,v in enumerate(c)},'G':g}
        match=[r for r in rows if all(r[j]=='d' or r[j] in [f'C{i}' for i in range(4)] or int(r[j])==values[name] for j,name in enumerate(['B','A','C0','C1','C2','C3','G']))]
        actual=boolean(match[0][-1],values) if len(match)==1 else None
        # Independent enabled sum of minterms.
        expected=sum(c[i]*int(i==2*b+a) for i in range(4))*(1-g)
        pairs.append((bits,actual,expected))
    compare(checks,unit,'实际74153功能表展开全部128种输入',pairs)
    ex=get(d,'013-example-p22');ans=ex['children'][0]['payload']['items']
    minterms=[set(map(int,s.split(','))) for s in re.findall(r'Σm\(([^)]+)\)',ex['payload']['problem'])]
    maps=[mappings(' '.join(ans),'1C'),mappings(' '.join(ans),'2C')];pairs=[]
    for bits in it.product((0,1),repeat=4):
        a,b,c,e=bits;env={'C':c,'D':e};idx=int(''.join(map(str,bits)),2)
        for j,mp in enumerate(maps):
            out=boolean(mp[f'{j+1}C{2*a+b}'],env)
            pairs.append(([j+1,*bits],out,int(idx in minterms[j])))
    compare(checks,unit,'P22正文实际数据端接线对照题干最小项',pairs)
    ex=get(d,'015-exercise');ans=ex['children'][0]['payload']['items'];ms=set(map(int,re.search(r'Σm\(([^)]+)\)',ex['payload']['problem']).group(1).split(',')))
    ab=mappings(ans[1],'I');ca=mappings(ans[2].split('因此 ')[1],'I');pairs=[]
    for a,b,c in it.product((0,1),repeat=3):
        expect=int(4*a+2*b+c in ms)
        pairs.extend([(['AB',a,b,c],boolean(ab[f'I{2*a+b}'],{'C':c}),expect),(['CA',a,b,c],boolean(ca[f'I{2*c+a}'],{'B':b}),expect)])
    compare(checks,unit,'练习两种选择位序：读取答案数据端并重算',pairs)
    pairs=[]
    for inputs in it.product((0,1),repeat=8):
        for addr in range(8):
            s2,s1,s0=(addr>>2)&1,(addr>>1)&1,addr&1
            layer1=[mux2(s0,inputs[i],inputs[i+1]) for i in range(0,8,2)]
            layer2=[mux2(s1,layer1[i],layer1[i+1]) for i in range(0,4,2)]
            pairs.append(([list(inputs),addr],mux2(s2,*layer2),inputs[addr]))
    compare(checks,unit,'8:1的4+2+1选择树：全部数据/地址枚举',pairs)
    pairs=[]
    for hot in range(-1,17):
        inputs=[int(i==hot) for i in range(16)] if hot<16 else [1]*16
        for addr in range(16):
            hi,lo=divmod(addr,8)
            u0=inputs[lo] if hi==0 else 0
            u1=inputs[8+lo] if hi==1 else 0
            pairs.append(([hot,addr],mux2(hi,u0,u1),inputs[addr]))
    compare(checks,unit,'16:1使能和末级选择：单热点覆盖所有通道',pairs)
    compare(checks,unit,'四位并行2:1总线选择与整数整体选择',(( [a,b,s],sum(mux2(s,(a>>i)&1,(b>>i)&1)<<i for i in range(4)),b if s else a) for a,b,s in it.product(range(16),range(16),range(2))))


def verify58(checks):
    d=load(58);unit=d['unitId'];rows=get(d,'012-wave-inputs')['payload']['rows']
    # 原页P16从左往右的实际输入跳变边界；不由Y反推输入。
    initial=[0,0,1,0];edges=[[1,3,4,5,6,7],[1,4,6,7],[2,4,6],[4,6,7]]
    pairs=[]
    for t,r in enumerate(rows):
        expected=[t+1,(t//2)%2,t%2]+[v^(sum(e<=t for e in es)%2) for v,es in zip(initial,edges)]
        pairs.append((t+1,list(map(int,r)),expected))
    compare(checks,unit,'正文八窗输入表对照原页独立读出的输入跳变位置',pairs)
    ans=get(d,'007-example-ans')['payload']['items'];pairs=[]
    for t,r in enumerate(rows):
        _,s1,s0,*data=map(int,r);expected=data[2*s1+s0]
        actual=int(re.search(r'所以 Y=(\d)',ans[t]).group(1));pairs.append((t+1,actual,expected))
    compare(checks,unit,'八窗实际解答由同窗输入重算',pairs)
    # 原图Y初始低，在第1/2/4/5/7条内部边界翻转（人工实际看图）。
    compare(checks,unit,'P16参考Y波形与选择计算独立对照',((t+1,sum(e<=t for e in [1,2,4,5,7])%2,int(r[3+2*int(r[1])+int(r[2])])) for t,r in enumerate(rows)))
    ex=get(d,'008-practice');problem=ex['payload']['problem'];selects=re.search(r'依次为 (.*?)；',problem).group(1).split('、')
    data={i:list(map(int,re.search(rf'D{i}=\[([^]]+)\]',problem).group(1).split(','))) for i in range(4)}
    out=list(map(int,re.search(r'Y=\[([^]]+)\]',ex['children'][0]['payload']['items'][-1]).group(1).split(',')))
    compare(checks,unit,'读取自测题干数组与实际答案，按时间索引计算',((t+1,out[t],data[int(s,2)][t]) for t,s in enumerate(selects)))


def verify59(checks):
    d=load(59);unit=d['unitId'];table=get(d,'002-fn-table')['payload']['rows'];pairs=[]
    for row in table:
        a,b=map(int,row[:2]);idx=2*a+b
        for data in range(2):
            actual=[data if x=='D' else x for x in row[2:]]
            pairs.append(([a,b,data],actual,[data if i==idx else 'z' for i in range(4)]))
    compare(checks,unit,'实际三态DMUX功能表对照单选定义',pairs)
    problem=get(d,'008-example')['payload']['problem'];vector=re.search(r'D7～D0=([01]+)',problem).group(1);word=int(vector,2)
    # 左端是D7，数值移位提取Dk；不用把文本正序直接当D0数组。
    answers=get(d,'009-example-ans')['payload']['items']+get(d,'011-practice-ans')['payload']['items'];claims=[]
    for text in answers:
        for k,v in re.findall(r'D(\d)=([01])(?![01])',text):claims.append((text,int(v),(word>>int(k))&1))
    compare(checks,unit,'实际例练的D5/D6答案与题干整数位权核对',claims)
    pairs=[]
    for word in range(256):
        # 两种实现：总线逐门选择/按整数位权定义。
        for addr in range(8):
            y=0
            for k in range(8):y|=((word>>k)&1)&int(k==addr)
            out=[y if i==addr else 'z' for i in range(8)]
            pairs.append(([word,addr],out,[(word>>i)&1 if i==addr else 'z' for i in range(8)]))
    compare(checks,unit,'MUX/DMUX链路全部256数据字×8地址',pairs)


def structure(checks, unit_ids=None):
    """只应用本章片段到内存副本；保留正式四样本，绝不写回。"""
    sys.path.insert(0,str(ROOT/'期中/工具'))
    from 复习内容 import validate_reading, _apply_source_proposals
    data=json.loads((ROOT/'期中/数据/知识地图.json').read_text())
    units={u['id']:u for u in data['units']};questions={q['id']:q for q in data['questions']}
    ids=unit_ids or TARGETS
    samples={k:copy.deepcopy(units[k].get('reading')) for k in ['KU-035','KU-055','KU-056','KU-063']}
    for uid in ids:
        p=HERE/'units'/f'{uid}.json';d=json.loads(p.read_text());assert d['unitId']==uid
        units[uid]['reading']=d['reading']
        _apply_source_proposals(data,d.get('sourceProposals',[]),ROOT)
        for q in d.get('questionUpdates',[]):questions[q['questionId']].update({k:v for k,v in q.items() if k!='questionId'})
        geometry=[]
        for b in flat(d['reading']['blocks']):
            if b['kind']!='figure':continue
            nodes=b['payload'].get('config',{}).get('nodes',[])
            for n in nodes:geometry.append((n['id'],70<=n['x']<=570 and 28<=n['y']<=212,True))
            for a,c in it.combinations(nodes,2):geometry.append(([a['id'],c['id']],abs(a['x']-c['x'])>=140 or abs(a['y']-c['y'])>=56,True))
            for e in b['payload'].get('config',{}).get('edges',[]):geometry.append((e,e['from'] in {n['id'] for n in nodes} and e['to'] in {n['id'] for n in nodes},True))
        compare(checks,uid,'实际figure的640×240框边界、互不遮盖、连线端点',geometry)
    errors=[];validate_reading(data,errors)
    compare(checks,'chapter','validate_reading完整权威内存副本',[(ids,errors,[])])
    compare(checks,'chapter','正式四样本reading在内存组合前后保持不变',[(uid,units[uid].get('reading'),value) for uid,value in samples.items()])
    return {uid:hashlib.sha256((HERE/'units'/f'{uid}.json').read_bytes()).hexdigest() for uid in ids}


def main(unit=None):
    checks=[]
    for n,fn in [(57,verify57),(58,verify58),(59,verify59)]:
        if unit is None or unit==f'KU-{n:03}':fn(checks)
    hashes=structure(checks,[unit] if unit else None)
    result={'scope':'TH-13 candidate only','checks':checks,'allPass':all(c['pass'] for c in checks),'caseCount':sum(c['cases'] for c in checks),'fragmentSha256':hashes,'limitations':['原页目视由人工完成，脚本不能代替view_image','未运行浏览器或正式导入']}
    out=HERE/(f'audit-{unit}.json' if unit else 'verification-independent.json')
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'allPass':result['allPass'],'checks':len(checks),'cases':result['caseCount'],'failures':[c for c in checks if not c['pass']]},ensure_ascii=False))
    return 0 if result['allPass'] else 1

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--unit',choices=TARGETS)
    raise SystemExit(main(parser.parse_args().unit))
