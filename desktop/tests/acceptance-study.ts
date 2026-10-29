import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import type { CourseGraph, OpenedCourse } from '../src/shared';
import { AcceptanceMetrics } from './acceptance-metrics';
import { exerciseDirtyIndex, exerciseHistoryPreview, exerciseParserPreparation, flattenBlocks, prepareLongHistory, type StudyAPI } from './acceptance-workload';
import { parsingFixture } from './parsing-fixture';
import { readCameraTransform, revealBoardControl, expectBoundedReading } from './board-test-helpers';

export function studyAPI(page: Page, other?: { page: Page; sessionId: string }): StudyAPI {
  const call = (path: string[], args: unknown[]) => {
    const sessionId = typeof args[0] === 'string' ? args[0] : (args[0] as { sessionId?: string })?.sessionId;
    const target = other && sessionId === other.sessionId ? other.page : page;
    return target.evaluate(async ({ path, args }) => {
    let owner = (window as any).yizhi; for (const name of path.slice(0, -1)) owner = owner[name];
    return owner[path.at(-1)!](...args);
    }, { path, args });
  };
  const branch = (name: string, methods: string[]) => Object.fromEntries(methods.map(method => [method, (request: unknown) => call([name, method], [request])]));
  return { read: (sessionId: string, unitId?: string) => call(['read'], [sessionId, unitId]), commitEdit: (request: import('../src/shared').EditCommand) => call(['commitEdit'], [request]),
    search: branch('search', ['rebuild', 'status', 'query', 'locate']),
    formalHistory: branch('formalHistory', ['list', 'detail', 'preview', 'release', 'query', 'apply']),
    parsing: branch('parsing', ['start', 'get', 'list', 'stop']) } as unknown as StudyAPI;
}
export async function chooseSecondCourse(app: ElectronApplication, directory: string) {
  const opened = app.waitForEvent('window');
  await app.evaluate(({ dialog, Menu }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    Menu.getApplicationMenu()!.items.find(item => item.label === '课程')!.submenu!.items[0].click(undefined, undefined, undefined);
  }, directory);
  const page = await opened; await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false'); return page;
}
export async function navigateUnit(page: Page, graph: CourseGraph, id: string) {
  const node = graph.nodes.find(node => node.id === id)!;
  if (!node) throw new Error('Unknown navigation unit: ' + id);
  if (await page.getByRole('button', { name: '展开目录', exact: true }).count()) await page.getByRole('button', { name: '展开目录', exact: true }).click();
  const button = page.getByRole('button', { name: node.name, exact: true }).first();
  if (!await button.count()) await page.getByRole('button', { name: graph.groups.find(group => group.id === node.themeId)!.name, exact: true }).first().click();
  await button.click();
  await expect(page.locator(`article[data-unit-id="${id}"][data-reading-active="true"]`)).toHaveCount(1);
  await expect(page.locator(`article[data-unit-id="${id}"] .tiptap.ProseMirror`)).toHaveCount(1);
}

export interface SavedTargetFixture { conversationId: string; results: Array<{ unitId: string; marker: string; taskId: string }> }
export async function exerciseTargetDisplays(page: Page, fixture: SavedTargetFixture, metrics: AcceptanceMetrics) {
  await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
  await page.getByRole('combobox', { name: '学习对话列表', exact: true }).selectOption(fixture.conversationId);
  const buttons = page.getByRole('button', { name: '查看实际修改', exact: true }); await expect(buttons).toHaveCount(fixture.results.length);
  const displays = [];
  for (let index = 0; index < fixture.results.length; index++) {
    const result = fixture.results[index]; await buttons.nth(index).click();
    const article = page.locator(`article[data-unit-id="${result.unitId}"][data-reading-active=true]`);
    await expect(article).toHaveCount(1); await expect(article).toContainText(result.marker);
    const layers = await expectBoundedReading(page);
    await metrics.sample(`saved-target:${index + 1}`); displays.push({ unitId: result.unitId, taskId: result.taskId, layers });
  }
  await page.getByRole('button', { name: '收起对话', exact: true }).click();
  return { producer: 'synthetic public Core commits; no model or executor', displays };
}

