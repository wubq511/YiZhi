import type { FormalRelations } from './formal-relations';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentIdentity, AgentMutation } from '../agent-mutation-api';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { ContentPatch } from '../editor-api';
import type { CommandGroups } from './command-groups';
import type { AgentStore } from './agent-store';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const keys = (v: any, allowed: string[]) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k=>!allowed.includes(k))) throw new Error('修改工具包含不支持的字段'); };
/** No filesystem/SQL/personal-note authority. All writes use the existing editor and command validators. */
export class AgentMutations {
 constructor(private db:DatabaseSync,private groups:CommandGroups,private agent:AgentStore,private unit:(id:string)=>CourseUnit|undefined,private relations:FormalRelations) {
  db.exec('CREATE TABLE IF NOT EXISTS agent_mutation_requests(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL)');
 }
 private active(r:AgentIdentity) {
  const task=this.agent.active(r);
  if (!task.snapshot.intent || task.snapshot.intent==='question') throw new Error('仅明确修改或加入画板请求可取得修改能力');
  return task;
 }
 read(r:AgentIdentity) {
  const task=this.active(r),unit=this.unit(task.snapshot.target.unitId);
  if(!unit)throw new Error('固定修改目标已不可读');
  const ids:string[]=[]; const walk=(bs:ReadingBlock[])=>{for(const b of bs){ids.push(b.id);walk(b.children??[]);}};walk(unit.reading.blocks);
  const basis=this.groups.read({...r,unitId:unit.id,objectIds:ids,context:true});
  // Only directly affected formal edges enter the model context; the Core retains the full validation basis.
  const context=basis.context!;
  const narrowContext={layout:context.layout,experiments:context.experiments,relations:{graph:{edges:context.relations.graph.edges.filter(e=>[e.fromUnitId,e.toUnitId].includes(unit.id))},sources:context.relations.sources}};
  this.agent.mutationProgress(task.id,task.snapshot.target.blockId??unit.id,'read');
  const concurrentChanges = this.agent.reviewed(task.id,basis.basisId);
  const checks = this.groups.recheck(r.sessionId, task.attemptId);
  const pendingGroups = this.groups.candidates(task.attemptId).map(({command,result}) => ({candidateId:command.operationId,
    status: checks.find(c=>c.candidateId===command.operationId)?.status ?? 'needs-reread', reason:result.reason,
    proposal: { changes:command.changes, patch:command.patch, bundle:command.bundle }}));
  return {...basis,context:narrowContext,unitId:unit.id,submittedTarget:task.snapshot.target,content:unit,concurrentChanges,pendingGroups,
   capabilities:{updates:'root paragraph.text or formula.latex',structure:'root remove/move/copy/insert; opaque children preserved',layout:'target plus returned two neighbors',experiment:'independently verified six-bit 4:1 MUX; attached citation required; formulaBlockId writes the linked formula atomically from the same formula parameter'}};
 }
 private operation(taskId:string,operationId:string){if(!id(operationId))throw new Error('工具操作身份无效');return `agent:${taskId}:${hash(operationId).slice(0,24)}`;}
 query(r:AgentIdentity & {operationId:string}){const task=this.active(r);return this.groups.query(this.operation(task.id,r.operationId));}
 apply(r:AgentIdentity & {input:AgentMutation}) {
  const task=this.active(r),v=r.input;
  keys(v,['operationId','basisId','conclusionOrMethodChanged','updates','remove','moves','copies','insert','layout','relations','experiments','replaces']);
  if(v.replaces !== undefined && (!Array.isArray(v.replaces)||v.replaces.length>30||v.replaces.some(x=>!id(x))))throw new Error('待整合候选身份无效');
  if(!id(v.basisId)||typeof v.conclusionOrMethodChanged!=='boolean'||JSON.stringify(v).length>100_000)throw new Error('修改组参数无效');
  for(const k of ['updates','remove','moves','copies','insert','layout','experiments'] as const)if(v[k]!==undefined&&(!Array.isArray(v[k])||v[k]!.length>30))throw new Error('修改范围过大或无效');
  const operationId=this.operation(task.id,v.operationId),digest=hash(v),prior=this.db.prepare('SELECT digest FROM agent_mutation_requests WHERE operation_id=?').get(operationId);
  if(prior&&prior.digest!==digest)throw new Error('同一工具操作不能更换内容');
  if(!prior)this.db.prepare('INSERT INTO agent_mutation_requests VALUES(?,?)').run(operationId,digest);
  const existing=this.groups.query(operationId);if(existing){this.agent.group(existing);return existing;}
  const basis=this.groups.mutationBasis(task.attemptId,v.basisId);
  if(basis.unitId!==task.snapshot.target.unitId)throw new Error('修改依据不属于固定目标');
  const object=(blockId:string)=>{const o=basis.objects.find(o=>o.id===blockId&&o.kind==='block');if(!o||o.value.retired)throw new Error('对象不在已读取依据中');return o.value as ReadingBlock;};
  const original=basis.objects.find(o=>o.id===`structure:${basis.unitId}`)!.value.blockIds as string[];
  let order=[...original];const inserted:ReadingBlock[]=[],patch:ContentPatch={updates:[],correspondence:[]};
  for(const u of v.updates??[]){keys(u,['blockId','text','latex']);const b=object(u.blockId),field=b.kind==='paragraph'?'text':b.kind==='formula'?'latex':undefined;
   if(!field||typeof u[field]!=='string'||Object.keys(u).some(k=>!['blockId',field].includes(k))||!original.includes(b.id))throw new Error('只支持已读根段落文字或公式');
   patch.updates.push({blockId:b.id,before:b.payload,after:{...b.payload,[field]:u[field]}});
  }
  for(const blockId of v.remove??[]){const b=object(blockId);if(!original.includes(blockId)||!['paragraph','formula'].includes(b.kind)||(basis.objects.find(o=>o.id===`structure:${blockId}`)?.value.blockIds?.length??0)>0)throw new Error('仅可精简明确的正文段落／公式，不可删除实验或隐藏材料');order=order.filter(i=>i!==blockId);patch.correspondence.push({kind:'delete',sourceId:blockId,targetId:blockId});}
  const place=(blockId:string,beforeId?:string)=>{if(beforeId!==undefined&&!order.includes(beforeId))throw new Error('放置目标不在当前根结构');const at=beforeId===undefined?order.length:order.indexOf(beforeId);order.splice(at,0,blockId);};
  for(const m of v.moves??[]){keys(m,['blockId','beforeId']);object(m.blockId);if(!order.includes(m.blockId)||m.beforeId===m.blockId)throw new Error('移动必须保留原块身份');order=order.filter(i=>i!==m.blockId);place(m.blockId,m.beforeId);patch.correspondence.push({kind:'move',sourceId:m.blockId,targetId:m.blockId});}
  const materialize=(blockId:string):ReadingBlock=>{
    const block=structuredClone(object(blockId)), children=basis.objects.find(o=>o.id===`structure:${blockId}`)?.value.blockIds as string[] | undefined;
    if(children?.length)block.children=children.map(materialize);
    return block;
  };
  let counter=0;const fresh=()=>`RB-AG-${hash([operationId,counter++]).slice(0,28)}`;
  const clone=(b:ReadingBlock):ReadingBlock=>({...structuredClone(b),id:fresh(),...(b.children?{children:b.children.map(clone)}:{})});
  for(const c of v.copies??[]){keys(c,['blockId','beforeId']);if(!original.includes(c.blockId))throw new Error('复制对象必须是已读根块');const b=clone(materialize(c.blockId));inserted.push(b);place(b.id,c.beforeId);patch.correspondence.push({kind:'copy',sourceId:c.blockId,targetId:b.id});}
  for(const i of v.insert??[]){keys(i,['kind','text','latex','beforeId']);const field=i.kind==='paragraph'?'text':i.kind==='formula'?'latex':undefined;if(!field||typeof i[field]!=='string')throw new Error('只能加入段落或公式');const b={id:fresh(),kind:i.kind,payload:{[field]:i[field]}};inserted.push(b);place(b.id,i.beforeId);}
  if(JSON.stringify(order)!==JSON.stringify(original))patch.structure={parentId:basis.unitId,before:original,after:order,inserted};
  if(v.relations) {keys(v.relations,['changes']);if(!Array.isArray(v.relations.changes)||v.relations.changes.length>6)throw new Error('正式关系范围过大');for(const c of v.relations.changes){keys(c,['id','value','citationIds']);if(typeof c.value!=='string'||!c.value.trim()||!Array.isArray(c.citationIds)||!c.citationIds.length||c.citationIds.length>8)throw new Error('正式关系需要含义和本次固定来源引用');}}
  const changes=[];
  for(const e of v.experiments??[]){keys(e,['blockId','formula','formulaBlockId','sourceCitationId','config','inputNames']);keys(e.config,['dataSignals','selectBits']);const b=structuredClone(object(e.blockId));
   if(b.kind!=='interactive'||b.payload.component!=='mux'||!Array.isArray(e.config.dataSignals)||!Array.isArray(e.config.selectBits)||e.config.dataSignals.length!==4||e.config.selectBits.length!==2)throw new Error('仅支持有限4:1 MUX纠错');
   b.payload.config={...b.payload.config,...e.config};
   if(e.inputNames){if(e.inputNames.length>6||e.inputNames.some(n=>!/^I[0-3]$|^S[01]$/.test(n)))throw new Error('实验声明超出有限输入域');b.payload.inputs=Object.fromEntries(e.inputNames.map(n=>[n,b.payload.inputs[n]??0]));}
   if(e.formulaBlockId && !patch.updates.some(u=>u.blockId===e.formulaBlockId)) {
    const formula=object(e.formulaBlockId);
    if(formula.kind!=='formula'||formula.payload.experimentBlockId!==b.id)throw new Error('关联公式必须对应本次实验');
    patch.updates.push({blockId:formula.id,before:formula.payload,after:{...formula.payload,latex:e.formula}});
   }
   changes.push({objectId:b.id,value:b});
  }
  const relations=v.relations ? {changes:v.relations.changes.map(c=>{
    const old=this.relations.graph().edges.find(e=>e.id===c.id);
    if(!old||![old.fromUnitId,old.toUnitId].includes(basis.unitId))throw new Error('只能纠正本单元已读的直接正式关系');
    const sourceRefs=c.citationIds.map(id=>{
      const fixed=task.snapshot.citations.find(a=>a.citation.id===id)?.citation;
      if(!fixed||fixed.target?.unitId!==basis.unitId)throw new Error('正式关系来源必须来自本次固定请求');
      return {sourceId:fixed.sourceId,versionId:fixed.versionId,pdfPages:[fixed.pdfPageIndex+1],note:`固定来源引用 ${fixed.id}`};
    });
    return {id:c.id,value:{...old,value:c.value,sourceRefs}};
  })} : undefined;
  const result=this.groups.commit({...r,unitId:basis.unitId,operationId,basisId:v.basisId,changes,patch,resolves:v.replaces,
   semanticImpact:{version:1,unitId:basis.unitId,conclusionOrMethodChanged:v.conclusionOrMethodChanged},
   bundle:{layout:v.layout,relations,experiments:v.experiments?.map(({config:_,inputNames:__,...e})=>e)}});
  this.agent.group(result);return result;
 }
}
