import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { resizeBoardWindow,revealBoardControl } from './board-test-helpers';
import { muxCopy,muxId } from './agent-mutation-setup';
import type { Page } from '@playwright/test';
const real=process.env.YIZHI_REAL_EXECUTOR==='1';
const env=(root:string)=>{const e:Record<string,string>={...process.env,PATH:'/usr/bin:/bin',YIZHI_DATA_HOME:join(root,'profile')} as Record<string,string>;delete e.YIZHI_CODEX_PATH;return e;};
async function conversation(page:Page){return page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),l=await b.agent.list({sessionId:c.sessionId});return b.agent.get({sessionId:c.sessionId,conversationId:l.selectedId});});}
async function openAgent(page:Page){await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(page.getByText('本机 Codex CLI · 已连接',{exact:true})).toBeVisible();await page.getByLabel('问答模型').selectOption('gpt-6-luna');}
async function terminal(page:Page){await expect.poll(async()=>(await conversation(page)).tasks.at(-1)?.status,{timeout:120000}).not.toBe('running');return (await conversation(page)).tasks.at(-1);}
async function evidence(name:string,value:any){if(process.env.YIZHI_EVIDENCE_DIR)await writeFile(join(process.env.YIZHI_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2));}

test('installed CLI modifies one real B, removes an actual redundant paragraph, moves its original example, preserves note and hidden material, reopens at 1024x688',async()=>{
 test.skip(!real,'Opt-in installed CLI acceptance; controlled fixture is separate');test.setTimeout(180000);
 const root=await mkdtemp(join(tmpdir(),'yizhi-t17-actual-structure-')),core=new CourseService(resolve('dist/worker.cjs'));let app:any;const result:any={};
 try{
  const c=await core.open(join(root,'course')),paragraph=c.unit.reading.blocks.find(b=>b.kind==='paragraph')!,example=c.unit.reading.blocks.find(b=>b.kind==='example')!,duplicate={...structuredClone(paragraph),id:'t17-redundant-paragraph'};
  await core.commitEdit({sessionId:c.sessionId,operationId:'explicit-copy-duplicate',inputSeq:1,baseRevision:c.revision,changes:[],complete:true,patch:{updates:[],structure:{parentId:c.unit.id,before:c.unit.reading.blocks.map(b=>b.id),after:[paragraph.id,duplicate.id,...c.unit.reading.blocks.slice(1).map(b=>b.id)],inserted:[duplicate]},correspondence:[{kind:'copy',sourceId:paragraph.id,targetId:duplicate.id}]}});
  const note=await core.annotations.create({sessionId:c.sessionId,operationId:'personal-note',text:'精简后仍保留我的记录',selection:{unitId:c.unit.id,fragments:[{blockId:duplicate.id,block:duplicate,field:'text',formalRevision:c.revision+1,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:duplicate.payload.text},from:0,to:4,quote:Array.from(duplicate.payload.text).slice(0,4).join('')}]}});
  await core.setReviewStatus(c.sessionId,c.unit.id,'mastered');const baseline=await core.graph(c.sessionId);await core.close();
  const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:env(root)});app=await launch();let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();await openAgent(page);
  result.executor=await page.evaluate(()=>(window as any).yizhi.agent.status());result.runtime=(await page.evaluate(()=>(window as any).yizhi.open())).runtime;
  await page.getByLabel('Agent 请求方式').selectOption('modify');
  const wording='位置记数法用数码、基数和位权表示数值，各位数码乘位权后相加。';
  await page.getByRole('textbox',{name:'学习对话草稿'}).fill(`请直接完成一次局部整理并保存一个完整组：把原段落 ${paragraph.id} 的文字改为“${wording}”，这是纯措辞精简不改变方法；删除明确重复的 ${duplicate.id}；把原例题 ${example.id} 移到首段 ${paragraph.id} 之前，保持原ID及所有未展开材料。不要删除个人记录。使用最新edit context中的手动布局，将目标与返回的两个邻居的x各加24、y各加36，width不变。必须实际调用read edit context和apply group，不要只回答完成。`);
  await page.getByRole('button',{name:'发送修改请求',exact:true}).click();result.task=await terminal(page);result.view=await conversation(page);expect(result.task.status,JSON.stringify(result.view)).toBe('completed');
  const actual=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return {...c,notes:await b.annotations.list({sessionId:c.sessionId}),graph:await b.graph(c.sessionId),review:await b.reviewStates(c.sessionId)};});
  expect(actual.unit.reading.blocks[0]).toEqual(example);expect(actual.unit.reading.blocks.some((b:any)=>b.id===duplicate.id)).toBe(false);expect(actual.unit.reading.blocks.find((b:any)=>b.id===paragraph.id).payload.text).toBe(wording);
  expect(actual.unit.reading.blocks.filter((b:any)=>b.kind==='exercise')).toEqual(c.unit.reading.blocks.filter(b=>b.kind==='exercise'));
  expect(actual.notes).toHaveLength(1);expect(actual.notes[0].current.status).toBe('orphan');expect(actual.notes[0].original).toEqual(note.original);expect(actual.notes[0].text).toBe(note.text);expect(actual.review.prompts).toHaveLength(0);expect(actual.review.units['KU-001'].status).toBe('mastered');
  const changes=actual.graph.layout.nodes.filter((n:any)=>JSON.stringify(n)!==JSON.stringify(baseline.layout.nodes.find(x=>x.unitId===n.unitId)));expect(changes).toHaveLength(3);
  result.changedLayout=changes;result.saved=actual;expect(result.view.toolFacts.map((f:any)=>f.name)).toEqual(expect.arrayContaining(['yizhi_read_edit_context','yizhi_apply_group']));
  await page.getByRole('textbox',{name:'学习对话草稿'}).fill('整理后的真实草稿');await expect(page.getByRole('status',{name:'对话草稿保存'})).toHaveText('草稿已保存');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);await openAgent(page);
  await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('整理后的真实草稿');expect((await page.evaluate(()=>(window as any).yizhi.open())).unit).toEqual(actual.unit);expect((await conversation(page)).tasks[0].groups).toEqual(result.task.groups);
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,'t17-actual-structure-reopen.png')});result.passed=true;
 }catch(error){result.error=String(error);throw error;}finally{await evidence('t17-actual-structure',result);await app?.close();await core.close();await rm(root,{recursive:true,force:true});}
});

