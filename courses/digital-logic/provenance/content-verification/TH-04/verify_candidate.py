#!/usr/bin/env python3
"""Independently enumerate original circuit definitions against actual candidate data."""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import re
import subprocess
import sys

HERE=Path(__file__).resolve().parent
ROOT=next(p for p in HERE.parents if (p/'期中/工具/知识地图.py').exists())
sys.path.insert(0,str(ROOT/'期中/工具'))
from 复习内容 import validate_reading

def walk(blocks):
    for b in blocks:
        yield b
        yield from walk(b.get('children',[]))

class Boolean:
    """Small evaluator for the actual authored equations, including implicit AND.

    Grammar is independent from the content provider and from old audit scripts.
    Variables are single capitals with optional digit, or one-letter intermediates
    with optional capital suffix. There is no evaluation of Python/source code.
    """
    def __init__(self,s,env):
        self.ts=re.findall(r'NAND|NOR|[A-Z]\d?|[a-z][A-Z]?|[01]|[¬+⊕⊙·*(),]',s)
        if ''.join(self.ts) != re.sub(r'\s+','',s):raise ValueError('unparsed expression '+s)
        self.i=0;self.env=env
    def peek(self):return self.ts[self.i] if self.i<len(self.ts) else None
    def take(self):
        t=self.peek();self.i+=1;return t
    def parse(self):
        value=self.or_expr()
        if self.peek() is not None:raise ValueError(self.ts[self.i:])
        return value
    def or_expr(self):
        v=self.xor_expr()
        while self.peek()=='+':
            self.take();other=self.xor_expr();v=v|other
        return v
    def xor_expr(self):
        v=self.and_expr()
        while self.peek() in ('⊕','⊙'):
            op=self.take();other=self.and_expr();v=v^other
            if op=='⊙':v=1-v
        return v
    def and_expr(self):
        v=self.atom()
        while self.peek() not in (None,')',',','+','⊕','⊙'):
            if self.peek() in ('·','*'):self.take()
            v=v&self.atom()
        return v
    def atom(self):
        t=self.take()
        if t=='¬':return 1-self.atom()
        if t=='(':
            v=self.or_expr();assert self.take()==')';return v
        if t in ('NAND','NOR'):
            assert self.take()=='('
            args=[self.or_expr()]
            while self.peek()==',':self.take();args.append(self.or_expr())
            assert self.take()==')'
            return 1-int(all(args) if t=='NAND' else any(args))
        if t in ('0','1'):return int(t)
        return self.env[t]

def evaluate(s,env):return Boolean(s,env).parse()
def run_netlist(text,env):
    env=env.copy()
    for name,expr in re.findall(r'([a-z][A-Z]?|[A-Z]\d?)=((?:NAND|NOR)\([^()]+\))',text):
        env[name]=evaluate(expr,env)
    return env

