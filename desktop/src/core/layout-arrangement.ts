import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BOARD_LAYOUT_POLICY_VERSION, planInitialLayout } from '../board-layout';
import type { LayoutArrangementPlan, LayoutArrangementReceipt } from '../board-layout-api';
import type { LayoutPlacement } from '../layout';
import type { CourseGraph } from '../shared';
import { historyTimestamp } from './history-clock';
import { layoutRevision, graphRevision } from './generation-lifecycle';
import { layoutGraph, saveLayout } from './local-layout';
import { appendEvent, eventCursor, transaction } from './save-store';

const POLICY_VERSION = BOARD_LAYOUT_POLICY_VERSION;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const placement = (node: LayoutPlacement): LayoutPlacement => ({unitId:node.unitId,x:node.x,y:node.y,width:node.width});

/** Includes revision counters as well as values, so an intervening change and reversal is stale. */
function basis(db:DatabaseSync,graph:CourseGraph):string {
  return hash({
    graph:layoutGraph(db,graph), graphRevision:graphRevision(db),
    relationRevision:db.prepare("SELECT value FROM metadata WHERE key='formal-relations-revision'").get()?.value,
    generation:db.prepare("SELECT value FROM metadata WHERE key='generation'").get()?.value,
    layouts:db.prepare('SELECT unit_id,version FROM layout_versions ORDER BY unit_id').all(),
    units:db.prepare('SELECT id,revision FROM units ORDER BY id').all(), policyVersion:POLICY_VERSION,
  });
}

function compute(db:DatabaseSync,graph:CourseGraph) {
  const current=layoutGraph(db,graph), token=basis(db,graph), proposed=planInitialLayout(current,{preserveExistingSizes:true});
  const proposedById=new Map(proposed.nodes.map(node=>[node.unitId,node]));
  if(proposedById.size!==current.layout.nodes.length || current.layout.nodes.some(node=>!proposedById.has(node.unitId)))
    throw new Error('整理结果中的单元身份不完整');
  const changes:LayoutArrangementPlan['changes']=current.layout.nodes.flatMap(node=>{
    const next=proposedById.get(node.unitId)!;
    const before=placement(node), after=placement(next);
    return before.x===after.x && before.y===after.y && before.width===after.width ? [] : [{before,after}];
  });
  return {plan:{basis:token,policyVersion:POLICY_VERSION,changes},proposed};
}

/** This operation is host-only: callers must explicitly request a whole-course arrangement. */
export function prepareLayoutArrangement(db:DatabaseSync,graph:CourseGraph):LayoutArrangementPlan {
  return compute(db,graph).plan;
}

export function queryLayoutArrangement(db:DatabaseSync,operationId:string):LayoutArrangementReceipt|null {
  const row=db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(operationId);
  if(!row)return null;
  const result=JSON.parse(String(row.result));
  return result.domain==='layout-arrangement'?result:null;
}

export function commitLayoutArrangement(db:DatabaseSync,graph:CourseGraph,request:{operationId:string;basis:string}):LayoutArrangementReceipt {
  if(typeof request.operationId!=='string' || !request.operationId.length || request.operationId.length>160 ||
      typeof request.basis!=='string' || !/^[a-f0-9]{64}$/.test(request.basis)) throw new Error('布局整理操作或依据无效');
  const digest=hash(['layout-arrangement',request.basis]);
  const old=db.prepare('SELECT digest,result FROM cg_candidates WHERE id=?').get(request.operationId);
  if(old) {
    if(old.digest!==digest)throw new Error('同一操作不能更换布局整理依据');
    const receipt=JSON.parse(String(old.result));
    if(receipt.domain!=='layout-arrangement')throw new Error('操作身份已用于其他修改');
    return receipt;
  }
  if(db.prepare('SELECT 1 FROM operations WHERE id=?').get(request.operationId))throw new Error('操作身份已用于正文修改');
  // Compute before the write transaction. The original input is checked again immediately before commit.
  const {plan}=compute(db,graph);
  if(plan.basis!==request.basis)throw new Error('课程或布局已变化，请重新读取后整理');
  return transaction(db,()=>{
    if(basis(db,graph)!==request.basis)throw new Error('课程或布局已变化，请重新读取后整理');
    const beforeVersions=new Map(plan.changes.map(change=>[change.before.unitId,layoutRevision(db,change.before.unitId)]));
    saveLayout(db,graph,plan.changes.map(change=>change.after));
    const changedUnitIds=plan.changes.map(change=>change.after.unitId);
    const changes=plan.changes.map(change=>({objectId:`layout:${change.after.unitId}`,before:change.before,after:change.after,
      beforeVersion:beforeVersions.get(change.before.unitId)!,afterVersion:layoutRevision(db,change.after.unitId)}));
    const revision=Number(db.prepare('SELECT coalesce(max(revision),1) AS n FROM units').get()!.n);
    const receipt:LayoutArrangementReceipt={domain:'layout-arrangement',operationId:request.operationId,
      status:changes.length?'committed':'unchanged',changedUnitIds,cursor:eventCursor(db)};
    if(changes.length) receipt.cursor=appendEvent(db,{type:'group.committed',operationId:request.operationId,revision,changedObjectIds:changes.map(change=>change.objectId)});
    db.prepare('INSERT INTO cg_candidates VALUES(?,?,?,?)').run(request.operationId,digest,'{}',JSON.stringify(receipt));
    if(changes.length)db.prepare('INSERT INTO cg_history VALUES(?,?)').run(request.operationId,JSON.stringify({
      operationId:request.operationId,actor:'student',unitIds:changedUnitIds,explanation:'整理画板布局',
      generation:Number(db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value),revision,
      committedAt:historyTimestamp(),changes,
    }));
    db.prepare("INSERT INTO metadata VALUES('layout-policy-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(POLICY_VERSION));
    return receipt;
  });
}
