import { evidencePath } from './evidence-paths';
import {resizeBoardWindow,revealBoardControl} from './board-test-helpers';
import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {ElectronApplication,Page} from '@playwright/test';
async function captureVisibility(app:ElectronApplication,page:Page,phase:string){
 const renderer=await page.evaluate(async()=>{const b=window.yizhi,c=await b.open(),lab=document.querySelector('.extension-lab'),board=document.querySelector('main.board')!;
  const intersection=lab?await new Promise(resolve=>{const o=new IntersectionObserver(entries=>{o.disconnect();const e=entries[0];resolve({intersecting:e.isIntersecting,ratio:e.intersectionRatio,root:e.rootBounds?.toJSON(),target:e.boundingClientRect.toJSON(),intersection:e.intersectionRect.toJSON()});},{root:board});o.observe(lab);}):null;
  const v=await b.extensions.read({sessionId:c.sessionId});return {visibility:document.visibilityState,focus:document.hasFocus(),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,header:document.querySelector('header')?.getBoundingClientRect().toJSON(),board:board.getBoundingClientRect().toJSON(),scroll:[board.scrollLeft,board.scrollTop],lab:lab?.getBoundingClientRect().toJSON(),intersection,active:document.activeElement?.outerHTML.slice(0,250),inert:[...document.querySelectorAll('[inert]')].slice(0,8).map(el=>el.outerHTML.slice(0,180)),inline:document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform,camera:(await b.readingState(c.sessionId))?.camera,extension:{visible:v.visible,running:v.running,phase:v.phase,generation:v.generation,revision:v.revision,state:v.state,definition:v.definition.packageVersion,pending:v.pending?.packageVersion,error:v.error}};});
 const native=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {outer:w.getSize(),content:w.getContentSize(),visible:w.isVisible(),focused:w.isFocused(),minimized:w.isMinimized()};});
 const path=test.info().outputPath('visibility-'+phase+'.json');await writeFile(path,JSON.stringify({...renderer,native},null,2));await test.info().attach('visibility-'+phase,{path,contentType:'application/json'});await page.screenshot({path:test.info().outputPath('visibility-'+phase+'.png'),timeout:1000});
}
async function verifyVisibility(app:ElectronApplication,page:Page,phase:string,verify:()=>Promise<void>){
 try{await verify();}catch(error){
  // Bound failure evidence so diagnostics cannot hold the serial UI lease indefinitely.
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([captureVisibility(app,page,phase),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('visibility capture deadline')),2000);})]);}
  catch(captureError){console.error('Extension visibility evidence:',String(captureError));}finally{clearTimeout(timer);}
  throw error;
 }
}

