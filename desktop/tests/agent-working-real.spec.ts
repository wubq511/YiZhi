import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';
async function view(page: Page) { return page.evaluate(async () => { const b = window.yizhi, c = await b.open(), l = await b.agent.list({sessionId:c.sessionId}); return b.agent.get({sessionId:c.sessionId,conversationId:l.selectedId!}); }); }

test('installed CLI integrates student typing, correction and new same-target matter before the queued request', async () => {
  test.skip(process.env.YIZHI_REAL_EXECUTOR !== '1', 'Opt-in installed CLI; controlled protocol tested separately'); test.setTimeout(210000);
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t18-real-'));
  const env = {...process.env, PATH:'/usr/bin:/bin', YIZHI_DATA_HOME:join(root,'profile')} as Record<string,string>; delete env.YIZHI_CODEX_PATH;
  const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env});
  let app=await launch(); const evidence: any = {};
  try {
    let page=await app.firstWindow(); await resizeBoardWindow(app,page);
    await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
    await expect.poll(() => page.evaluate(async () => (await window.yizhi.agent.list({sessionId:(await window.yizhi.open()).sessionId})).selectedId)).not.toBeNull();
    const initial=await page.evaluate(async()=>({course:await window.yizhi.open(),status:await window.yizhi.agent.status()}));
    expect(initial.status.available).toBe(true);expect(initial.status.path).not.toContain('fixture');evidence.executor=initial.status;
    const a=initial.course.unit.reading.blocks.find(b=>b.kind==='paragraph')!,b=initial.course.unit.reading.blocks.filter(b=>b.kind==='paragraph')[1];expect(b).toBeTruthy();
    const paragraph=page.getByRole('textbox',{name:'连续编辑正文',exact:true}).locator(`[data-block-id="${a.id}"]`);
    await revealBoardControl(page,paragraph);await paragraph.click();await page.keyboard.press('Home');
    const original=await page.evaluate(async({a,b})=>{const api=window.yizhi,c=await api.open(),l=await api.agent.list({sessionId:c.sessionId});return api.agent.submit({sessionId:c.sessionId,conversationId:l.selectedId!,generation:1,operationId:crypto.randomUUID(),intent:'modify',model:'gpt-6-luna',target:{unitId:'KU-001'},text:`请实际修改固定KU-001，先读target和edit context。两个独立部分分别保存：在段落${a}末尾添加“补充：位权随位置变化。”；在段落${b}末尾添加“独立补充：基数决定可用数码。”。保留每段原文和学生新输入，不改变结论。若同处受保护，保存该组为候选，独立部分照常正式保存，然后说明并结束本轮；不要循环或重复提交候选，不请求逐块采纳，系统在保护解除后会自动整合。后续学生纠正和新事项必须实际处理。`});},{a:a.id,b:b.id});evidence.original=original;
    const correction='更正：首段末尾补充改为“补充：位权等于基数的相应次幂。”，保留学生文字。另一个明确新事项：在同一个固定KU-001末尾新加一个独立段落，内容精确为“三进制示例：12₃ = 5₁₀。”。请实际处理纠正和新增事项，依据真实回执说明，不修改其他单元。';
    await page.evaluate(async({original,correction})=>{const api=window.yizhi,c=await api.open();await api.agent.submit({sessionId:c.sessionId,conversationId:original.conversationId,generation:1,operationId:crypto.randomUUID(),intent:'modify',model:'gpt-6-luna',target:{unitId:'KU-001'},text:correction});},{original,correction});
    const queued=await page.evaluate(async original=>{const api=window.yizhi,c=await api.open();return api.agent.submit({sessionId:c.sessionId,conversationId:original.conversationId,generation:1,operationId:crypto.randomUUID(),mode:'queue',model:'gpt-6-luna',target:{unitId:'KU-001'},text:'前面的修改全部处理结束后，请实际读取最新固定目标，用一句话指出新加入的三进制示例，不再修改。'});},original);
    expect(queued.status).toBe('queued');evidence.queued=queued;
    await page.keyboard.insertText('学生保留前缀：');
    await expect.poll(()=>page.evaluate(async id=>(await window.yizhi.open()).unit.reading.blocks.find(b=>b.id===id)!.payload.text,a.id)).toContain('学生保留前缀：');
    await expect.poll(async()=>(await view(page)).tasks.find(t=>t.id===original.id)?.status,{timeout:120000}).toBe('waiting');
    const waiting=await view(page);evidence.waiting=waiting;
    expect(waiting.tasks.find(t=>t.id===queued.id)!.turnId).toBeNull();
    expect(waiting.tasks[0].groups!.some(g=>g.status==='retained')).toBe(true);expect(waiting.tasks[0].groups!.some(g=>g.status==='committed')).toBe(true);
    const held=await page.evaluate(()=>window.yizhi.open());evidence.held=held.unit;
    expect(held.unit.reading.blocks.find(x=>x.id===a.id)!.payload.text).toContain('学生保留前缀：');
    expect(held.unit.reading.blocks.find(x=>x.id===a.id)!.payload.text).not.toContain('补充：位权等于');
    expect(held.unit.reading.blocks.find(x=>x.id===b.id)!.payload.text).toContain('独立补充：基数决定可用数码。');
    await page.getByRole('button',{name:'学习对话',exact:true}).click();
    await expect.poll(async()=>(await view(page)).tasks.every(t=>t.status==='completed'),{timeout:120000}).toBe(true);
    const done=await view(page);evidence.done=done;const final=await page.evaluate(()=>window.yizhi.open());evidence.final=final.unit;
    const finalText=final.unit.reading.blocks.find(x=>x.id===a.id)!.payload.text;
    expect(finalText).toContain('学生保留前缀：');expect(finalText).toContain('补充：位权等于基数的相应次幂。');
    expect(final.unit.reading.blocks.some(x=>x.payload.text==='三进制示例：12₃ = 5₁₀。')).toBe(true);
    expect(done.tasks[0].attemptId).toBe(original.attemptId);expect(done.tasks[0].turnHistory!.length).toBeGreaterThan(0);
    expect(done.tasks[0].deliveries!.some(d=>d.kind==='steer'&&d.state==='accepted')).toBe(true);
    expect(done.tasks[0].deliveries!.some(d=>d.kind==='student-change'&&d.reviewedBasisId)).toBe(true);
    expect(done.tasks[0].groups!.some(g=>g.resolvedCandidateIds?.length)).toBe(true);
    expect(done.messages.filter(m=>m.taskId===queued.id&&m.role==='assistant').map(m=>m.text).join('\n')).toContain('三进制');
    await page.screenshot({path:evidencePath('t18-real-complete.png')});
    await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
    expect((await page.evaluate(()=>window.yizhi.open())).unit).toEqual(final.unit);evidence.reopened=await view(page);evidence.passed=true;
  } catch(error) {evidence.error=String(error);const p=await app.firstWindow();evidence.failure=await view(p).catch(()=>null);throw error;}
  finally {await writeFile(evidencePath('t18-actual-working.json'),JSON.stringify(evidence,null,2));await app.close();await rm(root,{recursive:true,force:true});}
});

