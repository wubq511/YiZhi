import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { DevelopmentCourseService } from '../../tools/desktop/course-service';
import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,rm,cp,rename,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {legacyFixture} from './migration-fixture';
import type {Page} from '@playwright/test';

async function captureMigrationFailure(old:Page|undefined,host:ReturnType<typeof spawn>|undefined,traffic:unknown[],errors:string,error:unknown){
 if(!old)return;
 try{
  const scene=await old.evaluate(()=>{
   const board=(window as any).ReviewBoard,p=board?.persistence,state=board?.getState();
   const reading=(value:any)=>({camera:value?.camera,viewport:value?.viewport,selected:value?.selected,layoutVersion:value?.layoutVersion});
   return {camera:state?.camera,cameraNumbers:state?.camera&&Object.fromEntries(Object.entries(state.camera).map(([k,v])=>[k,{type:typeof v,finite:Number.isFinite(v),value:String(v)}])),viewport:state?.viewport,
    world:document.getElementById('world')?.getAttribute('style'),draft:(document.getElementById('agent-draft') as HTMLTextAreaElement)?.value,
    migration:[...document.querySelectorAll('[aria-label="迁移准备状态"]')].map(el=>({role:el.getAttribute('role'),text:el.textContent})),
    persistence:p&&{busy:p.busy,problem:p.problem,sequence:p.sequence,inflightReading:p.inflight?.changes?.filter((c:any)=>c.namespace==='reading').map((c:any)=>reading(c.value)),pendingReading:[...p.pending.values()].filter((c:any)=>c.namespace==='reading').map((c:any)=>reading(c.value))}};
  });
  const path=test.info().outputPath('migration-stop-failure.json');
  await writeFile(path,JSON.stringify({error:String(error),host:{exitCode:host?.exitCode,signalCode:host?.signalCode,stderr:errors.slice(-4000)},traffic,scene},null,2));
  await test.info().attach('migration-stop-failure',{path,contentType:'application/json'});
  await old.screenshot({path:test.info().outputPath('migration-stop-failure.png')});
 }catch(captureError){console.error('Migration stop evidence capture:',captureError);}
}

