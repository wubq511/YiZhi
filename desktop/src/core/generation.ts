import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentIdentity } from '../agent-mutation-api';
import type { AgentTask } from '../agent-api';
import type { ParsedPage } from '../parsing-api';
import type { GenerationCandidateView, GenerationCheck, GenerationContext, GenerationRequest, GenerationResult, GenerationSpec, LessonProposal, FiniteExample } from '../generation-api';
import type { CourseGraph, CourseUnit, ReadingBlock } from '../shared';
import type { Sources } from './sources';
import type { Parsing } from './parsing';
import type { AgentStore } from './agent-store';
import type { CommandGroups } from './command-groups';
import type { Search } from './search';
import { assignments, formulaOutputs } from './builtin-model';
import { readDrafts, transaction, appendEvent } from './save-store';
import { selectorEvidence, exampleEvidence } from './generation-evidence';

const json=(v:unknown)=>JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(json(v)).digest('hex');
const valid=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
const prose=(v:unknown,min=1,max=10000):v is string=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
const parse=(v:unknown)=>JSON.parse(String(v));
const stages=['lesson','practice'] as const;
const roles=['intro','formula','derivation','table','example','example-answer','exercise','exercise-answer','practice','practice-answer'] as const;
const blockId=(unitId:string,role:string)=>`RB-GEN-${hash([unitId,role]).slice(0,28)}`;
const readingObjects=(blocks:ReadingBlock[],parentId:string):Map<string,unknown>=>{
  const objects=new Map<string,unknown>([[`structure:${parentId}`,{blockIds:blocks.map(b=>b.id)}]]);
  for(const block of blocks){
    const {children,...self}=block;
    objects.set(block.id,self);
    for(const [id,value] of readingObjects(children??[],block.id))objects.set(id,value);
  }
  return objects;
};
const unitHeader=(unit:CourseUnit|undefined)=>{
  if(!unit)return null;
  const {reading,...header}=unit;
  return header;
};

