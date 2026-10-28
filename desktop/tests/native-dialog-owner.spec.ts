import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceFixture } from './source-fixture';

test('source import and repair attach the native chooser to the requesting learning window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-native-dialog-'));
  const file = join(root, 'source.pdf'); await sourceFixture(file);
  const app = await electron.launch({ args:[resolve('.'),`--course=${join(root,'course')}`],
    env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')} });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    const owner = await app.browserWindow(page);
    const ownerId = await owner.evaluate(window=>window.id);
    await app.evaluate(({dialog},path)=>{
      (globalThis as any).sourceChooserOwners=[];
      dialog.showOpenDialog=async (window:any,options?:any)=>{
        const calls=(globalThis as any).sourceChooserOwners;
        calls.push({id:window?.id??null,title:(options??window)?.title});
        return calls.length===1 ? {canceled:false,filePaths:[path]} : {canceled:true,filePaths:[]};
      };
    },file);
    await page.getByRole('button',{name:'原文资料',exact:true}).click();
    await page.getByRole('button',{name:'导入资料',exact:true}).click();
    await expect(page.getByRole('status',{name:'原文状态'})).toHaveText('原页已载入');
    const state=await page.evaluate(async()=>{
      const api=(window as any).yizhi,c=await api.open(),list=await api.sources.list({sessionId:c.sessionId});
      return {sessionId:c.sessionId,generation:list.generation,versionId:list.versions[0].versionId};
    });
    const cancelled=await page.evaluate(request=>(window as any).yizhi.sources.chooseRepair({
      ...request,operationId:crypto.randomUUID()}),state);
    expect(cancelled).toBeNull();
    const calls=await app.evaluate(()=>(globalThis as any).sourceChooserOwners);
    expect(calls).toEqual([{id:ownerId,title:'导入课程原件'},{id:ownerId,title:'选择该版本的原件以修复'}]);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
