import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow, revealBoardControl, waitForReadingLayout } from './board-test-helpers';

async function captureSearchFailure(page: Page, name: string, error: unknown) {
  try {
    const scene = await page.evaluate(async () => {
      const b = window.yizhi, c = await b.open(), query = document.querySelector<HTMLInputElement>('input[type="search"]')?.value;
      return { viewport: [innerWidth, innerHeight], camera: (document.querySelector('.react-flow__viewport') as HTMLElement)?.style.transform,
        query, focus: document.activeElement?.outerHTML.slice(0, 400), reading: await b.readingState(c.sessionId),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.textContent), results: document.querySelector('.search-results')?.outerHTML,
        index: await b.search.status({ sessionId: c.sessionId }), rawQuery: query ? await b.search.query({ sessionId: c.sessionId, query }) : undefined,
        editors: [...document.querySelectorAll('.reading-layer')].map(el => ({ unitId: el.getAttribute('data-unit-id'), editor: !!el.querySelector('[contenteditable="true"]'), loading: el.textContent?.includes('正在读取当前正文与输入') })) };
    });
    const json = test.info().outputPath(`${name}-scene.json`), dom = test.info().outputPath(`${name}-dom.html`), png = test.info().outputPath(`${name}.png`);
    await writeFile(json, JSON.stringify({ error: String(error), scene }, null, 2)); await writeFile(dom, await page.content()); await page.screenshot({ path: png });
    for (const [label, path, contentType] of [[`${name}-scene`, json, 'application/json'], [`${name}-dom`, dom, 'text/html'], [name, png, 'image/png']])
      await test.info().attach(label, { path, contentType });
  } catch (captureError) { console.error('Search location failure evidence:', captureError); }
}

