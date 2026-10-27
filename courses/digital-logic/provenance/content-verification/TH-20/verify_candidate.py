#!/usr/bin/env python3
"""Read-only candidate verification. Writes only verification-candidate.json beside this file.
Independent source inputs below transcribe visible original minterms, literal columns and
truth rows, not the old verification script or the candidate's proposed answers.
No package assembly, service, browser, import or canonical mutation is performed.
"""
import copy
import hashlib
import itertools
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[4]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / '期中/工具'))
from 复习内容 import validate_reading

REPORT = {'schema': 'th20-candidate-verification-1', 'scope': 'KU-082..086 candidate only',
          'browserAcceptance': 'not-performed; mainline required',
          'sourceMethod': 'Independent manual transcription of viewed original page literal columns / minterm specifications, compared with candidate tables and actual shared solutions. Not an OCR proof.',
          'checks': [], 'failures': []}
def check(name, condition, details=None):
    item = {'name': name, 'passed': bool(condition)}
    if details is not None: item['details'] = details
    REPORT['checks'].append(item)
    if not condition: REPORT['failures'].append(name)

def walk(bs):
    for x in bs:
        yield x
        yield from walk(x.get('children', []))

# Small independent evaluator for the literal expressions actually saved in tables/stems.
# Grammar: + (OR), · (AND), ¬ (NOT), parentheses, identifiers and 0/1.
def evaluate(expr, values):
    tokens = re.findall(r'¬|·|\+|\(|\)|[A-Za-z][A-Za-z0-9]*|[01]', expr)
    if ''.join(tokens) != re.sub(r'\s+', '', expr):
        raise ValueError('Unrecognized expression: ' + expr)
    pos = 0
    def atom():
        nonlocal pos
        t=tokens[pos]; pos+=1
        if t=='¬': return not atom()
        if t=='(':
            v=ors()
            if tokens[pos]!=')': raise ValueError(expr)
            pos+=1;return v
        if t in ('0','1'):return t=='1'
        return bool(values[t])
    def ands():
        nonlocal pos
        v=atom()
        while pos<len(tokens) and tokens[pos]=='·':
            pos+=1; rhs=atom();v=v and rhs
        return v
    def ors():
        nonlocal pos
        v=ands()
        while pos<len(tokens) and tokens[pos]=='+':
            pos+=1; rhs=ands();v=v or rhs
        return v
    value=ors()
    if pos!=len(tokens):raise ValueError(expr)
    return int(value)

def rows(n):return itertools.product((0,1), repeat=n)
def packed(text):return re.findall(r'(?<![01])[01]{16}(?![01])',text)
def sop_columns(bits, terms):
    # physically distinct positive and negative rails for each original input
    rails=[rail for x in bits for rail in (x,1-x)]
    return int(any(all(rails[i] for i in row) for row in terms))

def source95(a,b,c,d):
    # TB57/71 2.13(c): independently transcribed seven source terms
    return int((not a and not b and not c and not d) or
               (a and not b and not c) or (a and not b and c and not d) or
               (a and b and d) or (not a and not b and c and not d) or
               (b and not c and d) or not a)
def source96(a,b,c,d,e):
    # TB57/71 2.17(c): NOT applies to entire (A+D+E), no complemented inputs inside.
    return int(a*b*c or a*b*d or a*b*e or a*c*d or a*c*e or
               not (a or d or e) or (not b)*(not c)*d or
               (not b)*(not c)*e or (not b)*(not d)*(not e) or
               (not c)*(not d)*(not e))

fragments={p.stem:json.loads(p.read_text()) for p in sorted((BASE/'units').glob('KU-*.json'))}
check('exact five unit files',set(fragments)=={f'KU-{i:03d}'for i in range(82,87)})
canonical=json.loads((ROOT/'期中/数据/知识地图.json').read_text())
data=copy.deepcopy(canonical)
unitmap={u['id']:u for u in data['units']};qmap={q['id']:q for q in data['questions']}
allblocks={}; questions={}
for key,f in fragments.items():
    check(key+' fragment contract',set(f)=={'unitId','reading','questionUpdates','evidence'} and f['unitId']==key)
    unitmap[key]['reading']=f['reading']
    for q in f['questionUpdates']:
        questions[q['questionId']]=q
        qmap[q['questionId']].update({k:v for k,v in q.items() if k!='questionId'})
    for x in walk(f['reading']['blocks']):
        check(x['id']+' unique namespace',x['id'].startswith('RB-TH-20-') and x['id'] not in allblocks)
        allblocks[x['id']]=x
        if x['kind']=='figure':
            nodes=x['payload']['config']['nodes'];ids={n['id']for n in nodes}
            valid=all(70<=n['x']<=570 and 28<=n['y']<=212 for n in nodes)
            overlaps=[]
            for a,z in itertools.combinations(nodes,2):
                if abs(a['x']-z['x'])<140 and abs(a['y']-z['y'])<56: overlaps.append([a['id'],z['id']])
            edges=x['payload']['config']['edges']
            check(x['id']+' 640x240 geometry',valid and not overlaps and all(e['from']in ids and e['to']in ids for e in edges),{'nodes':len(nodes),'overlaps':overlaps})
            # At 18px, Chinese glyphs <=18px and Latin <=11px: conservative label budget.
            widths=[sum(18 if ord(ch)>127 else 11 for ch in n['label']) for n in nodes]
            check(x['id']+' short labels',all(w<=136 for w in widths),widths)
    for page in f['evidence']['pages']:check(key+' evidence '+page,(BASE/page).is_file())
    check(key+' explicitly pending browser','浏览器验收' in f['evidence']['readingReview'])
    # Scope validation to our five readings while retaining other entity identities.
