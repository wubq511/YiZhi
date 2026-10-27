#!/usr/bin/env python3
"""Verify second-batch actual answers against independently enumerated truth/cubes.

No old audit output or saved answer is imported. Truth inputs come from candidate
problem statements (manually checked against original images); result tables are
the actual answer under test. All 3^n cubes are enumerated independently and an
exact cover solver proves the lexicographic (terms, literals) optimum. Shared
outputs use (output,minterm) targets and ALL valid cubes, not only single-output
prime implicants. This script never writes course data or evidence files.
"""
import argparse
import copy
from functools import lru_cache
import hashlib
import itertools
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

sys.dont_write_bytecode = True
HERE=Path(__file__).resolve().parent
ROOT=next(p for p in HERE.parents if (p/'期中/工具/知识地图.py').exists())
WORK=HERE.parent
sys.path.insert(0,str(ROOT/'期中/工具'))
from 复习内容 import validate_reading

TARGETS={'TH-07':[32,33],'TH-08':[34,36,37,38],'TH-09':[39,40,41]}

def walk(blocks):
    for b in blocks:
        yield b
        yield from walk(b.get('children',[]))

def normalized(s):
    result=[]
    for c in unicodedata.normalize('NFD',s):
        if c=='\u0304':
            previous=result.pop();result.extend(['¬',previous])
        elif not c.isspace():result.append(c)
    return ''.join(result).replace('·','*').replace('×','*')

def node(op,children):
    flat=[]
    for c in children:
        if c[0]==op:flat.extend(c[1:])
        else:flat.append(c)
    return (op,*flat) if len(flat)>1 else flat[0]

class Parser:
    def __init__(self,s):
        self.s=normalized(s);self.i=0
    def peek(self):return self.s[self.i] if self.i<len(self.s) else None
    def take(self):c=self.peek();self.i+=1;return c
    def parse(self):
        n=self.or_expr()
        assert self.peek() is None, ('trailing expression',self.s[self.i:])
        return n
    def or_expr(self):
        ns=[self.and_expr()]
        while self.peek()=='+':self.take();ns.append(self.and_expr())
        return node('or',ns)
    def and_expr(self):
        ns=[self.atom()]
        while self.peek() not in (None,')','+'):
            if self.peek()=='*':self.take()
            ns.append(self.atom())
        return node('and',ns)
    def atom(self):
        c=self.take()
        if c=='¬':return ('not',self.atom())
        if c=='(':
            n=self.or_expr();assert self.take()==')';return n
        if c in ('0','1'):return ('const',int(c))
        assert c and c.isascii() and c.isalpha(), ('bad token',c,self.s)
        return ('var',c)

def ast(s):return Parser(s).parse()
def value(n,env):
    op=n[0]
    if op=='var':return env[n[1]]
    if op=='const':return n[1]
    if op=='not':return 1-value(n[1],env)
    values=[value(c,env) for c in n[1:]]
    return int(any(values) if op=='or' else all(values))
def truth(expr,variables):
    n=ast(expr)
    return {m for m,bits in enumerate(itertools.product((0,1),repeat=len(variables))) if value(n,dict(zip(variables,bits)))}
def literal(n):
    if n[0]=='var':return n[1],1
    assert n[0]=='not' and n[1][0]=='var',('not a literal',n)
    return n[1][1],0
def term_patterns(expr,variables,form='SOP'):
    n=ast(expr);outer='or' if form=='SOP' else 'and';inner='and' if form=='SOP' else 'or'
    terms=n[1:] if n[0]==outer else [n];patterns=[]
    for term in terms:
        literals=term[1:] if term[0]==inner else [term]
        fixed=dict(literal(x) for x in literals)
        assert len(fixed)==len(literals),('repeated literal',term)
        assert set(fixed)<=set(variables),(fixed,variables)
        # For POS, each clause's complement is the cube on the ZERO set.
        if form=='POS':fixed={k:1-v for k,v in fixed.items()}
        patterns.append(''.join(str(fixed[c]) if c in fixed else '-' for c in variables))
    return tuple(sorted(patterns))
