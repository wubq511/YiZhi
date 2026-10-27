#!/usr/bin/env python3
"""检查实际片段表/式/答案。独立预期：优先序、地址值、整数加法、段位置。
仅内存组合；不写权威JSON、不改provider、不启动预览。与TH-13共用有限布尔式解析器。
"""
import argparse
import copy
import hashlib
import itertools as it
import json
from pathlib import Path
import re
import sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[4]
sys.path.insert(0,str(HERE.parent/'TH-13'))
from verify_independent import boolean, normalized, flat, get, compare
TARGETS=['KU-060','KU-061','KU-062','KU-064','KU-065','KU-066']

def load(n):return json.loads((HERE/'units'/f'KU-{n:03}.json').read_text())
def bits(n,width):return [(n>>j)&1 for j in range(width-1,-1,-1)]
def pattern(p):return it.product(*[(0,1) if c=='X' else (int(c),) for c in p.replace('H','1').replace('L','0').replace(' ','')])
def assignment(s,name):return re.search(rf'\b{name}\s*=\s*([^，。；、]+)',s).group(1)

def dec_gate(address, high, low1, low2):
    enable=high & (1-low1) & (1-low2)
    return [1-int(enable and all(bit==want for bit,want in zip(address,bits(i,3)))) for i in range(8)]

def verify60(checks):
    d=load(60);uid=d['unitId'];pairs=[]
    p=get(d,'003-priority')['payload']['text'];eq={name:assignment(p,name) for name in ['Y1','Y0']}
    table=get(d,'014-priority-table')['payload']['rows'];covered=[]
    for row in table:
        for inputs in pattern(''.join(row[:4])):
            val=int(''.join(map(str,inputs)),2);active=[i for i in range(4) if (val>>i)&1]
            expected=''.join(map(str,bits(3-max(active),2))) if active else '无有效编码'
            pairs.append((inputs,row[4],expected));covered.append(inputs)
    compare(checks,uid,'实际P47优先表展开：15非零+1无效行',pairs)
    compare(checks,uid,'实际优先表无重叠且完整覆盖16种输入',[(len(covered),len(set(covered)),16)])
    pairs=[]
    for inputs in it.product((0,1),repeat=4):
        env=dict(zip(['A3','A2','A1','A0'],inputs));active=[i for i in range(4) if env[f'A{i}']]
        if active:pairs.append((inputs,[boolean(eq[x],env) for x in ['Y1','Y0']],bits(3-max(active),2)))
    compare(checks,uid,'读取正文P47优先表达式，独立最高优先级比较',pairs)
    p=get(d,'002-normal')['payload']['text'];eq={name:assignment(p,name) for name in ['Y1','Y0']};pairs=[]
    for i in range(4):
        env={f'A{j}':int(j==i) for j in range(4)};pairs.append((i,[boolean(eq[x],env) for x in ['Y1','Y0']],bits(3-i,2)))
    compare(checks,uid,'普通编码实际公式仅在四个单有效行验证',pairs)
    p=get(d,'004-valid')['payload']['text'];eq={name:assignment(p,name) for name in ['x','y','V']};pairs=[]
    for val in range(16):
        env={f'D{i}':(val>>i)&1 for i in range(4)}
        if val:pairs.append((val,[boolean(eq[x],env) for x in ['x','y']],bits(val.bit_length()-1,2)))
        pairs.append(([val,'V'],boolean(eq['V'],env),int(val!=0)))
    compare(checks,uid,'P48按下标编码的实际公式与V',pairs)
    q=d['questionUpdates'][0];active=list(map(int,re.findall(r'I(\d)',q['stem'].split('其余')[0])));expected=bits(max(active),3)
    # 读取实际共享解答中的输出码，不把101作固定预期。
    actual=list(map(int,re.search(r'Y2Y1Y0=([01]{3})',q['solution']).group(1)))
    compare(checks,uid,'Q-088从实际题干有效输入独立求优先级',[(active,actual,expected)])
    # 8-3普通编码：正文所列三条或式对照单有效线的下标。
    p=get(d,'007-8to3')['payload']['text'];pairs=[]
    eq={name:assignment(p,name).split('（')[0] for name in ['Y2','Y1','Y0']}
    for i in range(8):
        env={f'I{j}':int(j==i) for j in range(8)};pairs.append((i,[boolean(eq[x],env) for x in ['Y2','Y1','Y0']],bits(i,3)))
    compare(checks,uid,'普通8-3实际或门表达式',pairs)