for u in data['units']:
    if u['id']not in fragments:u.pop('reading',None)
errors=[];validate_reading(data,errors)
check('official validate_reading in-memory candidate',not errors,errors)
otherids={b['id']for u in canonical['units']if u['id']not in fragments for b in walk(u.get('reading',{}).get('blocks',[]))}
check('no block collision with current canonical other units',not set(allblocks)&otherids)
check('only authorized official question updates',set(questions)=={'Q-095','Q-096','Q-097','Q-098'})
check('all official answers marked derived',all(q['answerNature']=='derived-solution'for q in questions.values()))

def block(n,s):return allblocks[f'RB-TH-20-{n}-{s}']
def table(n,s):return block(n,s)['payload']['rows']

# PAL: evaluate the candidate's actual 1/0/dash connection table against the original minterm sets.
mins={'w':{2,12,13},'x':{7,8,9,10,11,12,13,14,15},
      'y':{0,2,3,4,5,6,7,8,10,11,15},'z':{1,2,8,12,13}}
pal=table('082','pal-program');pal_details=[]
for index,ins in enumerate(rows(4)):
    v=dict(zip('ABCD',ins));outputs={}
    for out in 'wxyz':
        terms=[]
        for row in pal:
            if not row[0].startswith(out):continue
            bits=[v.get(ch,outputs.get(ch))for ch in 'ABCDw']
            term=int(all(x=='–' or val==int(x)for x,val in zip(row[1:6],bits)))
            expression=evaluate(row[6],{**v,**outputs})
            check(f'PAL {row[0]} address{index} table-expression',term==expression)
            terms.append(term)
        outputs[out]=int(any(terms))
        check(f'PAL {out} original minterms address{index}',outputs[out]==int(index in mins[out]))
    pal_details.append(outputs)
check('PAL fixed OR <=3 active rows each',all(sum(row[0].startswith(o)for row in pal)<=3 for o in 'wxyz'))
# PLA original specification from C06P60, not proposed simplified formula.
pla=table('082','pla-program')
for i,ins in enumerate(rows(3)):
    terms=[int(all(bit=='–'or val==int(bit) for bit,val in zip(row[1:4],ins)))for row in pla]
    f1=int(not any(t for t,row in zip(terms,pla)if row[4]=='1'))
    f2=int(any(t for t,row in zip(terms,pla)if row[5]=='1'))
    check(f'PLA P60 original minterms {i}',(f1,f2)==(int(i in {0,1,2,4}),int(i in {0,5,6,7})))
# P82 exercise's equations and implemented shared product rows, full input domain.
for a,b,c in rows(3):
    env=dict(A=a,B=b,C=c)
    f=evaluate('A·B+¬A·C',env);g=evaluate('A·B+B·C',env)
    p1=a*b;p2=(1-a)*c;p3=b*c
    check(f'PAL/PLA exercise {a}{b}{c}',(f,g)==(int(bool(p1 or p2)),int(bool(p1 or p3))))
# No one-product cube equals G: enumerate all 3^3 legal product masks.
truth_g=[int(b and (a or c))for a,b,c in rows(3)]
possible=[tuple(int(all(s is None or s==x for s,x in zip(mask,ins)))for ins in rows(3))for mask in itertools.product((None,0,1),repeat=3)]
check('PAL G one product impossible',tuple(truth_g)not in possible)

