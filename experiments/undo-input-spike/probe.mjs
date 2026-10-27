import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, '../architecture-spike');
const runtime = join(here, '.runtime');
const originalTmpdir = process.env.TMPDIR;
const require = createRequire(import.meta.url);
const hash = data => createHash('sha256').update(data).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const undo = `${modifier}+z`, redo = `${modifier}+Shift+z`;
const result = {
  capturedAt: new Date().toISOString(), scope: 'Isolated keyboard fact probe; existing built sample; no build, benchmark, CourseService or production implementation',
  environment: { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, headless: true,
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, undo, redo,
    input: 'Playwright keyboard.type/press via Chromium automation; not physical keyboard or native IME' },
  checks: [], scenarios: [], cleanup: {},
};
let browser, server, serverClosed, port, serverLog = '';
const contexts = [];

async function hashes() {
  const values = {};
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) values[path.slice(sample.length + 1)] = hash(await readFile(path));
    }
  }
  await walk(sample);
  for (const relative of ['../style-math-prototype/vendor/mathlive/mathlive.min.js', '../style-math-prototype/vendor/mathlive/package.json',
    '../../legacy/review-board/web/content/provider.js', '../../legacy/review-board/web/content/content.css']) {
    values[relative] = hash(await readFile(resolve(sample, relative)));
  }
  return values;
}

function check(name, pass, evidence) {
  result.checks.push({ name, pass: Boolean(pass), evidence });
}
const unit = id => `[data-unit="${id}"]`;
const settle = async page => {
  await page.waitForFunction(() => !probe.layout()?.pending);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
};

// Observation only: no preventDefault, editor commands, value writes or synthetic DOM input events.
function observe() {
  const describe = el => el?.closest?.('[data-unit]')?.dataset.unit || null;
  const value = el => el?.matches?.('textarea, math-field') ? el.value : null;
  window.undoObservation = { phase: 'load', events: [], writes: [] };
  const log = window.undoObservation;
  const nativeSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, text) {
    const returned = nativeSetItem.call(this, key, text);
    if (this === localStorage && key.startsWith('architecture-spike-v1:')) {
      const state = JSON.parse(text);
      log.writes.push({ phase: log.phase, time: performance.now(), key, bytesUtf8: new TextEncoder().encode(text).length,
        drafts: structuredClone(state.drafts), patchLengths: Object.fromEntries(Object.entries(state.patches).map(([id,v]) => [id, v.length])) });
    }
    return returned;
  };
  for (const type of ['keydown', 'beforeinput', 'input', 'focusin', 'focusout']) {
    document.addEventListener(type, event => {
      const target = event.target;
      if (!target.closest?.('[data-unit]') && !['keydown'].includes(type)) return;
      const record = { phase: log.phase, type, time: performance.now(), target: target.tagName,
        unit: describe(target), key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
        inputType: event.inputType, data: event.data, isComposing: event.isComposing, isTrusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented, value: value(target) };
      log.events.push(record);
      queueMicrotask(() => {
        record.defaultPreventedAfterDispatch = event.defaultPrevented;
        record.valueAfterDispatch = value(target);
        record.focusUnit = describe(document.activeElement);
        const key = Object.keys(localStorage).find(k => k.startsWith('architecture-spike-v1:'));
        record.savedDraftAfterDispatch = key ? JSON.parse(localStorage.getItem(key)).drafts[record.unit] || null : null;
      });
    });
  }
}