test('offline real IPC search reveals a delivered deep answer and restores the original camera and disclosures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  let current: Page | undefined;
  try {
    const page = await app.firstWindow(); current = page; await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const first = page.getByRole('textbox', { name: '编辑首段正文' });
    await revealBoardControl(page, first); await first.click();
    await first.evaluate(el => { const range = document.createRange(); range.setStart(el.firstChild!, 0); range.setEnd(el.firstChild!, 3); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    // Settle the real caret/native-scroll response before defining the search's starting scene.
    await waitForReadingLayout(page);
    const selectedText = await page.evaluate(() => getSelection()!.toString());
    const before = await page.locator('.reading-layer[data-unit-id="KU-001"]').getAttribute('style');
    // Delay one real Worker read so locating must await the destination editor.
    await app.evaluate(() => {
      const { Worker } = process.getBuiltinModule('node:worker_threads')!, original = Worker.prototype.postMessage;
      (globalThis as any).searchReadDelay = [];
      Worker.prototype.postMessage = function(message: any, transfer: any) {
        if (message.action === 'read' && message.payload?.unitId === 'KU-002') {
          Worker.prototype.postMessage = original;
          (globalThis as any).searchReadDelay.push('held');
          setTimeout(() => { (globalThis as any).searchReadDelay.push('sent'); original.call(this, message, transfer); }, 250);
          return;
        }
        original.call(this, message, transfer);
      };
    });
    await page.context().setOffline(true);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('0.40625×16');
    const results = page.getByRole('region', { name: '搜索结果' });
    await expect(results.getByRole('button', { name: '定位命中' }).first()).toBeVisible();
    await results.getByRole('button', { name: '定位命中' }).first().click();
    await expect(page.locator('[data-search-current="true"]')).toContainText('0.40625×16');
    expect(await app.evaluate(() => (globalThis as any).searchReadDelay)).toEqual(['held', 'sent']);
    await expect(page.locator('[data-unit-id="KU-002"] details.answer')).toHaveAttribute('open', '');
    await page.getByRole('button', { name: '返回搜索前位置', exact: true }).click();
    await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toHaveAttribute('style', before!);
    await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe(selectedText);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('Nibble');
    await results.getByRole('button', { name: '定位命中' }).first().click();
    await expect(page.locator('[data-search-current="true"]')).toContainText('Nibble');
    await page.screenshot({ path: evidencePath('t15-knowledge-hit.png') });
    await app.close(); app = await launch();
    const reopened = await app.firstWindow(); current = reopened; await resizeBoardWindow(app, reopened);
    await reopened.context().setOffline(true);
    await reopened.getByRole('button', { name: '搜索课程', exact: true }).click();
    await reopened.getByRole('searchbox').fill('Nibble');
    await reopened.getByRole('button', { name: '定位命中' }).first().click();
    await expect(reopened.locator('[data-search-current="true"]')).toContainText('Nibble');
  } catch (error) { if (current) await captureSearchFailure(current, 'deep-search-location', error); throw error; }
  finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('real saved note and durable message results open their own objects, preserve composer text and work at narrow width', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-personal-ui-'));
  // Seed actual records through the same public CourseService used by the host, never renderer-local search data.
  const { CourseService } = await import('../src/core/course-service');
  const core = new CourseService(resolve('dist/worker.cjs'));
  const c = await core.open(join(root, 'course')), b = c.unit.reading.blocks[0];
  const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'ui-note', text: '笔记定位独特词', selection: { unitId: c.unit.id, fragments: [{ blockId: b.id, block: b, field: 'text', formalRevision: 1, source: 'formal', projection: { version: 1, encoding: 'unicode-code-points', text: b.payload.text }, from: 0, to: 1, quote: Array.from(b.payload.text)[0] as string }] } });
  const conversation = await core.agent.create({ sessionId: c.sessionId, operationId: 'ui-conversation' });
  const task = await core.agent.submit({ sessionId: c.sessionId, conversationId: conversation.id, operationId: 'ui-question', generation: 1, text: '持久消息定位独特词', target: { unitId: c.unit.id } });
  await core.recordAgent({ sessionId: c.sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'actual-answer', kind: 'message', itemId: 'answer', text: '深层已保存回答的独特词' });
  await core.recordAgent({ sessionId: c.sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'actual-finish', kind: 'finish', status: 'completed' });
  await core.agent.saveDraft({ sessionId: c.sessionId, conversationId: conversation.id, seq: 1, text: '保留未发送草稿' });
  await core.close();
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('笔记定位独特词');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveValue(note.text);
    await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveAttribute('data-search-current', 'true');
    await page.getByRole('button', { name: '返回搜索前位置' }).click();
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('深层已保存回答');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.locator('[data-search-current="true"]')).toHaveAttribute('data-message-id', `${task.id}:answer`);
    await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toHaveValue('保留未发送草稿');
    await page.getByRole('button', { name: '返回搜索前位置' }).click();
    await resizeBoardWindow(app, page, 700, 700);
    await page.getByRole('button', { name: '收起目录' }).click();
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '搜索课程', exact: true })).toBeVisible();
    await expect(page.locator('main.board')).toHaveAttribute('inert', '');
    await page.getByRole('searchbox').fill('不存在的真实查找词');
    await expect(page.getByRole('region', { name: '搜索结果' })).toContainText('无命中');
    await page.screenshot({ path: evidencePath('t15-search-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '搜索课程', exact: true })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('source result opens the fixed original page without creating an annotation, then returns to the prior source page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-source-ui-'));
  const { sourceFixture } = await import('./source-fixture');
  const { CourseService } = await import('../src/core/course-service');
  const path = join(root, 'source.pdf'); await sourceFixture(path, 'Search original evidence unique phrase');
  const core = new CourseService(resolve('dist/worker.cjs')); const c = await core.open(join(root, 'course'));
  const version = (await core.sources.importFile({ sessionId: c.sessionId, generation: 1, operationId: 'ui-original', path, title: '固定版本测试资料' })).version;
  await core.sources.saveContext({ sessionId: c.sessionId, generation: 1, seq: 1, state: { open: false, versionId: version.versionId, pdfPageIndex: 1, scale: 1.4, scrollTop: 10, scrollLeft: 0 } });
  await core.close();
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let sourcePage: Page | undefined;
  try {
    const page = await app.firstWindow(); sourcePage = page; await resizeBoardWindow(app, page);
    await page.context().setOffline(true);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('original evidence');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.locator('.source-panel canvas')).toBeVisible();
    await expect(page.locator('.source-panel [data-search-current="true"]')).toContainText('original evidence');
    const facts = await page.evaluate(async () => { const c = await window.yizhi.open(); return { citations: await window.yizhi.sources.citations({ sessionId: c.sessionId }), context: await window.yizhi.sources.context({ sessionId: c.sessionId }) }; });
    expect(facts.citations).toEqual([]);
    await page.screenshot({ path: evidencePath('t15-source-hit.png') });
    const returnScene = () => page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent === '返回搜索前位置')!;
      const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { viewport: [innerWidth, innerHeight], camera: (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform,
        focused: document.activeElement?.outerHTML.slice(0, 280), box: box.toJSON(), clear: hit === button || button.contains(hit), hit: hit?.outerHTML.slice(0, 280) };
    });
    const beforeClose = await returnScene();
    // Leave the original-page overlay before using the independent search return action.
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '原文资料', exact: true })).toBeHidden();
    const afterClose = await returnScene();
    expect(afterClose.camera).toBe(beforeClose.camera); expect(afterClose.clear).toBe(true);
    const scenePath = test.info().outputPath('source-return-scenes.json');
    await writeFile(scenePath, JSON.stringify({ beforeClose, afterClose }, null, 2));
    await test.info().attach('source-return-scenes', { path: scenePath, contentType: 'application/json' });
    await page.getByRole('button', { name: '返回搜索前位置' }).click();
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await expect(page.locator('.source-panel canvas')).toHaveAttribute('aria-label', '固定版本测试资料 · PDF 第 2 页');
  } catch (error) { if (sourcePage) await captureSearchFailure(sourcePage, 'source-search-return', error); throw error; }
  finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a changed or unreadable result is rejected, and exact original repair restores searchable source pages', async () => {
  const { sourceFixture } = await import('./source-fixture');
  const { CourseService } = await import('../src/core/course-service');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-repair-ui-')), path = join(root, 'original.pdf');
  await sourceFixture(path, 'Literal damaged original evidence');
  const core = new CourseService(resolve('dist/worker.cjs')), c = await core.open(join(root, 'course'));
  const prepared = await (async () => {
    try {
      const version = (await core.sources.importFile({ sessionId: c.sessionId, operationId: 'repair-source-ui', generation: 1, path, title: '待修复资料' })).version;
      // Fault a retained hit, after initial indexing has stopped refreshing it.
      let indexed = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
      for (let i = 0; indexed.pending && i < 100; i++) indexed = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
      expect(indexed.pending).toBe(0); expect(indexed.indexErrors).toEqual([]); expect(indexed.unreadable).toEqual([]);
      const result = await core.search.query({ sessionId: c.sessionId, query: 'damaged original' });
      expect(result.hits).toHaveLength(1); expect(result.hits[0].versionId).toBe(version.versionId);
      return { version, indexed, hit: result.hits[0] };
    } finally { await core.close(); }
  })();
  const { version } = prepared;
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let page: Page | undefined;
  const observations: unknown[] = [{ phase: 'prepared', ...prepared }];
  try {
    page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await expect.poll(() => page!.evaluate(async () => { const c=await window.yizhi.open();return (await window.yizhi.search.status({sessionId:c.sessionId})).pending; })).toBe(0);
    await expect(page.getByRole('button', { name: '重建索引', exact: true })).toHaveCount(0);
    await page.getByRole('searchbox').fill('damaged original');
    await expect(page.getByRole('button', { name: '定位命中' })).toBeVisible();
    const ready = await page.evaluate(async () => {
      const b = (window as any).yizhi, c = await b.open();
      return { status: await b.search.status({ sessionId: c.sessionId }), index: document.querySelector('[aria-label="搜索索引状态"]')?.textContent,
        hits: [...document.querySelectorAll('.search-result')].map(el => el.textContent) };
    });
    expect(ready.status.pending).toBe(0);
    observations.push({ phase: 'before-fault', ...ready });
    await writeFile(join(root, 'course/resources', version.sha256), 'damaged bytes');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.getByRole('alert')).toContainText('损坏');
    await page.getByText('未覆盖与不可读内容', { exact: true }).click();
    await expect(page.getByRole('button', { name: '从原件修复此版本' })).toBeVisible();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    await page.getByRole('button', { name: '从原件修复此版本' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.locator('.source-panel [data-search-current="true"]')).toContainText('damaged original');
  } catch (error) {
    if (page) {
      try {
        const domPath = test.info().outputPath('search-failure-dom.html'), scenePath = test.info().outputPath('search-failure-scene.json');
        await writeFile(domPath, await page.content());
        await page.screenshot({ path: test.info().outputPath('search-failure.png') });
        const state = await page.evaluate(async () => {
          const b = (window as any).yizhi, c = await b.open();
          return { viewport: [innerWidth, innerHeight], query: document.querySelector<HTMLInputElement>('input[type="search"]')?.value,
            index: document.querySelector('[aria-label="搜索索引状态"]')?.textContent, results: document.querySelector('.search-results')?.outerHTML,
            alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.textContent),
            statusBefore: await b.search.status({ sessionId: c.sessionId }), rawQuery: await b.search.query({ sessionId: c.sessionId, query: 'damaged original' }),
            statusAfter: await b.search.status({ sessionId: c.sessionId }) };
        });
        await writeFile(scenePath, JSON.stringify({ observations, state, error: String(error) }, null, 2));
        await test.info().attach('search-failure-scene', { path: scenePath, contentType: 'application/json' });
        await test.info().attach('search-failure-dom', { path: domPath, contentType: 'text/html' });
      } catch (captureError) { console.error('Search failure evidence capture:', captureError); }
    }
    throw error;
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
