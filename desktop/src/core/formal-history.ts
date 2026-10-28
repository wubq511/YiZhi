import { initializeHistoryIndex } from './history-index';
import type { BuiltinExperiments } from './builtin-experiments';
import type { FormalRelations } from './formal-relations';
import type { CourseGraph } from '../shared';
import { layoutGraph,saveLayout } from './local-layout';
import { changedCouplings,unitBlocks,linkedExperiment,isBuiltin } from './consistency-links';
import { assignments,evaluate,formulaOutputs,convertFormula } from './builtin-model';
import { unitObjects } from './history-objects';
import { equal } from '../editor-api';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseUnit, ReadingBlock } from '../shared';
import { createHash } from 'node:crypto';
import { transaction, appendEvent, eventCursor, readDrafts } from './save-store';
import type { CommandGroups } from './command-groups';
import type { AgentStore } from './agent-store';
import type { HistoryPreview, HistoryResult, HistorySelection, HistoryGroup, HistoryActivity, HistoryChange } from '../history-api';
const parse=(v:unknown)=>JSON.parse(String(v));
/** Adapts existing formal records; no second copy of historical content. */
export class FormalHistory {
  constructor(private db:DatabaseSync, private commands:CommandGroups, private agent:AgentStore, private graph:CourseGraph, private relations:FormalRelations, private experiments:BuiltinExperiments) {initializeHistoryIndex(db);}
  private hash(value:unknown) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  currentObject(id:string){return this.object(id);}
  private object(id:string):{value:Record<string,any>|null;version:number;kind:string} {
    if(id.startsWith('review:')){const unitId=id.slice(7),r=this.db.prepare('SELECT status,version FROM review_states WHERE unit_id=?').get(unitId);return {value:{unitId,status:r?String(r.status):'pending'},version:Number(r?.version??0),kind:'review'};}
    if(id.startsWith('layout:')) {const unitId=id.slice(7),n=layoutGraph(this.db,this.graph).layout.nodes.find(n=>n.unitId===unitId);return {value:n?{unitId:n.unitId,x:n.x,y:n.y,width:n.width}:null,version:Number(this.db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(unitId)?.version??0),kind:'layout'};}
    if(id.startsWith('experiment:')) {const [unitId,blockId]=id.slice(11).split('/');const value=this.experiments.formalDefinition(unitId,blockId);return {value,version:value.revision,kind:'experiment'};}
    if(id.startsWith('REL-')||/^G[A-Za-z0-9]/.test(id))return this.relations.historyObject(id);
    const row=this.db.prepare('SELECT * FROM cg_objects WHERE id=?').get(id);
    return {value:row?parse(row.value):null,version:Number(row?.version??0),kind:String(row?.kind??'unknown')};
  }
  /** Later producer domains must provide a checked inverse, never fall through as body objects. */
  private unsupported(changes:HistoryChange[]):string[] {
    return changes.filter(c=>/^(unit|graph|theme):/.test(c.objectId)||
      !['block','structure','reference','dependency','layout','experiment','formal-relation','review'].includes(this.object(c.objectId).kind)).map(c=>c.objectId);
  }
  private unsupportedReason(ids:string[]) {return `尚不支持这些结构对象的完整恢复，整个一致组保留：${ids.join('、')}`;}
  private selected(selection:HistorySelection) {
    if(selection.kind==='task')return this.groups().filter(g=>g.taskId===this.taskRoot(selection.taskId));
    if(!Array.isArray(selection.operationIds)||!selection.operationIds.length||selection.operationIds.length>1000)throw new Error('无效的撤回范围');
    return [...new Set(selection.operationIds)].map(id=>this.detail(id)).sort((a,b)=>a.order.localeCompare(b.order));
  }
  private projectUnit(unit:CourseUnit,replacements:Map<string,Record<string,any>|null>):CourseUnit {
    const seen=new Set<string>();
    const build=(parentId:string,existing:ReadingBlock[]):ReadingBlock[]=>{
      const structure=replacements.get(`structure:${parentId}`);
      const ids=structure?.blockIds??existing.map(b=>b.id);
      return ids.map((id:string)=>{
        if(seen.has(id))throw new Error('恢复结构包含重复或循环身份');seen.add(id);
        const value=replacements.has(id)?replacements.get(id):existing.find(b=>b.id===id)??this.object(id).value;
        if(!value||value.retired)throw new Error('恢复结构留下悬空内容引用');
        const b=structuredClone(value) as ReadingBlock;
        const children=build(id,b.children??existing.find(x=>x.id===id)?.children??[]);
        if(children.length||b.children)b.children=children;
        return b;
      });
    };
    return {...unit,reading:{...unit.reading,blocks:build(unit.id,unit.reading.blocks)}};
  }
  /** A projection from stored object differences; does not execute or replay old commands. */
  courseProjection(unitIds:string[],atOperationId:string,side:'before'|'after',includeLayout=false) {
    const anchor=this.detail(atOperationId),scope=new Set(unitIds),desired=new Map<string,Record<string,any>|null>();
    const later=this.groups().filter(g=>g.order>anchor.order||(side==='before'&&g.operationId===anchor.operationId)).reverse();
    // Necessary aggregates may widen a selected content range; expose that scope before applying.
    let added=true;while(added){added=false;for(const g of later)if(g.unitIds.some(id=>scope.has(id)))for(const id of g.unitIds)if(!scope.has(id)){scope.add(id);added=true;}}
    for(const g of later)if(g.unitIds.some(id=>scope.has(id))) {
      const ids=this.unsupported(g.changes);if(ids.length)throw new Error(this.unsupportedReason(ids));
      for(const c of g.changes)if((includeLayout||!c.objectId.startsWith('layout:'))&&!c.objectId.startsWith('review:'))desired.set(c.objectId,c.before);
    }
    const changes:HistoryChange[]=[];
    for(const [id,after] of desired){const now=this.object(id);if(!equal(now.value,after))changes.push({objectId:id,before:now.value,after,beforeVersion:now.version,afterVersion:now.version});}
    const units=[...scope].flatMap(id=>{const row=this.db.prepare('SELECT payload FROM units WHERE id=?').get(id);return row?[this.projectUnit(parse(row.payload),desired)]:[];});
    return {anchor,unitIds:[...scope],changes,units};
  }
  restoreInTransaction(changes:HistoryChange[],unitIds:string[]) {
    if(!this.db.isTransaction)throw new Error('整课恢复必须使用共同事务');
    const publications:Array<()=>void>=[],actual=this.write(changes,unitIds,publications);
    return {changes:actual,publish:()=>{for(const p of publications)p();}};
  }
  preview(p:any):HistoryPreview {
    let groups:HistoryGroup[],unit:CourseUnit|undefined,guardIds:string[]=[];
    const kind=p.selection?'undo':'restore';
    if(p.selection)groups=this.selected(p.selection);
    else {
      if(typeof p.unitId!=='string'||!['before','after'].includes(p.side))throw new Error('无效的单元旧版范围');
      const anchor=this.detail(p.atOperationId);
      if(!anchor.unitIds.includes(p.unitId))throw new Error('所选版本不属于该单元');
      const row=this.db.prepare('SELECT payload FROM units WHERE id=?').get(p.unitId);
      if(!row)throw new Error('单元不存在');
      const current:CourseUnit=parse(row.payload), desired=new Map<string,Record<string,any>|null>();
      const scope=new Set<string>([p.unitId]);
      const later=this.groups().filter(g=>g.order>anchor.order||(p.side==='before'&&g.operationId===anchor.operationId)).reverse();
      // Retake only this unit's content plus complete necessary domains in its original aggregates.
      for(const g of later)if(g.unitIds.includes(p.unitId)) {
        const unsupported=this.unsupported(g.changes);
        if(unsupported.length)throw new Error(this.unsupportedReason(unsupported));
        for(const c of g.changes) {
          if(!p.includeLayout&&c.objectId.startsWith('layout:'))continue;
          if(c.objectId.startsWith('review:'))continue;
          desired.set(c.objectId,c.before);
          for(const id of g.unitIds)scope.add(id);
        }
      }
      unit=this.projectUnit(current,desired);guardIds=[...unitObjects(current).keys()];
      const changes:HistoryChange[]=[];
      for(const [id,value] of desired) {const now=this.object(id);if(!equal(value,now.value))changes.push({objectId:id,before:value,after:now.value,beforeVersion:now.version,afterVersion:now.version});}
      groups=[{...anchor,unitIds:[...scope],changes,explanation:'恢复单元旧内容'}];
    }
    const affectedObjectIds=[...new Set(groups.flatMap(g=>g.changes.map(c=>c.objectId)))],unitIds=[...new Set(groups.flatMap(g=>g.unitIds))];
    const versions=[...new Set([...guardIds,...affectedObjectIds])].map(id=>[id,this.object(id).version]);
    const scope=new Set(affectedObjectIds);
    const drafts=readDrafts(this.db).filter(d=>[...d.input.changes.map(c=>c.blockId),...(d.input.formulaDrafts??[]).map(f=>f.blockId),...(d.input.patch?.updates??[]).map(u=>u.blockId),...(d.input.patch?.structure?[`structure:${d.input.patch.structure.parentId}`]:[])].some(id=>scope.has(id)||guardIds.includes(id)));
    const taskRoots=new Set(groups.map(g=>g.taskId).filter(Boolean));
    const runningTaskIds=this.db.prepare('SELECT id,payload FROM agent_tasks').all().filter(r=>taskRoots.has(this.taskRoot(String(r.id)))&&['running','queued','waiting','stopping','unknown'].includes(parse(r.payload).status)).map(r=>String(r.id));
    const sourceVersions=new Set<string>();
    const collect=(v:any):void=>{if(!v||typeof v!=='object')return;if(typeof v.versionId==='string')sourceVersions.add(v.versionId);if(typeof v.sourceCitationId==='string'){const r=this.db.prepare('SELECT version_id FROM source_citations WHERE id=?').get(v.sourceCitationId);if(r)sourceVersions.add(String(r.version_id));}for(const child of Object.values(v))if(child&&typeof child==='object')collect(child);};
    for(const g of groups) {collect(g.changes);const row=this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(g.operationId);if(row)collect(parse(row.result));}
    const identity=p.selection?{selection:p.selection}:{unitId:p.unitId,atOperationId:p.atOperationId,side:p.side,includeLayout:!!p.includeLayout};
    return {kind,...identity,unit,groups,affectedObjectIds,unitIds,sourceVersions:[...sourceVersions],runningTaskIds,drafts:drafts.length,
      explanations:[kind==='undo'?'按原一致组逆序撤回；同处后续修改保留并说明。':'仅取回所选单元课程内容；当前笔记、掌握状态、对话和未完成草稿保留。',
        ...groups.flatMap(g=>{const ids=this.unsupported(g.changes);return ids.length?[this.unsupportedReason(ids)]:[];})],
      token:this.hash([identity,groups.map(g=>[g.operationId,g.changes]),versions,drafts])};
  }
  query(id:string):HistoryResult|null {
    const row=this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(id);
    if(!row)return null;const receipt=parse(row.result);return receipt.domain==='history'?receipt:null;
  }
  apply(p:{sessionId:string;operationId:string;preview:HistoryPreview}):HistoryResult {
    if(typeof p.operationId!=='string'||!p.operationId.length||p.operationId.length>160)throw new Error('无效的恢复操作身份');
    const digest='history:'+this.hash(p.preview);
    const old=this.db.prepare('SELECT digest FROM cg_candidates WHERE id=?').get(p.operationId);
    if(old) {if(old.digest!==digest)throw new Error('同一操作身份不能换用不同恢复内容');return this.query(p.operationId)!;}
    if(this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(p.operationId))throw new Error('操作身份已用于正文修改');
    const roots=new Set(p.preview.kind==='undo'?this.selected(p.preview.selection!).map(g=>g.taskId).filter((id):id is string=>!!id):[]);
    for(const root of roots) {
      for(const r of this.db.prepare('SELECT id FROM agent_tasks').all())if(this.taskRoot(String(r.id))===root)this.agent.stop({taskId:String(r.id)});
      for(const r of this.db.prepare("SELECT id,task_id FROM cg_attempts WHERE status='running'").all())if(this.taskRoot(String(r.task_id))===root)this.commands.stop(String(r.id));
    }
    const publications:Array<()=>void>=[];
    const committed=transaction(this.db,()=>{
      const fresh=this.preview(p.preview), result:HistoryResult={operationId:p.operationId,status:'conflict',applied:[],conflicts:[],changedObjectIds:[],cursor:eventCursor(this.db)};
      if(fresh.token!==p.preview.token) result.conflicts.push({operationId:p.operationId,objectIds:fresh.affectedObjectIds,reason:'预览后相关内容或草稿已变化，请重新预览'});
      else {
        const logical=new Map<string,number>(), combined=new Map<string,HistoryChange>();
        for(const group of [...fresh.groups].reverse()) {
          const unsupported=this.unsupported(group.changes);
          if(unsupported.length) {result.conflicts.push({operationId:group.operationId,objectIds:unsupported,reason:this.unsupportedReason(unsupported)});continue;}
          const conflicts=group.changes.filter(c=>(logical.get(c.objectId)??this.object(c.objectId).version)!==c.afterVersion).map(c=>c.objectId);
          if(conflicts.length) {result.conflicts.push({operationId:group.operationId,objectIds:conflicts,reason:'同处修订已变化，整个一致组保留'});continue;}
          this.db.exec('SAVEPOINT history_group');
          let actual:HistoryChange[];const publicationStart=publications.length;
          try {actual=this.write(group.changes.map(c=>({...c,before:c.after,after:c.before})),group.unitIds,publications);this.db.exec('RELEASE history_group');}
          catch(error) {this.db.exec('ROLLBACK TO history_group');this.db.exec('RELEASE history_group');publications.length=publicationStart;
            if((error as any).code || !(error instanceof Error) || error instanceof TypeError)throw error;
            result.conflicts.push({operationId:group.operationId,objectIds:group.changes.map(c=>c.objectId),reason:(error as Error).message});continue;}

          for(const c of actual) {const previous=combined.get(c.objectId);combined.set(c.objectId,previous?{...previous,after:c.after,afterVersion:c.afterVersion}:c);}
          for(const c of group.changes)logical.set(c.objectId,c.beforeVersion);
          result.applied.push(group.operationId);
        }
        result.changedObjectIds=[...combined.keys()];result.status=result.applied.length?(result.conflicts.length?'partial':'committed'):'conflict';
        if(combined.size) {
          for(const unitId of fresh.unitIds) {
            const row=this.db.prepare('SELECT revision FROM units WHERE id=?').get(unitId);
            if(row)this.agent.studentChanged({operationId:p.operationId,unitId,revision:Number(row.revision),objectIds:result.changedObjectIds});
          }
          result.cursor=appendEvent(this.db,{type:'group.committed',operationId:p.operationId,revision:Math.max(...fresh.unitIds.map(id=>Number(this.db.prepare('SELECT revision FROM units WHERE id=?').get(id)?.revision??1))),changedObjectIds:result.changedObjectIds});
          this.db.prepare('INSERT INTO cg_candidates VALUES(?,?,?,?)').run(p.operationId,digest,'{}',JSON.stringify({...result,domain:'history'}));
          this.db.prepare('INSERT INTO cg_history VALUES(?,?)').run(p.operationId,JSON.stringify({operationId:p.operationId,actor:'student',unitIds:fresh.unitIds,explanation:fresh.kind==='undo'?'撤回所选修改':'恢复单元旧内容',generation:Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value),revision:Math.max(1,...fresh.unitIds.map(id=>Number(this.db.prepare('SELECT revision FROM units WHERE id=?').get(id)?.revision??1))),recovery:{kind:fresh.kind,sourceOperationIds:fresh.groups.map(g=>g.operationId),unitId:fresh.unitId,side:fresh.side,includeLayout:fresh.includeLayout},committedAt:new Date().toISOString(),changes:[...combined.values()]}));
        }
      }
      if(!this.db.prepare('SELECT 1 FROM cg_candidates WHERE id=?').get(p.operationId))this.db.prepare('INSERT INTO cg_candidates VALUES(?,?,?,?)').run(p.operationId,digest,'{}',JSON.stringify({...result,domain:'history'}));
      return {...result,domain:'history'} as HistoryResult;
    });
    for(const publish of publications)publish();
    return committed;
  }
  private write(changes:HistoryChange[],unitIds:string[],publications:Array<()=>void>):HistoryChange[] {
    const before=new Map(changes.map(c=>[c.objectId,this.object(c.objectId)]));
    const replacements=new Map(changes.map(c=>[c.objectId,c.after]));
    const units=new Map<string,CourseUnit>();
    for(const unitId of unitIds) {
      const row=this.db.prepare('SELECT payload FROM units WHERE id=?').get(unitId);if(!row)continue;
      const unit:CourseUnit=parse(row.payload);
      const next=this.projectUnit(unit,replacements);units.set(unitId,next);
      const bodyChanged=!equal(unit,next);
      if(!bodyChanged&&!changes.some(c=>c.objectId.startsWith(`experiment:${unitId}/`)))continue;
      const couplings=changedCouplings(unit,next);
      for(const c of changes)if(c.objectId.startsWith(`experiment:${unitId}/`))couplings.add(c.objectId.split('/')[1]);
      for(const id of couplings)if(!replacements.has(`experiment:${unitId}/${id}`))throw new Error('不能拆开历史公式与实验一致组');
      for(const f of unitBlocks(next).filter(b=>couplings.has(linkedExperiment(b)??''))) {
        const e=unitBlocks(next).find(b=>b.id===linkedExperiment(f));if(!isBuiltin(e))throw new Error('历史公式留下悬空实验引用');
        const definition=replacements.get(`experiment:${unitId}/${e!.id}`)??this.experiments.formalDefinition(unitId,e!.id);
        const checked=convertFormula(definition as any,f.payload.latex);
        if(checked.check!=='verified'||checked.outputName!==definition.outputName)throw new Error('历史公式与实验定义不能共同成立');
        if(definition.kind==='mux'&&!equal(formulaOutputs(f.payload.latex,Object.keys(definition.initialInputs)),assignments(Object.keys(definition.initialInputs)).map(bits=>evaluate(definition as any,bits).output)))throw new Error('历史公式与实验计算不一致');
      }
      if(bodyChanged)this.db.prepare('UPDATE units SET payload=?,revision=revision+1 WHERE id=?').run(JSON.stringify(next),unit.id);
    }
    for(const c of changes)if(['reference','dependency'].includes(before.get(c.objectId)!.kind))this.db.prepare('UPDATE cg_objects SET value=?,version=version+1 WHERE id=?').run(JSON.stringify(c.after??{}),c.objectId);
    const overrides=new Map<string,HistoryChange>();
    const relationChanges=changes.filter(c=>before.get(c.objectId)!.kind==='formal-relation');
    if(relationChanges.length)for(const c of this.relations.restoreInTransaction(relationChanges))overrides.set(c.objectId,c);
    for(const c of changes) {
      if(c.objectId.startsWith('review:')) {
        if(!c.after||!['pending','weak','mastered'].includes(c.after.status))throw new Error('历史掌握状态无效');
        this.db.prepare('INSERT INTO review_states VALUES(?,?,1) ON CONFLICT(unit_id) DO UPDATE SET status=excluded.status,version=version+1').run(c.objectId.slice(7),c.after.status);
      }
      if(c.objectId.startsWith('layout:')) {if(!c.after)throw new Error('历史布局缺少位置');saveLayout(this.db,this.graph,[c.after as any]);}
      if(c.objectId.startsWith('experiment:')) {
        const [unitId,blockId]=c.objectId.slice(11).split('/'),block=unitBlocks(units.get(unitId)).find(b=>b.id===blockId);
        if(!block||!c.after)throw new Error('历史实验定义缺少必要正文');
        const restored=this.experiments.restoreDefinition(unitId,block,c.after as any);
        publications.push(restored.publish);
        overrides.set(c.objectId,{...c,before:before.get(c.objectId)!.value,beforeVersion:before.get(c.objectId)!.version,after:restored.definition,afterVersion:restored.definition.revision});
      }
    }
    // Cross-block references cannot outlive their actual endpoints. Personal originals are separate roots.
    const active=new Set([...units.values()].flatMap(u=>unitBlocks(u).map(b=>b.id)));
    for(const row of this.db.prepare("SELECT id,value FROM cg_objects WHERE kind IN ('reference','dependency')").all()) {
      const v=parse(row.value);for(const id of [v.fromBlockId,v.toBlockId,v.sourceBlockId,v.dependentBlockId].filter(Boolean)) {
        const replacement=replacements.get(id),object=this.object(id).value;
        if((replacements.has(id)&&(!replacement||replacement.retired))||(!active.has(id)&&object?.retired))throw new Error('后来的引用或依赖仍使用该块，整个一致组保留');
      }
    }
    const effects=this.commands.observe(new Set(changes.filter(c=>c.objectId.startsWith('dependency:')).map(c=>c.objectId)));
    return [...effects.filter(c=>!replacements.has(c.objectId)),...changes.map(c=>overrides.get(c.objectId)??({objectId:c.objectId,before:before.get(c.objectId)!.value,after:this.object(c.objectId).value,beforeVersion:before.get(c.objectId)!.version,afterVersion:this.object(c.objectId).version}))];
  }
  private taskRoot(id:string):string {
    const seen=new Set<string>();
    while(!seen.has(id)) { seen.add(id); const row=this.db.prepare('SELECT payload FROM agent_tasks WHERE id=?').get(id); const previous=row&&parse(row.payload).continuesTaskId; if(!previous)return id; id=previous; }
    throw new Error('任务继续链无效');
  }
  private rawDetail(operationId:string):HistoryGroup {
    const index=this.db.prepare('SELECT * FROM history_index WHERE operation_id=?').get(operationId);
    const order=String(index?.seq??0).padStart(16,'0');
    if(index?.source==='placement') {
      const row=this.db.prepare("SELECT value FROM placement_history WHERE json_extract(value,'$.operationId')=?").get(operationId)!;
      const value=parse(row.value),objectId=`layout:${value.after.unitId}`;
      return {operationId,activityId:String(index.activity_id),actor:'student',committedAt:value.committedAt,explanation:'调整单元布局',unitIds:[value.after.unitId],order,source:'placement',changes:[{objectId,before:value.before,after:value.after,beforeVersion:value.beforeVersion??0,afterVersion:value.afterVersion??0}]};
    }
    const group=this.db.prepare('SELECT payload FROM cg_history WHERE operation_id=?').get(operationId);
    if(group) {
      const h=parse(group.payload), receipt=parse(this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(operationId)!.result);
      const taskId=h.taskId?this.taskRoot(h.taskId):undefined;
      const unitIds=new Set<string>(h.unitIds??(receipt.unitId?[receipt.unitId]:[]));
      for(const c of h.changes) {
        for(const v of [c.before,c.after]) if(v) { if(v.fromUnitId)unitIds.add(v.fromUnitId);if(v.toUnitId)unitIds.add(v.toUnitId); }
        if(c.objectId.startsWith('experiment:'))unitIds.add(c.objectId.slice(11).split('/')[0]);
        if(c.objectId.startsWith('layout:'))unitIds.add(c.objectId.slice(7));
      }
      return {operationId,activityId:taskId?`task:${taskId}`:`operation:${operationId}`,taskId,actor:h.actor??'agent',committedAt:h.committedAt,
        explanation:h.explanation??(taskId?'Agent 修改':'正式关系修改'),unitIds:[...unitIds],changes:h.changes,
        order,source:'group'};
    }
    const row=this.db.prepare('SELECT o.*,t.committed_at FROM operations o LEFT JOIN operation_times t ON t.operation_id=o.id WHERE o.id=?').get(operationId);
    if(!row)throw new Error('正式历史不存在或已不可恢复');
    const receipt=parse(row.receipt), before=parse(row.before_text), after=parse(row.after_text);
    const oldBlocks:ReadingBlock[]=Array.isArray(before)?before:[], nextBlocks:ReadingBlock[]=after.blocks??[];
    const changes:HistoryChange[]=after.objectChanges??[...new Set([...oldBlocks,...nextBlocks].map(b=>b.id))].map(id=>({objectId:id,before:oldBlocks.find(b=>b.id===id)??null,after:nextBlocks.find(b=>b.id===id)??null,beforeVersion:after.objectVersions?.[id]?.[0]??0,afterVersion:after.objectVersions?.[id]?.[1]??0}));
    if(!after.objectChanges) {
      if(after.structures)changes.push(...after.structures);
      else if(after.structure)changes.push({objectId:`structure:${after.structure.parentId}`,before:{blockIds:after.structure.before},after:{blockIds:after.structure.after},beforeVersion:0,afterVersion:0});
      changes.push(...(after.relatedChanges??[]));
    }
    const committedAt=String(row.committed_at??'');
    return {operationId,activityId:`edit:${receipt.sessionId}:${Math.floor(Date.parse(committedAt)/300000)}`,actor:'student',committedAt,explanation:'学生编辑正文',unitIds:[String(row.unit_id)],changes,
      order,source:'student'};
  }
  detail(operationId:string):HistoryGroup {
    const group=this.rawDetail(operationId);
    if(group.changes.every(c=>c.afterVersion>0))return group;
    // Earlier student records did not store cg revisions. Walk only their affected object's
    // subsequent formal changes backwards from the live monotonic revision, checking every value.
    // Never use equality alone to declare an old write conflict-free (ABA still consumes revisions).
    const later=this.db.prepare('SELECT operation_id FROM history_index WHERE seq>? ORDER BY seq DESC').all(Number(group.order)).map(r=>this.rawDetail(String(r.operation_id)));
    const canonical=(v:any)=>v?.retired?null:v;
    for(const c of group.changes)if(!c.afterVersion) {
      let {value,version}=this.object(c.objectId),valid=true;
      for(const g of later) {
        const next=g.changes.find(n=>n.objectId===c.objectId);if(!next)continue;
        if(!equal(canonical(value),canonical(next.after))) {valid=false;break;}
        if(next.afterVersion>0&&version!==next.afterVersion) {valid=false;break;}
        const distance=next.afterVersion>0?next.afterVersion-next.beforeVersion:Number(!equal(canonical(next.before),canonical(next.after)));
        version-=distance;value=next.before;
      }
      if(valid&&version>0&&equal(canonical(value),canonical(c.after))) {c.afterVersion=version;c.beforeVersion=version-Number(!equal(canonical(c.before),canonical(c.after)));}
    }
    return group;
  }
  private ids():string[] {
    return this.db.prepare('SELECT operation_id AS id FROM history_index ORDER BY seq').all().map(r=>String(r.id));
  }
  groups():HistoryGroup[] {return this.ids().map(id=>this.detail(id)).sort((a,b)=>a.order.localeCompare(b.order));}
  list(request:{unitId?:string;limit?:number;before?:string}) {
    const limit=request.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||(request.before!==undefined&&!/^\d{16}$/.test(request.before)))throw new Error('无效的历史分页');
    // Only small metadata is grouped. Full before/after bodies are loaded by detail/preview on demand.
    const roots=new Map<string,string>();
    for(const r of this.db.prepare('SELECT id FROM agent_tasks').all())roots.set(String(r.id),this.taskRoot(String(r.id)));
    const taskRoot=(id:string|null)=>id?roots.get(id)??id:null;
    const activities=new Map<string,HistoryActivity>();
    const rows=this.db.prepare('SELECT * FROM history_index WHERE (? IS NULL OR EXISTS(SELECT 1 FROM json_each(unit_ids) WHERE value=?)) ORDER BY seq').all(request.unitId??null,request.unitId??null);
    for(const row of rows) {
      const taskId=taskRoot(row.task_id as string|null)??undefined,id=taskId?`task:${taskId}`:String(row.activity_id),order=String(row.seq).padStart(16,'0');
      const a=activities.get(id)??{id,actor:row.actor as HistoryActivity['actor'],taskId,committedAt:String(row.committed_at),explanation:String(row.explanation),unitIds:[],operationIds:[],affectedObjectIds:[],order};
      a.committedAt=String(row.committed_at);a.order=order;a.operationIds.push(String(row.operation_id));
      a.unitIds=[...new Set([...a.unitIds,...parse(row.unit_ids)])];a.affectedObjectIds=[...new Set([...a.affectedObjectIds,...parse(row.object_ids)])];activities.set(id,a);
    }
    const sorted=[...activities.values()].sort((a,b)=>b.order.localeCompare(a.order)).filter(a=>!request.before||a.order<request.before);
    const page=sorted.slice(0,limit);return {activities:page,...(sorted.length>limit?{next:page.at(-1)!.order}:{})};
  }
  dispatch(action:string,p:any):unknown {
    if(action==='formalHistory:list')return this.list(p);
    if(action==='formalHistory:detail')return this.detail(p.operationId);
    if(action==='formalHistory:preview')return this.preview(p);
    if(action==='formalHistory:apply')return this.apply(p);
    if(action==='formalHistory:query')return this.query(p.operationId);
    throw new Error('未知历史操作');
  }
}