async function phase(page, label) {
  await page.evaluate(label => undoObservation.phase = label, label);
}
async function snapshot(page, selector, label) {
  await settle(page);
  const data = await page.locator(selector).evaluate((el, label) => {
    const id = el.closest('[data-unit]').dataset.unit;
    const key = Object.keys(localStorage).find(k => k.startsWith('architecture-spike-v1:'));
    const state = key ? JSON.parse(localStorage.getItem(key)) : null;
    const property = el.tagName === 'TEXTAREA' ? 'text' : 'formula';
    const rect = el.getBoundingClientRect();
    return { label, id, value: el.value, saved: state?.drafts[id]?.[property] ?? null, storageKey: key,
      sameDOM: el === window.undoTarget, connected: el.isConnected, focused: document.activeElement === el,
      selection: el.tagName === 'TEXTAREA' ? { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection } : structuredClone(el.selection),
      position: el.position ?? null, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: probe.viewport(), owner: probe.snapshot().owner, bodyMounts: probe.snapshot().bodyMounts,
      bodyUnmounts: probe.snapshot().bodyUnmounts };
  }, label);
  return data;
}
async function openScenario(count) {
  const context = await browser.newContext({ viewport: result.environment.viewport, deviceScaleFactor: 1 });
  contexts.push(context);
  await context.addInitScript(observe);
  const page = await context.newPage();
  const scenario = { count, query: `?count=${count}&mode=managed&dynamic=1`, errors: [], requests: [], requestFailures: [], stages: [] };
  result.scenarios.push(scenario);
  page.on('pageerror', e => scenario.errors.push({ type: 'pageerror', message: e.message }));
  page.on('console', m => { if (m.type() === 'error') scenario.errors.push({ type: 'console', message: m.text(), location: m.location() }); });
  page.on('request', req => scenario.requests.push({ method: req.method(), origin: new URL(req.url()).origin, path: new URL(req.url()).pathname }));
  page.on('requestfailed', req => scenario.requestFailures.push({ url: req.url(), error: req.failure(), phase: 'requestfailed' }));
  await page.goto(`http://127.0.0.1:${port}/${scenario.query}`);
  await page.waitForFunction(() => window.probe?.ready || window.probe?.failure);
  if (await page.evaluate(() => probe.failure)) throw new Error(await page.evaluate(() => probe.failure));
  await page.evaluate(() => probe.manual());
  await settle(page);
  scenario.actualObjects = await page.locator('[data-unit]').count();
  scenario.initialStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  check(`${count}: actual object count and initially empty storage`, scenario.actualObjects === count && Object.keys(scenario.initialStorage).length === 0, { actualObjects: scenario.actualObjects, initialStorage: scenario.initialStorage });
  return { page, scenario, context };
}
async function capture(page, scenario, selector, label) {
  const state = await snapshot(page, selector, label);
  scenario.stages.push(state);
  return state;
}
async function finish(page, scenario, context) {
  scenario.observation = await page.evaluate(() => undoObservation);
  const target = scenario.count === 84 ? 'TEXTAREA' : 'MATH-FIELD';
  const property = scenario.count === 84 ? 'text' : 'formula';
  const inputs = scenario.observation.events.filter(e => e.type === 'input' && e.target === target);
  scenario.inputSummary = inputs.map(e => ({ phase: e.phase, inputType: e.inputType, isTrusted: e.isTrusted,
    value: e.valueAfterDispatch, saved: e.savedDraftAfterDispatch?.[property] }));
  check(`${scenario.count}: insert/undo/redo input events observed and storage equals emitted value`,
    ['insertText', 'historyUndo', 'historyRedo'].every(type => inputs.some(e => e.inputType === type)) &&
    inputs.every(e => e.valueAfterDispatch === e.savedDraftAfterDispatch?.[property]), scenario.inputSummary);
  check(`${scenario.count}: no page or console errors`, scenario.errors.length === 0, scenario.errors);
  check(`${scenario.count}: all requests are reads on dedicated origin`, scenario.requests.every(r => r.method === 'GET' && r.origin === `http://127.0.0.1:${port}`), { count: scenario.requests.length, methods: [...new Set(scenario.requests.map(r => r.method))] });
  check(`${scenario.count}: no failed asset requests`, scenario.requestFailures.length === 0, scenario.requestFailures);
  if (scenario.errors.length || scenario.requestFailures.length || result.checks.some(c => !c.pass)) await page.screenshot({ path: join(here, `failure-${scenario.count}.png`) });
  await context.close();
}

