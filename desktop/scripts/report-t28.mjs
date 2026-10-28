import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const input = args.get('--input'), output = args.get('--output');
if (!input || !output || !isAbsolute(input) || !isAbsolute(output)) throw new Error('Usage: node scripts/report-t28.mjs --input /persistent/measurement.json --output /persistent/new-report.md');
const data = JSON.parse(await readFile(input, 'utf8'));
if (data.schema !== 'yizhi-t28-observation-1' || !data.checkpoints?.length) throw new Error('No actual T28 observation checkpoints');
const checkpoints = data.checkpoints, context = data.context ?? {}, study = data.study ?? {};
const mib = value => typeof value === 'number' ? (value / 1048576).toFixed(2) : 'unavailable';
const range = values => values.length ? `${mib(values[0])} → ${mib(Math.max(...values))} → ${mib(values.at(-1))}` : 'unavailable';
const percentile = (raf, quantile) => { if (!raf?.count) return 'unavailable'; let count = 0;
  for (let index = 0; index < raf.bins.length; index++) { count += raf.bins[index]; if (count >= raf.count * quantile) return index === 2001 ? '≥2001' : `${index}–${index + 1}`; }
  return 'unavailable'; };
const pages = [...new Set(checkpoints.flatMap(checkpoint => checkpoint.renderers.map(renderer => renderer.label)))];
const rows = [], missing = [];
for (const page of pages) {
  const samples = checkpoints.flatMap(checkpoint => checkpoint.renderers.filter(renderer => renderer.label === page));
  const names = new Set(samples.flatMap(sample => Object.keys(sample.internal ?? {})));
  for (const name of [...names].sort()) {
    const values = samples.flatMap(sample => sample.internal?.[name] ? [sample.internal[name]] : []);
    rows.push(`| ${page} / ${name} | ${values.at(-1).current} | ${Math.max(...values.map(value => value.peak))} | ${Math.max(...values.map(value => value.max))} | ${values.at(-1).count} |`);
  }
  for (const name of ['reading.surfaces', 'editor.instances', 'measurement.callbacks', 'measurement.pending', 'layout.scheduledFrames', 'notifications.batchSize'])
    if (!names.has(name)) missing.push(`${page}/${name}`);
}
const coreNames = [...new Set(checkpoints.flatMap(checkpoint => Object.keys(checkpoint.core.counters)))].sort();
for (const name of coreNames) { const values = checkpoints.flatMap(checkpoint => checkpoint.core.counters[name] ? [checkpoint.core.counters[name]] : []);
  rows.push(`| Core / ${name} | ${values.at(-1).current} | ${Math.max(...values.map(value => value.peak))} | ${Math.max(...values.map(value => value.max))} | ${values.at(-1).count} |`); }
const memory = [`| Core + host process RSS | ${range(checkpoints.map(checkpoint => checkpoint.core.memory.rss))} |`,
  `| Core Worker V8 heap | ${range(checkpoints.map(checkpoint => checkpoint.core.memory.heapUsed))} |`];
for (const page of pages) memory.push(`| ${page} renderer V8 heap | ${range(checkpoints.flatMap(checkpoint => checkpoint.renderers.filter(renderer => renderer.label === page).map(renderer => renderer.v8Heap?.usedSize).filter(value => typeof value === 'number')))} |`);
const last = checkpoints.at(-1);
const frames = last.renderers.map(renderer => `| ${renderer.label} | ${renderer.raf?.count ?? 'unavailable'} | ${percentile(renderer.raf, .5)} | ${percentile(renderer.raf, .95)} | ${renderer.raf?.max ?? 'unavailable'} | ${renderer.longtask?.supported ? `${renderer.longtask.count} / ${renderer.longtask.max}` : 'unsupported'} |`);
const overlaps = ['historyOverlap', 'indexOverlap', 'parserOverlap'].flatMap(name => { const evidence = study[name]; if (!evidence) return [];
  const progress = evidence.progress; return [`| ${name} | ${(evidence.endedAt - evidence.startedAt).toFixed(2)} | ${(progress.acknowledgedAt - progress.requestedAt).toFixed(2)} | ${(progress.readAt - progress.requestedAt).toFixed(2)} | ${progress.acknowledgedWhileActive && progress.readBackWhileActive} |`]; });
const text = `# T28 observation report\n\nScope: ${context.scope ?? 'unspecified'}. Automated: ${data.automatedStatus ?? 'preparation only'}. Physical: ${data.physicalStatus ?? 'not accepted'}.\n\n` +
  `Source SHA: ${context.sourceSHA ?? 'unavailable'}; app manifest SHA256: ${context.appManifestSha256 ?? 'not an installed run'}. Device: ${data.device.model}, ${data.device.cpu}, macOS ${data.device.macOS} (${data.device.macOSBuild}). Runtime: ${JSON.stringify(last.processes?.runtime ?? data.runtime?.versions ?? null)}.\n\n` +
  `Load: ${study.graphUnits ?? 'unrecorded'} graph units, ${study.navigated ?? 'unrecorded'} navigations, ${study.history?.groups ?? 'unrecorded'} synthetic public history groups. Viewport/DPR: ${last.renderers.map(renderer => `${renderer.label} ${renderer.viewport.join('×')} @${renderer.dpr}`).join('; ')}.\n\n` +
  `Raw evidence: [JSON](<${input}>). Missing required counters: ${missing.length ? missing.join(', ') : 'none among the listed common counters'}. Unexercised optional resources must not be inferred from a zero or missing value.\n\n` +
  `## Memory trend\n\nMiB, first → maximum observed checkpoint → last; this is an observation, not a leak diagnosis. Core RSS already includes the host process.\n\n| Scope | Trend |\n| --- | --- |\n${memory.join('\n')}\n\n` +
  `## Frame observations\n\nProgrammatic/browser timing only. 1 ms histogram bins; hidden windows can be throttled. Longtasks show count / maximum duration in ms.\n\n| Renderer | rAF samples | p50 ms | p95 ms | Max ms | Longtask |\n| --- | --- | --- | --- | --- | --- |\n${frames.join('\n')}\n\n` +
  `## Actual overlap\n\nMilliseconds; B starts after the real workload begins. The history workload uses repeated real previews; one synchronous preview may queue B. No arbitrary latency target is applied.\n\n| Workload | Duration | B latest-save acknowledgement | B read-back | Both before job end |\n| --- | --- | --- | --- | --- |\n${overlaps.join('\n')}\n\n` +
  `## Passive counters\n\nResource gauges use current/peak; sampled sizes/durations use maximum sample; event counters use count. Cumulative count is not concurrent work.\n\n| Scope / counter | Last gauge | Peak gauge | Max sample | Last count |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n` +
  `No physical mouse/trackpad/IME result is inferred from this report. User observations and final acceptance notes must reference the same final app/course identity.\n`;
await writeFile(output, text, { flag: 'wx' }); console.log(output);
