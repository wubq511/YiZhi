import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),{CourseService}=require('../dist/course-service.cjs');
const [action,source,destination,backupId]=process.argv.slice(2);
if(!['create','resume','verify','status'].includes(action)||!source||(['create','resume'].includes(action)&&(!destination||!backupId))){console.error('Usage: node scripts/backup-course.mjs create|resume COURSE NEW_DIRECTORY BACKUP_ID\n       node scripts/backup-course.mjs verify|status BACKUP');process.exit(2);}
const core=new CourseService(resolve('dist/worker.cjs'));
try{
 if(action==='status'||action==='verify')console.log(JSON.stringify(await core.backup[action]({directory:resolve(source)}),null,2));
 else {const c=await core.open(resolve(source));console.log(JSON.stringify(await core.backup[action]({...c,directory:resolve(destination),backupId}),null,2));}
}finally{await core.close();}
