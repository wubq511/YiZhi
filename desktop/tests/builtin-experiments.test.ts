import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

const muxId = 'RB-TH-13-057-010-interactive';
test('the real KU057 MUX covers all six independent inputs and reopens the confirmed scene without rewriting knowledge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await service.open(root);
    const original = await service.readUnit(c.sessionId, 'KU-057');
    let v = await service.experiments.open({ sessionId: c.sessionId, unitId: 'KU-057', blockId: muxId });
    // Independent oracle: each selection quadrant repeats the corresponding data-mask bit.
    const truth = ['0101010101010101', '0011001100110011', '0000111100001111', '0000000011111111'];
    for (let s = 0; s < 4; s++) for (let data = 0; data < 16; data++) {
      const inputs = { S1: s >> 1, S0: s & 1, I0: data & 1, I1: (data >> 1) & 1, I2: (data >> 2) & 1, I3: data >> 3 };
      v = await service.experiments.act({ sessionId: c.sessionId, instanceId: v.instanceId, generation: v.generation,
        operationId: `input-${s}-${data}`, action: { kind: 'inputs', inputs } });
      assert.equal(v.result?.output, Number(truth[s][data]), `selection ${s}, data mask ${data}`);
    }
    const confirmed = v.state;
    await service.close(); service = new CourseService(resolve('dist/worker.cjs')); c = await service.open(root);
    v = await service.experiments.open({ sessionId: c.sessionId, unitId: 'KU-057', blockId: muxId });
    assert.deepEqual(v.state, confirmed);
    assert.deepEqual(await service.readUnit(c.sessionId, 'KU-057'), original);
    assert.equal(v.phase, 'paused');
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('74LS138 enumerates 64 address/enable rows and fixed K-map covers precisely its four wrap cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtins-oracle-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), sessionId = c.sessionId;
    const original = await service.readUnit(sessionId, 'KU-062');
    let d = await service.experiments.open({ sessionId, unitId: 'KU-062', blockId: 'RB-TH-14-062-007-interactive' });
    const enabledRows = ['01111111', '10111111', '11011111', '11101111', '11110111', '11111011', '11111101', '11111110'];
    for (let enable = 0; enable < 8; enable++) for (let address = 0; address < 8; address++) {
      d = await service.experiments.act({ sessionId, instanceId: d.instanceId, generation: d.generation, operationId: `decoder-${enable}-${address}`,
        action: { kind: 'inputs', inputs: { A2: address >> 2, A1: (address >> 1) & 1, A0: address & 1, E1: enable & 1, E2: (enable >> 1) & 1, E3: enable >> 2 } } });
      assert.equal(d.result?.outputs?.join(''), enable === 4 ? enabledRows[address] : '11111111');
    }
    let k = await service.experiments.open({ sessionId, unitId: 'KU-035', blockId: 'RB-KU-035-diagram' });
    assert.deepEqual(k.result?.highlighted, []);
    k = await service.experiments.act({ sessionId, instanceId: k.instanceId, generation: k.generation, operationId: 'wrap', action: { kind: 'inputs', inputs: { showCorners: 1 } } });
    assert.deepEqual(k.result?.highlighted, [0, 3, 4, 7]);
    assert.deepEqual(k.definition.config.cells, [[1, 0, 0, 1], [1, 0, 0, 1]]);
    assert.deepEqual(await service.readUnit(sessionId, 'KU-062'), original);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('formula/config changes are atomic, unsupported edits persist without stale results, and exact retry is idempotent', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-formula-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    let c = await service.open(root), sessionId = c.sessionId;
    let v = await service.experiments.open({ sessionId, unitId: 'KU-057', blockId: muxId });
    const cmd = { sessionId, instanceId: v.instanceId, generation: v.generation, operationId: 'formula',
      action: { kind: 'formula' as const, baseRevision: 1, formula: 'Y=\\overline{S_1}\\overline{S_0}I_1+\\overline{S_1}S_0I_0+S_1\\overline{S_0}I_3+S_1S_0I_2' } };
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER reject_experiment_event BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT,'experiment disk fault'); END");
    await assert.rejects(service.experiments.act(cmd), /experiment disk fault/);
    assert.deepEqual(await service.experiments.read({ sessionId, instanceId: v.instanceId }), v);
    fault.exec('DROP TRIGGER reject_experiment_event'); fault.close(); fault = undefined;
    v = await service.experiments.act(cmd);
    assert.equal(v.definition.check, 'verified');
    assert.deepEqual(v.definition.config.dataSignals, ['I1', 'I0', 'I3', 'I2']);
    assert.deepEqual(await service.experiments.act(cmd), v);
    const swapped = ['0011001100110011', '0101010101010101', '0000000011111111', '0000111100001111'];
    for (let select = 0; select < 4; select++) for (let data = 0; data < 16; data++) {
      const scene = await service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: `converted-${select}-${data}`,
        action: { kind: 'inputs', inputs: { S1: select >> 1, S0: select & 1, I0: data & 1, I1: (data >> 1) & 1, I2: (data >> 2) & 1, I3: data >> 3 } } });
      assert.equal(scene.result?.output, Number(swapped[select][data]));
    }
    await assert.rejects(service.experiments.act({ ...cmd, action: { ...cmd.action, formula: 'Y=1' } }), /不同内容/);
    v = await service.experiments.act({ ...cmd, operationId: 'unsupported', action: { kind: 'formula', baseRevision: 2, formula: 'Y=S_{10}' } });
    assert.equal(v.result, null); assert.equal(v.definition.check, 'needs-check');
    await service.close(); service = new CourseService(resolve('dist/worker.cjs')); c = await service.open(root); sessionId = c.sessionId;
    v = await service.experiments.open({ sessionId, unitId: 'KU-057', blockId: muxId });
    assert.equal(v.definition.formula, 'Y=S_{10}'); assert.equal(v.result, null);
    await assert.rejects(service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: 'bad-run', action: { kind: 'run', running: true } }), /核对/);
    v = await service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: 'constant', action: { kind: 'formula', baseRevision: 3, formula: 'Y=1' } });
    assert.equal(v.definition.check, 'verified'); assert.deepEqual(v.definition.config.dataSignals, ['1', '1', '1', '1']);
    assert.equal(v.result?.output, 1);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
