import { _electron as electron } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AcceptanceMetrics } from './acceptance-metrics';
import { validateFinalInput } from './acceptance-input';
import { startWheelTrace, stopWheelTrace } from './acceptance-wheel-trace';
import { readCameraTransform } from './board-test-helpers';

async function commitIndependentUpdate(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
            const observation = structuredClone((window as any).__t28Metrics.snapshot());
            if (!observation.composition.active || !observation.composition.lastStartTrusted || !observation.focus.documentFocused)
              throw new Error('No focused native composition observed; cannot claim an IME-overlap update');
            const api = (window as any).yizhi, course = await api.open(), article = document.querySelector('article[data-reading-active=true]');
            const unitId = article?.getAttribute('data-unit-id');
            if (!unitId?.startsWith('KU-LOAD-')) throw new Error('Use an explicitly synthetic growth unit for the physical edit');
            const current = await api.read(course.sessionId, unitId), protectedId = observation.composition.blockId;
            if (!protectedId) throw new Error('Composition block was not identified');
            const target = current.unit.reading.blocks.find((block: any) => block.kind === 'paragraph' && block.id !== protectedId);
            if (!target) throw new Error('No independent paragraph available');
            const attempt = await api.commands.startAttempt({ sessionId: course.sessionId, taskId: crypto.randomUUID() });
            const basis = await api.commands.read({ sessionId: course.sessionId, unitId, attemptId: attempt.attemptId, objectIds: [target.id] });
            const object = basis.objects.find((object: any) => object.id === target.id);
            const result = await api.commands.commit({ sessionId: course.sessionId, unitId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: crypto.randomUUID(),
              changes: [{ objectId: target.id, value: { ...object.value, payload: { ...object.value.payload, text: object.value.payload.text + ' [physical-session controlled independent update]' } } }] });
            await api.commands.stop({ sessionId: course.sessionId, attemptId: attempt.attemptId });
            const after = (window as any).__t28Metrics.snapshot().composition;
            return { at: new Date().toISOString(), compositionBefore: observation.composition, compositionAfter: after,
              nativeCompositionObservedBeforeAndAfter: observation.composition.active && after.active && after.lastStartTrusted,
              receipt: result, independentBlockId: target.id, producer: 'controlled, not actual model' };
          });
}

