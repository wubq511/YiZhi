"""Follow only declared merges or one unambiguous surviving fragment."""
from copy import deepcopy
from datetime import datetime, timezone
from .content_commands import entity_hash


def reconcile_anchors(service):
    catalog=service.catalog.store()
    data=getattr(catalog,'data',{})
    retired={item['id']:item for item in data.get('retiredUnits',[])}
    if not retired:
        return
    def blocks(unit):
        result=[]
        def walk(items):
            for block in items:
                result.append(block);walk(block.get('children',[]))
        walk(unit.get('reading',{}).get('blocks',[]));return result
    for namespace in ('notes','annotations'):
        for key,record in service.store.list(namespace).items():
            value=record['value']
            if not value or value.get('objectId') not in retired:
                continue
            old=retired[value['objectId']];anchor=value.get('anchor',{})
            candidates=[old['mergedInto']] if old.get('mergedInto') else old.get('splitInto',[])
            candidates=[uid for uid in candidates if isinstance(uid,str) and uid in catalog.units]
            matches=[]
            if not anchor.get('blockId') and not anchor.get('selector') and len(candidates)==1:
                matches=[(candidates[0],None)]
            else:
                exact=(anchor.get('selector') or {}).get('exact') or anchor.get('originalText')
                for uid in candidates:
                    for block in blocks(catalog.units[uid]):
                        text=block.get('payload',{}).get('text','')
                        if block['id']==anchor.get('blockId') or (isinstance(exact,str) and exact and text.count(exact)==1):
                            matches.append((uid,block['id']))
            if len(matches)!=1:
                continue  # Ambiguous splits stay in the library; never duplicate personal objects.
            uid,bid=matches[0]
            target=catalog.units[uid]
            new=deepcopy(value);new['objectId']=uid
            new['anchor']={**deepcopy(anchor),'objectId':uid,'blockId':bid,
                'revision':target.get('reading',{}).get('revision',0),
                'originalAnchor':deepcopy(anchor.get('originalAnchor') or anchor),
                'relocations':deepcopy(anchor.get('relocations',[]))+[{
                    'objectId':anchor.get('objectId'),'blockId':anchor.get('blockId'),
                    'revision':anchor.get('revision'),'originalText':anchor.get('originalText'),
                    'sourceRefs':deepcopy(anchor.get('sourceRefs',[])),
                    'reason':'明确的合并目标或唯一保留片段','at':datetime.now(timezone.utc).isoformat()}]}
            changes=[{'namespace':namespace,'key':key,'value':new}]
            revisions={namespace+':'+key:record['revision']}
            if namespace=='annotations':
                layout=service.store.read('layout',key)
                if layout['value']:
                    changes.append({'namespace':'layout','key':key,'value':{**layout['value'],'objectId':uid,'blockId':bid}})
                    revisions['layout:'+key]=layout['revision']
            snapshot=service.store.snapshot()
            service.apply_command({'operationId':'OP-ANCHOR-'+entity_hash([namespace,key,record['revision'],uid,bid]),
                'actor':'import','kind':'anchor.follow','generation':snapshot['generation'],
                'changes':changes,'expectedRevisions':revisions})
