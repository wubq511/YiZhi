import { CourseService } from '../src/core/course-service';
import { resolve } from 'node:path';
const [sourceDirectory,directory,backupDirectory,point]=process.argv.slice(2),gate=new SharedArrayBuffer(4),core=new CourseService(resolve('dist/worker.cjs'),{cutoverScheduling:{[point]:gate}});
const timer=setInterval(()=>{if(Atomics.load(new Int32Array(gate),0)===1){clearInterval(timer);process.send?.({point});}},5);
void(async()=>{try{const c=await core.open(sourceDirectory);await core.upgrade.prepare({...c,directory,backupDirectory,upgradeId:'kill-upgrade'});await core.upgrade.publish({sessionId:c.sessionId,upgradeId:'kill-upgrade'});}catch(e){process.send?.({error:(e as Error).message});}finally{clearInterval(timer);await core.close();}})();