try {
  await mkdir(runtime, { recursive: true });
  process.env.TMPDIR = runtime; // Playwright's own mkdtemp/profile creation must stay inside the write scope too.
  let packageDir = process.env.PLAYWRIGHT_CORE_PATH;
  if (!packageDir) {
    try { packageDir = dirname(require.resolve('playwright-core/package.json')); }
    catch { throw new Error('Install playwright-core 1.62.1 in the project or set PLAYWRIGHT_CORE_PATH to its package directory; no automatic installation is performed.'); }
  }
  packageDir = resolve(packageDir);
  const packageInfo = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (packageInfo.version !== '1.62.1') throw new Error(`Expected playwright-core 1.62.1; got ${packageInfo.version}`);
  const { chromium } = await import(pathToFileURL(join(packageDir, 'index.mjs')).href);
  result.environment.playwright = { path: packageDir, version: packageInfo.version, reused: !packageDir.startsWith(here),
    packageSha256: hash(await readFile(join(packageDir, 'package.json'))) };
  result.sampleHashesBefore = await hashes();
  const main = await readFile(join(sample, 'src/main.jsx'), 'utf8');
  const dynamicLayout = await readFile(join(sample, 'src/dynamic-layout.js'), 'utf8');
  const provider = await readFile(resolve(sample, '../../legacy/review-board/web/content/provider.js'), 'utf8');
  const search = (text, regex) => text.split('\n').flatMap((line, index) => regex.test(line) ? [{ line: index + 1, text: line.trim() }] : []);
  result.sourceAudit = {
    scope: ['architecture-spike/src/main.jsx', 'architecture-spike/src/dynamic-layout.js', 'legacy/review-board/web/content/provider.js'],
    appUndoOrKeyboardRoutingMatches: search(main + '\n' + dynamicLayout, /\b(?:undo|redo|keydown|keyup|beforeinput|historyUndo|historyRedo)\b/i),
    providerUndoOrKeyboardRoutingMatches: search(provider, /\b(?:undo|redo|keydown|keyup|historyUndo|historyRedo)\b/i),
    movementHooks: search(main, /onNodeDrag(Start|Stop)|moveNode:/),
    baselineWrites: search(dynamicLayout, /baseline\.set/),
    persistence: search(main, /storageKey =|const persist =|addEventListener\('input'|onInput=/),
    drawingRenderers: search(provider, /^\s*function (drawing|drawMux|drawDecoder|drawKmap|drawAdder)/),
    conclusion: 'No application board movement/drawing undo stack or unified keyboard route found in these sources; provider renders course diagrams, not a freehand board editor. Bundled library editor shortcuts do not establish an application route.',
  };
  result.scriptHashes = {};
  for (const f of ['probe.mjs', 'serve.py', 'package.json', 'package-lock.json']) {
    try { result.scriptHashes[f] = hash(await readFile(join(here, f))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const ready = new Promise((accept, reject) => {
    server = spawn('python3', ['-B', join(here, 'serve.py')], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: runtime, PYTHONDONTWRITEBYTECODE: '1' } });
    serverClosed = once(server, 'close');
    server.on('error', reject);
    let line = '';
    server.stdout.on('data', data => {
      serverLog += data; line += data;
      if (line.includes('\n')) { try { accept(JSON.parse(line.split('\n')[0]).port); } catch(e) { reject(e); } }
    });
    server.stderr.on('data', data => serverLog += data);
    server.on('exit', code => { if (!port) reject(new Error(`Server exited ${code}`)); });
  });
  let readyTimer;
  try { port = await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Server readiness timeout')), 10000); })]); }
  finally { clearTimeout(readyTimer); }
  if (port === 8772) throw new Error('Refuse old service port 8772');
  result.environment.server = { host: '127.0.0.1', port, pid: server.pid, osAssigned: true };
  result.environment.chromePath = process.env.PROBE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: result.environment.chromePath, headless: true,
    env: { ...process.env, TMPDIR: runtime, XDG_CACHE_HOME: join(runtime, 'cache') },
    downloadsPath: join(runtime, 'downloads'), tracesDir: join(runtime, 'traces') });
  result.environment.browser = browser.version();

  // 84 real units: native textarea undo, then one same-object paragraph patch combination.
  {
    const { page, scenario, context } = await openScenario(84);
    const id = await page.evaluate(() => probe.unitIds[0]);
    const selector = `${unit(id)} textarea[data-draft]`;
    await page.locator(selector).click();
    await page.locator(selector).evaluate(el => window.undoTarget = el);
    const initial = await capture(page, scenario, selector, 'initial');
    await phase(page, 'textarea.keyboard.type');
    await page.keyboard.type('undo84', { delay: 35 });
    const typed = await capture(page, scenario, selector, 'typed');
    check('textarea: keyboard entered expected text and saved it', typed.value === 'undo84' && typed.saved === 'undo84', typed);
    await phase(page, 'textarea.undo'); await page.keyboard.press(undo);
    const undone = await capture(page, scenario, selector, 'undo');
    check('textarea: one keyboard undo returns initial text and synchronizes storage', undone.value === initial.value && undone.saved === initial.value, undone);
    await phase(page, 'textarea.redo'); await page.keyboard.press(redo);
    const redone = await capture(page, scenario, selector, 'redo');
    check('textarea: keyboard redo returns typed text and synchronizes storage', redone.value === typed.value && redone.saved === typed.value, redone);
    await phase(page, 'textarea.same-object-body-patch');
    const patchText = '同对象正文模拟修改，不修改输入框。'.repeat(12);
    const paragraphSelector = `${unit(id)} .reading-paragraph p, ${unit(id)} .reading-block p`;
    const paragraphBefore = await page.locator(paragraphSelector).first().textContent();
    await page.evaluate(text => probe.emit(0, text), patchText);
    const afterPatch = await capture(page, scenario, selector, 'same-object patch');
    scenario.sameObjectPatch = { paragraphBefore, expected: patchText, actual: await page.locator(paragraphSelector).first().textContent() };
    check('textarea: same-object body patch applied while input DOM, value, focus and selection survived',
      scenario.sameObjectPatch.actual === patchText && afterPatch.sameDOM && afterPatch.focused && afterPatch.value === redone.value && JSON.stringify(afterPatch.selection) === JSON.stringify(redone.selection), afterPatch);
    await phase(page, 'textarea.undo-after-same-object-patch'); await page.keyboard.press(undo);
    const patchUndo = await capture(page, scenario, selector, 'undo after same-object patch');
    await phase(page, 'textarea.redo-after-same-object-patch'); await page.keyboard.press(redo);
    const patchRedo = await capture(page, scenario, selector, 'redo after same-object patch');
    check('textarea: same-object body patch preserves keyboard undo/redo; body patch itself is not undone',
      patchUndo.value === initial.value && patchUndo.saved === initial.value && patchRedo.value === typed.value && patchRedo.saved === typed.value &&
      await page.locator(paragraphSelector).first().textContent() === patchText, { undo: patchUndo, redo: patchRedo });
    await finish(page, scenario, context);
  }

  // 500 objects: MathLive input, then exactly eight simulated updates to another visible body's first paragraph.
  {
    const { page, scenario, context } = await openScenario(500);
    const [id, otherId] = await page.evaluate(() => probe.unitIds);
    const selector = `${unit(id)} .probe-editors math-field`;
    await page.locator(selector).click();
    await page.keyboard.press('End');
    await page.locator(selector).evaluate(el => window.undoTarget = el);
    const initial = await capture(page, scenario, selector, 'initial');
    await phase(page, 'mathlive.keyboard.type');
    await page.keyboard.type('7', { delay: 35 });
    const typed = await capture(page, scenario, selector, 'typed');
    scenario.expectedTyped = `${initial.value}7`;
    check('MathLive: keyboard appends expected digit and saves formula', typed.value === scenario.expectedTyped && typed.saved === typed.value, typed);
    await phase(page, 'mathlive.undo'); await page.keyboard.press(undo);
    const undone = await capture(page, scenario, selector, 'undo');
    check('MathLive: one keyboard undo returns initial formula and synchronizes storage', undone.value === initial.value && undone.saved === initial.value, undone);
    await phase(page, 'mathlive.redo'); await page.keyboard.press(redo);
    const redone = await capture(page, scenario, selector, 'redo');
    check('MathLive: keyboard redo returns typed formula and synchronizes storage', redone.value === typed.value && redone.saved === typed.value, redone);
    const paragraphSelector = `${unit(otherId)} .reading-paragraph p, ${unit(otherId)} .reading-block p`;
    await page.locator(paragraphSelector).first().waitFor();
    scenario.stream = { otherId, minimumDelayMs: 100, updates: 8, samples: [], shortcutDuringStream: [] };
    await phase(page, 'mathlive.other-object-stream');
    for (let i = 1; i <= 8; i++) {
      if (i === 4 || i === 6) {
        await phase(page, `mathlive.${i === 4 ? 'undo' : 'redo'}-during-stream`);
        await page.keyboard.press(i === 4 ? undo : redo);
        scenario.stream.shortcutDuringStream.push(await capture(page, scenario, selector, i === 4 ? 'undo during stream' : 'redo during stream'));
        await phase(page, 'mathlive.other-object-stream');
      }
      const text = `其他对象持续模拟修改 ${i}：${'先核对定义，再验证输入组合。'.repeat(i * 3)}`;
      await page.evaluate(text => probe.emit(1, text), text);
      await delay(100);
      const state = await capture(page, scenario, selector, `stream ${i}`);
      scenario.stream.samples.push({ expectedText: text, actualText: await page.locator(paragraphSelector).first().textContent(), editor: state,
        expectedValue: i >= 4 && i < 6 ? initial.value : typed.value,
        expectedSelection: i >= 4 && i < 6 ? undone.selection : redone.selection });
    }
    check('MathLive: eight actual other-body updates preserve focused DOM, formula and selection',
      scenario.stream.samples.every(s => s.actualText === s.expectedText && s.editor.sameDOM && s.editor.focused && s.editor.value === s.expectedValue && s.editor.saved === s.expectedValue &&
        JSON.stringify(s.editor.selection) === JSON.stringify(s.expectedSelection)), scenario.stream.samples.map(s => ({ textApplied: s.actualText === s.expectedText, focused: s.editor.focused, sameDOM: s.editor.sameDOM, value: s.editor.value, selection: s.editor.selection })));
    await phase(page, 'mathlive.undo-after-other-object-stream'); await page.keyboard.press(undo);
    const streamUndo = await capture(page, scenario, selector, 'undo after stream');
    await phase(page, 'mathlive.redo-after-other-object-stream'); await page.keyboard.press(redo);
    const streamRedo = await capture(page, scenario, selector, 'redo after stream');
    check('MathLive: other-object stream preserves keyboard undo/redo; stream itself is not undone',
      streamUndo.value === initial.value && streamUndo.saved === initial.value && streamRedo.value === typed.value && streamRedo.saved === typed.value &&
      await page.locator(paragraphSelector).first().textContent() === scenario.stream.samples.at(-1).expectedText,
      { undo: streamUndo, redo: streamRedo });

    // One actual drag followed by a board-focused shortcut; no undo implementation is added.
    await phase(page, 'board.actual-drag');
    await page.evaluate(() => { document.activeElement.blur(); getSelection().removeAllRanges(); probe.manual(); probe.jump(0); });
    await settle(page);
    const before = await page.evaluate(id => probe.layout().baseline[id], id);
    const handle = await page.locator(`${unit(id)} .unit-handle`).boundingBox();
    await page.mouse.move(handle.x + 100, handle.y + 24); await page.mouse.down();
    await page.mouse.move(handle.x + 145, handle.y + 48, { steps: 8 }); await page.mouse.up();
    await settle(page);
    const dragged = await page.evaluate(id => probe.layout().baseline[id], id);
    await page.mouse.click(20, 400);
    const focusBefore = await page.evaluate(() => ({ tag: document.activeElement.tagName, unit: document.activeElement.closest('[data-unit]')?.dataset.unit || null }));
    await phase(page, 'board.undo'); await page.keyboard.press(undo); await settle(page);
    const afterUndo = await page.evaluate(id => probe.layout().baseline[id], id);
    await phase(page, 'board.redo'); await page.keyboard.press(redo); await settle(page);
    const afterRedo = await page.evaluate(id => probe.layout().baseline[id], id);
    scenario.board = { before, dragged, afterUndo, afterRedo, focusBefore,
      actualDragMoved: Math.abs(before.x - dragged.x) > 1 || Math.abs(before.y - dragged.y) > 1,
      undoRestored: JSON.stringify(before) === JSON.stringify(afterUndo) };
    check('board: actual drag established; shortcut did not undo movement (observed gap)', scenario.board.actualDragMoved &&
      !scenario.board.undoRestored && JSON.stringify(dragged) === JSON.stringify(afterUndo) && JSON.stringify(dragged) === JSON.stringify(afterRedo) && !focusBefore.unit, scenario.board);
    await finish(page, scenario, context);
  }
} catch (error) {
  result.failure = error.stack; process.exitCode = 1;
  for (const context of contexts) for (const page of context.pages()) {
    await page.screenshot({ path: join(here, 'failure-abort.png') }).catch(() => {});
    const observation = await page.evaluate(() => window.undoObservation).catch(() => null);
    if (observation) result.abortedObservation = observation;
  }
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) { await browser.close(); result.cleanup.browserClosed = true; }
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await serverClosed; }
  result.cleanup.serverExited = server ? server.exitCode !== null || server.signalCode !== null : null;
  if (port) {
    result.cleanup.portClosed = await new Promise(accept => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); accept(false); });
      socket.once('error', () => accept(true));
    });
  }
  await rm(runtime, { recursive: true, force: true });
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  result.cleanup.runtimeRemoved = true;
  result.serverLog = serverLog;
  if (result.sampleHashesBefore) {
    result.sampleHashesAfter = await hashes();
    check('original sample and referenced provider/MathLive files unchanged', JSON.stringify(result.sampleHashesBefore) === JSON.stringify(result.sampleHashesAfter), { files: Object.keys(result.sampleHashesBefore).length });
  }
  result.completedAt = new Date().toISOString();
  result.failedChecks = result.checks.filter(c => !c.pass).map(c => c.name);
  if (result.failedChecks.length) process.exitCode = 1;
  await writeFile(join(here, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ checks: result.checks.length, failed: result.failedChecks, failure: result.failure, cleanup: result.cleanup }, null, 2));
}
