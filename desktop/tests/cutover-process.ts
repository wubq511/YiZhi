import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { DevelopmentCourseService as CourseService } from '../../tools/desktop/course-service';
import { join } from 'node:path';
void (async()=>{
const [source,candidate,target,point]=process.argv.slice(2),flag=new SharedArrayBuffer(4);
const core=new CourseService(join(developmentDirectory(), 'worker.cjs'),{cutoverScheduling:{[point]:flag}});
await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'process-cutover'});
const publishing=core.migration.publish({sourceDirectory:source,operationId:'process-cutover'});
while(Atomics.load(new Int32Array(flag),0)!==1)await new Promise(r=>setTimeout(r,5));
process.send?.({point});await publishing;await core.close();

})().catch(error=>{process.send?.({error:error.message});process.exitCode=1;});