/** Product Core owner of a single bounded source-backed MUX generation path. */
export class Generation {
  constructor(private db:DatabaseSync,private graph:CourseGraph,private sources:Sources,private parsing:Parsing,
    private agent:AgentStore,private groups:CommandGroups,private search:Search) {
    db.exec(`CREATE TABLE IF NOT EXISTS generation_bases(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL REFERENCES cg_attempts(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generation_candidates(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL REFERENCES cg_attempts(id),digest TEXT NOT NULL,
        proposal TEXT NOT NULL,result TEXT NOT NULL,checks TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generation_groups(root_task_id TEXT NOT NULL,stage TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
        receipt TEXT NOT NULL,PRIMARY KEY(root_task_id,stage));`);
    agent.attachGeneration(task=>this.state(task));
  }
  private root(task:AgentTask) {
    let current=task;
    for(let i=0;current.continuesTaskId&&i<20;i++){
      const row=this.db.prepare('SELECT payload FROM agent_tasks WHERE id=?').get(current.continuesTaskId);
      if(!row)throw new Error('原生成任务链不可核对');current=parse(row.payload);
    }
    return current.id;
  }
  private spec(task:AgentTask):GenerationSpec {
    if(task.snapshot.intent!=='generate'||!task.snapshot.generationSpec)throw new Error('仅明确新增小主题任务可使用生成工具');
    return task.snapshot.generationSpec;
  }
  private active(r:AgentIdentity) {const task=this.agent.active(r);this.spec(task);return task;}
  private completed(root:string) {
    return this.db.prepare('SELECT stage,operation_id,receipt FROM generation_groups WHERE root_task_id=? ORDER BY rowid').all(root)
      .map(row=>({stage:String(row.stage) as 'lesson'|'practice',operationId:String(row.operation_id),receipt:parse(row.receipt) as GenerationResult}));
  }
  private pending(root:string) {const done=new Set(this.completed(root).map(r=>r.stage));return stages.filter(s=>!done.has(s));}
  state(task:AgentTask) {
    const root=this.root(task),pending=this.pending(root),retained=this.db.prepare("SELECT id,result,proposal FROM generation_candidates WHERE attempt_id=? AND json_extract(result,'$.status')='retained' ORDER BY rowid").all(task.attemptId)
      .filter(row=>pending.includes(parse(row.proposal).stage))
      .map(row=>({candidateId:String(row.id),reason:String(parse(row.result).reason)}));
    return {pending,retained,completed:this.completed(root).map(r=>r.stage)};
  }
  candidates(taskId:string):GenerationCandidateView[] {
    const row=this.db.prepare('SELECT payload FROM agent_tasks WHERE id=?').get(taskId);
    if(!row)throw new Error('生成任务不存在');
    const task=parse(row.payload) as AgentTask;this.spec(task);const root=this.root(task),pending=this.pending(root);
    return this.db.prepare(`SELECT * FROM generation_candidates
      WHERE json_extract(result,'$.status')='retained' ORDER BY rowid`).all()
      .filter(r=>{
        if(!pending.includes(parse(r.proposal).stage))return false;
        const t=this.db.prepare('SELECT payload FROM agent_tasks WHERE attempt_id=?').get(r.attempt_id);
        return t&&this.root(parse(t.payload))===root;
      }).map(r=>({operationId:String(r.id),attemptId:String(r.attempt_id),stage:parse(r.proposal).stage,
        reason:parse(r.result).reason,proposal:parse(r.proposal),checks:parse(r.checks)}));
  }
  private targetDrafts(unitId:string) {return readDrafts(this.db).filter(d=>(d.input.unitId??'KU-001')===unitId);}
  private current(spec:GenerationSpec) {
    const version=this.sources.version(spec.sourceVersionId);
    const refs=this.parsing.artifacts(version.versionId).filter(r=>r.pdfPageIndex===spec.pdfPageIndex);
    const ref=refs.find(r=>r.artifactId===spec.artifactId);
    if(!ref||refs.at(-1)?.artifactId!==ref.artifactId)throw new Error('所选解析产物不是当前该页最新已确认版本，请重新指定来源');
    const page=this.parsing.artifact(ref.artifactId);
    if(page.source.versionId!==version.versionId||page.source.sha256!==version.sha256||page.pdfPageIndex!==spec.pdfPageIndex||ref.digest!==ref.resource.sha256)
      throw new Error('解析产物与固定原件版本不一致');
    const table=selectorEvidence(page);
    return {version,ref,page,table};
  }
  private sourceChanged(version:{sourceId:string;versionId:string;sha256:string}) {
    const latest=this.db.prepare('SELECT payload FROM source_versions WHERE source_id=? ORDER BY rowid DESC LIMIT 1').get(version.sourceId);
    return latest&&parse(latest.payload).sha256!==version.sha256;
  }
  read(r:AgentIdentity):GenerationContext {
    const task=this.active(r),spec=this.spec(task),root=this.root(task),{version,ref,page,table}=this.current(spec);
    if(this.sourceChanged(version))throw new Error('来源已有内容不同的新版本；请从该版本重新解析并明确新请求，旧正式内容与引用保留');
    const unitRow=this.db.prepare('SELECT payload,revision FROM units WHERE id=?').get(spec.unitId);
    const targetRev=unitRow?Number(unitRow.revision):null;
    const draftHash=hash(this.targetDrafts(spec.unitId));
    const readset=[
      {kind:'source-version',id:version.versionId,version:version.sha256,purpose:'printed table provenance'},
      {kind:'parsed-page',id:ref.artifactId,version:ref.digest,purpose:'coordinate table rows and original raster'},
      {kind:'unit',id:spec.unitId,version:targetRev,purpose:'formal target and stable identities'},
      {kind:'student-draft',id:spec.unitId,version:draftHash,purpose:'latest unconfirmed student input'},
      {kind:'graph-target',id:spec.themeId,version:hash(this.graph.nodes.filter(n=>n.id===spec.unitId)),purpose:'structure ownership'},
    ];
    const basisId=`generation:${hash([task.attemptId,Date.now(),Math.random()]).slice(0,32)}`;
    const basis={generation:task.generation,spec,root,targetRev,draftHash,structureHash:unitRow?hash(parse(unitRow.payload).reading.blocks.map((b:ReadingBlock)=>b.id)):null,
      sourceSha:version.sha256,artifactDigest:ref.digest,readset};
    this.db.prepare('INSERT INTO generation_bases VALUES(?,?,?)').run(basisId,task.attemptId,json(basis));
    this.agent.mutationProgress(task.id,spec.unitId,'read');
    return {basisId,spec,source:{sourceId:version.sourceId,versionId:version.versionId,sha256:version.sha256},
      artifact:{artifactId:ref.artifactId,digest:ref.digest,pdfPageIndex:ref.pdfPageIndex,coordinateSpace:page.coordinateSpace,
        structureRole:page.structure?.role??null,view:page.view},target:{formalRevision:targetRev,studentDraftVersion:this.targetDrafts(spec.unitId).length,generation:task.generation},
      sourceText:page.text.map(t=>({id:t.id,text:t.text,bounds:t.bounds})),sourceTable:table.table,evidenceIds:table.evidenceIds,
      completedStages:this.completed(root),pendingStages:this.pending(root),retained:this.candidates(task.id).map(({operationId,stage,reason,proposal,checks})=>({operationId,stage,reason,proposal,checks}))};
  }
  private validate(input:LessonProposal,spec:GenerationSpec,table:ReturnType<typeof selectorEvidence>,basis:any,unit:CourseUnit|undefined):GenerationCheck[] {
    const checks:GenerationCheck[]=[];
    const check=(layer:GenerationCheck['layer'],run:()=>string)=>{
      try{checks.push({layer,status:'passed',detail:run()});}catch(error){checks.push({layer,status:'failed',detail:(error as Error).message});}
    };
    check('structure',()=>{
      if(!['lesson','practice'].includes(input.stage)||!input.evidence||!valid(input.operationId)||!valid(input.basisId))throw new Error('候选结构或阶段无效');
      if(input.stage==='lesson'){
        if(!prose(input.title,4,120)||!prose(input.outcome,12,300))throw new Error('小主题标题或学习目标缺失');
        if(!prose(input.intro,90)||!prose(input.derivation,65)||!prose(input.formula,12,2000))throw new Error('说明、推导或公式不足以独立学习');
        this.completeExample(input.example,'例题');this.completeExample(input.exercise,'练习',true);
      } else this.completeExample(input.exercise,'追加练习',true);
      return '已检查完整学习材料与有限阶段结构';
    });
    check('identity',()=>{
      if(!/^KU-[A-Za-z0-9-]+$/.test(spec.unitId)||!/^TH-[A-Za-z0-9-]+$/.test(spec.themeId)||
        spec.unitId==='KU-001'||new Set(roles.map(role=>blockId(spec.unitId,role))).size!==roles.length)throw new Error('新增目标身份无效');
      if(unit&&(unit.generationOrigin as {sourceId?:string}|undefined)?.sourceId!==this.sources.version(spec.sourceVersionId).sourceId)throw new Error('已有单元身份属于其他语义，不能静默改写');
      if(!unit&&this.graph.nodes.some(n=>n.id===spec.unitId))throw new Error('图中已有同名正式身份，拒绝覆盖');
      if(this.graph.groups.some(g=>g.id===spec.themeId&&g.name!==spec.themeName))throw new Error('主题身份与已有名称冲突');
      return '固定单元与主题身份，无既有语义覆盖';
    });
    check('reference',()=>{
      const actual=new Set([...Object.values(table.evidenceIds).flat(),
        ...table.table.flatMap(row=>row.evidenceIds),...table.disabledEvidenceIds]);
      const claims=input.stage==='lesson'?(['enable','selection','formula','example','exercise'] as const):(['exercise'] as const);
      for(const kind of claims){
        const ids=input.evidence[kind];if(!Array.isArray(ids)||!ids.length||ids.some(id=>!actual.has(id)))throw new Error(`${kind} 缺少该来源页的具体文本项依据`);
      }
      if(input.stage==='lesson'){
        const required={enable:table.evidenceIds.enable,selection:table.evidenceIds.selection,formula:table.evidenceIds.formula};
        for(const kind of Object.keys(required) as Array<keyof typeof required>)if(required[kind].some(id=>!input.evidence[kind].includes(id)))
          throw new Error(`${kind} 依据未覆盖必要表头／行值`);
      }
      return '来源版本、原页坐标及逐论断文本项均可回查；原生表格标签未假设存在';
    });
    check('version',()=>{
      if(basis.generation!==Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()?.value)||
        basis.sourceSha!==this.sources.version(spec.sourceVersionId).sha256||basis.artifactDigest!==this.current(spec).ref.digest)throw new Error('来源、解析产物或课程代际已变化');
      if(this.sourceChanged(this.sources.version(spec.sourceVersionId)))throw new Error('来源已有内容不同的新版本；本阶段依赖该表，须按新版重新解析和校验，旧正式内容与引用保留');
      const row=this.db.prepare('SELECT payload,revision FROM units WHERE id=?').get(spec.unitId);
      if(input.stage==='lesson'&&basis.targetRev!==(row?Number(row.revision):null))throw new Error('目标正式修订已变化，请重读并局部整合');
      if(input.stage==='practice'&&basis.structureHash!==(row?hash(parse(row.payload).reading.blocks.map((b:ReadingBlock)=>b.id)):null))throw new Error('目标结构已变化，追加材料需重读');
      if(basis.draftHash!==hash(this.targetDrafts(spec.unitId))||this.targetDrafts(spec.unitId).length)throw new Error('学生最新草稿尚待整合，不能覆盖或越过');
      return '同一代际、不可变原件/产物、实际目标与学生编辑基线';
    });
    check('course',()=>{
      if(input.stage==='practice'&&!unit)throw new Error('完整小主题尚未正式发布，不能独立追加练习');
      if(input.stage==='lesson'&&unit&&unit.theme.id!==spec.themeId)throw new Error('已有单元主题归属不一致');
      if(unit?.reading.blocks.some(b=>roles.some(role=>blockId(spec.unitId,role)===b.id)&&!(b.sourceRefs as Array<{sourceId:string}>|undefined)?.some(r=>r.sourceId===this.sources.version(spec.sourceVersionId).sourceId)))
        throw new Error('生成身份被非本来源内容占用');
      return '保留其他图节点、主题、个人内容与既有身份';
    });
    check('source-meaning',()=>{
      if(input.stage==='lesson'){
        const intro=input.intro!,derive=input.derivation!;
        const pair=(a:string,b:string)=>new RegExp(`(?:${a}\\s*(?:=|→|对应|记作|映射为)\\s*${b}|${b}\\s*(?:=|→|对应|记作|映射为)\\s*${a})`).test(intro);
        const orderedData=/C0.{0,8}C1.{0,8}C2.{0,8}C3.{0,24}分别.{0,24}I0.{0,8}I1.{0,8}I2.{0,8}I3/.test(intro);
        if(!/G.{0,12}(?:=.?0|低|有效电平为.?0)/i.test(intro)||!/低有效|有效电平为.?0/.test(intro))
          throw new Error('说明必须写明 Gbar=0 的低有效使能范围');
        if(!pair('B','S1')||!pair('A','S0')||!pair('Y','Z'))
          throw new Error('说明必须显式写出 B=S1、A=S0、Y=Z 的符号对应');
        if(!(orderedData||[0,1,2,3].every(i=>pair(`C${i}`,`I${i}`))))
          throw new Error('说明必须显式写出 C0..C3 分别对应 I0..I3');
        for(const [select,index] of [['00',0],['01',1],['10',2],['11',3]] as const)
          if(!new RegExp(`${select}[^。；\\n]{0,50}(?:C${index}|I${index})`).test(derive))throw new Error(`${select} 的推导没有对应来源通道`);
        if(/MHz|ns\b|电压|电流|第二通道|真实芯片|封装引脚/.test(intro+derive))throw new Error('候选含超出该表证据的器件或时序断言');
      }
      return '逐项比对低有效、B/A选择和C0..C3输出行；未从读过来源推定其他物理结论';
    });
    check('finite',()=>{
      const evidence=(ex:FiniteExample|undefined,kind:'example'|'exercise')=>{
        const selected=exampleEvidence(ex!,table);
        if(!input.evidence[kind].includes(selected))throw new Error(`${kind} 未指向其实际选通行`);
        if(!ex!.answer.includes(`Z=${ex!.output}`))throw new Error(`${kind} 答案文本没有明确给出独立核对的输出`);
      };
      if(input.stage==='lesson'){
        const names=['I0','I1','I2','I3','S0','S1'];const rows=assignments(names);
        const actual=formulaOutputs(input.formula!,names);
        if(!/^\s*Z\s*=/.test(input.formula!)||actual.length!==64||rows.some((bits,i)=>actual[i]!==table.expected[`${bits.S1}${bits.S0}${bits.I0}${bits.I1}${bits.I2}${bits.I3}`]))
          throw new Error('公式与来源表展开的独立64组穷举不一致');
        evidence(input.example,'example');
      }
      evidence(input.exercise,'exercise');
      return input.stage==='lesson'?'来源L/H/X行独立展开64组，公式全域一致，例练按对应行核对':'追加练习按来源行核对';
    });
    checks.push({layer:'experiment',status:'not-applicable',detail:'本次发布内置真值表阅读材料，没有新增可执行实验定义'});
    return checks;
  }
  private completeExample(ex:FiniteExample|undefined,label:string,hint=false) {
    if(!ex||!prose(ex.problem,12,1000)||!prose(ex.answer,8,1500))
      throw new Error(`${label}必须有完整题目，answer 至少八字并解释 Z 值依据；不能只写 Z=0/1`);
    if(hint&&!prose(ex.hint,5,1000)||!hint&&!prose(ex.steps,15,2000))
      throw new Error(`${label}缺少提示或逐步解答`);
    if(!ex.inputs||typeof ex.inputs!=='object'||![0,1].includes(ex.output))
      throw new Error(`${label}缺少完整输入或输出`);
    return true;
  }
  private sourceRef(spec:GenerationSpec,sourceId:string,digest:string,note:string,page:ParsedPage,evidenceTextIds:string[]) {
    const items=page.text.filter(t=>evidenceTextIds.includes(t.id));
    if(!items.length)throw new Error('正式材料没有可定位的来源文字项');
    const region={x0:Math.min(...items.map(t=>t.bounds[0])),y0:Math.min(...items.map(t=>t.bounds[1])),
      x1:Math.max(...items.map(t=>t.bounds[2])),y1:Math.max(...items.map(t=>t.bounds[3]))};
    return {sourceId,versionId:spec.sourceVersionId,pdfPages:[spec.pdfPageIndex+1],pdfPageIndex:spec.pdfPageIndex,
      artifactId:spec.artifactId,artifactDigest:digest,coordinateSpace:'pdf-user-space',region,
      evidenceTextIds:[...new Set(evidenceTextIds)],textStatus:'page-or-region',note};
  }
  private material(spec:GenerationSpec,input:LessonProposal,sourceId:string,digest:string,page:ParsedPage):ReadingBlock[] {
    const claims=input.evidence;
    const ids=(...kinds:Array<keyof typeof claims>)=>[...new Set(kinds.flatMap(kind=>claims[kind]))];
    const ref=(note:string,textIds:string[])=>[this.sourceRef(spec,sourceId,digest,note,page,textIds)];
    const b=(role:string,kind:string,payload:Record<string,unknown>,note:string,textIds:string[],children?:ReadingBlock[]):ReadingBlock=>({id:blockId(spec.unitId,role),kind,role:role==='practice'?'material':'core',payload,sourceRefs:ref(note,textIds),...(children?{children}:{})});
    const answer=(role:string,text:string,textIds:string[])=>b(role,'paragraph',{text},'对应输入和输出行的完整解答',textIds);
    if(input.stage==='practice')return [b('practice','exercise',{title:'进阶练习 · 读表求输出',problem:input.exercise!.problem,hint:input.exercise!.hint,answerNature:'self-test'},
      '新增练习，按实际选择行验证',ids('exercise'),[answer('practice-answer',input.exercise!.answer,ids('exercise'))])];
    return [
      b('intro','paragraph',{text:input.intro!},'低有效使能与各信号映射',ids('enable','selection')),
      b('formula','formula',{latex:input.formula!},'四选一逻辑式与四种选择码',ids('formula','selection')),
      b('derivation','paragraph',{text:input.derivation!},'从四通道L/H/X行推导公式',ids('formula','selection')),
      b('table','table',{columns:['B=S1','A=S0','Gbar','被选中输入','Y=Z'],rows:[['0','0','0','C0=I0','I0'],['0','1','0','C1=I1','I1'],['1','0','0','C2=I2','I2'],['1','1','0','C3=I3','I3']]},'来源四通道选择行',ids('selection','formula')),
      b('example','example',{title:'例题 · 从选择码读输出',problem:input.example!.problem,hint:'先确定 S1S0，再读取对应 I。',answerNature:'authored-example'},'由来源行验证的已解例题',ids('example'),[answer('example-answer',`${input.example!.steps}\n${input.example!.answer}`,ids('example'))]),
      b('exercise','exercise',{title:'练习 · 单通道四选一',problem:input.exercise!.problem,hint:input.exercise!.hint,answerNature:'self-test'},'由来源行验证的自测练习',ids('exercise'),[answer('exercise-answer',input.exercise!.answer,ids('exercise'))]),
    ];
  }
  private nextGraph(spec:GenerationSpec,title:string,unit:CourseUnit):CourseGraph {
    const next=structuredClone(this.graph);
    const node=next.nodes.find(n=>n.id===unit.id);
    if(node){node.name=title;node.themeId=spec.themeId;node.themeName=spec.themeName;}
    else next.nodes.push({id:unit.id,name:title,kind:'method',themeId:spec.themeId,themeName:spec.themeName,stars:1});
    const group=next.groups.find(g=>g.id===spec.themeId);
    if(!group)next.groups.push({id:spec.themeId,name:spec.themeName,coreOutcome:unit.outcome,
      rating:{stars:1,rationale:'单一新增来源的学习主题，未据此推断考试重要性'}} as CourseGraph['groups'][number]);
    else if(!next.nodes.some(n=>n.themeId===spec.themeId && n.id!==unit.id))
      (group as typeof group & {coreOutcome?:string}).coreOutcome=unit.outcome;
    if(!next.layout.nodes.some(n=>n.unitId===unit.id)) {
      const bottom=Math.max(0,...next.layout.nodes.map(n=>n.y+n.height));
      const layoutNode={elementId:`VE-N-${unit.id}`,unitId:unit.id,x:104,y:bottom+180,width:300,height:86};
      next.layout.nodes.push(layoutNode);
      if(!next.layout.groups.some(g=>g.themeId===spec.themeId))next.layout.groups.push({elementId:`VE-G-${spec.themeId}`,themeId:spec.themeId,title:spec.themeName,x:64,y:layoutNode.y-90,width:750,height:270});
    }
    return next;
  }
  publish(r:GenerationRequest):GenerationResult {
    const task=this.active(r),spec=this.spec(task),input=r.input,root=this.root(task);
    if(!input||!valid(input.operationId)||!valid(input.basisId)||!stages.includes(input.stage))throw new Error('生成候选身份或阶段无效');
    const operationId=`generation:${task.id}:${hash(input.operationId).slice(0,24)}`;
    const digest=hash(input),prior=this.db.prepare('SELECT * FROM generation_candidates WHERE id=?').get(operationId);
    if(prior){if(prior.digest!==digest)throw new Error('同一生成操作不能更换内容');return parse(prior.result);}
    const done=this.completed(root).find(s=>s.stage===input.stage);
    if(done)return done.receipt;
    const basisRow=this.db.prepare('SELECT * FROM generation_bases WHERE id=?').get(input.basisId);
    if(!basisRow||basisRow.attempt_id!==task.attemptId)throw new Error('候选未使用本尝试的实际读取依据');
    const basis=parse(basisRow.payload),unitRow=this.db.prepare('SELECT payload FROM units WHERE id=?').get(spec.unitId);
    const before=unitRow?parse(unitRow.payload) as CourseUnit:undefined;
    let current:ReturnType<Generation['current']>|undefined,sourceFailure:string|undefined;
    try{current=this.current(spec);}catch(error){sourceFailure=(error as Error).message;}
    const checks=current?this.validate(input,spec,current.table,basis,before):[{layer:'version' as const,status:'failed' as const,detail:sourceFailure!}];
    const initial:GenerationResult={operationId,attemptId:task.attemptId,stage:input.stage,status:'retained',changedObjectIds:[],
      checks,reason:checks.find(c=>c.status==='failed')?.detail??'候选等待正式提交'};
    transaction(this.db,()=>this.db.prepare('INSERT INTO generation_candidates VALUES(?,?,?,?,?,?)').run(operationId,task.attemptId,digest,json(input),json(initial),json(checks)));
    if(checks.some(c=>c.status==='failed')){this.agent.group(initial);return initial;}
    const ready=current!;
    let result=initial,nextGraph:CourseGraph|undefined;
    try {
      result=transaction(this.db,()=>{
        this.agent.active(r);
        const latest=this.db.prepare('SELECT * FROM generation_bases WHERE id=?').get(input.basisId);
        if(!latest||latest.attempt_id!==task.attemptId)throw new Error('生成依据已释放');
        const checked=this.validate(input,spec,this.current(spec).table,parse(latest.payload),this.db.prepare('SELECT payload FROM units WHERE id=?').get(spec.unitId)?.payload ?
          parse(this.db.prepare('SELECT payload FROM units WHERE id=?').get(spec.unitId)!.payload):undefined);
        if(checked.some(c=>c.status==='failed'))throw new Error(checked.find(c=>c.status==='failed')!.detail);
        if(this.completed(root).some(s=>s.stage===input.stage))throw new Error('该阶段已被其他提交确认');
        const oldRow=this.db.prepare('SELECT payload,revision FROM units WHERE id=?').get(spec.unitId);
        const old=oldRow?parse(oldRow.payload) as CourseUnit:undefined;
        const added=this.material(spec,input,ready.version.sourceId,ready.ref.digest,ready.page);
        const unit:CourseUnit=input.stage==='lesson'?({
          ...(old??{}),id:spec.unitId,name:input.title!,outcome:input.outcome!,kind:'method',
          theme:{id:spec.themeId,name:spec.themeName},rating:old?.rating??{stars:1,rationale:'新增来源仅作为本主题学习依据，未推断课程重要性'},
          generationOrigin:{sourceId:ready.version.sourceId,sourceVersionId:spec.sourceVersionId,artifactId:spec.artifactId},
          reading:{...(old?.reading??{}),schemaVersion:'1',blocks:old?[...old.reading.blocks.filter(b=>!added.some(n=>n.id===b.id)),...added]:added},
        } as CourseUnit): {...old!,reading:{...old!.reading,blocks:[...old!.reading.blocks.filter(b=>b.id!==added[0].id),...added]}};
        const revision=Number(oldRow?.revision??0)+1;
        const beforeObjects=old?readingObjects(old.reading.blocks,spec.unitId):new Map<string,unknown>();
        const afterObjects=readingObjects(unit.reading.blocks,spec.unitId);
        const objectIds=[...new Set([...beforeObjects.keys(),...afterObjects.keys()])];
        const beforeVersions=new Map(objectIds.map(id=>[id,Number(this.db.prepare('SELECT version FROM cg_objects WHERE id=?').get(id)?.version??0)]));
        const beforeGraph=structuredClone(this.graph);
        this.db.prepare('INSERT INTO units(id,payload,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision').run(spec.unitId,json(unit),revision);
        nextGraph=this.nextGraph(spec,unit.name,unit);
        if(json(nextGraph)!==json(beforeGraph))this.db.prepare("INSERT INTO metadata VALUES('course-graph',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(nextGraph));
        const invalidated=this.groups.observe();
        const objectChanges=objectIds.flatMap(id=>{
          const before=beforeObjects.get(id)??null,after=afterObjects.get(id)??null;
          return json(before)===json(after)?[]:[{objectId:id,before,after,beforeVersion:beforeVersions.get(id)??0,
            afterVersion:Number(this.db.prepare('SELECT version FROM cg_objects WHERE id=?').get(id)?.version??0)}];
        });
        const graphChanges=([
          [`graph:${spec.unitId}`,beforeGraph.nodes.find(n=>n.id===spec.unitId),nextGraph.nodes.find(n=>n.id===spec.unitId)],
          [`theme:${spec.themeId}`,beforeGraph.groups.find(g=>g.id===spec.themeId),nextGraph.groups.find(g=>g.id===spec.themeId)],
          [`layout:${spec.unitId}`,beforeGraph.layout.nodes.find(n=>n.unitId===spec.unitId),nextGraph.layout.nodes.find(n=>n.unitId===spec.unitId)],
          [`layout-theme:${spec.themeId}`,beforeGraph.layout.groups.find(g=>g.themeId===spec.themeId),nextGraph.layout.groups.find(g=>g.themeId===spec.themeId)],
        ] as const).flatMap(([objectId,prior,after])=>json(prior??null)===json(after??null)?[]:[{objectId,before:prior??null,after:after??null,
          beforeVersion:prior?revision-1:0,afterVersion:revision}]);
        const unitChanges=json(unitHeader(old))===json(unitHeader(unit))?[]:
          [{objectId:`unit:${spec.unitId}`,before:old??null,after:unit,beforeVersion:Number(oldRow?.revision??0),afterVersion:revision}];
        const changes=[...unitChanges,...objectChanges,...invalidated,...graphChanges];
        const receipt:GenerationResult={operationId,attemptId:task.attemptId,unitId:spec.unitId,stage:input.stage,status:'committed',revision,
          changedObjectIds:changes.map(c=>c.objectId),checks:checked,cursor:0};
        receipt.cursor=appendEvent(this.db,{type:'group.committed',operationId,revision,changedObjectIds:receipt.changedObjectIds});
        this.db.prepare('UPDATE generation_candidates SET result=?,checks=? WHERE id=?').run(json(receipt),json(checked),operationId);
        this.db.prepare('INSERT INTO generation_groups VALUES(?,?,?,?)').run(root,input.stage,operationId,json(receipt));
        // Once a stage is formally published, earlier failed proposals for that stage
        // are no longer a recovery draft. Keep their identities and result facts for
        // idempotent queries, but release duplicate full candidate bodies.
        for(const row of this.db.prepare("SELECT id,attempt_id,proposal FROM generation_candidates WHERE json_extract(result,'$.status')='retained'").all()){
          const previousTask=this.db.prepare('SELECT payload FROM agent_tasks WHERE attempt_id=?').get(row.attempt_id);
          if(previousTask&&this.root(parse(previousTask.payload))===root&&parse(row.proposal).stage===input.stage)
            this.db.prepare('UPDATE generation_candidates SET proposal=?,checks=? WHERE id=?').run(json({stage:input.stage}),json([]),row.id);
        }
        this.db.prepare('INSERT INTO cg_candidates VALUES(?,?,?,?)').run(operationId,digest,json({domain:'generation',attemptId:task.attemptId,operationId}),json(receipt));
        this.db.prepare('INSERT INTO cg_history VALUES(?,?)').run(operationId,json({operationId,taskId:task.id,attemptId:task.attemptId,actor:'agent',domain:'generation',
          unitIds:[spec.unitId],explanation:input.stage==='lesson'?'从新增来源发布小主题':'为已发布小主题追加练习',
          generation:task.generation,revision,committedAt:new Date().toISOString(),changes}));
        this.agent.group(receipt);
        return receipt;
      });
    }catch(error){
      result={...initial,reason:(error as Error).message,checks:[...checks,{layer:'course',status:'failed',detail:(error as Error).message}]};
      this.db.prepare('UPDATE generation_candidates SET result=?,checks=? WHERE id=?').run(json(result),json(result.checks),operationId);
      this.agent.group(result);
      return result;
    }
    if(nextGraph){Object.assign(this.graph,nextGraph);this.search.includeImportedUnits([spec.unitId],this.graph.nodes.length);}
    return result;
  }
  query(r:AgentIdentity & {operationId:string}) {
    const task=this.agent.facts(r),operationId=`generation:${task.id}:${hash(r.operationId).slice(0,24)}`;
    const row=this.db.prepare('SELECT result FROM generation_candidates WHERE id=?').get(operationId);
    return row?parse(row.result) as GenerationResult:null;
  }
}
