import { CourseService } from '../src/core/course-service';
import { resolve } from 'node:path';
const [directory,point,now]=process.argv.slice(2),clock=new SharedArrayBuffer(8),gate=new SharedArrayBuffer(4);
Atomics.store(new BigInt64Array(clock),0,BigInt(now));
const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true,[point]:gate}});
const watcher=setInterval(()=>{if(Atomics.load(new Int32Array(gate),0)===1){clearInterval(watcher);process.send?.({point});}},5);
void(async()=>{try{const c=await core.open(directory);let result=await core.retention.run({...c,limit:1});while(result.pending)result=await core.retention.run({...c,limit:1});process.send?.({point:'unexpected-finish'});}catch(e){process.send?.({error:String(e)});}finally{clearInterval(watcher);await core.close();}})();
