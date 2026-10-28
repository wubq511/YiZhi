"""Synthetic legacy records through the normal public Store; no SQL manufactured rows."""
import sys
sys.dont_write_bytecode=True
import json
from pathlib import Path
from datetime import datetime,timezone
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'legacy/review-board'))
from reviewboard.storage import CourseStore
root=Path(sys.argv[1]);manifest=json.loads((root/'课程.json').read_text());store=CourseStore(root/manifest['state'],manifest['courseId'])
created=datetime.now(timezone.utc).isoformat()
note={'noteId':'NOTE-T25-OBJECT','objectId':'KU-001','text':'SYNTHETIC original thought','anchor':{'kind':'object','objectId':'KU-001','quote':'SYNTHETIC original context','sourceHash':'old-context-hash'},'createdAt':created,'updatedAt':created}
request={'operationId':'OP-T25-ORIGINAL-NOTE','actor':'student','kind':'note.create','generation':1,'expectedRevisions':{'notes:NOTE-T25-OBJECT':0},'changes':[{'namespace':'notes','key':'NOTE-T25-OBJECT','value':note}]}
receipt=store.apply(request)
def put(ns,key,value):
 old=store.read(ns,key)
 return store.apply({'operationId':'OP-T25-'+ns+'-'+key+'-'+str(old['revision']+1),'actor':'student','kind':'t25.fixture.'+ns,'generation':store.snapshot()['generation'],'expectedRevisions':{ns+':'+key:old['revision']},'changes':[{'namespace':ns,'key':key,'value':value}]})
if len(sys.argv)>2 and sys.argv[2]=='history':
 put('notes','NOTE-T25-OBJECT',dict(note,text='SYNTHETIC current edited thought',updatedAt=datetime.now(timezone.utc).isoformat()))
if len(sys.argv)>2 and sys.argv[2]=='state':
 knowledge=json.loads((root/manifest['knowledge']).read_text());unit=knowledge['units'][0];block=unit['reading']['blocks'][0]
 put('review','KU-001',{'status':'weak'});put('review','KU-086',{'status':'mastered'})
 put('layout','VE-KU-001',{'objectId':'KU-001','x':310,'y':240,'width':720,'height':480})
 for tool in ['line','wave','highlight','rectangle','ellipse','arrow']:
  key='DRAW-T25-'+tool
  put('annotations',key,{'drawingId':key,'objectId':'KU-001','tool':tool,'color':'#345d88','anchor':{'objectId':'KU-001','blockId':block['id'],'originalText':block['payload']['text']},'createdAt':created,'updatedAt':created})
  put('layout',key,{'objectId':'KU-001','blockId':block['id'],'x':10,'y':20,'width':100,'height':40})
 put('reading','default',{'selected':'KU-086','expanded':['last-material'],'camera':{'x':12,'y':34,'scale':.8},'unitScroll':{'KU-001':18,'KU-086':44},'source':{'sourceId':'SRC-TEST','versionId':'VER-TEST','location':{'pdfPage':1,'rect':[.1,.1,.8,.3]},'text':'SYNTHETIC selected source'},'sourceScroll':33,'query':'SYNTHETIC prior search'})
 put('sourceTracking','observed',{'SRC-TEST':['VER-TEST']})
 put('materialUpdates','UPDATE-T25',{'updateId':'UPDATE-T25','sourceId':'SRC-TEST','versionId':'VER-TEST','status':'later','createdAt':created,'affectedUnitIds':['KU-001']})
store.close()
if len(sys.argv)>2 and sys.argv[2]=='tasks':
 import queue,threading,time,sqlite3,shutil
 from reviewboard.service import CourseService
 from reviewboard.agent_runtime import AgentRuntime
 class Executor:
  def __init__(self,root,model): self.events=queue.Queue();self.started=threading.Event();self.thread_id=self.turn_id=None
  def connect(self): return self
  def start(self,prompt,on_mapping):
   self.thread_id='THREAD-T25-SYNTHETIC';self.turn_id='TURN-T25-SYNTHETIC';on_mapping({'threadId':self.thread_id,'turnId':self.turn_id});self.started.set()
  def next_event(self):
   try:return self.events.get(timeout=.05)
   except queue.Empty:return None
  def close(self):self.events.put(None)
  def interrupt(self):self.close()
 def wait(fn):
  end=time.monotonic()+5
  while not fn():
   if time.monotonic()>end:raise RuntimeError('Synthetic runtime did not reach checkpoint')
   time.sleep(.01)
 path=root/manifest['knowledge'];knowledge=json.loads(path.read_text());knowledge.setdefault('referenceItems',[]);knowledge.setdefault('questionCoverage',[]);path.write_text(json.dumps(knowledge,ensure_ascii=False))
 service=CourseService(root);runtime=AgentRuntime(service,Executor);service._agent=runtime
 chat=runtime.conversation();runtime.save_conversation(chat['conversationId'],{'draft':'SYNTHETIC conversation draft','title':'SYNTHETIC retained conversation'})
 task=runtime.submit({'requestId':'REQ-T25-EXECUTION','requestKind':'ask','instruction':'SYNTHETIC saved question','conversationId':chat['conversationId'],'target':{'objectId':'KU-001'}})
 wait(lambda: task['taskId'] in runtime._executors and runtime._executors[task['taskId']].started.is_set());ex=runtime._executors[task['taskId']]
 ex.events.put({'method':'item/agentMessage/delta','params':{'itemId':'T25-visible','delta':'SYNTHETIC actual controlled partial reply'}})
 wait(lambda:any(x.get('pending') for x in runtime.conversation(chat['conversationId'])['messages']))
 active=root.parent/'active-personal.sqlite3'
 with sqlite3.connect(active) as dst:service.store._connection.backup(dst)
 service.close();shutil.copyfile(active,root/manifest['state'])
 store=CourseStore(root/manifest['state'],manifest['courseId']);value=store.read('conversations',chat['conversationId'])['value'];value['messages'].insert(0,{'messageId':'SYNTHETIC-UNTHREADED','role':'user','text':'SYNTHETIC original message without a task','createdAt':created});put('conversations',chat['conversationId'],value);store.close()
print(json.dumps({'note':note,'receipt':receipt,'request':request}))
if len(sys.argv)>2 and sys.argv[2]=='content-history':
 knowledge=json.loads((root/manifest['knowledge']).read_text());before=knowledge['units'][0];store=CourseStore(root/manifest['state'],manifest['courseId']);put('knowledge','KU-001',before);value=json.loads(json.dumps(before));value['reading']['blocks'][0]['payload']['text']='SYNTHETIC old formal edited body'
 store.apply({'operationId':'OP-LEGACY-BODY','actor':'student','kind':'knowledge.edit','generation':1,'expectedRevisions':{'knowledge:KU-001':1},'changes':[{'namespace':'knowledge','key':'KU-001','value':value}]});store.close();knowledge['units'][0]=value;(root/manifest['knowledge']).write_text(json.dumps(knowledge,ensure_ascii=False))
if len(sys.argv)>2 and sys.argv[2]=='confirmed-draft':
 store=CourseStore(root/manifest['state'],manifest['courseId']);put('editingDrafts','confirmed',{'draft':request});put('editingDrafts','unresolved',{'draft':dict(request,operationId='SYNTHETIC-UNCOMMITTED')});store.close()
