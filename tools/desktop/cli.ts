import {join} from 'node:path';
import {isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {DevelopmentCourseService} from './course-service';
// JSON arguments preserve paths and operation identities without interactive UI.
async function main(){
const [action,raw]=process.argv.slice(2);
const payload=JSON.parse(raw??'{}');
const service=new DevelopmentCourseService(join(__dirname,'worker.cjs'));
try {
 const commands=service.migration;
 if(action==='layout-plan'||action==='layout-arrange') {
  if(typeof payload.directory!=='string'||!isAbsolute(payload.directory)||!existsSync(join(payload.directory,'course.sqlite')))throw new Error('布局整理需要已存在课程的绝对目录');
  const {sessionId}=await service.open(payload.directory);
  if(action==='layout-plan')console.log(JSON.stringify(await service.planLayout(sessionId),null,2));
  else {
   if(typeof payload.operationId!=='string'||typeof payload.basis!=='string')throw new Error('布局整理需要读取依据和操作身份');
   console.log(JSON.stringify(await service.arrangeLayout({sessionId,operationId:payload.operationId,basis:payload.basis}),null,2));
  }
  return;
 }
 if(action==='migrate'){await commands.prepare(payload);console.log(JSON.stringify(await commands.publish({sourceDirectory:payload.sourceDirectory,operationId:payload.operationId}),null,2));return;}
 if(!action||!Object.hasOwn(commands,action))throw new Error('用法: node cli.cjs <migrate|snapshot|convert|prepare|publish|status|recover|abandon|transition|content|personal|history|operation|records|pending|resource> <JSON>；课程查询用 directory 替代 sessionId');
 if(payload.directory&&!['snapshot','convert','prepare','status','recover'].includes(action)){const opened=await service.open(payload.directory);payload.sessionId=opened.sessionId;}
 console.log(JSON.stringify(await (commands as any)[action](payload),null,2));
} finally {await service.close();}

}
void main().catch(error=>{console.error(error.message);process.exitCode=1;});