test('a real sandboxed browser Worker verifies learning results, saves complete steps and reopens offline after cache removal', async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-ui-'));
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
 let app=await launch();
 try {
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
  await revealBoardControl(page,page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}));
  await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  const lab=()=>page.getByRole('region',{name:'奇偶校验扩展实验',exact:true});
  await expect(lab().getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  const frame=page.frameLocator('iframe[title="奇偶校验运行结果"]');
  await expect(frame.getByLabel('奇偶校验输出')).toHaveText('奇数检测 P = 0');
  await lab().getByRole('checkbox',{name:'A',exact:true}).check();
  await expect(frame.getByLabel('奇偶校验输出')).toHaveText('奇数检测 P = 1');
  await lab().getByRole('button',{name:'开始模拟',exact:true}).click();
  const read=()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.extensions.read({sessionId:c.sessionId});});
  await expect.poll(async()=>(await read()).state.step).toBeGreaterThan(0);
  await page.getByRole('button',{name:'组合逻辑分析与设计',exact:true}).click();
  await expect.poll(async()=>(await read()).phase).toBe('paused');
  const offscreen=(await read()).state;await page.waitForTimeout(650);expect((await read()).state).toEqual(offscreen);
  // A short native viewport puts the lab below the unit header after navigation.
  await resizeBoardWindow(app,page,1024,600);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
  await verifyVisibility(app,page,'return-to-running',async()=>{
   await revealBoardControl(page,lab().getByRole('button',{name:'暂停模拟',exact:true}));
   await expect.poll(async()=>(await read()).visible).toBe(true);
   await expect.poll(async()=>(await read()).phase).toBe('running');
   await expect.poll(async()=>(await read()).state.step).toBeGreaterThan(offscreen.step);
  });
  await lab().getByRole('button',{name:'暂停模拟',exact:true}).click();
  await expect.poll(async()=>(await read()).phase).toBe('paused');
  const saved=await read();
  const actualFrame=page.frames().find(f=>f.url().startsWith('yizhi-extension:'))!;
  expect(await actualFrame.evaluate(()=>({origin:location.origin,node:typeof (window as any).require,bridge:typeof (window as any).yizhi,parentReadable:(()=>{try{return !!parent.document;}catch{return false;}})()}))).toEqual({origin:'yizhi-extension://package',node:'undefined',bridge:'undefined',parentReadable:false});
  await page.screenshot({path:evidencePath('t13-extension.png')});
  await app.evaluate(async({session})=>{await session.defaultSession.clearCache();await session.defaultSession.clearStorageData();await session.defaultSession.enableNetworkEmulation({offline:true});});
  await app.close();
  await rm(join(root,'profile','Cache'),{recursive:true,force:true});
  app=await launch(); await app.evaluate(async({session})=>{await session.defaultSession.enableNetworkEmulation({offline:true});}); page=await app.firstWindow();await resizeBoardWindow(app,page);
  await revealBoardControl(page,page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}));
  await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  await expect(lab().getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  expect((await read()).state).toEqual(saved.state);
  expect((await read()).definition).toEqual(saved.definition);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(700,700));
  const directory=page.getByRole('navigation',{name:'课程目录'});if(await directory.isVisible())await directory.press('Escape');
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
  const narrowBoard=(await page.locator('main.board').boundingBox())!;
  const narrowInput=lab().getByRole('checkbox',{name:'A',exact:true});await expect(narrowInput).toBeVisible();
  const beforeInput=(await narrowInput.boundingBox())!;
  // Restored native focus movement is part of the saved camera. Pan from the
  // actual control position, with gain 1, instead of assuming an old viewport.
  await page.mouse.move(narrowBoard.x+12,narrowBoard.y+narrowBoard.height/2);
  await page.mouse.wheel(beforeInput.x+beforeInput.width/2-narrowBoard.x-narrowBoard.width/2,
   beforeInput.y+beforeInput.height/2-narrowBoard.y-narrowBoard.height/2);
  await expect.poll(async()=>((await narrowInput.boundingBox())!.y+(await narrowInput.boundingBox())!.height/2)).toBeCloseTo(narrowBoard.y+narrowBoard.height/2,0);
  const inputBox=(await narrowInput.boundingBox())!;expect(inputBox.y).toBeGreaterThan(narrowBoard.y);expect(inputBox.y+inputBox.height).toBeLessThan(narrowBoard.y+narrowBoard.height);
  await page.screenshot({path:evidencePath('t13-extension-narrow.png')});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('actual Worker nonresponse reports incomplete; destroyed generations cannot overwrite recovery, and compatible/incompatible definitions keep exact versions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-lifecycle-'));
 const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
 const child=app.process();
 try{
  const page=await app.firstWindow();await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
  await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  const lab=page.getByRole('region',{name:'奇偶校验扩展实验',exact:true});
  await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  const read=()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.extensions.read({sessionId:c.sessionId});});
  const confirmed=await read();
  // This evaluates an infinite loop in the ACTUAL package browser Worker, not a fake timeout transport.
  const worker=page.workers().find(w=>w.url().includes('/compute.js'))!;expect(worker).toBeTruthy();
  void worker.evaluate(()=>{while(true){/* deliberately nonresponsive disposable Worker */}}).catch(()=>{});
  await lab.getByRole('button',{name:'开始模拟',exact:true}).click();
  await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('暂停未完成',{timeout:10000});
  expect((await read()).state).toEqual(confirmed.state);
  await lab.getByRole('button',{name:'恢复最近确认现场',exact:true}).click();
  await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  expect((await read()).generation).toBeGreaterThan(confirmed.generation);
  await lab.getByRole('checkbox',{name:'B',exact:true}).check();
  await expect.poll(async()=>(await read()).state.output).toBe(1);
  await lab.getByText('扩展版本与资源',{exact:true}).click();
  await lab.getByRole('button',{name:'载入兼容定义 1.1.0',exact:true}).click();
  await expect.poll(async()=>(await read()).definition.packageVersion).toBe('1.1.0');
  expect((await read()).state.inputs).toEqual({A:0,B:1,C:0});expect((await read()).state.ones).toBe(1);
  await lab.getByRole('button',{name:'载入四位定义 2.0.0',exact:true}).click();
  await expect(lab.getByRole('button',{name:'按新定义重新开始',exact:true})).toBeVisible();
  expect((await read()).definition.packageVersion).toBe('1.1.0');
  await resizeBoardWindow(app,page,1024,600);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
  await verifyVisibility(app,page,'return-to-visible',async()=>{
   await revealBoardControl(page,lab.getByRole('button',{name:'开始模拟',exact:true}));
   await expect.poll(async()=>(await read()).visible).toBe(true);
  });
  const oldStep=(await read()).state.step;
  await lab.getByRole('button',{name:'开始模拟',exact:true}).click({timeout:1500});
  await expect.poll(async()=>(await read()).state.step).toBeGreaterThan(oldStep);
  await lab.getByRole('button',{name:'暂停模拟',exact:true}).click();
  await expect.poll(async()=>(await read()).phase).toBe('paused');
  expect((await read()).definition.packageVersion).toBe('1.1.0');
  await page.screenshot({path:evidencePath('t13-conflict.png')});
  await lab.getByRole('button',{name:'按新定义重新开始',exact:true}).click();
  await expect.poll(async()=>(await read()).definition.packageVersion).toBe('2.0.0');
  await expect(lab.getByRole('checkbox',{name:'D',exact:true})).toBeVisible();
  await app.close();
 }finally{if(child.exitCode===null&&child.signalCode===null){const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await done;}await rm(root,{recursive:true,force:true});}
});

