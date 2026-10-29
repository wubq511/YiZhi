import { test, expect, _electron as electron } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcceptanceMetrics } from './acceptance-metrics';
import { resizeBoardWindow } from './board-test-helpers';
import { runStudyAcceptance } from './acceptance-study';
import { validateFinalInput } from './acceptance-input';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CourseService } from '../src/core/course-service';
import { prepareTargetResults } from './acceptance-targets-prepare';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function originalRecords(directory: string) {
  const db = new DatabaseSync(join(directory, 'course.sqlite'), { readOnly: true });
  const tables: Record<string, Record<string, string>> = {};
  try {
    for (const name of ['migration_origins', 'migration_pending', 'migration_receipts', 'migration_values', 'restore_timeline',
      'annotation_heads', 'personal_notes', 'agent_conversations', 'agent_tasks', 'agent_messages', 'agent_unthreaded_messages', 'source_versions', 'source_citations', 'source_intents']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) continue;
      const keys = db.prepare(`PRAGMA table_info("${name}")`).all().filter(column => Number(column.pk)).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
      const rows = db.prepare(`SELECT ${keys.length ? '' : 'rowid AS t28RowId,'}* FROM "${name}"`).all();
      tables[name] = Object.fromEntries(rows.map(row => [JSON.stringify(keys.length ? keys.map(key => row[key]) : row.t28RowId), digest(JSON.stringify(row))]));
    }
    const checkpoints = db.prepare("SELECT value FROM metadata WHERE key='legacy-checkpoint-facts'").get();
    if (checkpoints) tables['metadata/legacy-checkpoint-facts'] = { value: digest(String(checkpoints.value)) };
  } finally { db.close(); }
  return tables;
}

test('T28 opt-in small development harness records real counters and timings without claiming final acceptance', async () => {
  test.skip(process.env.YIZHI_ACCEPTANCE_SMOKE !== '1', 'Explicit small-sample harness opt-in only.');
  test.setTimeout(120000);
  if (!process.env.YIZHI_EVIDENCE_DIR) throw new Error('YIZHI_EVIDENCE_DIR must be a persistent scratch directory');
  const evidence = join(process.env.YIZHI_EVIDENCE_DIR, `smoke-${Date.now()}`);
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t28-harness-'));
  const preparation = new CourseService(resolve('dist/worker.cjs'));
  let targetResults;
  try { targetResults = await prepareTargetResults(preparation, join(root, 'course'), ['KU-001', 'KU-002', 'KU-004', 'KU-005']); } finally { await preparation.close(); }
  await writeFile(join(evidence, 'controlled-result-fixture.json'), JSON.stringify(targetResults, null, 2) + '\n');
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  const metrics = new AcceptanceMetrics(app, evidence, { scope: 'small development fixture, not final T28', physicalInput: 'not exercised' });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await metrics.attach(page, 'A');
    const study = await runStudyAcceptance(app, page, metrics, { runDirectory: root, evidenceDirectory: evidence, secondCourseDirectory: join(root, 'second'), final: false, historyGroups: 12, targetResults });
    await metrics.sample('settled');
    const value = await metrics.write('small-harness.json', { study });
    expect(value.checkpoints.length).toBeGreaterThan(0);
    expect(value.checkpoints[0].core.courseIds).toHaveLength(2);
    expect(value.checkpoints[0].renderers[0].internal['measurement.callbacks'].count).toBeGreaterThan(0);
    expect(value.checkpoints[0].renderers[0].internal['reading.surfaces'].peak).toBeGreaterThan(0);
  } catch (error) { await metrics.sample('failure').catch(() => {}); await metrics.write('small-harness-failure.json', { error: String(error) }); throw error;
  } finally { await metrics.stop(); const timer = setTimeout(() => app.process().kill('SIGKILL'), 5000); try { await app.close(); } finally { clearTimeout(timer); } await rm(root, { recursive: true, force: true }); }
});