def cube_cells(p):
    return frozenset(m for m in range(1<<len(p)) if all(c=='-' or int(c)==((m>>(len(p)-1-i))&1) for i,c in enumerate(p)))

def candidates_for(n,ones,dc):
    allowed=ones|dc
    return [(p,cube_cells(p)) for p in map(''.join,itertools.product('01-',repeat=n)) if cube_cells(p)<=allowed and cube_cells(p)&ones]

def cover_solver(points,candidates):
    """Each candidate=(pattern, coverage mask); return all optimum pattern sets."""
    full=(1<<len(points))-1
    choices=[[j for j,(_,mask) in enumerate(candidates) if (mask>>i)&1] for i in range(len(points))]
    assert all(choices)
    @lru_cache(None)
    def solve(mask):
        if mask==full:return (0,0,frozenset([()]))
        i=min((i for i in range(len(points)) if not (mask>>i)&1),key=lambda i:len(choices[i]))
        best=(10**6,10**6);solutions=set()
        for j in choices[i]:
            p,covered=candidates[j];count,lits,sub=solve(mask|covered)
            cost=(1+count,len(p)-p.count('-')+lits)
            if cost<best:best=cost;solutions.clear()
            if cost==best:
                solutions.update(tuple(sorted((p,)+s)) for s in sub)
        return (*best,frozenset(solutions))
    return solve(0)

@lru_cache(None)
def optimum(n,ones_tuple,dc_tuple=()):
    ones,dc=set(ones_tuple),set(dc_tuple)
    useful=candidates_for(n,ones,dc)
    primes=[(p,c) for p,c in useful if not any(c<other for _,other in useful)]
    points=sorted(ones)
    opt=cover_solver(points,[(p,sum(1<<i for i,m in enumerate(points) if m in c)) for p,c in primes])
    essential={p for p,c in primes if any(sum(m in cc for _,cc in primes)==1 for m in c&ones)}
    return opt,primes,essential

def shared_optimum(n,functions):
    points=[(i,m) for i,(on,dc) in enumerate(functions) for m in sorted(on)]
    candidates=[]
    for p in map(''.join,itertools.product('01-',repeat=n)):
        c=cube_cells(p);valid=[i for i,(on,dc) in enumerate(functions) if c<=on|dc]
        mask=sum(1<<j for j,(i,m) in enumerate(points) if i in valid and m in c)
        if mask:candidates.append((p,mask))
    return cover_solver(points,candidates)

def expression_in(text,label):
    pattern=rf'{re.escape(label)}(?:\([^)]*\))?\s*=\s*([A-Za-z0-9¬+*·()\u0304\u0100-\u024f]+)'
    match=re.search(pattern,text)
    assert match,('expression missing',label,text)
    return match.group(1)
def minsets(text):
    values=re.findall(r'Σm\s*\(([\d,\s]+)\)',text)
    assert values,('minterm specification missing',text)
    return [set(map(int,re.sub(r'\s','',s).split(','))) for s in values]
def dontcares(text):
    matches=re.findall(r'd\s*\(([\d,\s]+)\)',text)
    return set(map(int,re.sub(r'\s','',matches[0]).split(','))) if matches else set()

