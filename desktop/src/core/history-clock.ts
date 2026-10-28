import { workerData } from 'node:worker_threads';
/** Trusted host-only clock for reproducible retention boundary verification. */
export function historyNow():number {const clock=workerData?.retentionScheduling?.clock;return clock?Number(Atomics.load(new BigInt64Array(clock),0)):Date.now();}
export const historyTimestamp=()=>new Date(historyNow()).toISOString();
