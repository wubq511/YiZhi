import sys,json
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'legacy/review-board'))
from reviewboard.service import CourseService
from reviewboard.storage import CourseStore
from reviewboard.content_commands import ContentCommands
root=Path(sys.argv[1]);service=CourseService(root);content=ContentCommands(service,initialize=False)
service.store._connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
print(json.dumps({'ready':True}),flush=True)
sys.stdin.readline();result=[]
def probe(name,fn):
 try:fn();result.append({'name':name,'accepted':True})
 except Exception as error:result.append({'name':name,'accepted':False,'error':str(error)})
def command():
 r=service.store.read('editingDrafts','fence-tail')
 return {'operationId':'FENCE-T25-'+str(len(result)),'actor':'student','kind':'personal.update','generation':service.store.snapshot()['generation'],'expectedRevisions':{'editingDrafts:fence-tail':r['revision']},'changes':[{'namespace':'editingDrafts','key':'fence-tail','value':{'type':'agent','text':'Must never persist'}}]}
probe('held Store',lambda:service.store.apply(command()))
probe('held Service',lambda:service.apply_command(command()))
probe('fresh Store',lambda:CourseStore(root/service.manifest['state'],service.manifest['courseId']))
probe('fresh Service',lambda:CourseService(root))
def lease():
 with content.writer_lock():pass
probe('held content writer lock',lease)
print(json.dumps(result,ensure_ascii=False),flush=True);service.close()
