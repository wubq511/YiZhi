import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CourseService } from '../src/core/course-service';
import { sourceFixture } from './source-fixture';
export const muxId = 'RB-TH-13-057-010-interactive';
export const correctFormula = 'Z=¬S1·¬S0·I0+¬S1·S0·I1+S1·¬S0·I2+S1·S0·I3';
export async function muxCopy(core: CourseService, root: string, incomplete = false, actualSource?: string) {
  const opened = await core.open(root), sessionId = opened.sessionId, unit = await core.readUnit(sessionId,'KU-057');
  // Construct an explicitly erroneous COPY as test data, before any task/runtime observes it.
  // Product producers must not be able to create this half-consistent state through public commands.
  const block=unit.reading.blocks.find(b=>b.id===muxId)!;
  block.payload.config.selectBits=['S0','S1']; block.payload.necessaryRelationIds=['REL-014'];
  if(incomplete){delete block.payload.inputs.I3;block.payload.config.dataSignals=['I0','I1','I2','0'];}
  unit.reading.blocks.unshift({id:'mux-linked-formula',kind:'formula',payload:{latex:'Z=0',experimentBlockId:muxId}});
  const seed=new DatabaseSync(join(root,'course.sqlite'));
  try{seed.prepare('INSERT INTO units VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(unit.id,JSON.stringify(unit));}finally{seed.close();}
  const rb = await core.relations.read({sessionId}); const edge=rb.graph.edges.find(e=>e.id==='REL-014')!;
  await core.relations.commit({sessionId,generation:rb.generation,basisId:rb.basisId,operationId:'explicit-bad-relation-copy',changes:[{id:edge.id,value:{...edge,value:'此副本错误地宣称S0为高位，交换01与10通道。'}}]});
  const path=actualSource ?? join(root,'source.pdf'); if(!actualSource) await sourceFixture(path,'MUX selector evidence: S1 is high, S0 is low. 00:I0 01:I1 10:I2 11:I3');
  const source=await core.sources.importFile({sessionId,generation:1,operationId:'source',path,title:actualSource ? '实际课程课件 C05 组合模块1' : 'Regression evidence, not actual-executor acceptance'});
  const page=await core.sources.page({sessionId,versionId:source.version.versionId,pdfPageIndex:actualSource ? 10 : 0});
  const citation=await core.sources.cite({sessionId,generation:1,operationId:'cite',versionId:source.version.versionId,pdfPageIndex:actualSource ? 10 : 0,projectionId:page.projection.id,start:0,end:Array.from(page.projection.text).length,target:{unitId:'KU-057',blockId:muxId}});
  await core.setReviewStatus(sessionId,'KU-057','mastered');
  const view=await core.experiments.open({sessionId,unitId:'KU-057',blockId:muxId});
  return {sessionId,citation,view};
}
export async function correction(core: CourseService, sessionId:string, citationId:string, operationId:string) {
  const unit=await core.readUnit(sessionId,'KU-057'), a=await core.commands.startAttempt({sessionId,taskId:operationId});
  const basis=await core.commands.read({sessionId,unitId:unit.id,attemptId:a.attemptId,objectIds:unit.reading.blocks.map(b=>b.id),context:true});
  const b=unit.reading.blocks.find(b=>b.id===muxId)!, next=structuredClone(b);
  next.payload.config.selectBits=['S1','S0']; next.payload.config.dataSignals=['I0','I1','I2','I3']; next.payload.inputs.I3=0;
  const edge=basis.context!.relations.graph.edges.find(e=>e.id==='REL-014')!;
  return { sessionId,unitId:unit.id,attemptId:a.attemptId,operationId,basisId:basis.basisId,changes:[{objectId:muxId,value:next}],
    patch:{updates:[{blockId:'mux-linked-formula',before:unit.reading.blocks[0].payload,after:{...unit.reading.blocks[0].payload,latex:correctFormula}}],correspondence:[]},
    semanticImpact:{version:1 as const,unitId:unit.id,conclusionOrMethodChanged:true},
    bundle:{layout:basis.context!.layout.map(n=>({unitId:n.unitId,x:n.x+20,y:n.y+40,width:n.width})),relations:{changes:[{id:edge.id,value:{...edge,value:'组内由低位S0选择，组间由高位S1选择，三个2:1构成4:1，通道按2S1+S0编号。'}}]},
      experiments:[{blockId:muxId,formula:correctFormula,formulaBlockId:'mux-linked-formula',sourceCitationId:citationId}]} };
}
