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
receipt=store.apply(request);store.close()
print(json.dumps({'note':note,'receipt':receipt,'request':request}))