/** Identical public/UI scenarios in a small preparation run and the gated final installed run. */
export async function runStudyAcceptance(app: ElectronApplication, page: Page, metrics: AcceptanceMetrics, options: {
  runDirectory: string; evidenceDirectory: string; secondCourseDirectory: string; final: boolean; historyGroups: number; targetResults?: SavedTargetFixture;
}) {
  let api = studyAPI(page);
  const opened: OpenedCourse = await page.evaluate(() => (window as any).yizhi.open());
  const graph: CourseGraph = await page.evaluate(sessionId => (window as any).yizhi.graph(sessionId), opened.sessionId);
  if (options.final) expect(graph.nodes).toHaveLength(500);
  const ids = options.final ? graph.nodes.map(node => node.id) : ['KU-001', 'KU-002', 'KU-004', 'KU-055', 'KU-035', 'KU-001'];
  const editableId = options.final ? graph.nodes.find(node => node.id.startsWith('KU-LOAD-'))!.id : 'KU-001';
  const beforeCore = await app.evaluate(() => (globalThis as any).__yizhiAcceptance.core());
  const second = await chooseSecondCourse(app, options.secondCourseDirectory);
  await metrics.attach(second, 'B');
  const b: OpenedCourse = await second.evaluate(() => (window as any).yizhi.open());
  const secondGraph = await second.evaluate(sessionId => (window as any).yizhi.graph(sessionId), b.sessionId);
  await navigateUnit(second, secondGraph, b.unit.id);
  api = studyAPI(page, { page: second, sessionId: b.sessionId });
  expect(b.courseId).not.toBe(opened.courseId);
  const sharedCore = await app.evaluate(() => (globalThis as any).__yizhiAcceptance.core());
  expect(sharedCore.instanceId).toBe(beforeCore.instanceId); expect(sharedCore.threadId).toBe(beforeCore.threadId);
  expect(new Set(sharedCore.courseIds)).toEqual(new Set([opened.courseId, b.courseId]));
  await page.bringToFront();
  let disclosures = 0;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    await metrics.time(`navigation:${id}`, () => navigateUnit(page, graph, id));
    await expectBoundedReading(page);
    const summary = page.locator(`article[data-unit-id="${id}"] details > summary`).first();
    if (index % 25 === 0 && await summary.count()) {
      await revealBoardControl(page, summary); await summary.click(); disclosures++;
      await metrics.sample(`disclosure:${id}`);
      await revealBoardControl(page, summary); await summary.click();
    }
    if (index % 25 === 0 || index + 1 === ids.length) await metrics.sample(`navigation:${index + 1}/${ids.length}`);
  }
  const targetDisplays = options.targetResults ? await exerciseTargetDisplays(page, options.targetResults, metrics) : { status: 'not exercised in this preparation' };
  await navigateUnit(page, graph, editableId);
  let a = await api.read(opened.sessionId, editableId);
  const history = await prepareLongHistory(api, a, options.historyGroups);
  const historyOverlap = await exerciseHistoryPreview(api, a, b, history.anchorOperationId);
  await expect(second.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText(historyOverlap.progress.savedText);
  await metrics.sample('history-preview-and-B-save');
  const indexOverlap = await exerciseDirtyIndex(api, a, b);
  await expect(second.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText(indexOverlap.progress.savedText);
  await metrics.sample('dirty-index-and-B-save');
  const sourcePath = join(options.runDirectory, 'synthetic-parser-overlap.pdf'); await parsingFixture(sourcePath, 1);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, sourcePath);
  await page.getByRole('button', { name: '原文资料', exact: true }).click();
  const originals = await page.evaluate(sessionId => (window as any).yizhi.sources.list({ sessionId }), opened.sessionId);
  const originalPages: string[] = [];
  for (const version of originals.versions) {
    await page.getByRole('combobox', { name: '资料版本', exact: true }).selectOption(version.versionId);
    await page.getByRole('spinbutton', { name: 'PDF 页序', exact: true }).fill('1');
    await expect(page.getByRole('status', { name: '原文状态', exact: true })).toHaveText('原页已载入');
    originalPages.push(version.versionId); await metrics.sample(`offline-original:${version.versionId}`);
  }
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await expect(page.getByRole('status', { name: '原文状态', exact: true })).toHaveText('原页已载入');
  const sources = await page.evaluate(sessionId => (window as any).yizhi.sources.list({ sessionId }), opened.sessionId);
  const syntheticSource = sources.versions.find((version: any) => version.title.includes('synthetic-parser-overlap'));
  if (!syntheticSource) throw new Error('Actual synthetic parser PDF was not imported');
  await metrics.sample('pdf-first-page');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('status', { name: '原文状态', exact: true })).toHaveText('原页已载入');
  await metrics.sample('pdf-next-page');
  await page.getByRole('button', { name: '返回画板', exact: true }).click();
  const parserOverlap = await exerciseParserPreparation(api, a, b, syntheticSource.versionId);
  await expect(second.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText(parserOverlap.progress.savedText);
  await metrics.sample('parser-preparation-and-B-save');
  // Actual running/pause/resume uses the copied course's own experiment, with no replacement runtime.
  const experimentUnit = graph.nodes.find(node => node.id === 'KU-055');
  if (!experimentUnit) throw new Error('Acceptance input needs the delivered MUX experiment');
  await navigateUnit(page, graph, experimentUnit.id);
  const experimentBody = await api.read(opened.sessionId, experimentUnit.id);
  const experimentBlock = flattenBlocks(experimentBody.unit.reading.blocks).find(block => block.kind === 'interactive')!;
  const experimentRequest = { sessionId: opened.sessionId, instanceId: `${experimentUnit.id}/${experimentBlock.id}` };
  const experimentState = () => page.evaluate(request => (window as any).yizhi.experiments.read(request), experimentRequest);
  const region = page.locator(`article[data-unit-id="${experimentUnit.id}"] .builtin-experiment`);
  const startExperiment = region.getByRole('button', { name: '开始遍历输入', exact: true });
  await revealBoardControl(page, startExperiment); await startExperiment.click();
  await expect.poll(async () => (await experimentState()).state.step).toBeGreaterThan(0);
  const runningExperiment = await experimentState(); await metrics.sample('experiment-running');
  await navigateUnit(page, graph, editableId);
  await expect.poll(async () => (await experimentState()).phase).toBe('paused');
  const pausedExperiment = await experimentState(); await metrics.sample('experiment-paused-offscreen');
  expect(pausedExperiment.state.step).toBeGreaterThanOrEqual(runningExperiment.state.step);
  await navigateUnit(page, graph, experimentUnit.id);
  const experimentStatus = region.getByRole('status', { name: '实验运行状态', exact: true });
  await revealBoardControl(page, experimentStatus);
  await expect.poll(async () => (await experimentState()).state.step).toBeGreaterThan(pausedExperiment.state.step);
  const resumedExperiment = await experimentState();
  await region.getByRole('button', { name: '暂停遍历', exact: true }).click();
  let extensionEvidence: unknown = { status: 'not part of this migrated course', exercised: false };
  if (!opened.contentScope) {
  await navigateUnit(page, graph, 'KU-001');
  const extensionButton = page.locator('article[data-unit-id="KU-001"]').getByRole('button', { name: '奇偶校验扩展实验', exact: true });
  await revealBoardControl(page, extensionButton); await extensionButton.click();
  const extension = page.getByRole('region', { name: '奇偶校验扩展实验', exact: true });
  await expect(extension.getByRole('status', { name: '扩展保存状态', exact: true })).toHaveText('现场已保存');
  const extensionState = () => page.evaluate(sessionId => (window as any).yizhi.extensions.read({ sessionId }), opened.sessionId);
  const startExtension = extension.getByRole('button', { name: '开始模拟', exact: true });
  await revealBoardControl(page, startExtension); await startExtension.click();
  await expect.poll(async () => (await extensionState()).state.step).toBeGreaterThan(0);
  const extensionRunning = await extensionState(); await metrics.sample('extension-worker-running');
  // KU-001 is the normal pinned reading object; the extension stays mounted but must actually pause.
  await navigateUnit(page, graph, editableId);
  if (editableId === 'KU-001') await navigateUnit(page, graph, 'KU-002');
  await expect.poll(async () => (await extensionState()).phase).toBe('paused');
  const extensionPaused = await extensionState(); await metrics.sample('extension-paused-offscreen');
  await navigateUnit(page, graph, 'KU-001');
  await revealBoardControl(page, extension.getByRole('status', { name: '扩展保存状态', exact: true }));
  await expect.poll(async () => (await extensionState()).state.step).toBeGreaterThan(extensionPaused.state.step);
  const extensionResumed = await extensionState();
  const stopExtension = extension.getByRole('button', { name: '暂停模拟', exact: true }); await revealBoardControl(page, stopExtension); await stopExtension.click();
  await revealBoardControl(page, extensionButton); await extensionButton.click();
  extensionEvidence = { exercised: true, running: extensionRunning, paused: extensionPaused, resumed: extensionResumed };
  }
  await navigateUnit(page, graph, editableId);
  // Actual trusted editor input/selection plus an independent formal update; no synthetic IME events.
  const editor = page.locator(`article[data-unit-id="${editableId}"] .tiptap.ProseMirror`);
  a = await api.read(opened.sessionId, editableId);
  const firstParagraph = flattenBlocks(a.unit.reading.blocks).find(block => block.kind === 'paragraph')!;
  const textMarker = ' T28 programmatic latest input';
  await editor.evaluate((element: any) => { element.editor.commands.setTextSelection(2); element.editor.view.focus(); });
  await metrics.time('programmatic-input', () => page.keyboard.insertText(textMarker));
  await metrics.time('save-ack', async () => {
    await expect.poll(async () => String(flattenBlocks((await api.read(opened.sessionId, editableId)).unit.reading.blocks).find(block => block.id === firstParagraph.id)?.payload.text)).toContain(textMarker);
  });
  await editor.evaluate((element: any) => { element.editor.commands.setTextSelection({ from: 2, to: 5 }); element.editor.view.focus(); (window as any).__t28Editor = element; });
  const selection = await page.evaluate(() => getSelection()!.toString());
  const update = await page.evaluate(async ({ sessionId, unitId, protectedId }) => {
    const api = (window as any).yizhi, current = await api.read(sessionId, unitId);
    const target = current.unit.reading.blocks.find((block: any) => block.kind === 'paragraph' && block.id !== protectedId);
    if (!target) throw new Error('Fixture needs an independent paragraph for a real background update');
    const attempt = await api.commands.startAttempt({ sessionId, taskId: crypto.randomUUID() });
    const basis = await api.commands.read({ sessionId, unitId, attemptId: attempt.attemptId, objectIds: [target.id] });
    const object = basis.objects.find((object: any) => object.id === target.id), operationId = crypto.randomUUID();
    const receipt = await api.commands.commit({ sessionId, unitId, attemptId: attempt.attemptId, operationId, basisId: basis.basisId,
      changes: [{ objectId: target.id, value: { ...object.value, payload: { ...object.value.payload, text: object.value.payload.text + ' [synthetic controlled background update]' } } }] });
    return { receipt, taskId: attempt.taskId, attemptId: attempt.attemptId, targetId: target.id };
  }, { sessionId: opened.sessionId, unitId: editableId, protectedId: firstParagraph.id });
  expect(update.receipt.status).toBe('committed');
  await expect.poll(() => editor.evaluate((element: any) => element.editor.storage.courseSelection.capture().latestFormalRevision)).toBe(update.receipt.revision);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(selection);
  expect(await editor.evaluate(element => element === (window as any).__t28Editor)).toBe(true);
  await page.evaluate(async ({ sessionId, attemptId }) => (window as any).yizhi.commands.stop({ sessionId, attemptId }), { sessionId: opened.sessionId, attemptId: update.attemptId });
  await page.getByRole('button', { name: '收起目录', exact: true }).click();
  const formulaButton = editor.locator('.editor-formula').first().getByRole('button', { name: '编辑公式', exact: true });
  await revealBoardControl(page, formulaButton); await formulaButton.click();
  const formula = editor.locator('math-field').first();
  const originalFormula = await formula.evaluate((element: any) => element.getValue('latex'));
  await formula.evaluate((element: any) => { element.executeCommand('selectAll'); element.executeCommand(['insert', 'x+1']); });
  await expect.poll(() => formula.evaluate((element: any) => element.getValue('latex'))).toBe('x+1');
  await page.keyboard.press('Meta+z');
  await expect.poll(() => formula.evaluate((element: any) => element.getValue('latex'))).toBe(originalFormula);
  await editor.locator('.editor-formula').first().getByRole('button', { name: '返回正文', exact: true }).click();
  await editor.evaluate((element: any) => { element.editor.commands.setTextSelection(2); element.editor.view.focus(); });
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => String(flattenBlocks((await api.read(opened.sessionId, editableId)).unit.reading.blocks).find(block => block.id === firstParagraph.id)?.payload.text)).not.toContain(textMarker);
  expect(JSON.stringify((await api.read(opened.sessionId, editableId)).unit)).toContain('[synthetic controlled background update]');
  await editor.evaluate((element: any) => { element.editor.commands.setTextSelection(2); element.editor.view.focus(); });
  await page.keyboard.insertText(textMarker);
  await formulaButton.click();
  await formula.evaluate((element: any) => { element.executeCommand('selectAll'); element.executeCommand(['insert', '\\frac{1}{#?}']); });
  await expect.poll(async () => (await api.read(opened.sessionId, editableId)).drafts.some(draft => draft.input.formulaDrafts?.length)).toBe(true);
  await metrics.sample('incomplete-MathLive-draft');
  const savedDraft = await api.read(opened.sessionId, editableId);
  await navigateUnit(page, graph, ids.find(id => id !== editableId)!);
  await navigateUnit(page, graph, editableId);
  expect((await api.read(opened.sessionId, editableId)).drafts.some(draft => draft.input.formulaDrafts?.length)).toBe(true);
  await metrics.sample('draft-returned');
  const wideDirectoryClose = page.getByRole('button', { name: '收起目录', exact: true });
  if (await wideDirectoryClose.count()) await wideDirectoryClose.click();
  const windowHandle = await app.browserWindow(page);
  const narrowSize = await windowHandle.evaluate(window => { window.setSize(700, 700); return window.getContentSize(); });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(narrowSize);
  const directoryModalClose = page.getByRole('button', { name: '关闭目录', exact: true });
  if (await directoryModalClose.count()) await directoryModalClose.click();
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('status', { name: '阅读状态', exact: true })).toHaveText('阅读位置已保存');
  // A navigation/focus scroll can precede its queued reading-state receipt.
  // The shared observer reads exact Typed OM components, without string/matrix loss.
  await expect.poll(async () => {
    const saved = await page.evaluate(sessionId => (window as any).yizhi.readingState(sessionId), opened.sessionId);
    const viewport = await readCameraTransform(page.locator('.react-flow__viewport'));
    return !!saved?.camera && saved.camera.x === viewport.x && saved.camera.y === viewport.y && saved.camera.zoom === viewport.zoom;
  }).toBe(true);
  const readingBeforePanels = await page.evaluate(sessionId => (window as any).yizhi.readingState(sessionId), opened.sessionId);
  const panelTrace = [{ phase: 'before', state: readingBeforePanels }];
  const panelSample = async (phase: string) => { panelTrace.push({ phase, state: await page.evaluate(sessionId => (window as any).yizhi.readingState(sessionId), opened.sessionId) }); await metrics.sample(`panel:${phase}`); };
  const agentButton = page.getByRole('button', { name: 'Agent · 学习对话', exact: true });
  await agentButton.focus(); await expect(agentButton).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: '学习对话草稿', exact: true })).toBeFocused();
  await panelSample('agent-open');
  await expect(page.getByText(/生成暂不可用/)).toBeVisible();
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  const closeAgent = page.getByRole('button', { name: '收起对话', exact: true });
  await closeAgent.focus(); await page.keyboard.press('Shift+Tab');
  await panelSample('agent-tab-wrap');
  expect(await page.getByRole('dialog', { name: 'Agent 学习对话', exact: true }).evaluate(element => element.contains(document.activeElement))).toBe(true);
  await closeAgent.focus(); await page.keyboard.press('Enter');
  await expect(agentButton).toBeFocused();
  await panelSample('agent-closed');
  const sourceButton = page.getByRole('button', { name: '原文资料', exact: true }); await sourceButton.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '原文资料', exact: true })).toBeVisible();
  await panelSample('source-open');
  await page.keyboard.press('Escape'); await expect(sourceButton).toBeFocused();
  await panelSample('source-closed');
  await expect(page.getByRole('status', { name: '阅读状态', exact: true })).toHaveText('阅读位置已保存');
  const readingAfterPanels = await page.evaluate(sessionId => (window as any).yizhi.readingState(sessionId), opened.sessionId);
  expect(readingAfterPanels).toEqual(readingBeforePanels);
  const accessibility = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, emulatedReducedMotion: true,
    transition: getComputedStyle(document.querySelector('button')!).transitionDuration, fonts: getComputedStyle(document.body).fontFamily,
    readableStatusText: [...document.querySelectorAll('[role=status]')].map(node => node.textContent),
    fontResources: performance.getEntriesByType('resource').filter(entry => /\.(woff2?|ttf)(\?|$)/.test(entry.name)).map(entry => entry.name) }));
  expect(accessibility.reducedMotion).toBe(true);
  await metrics.sample('narrow-keyboard-reduced-motion');
  await page.screenshot({ path: join(options.evidenceDirectory, 'narrow-keyboard-reduced-motion.png') });
  return { graphUnits: graph.nodes.length, navigated: ids.length, disclosures, editableId, courseId: opened.courseId, secondCourseId: b.courseId,
    sharedCore: { instanceId: sharedCore.instanceId, threadId: sharedCore.threadId }, history, historyOverlap, indexOverlap, parserOverlap,
    originalPages, update, targetDisplays, textMarker, savedDraftInputSeq: savedDraft.drafts.at(-1)?.input.inputSeq,
    experiment: { running: runningExperiment, paused: pausedExperiment, resumed: resumedExperiment },
    extension: extensionEvidence,
    programmaticUndo: { formula: true, body: true, independentUpdatePreserved: true }, accessibility,
    panelReadingState: { before: readingBeforePanels, after: readingAfterPanels, trace: panelTrace },
    physical: { mouse: 'pending', trackpad: 'pending', doubaoIME: 'pending' }, limitations: ['Controlled producer update is not an actual model call.'] };
}