test('a genuinely unresponsive learning renderer is recovered by the host with persisted editor, extension scene and new generation',async()=>{
 const {spawn}=await import('node:child_process');const {readFile,writeFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-hung-renderer-'));
 const evidence=join(root,'evidence.json');
 const executable=(await import('electron')).default as unknown as string;
 const child=spawn(executable,['--disable-site-isolation-trials',resolve('dist/tests/extension-host-fixture.cjs'),`--course=${join(root,'course')}`],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_RECOVERY_EVIDENCE:evidence},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 try{
  const code=await new Promise<number|null>((r,j)=>{child.once('exit',r);child.once('error',j);});
  const result=JSON.parse(await readFile(evidence,'utf8'));
  expect(code,logs+JSON.stringify(result)).toBe(0);expect(result.error).toBeUndefined();
  expect(result.events).toBeGreaterThan(0);expect(result.loads).toBe(2);
  expect(result.oldPid).not.toBe(result.newPid);expect(result.after.state).toEqual(result.before.state);
  expect(result.after.generation).toBeGreaterThan(result.before.generation);
  expect(result.text).toBe('Persisted before native renderer failure.');
  await writeFile(evidencePath('t13-native-recovery-evidence.json'),JSON.stringify(result,null,2));
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});

test('actual generated DOM height enters reading measurements while the live editor DOM stays stable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-height-'));
 const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
 const child=app.process();
 try{
  const page=await app.firstWindow();await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
  await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  const lab=page.getByRole('region',{name:'奇偶校验扩展实验',exact:true});
  await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  await expect(page.locator('.ProseMirror')).toHaveCount(1);
  await page.evaluate(()=>{(window as any).__extensionEditor=document.querySelector('.ProseMirror');});
  const board=(await page.locator('main.board').boundingBox())!;
  await page.mouse.move(board.x+12,board.y+board.height/2);await page.mouse.wheel(0,400);await page.waitForTimeout(150);
  const oldHeight=await lab.evaluate(el=>el.getBoundingClientRect().height);
  const frame=page.frames().find(f=>f.url().startsWith('yizhi-extension:'))!;
  await frame.evaluate(()=>{const p=document.createElement('p');p.textContent='已确认模型变量的完整说明。';p.style.height='220px';document.body.append(p);});
  await expect.poll(()=>lab.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(oldHeight+100);
  expect(await page.evaluate(()=>(window as any).__extensionEditor===document.querySelector('.ProseMirror'))).toBe(true);
  await app.close();
 }finally{if(child.exitCode===null&&child.signalCode===null){const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await done;}await rm(root,{recursive:true,force:true});}
});