test('installed CLI interprets a new-target guidance and schedules its own fixed-authority task without retargeting the question', async()=>{
  test.skip(process.env.YIZHI_REAL_EXECUTOR!=='1','Opt-in installed CLI');test.setTimeout(120000);
  const root=await mkdtemp(join(tmpdir(),'yizhi-t18-new-matter-')),env={...process.env,PATH:'/usr/bin:/bin',YIZHI_DATA_HOME:join(root,'profile')} as Record<string,string>;delete env.YIZHI_CODEX_PATH;
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env});const evidence:any={};
  try{
    const page=await app.firstWindow();await resizeBoardWindow(app,page);
    await expect.poll(()=>page.evaluate(async()=>(await window.yizhi.agent.list({sessionId:(await window.yizhi.open()).sessionId})).selectedId)).not.toBeNull();
    const before=await page.evaluate(async()=>{const b=window.yizhi,c=await b.open();return{c,other:await b.readUnit(c.sessionId,'KU-057'),executor:await b.agent.status()};});evidence.executor=before.executor;
    const original=await page.evaluate(async()=>{const b=window.yizhi,c=await b.open(),l=await b.agent.list({sessionId:c.sessionId});return b.agent.submit({sessionId:c.sessionId,conversationId:l.selectedId!,generation:1,operationId:crypto.randomUUID(),model:'gpt-6-luna',text:'请先读取位权单元，简洁解释位权。若工作中收到独立新事项，由你理解并使用提供的工具安排，保持本次问题只读。',target:{unitId:'KU-001'}});});evidence.original=original;
    const paragraph=before.other.reading.blocks.find(b=>b.kind==='paragraph')!;
    await page.evaluate(async({original,blockId})=>{const b=window.yizhi,c=await b.open();await b.agent.submit({sessionId:c.sessionId,conversationId:original.conversationId,generation:1,operationId:crypto.randomUUID(),intent:'modify',model:'gpt-6-luna',target:{unitId:'KU-057'},text:`明确的新事项：请在提交目标KU-057的段落${blockId}末尾加上“新事项补充：先确定选择位顺序。”，保留原文。这与原位权问答独立；原任务保持只读，请用yizhi_queue_guidance以本消息deliveryId安排独立固定目标任务，再实际完成该修改。`});},{original,blockId:paragraph.id});
    await expect.poll(async()=>{const v=await view(page);return v.tasks.length===2&&v.tasks.every(t=>t.status==='completed');},{timeout:100000}).toBe(true);
    const done=await view(page);evidence.done=done;
    expect(done.toolFacts.filter(t=>t.taskId===done.tasks[1].id&&t.name==='yizhi_queue_guidance')).toHaveLength(0);
    expect(done.tasks[0].snapshot.target.unitId).toBe('KU-001');expect(done.tasks[0].snapshot.intent).toBe('question');expect(done.tasks[0].groups??[]).toHaveLength(0);
    expect(done.tasks[1].snapshot.target.unitId).toBe('KU-057');expect(done.tasks[1].snapshot.intent).toBe('modify');expect(done.tasks[1].guidedFrom?.taskId).toBe(original.id);
    expect(done.toolFacts.some(t=>t.taskId===original.id&&t.name==='yizhi_queue_guidance')).toBe(true);
    expect(done.tasks[1].groups!.some(g=>g.status==='committed')).toBe(true);
    const after=await page.evaluate(async()=>{const b=window.yizhi,c=await b.open();return{c,other:await b.readUnit(c.sessionId,'KU-057')};});
    expect(after.c.unit).toEqual(before.c.unit);expect(after.other.reading.blocks.find(b=>b.id===paragraph.id)!.payload.text).toBe(paragraph.payload.text+'新事项补充：先确定选择位顺序。');evidence.passed=true;
  }catch(error){evidence.error=String(error);evidence.failure=await view(await app.firstWindow()).catch(()=>null);throw error;}
  finally{await writeFile(evidencePath('t18-actual-new-matter.json'),JSON.stringify(evidence,null,2));await app.close();await rm(root,{recursive:true,force:true});}
});
