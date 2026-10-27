'use strict';
if (process.env.CORE_PLACEMENT_WINDOW !== 'explicitly-open') throw new Error('Measurement window not authorized');
const {parentPort:workerPort} = require('node:worker_threads');
const port = workerPort || process.parentPort;
if (!port) throw new Error('Must run in worker_threads or utilityProcess');
const dispatch = require('./service.cjs').createService();
port.on('message', event => {
  const request = workerPort ? event : event.data;
  try { port.postMessage({id:request.id,ok:true,value:dispatch(request)}); }
  catch (e) { port.postMessage({id:request.id,ok:false,error:{name:e.name,message:e.message,code:e.code,stack:e.stack}}); }
});