test('new input during an actual target-frame migration invalidates its held result, then migration rechecks the newest scene',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-live-migrate-'));
 const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});const child=app.process();
 try{
  const page=await app.firstWindow();
  await page.addInitScript(()=>{if(location.pathname.includes('/1.1.0/'))addEventListener('message',e=>{if(e.data?.kind==='migrate'&&e.data.state.step!==7&&!sessionStorage.getItem('migration-gate-used')){sessionStorage.setItem('migration-gate-used','yes');(window as any).__heldMigration=e.data;e.stopImmediatePropagation();}},true);});
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  const lab=page.getByRole('region',{name:'奇偶校验扩展实验',exact:true});await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  const act=(action:any)=>page.evaluate(async a=>{const b=(window as any).yizhi,c=await b.open(),v=await b.extensions.read({sessionId:c.sessionId});return b.extensions.act({sessionId:c.sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action:a});},action);
  const read=()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.extensions.read({sessionId:c.sessionId});});
  await act({kind:'definition',version:'1.1.0'});
  await expect.poll(async()=>{const f=page.frames().find(f=>f.url().includes('/1.1.0/'));return f?await f.evaluate(()=>!!(window as any).__heldMigration):false;}).toBe(true);
  const target=page.frames().find(f=>f.url().includes('/1.1.0/'))!;
  await act({kind:'inputs',inputs:{A:1,B:0,C:0}});
  // Release the original protocol request to the real target Worker. It still carries the old scene.
  const held=await target.evaluate(()=>(window as any).__heldMigration);
  await page.evaluate(q=>{const f=[...document.querySelectorAll('iframe')].find(f=>f.src.includes('/1.1.0/'))!;f.contentWindow!.postMessage(q,'yizhi-extension://package');},held);
  await expect.poll(async()=>(await read()).definition.packageVersion).toBe('1.1.0');
  const final=await read();expect(final.inputs).toEqual({A:1,B:0,C:0});expect(final.state.inputs).toEqual(final.inputs);expect(final.state.output).toBe(1);expect(final.state.ones).toBe(1);
  await app.close();
 }finally{if(child.exitCode===null&&child.signalCode===null){const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await done;}await rm(root,{recursive:true,force:true});}
});

test('an actual confirmation disk fault stops browser steps and offers explicit recovery while retaining the last saved scene',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const root=await mkdtemp(join(tmpdir(),'yizhi-extension-disk-fault-'));
 const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});const child=app.process();let fault:InstanceType<typeof DatabaseSync>|undefined;
 try{
  const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();await revealBoardControl(page,page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}));
  await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  const lab=page.getByRole('region',{name:'奇偶校验扩展实验',exact:true});await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');
  const frame=page.frames().find(f=>f.url().startsWith('yizhi-extension:'))!;
  await frame.evaluate(()=>{(window as any).__issuedSteps=0;addEventListener('message',e=>{if(e.data?.kind==='step')(window as any).__issuedSteps++;});});
  await lab.getByRole('button',{name:'开始模拟',exact:true}).click();
  const read=()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.extensions.read({sessionId:c.sessionId});});
  await expect.poll(async()=>(await read()).state.step).toBeGreaterThan(0);
  fault=new DatabaseSync(join(root,'course/course.sqlite'));fault.exec("CREATE TRIGGER extension_ui_disk_fault BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT,'actual extension disk fault'); END");
  await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('暂停未完成');
  const confirmed=(await read()).state,issued=await frame.evaluate(()=>(window as any).__issuedSteps);
  await page.waitForTimeout(700);expect(await frame.evaluate(()=>(window as any).__issuedSteps)).toBe(issued);expect((await read()).state).toEqual(confirmed);
  await revealBoardControl(page,page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}));
  await page.getByRole('button',{name:'奇偶校验扩展实验',exact:true}).click();
  await expect(lab).toBeVisible();
  fault.exec('DROP TRIGGER extension_ui_disk_fault');fault.close();fault=undefined;
  await revealBoardControl(page,lab.getByRole('button',{name:'恢复最近确认现场',exact:true}));
  await lab.getByRole('button',{name:'恢复最近确认现场',exact:true}).click();await expect(lab.getByRole('status',{name:'扩展保存状态'})).toHaveText('现场已保存');expect((await read()).state).toEqual(confirmed);
  await app.close();
 }finally{fault?.close();if(child.exitCode===null&&child.signalCode===null){const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await done;}await rm(root,{recursive:true,force:true});}
});
