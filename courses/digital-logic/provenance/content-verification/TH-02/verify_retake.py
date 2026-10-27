"""Independent arithmetic checks, plus checks against displayed candidate values."""
from fractions import Fraction
import json
from pathlib import Path
import re

HERE=Path(__file__).resolve().parent
WORK=HERE.parent
checks=[]
def check(name,actual,expected):
    assert actual==expected,(name,actual,expected)
    checks.append(name)
def signed(code,width):
    sign=1<<(width-1)
    return (code^sign)-sign
def ripple(a,b,width,carry=0):
    result=0;cs=0
    for i in range(width):
        if i==width-1:cs=carry
        value=((a>>i)&1)+((b>>i)&1)+carry
        result|=(value%2)<<i;carry=value//2
    return result,cs,carry
def value(text,base):
    a,_,b=text.partition('.')
    return Fraction(int(a or '0',base))+sum((Fraction(int(c,base),base**i) for i,c in enumerate(b,1)),Fraction())
def fragment(uid):
    return json.loads((WORK/('TH-01' if int(uid[-3:])<=5 else 'TH-02')/'units'/f'{uid}.json').read_text())
def block(uid,bid):
    def walk(items):
        for b in items:
            if b['id']==bid:return b
            found=walk(b.get('children',[]))
            if found:return found
    return walk(fragment(uid)['reading']['blocks'])

for n in (4,8):
    mask=(1<<n)-1;limit=1<<(n-1);total=0
    for a in range(1<<n):
        for b in range(1<<n):
            for subtract in (False,True):
                r,cs,co=ripple(a,b^mask if subtract else b,n,int(subtract))
                truth=signed(a,n)-signed(b,n) if subtract else signed(a,n)+signed(b,n)
                expected=int(not -limit<=truth<limit)
                assert r==(a-b if subtract else a+b)&mask
                assert cs^co==expected
                total+=1
    checks.append(f'{n}-bit add/sub ripple carry, modulo and signed overflow: {total} cases')
for code in range(16):
    extended=code|0xf0 if code&8 else code
    check(f'sign extension code {code:04b}',signed(extended,8),signed(code,4))

cases=[('RB-TH-01-46-example-7-bin-to-oct','RB-TH-01-46a-example-7-bin-to-oct-ans',8),
       ('RB-TH-01-47-example-8-bin-to-hex','RB-TH-01-47a-example-8-bin-to-hex-ans',16)]
for bid,answer,base in cases:
    problem=block('KU-003',bid)['payload']['problem']
    binary=re.search(r'\(([01]+\.[01]+)\)₂',problem)[1]
    content=json.dumps(block('KU-003',answer)['payload'],ensure_ascii=False)
    target=re.search(r'\(([0-9A-F]+\.[0-9A-F]+)\)'+('₈' if base==8 else '₁₆'),content)[1]
    check(bid,value(binary,2),value(target,base))

table=block('KU-009','RB-KU-009-table-c06')['payload']['rows']
for row in table:
    a,b,r=re.fullmatch(r'([01]{8}) \+ ([01]{8}) = ([01]{8})',row[1]).groups()
    result,cs,co=ripple(int(a,2),int(b,2),8)
    check('displayed 8-bit sum '+row[0],int(r,2),result)
    check('displayed cs/co '+row[0],row[2],f'{cs} / {co}')
    check('displayed V '+row[0],int(row[3]),cs^co)

for text,base,expected in [('1C4',16,452),('8AE6',16,35558),('67.731',8,Fraction(28633,512)),
                           ('11011.1011',2,Fraction(443,16)),('0.42',8,Fraction(17,32)),
                           ('0.68',16,Fraction(13,32))]:
    check('source example '+text,value(text,base),expected)
check('same self-test octal/binary',value('11011.1011',2),value('33.54',8))
check('same self-test hex/binary',value('11011.1011',2),value('1B.B',16))
check('50GB binary-unit conversion',round(50*10**9/2**30,2),46.57)
result={'status':'passed','checks':checks,'note':'Numerical checks do not replace the recorded manual reading of every explanation and original page.'}
(HERE/'verification-retake.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':'passed','checks':len(checks),'exhaustiveArithmeticCases':2*(16**2+256**2)},ensure_ascii=False))
