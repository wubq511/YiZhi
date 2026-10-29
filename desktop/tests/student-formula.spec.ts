import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CourseService} from '../src/core/course-service';
import {muxCopy,correction} from './agent-mutation-setup';
import {resizeBoardWindow,revealBoardControl,closeFailedBoard} from './board-test-helpers';
import {DatabaseSync} from 'node:sqlite';
import {unitBlocks} from '../src/core/consistency-links';
for(const nested of [false,true])test(`student reaches an existing ${nested?'nested':'root'} linked formula from the experiment and saves unsupported input with an explicit check state`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-student-formula-ui-')),course=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 let failure:unknown;
 try{
  const fixture=await muxCopy(core,course);{const result=await core.commands.commit(await correction(core,fixture.sessionId,fixture.citation.id,'verified-link'));expect(result.status).toBe('committed');}
  await core.close();
  if(nested){
   const seed=new DatabaseSync(join(course,'course.sqlite'));
   try{
    const unit=JSON.parse(String(seed.prepare('SELECT payload FROM units WHERE id=?').get('KU-057')!.payload));
    const formula=unit.reading.blocks.find((b:any)=>b.id==='mux-linked-formula');
    unit.reading.blocks=unit.reading.blocks.filter((b:any)=>b.id!==formula.id);
    unit.reading.blocks.unshift({id:'linked-formula-exercise',kind:'exercise',payload:{title:'已备好的公式练习',problem:'在答案材料内核对公式'},children:[{id:'linked-formula-example',kind:'example',payload:{title:'嵌套推导',problem:'保留现有公式身份'},children:[formula]}]});
    seed.prepare('UPDATE units SET payload=? WHERE id=?').run(JSON.stringify(unit),unit.id);
   }finally{seed.close();}
  }
  app=await electron.launch({args:[resolve('.'),`--course=${course}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-cli')}});
  const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'复用器与分配器',exact:true}).click();await page.getByRole('button',{name:'MUX 器件、级联与扩展',exact:true}).first().click();
  const button=page.getByRole('button',{name:'编辑关联正文公式',exact:true});await revealBoardControl(page,button);await button.click();
  const field=page.locator('.editor-formula[data-block-id="mux-linked-formula"] math-field');await expect(field).toBeVisible();
  await field.evaluate((el:any)=>{el.setValue('Z=S_{10}');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));});
  await expect(page.getByRole('status',{name:'当前单元保存状态'})).toHaveText('已保存');
  await expect.poll(async()=>unitBlocks(await page.evaluate(async()=>{const c=await window.yizhi.open();return window.yizhi.readUnit(c.sessionId,'KU-057');})).find(b=>b.id==='mux-linked-formula')!.payload.latex).toContain('10');
  if(nested){
   expect(await page.locator('article[data-unit-id="KU-057"] details.material').first().getAttribute('open')).not.toBeNull();
   expect(await page.locator('article[data-unit-id="KU-057"] details.answer').first().getAttribute('open')).not.toBeNull();
   const saved = await page.evaluate(async()=>{const c=await window.yizhi.open();return window.yizhi.read(c.sessionId,'KU-057');});
   await field.focus(); await field.evaluate((el:any)=>{el.selection={ranges:[[0,el.lastOffset]]};});
   const editor=page.locator('article[data-unit-id="KU-057"] .tiptap');
   const capture=()=>editor.evaluate((el:any)=>el.editor.storage.courseSelection.captureAnnotation());
   await expect.poll(async()=>(await capture()).fragments[0]?.source).toBe('formal');
   const held=(await capture()).fragments[0];
   expect(held.contentVersion).toBe(saved.blockVersions!['mux-linked-formula']);
   expect(held.formalRevision).toBe(saved.revision);
   await editor.evaluate((el:any)=>el.editor.storage.courseSelection.settle());
   const next=await page.evaluate(async()=>{
    const b=window.yizhi,c=await b.open(),s=await b.read(c.sessionId,'KU-057'),p=s.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
    return b.commitEdit({sessionId:c.sessionId,unitId:s.unit.id,operationId:'unrelated-held-formula-update',inputSeq:s.confirmedInputSeq+1,baseRevision:s.revision,complete:true,changes:[],patch:{updates:[{blockId:p.id,before:p.payload,after:{...p.payload,text:p.payload.text+' independent'}}],correspondence:[]}});
   });
   await expect.poll(()=>editor.evaluate((el:any)=>el.editor.storage.courseSelection.capture().latestFormalRevision)).toBe(next.revision);
   expect((await capture()).fragments[0]).toEqual(held);
  }
  await expect(page.getByText('公式需要核对；当前不显示计算结果。',{exact:true})).toBeAttached();
  await page.screenshot({path:test.info().outputPath('linked-formula-needs-check.png')});
 }catch(error){failure=error;throw error;}
 finally{await core.close();if(app){if(failure)await closeFailedBoard(app,failure);else await app.close();}await rm(root,{recursive:true,force:true});}
});