test('offscreen pause drains a bounded step, freezes simulation time, resumes without catch-up, and background requires an explicit choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-pause-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), sessionId = c.sessionId;
    let v = await service.experiments.open({ sessionId, unitId: 'KU-057', blockId: muxId });
    let seq = 0;
    const act = async (action: import('../src/experiments-api').ExperimentAction) => v = await service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: `lifecycle-${++seq}`, action });
    await act({ kind: 'visibility', visible: true }); await act({ kind: 'run', running: true });
    await wait(290); v = await service.experiments.read({ sessionId, instanceId: v.instanceId });
    assert.ok(v.state.step >= 1);
    await act({ kind: 'visibility', visible: false });
    const oldPause = { sessionId, instanceId: v.instanceId, generation: v.generation, operationId: `lifecycle-${seq}`, action: { kind: 'visibility' as const, visible: false } };
    const paused = v.state; assert.equal(v.phase, 'paused');
    await wait(570); v = await service.experiments.read({ sessionId, instanceId: v.instanceId });
    assert.deepEqual(v.state, paused);
    await act({ kind: 'visibility', visible: true }); assert.deepEqual(v.state, paused);
    await wait(290); v = await service.experiments.read({ sessionId, instanceId: v.instanceId });
    assert.equal(v.state.step, paused.step + 1); assert.equal(v.state.simulationTime, paused.simulationTime + 250);
    await service.experiments.act(oldPause);
    const beforeOldPause = v.state.step; await wait(290);
    v = await service.experiments.read({ sessionId, instanceId: v.instanceId }); assert.ok(v.state.step > beforeOldPause, 'an old pause receipt must not cancel resumed steps');
    await act({ kind: 'background', enabled: true }); await act({ kind: 'visibility', visible: false });
    const backgroundStep = v.state.step; await wait(290);
    v = await service.experiments.read({ sessionId, instanceId: v.instanceId }); assert.ok(v.state.step > backgroundStep);
    await act({ kind: 'background', enabled: false }); const stopped = v.state;
    await wait(290); v = await service.experiments.read({ sessionId, instanceId: v.instanceId }); assert.deepEqual(v.state, stopped);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a real pause write failure stops new steps, reports incomplete and restores the last confirmed scene with a new generation', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-failed-pause-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const c = await service.open(root), sessionId = c.sessionId;
    let v = await service.experiments.open({ sessionId, unitId: 'KU-057', blockId: muxId });
    const act = (operationId: string, action: import('../src/experiments-api').ExperimentAction) => service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId, action });
    v = await act('show', { kind: 'visibility', visible: true }); v = await act('run', { kind: 'run', running: true });
    const confirmed = v.state, generation = v.generation;
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_pause BEFORE UPDATE ON builtin_experiments BEGIN SELECT RAISE(ABORT,'pause disk fault'); END");
    await assert.rejects(act('offscreen', { kind: 'visibility', visible: false }), /pause disk fault/);
    v = await service.experiments.read({ sessionId, instanceId: v.instanceId });
    assert.equal(v.phase, 'pause-incomplete');
    const snapshot = await service.experiments.snapshot({ sessionId, instanceId: v.instanceId });
    assert.equal(snapshot.schemaVersion, 'builtin-state-1'); assert.deepEqual(snapshot.state, confirmed);
    await wait(570); assert.deepEqual((await service.experiments.read({ sessionId, instanceId: v.instanceId })).state, confirmed);
    fault.exec('DROP TRIGGER fail_pause'); fault.close(); fault = undefined;
    v = await act('recover', { kind: 'recover' }); assert.deepEqual(v.state, confirmed); assert.ok(v.generation > generation);
    await assert.rejects(service.experiments.act({ sessionId, instanceId: v.instanceId, generation, operationId: 'late-input', action: { kind: 'inputs', inputs: { ...v.state.inputs, I0: 1 } } }), /代际/);
    assert.equal(v.phase, 'paused');
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});


