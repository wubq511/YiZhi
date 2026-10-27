#!/usr/bin/env python3
"""Read candidate payloads; compare them with arithmetic/code definitions in memory.

Raw inputs may be transcribed from viewed original pages. Expected results are
computed, never copied from old audit outputs. Prose claims are manually reviewed;
the checks below bind computed values to actual tables/answers where possible.
"""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = next(p for p in HERE.parents if (p / '期中/工具/知识地图.py').exists())
sys.path.insert(0, str(ROOT / '期中/工具'))
from 复习内容 import validate_reading

def walk(blocks):
    for b in blocks:
        yield b
        yield from walk(b.get('children', []))

def run():
    data = json.loads((ROOT / '期中/数据/知识地图.json').read_text())
    baseline_sha = hashlib.sha256((ROOT / '期中/数据/知识地图.json').read_bytes()).hexdigest()
    candidates = {f'KU-{n:03}': json.loads((HERE / f'units/KU-{n:03}.json').read_text()) for n in range(11, 17)}
    results, calculations = [], {}
    def check(name, actual, expected):
        assert actual == expected, (name, actual, expected)
        results.append(name)
    def block(n, suffix):
        return next(b for b in walk(candidates[f'KU-{n:03}']['reading']['blocks']) if b['id'].endswith(suffix))
    def text(n, suffix):
        return json.dumps(block(n, suffix), ensure_ascii=False)
    updates = {}
    for c in candidates.values():
        for q in c['questionUpdates']:
            qid = q['questionId']
            if qid in updates:
                check('identical proposal ' + qid, q, updates[qid])
            updates[qid] = q
    # Only this theme's proposals are applied to an independent full-map memory copy.
    merged = copy.deepcopy(data)
    for u in merged['units']:
        if u['id'] in candidates:
            u['reading'] = candidates[u['id']]['reading']
    for q in merged['questions']:
        if q['id'] in updates:
            q.update({k: v for k, v in updates[q['id']].items() if k != 'questionId'})
    errors = []
    validate_reading(merged, errors)
    check('validate_reading full in-memory map', errors, [])
    # Read true identities/outcomes/internals/direct questions using the official CLI.
    cli = {}
    for uid, c in candidates.items():
        ku = json.loads(subprocess.check_output([sys.executable, str(ROOT/'期中/工具/知识地图.py'), 'get', uid], cwd=ROOT))
        direct = json.loads(subprocess.check_output([sys.executable, str(ROOT/'期中/工具/知识地图.py'), 'questions', uid, '--role', 'direct'], cwd=ROOT))
        check('identity ' + uid, ku['id'], uid)
        check('goal ' + uid, c['reading']['coverage'][0]['goal'], ku['outcome'])
        cli[uid] = {k: ku[k] for k in ('id','name','kind','outcome','internals','sourceRefs')}
        cli[uid]['directQuestionIds'] = [x['questionId'] for x in direct['items']]
    # Actual 0..9 code table, weighted sums, offset, unique words and complement.
    rows = block(11, 'ku11-codewords')['payload']['rows']
    check('BCD row count', len(rows), 10)
    for row in rows:
        d = int(row[0])
        for col, weights in ((1, (8,4,2,1)), (2,(2,4,2,1)), (4,(8,4,-2,-1))):
            check(f'BCD weighted d={d} col={col}', sum(int(b)*w for b,w in zip(row[col],weights)), d)
        check(f'excess3 offset {d}', int(row[3],2)-3, d)
    for col in range(1,5):
        check(f'codewords unique {col}', len({r[col] for r in rows}), 10)
    for col in (2,3,4):
        for d in range(10):
            check(f'self complement {col} {d}', int(rows[d][col],2)^15, int(rows[9-d][col],2))
    calculations['invalidWords'] = {rows[0][0] + ':' + str(col): sorted(set(f'{x:04b}' for x in range(16)) - {r[col] for r in rows}) for col in range(1,5)}
    def bcd(digits):
        return ' '.join(f'{int(c):04b}' if c != '.' else '.' for c in digits)
    def decode(s, offset=0):
        return '.'.join(''.join(str(int(x[i:i+4],2)-offset) for i in range(0,len(x),4)) for x in s.split('.'))
    for qid in ('Q-030','Q-031','Q-032','Q-035','Q-036','Q-038','Q-039'):
        q = updates[qid]
        raw = re.search(r'[01]{6,}(?:\.[01]+)?', q['stem'])
        if qid == 'Q-030':
            d = re.search(r'\d{3}', q['stem']).group()
            check(qid+' actual BCD answer', bcd(d) in q['solution'], True)
        elif qid == 'Q-031':
            check(qid+' decimal answer', decode(raw.group()) in q['solution'], True)
        elif qid == 'Q-032':
            d = int(decode(raw.group()))
            check(qid+' computed binary in answer', f'{d:b}' in q['solution'], True)
            calculations[qid] = {'sourceWord': raw.group(), 'decimal':d,'binary':f'{d:b}', 'metadataDisagreement':'taskSummary retains a different exercise input; stem proposal follows HW01 PDF5'}
        elif qid in ('Q-035','Q-036'):
            digits = decode(raw.group(),3)
            expected = ' '.join('.' if x=='.' else rows[int(x)][2] for x in digits)
            check(qid+' decimal answer', digits in q['solution'], True)
            check(qid+' 2421 answer', expected in q['solution'], True)
        else:
            value = int(raw.group(),2)
            g = value ^ (value >> 1)
            check(qid+' computed BCD', bcd(str(value)) in q['solution'], True)
            check(qid+' computed Gray', f'{g:0{len(raw.group())}b}' in q['solution'], True)
    # Q120: parse actual minterm lists, compare with +3, then simulate active-low outputs.
    q = updates['Q-120']['solution']
    sets = {label: [int(x) for x in s.split(',')] for label,s in re.findall(r'([WXYZ])=Σm\(([\d,]+)\)',q)}
    netlists = {label:[int(x) for x in re.findall(r'L(\d+)',pins)] for label,pins in re.findall(r'([WXYZ])=NAND\(([^)]+)\)',q)}
    check('Q120 complete output sets', set(sets), set('WXYZ'))
    for label, bit in zip('WXYZ',(3,2,1,0)):
        check('Q120 minterms '+label,sets[label],[d for d in range(10) if ((d+3)>>bit)&1])
        check('Q120 physical NAND inputs '+label,netlists[label],sets[label])
    out = []
    for d in range(16):
        lows = [int(i!=d) for i in range(16)]
        value = sum((1-int(all(lows[i] for i in netlists[label]))) << bit for label,bit in zip('WXYZ',(3,2,1,0)))
        check(f'Q120 circuit input {d}',value,d+3 if d<10 else 0)
        out.append(value)
    calculations['Q120 decoderCircuitOutputs'] = out
    table = block(11,'ku11-example-q120')['children'][1]['payload']['rows']
    for row in table:
        check('Q120 actual candidate table '+row[0], int(row[2],2), int(row[1],2)+3)
    # Numerical answers in actual self tests, calculated from source inputs.
    check('BCD self test 294',bcd('294') in text(11,'ku11-qr030'),True)
    check('BCD self test decoded963',decode('100101100011') in text(11,'ku11-qr030'),True)
    check('BCD self test binary69',f'{int(decode("01101001")):b}' in text(11,'ku11-qr032'),True)
    for word in ('1010','1100','0000','0111'):
        calculations['valid:'+word] = {str(col):word in {r[col] for r in rows} for col in (1,2,3)}
    # BCD add implementation vs ordinary decimal division: all digits and input carries.
    def add_column(a,b,carry):
        t=a+b+carry
        cbin,s=t>>4,t&15
        correction = 6 if cbin or s>=10 else 0
        return (s+correction)&15, int(bool(cbin or s>=10))
    for a,b,c in itertools.product(range(10),range(10),range(2)):
        check(f'BCD carry exhaustive {a}+{b}+{c}',add_column(a,b,c),((a+b+c)%10,(a+b+c)//10))
    traces=[]
    for a,b in ((295,635),(257,9840),(47,58),(83,71),(29,17)):
        ac,bc=a,b;carry=0;digits=[];trace=[]
        while ac or bc or carry:
            x,y=ac%10,bc%10;inc=carry;digit,carry=add_column(x,y,inc)
            trace.append({'a':x,'b':y,'carryIn':inc,'rawTotal':x+y+inc,'digit':digit,'carryOut':carry})
            digits.append(digit);ac//=10;bc//=10
        actual=sum(x*10**i for i,x in enumerate(digits))
        check(f'multi BCD {a}+{b}',actual,a+b)
        traces.append({'a':a,'b':b,'sum':actual,'columnsLowToHigh':trace})
    calculations['BCD column traces']=traces
    # Signed differences: decimal ten's complement is independently compared to subtraction.
    for a,b in itertools.product(range(100),repeat=2):
        total=a+(-b%100); stored=total%100
        decoded=stored if total>=100 or b==0 else -(100-stored)
        check(f'tens complement {a}-{b}',decoded,a-b)
    for n,a,b,suffix in ((12,295,635,'004-multi-digit-example'),(12,47,58,'008-practice'),(12,83,29,'008-practice')):
        value=a+b if suffix=='004-multi-digit-example' or a==47 else a-b
        check(f'actual BCD worked final {a},{b}',str(value) in text(n,suffix),True)
    # ASCII actual table and actual self-test parity.
    for row in block(13,'002-table')['payload']['rows']:
        dec=int(row[1]); check('ASCII word '+row[0],int(row[2],2),dec)
        label={'NUL':'\0','空格':' ','DEL':chr(127)}.get(row[0],row[0].strip("'"))
        check('ASCII character '+row[0],ord(label),dec)
    for char in ('A','5'):
        word=f'{ord(char):07b}'
        for target in (0,1):
            p=(word.count('1')%2)^target
            expected=str(p)+word
            suffix='006-example' if char=='A' else '007-practice'
            check(f'ASCII {char} parity{target} actual answer',expected in text(13,suffix),True)
    # Gray definition via independent reflected sequence, then actual table and circuit.
    sequence=['']
    for width in range(1,8):
        sequence=['0'+s for s in sequence]+['1'+s for s in reversed(sequence)]
        for n,s in enumerate(sequence):
            check(f'Gray definition width{width} input{n}',int(s,2),n^(n>>1))
            if n:check(f'Gray adjacent width{width} input{n}',(int(s,2)^int(sequence[n-1],2)).bit_count(),1)
    for row in block(14,'002-table')['payload']['rows']:
        check('actual Gray table '+row[0],int(row[2],2),int(row[1],2)^(int(row[1],2)>>1))
    def nand(*args):return 1-int(all(args))
    circuit=[]
    for m,x in itertools.product((0,1),range(16)):
        bits=[(x>>i)&1 for i in range(4)];y=[0]*4
        y[3]=bits[3];y[2]=bits[2]^bits[3]
        for i in (1,0):
            u=nand(m,bits[i+1]);v=nand(1-m,y[i+1]);s=nand(u,v);y[i]=bits[i]^s
        actual=sum(z<<i for i,z in enumerate(y))
        if m: expected=x^(x>>1)
        else:
            # Decode by finding the position in an independently reflected Gray list.
            seq=['']
            for _ in range(4):seq=['0'+s for s in seq]+['1'+s for s in reversed(seq)]
            expected=seq.index(f'{x:04b}')
        check(f'Q080 original NAND netlist M{m} input{x}',actual,expected)
        circuit.append({'M':m,'X':f'{x:04b}','Y':f'{actual:04b}'})
    calculations['Q080 complete circuit table']=circuit
    check('Gray actual corrected selftest',f'{5^(5>>1):04b}' in block(14,'010-practice')['children'][0]['payload']['items'][0],True)
    # Parity: every error mask, including flips of the parity bit.
    for value,mask in itertools.product(range(16),range(32)):
        p=value.bit_count()%2;word=(p<<4)|value
        received=word^mask
        check(f'parity mask {value}:{mask}',received.bit_count()%2,mask.bit_count()%2)
    for value in (9,6,15):
        even=str(value.bit_count()%2)+f'{value:04b}'
        odd=str(1-value.bit_count()%2)+f'{value:04b}'
        suffix='006-example' if value==9 else '007-practice'
        check('actual parity even '+str(value),even in text(15,suffix),True)
        if value!=15:check('actual parity odd '+str(value),odd in text(15,suffix),True)
    # Hamming: actual groups compared with binary position membership, 256 payloads x 12 errors.
    groups={int(row[0][1:]):[int(x) for x in row[1].split(',')] for row in block(16,'003-check-groups')['payload']['rows']}
    for k in (1,2,4,8):check('Hamming actual group '+str(k),groups[k],[i for i in range(1,13) if i&k])
    def syndrome(word):return sum((sum(word[i] for i in g)%2)*k for k,g in groups.items())
    for value in range(256):
        word=[0]*13
        for j,pos in enumerate(i for i in range(1,13) if i not in (1,2,4,8)):word[pos]=(value>>j)&1
        for k,g in groups.items():word[k]=sum(word[i] for i in g)%2
        check('Hamming generated legal '+str(value),syndrome(word),0)
        for pos in range(1,13):
            bad=word.copy();bad[pos]^=1
            check(f'Hamming syndrome payload{value} error{pos}',syndrome(bad),pos)
            bad[syndrome(bad)]^=1
            check(f'Hamming restore payload{value} error{pos}',bad,word)
    raw=re.search(r'[01]{12}',block(16,'006-example')['payload']['problem']).group()
    word=[0]+[int(c) for c in raw]
    check('actual Hamming original word',syndrome(word),0)
    for pos in (1,5):
        bad=word.copy();bad[pos]^=1
        check('actual Hamming example position'+str(pos),f'{syndrome(bad):04b}' in text(16,'006-example'),True)
    bad=word.copy();bad[6]^=1;bad[7]^=1
    check('actual Hamming double error answer',f'{syndrome(bad):04b}' in text(16,'007-practice'),True)
    calculations['Hamming double-error positions6,7']={'syndrome':syndrome(bad),'misidentifiedPosition':syndrome(bad)}
    # Source/fragment fingerprints make the report reproducible and expose later changes.
    evidence={'themeId':'TH-03','unitIds':list(candidates),'checksPassed':len(results),'failures':[],
              'scope':'Calculation and candidate validation only; prose manually re-read; no browser, preview server or formal import.',
              'mapSnapshotSha256':baseline_sha,'cli':cli,'calculations':calculations,
              'fragmentSha256':{uid:hashlib.sha256((HERE/f'units/{uid}.json').read_bytes()).hexdigest() for uid in candidates}}
    (HERE/'evidence/verification-candidate.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'theme':'TH-03','units':len(candidates),'checksPassed':len(results),'validate_reading':errors},ensure_ascii=False))

if __name__=='__main__':run()
