'use strict';
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const plan = require('./plan.cjs');
async function createCarrier(kind) {
  if (kind === 'host') {
    const dispatch = require('./service.cjs').createService();
    return {call:async (action,payload) => dispatch({action,payload}),
      stop:async () => ({kind:'host',threadEnded:false,reason:'host remains alive until trial exit'})};
  }
  const child = kind === 'worker' ? new Worker(path.join(__dirname,'core-entry.cjs')) :
    require('electron').utilityProcess.fork(path.join(__dirname,'core-entry.cjs'),[],{serviceName:'core-placement',stdio:'pipe'});
  const pending = new Map();
  let sequence = 0, exited = false, exitInfo;
  const done = new Promise(resolve => child.once('exit', (code,signal) => {
    exited = true; exitInfo = {code,signal};
    for (const {reject,timer} of pending.values()) { clearTimeout(timer); reject(new Error(`core exited: ${code}/${signal}`)); }
    pending.clear(); resolve(exitInfo);
  }));
  child.on('error', e => {
    for (const {reject,timer} of pending.values()) { clearTimeout(timer); reject(e); }
    pending.clear();
  });
  let stderr = '';
  if (child.stderr) child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-16000); });
  if (child.stdout) child.stdout.on('data', () => {});
  child.on('message', message => {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(Object.assign(new Error(message.error.message),message.error));
  });
  let stopping;
  return {
    call(action,payload) {
      if (exited) return Promise.reject(new Error('core already exited'));
      const id = ++sequence;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => {pending.delete(id);reject(new Error(`RPC timeout ${action}`));},plan.rpcTimeoutMs);
        pending.set(id,{resolve,reject,timer});
        try { child.postMessage({id,action,payload}); }
        catch (e) {clearTimeout(timer);pending.delete(id);reject(e);}
      });
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (!exited) {
          if (kind === 'worker') await child.terminate(); else child.kill();
        }
        let timer;
        try {
          await Promise.race([done,new Promise((_,reject) => {
            timer = setTimeout(() => reject(new Error('core termination timeout')),5000);
          })]);
        } finally { clearTimeout(timer); }
        return {kind,terminated:true,exit:exitInfo,stderr};
      })();
      return stopping;
    },
  };
}
module.exports = {createCarrier};
