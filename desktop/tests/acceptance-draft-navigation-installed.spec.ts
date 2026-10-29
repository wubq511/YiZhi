import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateFinalInput } from './acceptance-input';
import { navigateUnit } from './acceptance-study';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('T28 installed navigation restores the existing durable body draft beside an unfinished formula', async () => {
  test.skip(!process.env.YIZHI_DRAFT_NAVIGATION_INPUT, 'Bound corrected app and isolated copy of the existing 500 course; no repeated growth workload.');
  test.setTimeout(90000);
  const input = JSON.parse(await readFile(process.env.YIZHI_DRAFT_NAVIGATION_INPUT!, 'utf8')); validateFinalInput(input);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const bytes = await readFile(join(input.app, 'Contents/Resources/app/package-manifest.json'));
  const manifest = JSON.parse(bytes.toString());
  expect(manifest.source).toEqual({ commit: input.sourceSHA, dirty: false });
  expect(hash(bytes)).toBe(input.appManifestSha256);
  expect(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(input.sourceSHA);
  expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  for (const entry of manifest.runtimeFiles) expect(hash(await readFile(join(input.app, 'Contents/Resources/app', entry.path)))).toBe(entry.sha256);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', input.app]);
  const empty = join(input.evidenceDirectory, 'empty'); await mkdir(empty, { recursive: true });
  const launch = () => electron.launch({ executablePath: join(input.app, 'Contents/MacOS/YiZhi'), cwd: empty,
    args: [`--course=${input.courseDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: '', NODE_OPTIONS: '', YIZHI_OBSERVE: '1',
      YIZHI_DATA_HOME: input.profileDirectory, YIZHI_CODEX_PATH: join(input.evidenceDirectory, 'missing-executor') } });
  let app = await launch(), page: Page | undefined;
  const checkpoints: unknown[] = [];
  try {
    page = await app.firstWindow(); await page.context().setOffline(true); await resizeBoardWindow(app, page);
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath, versions: process.versions }));
    expect(runtime.packaged).toBe(true); expect(runtime.appPath).toBe(join(input.app, 'Contents/Resources/app'));
    expect(runtime.executable).toBe(join(input.app, 'Contents/MacOS/YiZhi'));
    let opened = await page.evaluate(() => (window as any).yizhi.open());
    let graph = await page.evaluate(id => (window as any).yizhi.graph(id), opened.sessionId);
    expect(graph.nodes).toHaveLength(500);
    const unitId = input.editableUnitId;
    expect(unitId).toBe('KU-LOAD-0001');
    await navigateUnit(page, graph, unitId);
    const baseline = await page.evaluate(async ({ sessionId, unitId }) => (window as any).yizhi.read(sessionId, unitId), { sessionId: opened.sessionId, unitId });
    const draft = baseline.drafts.find((d: any) => d.input.patch?.updates.some((u: any) => u.blockId === 'RB-LOAD-0001-0001'));
    expect(draft).toBeTruthy(); expect(draft.input.complete).toBe(false);
    expect(draft.input.baseRevision).toBeLessThan(baseline.revision);
    const update = draft.input.patch.updates.find((u: any) => u.blockId === 'RB-LOAD-0001-0001');
    expect(update.after.text).toContain('english');
    expect(draft.input.formulaDrafts).toHaveLength(1);
    const formulaDraft = draft.input.formulaDrafts[0]; expect(formulaDraft.latex).toContain('placeholder');
    const independent = baseline.unit.reading.blocks.find((b: any) => b.id === 'RB-LOAD-0001-0003');
    expect(independent.payload.text).toContain('[physical-session controlled independent update]');
    const formalFormula = baseline.unit.reading.blocks.find((b: any) => b.id === formulaDraft.blockId);
    const inspect = async (label: string) => {
      const article = page!.locator(`article[data-unit-id="${unitId}"][data-reading-active="true"]`);
      const body = article.locator(`.tiptap p[data-block-id="${update.blockId}"]`);
      await expect(body).toHaveText(update.after.text);
      await expect(article.locator(`.tiptap p[data-block-id="${independent.id}"]`)).toHaveText(independent.payload.text);
      const formula = article.locator(`.editor-formula[data-block-id="${formulaDraft.blockId}"]`);
      await expect(formula.getByRole('math')).toHaveAttribute('aria-label', formalFormula.payload.latex);
      await expect(formula).toContainText('未完成公式 · 草稿已保留，正式公式保持原值');
      const edit = formula.getByRole('button', { name: '编辑公式', exact: true });
      await revealBoardControl(page!, edit); await edit.click();
      await expect.poll(() => formula.locator('math-field').evaluate((field: any) => field.value)).toBe(formulaDraft.latex);
      const leave = formula.getByRole('button', { name: '返回正文', exact: true });
      await revealBoardControl(page!, leave); await leave.click();
      const snapshot = await page!.evaluate(async unitId => { const api = (window as any).yizhi, course = await api.open(); return api.read(course.sessionId, unitId); }, unitId);
      expect(snapshot.unit).toEqual(baseline.unit);
      const retained = snapshot.drafts.find((d: any) => d.input.patch?.updates.some((u: any) => u.blockId === update.blockId));
      expect(retained.input.patch).toEqual(draft.input.patch);
      expect(retained.input.formulaDrafts).toEqual(draft.input.formulaDrafts);
      await expect(body).toHaveText(update.after.text);
      checkpoints.push({ label, unitRevision: snapshot.revision, bodyText: await body.textContent(), formalFormula: formalFormula.payload.latex,
        formulaDrafts: retained.input.formulaDrafts, formalUnchanged: true, durablePatchUnchanged: true });
      await page!.screenshot({ path: test.info().outputPath(`${label}.png`) });
    };
    await inspect('initial-existing-draft');
    await navigateUnit(page, graph, 'KU-LOAD-0002'); await navigateUnit(page, graph, unitId); await inspect('navigation-return');
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.context().setOffline(true); await resizeBoardWindow(app, page);
    opened = await page.evaluate(() => (window as any).yizhi.open());
    graph = await page.evaluate(id => (window as any).yizhi.graph(id), opened.sessionId);
    await navigateUnit(page, graph, unitId); await inspect('normal-reopen');
    await writeFile(join(input.evidenceDirectory, 'affected-installed.json'), JSON.stringify({ input, runtime, checkpoints,
      scope: 'existing500 copy navigation and normal reopen of actual durable bad body/formula draft; no new growth/model/input/physical pass' }, null, 2) + '\n');
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('draft-navigation-failure.png') }).catch(() => {});
      await writeFile(test.info().outputPath('draft-navigation-failure.json'), JSON.stringify({ error: String(error), input, checkpoints }, null, 2) + '\n');
    }
    throw error;
  } finally { await app.close(); }
});