# LUTs: candidate table, source originals, and shared solution's serialized configuration must all agree.
lut=table('083','lut-tables')
check('LUT all16 addresses in order',[r[0]for r in lut]==[format(i,'04b')for i in range(16)])
strings=[''.join(str(r[col])for r in lut)for col in range(1,6)]
check('Q095 shared solution agrees with table',packed(questions['Q-095']['solution'])==[strings[0]])
check('Q096 shared solution agrees with both tables',packed(questions['Q-096']['solution'])==strings[1:3])
check('Q097 shared solution agrees with both tables',packed(questions['Q-097']['solution'])==strings[3:5])
expr95=questions['Q-095']['stem'].split('完整函数为 Y=')[1].split('；')[0]
expr96=questions['Q-096']['stem'].split('原函数 Y=')[1].split('，')[0]
for i,ins in enumerate(rows(4)):
    check(f'Q095 source expression / candidate stem / LUT {i}',source95(*ins)==evaluate(expr95,dict(zip('ABCD',ins)))==int(lut[i][1]))
essential95=[]
for j in range(4):
    if any(source95(*ins)!=source95(*(bit^(k==j) for k,bit in enumerate(ins))) for ins in rows(4)):
        essential95.append('ABCD'[j])
check('Q095 all four variables essential; not a direct wire',len(essential95)==4,essential95)
simple96=questions['Q-096']['solution'].split('故Y=')[1].split('。')[0]
# Saved prose omits multiplication dots in this short formula: insert them between literals.
simple96=re.sub(r'([A-E])(?=¬?[A-E])',r'\1·',simple96)
for ins in rows(5):
    a,b,c,d,e=ins;gaddr=8*b+4*c;g=int(lut[gaddr][2]);addr=8*a+4*g+2*d+e
    src=source96(*ins)
    check('Q096 two-LUT network '+''.join(map(str,ins)),src==evaluate(expr96,dict(zip('ABCDE',ins)))==int(lut[addr][3]))
    check('Q096 saved simplified expression '+''.join(map(str,ins)),src==evaluate(simple96,dict(zip('ABCDE',ins))))
# Check all entries of inner LUT, including unused physical address combinations.
for i,(b,c,x,y) in enumerate(rows(4)):
    check(f'Q096 unused address replication {i}',int(lut[i][2])==int(not b and not c))
# True dependence witnesses establish single 4-input LUT insufficiency.
witnesses={}
for j,name in enumerate('ABCDE'):
    for ins in rows(5):
        changed=list(ins);changed[j]^=1
        if source96(*ins)!=source96(*changed):witnesses[name]=[list(ins),changed];break
check('Q096 five essential inputs',len(witnesses)==5,witnesses)
# Fig2-82 independently trace source input rails and OR fanout.
source97_rows=[[1,6],[2,6],[0,5,6],[0,3,4],[0,3,4,6]]
source97_fanout=[[0,2,3,4],[1,2]]
for o,fanout in enumerate(source97_fanout):
    check(f'Q097 exact output{o} fanout', [j for j,row in enumerate(table('083','q097-gates')) if row[2+o]=='1']==fanout)
formula97=questions['Q-097']['solution'].split('据图2-82推导：')[1].split('。')[0]
formulas97=[t.split('=')[1]for t in formula97.split('，')]
for i,ins in enumerate(rows(4)):
    v=dict(zip('ABCD',ins));candidate=table('083','q097-gates')
    prod=[sop_columns(ins,[cols])for cols in source97_rows]
    for j,row in enumerate(candidate):check(f'Q097 row{j+1} address{i}',evaluate(row[1],v)==prod[j])
    for o,fanout in enumerate(source97_fanout):
        expect=int(any(prod[k]for k in fanout))
        actual=int(any(evaluate(r[1],v) for r in candidate if r[2+o]=='1'))
        check(f'Q097 output{o} address{i}',expect==actual==int(lut[i][4+o]))
        check(f'Q097 saved solution expression{o} address{i}',expect==evaluate(formulas97[o],v))
# Source66 truth rows read from original slide, vs actual example's strings.
xy=block('083','xy-example')
xyans=xy['children'][0]['payload']['items']
check('P66 X actual candidate sequence','01000010' in xyans[0])
for i,(a,b,c) in enumerate(rows(3)):
    check(f'P66 truth row{i}',int((not a and not b and c)or(a and b and not c))==int('01000010'[i]))
for i,(a,b) in enumerate(rows(2)):check(f'P66 Y row{i}',int(a and not b)==int('0010'[i]))
for ins in rows(7):
    x=all(ins[:4]);actual=all((*ins[4:],x))
    check('P67 two LUTs '+''.join(map(str,ins)),actual==all(ins))
# Self-test F=ABCDE/G=A+B: evaluate 3-LUT wiring and prove two LUTs cannot suffice.
for ins in rows(5):
    a,b,c,d,e=ins;t=all(ins[:4]);check('LUT self-test '+''.join(map(str,ins)),(bool(t and e),bool(a or b))==(all(ins),bool(a or b)))
