"""Independent switch/network checks against actual displayed tables and source geometry."""
from decimal import Decimal
from pathlib import Path
import hashlib,itertools,json,re,sys
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[4]
sys.path.insert(0,str(ROOT/'期中/工具'));from 复习内容 import validate_reading
checks=[]
def check(name,a,b):
 assert a==b,(name,a,b)
 checks.append(name)
def fragment(n):return json.loads((HERE/'units'/f'KU-{n:03}.json').read_text())
def walk(bs):
 for b in bs:
  yield b;yield from walk(b.get('children',[]))
d=fragment(78)
rows=next(b['payload']['rows'] for b in walk(d['reading']['blocks']) if b['id'].endswith('table-diode-levels'))
for index,row in enumerate(rows):
 a,b=int(row[1]),int(row[2]);expected=min(a,b) if row[0]=='与门' else max(a,b)
 check(f'candidate diode voltage row {index}',int(row[3]),expected)
 check(f'candidate diode truth row {index}',list(map(int,row[4].split())),[int(a>0),int(b>0),int(expected>0)])
# Calculate complementary pull-up/down networks; exactly one conducts for every stable input.
for a,b in itertools.product((0,1),repeat=2):
 pullup_nand=not a or not b;pulldown_nand=bool(a and b)
 pullup_nor=not a and not b;pulldown_nor=bool(a or b)
 check(f'NAND complementary paths {a}{b}',pullup_nand,not pulldown_nand)
 check(f'NOR complementary paths {a}{b}',pullup_nor,not pulldown_nor)
 check(f'NAND stable output {a}{b}',int(pullup_nand),1-(a&b))
 check(f'NOR stable output {a}{b}',int(pullup_nor),1-(a|b))
# Constant-drop example: compare actual candidate numeric outputs to circuit voltage law.
d=fragment(79);answer=next(b for b in walk(d['reading']['blocks']) if b['id'].endswith('example-vf-answer'))['payload']['items']
for item,drop in [(answer[1],Decimal('.7')),(answer[2],Decimal('.3'))]:
 result=Decimal(re.search(r'=([0-9.]+)V',item).group(1));check('constant-drop output '+str(drop),result,Decimal(5)-drop)
# The threshold exercise states values in its actual text; classify with the source's piecewise model.
exercise=next(b for b in walk(d['reading']['blocks']) if b['id'].endswith('practice-regions'))
values=[Decimal(x.replace('−','-')) for x in re.findall(r'\(\d\)\s*([+−-][\d.]+)V',exercise['payload']['problem'])]
answers=exercise['children'][0]['payload']['items']
for value,item in zip(values,answers):
 region='breakdown' if value<=-50 else 'forward' if value>=Decimal('.7') else 'reverse-blocking' if value<0 else 'below-knee'
 actual='breakdown' if '进入反向击穿区' in item else 'reverse-blocking' if '反向截止' in item else 'below-knee' if '未达到阈值' in item else 'forward'
 check('actual voltage classification '+str(value),actual,region)
check('threshold example count',len(values),3)
# Merge the actual four readings, then validate schema and all references in course context.
course=json.loads((ROOT/'期中/数据/知识地图.json').read_text());units={u['id']:u for u in course['units']}
for n in range(78,82):
 f=fragment(n);units[f['unitId']]['reading']=f['reading']
errors=[];validate_reading(course,errors);check('actual reading schema',errors,[])
assets=[]
for p in sorted((HERE/'assets').glob('*.png')):assets.append({'name':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
report={'checks':len(checks),'passed':checks,'assets':assets,'scope':'Voltage/truth tables parsed from current candidates; complementary CMOS paths from actual series/parallel source networks; this calculation does not prove arbitrary prose or substitute for source/browser inspection.'}
(HERE/'verification-retake.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(len(checks),'checks passed')