def verify61(checks):
    d=load(61);uid=d['unitId'];rows=get(d,'003-148-tbl')['payload']['rows'];pairs=[];seen=set()
    for r in rows:
        for ei in pattern(r[0]):
            for levels in pattern(r[1]):
                active=[i for i,v in enumerate(levels) if not v]
                if ei[0]:expected=[1]*5
                elif not active:expected=[1,1,1,1,0]
                else:expected=[1-b for b in bits(max(active),3)]+[0,1]
                actual=[int(c) for c in (r[2]+r[3]+r[4]).replace('H','1').replace('L','0')]
                pairs.append(([ei[0],list(levels)],actual,expected));seen.add((ei[0],*levels))
    compare(checks,uid,'实际148十行压缩表展开全部输入/使能',pairs)
    compare(checks,uid,'148覆盖512组合且无重复',[(len(pairs),len(seen),512)])
    pairs=[]
    for r in get(d,'005-147-tbl')['payload']['rows']:
        number=int(re.match(r'(\d+)',r[2]).group(1));actual=[int(c) for c in r[1].replace(' ','').replace('H','1').replace('L','0')]
        # 原页优先输入条件：所有更高编号必须为高，更低编号任意；0为全高。
        combos=[(1,)*9] if number==0 else [tuple(lower)+(0,)+(1,)*(9-number) for lower in it.product((0,1),repeat=number-1)]
        for inp in combos:
            found=max([i+1 for i,v in enumerate(inp) if v==0],default=0)
            pairs.append((inp,actual,[1-b for b in bits(found,4)]))
    compare(checks,uid,'实际147输出表对应全部512个按键电平',pairs)
    text=get(d,'009-example-ans')['payload']['items'];actual=list(map(int,re.search(r'Ȳ3Ȳ2Ȳ1Ȳ0=([01]{4})',text[2]).group(1)))
    compare(checks,uid,'147按9键示例实际反码答案',[(9,actual,[1-v for v in bits(9,4)])])


def verify62(checks):
    d=load(62);uid=d['unitId'];rows=get(d,'014-enable-table')['payload']['rows'];pairs=[]
    formula=re.search(r'即 Dk=([^。]+)',get(d,'003-enable')['payload']['text']).group(1)
    for row in rows:
        for e,a1,a0 in pattern(''.join(row[:3])):
            expected=[1-int(e==0 and k==2*a1+a0) for k in range(4)]
            pairs.append(([e,a1,a0],list(map(int,row[3:])),expected))
            calc=[boolean(formula,{'E':e,'mk':int(k==2*a1+a0)}) for k in range(4)]
            pairs.append((['formula',e,a1,a0],calc,expected))
    compare(checks,uid,'P32真实表格和实际公式：低使能极性8组',pairs)
    # 直接读取Q093实际表达式；独立参考是高七位形成的外设区段编号。
    q=d['questionUpdates'][0];eq={k:assignment(q['solution'],f'CS{k}') for k in [0,5,7]};pairs=[]
    for code in range(128):
        env={f'A{19-i}':bit for i,bit in enumerate(bits(code,7))};env['E']=int(all(env[f'A{i}']==0 for i in [19,18,17,16]))
        for k,expr in eq.items():
            pairs.append(([code,k],boolean(expr,env),0 if code==k else 1))
    compare(checks,uid,'Q-093实际共享答案对照128个地址前缀',pairs)