# If only two single-output LUTs serve both outputs, first must compute G, because F depends on 5 originals.
# Exhaust all choices of <=3 original signals accompanying G at the second LUT; detect conflicting rows.
conflicts=[]
for k in range(4):
    for subset in itertools.combinations(range(5),k):
        mapping={};bad=False
        for ins in rows(5):
            signature=(int(ins[0]or ins[1]),*(ins[j]for j in subset));value=int(all(ins))
            if signature in mapping and mapping[signature]!=value:bad=True;break
            mapping[signature]=value
        conflicts.append(bad)
check('LUT self-test lower bound exhaust all outer signal choices',all(conflicts),{'subsetsChecked':len(conflicts)})

# Q098: exact source column lists distinguish even equivalent constant-zero rows.
src98=[[1],[2],[4],[7],[0,2],[4,7],[1,3],[5,6],[0,2,4,6],[1,3,5,7],[0,1],list(range(8))]
cols=['A','¬A','B','¬B','C','¬C','D','¬D'];cand98=table('084','q098-connections')
for j,row in enumerate(cand98):
    check(f'Q098 physical column list row{j+1}',row[1].split('·')==[cols[i]for i in src98[j]])
seq98=['','','']
for i,ins in enumerate(rows(4)):
    for o in range(3):
        original=sop_columns(ins,src98[4*o:4*o+4])
        candidate=int(any(evaluate(row[1],dict(zip('ABCD',ins))) for row in cand98 if row[2]==f'Y{o+1}'))
        seq98[o]+=str(original)
        check(f'Q098 output{o+1} address{i}',candidate==original)
sol98=questions['Q-098']['solution']
formulas98=[t.split('=')[1] for t in sol98.split('据原图逐行推导：')[1].split('。')[0].split('；')]
check('Q098 full shared solution serialized truth tables',packed(sol98)==seq98,{'derivedFromOriginalColumns':seq98})
for i,ins in enumerate(rows(4)):
    a,b,c,d=ins
    for o,formula in enumerate(formulas98):
        check(f'Q098 saved full solution expression{o} address{i}',evaluate(formula,dict(zip('ABCD',ins)))==int(seq98[o][i]))
    check(f'Q098 simplified semantic descriptions {i}',tuple(int(x[i])for x in seq98)==(int(not a or b or c or not d),int(a==b or c!=d),int(len(set(ins))==1)))
for a,b in rows(2):
    check(f'array exercise original {a}{b}',int((a and not a)or b)==b)
    check(f'array exercise after deletion {a}{b}',int(a or b)==evaluate('A+B',dict(A=a,B=b)))
for i,(a,b,c) in enumerate(rows(3)):
    check(f'PROM specified minterm set {i}',int(i in {1,3,5,7})==c)
# CPLD numerical examples: recompute from actual saved table parameters, not the claimed result cells.
for key in ['allocation','allocation-practice']:
    row=table('085',key)[0];cap0,cap1,need0,need1,maxborrow,claimedborrow,claimedtotal,claimedok=row
    available=max(0,min(cap1-need1,maxborrow));total=cap0+available
    check('CPLD '+key,(claimedborrow,claimedtotal,claimedok)==(available,total,'是'if total>=need0 else'否'))
# LE trace uses explicit clock events, independently updates state and reads saved outputs.
state=0
for row in table('086','trace'):
    event,a,b,edge,comb,reg=row;f=a^b
    if edge:state=f
    check('LE trace '+event,(comb,reg)==(f,state))
# Clocked vs asynchronous control experiment; conditional rules rather than fixed answer literals.
for initial in (0,1):
    for edge in (0,1):
        for clear in (0,1):
            sync=0 if edge and clear else initial
            async_=0 if clear else initial
            check(f'LE control semantics q{initial} clk{edge} clr{clear}',
                  (not clear or async_==0) and (edge or sync==initial) and (not(edge and clear)or sync==0))
REPORT['files']={str(p.relative_to(BASE)):{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}for p in sorted((BASE/'units').glob('*.json'))}
REPORT['summary']={'checks':len(REPORT['checks']),'passed':sum(x['passed']for x in REPORT['checks']),'failed':len(REPORT['failures']),'units':len(fragments),'blocks':len(allblocks),'questions':sorted(questions)}
REPORT['limitations']=['原页连接由作者实际看图转录；程序不能证明转录的光学真实性，原图和逐点记录一并保留。','schema和矩形布局检查不是主线provider浏览器验收。','仅验证独占候选；未组装包、未导入、未运行正式build或服务。','状态机示例是题设抽象事件语义，不虚构器件控制优先级或传播时间参数。']
(BASE/'verification-candidate.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(REPORT['summary'],ensure_ascii=False))
if REPORT['failures']:
    print(json.dumps(REPORT['failures'],ensure_ascii=False,indent=2));sys.exit(1)
