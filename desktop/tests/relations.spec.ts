import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('formal relation editor rejects incomplete evidence, saves a reviewed correction and reopens via actual host IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-formal-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let window = await app.firstWindow();
    await window.getByRole('button', { name: '查看关系', exact: true }).click();
    const panel = window.getByLabel('关系详情');
    await expect(panel.getByText('个人箭头只作个人标注；正式关系在此独立审核。')).toBeVisible();
    await panel.getByRole('button', { name: '审核 REL-001', exact: true }).click();
    const value = panel.getByRole('textbox', { name: '具体信息价值' });
    await value.fill('');
    await panel.getByRole('button', { name: '保存正式关系', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('具体信息价值');
    await expect(value).toHaveValue('');
    await value.fill('副本审核：模与补数解释补码的表示依据，保留原有方向与来源。');
    await panel.getByLabel('正式关系显示').selectOption('auxiliary');
    await panel.getByRole('button', { name: '保存正式关系', exact: true }).click();
    await expect(panel.getByRole('status', { name: '正式关系结果' })).toContainText('已保存');
    await window.getByLabel('关系范围', { exact: true }).selectOption('auxiliary');
    await expect(panel.getByText('副本审核：模与补数解释补码的表示依据，保留原有方向与来源。', { exact: true })).toBeVisible();
    await window.getByLabel('关系范围', { exact: true }).selectOption('all');
    await expect(panel.getByText(/G1 · 任选一条/)).toBeVisible();
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t11-electron.png', fullPage: true });
    await app.close(); app = await launch(); window = await app.firstWindow();
    await window.getByRole('button', { name: '查看关系', exact: true }).click();
    await window.getByLabel('关系范围', { exact: true }).selectOption('auxiliary');
    await expect(window.getByLabel('关系详情').getByText('副本审核：模与补数解释补码的表示依据，保留原有方向与来源。', { exact: true })).toBeVisible();
    await window.getByLabel('关系详情').getByRole('button', { name: '审核 REL-001', exact: true }).click();
    await expect(window.getByRole('textbox', { name: '具体信息价值', exact: true })).toHaveValue('副本审核：模与补数解释补码的表示依据，保留原有方向与来源。');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('formal add/remove and stale-basis reconciliation use the same real IPC route; narrow overlay keeps keyboard ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-formal-add-ui-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '查看关系', exact: true }).click();
    const panel = window.getByLabel('关系详情');
    await panel.getByRole('button', { name: '新增正式关系', exact: true }).click();
    await panel.getByRole('combobox', { name: '起点单元', exact: true }).fill('KU-001');
    await panel.getByRole('combobox', { name: '终点单元', exact: true }).fill('KU-004');
    await panel.getByRole('textbox', { name: '具体信息价值', exact: true }).fill('临时副本的公开接口验证候选，不作为课程知识事实。');
    await panel.getByRole('button', { name: '添加来源', exact: true }).click();
    await panel.getByRole('combobox', { name: '来源 1', exact: true }).selectOption('SRC-C01');
    await panel.getByRole('textbox', { name: 'PDF 页码 1', exact: true }).fill('3');
    // A second writer changes an independent formal fact after the form captured its graph basis.
    await window.evaluate(async () => {
      const api = (window as any).yizhi, course = await api.open(), basis = await api.relations.read({ sessionId: course.sessionId });
      const edge = basis.graph.edges.find((e: any) => e.id === 'REL-001');
      await api.relations.commit({ sessionId: course.sessionId, basisId: basis.basisId, generation: basis.generation,
        operationId: 'external-review', changes: [{ id: edge.id, value: { ...edge, value: edge.value + '（并发副本审核）' } }] });
    });
    await panel.getByRole('button', { name: '保存正式关系', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('依据已变化');
    await expect(panel.getByRole('textbox', { name: '具体信息价值', exact: true })).toHaveValue('临时副本的公开接口验证候选，不作为课程知识事实。');
    await panel.getByRole('button', { name: '重新读取依据', exact: true }).click();
    await expect(panel.getByRole('status', { name: '正式关系结果' })).toContainText('依据已更新');
    await panel.getByRole('button', { name: '保存正式关系', exact: true }).click();
    await expect(panel.getByRole('status', { name: '正式关系结果' })).toContainText('已保存');
    const fact = panel.locator('.relation-fact').filter({ hasText: '临时副本的公开接口验证候选，不作为课程知识事实。' });
    await fact.getByRole('button', { name: /^审核 REL-/ }).click();
    await panel.getByRole('button', { name: '移除此正式关系', exact: true }).click();
    await expect(panel.getByRole('status', { name: '正式关系结果' })).toContainText('已移除');
    await expect(fact).toHaveCount(0);
    await window.setViewportSize({ width: 700, height: 600 });
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await panel.getByRole('button', { name: '新增正式关系', exact: true }).click();
    await panel.getByRole('button', { name: '添加来源', exact: true }).click();
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t11-narrow-electron.png', fullPage: true });
    await window.keyboard.press('Escape');
    await expect(window.getByRole('button', { name: '查看关系', exact: true })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