def run():
    baseline=(ROOT/'期中/数据/知识地图.json').read_bytes()
    data=json.loads(baseline)
    candidates={f'KU-{n:03}':json.loads((HERE/f'units/KU-{n:03}.json').read_text()) for n in range(17,23)}
    results=[];calculations={}
    def check(name,actual,expected):
        assert actual==expected,(name,actual,expected)
        results.append(name)
    def block(n,suffix):return next(b for b in walk(candidates[f'KU-{n:03}']['reading']['blocks']) if b['id'].endswith(suffix))
    updates={}
    for c in candidates.values():
        for q in c['questionUpdates']:
            if q['questionId'] in updates:check('same proposal '+q['questionId'],q,updates[q['questionId']])
            updates[q['questionId']]=q
    merged=copy.deepcopy(data)
    for u in merged['units']:
        if u['id'] in candidates:u['reading']=candidates[u['id']]['reading']
    for q in merged['questions']:
        if q['id'] in updates:q.update({k:v for k,v in updates[q['id']].items() if k!='questionId'})
    errors=[];validate_reading(merged,errors);check('full map in-memory validate_reading',errors,[])
    cli={}
    for uid,c in candidates.items():
        ku=json.loads(subprocess.check_output([sys.executable,str(ROOT/'期中/工具/知识地图.py'),'get',uid],cwd=ROOT))
        direct=json.loads(subprocess.check_output([sys.executable,str(ROOT/'期中/工具/知识地图.py'),'questions',uid,'--role','direct'],cwd=ROOT))
        check('identity '+uid,ku['id'],uid)
        # Existing richer wording may add subgoals; retain the official outcome here.
        cli[uid]={k:ku[k] for k in ('id','name','kind','outcome','internals','sourceRefs')}
        cli[uid]['directQuestionIds']=[x['questionId'] for x in direct['items']]
        check('core coverage '+uid,bool(c['reading']['coverage'][0]['coreBlockIds']),True)
    # Basics: compare each actual truth-table cell with Boolean definitions.
    for row in block(17,'005-truthtable')['payload']['rows']:
        a,b=int(row[0]),int(row[1])
        check('actual basic gate row '+str((a,b)),list(map(int,row[2:])),[a|b,a&b,1-a])
    for row in block(17,'011-table')['payload']['rows']:
        a,b=int(row[0]),int(row[1]);check('actual example XOR '+str((a,b)),int(row[2]),int(a!=b))
    # Same physical circuit: all rows translate both inputs AND output together.
    for row in block(18,'005-truthtable')['payload']['rows']:
        physical=re.findall(r'[HL]',row[0]);hp=[int(c=='H') for c in physical]
        pos=list(map(int,re.findall(r'[01]',row[1])));neg=list(map(int,re.findall(r'[01]',row[3])))
        check('physical unchanged '+row[0],pos,hp)
        check('negative labels '+row[0],neg,[1-x for x in hp])
        check('positive AND '+row[0],pos[2],pos[0]&pos[1])
        check('negative OR '+row[0],neg[2],neg[0]|neg[1])
    for row in block(18,'009-pos')['payload']['rows']:
        a,b,y=map(int,row[:3]);check('positive NOR example '+str((a,b)),y,1-int(bool(a or b)))
    for row in block(18,'009-neg')['payload']['rows']:
        a,b,y=map(int,row[:3]);check('negative NAND example '+str((a,b)),y,1-(a&b))
    for row in block(19,'010-tristate-table')['payload']['rows']:
        e,a=int(row[0]),int(row[1]);check('actual tristate '+str((e,a)),row[2],str(a) if e else 'Z')
    # All 3/4 input cases, AOI and parity independently from arithmetic counts.
    for bits in itertools.product((0,1),repeat=4):
        a,b,c,d=bits;env=dict(zip('ABCD',bits))
        check('NAND semantic '+str(bits),evaluate('¬(ABCD)',env),int(sum(bits)<4))
        check('NOR semantic '+str(bits),evaluate('¬(A+B+C+D)',env),int(sum(bits)==0))
        check('AOI semantic '+str(bits),evaluate('¬(AB+CD)',env),int(not ((a==b==1) or (c==d==1))))
        check('four-input XOR '+str(bits),evaluate('A⊕B⊕C⊕D',env),sum(bits)%2)
        check('cascaded XNOR caveat '+str(bits),evaluate('(A⊙B)⊙C',env),(a+b+c)%2)
    # Actual netlist table: parse the authored wiring, compare with target definitions.
    rows=block(20,'010-netlist')['payload']['rows']
    for a,b in itertools.product((0,1),repeat=2):
        env={'A':a,'B':b}
        for i,row in enumerate(rows):
            expected=[1-a,a&b,a|b][i]
            for j in (1,2):
                actual=run_netlist(row[j],env)
                check(f'actual basic netlist row{i} kind{j} input{a}{b}',actual['n' if i==0 else 'F'],expected)
    # Q101 stem retains the whole-bar BC. Both actual stem and actual NAND solution are evaluated.
    source=re.search(r'Y=([^。]+)',updates['Q-101']['stem']).group(1)
    source113=re.search(r'F=([^，。]+)',updates['Q-113']['stem']).group(1)
    truth=[]
    for a,b,c in itertools.product((0,1),repeat=3):
        env={'A':a,'B':b,'C':c}
        raw=evaluate(source,env)
        gates=run_netlist(updates['Q-101']['solution'],env)
        check('Q101 actual stem vs circuit '+str((a,b,c)),gates['Y'],raw)
        # Independent conditional description from the original function, not a saved answer vector.
        check('Q101 actual simplified expression '+str((a,b,c)),evaluate('A+¬B+¬C',env),raw)
        raw113=evaluate(source113,env)
        gates113=run_netlist(updates['Q-113']['solution'],env)
        check('Q113 actual stem vs circuit '+str((a,b,c)),gates113['F'],raw113)
        actual=run_netlist(updates['Q-081']['solution'],env)
        expected_f=int(a==1 and (b==1 or c==1));expected_g=int(a==0)
        check('Q081 actual NAND F '+str((a,b,c)),actual['F'],expected_f)
        check('Q081 actual NAND G '+str((a,b,c)),actual['g'],expected_g)
        truth.append({'ABC':f'{a}{b}{c}','Q101':raw,'Q113':raw113,'F':expected_f,'G':expected_g})
        # Actual practice's three-input NAND conversion.
        practice=block(20,'009-practice')['children'][0]['payload']['items'][2]
        practice_net=run_netlist(practice,env)
        check('actual practice NAND conversion '+str((a,b,c)),practice_net['F'],evaluate('¬(AB)+C',env))
    calculations['Q101,Q113,Q081 complete truth table']=truth
    actualtable=block(20,'008-example-q081')['children'][0]['payload']['rows']
    for row in actualtable:
        a,b,c=map(int,row[:3])
        check('actual Q081 table '+str((a,b,c)),list(map(int,row[3:5])),[int(a and (b or c)),1-a])
    # Q105 actual full expression compared with actual simplified same/equal function.
    source105=re.search(r'F=([^。]+)',updates['Q-105']['stem']).group(1)
    for a,b,c in itertools.product((0,1),repeat=3):
        env={'A':a,'B':b,'C':c}
        check('Q105 full to XNOR '+str((a,b,c)),evaluate(source105,env),a|int(b==c))
    # Source input waveform only, transcribed after actually viewing EX07 PDF12/13.
    # Outputs must be recomputed, never taken from the red answer curves or old audit vectors.
    page_inputs=[(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,1,1),(1,1,1),(1,0,1),(0,0,1)]
    computed=[]
    for a,b,c in page_inputs:
        f1=1-((1-a)*b+a*(1-b));f2=f1^c
        computed.append((f1,f2))
    for suffix in ('008-example-q114','009-example-q115','010-example-q116'):
        rows=block(21,suffix)['children'][1]['payload']['rows']
        check('complete waveform intervals '+suffix,len(rows),len(page_inputs))
        for i,row in enumerate(rows):
            check(f'actual wave inputs {suffix} interval{i}',tuple(map(int,row[2:5])),page_inputs[i])
            check(f'actual wave outputs {suffix} interval{i}',tuple(map(int,row[5:7])),computed[i])
    for qid in ('Q-114','Q-115','Q-116'):
        for index,label in ((0,'F1'),(1,'F2')):
            values=re.search(label+r'.*?八段输出依次([01、]+)',updates[qid]['solution']).group(1)
            check(f'actual shared waveform {qid} {label}',list(map(int,values.split('、'))),[p[index] for p in computed])
    calculations['waveformInputsFromViewedPage']=page_inputs
    calculations['waveformOutputsComputed']=computed
    for row in block(21,'003-xor-table')['payload']['rows']:
        a,b=int(row[0]),int(row[1]);check('actual XOR XNOR table '+str((a,b)),list(map(int,row[2:])),[a^b,int(a==b)])
    # The checkerboard is read from candidate data, compared with population-count parity.
    for row in block(21,'013-checkerboard')['payload']['rows']:
        a=int(row[0])
        for col,bc in enumerate(('00','01','11','10'),1):check('actual checkerboard '+str((a,bc)),int(row[col]),(a+bc.count('1'))%2)
    # Original P7 topology, independently compute upper/lower AND then OR.
    schematic=[]
    for a,b,c in itertools.product((0,1),repeat=3):
        u=int(b==0 and c==0);v=int(a==1 and b==0);y=int(bool(u or v))
        env={'A':a,'B':b,'C':c}
        check('P7 reduced expression '+str((a,b,c)),evaluate('¬B(¬C+A)',env),y)
        schematic.append({'ABC':f'{a}{b}{c}','U':u,'V':v,'Y':y})
    calculations['KU022 original schematic truth table']=schematic
    # Geometry check is limited to supported semantic boxes; no browser claim.
    for uid,c in candidates.items():
        for b in walk(c['reading']['blocks']):
            if b['kind']!='figure' or not b['payload'].get('config'):continue
            nodes=b['payload']['config'].get('nodes',[])
            ids={n['id'] for n in nodes}
            for n in nodes:
                check('figure bounds '+b['id']+n['id'],70<=n['x']<=570 and 28<=n['y']<=212,True)
            for x,y in itertools.combinations(nodes,2):
                check('figure boxes no overlap '+b['id']+x['id']+y['id'],abs(x['x']-y['x'])>=140 or abs(x['y']-y['y'])>=56,True)
            for e in b['payload']['config'].get('edges',[]):check('figure endpoints '+b['id']+str(e),e['from'] in ids and e['to'] in ids,True)
    evidence={'themeId':'TH-04','unitIds':list(candidates),'checksPassed':len(results),'failures':[],
              'scope':'Actual candidate tables/equations/netlists checked against original input definitions; manual prose review separate; no browser, server or import.',
              'mapSnapshotSha256':hashlib.sha256(baseline).hexdigest(),'cli':cli,'calculations':calculations,
              'fragmentSha256':{uid:hashlib.sha256((HERE/f'units/{uid}.json').read_bytes()).hexdigest() for uid in candidates}}
    (HERE/'evidence/verification-candidate.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'theme':'TH-04','units':len(candidates),'checksPassed':len(results),'validate_reading':errors},ensure_ascii=False))

if __name__=='__main__':run()
