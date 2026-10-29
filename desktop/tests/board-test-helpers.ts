import { expect,test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** Only a failed fixture may force its own process to exit; preserve the initiating failure first. */
export async function closeFailedBoard(app: ElectronApplication, failure: unknown) {
 const page=app.windows()[0];
 const evidence={failure:failure instanceof Error?{message:failure.message,stack:failure.stack}:String(failure),
  state:page?await captureBoardState(app,page):null};
 const path=test.info().outputPath('original-failure-before-close.json');
 await writeFile(path,JSON.stringify(evidence,null,2));
 await test.info().attach('original-failure-before-close.json',{path,contentType:'application/json'});
 const proc=app.process();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([app.close().catch(()=>{}),new Promise<void>(done=>{timer=setTimeout(done,1500);})]);
 }finally{
  clearTimeout(timer);
  if(proc.exitCode===null&&proc.signalCode===null){const exited=new Promise<void>(done=>proc.once('exit',()=>done()));proc.kill('SIGKILL');await exited;}
 }
}

/** Bounded evidence only: never changes native visibility, saved camera or readiness. */
export async function captureBoardState(app:ElectronApplication,page:Page) {
 const bounded=async<T>(read:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([read.catch(error=>({error:String(error)})),new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),1500);})]);}finally{clearTimeout(timer);}};
 const [native,renderer]=await Promise.all([
  bounded(app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),minimized:w.isMinimized(),focused:w.isFocused(),bounds:w.getBounds(),loading:w.webContents.isLoading(),destroyed:w.webContents.isDestroyed()})))),
  bounded(page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return {visibility:document.visibilityState,readyState:document.readyState,workspace:document.querySelector('.workspace')?.getAttribute('aria-busy'),errors:[...document.querySelectorAll('.load-error,.read-error')].map(e=>e.textContent),camera:(document.querySelector('.react-flow__viewport') as HTMLElement)?.style.transform,reading:await b.readingState(c.sessionId),articles:[...document.querySelectorAll('article[data-unit-id]')].map(e=>({unitId:e.getAttribute('data-unit-id'),active:e.getAttribute('data-reading-active')}))};})),
 ]);return {native,renderer};
}

export async function resizeBoardWindow(app: ElectronApplication, page: Page, width = 1024, height = 688) {
  const errors:string[]=[];const onError=(error:Error)=>{if(errors.length<8)errors.push(error.message.slice(0,1000));};page.on('pageerror',onError);
  try {await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');}
  catch(error){
    const state=await captureBoardState(app,page);await test.info().attach('board-readiness-failure.json',{body:JSON.stringify({state,errors},null,2),contentType:'application/json'});
    await page.screenshot({path:test.info().outputPath('board-readiness-failure.png'),timeout:1500}).catch(()=>{});throw error;
  }finally{page.off('pageerror',onError);}

  const size = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(width, height); return window.getContentSize();
  }, { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size);
}

export async function revealBoardControl(page: Page, target: Locator) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  const board = (await page.locator('main.board').boundingBox())!;
  await page.mouse.move(board.x + 8, board.y + board.height / 2);
  for (let step = 0; step < 60; step++) {
    const box = (await target.boundingBox())!;
    const delta = box.y + box.height / 2 - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 6) return;
    await page.mouse.wheel(0, Math.max(-500, Math.min(500, delta)));
    await page.waitForTimeout(30);
  }
  throw new Error(`画板控件未进入视野：${JSON.stringify(await target.boundingBox())}`);
}

/** Read the actual inline transform components without CSSOM string serialization.
 * style.transform rounds to six significant digits; even DOMMatrix's typed conversion
 * uses float32. The translate/scale CSS numeric values retain the original doubles.
 */
export async function readCameraTransform(target: Locator): Promise<{x:number;y:number;zoom:number}> {
  return target.evaluate(el => {
    const transforms = Array.from((el as any).attributeStyleMap.get('transform')) as any[];
    if (transforms.length !== 2 || transforms[0].constructor.name !== 'CSSTranslate' || transforms[1].constructor.name !== 'CSSScale'
      || transforms[0].x.unit !== 'px' || transforms[0].y.unit !== 'px' || transforms[1].x.value !== transforms[1].y.value) {
      throw new Error('Camera observation requires the actual 2D translate(px)/uniform scale transform');
    }
    const view={x:transforms[0].x.value,y:transforms[0].y.value,zoom:transforms[1].x.value};
    if (!Object.values(view).every(Number.isFinite)) throw new Error('Camera transform is not finite');
    return view;
  });
}

/** Counts static reading bodies as well as protected editing hosts; no excluded DOM category. */
export async function expectBoundedReading(page:Page) {
 const layers=await page.locator('.reading-layer').count();
 expect(await page.locator('.tiptap.ProseMirror').count()).toBeLessThanOrEqual(2);
 const observation=await page.evaluate(()=>(window as any).__yizhiObservation?.());
 if(observation?.['reading.rangeUnits']&&observation?.['reading.protectedUnits']){
  const protectedRange=observation['reading.rangeUnits'].max+observation['reading.protectedUnits'].max;
  expect(layers).toBeLessThanOrEqual(protectedRange);
  expect(observation['reading.cachedUnits'].max).toBeLessThanOrEqual(protectedRange+2);
 }
 return layers;
}