class Audit:
    def __init__(self,theme=None):
        self.theme=theme;self.checks=0;self.cases=[]
        self.data=json.loads((ROOT/'期中/数据/知识地图.json').read_text())
        self.units={}
        self.qs={}
        for t,ns in TARGETS.items():
            if theme and t!=theme:continue
            for n in ns:
                p=WORK/t/f'units/KU-{n:03}.json';d=json.loads(p.read_text());self.units[n]=d
                for q in d['questionUpdates']:
                    if q['questionId'] in self.qs:self.check('proposal一致',q,self.qs[q['questionId']])
                    self.qs[q['questionId']]=q
        self.byid={b['id']:b for d in self.units.values() for b in walk(d['reading']['blocks'])}
    def check(self,label,actual,expected):
        assert actual==expected,(label,actual,expected)
        self.checks+=1
    def block(self,identifier):return self.byid[identifier]
    def problem(self,identifier):
        p=self.block(identifier)['payload']
        return self.qs[p['questionId']]['stem'] if p.get('questionId') else p['problem']
    def result_rows(self,identifier):return self.block(identifier+'-results')['payload']['rows']
    def result(self,name,variables,on,dc,row,all_solutions=None):
        label,expr,form,count,lits=row
        universe=set(range(1<<len(variables)))
        actual=truth(expr,variables)
        self.check(name+' covers all required ones',on<=actual,True)
        self.check(name+' avoids all required zeros',actual<=(on|dc),True)
        pats=term_patterns(expr,variables,form)
        target=on if form=='SOP' else universe-on-dc
        self.check(name+' actual term/literal count',(len(pats),sum(len(p)-p.count('-') for p in pats)),(count,lits))
        covered=set().union(*(cube_cells(p) for p in pats))
        self.check(name+' exact cover',target<=covered<=target|dc,True)
        opt,primes,essential=optimum(len(variables),tuple(sorted(target)),tuple(sorted(dc)))
        self.check(name+' independently proved global optimum',(count,lits),opt[:2])
        self.check(name+' actual selected cover is an optimum',pats in opt[2],True)
        self.cases.append({'name':name,'variables':variables,'ones':sorted(on),'dc':sorted(dc),'form':form,'actualExpression':expr,'computedOptimum':list(opt[:2]),'allMinimumCovers':list(map(list,sorted(opt[2])))})
        if all_solutions is not None:all_solutions.add(pats)
        return opt,primes,essential
    def simple(self,n,identifier,variables,label='F'):
        problem=self.problem(identifier)
        on=minsets(problem)[0] if 'Σm' in problem else truth(expression_in(problem,label),variables)
        dc=dontcares(problem)
        for i,row in enumerate(self.result_rows(identifier)):self.result(identifier+f'[{i}]',variables,on,dc,row)
        return on,dc
    def grid(self,identifier,variables,on,dc=(),rowvars=None,colvars=None,prefix=''):
        p=self.block(identifier)['payload'];heads=p['columns'];rows=p['rows']
        if rowvars is None:
            rowvars,colvars=re.split('[＼\\\\]',heads[0])
        rowvars=rowvars.strip();colvars=colvars.strip()
        prefixvars=variables[:len(prefix)]
        gray=lambda w:[f'{i^(i>>1):0{w}b}' for i in range(1<<w)]
        self.check(identifier+' row Gray order',[str(r[0]) for r in rows],gray(len(rowvars)))
        self.check(identifier+' column Gray order',heads[1:],gray(len(colvars)))
        for row in rows:
            for col,cell in zip(heads[1:],row[1:]):
                env=dict(zip(prefixvars,prefix));env.update(zip(rowvars,str(row[0])));env.update(zip(colvars,col))
                m=int(''.join(env[c] for c in variables),2)
                expected='d' if m in dc else str(int(m in on))
                self.check(identifier+' cell '+str(m),str(cell),expected)
    def prime_table(self,identifier,variables,on,dc):
        opt,primes,essential=optimum(len(variables),tuple(sorted(on)),tuple(sorted(dc)))
        rows=self.block(identifier)['payload']['rows']
        self.check(identifier+' complete useful prime list',
                   {term_patterns(row[0],variables)[0] for row in rows},{p for p,c in primes})
        for expr,cells,needed in rows:
            p=term_patterns(expr,variables)[0]
            self.check(identifier+' actual prime cells '+expr,set(map(int,cells.split(','))),set(cube_cells(p)))
            self.check(identifier+' actual essential status '+expr,needed=='是',p in essential)
    def structural(self):
        merged=copy.deepcopy(self.data);byuid={d['unitId']:d for d in self.units.values()}
        for u in merged['units']:
            if u['id'] in byuid:u['reading']=byuid[u['id']]['reading']
        for q in merged['questions']:
            if q['id'] in self.qs:q.update({k:v for k,v in self.qs[q['id']].items() if k!='questionId'})
        errors=[];validate_reading(merged,errors);self.check('full-map memory-copy validate_reading',errors,[])
        sources={s['id']:s for s in self.data['sources']};versions=set();cli={}
        for n,d in self.units.items():
            uid=d['unitId'];self.check('stable unit ID',uid,f'KU-{n:03}')
            ku=json.loads(subprocess.check_output([sys.executable,str(ROOT/'期中/工具/知识地图.py'),'get',uid],cwd=ROOT))
            q=json.loads(subprocess.check_output([sys.executable,str(ROOT/'期中/工具/知识地图.py'),'questions',uid,'--role','direct'],cwd=ROOT))
            cli[uid]={k:ku[k] for k in ('id','name','kind','outcome','internals')}
            cli[uid]['directQuestions']=[x['questionId'] for x in q['items']]
            self.check('outcome '+uid,d['reading']['coverage'][0]['goal'],ku['outcome'])
            for b in walk(d['reading']['blocks']):
                self.check('supported answer organization '+b['id'],'children' not in b['payload'] and 'steps' not in b['payload'],True)
                if b['kind'] in ('example','exercise'):
                    self.check('complete answer children '+b['id'],bool(b.get('children')),True)
                    qid=b['payload'].get('questionId')
                    if qid:
                        self.check('full shared proposal '+qid,qid in self.qs,True)
                        self.check('full shared fields '+qid,all(self.qs[qid].get(k) for k in ('stem','solution','answerNature')),True)
                if b['kind']=='interactive':raise AssertionError('Second batch must not pretend fixed kmap widgets implement authored examples')
                for r in b['sourceRefs']:versions.add((r['sourceId'],r['versionId']))
                if b['kind']=='figure':
                    p=b['payload']
                    if p.get('asset'):
                        m=re.fullmatch(r'/source-pages/(SRC-[^/]+)/(VER-[^/]+)/(\d+)\.png',p['asset']);assert m
                        self.check('versioned embedded original '+b['id'],any(r['sourceId']==m[1] and r['versionId']==m[2] and int(m[3]) in r['pdfPages'] for r in b['sourceRefs']),True)
                    else:
                        nodes=p['config']['nodes'];ids={x['id'] for x in nodes}
                        for x in nodes:self.check('semantic box bounds '+b['id']+x['id'],70<=x['x']<=570 and 28<=x['y']<=212,True)
                        for x,y in itertools.combinations(nodes,2):self.check('semantic no box overlap '+b['id'],abs(x['x']-y['x'])>=140 or abs(x['y']-y['y'])>=56,True)
                        for e in p['config']['edges']:self.check('semantic endpoints '+b['id'],e['from'] in ids and e['to'] in ids,True)
            t=next(t for t,ns in TARGETS.items() if n in ns)
            for p in d['evidence']['pages']:self.check('viewed image retained '+p,(WORK/t/p).is_file(),True)
        for sid,vid in versions:
            v=next(v for v in sources[sid]['versions'] if v['id']==vid)
            self.check('source version actual sha '+vid,hashlib.sha256((ROOT/v['path']).read_bytes()).hexdigest(),v['sha256'])
        return cli
    def verify07(self):
        if 32 in self.units:
            ident='RB-TH-07-032-04';self.simple(32,ident,'AB','F1')
            ident='RB-TH-07-032-07';text=self.problem(ident)
            for row in self.result_rows(ident):self.result(ident+row[0],'ABC',truth(expression_in(text,row[0]),'ABC'),set(),row)
            # Count actual AST gates from the two cost-table equations.
            rows=self.block('RB-TH-07-032-09-cost-cost-table')['payload']['rows']
            def gates(n):
                if n[0] in ('var','const'):return (0,0,0)
                vals=[gates(c) for c in n[1:]]
                return (1+sum(x[0] for x in vals),len(n)-1+sum(x[1] for x in vals),1+max(x[2] for x in vals))
            original=truth(rows[0][1],'ABCDEF')
            for row in rows:
                self.check('six-input factored truth '+row[0],truth(row[1],'ABCDEF'),original)
                self.check('six-input actual gate cost '+row[0],gates(ast(row[1])),tuple(row[2:]))
            opt,_,essential=optimum(6,tuple(sorted(original)))
            self.check('six-input SOP all prime terms essential',len(essential),opt[0])
            self.check('six-input SOP stated optimum',opt[:2],(5,13))
        if 33 in self.units:
            for row in self.block('RB-TH-07-033-02-five-methods')['payload']['rows']:
                lhs,rhs=row[1].split('=');on=truth(lhs,'ABC')
                self.check('actual algebra identity '+row[0],truth(rhs,'ABC'),on)
                pats=term_patterns(rhs,'ABC');opt=optimum(3,tuple(sorted(on)))[0]
                self.check('five methods actual reduced optimum '+row[0],(len(pats),sum(3-p.count('-') for p in pats)),opt[:2])
            for suffix in ('05-example','06-exercise'):self.simple(33,'RB-TH-07-033-'+suffix,'ABCD')
    def verify08(self):
        if 34 in self.units:
            on,dc=self.simple(34,'RB-KU-034-example','ABCD');self.grid('RB-KU-034-example-map','ABCD',on)
            self.simple(34,'RB-KU-034-practice','xyz')
            # The only actual intersection of the exercise's two claimed circles.
            patterns=term_patterns(self.result_rows('RB-KU-034-practice')[0][1],'xyz')
            self.check('actual exercise overlap is only m4',set.intersection(*(set(cube_cells(p)) for p in patterns)),{4})
            for width in (1,2):
                seq=[i^(i>>1) for i in range(1<<width)]
                for x,y in zip(seq,seq[1:]+seq[:1]):self.check('cyclic Gray adjacency',(x^y).bit_count(),1)
        if 36 in self.units:
            for parent,variables in (('RB-KU-036-example','ABCD'),('RB-KU-036-practice','xyz')):
                on=minsets(self.problem(parent))[0];selected=set()
                for row in self.result_rows(parent):opt,primes,essential=self.result(parent+row[0],variables,on,set(),row,selected)
                self.check('ALL actual minimum solutions '+parent,selected,set(opt[2]))
                self.grid(parent+'-map',variables,on)
                if variables=='ABCD':
                    table=self.block('RB-KU-036-example-pis')['payload']['rows']
                    actual={term_patterns(row[0],variables)[0] for row in table}
                    self.check('actual complete prime table',actual,{p for p,c in primes})
                    for row in table:
                        p=term_patterns(row[0],variables)[0]
                        self.check('actual prime cells '+p,set(map(int,re.findall(r'm(\d+)',row[1]))),set(cube_cells(p)))
                        self.check('actual essential marker '+p,row[2]=='是',p in essential)
                else:self.check('exercise no essential primes',essential,set())
        if 37 in self.units:
            for parent,variables in (('RB-TH-08-037-06-example-five','ABCDE'),('RB-TH-08-037-07-example-six','ABCDEF'),('RB-TH-08-037-08-practice','ABCDE')):
                on,dc=self.simple(37,parent,variables)
                if len(variables)==5 and '06-' in parent:
                    for plane in ('0','1'):self.grid('RB-TH-08-037-06-map-'+plane,variables,on,rowvars='BC',colvars='DE',prefix=plane)
                if len(variables)==6:
                    for plane in ('00','01','11','10'):self.grid('RB-TH-08-037-07-map-'+plane,variables,on,rowvars='CD',colvars='EF',prefix=plane)
                    for row in self.block('RB-TH-08-037-07-groups')['payload']['rows']:
                        p=term_patterns(row[0],variables)[0]
                        self.check('actual cross-plane group '+row[0],set(map(int,row[2].split(','))),set(cube_cells(p)))
            for a,b in itertools.combinations(('00','01','11','10'),2):self.check('plane adjacency xor '+a+b,(int(a,2)^int(b,2)).bit_count()==1,(a,b) not in (('00','11'),('01','10')))
        if 38 in self.units:
            parent='RB-TH-08-038-06-example';text=self.problem(parent);f=truth(expression_in(text,'F'),'ABC');g=truth(expression_in(text,'G'),'ABC');universe=set(range(8))
            specs={'¬F':universe-f,'Fᵈ':{m for m in universe if 7-m not in f},'FG':f&g,'F+G':f|g,'F+G另一解':f|g}
            for row in self.result_rows(parent):self.result(parent+row[0],'ABC',specs[row[0]],set(),row)
            rows=self.block('RB-TH-08-038-06-truth')['payload']['rows']
            for row in rows:
                m=int(row[0]);self.check('actual complement/dual/AND/OR row '+str(m),row[2:],[str(int(m in s)) for s in (f,universe-f,specs['Fᵈ'],g,f&g,f|g)])
            parent='RB-TH-08-038-07-practice'
            # These raw sets are stated literally in this practice's actual problem.
            problem=self.problem(parent)
            raw=re.findall(r'\{([\d,]+)\}',problem)
            ones=set(map(int,raw[0].split(',')));dc=set(map(int,raw[1].split(',')));g=minsets(problem)[0]
            out_and=set();dc_and=set();out_or=set();dc_or=set()
            computed=[]
            for m in range(8):
                vals={0,1} if m in dc else {int(m in ones)};gv=int(m in g)
                andvals={v&gv for v in vals};orvals={v|gv for v in vals}
                for values,out,destdc in ((andvals,out_and,dc_and),(orvals,out_or,dc_or)):
                    if len(values)==2:destdc.add(m)
                    elif values=={1}:out.add(m)
                cv=lambda vs:'d' if len(vs)==2 else str(next(iter(vs)))
                computed.append([str(m),f'{m:03b}','d' if m in dc else str(int(m in ones)),str(gv),cv(andvals),cv(orvals)])
            self.check('actual entire d operation table',self.block('RB-TH-08-038-07-truth')['payload']['rows'],computed)
            for row in self.result_rows(parent):self.result(parent+row[0],'ABC',out_and if row[0]=='F1F2' else out_or,dc_and if row[0]=='F1F2' else dc_or,row)
            for v in (0,1):self.check('correlated complement OR',v|(1-v),1);self.check('correlated complement AND',v&(1-v),0)
    def verify09(self):
        if 39 in self.units:
            for suffix in ('04-example','06-q112','07-q086'):
                parent='RB-TH-09-039-'+suffix
                if suffix!='07-q086':on,dc=self.simple(39,parent,'ABCD')
                else:
                    raw=self.block('RB-TH-09-039-07-truth')['payload']['rows'];on={int(r[0]) for r in raw if r[2]=='1'};dc={int(r[0]) for r in raw if r[2]=='d'}
                    # Also compare with the full shared stem, so a second table is not silently authoritative.
                    vals=re.search(r'依次为([^；]+)',self.problem(parent)).group(1).split('、')
                    self.check('Q086 actual shared stem vs full table',[v.replace('X','d') for v in vals],[r[2] for r in raw])
                    for row in self.result_rows(parent):self.result(parent+row[0],'ABCD',on,dc,row)
                self.grid(parent.replace('-example','').replace('-q112','').replace('-q086','')+'-map','ABCD',on,dc)
                if suffix=='04-example':self.prime_table('RB-TH-09-039-04-primes','ABCD',on,dc)
            parent='RB-TH-09-039-05-comparison';problem=self.problem(parent);on=minsets(problem)[0];dc=dontcares(problem)
            for row in self.result_rows(parent):
                o=on|dc if row[0]=='全部d取1' else on;d=dc if row[0].startswith('独立') else set()
                self.result(parent+row[0],'ABCD',o,d,row)
            self.grid('RB-TH-09-039-05-map','ABCD',on,dc)
        if 40 in self.units:
            for suffix,variables in (('05-example','ABCD'),('06-dexample','ABCD'),('07-practice','ABC')):
                parent='RB-TH-09-040-'+suffix;on,dc=self.simple(40,parent,variables)
                self.grid('RB-TH-09-040-'+suffix[:2]+'-map',variables,on,dc)
                if suffix=='06-dexample':self.prime_table('RB-TH-09-040-06-primes',variables,set(range(16))-on-dc,dc)
            # Raw alternate H is transcribed from the viewed page, not an alleged equivalent F.
            f=truth(expression_in(self.problem('RB-TH-09-040-05-example'),'F'),'ABCD')
            h=truth('(¬A+D)(B+¬D)(A+B)','ABCD')
            self.check('P31 H simplification',h,truth('B(¬A+D)','ABCD'))
            self.check('P31 real counterexample 0000',(0 in f,0 in h),(True,False))
        if 41 in self.units:
            for parent,variables in (('RB-TH-09-041-04-example','ABC'),('RB-TH-09-041-06-q087','ABCD')):
                functions=minsets(self.problem(parent));self.check('two outputs in actual problem',len(functions),2)
                truth_id=parent.replace('-example','').replace('-q087','')+'-truth'
                self.check('multi-output truth all inputs',
                           self.block(truth_id)['payload']['rows'],
                           [[str(m),f'{m:0{len(variables)}b}',*[str(int(m in f)) for f in functions]] for m in range(1<<len(variables))])
                for row in self.block(parent+'-local-results')['payload']['rows']:
                    scheme,label,expr,count,lits=row;i=int(label[-1])-1
                    self.check('actual multi-output expression '+label,truth(expr,variables),functions[i])
                    pats=term_patterns(expr,variables)
                    self.check('actual local cost',(len(pats),sum(len(variables)-p.count('-') for p in pats)),(count,lits))
                    if scheme=='各自最简':self.result(parent+scheme+label,variables,functions[i],set(),[label,expr,'SOP',count,lits])
                pool=self.block(parent+'-shared-results')['payload']['rows'];unique={};cover=[set(),set()]
                for name,expr,outs in pool:
                    pats=term_patterns(expr,variables);self.check('one physical product',len(pats),1);p=pats[0];self.check('no duplicate physical product',p in unique,False);unique[p]=expr
                    for label in outs.split(','):
                        i=int(label[-1])-1;cells=set(cube_cells(p));self.check('shared term legal '+name,cells<=functions[i],True);cover[i]|=cells
                self.check('actual pool all outputs exactly correct',cover,functions)
                if len(variables)==4:
                    duplicate=self.block('RB-TH-09-041-06-pool')['payload']['rows']
                    self.check('Q087 explanatory pool agrees with result pool',
                               [[name,expr,outs.replace('、',',')] for name,expr,cells,outs in duplicate],pool)
                    for name,expr,cells,outs in duplicate:
                        self.check('Q087 explanatory pool actual cells '+name,
                                   set(map(int,cells.split(','))),truth(expr,variables))
                cost=(len(unique),sum(len(p)-p.count('-') for p in unique));opt=shared_optimum(len(variables),[(f,set()) for f in functions])
                self.check('global shared optimum independent exact cover',cost,opt[:2])
                self.check('actual shared optimum member',tuple(sorted(unique)) in opt[2],True)
                self.cases.append({'name':parent+' shared','computedOptimum':list(opt[:2]),'actualPool':list(unique.values()),'allMinimumPools':list(map(list,sorted(opt[2])))})

def run(theme=None):
    audit=Audit(theme);cli=audit.structural();audit.verify07();audit.verify08();audit.verify09()
    return {'theme':theme or 'all second-batch themes','unitIds':[d['unitId'] for d in audit.units.values()],
            'checksPassed':audit.checks,'minimizedCases':len(audit.cases),'failures':[],
            'validate_reading':'passed on full-map in-memory copy','cli':cli,'cases':audit.cases,
            'scope':'Candidate calculations, source fingerprints and schema only. No package/import/server/browser; no writes performed.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--all',action='store_true');args=parser.parse_args()
    report=run(None if args.all else 'TH-07')
    print(json.dumps(report,ensure_ascii=False,indent=2))