test('T28 final installed migrated 500-unit acceptance consumes the explicitly confirmed union', async () => {
  test.skip(!process.env.YIZHI_ACCEPTANCE_INPUT, 'Requires parent-confirmed final T25/T26 input; checkpoint runs cannot opt in.');
  test.setTimeout(1200000);
  if (!process.env.YIZHI_EVIDENCE_DIR) throw new Error('Use persistent scratch YIZHI_EVIDENCE_DIR');
  const input = validateFinalInput(JSON.parse(await readFile(process.env.YIZHI_ACCEPTANCE_INPUT!, 'utf8')));
  const parentEvidence = await readFile(input.parentFinalEvidence, 'utf8');
  if (!parentEvidence.trim()) throw new Error('Parent final evidence is empty');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  expect(sha).toBe(input.sourceSHA);
  for (const commit of [input.t25FinalSHA, input.t26FinalSHA, input.integrationSHA]) execFileSync('git', ['merge-base', '--is-ancestor', commit, sha]);
  expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  const manifestPath = join(input.app, 'Contents/Resources/app/package-manifest.json');
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString());
  expect(manifest.source).toEqual({ commit: input.sourceSHA, dirty: false });
  for (const file of manifest.runtimeFiles) expect(digest(await readFile(join(input.app, 'Contents/Resources/app', file.path)))).toBe(file.sha256);
  const growth = JSON.parse(await readFile(join(input.growthCourse, 'growth-fixture.json'), 'utf8'));
  expect(growth.totalUnits).toBe(500); expect(growth.syntheticUnits).toBeGreaterThan(0);
  expect(growth.originals).toHaveLength(growth.sourceUnits); expect(growth.sourceUnits).toBeGreaterThan(0);
  expect(growth.sourceUnits + growth.syntheticUnits).toBe(500);
  expect(digest(await readFile(join(input.migratedCourse, 'course.sqlite')))).toBe(growth.sourceDatabaseSha256);
  const authorityBytes = await readFile(join(input.migratedCourse, 'directory-authority.json'));
  expect(JSON.parse(authorityBytes.toString()).phase).toBe('published');
  const directory = join(process.env.YIZHI_EVIDENCE_DIR, `installed-${Date.now()}`); await mkdir(directory, { recursive: true });
  const root = await realpath(directory), installed = join(root, 'Applications/YiZhi.app'), course = join(root, 'course-A');
  await mkdir(join(root, 'Applications')); await cp(input.app, installed, { recursive: true, verbatimSymlinks: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
  await cp(input.growthCourse, course, { recursive: true }); await mkdir(join(root, 'empty'));
  const originalPersonal = originalRecords(input.migratedCourse);
  for (const required of ['migration_origins', 'migration_pending', 'migration_receipts', 'migration_values']) expect(originalPersonal[required]).toBeDefined();
  await writeFile(join(root, 'original-record-hashes.json'), JSON.stringify(originalPersonal, null, 2) + '\n');
  const executablePath = join(installed, 'Contents/MacOS/YiZhi');
  if (growth.appended.length < 3) throw new Error('Need three distinct synthetic targets for saved-result display coverage');
  const resultPreparation = join(root, 'acceptance-targets-prepare.cjs'), targetResultsPath = join(root, 'controlled-result-fixture.json');
  await cp(resolve('dist/tests/acceptance-targets-prepare.cjs'), resultPreparation);
  // Use the delivered Electron/Node/Core for fixture preparation, then close it before the app launches.
  const preparationLog = execFileSync(executablePath, [resultPreparation, '--worker', join(installed, 'Contents/Resources/app/dist/worker.cjs'),
    '--course', course, '--units', growth.appended.slice(0, 3).map((entry: any) => entry.id).join(','), '--output', targetResultsPath],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await writeFile(join(root, 'controlled-result-preparation.log'), preparationLog);
  const targetResults = JSON.parse(await readFile(targetResultsPath, 'utf8'));
  const launch = () => electron.launch({ executablePath, args: [`--course=${course}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--enable-precise-memory-info'], cwd: join(root, 'empty'),
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: '', NODE_OPTIONS: '', YIZHI_OBSERVE: '1',
      YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'empty/missing-executor') } });
  let app = await launch();
  const metrics = new AcceptanceMetrics(app, root, { scope: 'final installed 500-unit run', input, appManifestSha256: digest(manifestBytes),
    executableSha256: digest(await readFile(executablePath)), parentEvidenceSha256: digest(parentEvidence), migratedAuthoritySha256: digest(authorityBytes),
    installedCodesign: 'verified deep strict', growth, physicalInput: 'pending separate user operation' });
  let completed = false;
  try {
    const page = await app.firstWindow(); await page.context().route(/^https?:\/\//, route => route.abort()); await page.context().setOffline(true);
    await resizeBoardWindow(app, page); await metrics.attach(page, 'A');
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, versions: process.versions }));
    expect(runtime.packaged).toBe(true); expect(runtime.execPath).toBe(executablePath); expect(runtime.appPath.startsWith(installed + '/')).toBe(true);
    const study = await runStudyAcceptance(app, page, metrics, { runDirectory: root, evidenceDirectory: root, secondCourseDirectory: join(root, 'course-B'), final: true, historyGroups: 300, targetResults });
    await metrics.sample('settled-final'); await metrics.write('measurement-before-reopen.json', { runtime, study, automatedStatus: 'pending-integrity-and-reopen', physicalStatus: 'pending' });
    await metrics.stop(); await app.close();
    // Independent raw-payload preservation check after all app DB handles are closed.
    const db = new DatabaseSync(join(course, 'course.sqlite'), { readOnly: true });
    try { for (const original of growth.originals) { const row = db.prepare('SELECT payload,revision FROM units WHERE id=?').get(original.id)!;
      expect(digest(String(row.payload))).toBe(original.sha256); expect(Number(row.revision)).toBe(original.revision); } } finally { db.close(); }
    const afterPersonal = originalRecords(course), preservedCounts: Record<string, number> = {};
    for (const [table, records] of Object.entries(originalPersonal)) {
      for (const [key, hash] of Object.entries(records)) expect(afterPersonal[table]?.[key], `${table} original ${key}`).toBe(hash);
      preservedCounts[table] = Object.keys(records).length;
    }
    let originalResources = 0;
    for (const resource of JSON.parse(authorityBytes.toString()).proof.resources) if (resource.path.startsWith('resources/')) {
      expect(digest(await readFile(join(course, resource.path)))).toBe(resource.sha256); originalResources++;
    }
    await writeFile(join(root, 'original-preservation.json'), JSON.stringify({ originalUnits: growth.originals.length,
      originalPayloadRevisionIdPreserved: true, originalResources, preservedOriginalRecords: preservedCounts }, null, 2) + '\n');
    app = await launch(); const reopened = await app.firstWindow(); await expect(reopened.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const saved = await reopened.evaluate(async unitId => { const api = (window as any).yizhi, c = await api.open(); return api.read(c.sessionId, unitId); }, study.editableId);
    expect(JSON.stringify(saved.unit)).toContain(study.textMarker); expect(saved.drafts.some((draft: any) => draft.input.formulaDrafts?.length)).toBe(true);
    await metrics.write('measurement.json', { runtime, study, automatedStatus: 'passed', physicalStatus: 'pending' });
    await writeFile(join(root, 'physical-input.json'), JSON.stringify({ ...input, app: installed, courseDirectory: course, profileDirectory: join(root, 'profile'),
      evidenceDirectory: join(root, 'physical'), sourceSHA: sha, appManifestSha256: digest(manifestBytes), editableUnitId: study.editableId,
      secondCourseDirectory: join(root, 'course-B'), automatedEvidence: join(root, 'measurement.json'), physicalStatus: 'pending' }, null, 2) + '\n');
    completed = true;
  } catch (error) { await metrics.sample('failure').catch(() => {}); await metrics.write('failure.json', { error: String(error), automatedStatus: 'failed', physicalStatus: 'pending' }); throw error;
  } finally {
    await metrics.stop(); const timer = setTimeout(() => app.process().kill('SIGKILL'), 5000); try { await app.close(); } finally { clearTimeout(timer); }
    await writeFile(join(root, 'run-status.json'), JSON.stringify({ completed, course, installed, sourceSHA: sha, physicalStatus: 'pending' }, null, 2) + '\n');
  }
});
