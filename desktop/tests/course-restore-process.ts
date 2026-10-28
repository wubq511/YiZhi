import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
async function main(){
const [directory,requestPath,boundary]=process.argv.slice(2),gate=new SharedArrayBuffer(4),flag=new Int32Array(gate);
const core=new CourseService(resolve('dist/worker.cjs'),{restoreScheduling:{[boundary]:gate}});
const current=await core.open(directory),request=JSON.parse(await readFile(requestPath,'utf8'));
const timer=setInterval(()=>{if(Atomics.load(flag,0)===1){clearInterval(timer);process.send?.({boundary,sessionId:current.sessionId});}},5);
void core.courseRestore.apply({...request,sessionId:current.sessionId}).catch(error=>{process.send?.({error:error.message});process.exitCode=1;});

}
void main().catch(error=>{process.send?.({error:error.message});process.exitCode=1;});
