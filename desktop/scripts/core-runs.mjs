import { availableParallelism } from 'node:os';

export function coreBudget(args = process.argv.slice(2), reservedCpus = 2) {
  let cpus = availableParallelism();
  let sequential = false;
  for (const arg of args) {
    if (arg === '--sequential') sequential = true;
    else if (/^--cpus=[1-9]\d*$/.test(arg) && Number.isSafeInteger(Number(arg.split('=')[1]))) {
      cpus = Number(arg.split('=')[1]);
    } else throw new Error(`Invalid verification argument: ${arg}`);
  }
  if (cpus === 1) sequential = true;
  return { cpus, sequential,
    concurrency: Math.max(1, sequential ? cpus - Math.ceil(reservedCpus / 2) : Math.floor((cpus - reservedCpus) / 2)) };
}

export async function coreRuns(check, budget) {
  const node = () => check('core:node', ['scripts/run-tests.mjs', `--concurrency=${budget.concurrency}`]);
  const electron = () => check('core:electron', ['scripts/run-tests.mjs', '--electron', `--concurrency=${budget.concurrency}`]);
  return budget.sequential ? [await node(), await electron()] : Promise.all([node(), electron()]);
}
