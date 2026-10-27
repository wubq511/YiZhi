'use strict';
const assert = require('node:assert/strict');
const plan = require('./plan.cjs');
const { Adapter } = require('./adapter.cjs');
const { receipt } = require('./fixture.cjs');
function createService() {
  assert.equal(process.versions.electron,plan.electron,'Electron runtime version');
  assert.equal(process.versions.node,plan.node,'embedded Node version');
  let adapter;
  return ({action,payload}) => {
    switch (action) {
      case 'hello': return {pid:process.pid,versions:process.versions,processType:process.type};
      case 'open': {
        assert(!adapter); adapter = new Adapter(payload);
        return {pid:process.pid,pragmas:adapter.settings,
          sqlite:adapter.db.prepare('SELECT sqlite_version() AS version').get().version};
      }
      case 'apply': return adapter.apply(payload);
      // Same command payload and receipt envelope, without database work.
      case 'echo': return {receipt:receipt(payload,1),duplicate:false,adapterMs:0,transactionMs:0,commitCallMs:0};
      case 'probe-error': return adapter.probeRollback();
      case 'snapshot-hash': return require('./fixture.cjs').hash(adapter.snapshot());
      case 'close': adapter.close(); adapter = undefined; return {closed:true};
      default: throw new Error('unknown_action');
    }
  };
}
module.exports = {createService};