for(const incomplete of [false,true])test(`installed CLI corrects actual MUX copy with real source and necessary relation atomically, ${incomplete?'retains incompatible scene until restart':'migrates compatible scene after gesture'} and reopens`,async()=>{
 test.skip(!real,'Opt-in installed CLI acceptance; controlled fixture is separate');test.setTimeout(180000);
 const root=await mkdtemp(join(tmpdir(),'yizhi-t17-actual-mux-')),core=new CourseService(resolve('dist/worker.cjs'));let app:any;const result:any={incomplete};
 try{
  const source=process.env.YIZHI_T17_SOURCE;if(!source)throw new Error('Actual C05 source path required, never substitute generated evidence');
  const prepared=await muxCopy(core,join(root,'course'),incomplete,source),c=await core.read(prepared.sessionId),unit=await core.readUnit(prepared.sessionId,'KU-057');
  const sourcePage=await core.sources.page({sessionId:prepared.sessionId,versionId:prepared.citation.versionId,pdfPageIndex:12});
  const construction=await core.sources.cite({sessionId:prepared.sessionId,generation:1,operationId:'construction-citation',versionId:prepared.citation.versionId,pdfPageIndex:12,projectionId:sourcePage.projection.id,start:0,end:Array.from(sourcePage.projection.text).length,target:{unitId:'KU-057',blockId:muxId}});
  const conv=await core.agent.create({sessionId:prepared.sessionId,operationId:'actual-task-conversation'});
  const prompt=`这是明确有错的课程副本：KU-057 交互块 ${muxId} 把选择高低位交换了${incomplete?'，并漏了I3输入声明，错误常量0替代I3':''}；公式 mux-linked-formula 错成Z=0，正式关系REL-014的value也错误宣称S0为高位。请读取固定目标、edit context及两条真实课件引用（第11页真值表/公式，第13页三个2:1构造4:1）；按实际来源独立推导六输入4:1公式并穷举64组，然后一次必要一致组纠正：首段 ${unit.reading.blocks.find(b=>b.kind==='paragraph')!.id} 明确说明S1高位S0低位和索引2S1+S0；实验formula只用精确变量名I0/I1/I2/I3/S0/S1和¬、·、+的完整布尔等式；传formulaBlockId=mux-linked-formula由Core同组更新对应公式块，不在updates重复latex。interactive config的selectBits和dataSignals及必要声明一致；纠正直接受影响REL-014的value，保留端点、type/directed、其构造价值，sourceRefs引用这两条实际课件页及实际版本（不要改其他关系）。使用本次附带第11页citation作sourceCitationId。必要变化必须同一个apply_group，共同校验落盘，conclusionOrMethodChanged=true。当前实验旧现场不能伪装成新定义，迁移由产品处理。禁止只给解释、禁止改个人记录、不要改无关关系。`;
  await core.agent.saveDraft({sessionId:prepared.sessionId,conversationId:conv.id,seq:1,text:prompt,intent:'modify',target:{unitId:'KU-057'},citationIds:[prepared.citation.id,construction.id]});
  result.sources=[prepared.citation,construction];result.before={unit,view:prepared.view,graph:await core.graph(prepared.sessionId)};await core.close();
  const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:env(root)});app=await launch();let page:Page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'复用器与分配器',exact:true}).click();
  await page.getByRole('button',{name:'MUX 器件、级联与扩展',exact:true}).first().click();await openAgent(page);
  result.executor=await page.evaluate(()=>(window as any).yizhi.agent.status());result.runtime=(await page.evaluate(()=>(window as any).yizhi.open())).runtime;
  await expect(page.getByLabel('Agent 请求方式')).toHaveValue('modify');await expect(page.locator('.agent-attachment')).toHaveCount(2);
  await page.getByRole('button',{name:'发送修改请求',exact:true}).click();await page.getByRole('button',{name:'收起对话',exact:true}).click();
  const input=page.getByRole('checkbox',{name:'S0',exact:true});await revealBoardControl(page,input);const box=(await input.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),l=await b.agent.list({sessionId:c.sessionId}),task=(await b.agent.get({sessionId:c.sessionId,conversationId:l.selectedId})).tasks.at(-1),v=await b.experiments.read({sessionId:c.sessionId,instanceId:'KU-057/RB-TH-13-057-010-interactive'});return v.pendingDefinition?.revision===2 || task?.status!=='running';}),{timeout:120000}).toBe(true);
  let pending=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.experiments.read({sessionId:c.sessionId,instanceId:'KU-057/RB-TH-13-057-010-interactive'});});expect(pending.pendingDefinition?.revision,JSON.stringify(await conversation(page))).toBe(2);expect(pending.gesture).toBe(true);expect(pending.definition.revision).toBe(1);result.heldGesture=pending;
  await page.mouse.up();
  if(incomplete) await expect(page.getByRole('status',{name:'实验定义迁移'})).toContainText('不兼容');
  else await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.experiments.read({sessionId:c.sessionId,instanceId:'KU-057/RB-TH-13-057-010-interactive'})).definition.revision;})).toBe(2);
  await openAgent(page);result.task=await terminal(page);result.view=await conversation(page);expect(result.task.status,JSON.stringify(result.view)).toBe('completed');
  const groups=result.task.groups.filter((g:any)=>g.status==='committed'&&g.changedObjectIds.length);expect(groups).toHaveLength(1);const g=groups[0];expect(g.related.definitions[0].proof.assignments).toBe(64);expect(g.related.relation.domain).toBe('formal-relation');
  const saved=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return {unit:await b.readUnit(c.sessionId,'KU-057'),graph:await b.graph(c.sessionId),review:await b.reviewStates(c.sessionId),view:await b.experiments.read({sessionId:c.sessionId,instanceId:'KU-057/RB-TH-13-057-010-interactive'})};});result.saved=saved;
  expect(saved.review.units['KU-057'].status).toBe('mastered');expect(saved.review.prompts).toHaveLength(1);expect(saved.graph.edges.filter((e:any)=>e.id!=='REL-014')).toEqual(result.before.graph.edges.filter((e:any)=>e.id!=='REL-014'));
  const corrected=saved.unit.reading.blocks.find((b:any)=>b.id===muxId);expect(corrected.payload.config.selectBits).toEqual(['S1','S0']);expect(corrected.payload.config.dataSignals).toEqual(['I0','I1','I2','I3']);
  await page.getByRole('textbox',{name:'学习对话草稿'}).fill('真实纠错后接着复习');await expect(page.getByRole('status',{name:'对话草稿保存'})).toHaveText('草稿已保存');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);await openAgent(page);await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('真实纠错后接着复习');
  const reopened=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return {unit:await b.readUnit(c.sessionId,'KU-057'),view:await b.experiments.open({sessionId:c.sessionId,unitId:'KU-057',blockId:'RB-TH-13-057-010-interactive'})};});expect(reopened.unit).toEqual(saved.unit);expect(reopened.view.state).toEqual(saved.view.state);expect(reopened.view.definition.revision).toBe(incomplete?1:2);
  await page.getByRole('button',{name:'收起对话',exact:true}).click();
  if(incomplete){expect(reopened.view.pendingDefinition.revision).toBe(2);const restart=page.getByRole('button',{name:'按新定义重新开始',exact:true});await revealBoardControl(page,restart);await restart.click();}
  // Independently exercise the actual adopted evaluator for every row, oracle is direct channel indexing.
  result.rows=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),rows=[];let v=await b.experiments.read({sessionId:c.sessionId,instanceId:'KU-057/RB-TH-13-057-010-interactive'});for(let n=0;n<64;n++){const names=['I0','I1','I2','I3','S0','S1'],inputs=Object.fromEntries(names.map((name,i)=>[name,(n>>i)&1]));v=await b.experiments.act({sessionId:c.sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action:{kind:'inputs',inputs}});rows.push({inputs,output:v.result.output});}return rows;});
  for(const row of result.rows){const p=row.inputs;expect(row.output).toBe(p[['I0','I1','I2','I3'][2*p.S1+p.S0]]);}
  expect(result.view.toolFacts.map((f:any)=>f.name)).toEqual(expect.arrayContaining(['yizhi_read_target','yizhi_read_citation','yizhi_read_edit_context','yizhi_apply_group']));expect(result.view.toolFacts.every((f:any)=>!f.hasRecoveryPayload)).toBe(true);
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,`t17-actual-mux-${incomplete?'restart':'migrated'}.png`)});result.passed=true;
 }catch(error){result.error=String(error);if(app){const failedPage=await app.firstWindow();result.failureView=await conversation(failedPage).catch(()=>null);result.candidates=await failedPage.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.commands.candidates({sessionId:c.sessionId});}).catch(()=>null);}throw error;}finally{await evidence(`t17-actual-mux-${incomplete?'incompatible':'compatible'}`,result);await app?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