/** Passive physical-session tool. It never types, clicks, wheels, changes OS input methods or claims physical results itself. */
async function main() {
  const path = process.argv[process.argv.indexOf('--input') + 1];
  if (!process.argv.includes('--input') || !path) throw new Error('Usage: node t28-physical.cjs --input /persistent/physical-input.json');
  const input = JSON.parse(await readFile(path, 'utf8')); validateFinalInput(input);
  const manifestBytes = await readFile(join(input.app, 'Contents/Resources/app/package-manifest.json'));
  const hash = createHash('sha256').update(manifestBytes).digest('hex');
  if (hash !== input.appManifestSha256 || JSON.parse(manifestBytes.toString()).source.commit !== input.sourceSHA) throw new Error('Physical input does not name the accepted final app');
  const directory = join(input.evidenceDirectory, `session-${Date.now()}`); await mkdir(directory, { recursive: true });
  const app = await electron.launch({ executablePath: join(input.app, 'Contents/MacOS/YiZhi'),
    args: [`--course=${input.courseDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--enable-precise-memory-info'],
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: '', NODE_OPTIONS: '', YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: input.profileDirectory, YIZHI_CODEX_PATH: join(directory, 'missing-executor') } });
  const metrics = new AcceptanceMetrics(app, directory, { scope: 'physical session, operator records required', input, sourceSHA: input.sourceSHA,
    inputPolicy: 'Only Robert/parent operates physical devices. No synthetic input is emitted by this tool.' });
  const marks: Array<{ at: string; category: string; result: string; note: string; attestation: string }> = [];
  const updates: unknown[] = [];
  let wheelBefore: unknown;
  let backgroundArmed = false;
  let armedUpdate: Promise<void> | undefined;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = await app.firstWindow(); await page.context().route(/^https?:\/\//, route => route.abort()); await page.context().setOffline(true);
    await page.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
    await metrics.attach(page, 'physical-A'); await metrics.sample('opened-final-app');
    await page.exposeBinding('__t28CompositionReady', async ({ frame }) => {
      if (!backgroundArmed || frame !== page.mainFrame()) return;
      backgroundArmed = false;
      armedUpdate = (async () => {
      try {
        const receipt = { ...await commitIndependentUpdate(page), trigger: 'armed next trusted compositionstart' };
        updates.push(receipt); await metrics.sample('armed-native-composition-independent-update');
        await metrics.write(`armed-background-${Date.now()}.json`, { marks, updates, physicalStatus: 'operator result still required' });
        console.log(`Armed update completed: ${JSON.stringify(receipt)}`);
      } catch (error) {
        console.error(`Armed update did not establish live overlap: ${String(error)}`);
        await writeFile(join(directory, `armed-background-error-${Date.now()}.txt`), String(error));
      }
      })();
      await armedUpdate;
    });
    await page.evaluate(() => {
      const begin = (event: CompositionEvent) => { if (event.isTrusted) void (window as any).__t28CompositionReady(); };
      document.addEventListener('compositionstart', begin, true);
      (window as any).__t28StopCompositionArm = () => document.removeEventListener('compositionstart', begin, true);
    });
    console.log(`Evidence: ${directory}\nCommands: sample LABEL | wheel-start LABEL | wheel-stop | arm-background | disarm-background | background | mark CATEGORY pass|fail|unverified OPERATOR-NOTE | quit\nNo device action or physical pass is generated by this tool.`);
    for await (const line of terminal) {
      const [command, ...parts] = line.trim().split(/\s+/);
      try {
        if (command === 'quit') {
          await armedUpdate;
          if (wheelBefore) {
            const trace = await stopWheelTrace(page), after = await readCameraTransform(page.locator('.react-flow__viewport'));
            await writeFile(join(directory, `wheel-trace-${Date.now()}.json`), JSON.stringify({ input, before: wheelBefore, after, trace }, null, 2) + '\n');
            wheelBefore = undefined;
          }
          break;
        }
        if (command === 'sample') { const label = parts.join(' ') || 'operator-sample'; await metrics.sample(label); await page.screenshot({ path: join(directory, `sample-${Date.now()}.png`) }); }
        else if (command === 'wheel-start') {
          if (wheelBefore) throw new Error('Stop the current wheel trace first');
          const before = await readCameraTransform(page.locator('.react-flow__viewport'));
          await startWheelTrace(page, parts.join(' ') || 'operator-wheel'); wheelBefore = before;
          console.log('Passive wheel trace ready; perform only the named real gesture, then wheel-stop. Limit:512 events.');
        } else if (command === 'wheel-stop') {
          const trace = await stopWheelTrace(page), after = await readCameraTransform(page.locator('.react-flow__viewport'));
          const output = join(directory, `wheel-trace-${Date.now()}.json`);
          await writeFile(output, JSON.stringify({ input, before: wheelBefore, after, trace }, null, 2) + '\n');
          wheelBefore = undefined; console.log(`Raw wheel evidence: ${output}`);
        }
        else if (command === 'arm-background') {
          backgroundArmed = true;
          console.log('Armed once for the next trusted native compositionstart. Keep real candidates open until the independent paragraph updates; no chat/terminal switch is needed.');
        } else if (command === 'disarm-background') { backgroundArmed = false; console.log('Native composition update disarmed.'); }
        else if (command === 'mark') {
          const [category, result, ...note] = parts;
          if (!category || !['pass', 'fail', 'unverified'].includes(result) || !note.length) throw new Error('mark requires category, result and explicit operator evidence');
          marks.push({ at: new Date().toISOString(), category, result, note: note.join(' '), attestation: 'Operator-provided; not inferred from rAF/program input' });
        } else if (command === 'background') {
          const receipt = await commitIndependentUpdate(page);
          updates.push(receipt); await metrics.sample('live-composition-independent-update'); console.log(JSON.stringify(receipt));
        } else if (command) throw new Error('Unknown command');
        await metrics.write(`observation-${Date.now()}.json`, { marks, updates, physicalStatus: 'operator marks only; no aggregate auto-pass' });
      } catch (error) { console.error(String(error)); await writeFile(join(directory, `command-error-${Date.now()}.txt`), String(error)); }
    }
    await metrics.sample('operator-session-end'); await metrics.write('physical-observation.json', { marks, updates, physicalStatus: 'operator marks only; unmarked categories remain unverified' });
  } finally {
    backgroundArmed = false;
    await app.windows()[0]?.evaluate(() => (window as any).__t28StopCompositionArm?.()).catch(() => {});
    terminal.close(); await metrics.stop(); const timer = setTimeout(() => app.process().kill('SIGKILL'), 5000);
    try { await app.close(); } finally { clearTimeout(timer); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