test('supported 2:1 uses its ordered single selector for all eight inputs; fixed K-map and decoder formulas retain their finite contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-finite-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), sessionId = c.sessionId;
    const block = { id: 'two-to-one-test', kind: 'interactive', payload: { component: 'mux', config: { selectBits: ['S'], dataSignals: ['D0', 'D1'] }, inputs: { S: 0, D0: 0, D1: 1 } } };
    const ids = c.unit.reading.blocks.map(b => b.id);
    await service.commitEdit({ sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'finite-fixture', complete: true, changes: [],
      patch: { updates: [], structure: { parentId: c.unit.id, before: ids, after: [...ids, block.id], inserted: [block] }, correspondence: [] } });
    let m = await service.experiments.open({ sessionId, unitId: c.unit.id, blockId: block.id });
    const truth = '01010011';
    for (let row = 0; row < 8; row++) {
      m = await service.experiments.act({ sessionId, instanceId: m.instanceId, generation: m.generation, operationId: `two-${row}`,
        action: { kind: 'inputs', inputs: { S: row >> 2, D0: row & 1, D1: (row >> 1) & 1 } } });
      assert.equal(m.result?.output, Number(truth[row]));
    }
    m = await service.experiments.act({ sessionId, instanceId: m.instanceId, generation: m.generation, operationId: 'two-formula', action: { kind: 'formula', baseRevision: 1, formula: 'Z=\\overline{S}D_0+SD_1' } });
    assert.equal(m.definition.check, 'verified');
    assert.deepEqual(m.definition.config.dataSignals, ['D0', 'D1']);
    let k = await service.experiments.open({ sessionId, unitId: 'KU-035', blockId: 'RB-KU-035-diagram' });
    k = await service.experiments.act({ sessionId, instanceId: k.instanceId, generation: k.generation, operationId: 'kmap-equivalence', action: { kind: 'formula', baseRevision: 1, formula: 'F=\\overline{C}(A+\\overline{A})(B+\\overline{B})' } });
    assert.equal(k.definition.check, 'verified');
    // Independent eight minterms from the original Gray grid: C=0, at 0/2/4/6 only.
    assert.deepEqual(k.definition.config.columnOrder, ['00', '01', '11', '10']);
    k = await service.experiments.act({ sessionId, instanceId: k.instanceId, generation: k.generation, operationId: 'kmap-other-function', action: { kind: 'formula', baseRevision: 2, formula: 'F=A' } });
    assert.equal(k.definition.check, 'needs-check'); assert.equal(k.result, null);
    let d = await service.experiments.open({ sessionId, unitId: 'KU-062', blockId: 'RB-TH-14-062-007-interactive' });
    d = await service.experiments.act({ sessionId, instanceId: d.instanceId, generation: d.generation, operationId: 'decoder-equivalence', action: { kind: 'formula', baseRevision: 1, formula: d.definition.formula } });
    assert.equal(d.definition.check, 'verified');
    await assert.rejects(service.save({ sessionId, operationId: 'decoder-equivalence', inputSeq: 2, baseRevision: 2, blockId: c.editableBlockId, text: 'must not reuse experiment operation' }), /操作身份/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('parsing and built-in experiments cannot reuse each other\'s durable operation identity', async () => {
  const { sourceFixture } = await import('./source-fixture');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-parsing-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(join(root, 'course')), sessionId = c.sessionId;
    const v = await service.experiments.open({ sessionId, unitId: 'KU-057', blockId: muxId });
    const action = { kind: 'inputs' as const, inputs: v.state.inputs };
    await service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: 'experiment-identity', action });
    const path = join(root, 'new-source.pdf'); await sourceFixture(path);
    const source = await service.sources.importFile({ sessionId, generation: 1, operationId: 'source-for-parse', path, title: 'Public test fixture' });
    await assert.rejects(service.parsing.start({ sessionId, generation: 1, operationId: 'experiment-identity', versionId: source.version.versionId }), /操作身份/);
    await service.parsing.start({ sessionId, generation: 1, operationId: 'parse-identity', versionId: source.version.versionId });
    await assert.rejects(service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: 'parse-identity', action }), /操作身份/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('close pause barrier stops every instance even if one snapshot cannot be confirmed', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-close-barrier-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const { sessionId } = await service.open(root);
    const mux = await service.experiments.open({ sessionId, unitId: 'KU-057', blockId: muxId });
    const kmap = await service.experiments.open({ sessionId, unitId: 'KU-035', blockId: 'RB-KU-035-diagram' });
    for (const v of [mux, kmap]) {
      await service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: `${v.blockId}-background`, action: { kind: 'background', enabled: true } });
      await service.experiments.act({ sessionId, instanceId: v.instanceId, generation: v.generation, operationId: `${v.blockId}-run`, action: { kind: 'run', running: true } });
    }
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER one_snapshot_fault BEFORE UPDATE ON builtin_experiments WHEN NEW.id='KU-057/RB-TH-13-057-010-interactive' BEGIN SELECT RAISE(ABORT,'one snapshot failed'); END");
    await assert.rejects(service.experiments.pauseAll({ sessionId }), /one snapshot failed/);
    const before = await service.experiments.read({ sessionId, instanceId: kmap.instanceId });
    await wait(570);
    assert.deepEqual((await service.experiments.read({ sessionId, instanceId: kmap.instanceId })).state, before.state);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
