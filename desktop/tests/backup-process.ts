import { CourseService } from '../src/core/course-service';
import { resolve } from 'node:path';
const gate=new SharedArrayBuffer(4),core=new CourseService(resolve('dist/worker.cjs'),{backupScheduling:{beforeMarker:gate}});
const watcher=setInterval(()=>{if(Atomics.load(new Int32Array(gate),0)===1){clearInterval(watcher);process.send?.({point:'beforeMarker'});}},5);
void(async()=>{try{const c=await core.open(process.argv[2]);await core.backup.create({...c,directory:process.argv[3],backupId:'killed'});}catch(e){process.send?.({error:String(e)});}finally{clearInterval(watcher);await core.close();}})();
