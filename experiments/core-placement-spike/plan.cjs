'use strict';
const path = require('node:path');
module.exports = Object.freeze({
  schema: 'core-placement-1', electron: '40.10.6', node: '24.15.0',
  fixture: path.resolve(__dirname, '../architecture-spike/fixture.json'),
  // Prespecified Latin rotation: every carrier occupies every position once.
  rounds: [['host', 'worker', 'utility'], ['worker', 'utility', 'host'], ['utility', 'host', 'worker']],
  units: 500, steps: 80, operations: 240, warmupOperations: 12, echoCount: 40,
  idleMs: 400, timerPeriodMs: 5, rpcTimeoutMs: 15000, trialTimeoutMs: 60000,
  totalTimeoutMs: 12 * 60000,
  inputs: ['../architecture-spike/fixture.json', '../history-spike/spike.py',
    '../history-spike/README.md', '../storage-spike/spike.py', '../storage-spike/README.md'],
});