for(const delayedFrame of [false,true])test('legacy last input is confirmed before shutdown, then checked publication opens the portable course and its original records offline'+(delayedFrame?' with an earlier animation frame timestamp':''),async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-personal-ui-')),source=join(root,'source'),target=join(root,'target');let app:Awaited<ReturnType<typeof electron.launch>>|undefined,host:ReturnType<typeof spawn>|undefined;
 let old:Page|undefined,errors='';const traffic:unknown[]=[];
 try{
  const fixture=await legacyFixture(source);for(const theme of fixture.knowledge.themes)Object.assign(theme,{lessonId:'L01',coreOutcome:'SYNTHETIC UI migration fixture'});await writeFile(join(source,fixture.manifest.knowledge),JSON.stringify(fixture.knowledge));const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'tasks'],{encoding:'utf8'});expect(made.status,made.stderr).toBe(0);const seed=spawnSync('python3',['-B','-c',`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom reviewboard.storage import CourseStore\np=Path(sys.argv[2]);m=json.loads((p/'课程.json').read_text());s=CourseStore(p/m['state'],m['courseId']);s.apply({'operationId':'SYNTHETIC-UI-READING','actor':'student','kind':'personal.edit','generation':1,'expectedRevisions':{'reading:default':0},'changes':[{'namespace':'reading','key':'default','value':{'selected':'KU-001','expanded':[],'camera':{'x':0,'y':0,'scale':1},'unitScroll':{}}}]});s.close()`,resolve('../legacy/review-board'),source],{encoding:'utf8'});expect(seed.status,seed.stderr).toBe(0);
  const originalPaths=[fixture.manifest.knowledge,fixture.manifest.layout,'原始 资料.pdf'],originals=await Promise.all(originalPaths.map(path=>readFile(join(source,path))));
  host=spawn('python3',['-B',resolve('../legacy/review-board/start.py'),'--course',source,'--port','0','--no-browser'],{stdio:['ignore','pipe','pipe']});host.stderr!.on('data',b=>errors=(errors+b).slice(-12000));
  const url=await new Promise<string>((yes,no)=>{let out='';const t=setTimeout(()=>no(Error(errors||'old host timeout')),8000);host!.stdout!.on('data',b=>{out+=b;const m=/http:\/\/127\.0\.0\.1:\d+\//.exec(out);if(m){clearTimeout(t);yes(m[0]);}});host!.once('exit',()=>{clearTimeout(t);no(Error(errors));});});
  app=await electron.launch({args:[resolve('.'),`--course=${join(root,'initial')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-executor')}});const page=await app.firstWindow();
  if(delayedFrame)await app.context().addInitScript(()=>{
   if(location.protocol!=='http:')return;
   // Pin the frame-clock boundary and save through the public board API while
   // restoring the viewport. No camera values or server acknowledgements are mocked.
   const native=requestAnimationFrame;let saves=0;
   window.requestAnimationFrame=callback=>{const scheduled=performance.now();return native(time=>{callback(Math.min(time,scheduled-40));const board=(window as any).ReviewBoard;if(board&&saves++<16)void board.flush();});};
  });
  const oldWindow=app.waitForEvent('window');await app.evaluate(({BrowserWindow},url)=>{void new BrowserWindow({width:1100,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true}}).loadURL(url);},url);old=await oldWindow;
  old.on('request',request=>{if(!request.url().endsWith('/api/v1/commands'))return;const command=request.postDataJSON();traffic.push({phase:'command',operationId:command.operationId,changes:command.changes?.map((c:any)=>({namespace:c.namespace,key:c.key,...(c.namespace==='reading'?{camera:c.value?.camera,viewport:c.value?.viewport}: {})}))});if(traffic.length>16)traffic.shift();});
  old.on('response',response=>{if(!response.url().endsWith('/api/v1/commands')||response.ok())return;void response.json().then(error=>{traffic.push({phase:'rejected',status:response.status(),error});if(traffic.length>16)traffic.shift();}).catch(()=>{});});
  await expect(old.getByRole('button',{name:'保存并停止旧课程',exact:true})).toBeVisible();
  await old.getByRole('button',{name:'学习助手',exact:true}).click();await old.locator('#agent-draft').fill('SYNTHETIC last UI input before cutover');
  // Failed acknowledgement retains the actual field and never stops the host.
  await old.route('**/api/v1/commands',route=>route.abort());await old.getByRole('button',{name:'保存并停止旧课程',exact:true}).click();await expect(old.getByRole('alert',{name:'迁移准备状态'})).toContainText('尚未');expect(host.exitCode).toBeNull();await expect(readFile(join(source,'.review-board/migration-barrier.json'))).rejects.toMatchObject({code:'ENOENT'});await expect(old.locator('#agent-draft')).toHaveValue('SYNTHETIC last UI input before cutover');await old.unroute('**/api/v1/commands');
  const exited=once(host,'exit');await old.getByRole('button',{name:'保存并停止旧课程',exact:true}).click();await expect(old.getByRole('status',{name:'迁移准备状态'})).toContainText('已停止');await exited;
  expect(host.exitCode).toBe(0);const barrier=JSON.parse(await readFile(join(source,'.review-board/migration-barrier.json'),'utf8'));expect(barrier.saved).toBe(true);expect(barrier.phase).toBe('quiesced');
  await writeFile(test.info().outputPath('migration-stop-confirmed.json'),JSON.stringify({traffic,barrier},null,2));
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())if(w.webContents.getURL().startsWith('http://127.0.0.1:'))w.destroy();});
  const development=new DevelopmentCourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
   const candidate=join(root,'candidate');await development.migration.convert({sourceDirectory:source,directory:candidate});
   await development.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target+'-abandoned',operationId:'ui-abandoned'});
   await development.migration.abandon({sourceDirectory:source,operationId:'ui-abandoned'});
   await development.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'ui-publish'});
   await development.migration.publish({sourceDirectory:source,operationId:'ui-publish'});
  } finally {await development.close();}
  const newWindow=app.waitForEvent('window');
  await app.evaluate(({Menu,dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});const menu=Menu.getApplicationMenu()!;const item=menu.items.find(i=>i.label==='课程')!.submenu!.items.find(i=>i.label==='打开课程…')!;item.click();},target);
  const migrated=await newWindow;await expect(migrated.locator('.workspace')).toHaveAttribute('aria-busy','false');
  expect(await migrated.evaluate(()=> 'migration' in window.yizhi)).toBe(false);
  await migrated.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(migrated.getByLabel('对话消息',{exact:true})).toContainText('SYNTHETIC original message without a task');await migrated.getByRole('button',{name:'收起对话',exact:true}).click();
  const tasks=await migrated.evaluate(async()=>{const c=await window.yizhi.open(),chats=await window.yizhi.agent.list(c),view=await window.yizhi.agent.get({...c,conversationId:chats.conversations[0].id});return{draft:view.draft,tasks:view.tasks};});expect(tasks.draft.text).toBe('SYNTHETIC last UI input before cutover');expect(tasks.tasks).toHaveLength(1);
  expect(await Promise.all(originalPaths.map(path=>readFile(join(source,path))))).toEqual(originals);
  const proc=app.process();await app.close();proc.kill('SIGKILL');app=undefined;const portable=join(root,'新设备','课程 中文');const portableCore=new DevelopmentCourseService(join(developmentDirectory(), 'worker.cjs'));let published:string;try{published=(await portableCore.upgrade.recover({directory:target})).directory;}finally{await portableCore.close();}await cp(published,portable,{recursive:true});await rename(source,source+'-hidden');await rename(target,target+'-hidden');
  app=await electron.launch({args:[resolve('.'),`--course=${portable}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'new-profile'),YIZHI_CODEX_PATH:join(root,'absent-executor')}});const reopened=await app.firstWindow();await reopened.context().setOffline(true);await expect(reopened.locator('.workspace')).toHaveAttribute('aria-busy','false');
  const portableFacts=await reopened.evaluate(async()=>{const c=await window.yizhi.open(),chats=await window.yizhi.agent.list(c);return {view:await window.yizhi.agent.get({...c,conversationId:chats.conversations[0].id}),sources:await window.yizhi.sources.list(c)};});expect(portableFacts.view.tasks).toHaveLength(1);expect(portableFacts.view.draft.text).toBe(tasks.draft.text);expect(portableFacts.sources.versions.some(v=>v.sha256===fixture.knowledge.sources[0].versions[0].sha256)).toBe(true);
 }catch(error){await captureMigrationFailure(old,host,traffic,errors,error);throw error;}
 finally{if(host?.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');await once(host,'exit');}if(app){const proc=app.process();const timer=setTimeout(()=>proc.kill('SIGKILL'),4000);await app.close().catch(()=>{});clearTimeout(timer);proc.kill('SIGKILL');}await rm(root,{recursive:true,force:true});}
});

test('installed compatible app opens the complete published personal course at a new path and profile offline with original routes absent',async()=>{
 test.skip(!process.env.YIZHI_T25_ACTUAL_EVIDENCE||!process.env.YIZHI_PACKAGED_APP,'Explicit local stopped-copy installation acceptance; no original course or actual executor.');test.setTimeout(120000);
 const evidence=JSON.parse(await readFile(process.env.YIZHI_T25_ACTUAL_EVIDENCE!,'utf8')),root=await mkdtemp(join(resolve(process.env.YIZHI_T25_ACTUAL_EVIDENCE!,'..'),'t25-installed-')),course=join(root,'独立设备 课程'),installed=join(root,'YiZhi.app'),empty=join(root,'empty');const {mkdir}=await import('node:fs/promises');await mkdir(empty);await cp(evidence.portable,course,{recursive:true});await cp(process.env.YIZHI_PACKAGED_APP!,installed,{recursive:true,verbatimSymlinks:true});
 const launch=()=>electron.launch({executablePath:join(installed,'Contents/MacOS/YiZhi'),cwd:empty,args:[`--course=${course}`,'--host-resolver-rules=MAP * ~NOTFOUND'],env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',NODE_PATH:'',NODE_OPTIONS:'',YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(empty,'missing-executor')}});let app:Awaited<ReturnType<typeof launch>>|undefined;
 try{app=await launch();const page=await app.firstWindow();await page.context().setOffline(true);await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');expect(await app.evaluate(({app})=>app.isPackaged)).toBe(true);
  const inspect=()=>page.evaluate(async()=>{const c=await window.yizhi.open(),reading=await window.yizhi.readingState(c.sessionId),chats=await window.yizhi.agent.list(c),views=await Promise.all(chats.conversations.map(chat=>window.yizhi.agent.get({...c,conversationId:chat.id})));return{courseId:c.courseId,generation:c.generation,cursor:c.eventCursor,notes:await window.yizhi.annotations.list(c),reading,tasks:views.flatMap(v=>v.tasks),messages:views.flatMap(v=>v.messages),sources:await window.yizhi.sources.list(c)};});
  const first=await inspect();expect(first.notes).toHaveLength(1);expect(first.tasks).toHaveLength(2);expect(first.tasks.every(t=>t.status==='completed')).toBe(true);expect(first.messages).toHaveLength(4);expect(first.sources.versions).toHaveLength(16);
  await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(page.getByText(/生成暂不可用/)).toBeVisible();await page.getByRole('button',{name:'收起对话',exact:true}).click();await page.getByRole('button',{name:'原文资料',exact:true}).click();await page.getByLabel('资料版本',{exact:true}).selectOption(first.sources.versions[0].versionId);await expect(page.getByRole('status',{name:'原文状态'})).toHaveText('原页已载入');await expect(page.locator('.source-pdf canvas')).toBeVisible();await page.screenshot({path:test.info().outputPath('installed-personal-source.png')});await page.getByRole('button',{name:'返回画板',exact:true}).click();
  const proc=app.process();await app.close();proc.kill('SIGKILL');app=await launch();const reopened=await app.firstWindow();await reopened.context().setOffline(true);await expect(reopened.locator('.workspace')).toHaveAttribute('aria-busy','false');const again=await reopened.evaluate(async()=>{const c=await window.yizhi.open(),chats=await window.yizhi.agent.list(c);return{notes:await window.yizhi.annotations.list(c),tasks:(await Promise.all(chats.conversations.map(chat=>window.yizhi.agent.get({...c,conversationId:chat.id})))).flatMap(v=>v.tasks)};});expect(again.notes).toEqual(first.notes);expect(again.tasks.map(t=>t.id).sort()).toEqual(first.tasks.map(t=>t.id).sort());expect(again.tasks.every(t=>t.status==='completed')).toBe(true);
 }finally{if(app){const proc=app.process(),timer=setTimeout(()=>proc.kill('SIGKILL'),4000);await app.close().catch(()=>{});clearTimeout(timer);proc.kill('SIGKILL');}await rm(root,{recursive:true,force:true});}
});