def verify64(checks):
    d=load(64);uid=d['unitId'];pairs=[]
    table=get(d,'007-adder-table')['payload']['rows']
    wires=get(d,'009-wiring-table')['payload']['rows'];eq={r[0][0]:r[2].split('=',1)[1] for r in wires}
    for row in table:
        n,x,y,z,c,s=map(int,row);ls=dec_gate([x,y,z],1,0,0);env={f'L{i}':v for i,v in enumerate(ls)}
        total=x+y+z;expected=[total//2,total%2]
        pairs.append((n,[c,s],expected));pairs.append((['gates',n],[boolean(eq['C'],env),boolean(eq['S'],env)],expected))
    compare(checks,uid,'全加器实际表/接线表达式对照整数三位求和',pairs)
    for tag in ['010-fourvar-even','011-fourvar-general']:
        ex=get(d,tag);m=set(map(int,re.search(r'Σm\(([^)]+)\)',ex['payload']['problem']).group(1).split(',')))
        sol=ex['children'][0]['payload']['items'];line=next(s for s in sol if 'F=¬(' in s);expression=re.search(r'F=(¬\([^)]*\))',line).group(1);pairs=[]
        for n in range(16):
            a,b,c,e=bits(n,4)
            if tag=='010-fourvar-even':ls=dec_gate([a,b,c],1,e,e);env={f'L{i}':v for i,v in enumerate(ls)}
            else:
                ls=dec_gate([b,c,e],1,a,0);rs=dec_gate([b,c,e],a,0,0);env={f'L{i}':v for i,v in enumerate(ls)}|{f'R{i}':v for i,v in enumerate(rs)}
            pairs.append((n,boolean(expression,env),int(n in m)))
        compare(checks,uid,f'{tag} 实际合并公式与原页使能接线对照题干Σm',pairs)
    ex=get(d,'012-q120');q=d['questionUpdates'][0];roweq={name:assignment(get(d,'012-q120-solution')['payload']['items'][2],name) for name in 'WXYZ'};pairs=[]
    for row in get(d,'013-q120-table')['payload']['rows']:
        n=int(row[0]);expected=bits(n+3,4);pairs.append((n,list(map(int,row[2])),expected))
        env={f'L{i}':int(i!=n) for i in range(16)};pairs.append((['gates',n],[boolean(roweq[name],env) for name in 'WXYZ'],expected))
    compare(checks,uid,'Q-120真实码表/合并式对照独立整数n+3',pairs)
    ms={name:set(map(int,terms.split(','))) for name,terms in re.findall(r'([WXYZ])=Σm\(([^)]+)\)',q['solution'])}
    compare(checks,uid,'Q-120共享题实际最小项集合独立按位反算',((name,sorted(ms[name]),[n for n in range(10) if ((n+3)>>(3-j))&1]) for j,name in enumerate('WXYZ')))
    pairs=[]
    for n in range(10,16):
        env={f'L{i}':int(i!=n) for i in range(16)};pairs.append((n,[boolean(roweq[name],env) for name in 'WXYZ'],[0]*4))
    compare(checks,uid,'Q-120本接线非法BCD的确定电路输出（非余三码定义）',pairs)
    ex=get(d,'014-practice');m=set(map(int,re.search(r'Σm\(([^)]+)\)',ex['payload']['problem']).group(1).split(',')))
    expression=re.search(r'G=(¬\([^)]*\))',ex['children'][0]['payload']['items'][1]).group(1)
    compare(checks,uid,'自测实际低有效接线对照题干最小项',((n,boolean(expression,{f'L{i}':int(i!=n) for i in range(8)}),int(n in m)) for n in range(8)))


def verify65(checks):
    d=load(65);uid=d['unitId'];rows=get(d,'003-pins')['payload']['rows'];pairs=[]
    for n in range(16):
        env={f'D{i}':(n>>i)&1 for i in range(4)};address=bits(n%8,3);out=[]
        for col in [1,2]:
            out+=dec_gate(address,*[boolean(rows[j][col],env) for j in [1,2,3]])
        pairs.append((n,out,[0 if i==n else 1 for i in range(16)]))
    compare(checks,uid,'从实际逐端接线表重建两片电路：16地址全枚举',pairs)
    pairs=[]
    for row in get(d,'009-map-table')['payload']['rows']:
        addr=int(row[0],2);pairs.append((addr,[row[1],int(row[2]),int(row[3][1:])],['U0' if addr<8 else 'U1',addr%8,addr]))
    compare(checks,uid,'实际本地/全局输出编号表',pairs)
    pairs=[]
    for t,n in it.product(range(2),range(16)):
        hi=n>>3;address=bits(n%8,3)
        actual=dec_gate(address,t,hi,hi)+dec_gate(address,t&hi,0,0)
        pairs.append(([t,n],actual,[int(not(t and i==n)) for i in range(16)]))
    compare(checks,uid,'带总使能练习：电气使能条件对照全局4:16定义',pairs)


def verify66(checks):
    d=load(66);uid=d['unitId'];pairs=[]
    rows=get(d,'004-bcd-table')['payload']['rows']
    for row in rows:
        ns=range(10,16) if '～' in row[0] else [int(row[0],2)]
        for n in ns:pairs.append((n,list(map(int,row[2].split())),[0 if n==i else 1 for i in range(10)]))
    compare(checks,uid,'二-十进制实际功能表：合法和非法BCD全部16码',pairs)
    latex=get(d,'003-bcd-formula')['payload']['latex'].split('=')[-1]
    expression=re.sub(r'\\overline\{([^{}]*)\}',r'¬(\1)',latex);expression=re.sub(r'_(\d)',r'\1',expression)
    compare(checks,uid,'实际L5公式对照地址等于5的低有效定义',((n,boolean(expression,{f'A{i}':(n>>i)&1 for i in range(4)}),int(n!=5)) for n in range(16)))
    # 独立从P45实际字形的笔画位置列出集合；不从候选段码反推。
    # 原页6不亮上横，9不亮下横，保持这两个字形变体。
    strokes={0:'abcdef',1:'bc',2:'abdeg',3:'abcdg',4:'bcfg',5:'acdfg',6:'cdefg',7:'abc',8:'abcdefg',9:'abcfg'}
    rows=get(d,'007-segment-table')['payload']['rows'];pairs=[]
    for row in rows:
        ns=range(10,16) if row[0]=='10～15' else [int(row[0])]
        for n in ns:
            expected=[int(s in strokes.get(n,'')) for s in 'abcdefg'];pairs.append((n,list(map(int,row[2:9])),expected))
            if n<10:pairs.append((['named strokes',n],set(row[9]),set(strokes[n])))
    # sets are normalized to sorted lists for JSON evidence.
    pairs=[(k,sorted(a) if isinstance(a,set) else a,sorted(b) if isinstance(b,set) else b) for k,a,b in pairs]
    compare(checks,uid,'实际4511段码与独立字形笔画集合对照',pairs)
    table=get(d,'009-controls')['payload']['rows'];pairs=[]
    for lt,bl,le,n,stored in it.product(range(2),range(2),range(2),range(16),range(16)):
        matches=[r for r in table if all(c=='X' or int(c)==v for c,v in zip(r[:3],[lt,bl,le]))]
        assert len(matches)==1
        r=matches[0]
        if r[4] in ['1111111','0000000']:actual=[int(c) for c in r[4]]
        else:actual=[int(s in strokes.get(n if r[2]=='0' else stored,'')) for s in 'abcdefg']
        # 独立控制优先级：试灯 > 消隐 > 按透明/锁存数据译码。
        expected=[1]*7 if lt==0 else [0]*7 if bl==0 else [int(s in strokes.get(stored if le else n,'')) for s in 'abcdefg']
        pairs.append(([lt,bl,le,n,stored],actual,expected))
    compare(checks,uid,'实际控制表：全2048组LT/BL/LE/当前值/保存值',pairs)
    # 实际时序例：用锁存状态机重新执行，提取正文每步明确给出的段码。
    seq=[(0,1,1,2),(1,1,1,2),(1,1,1,9),(1,0,1,9),(1,0,0,9),(1,1,1,9),(0,1,1,9)]
    stored=None;last_le=0;last_input=2;outputs=[]
    for le,bl,lt,n in seq:
        if not le:stored=n
        elif not last_le:stored=last_input
        outputs.append(''.join(map(str,([1]*7 if not lt else [0]*7 if not bl else [int(s in strokes.get(stored,'')) for s in 'abcdefg']))))
        last_le,last_input=le,n
    text=get(d,'012-sequence')['children'][0]['payload']['items'];actual=[re.search(r'[01]{7}',s).group() for s in text]
    compare(checks,uid,'锁存/消隐/试灯实际答案对照独立状态演进',[(i,a,outputs[j]) for i,(a,j) in enumerate(zip(actual,[0,2,3,4,5,6]))])


def structure(checks,ids):
    sys.path.insert(0,str(ROOT/'期中/工具'));from 复习内容 import validate_reading
    data=json.loads((ROOT/'期中/数据/知识地图.json').read_text());units={u['id']:u for u in data['units']};qs={q['id']:q for q in data['questions']}
    samples={uid:copy.deepcopy(units[uid]['reading']) for uid in ['KU-035','KU-055','KU-056','KU-063']}
    for uid in ids:
        d=json.loads((HERE/'units'/f'{uid}.json').read_text());assert d['unitId']==uid;units[uid]['reading']=d['reading']
        for q in d.get('questionUpdates',[]):qs[q['questionId']].update({k:v for k,v in q.items() if k!='questionId'})
        geo=[]
        for b in flat(d['reading']['blocks']):
            if b['kind']!='figure':continue
            nodes=b['payload']['config'].get('nodes',[])
            for n in nodes:geo.append((n['id'],70<=n['x']<=570 and 28<=n['y']<=212,True))
            for a,c in it.combinations(nodes,2):geo.append(([a['id'],c['id']],abs(a['x']-c['x'])>=140 or abs(a['y']-c['y'])>=56,True))
            for e in b['payload']['config'].get('edges',[]):geo.append((e,e['from'] in {n['id'] for n in nodes} and e['to'] in {n['id'] for n in nodes},True))
        compare(checks,uid,'实际figure的640×240框边界、互不遮盖、连线端点',geo)
    errors=[];validate_reading(data,errors);compare(checks,'chapter','validate_reading权威内存副本',[(ids,errors,[])])
    compare(checks,'chapter','四正式样本reading保留不变',[(k,units[k]['reading'],v) for k,v in samples.items()])
    return {uid:hashlib.sha256((HERE/'units'/f'{uid}.json').read_bytes()).hexdigest() for uid in ids}


def main(unit=None):
    checks=[]
    for n,fn in [(60,verify60),(61,verify61),(62,verify62),(64,verify64),(65,verify65),(66,verify66)]:
        if unit is None or unit==f'KU-{n:03}':fn(checks)
    hashes=structure(checks,[unit] if unit else TARGETS)
    result={'scope':'TH-14 candidate only','checks':checks,'allPass':all(c['pass'] for c in checks),'caseCount':sum(c['cases'] for c in checks),'fragmentSha256':hashes,'limitations':['原页目视由人工完成，脚本不能替代看图','未运行浏览器或正式导入']}
    out=HERE/(f'audit-{unit}.json' if unit else 'verification-independent.json');out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'allPass':result['allPass'],'checks':len(checks),'cases':result['caseCount'],'failures':[c for c in checks if not c['pass']]},ensure_ascii=False))
    return 0 if result['allPass'] else 1

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--unit',choices=TARGETS)
    raise SystemExit(main(parser.parse_args().unit))
