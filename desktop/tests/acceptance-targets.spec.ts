import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { prepareTargetResults } from './acceptance-targets-prepare';
import { AcceptanceMetrics } from './acceptance-metrics';
import { navigateUnit } from './acceptance-study';
import { resizeBoardWindow } from './board-test-helpers';

test('T28 opt-in result display releases previous heavy reading surfaces across distinct saved controlled targets', async () => {
  test.skip(process.env.YIZHI_ACCEPTANCE_SMOKE !== '1', 'Small generated-fixture preparation only; no model.');
  if (!process.env.YIZHI_EVIDENCE_DIR) throw new Error('Use persistent scratch evidence');
  const evidence = join(process.env.YIZHI_EVIDENCE_DIR, `targets-${Date.now()}`); await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'yizhi-result-targets-')), course = join(root, 'course');
  const core = new CourseService(resolve('dist/worker.cjs'));
  let fixture;
  try { fixture = await prepareTargetResults(core, course, ['KU-001', 'KU-002', 'KU-004', 'KU-005']); } finally { await core.close(); }
  await writeFile(join(evidence, 'public-result-fixture.json'), JSON.stringify(fixture, null, 2));
  const app = await electron.launch({ args: [resolve('.'), `--course=${course}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_OBSERVE: '1', YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  const metrics = new AcceptanceMetrics(app, evidence, { scope: 'small saved-result display, no executor/model' });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page); await metrics.attach(page, 'A');
    const graph = await page.evaluate(async () => { const api = (window as any).yizhi, c = await api.open(); return api.graph(c.sessionId); });
    await navigateUnit(page, graph, 'KU-001');
    await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
    const buttons = page.getByRole('button', { name: '查看实际修改', exact: true }); await expect(buttons).toHaveCount(fixture.results.length);
    for (let index = 0; index < fixture.results.length; index++) {
      await buttons.nth(index).click();
      await expect(page.locator(`article[data-unit-id="${fixture.results[index].unitId}"][data-reading-active=true]`)).toHaveCount(1);
      await metrics.sample(`saved-target:${index + 1}`);
      expect(await page.locator('.reading-layer').count()).toBeLessThanOrEqual(2);
    }
    await metrics.write('measurement.json', { fixture, automatedStatus: 'small harness passed', physicalStatus: 'not exercised' });
  } catch (error) { await metrics.sample('failure').catch(() => {}); await metrics.write('failure.json', { error: String(error), fixture }); throw error;
  } finally { await metrics.stop(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
