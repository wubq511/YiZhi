import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { cp,realpath,lstat,rm,readFile,rename,readdir,rmdir } from 'node:fs/promises';
import { join,resolve,dirname,basename,relative,sep } from 'node:path';
import { durableJSON,CourseBackups } from './backup';
import { assertWritableFormat } from './course-format';
import { validateCourseCopy } from './course-validation';
import { directoryStatus,recoverDirectory,type DirectoryDecision,type CutoverScheduling } from './directory-authority';
import type { UpgradePreparation,UpgradeRequest,UpgradeScheduling } from '../upgrade-api';
export interface UpgradeSource {directory:string;courseId:string;pause():Promise<void>;resume(maintenanceOnly?:boolean):Promise<void>;release():Promise<void>;acquireBackup(id:string,directory:string):void;releaseBackup(id:string):void}
type Source=UpgradeSource;
interface Live {source:Source;held:SharedArrayBuffer;decision:DirectoryDecision;request:UpgradeRequest}
async function gate(buffer?:SharedArrayBuffer){if(!buffer)return;const a=new Int32Array(buffer);Atomics.store(a,0,1);while(Atomics.load(a,0)===1)await new Promise(r=>setTimeout(r,5));}
async function absent(path:string){try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}}
/** Only an empty reservation or its unpublished first-marker files are disposable. */
async function discardUninitialized(directory:string,marker:RegExp){
 const stat=await lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('维护暂存位置不是独立目录');
 const entries=await readdir(directory,{withFileTypes:true});
 if(entries.some(entry=>!entry.isFile()||!marker.test(entry.name)))throw new Error('维护暂存目录含有未登记内容，已保留，请核对后重试');
 for(const entry of entries)await rm(join(directory,entry.name));
 await rmdir(directory);
}
export class CourseUpgrades {
 private live=new Map<string,Live>();
 constructor(private backups:CourseBackups,private scheduling?:UpgradeScheduling,private cutoverScheduling?:CutoverScheduling){}
 status(directory:string){return directoryStatus(directory);}
 recover(directory:string){return this.proof('recover',undefined,directory);}
 private proof(action:'begin'|'prepare'|'cancel'|'publish'|'sourceVersion'|'recover',live?:Live,directory?:string):Promise<any>{return new Promise((resolve,reject)=>{
  const worker=new Worker(join(__dirname,'upgrade-proof.cjs'),{workerData:{action,decision:live?.decision,held:live?.held,directory,cutoverScheduling:this.cutoverScheduling}});let received=false;
  worker.once('message',r=>{received=true;if(r.ok)resolve(r.result);else reject(new Error(r.error));});worker.once('error',reject);worker.once('exit',code=>{if(!received)reject(new Error('升级核验进程退出: '+code));});
 });}
 async prepare(request:UpgradeRequest,source:Source):Promise<UpgradePreparation>{
  if(!/^[\w-]{1,100}$/.test(request.upgradeId))throw new Error('升级身份无效');
  const existing=this.live.get(source.directory);
  if(existing){if(existing.request.upgradeId!==request.upgradeId||existing.request.directory!==request.directory||existing.request.backupDirectory!==request.backupDirectory)throw new Error('该课程已有另一升级准备');if(!existing.decision?.proof.databaseSha256)throw new Error('该课程仍在准备升级，请等待实际核验结果');return existing.decision as UpgradePreparation;}
  if(assertWritableFormat(source.directory).courseFormat!==1)throw new Error('仅支持受控课程格式 1 → 2 升级');
  const canonical=async(path:string)=>join(await realpath(dirname(resolve(path))),basename(path));
  const directory=await canonical(request.directory),backupDirectory=await canonical(request.backupDirectory),origin=await realpath(source.directory),outside=(p:string)=>p==='..'||p.startsWith('..'+sep);
  for(const target of [directory,backupDirectory])if(!outside(relative(origin,target))||!outside(relative(target,origin)))throw new Error('升级与备份必须使用原课程外的独立新目录');
  if(directory===backupDirectory||!outside(relative(directory,backupDirectory))||!outside(relative(backupDirectory,directory)))throw new Error('升级工作副本与备份目录必须独立');
  if(request.automatic){
   const job=JSON.parse(await readFile(join(origin,'automatic-upgrade.json'),'utf8'));
   if(job.schema!=='yizhi-automatic-upgrade-1'||job.upgradeId!==request.upgradeId||job.directory!==directory||job.backupDirectory!==backupDirectory
     ||directory!==origin+'.format2-'+request.upgradeId||backupDirectory!==origin+'.before-format2-'+request.upgradeId)throw new Error('自动维护位置与原课程预留记录不符');
   if(!await absent(directory)&&await absent(join(directory,'directory-authority.json')))
    await discardUninitialized(directory,/^directory-authority\.json\.[\w-]+\.partial$/);
  }
  let staged:DirectoryDecision|undefined;
  if(!await absent(directory)){
   if(!request.automatic)throw new Error('请使用全新升级工作副本和备份目录');
   staged=JSON.parse(await readFile(join(directory,'directory-authority.json'),'utf8'));
   if(staged?.kind!=='format-upgrade'||staged.operationId!=='upgrade:'+request.upgradeId||staged.sourceDirectory!==origin||staged.targetDirectory!==directory||staged.phase!=='verified'||staged.abandonedAt||staged.report?.backupDirectory!==backupDirectory)throw new Error('升级工作副本与原维护身份不符');
  }
  const starting=backupDirectory+'.backup-starting-upgrade-'+request.upgradeId;
  if(request.automatic&&await absent(backupDirectory)&&!await absent(starting)){
   if(await absent(join(starting,'backup-manifest.json')))await discardUninitialized(starting,/^backup-manifest\.json\.partial$/);
   else{
    const initializing=JSON.parse(await readFile(join(starting,'backup-manifest.json'),'utf8'));
    if(initializing.backupId!=='upgrade-'+request.upgradeId||initializing.sourceDirectory!==origin||initializing.courseId!==source.courseId)throw new Error('未完成备份与原维护身份不符');
    await rename(starting,backupDirectory);
   }
  }
  const resumeBackup=!await absent(backupDirectory);
  if(resumeBackup&&!request.automatic)throw new Error('请使用全新升级工作副本和备份目录');
  const held=new SharedArrayBuffer(4);Atomics.store(new Int32Array(held),0,1);
  const live:Live={source,held,request,decision:undefined!};this.live.set(origin,live);
  try{
   await source.pause();
   const backupId='upgrade-'+request.upgradeId;
   const backup=await this.backups.create({sessionId:request.sessionId,directory:backupDirectory,backupId},{directory:origin,courseId:source.courseId,acquire:()=>source.acquireBackup(backupId,backupDirectory),release:()=>source.releaseBackup(backupId)},resumeBackup);
   await this.backups.verify(backupDirectory);await gate(this.scheduling?.afterBackup);
   const version={...await this.proof('sourceVersion',live,backupDirectory),backupId,backupDatabaseSha256:backup.database!.sha256,saveBarrier:request.saveBarrier??{scope:'core-confirmed-inputs'}};
   const decision:Omit<DirectoryDecision,'proof'>={schema:'yizhi-directory-transition-1',id:randomUUID(),operationId:'upgrade:'+request.upgradeId,kind:'format-upgrade',courseId:source.courseId,sourceDirectory:origin,targetDirectory:directory,sourceVersion:version,phase:'verified',preparedAt:new Date().toISOString(),report:{backupDirectory,backupId,fromVersion:1,toVersion:2}};
   live.decision=staged??{...decision,proof:{databaseSha256:'',resources:[]}};
   // A managed unfinished copy is recreated from the same checked backup. The
   // source-version lease still checks all domain data before sealing/publishing.
   if(!staged)await this.proof('begin',live);
   else if(staged.sourceVersion.dataDigest!==version.dataDigest)throw new Error('原备份与维护准备的课程内容不一致');
   for(const suffix of ['', '-wal', '-shm'])await rm(join(directory,'course.sqlite'+suffix),{force:true});
   await cp(backupDirectory,directory,{recursive:true,errorOnExist:false});
   await rm(join(directory,'backup-manifest.json'));await rm(join(directory,'backup-complete.json'));
   const target=new DatabaseSync(join(directory,'course.sqlite'));
   try{
    target.exec('BEGIN IMMEDIATE; CREATE TABLE format_upgrades(id TEXT PRIMARY KEY,from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,backup_sha256 TEXT NOT NULL,upgraded_at TEXT NOT NULL)');
    target.prepare('INSERT INTO format_upgrades VALUES(?,1,2,?,?)').run(request.upgradeId,backup.database!.sha256,new Date().toISOString());
    target.prepare("INSERT OR REPLACE INTO metadata VALUES('minimum-reader','2')").run();target.exec('PRAGMA user_version=2; COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
   }finally{target.close();}
   await gate(this.scheduling?.beforeValidation);
   const validation=await validateCourseCopy(directory);if(validation.courseId!==source.courseId)throw new Error('升级后课程身份变化');
   live.decision.report.validation={courseId:validation.courseId,generation:validation.generation,units:validation.units,resources:validation.resources};
   live.decision=await this.proof('prepare',live);return live.decision as UpgradePreparation;
  }catch(e){
   const diagnostic={schema:'yizhi-upgrade-diagnostic-1',upgradeId:request.upgradeId,sourceDirectory:origin,directory,backupDirectory,phase:'unfinished',message:(e as Error).message};
   if(!await absent(directory))await durableJSON(join(directory,'upgrade-diagnostic.json'),diagnostic);else if(!await absent(backupDirectory))await durableJSON(join(backupDirectory,'upgrade-diagnostic.json'),diagnostic);
   if(live.decision&&!request.automatic)await this.proof('cancel',live).catch(()=>{});
   Atomics.store(new Int32Array(held),0,0);this.live.delete(origin);await source.resume(!!request.automatic);throw e;
  }
 }
 private async reacquire(sourceDirectory:string,upgradeId:string,source?:Source){
  const held=this.live.get(sourceDirectory);if(held){if(held.request.upgradeId!==upgradeId)throw new Error('升级身份不匹配');return held;}
  const status=directoryStatus(sourceDirectory),decision=status.decision;
  if(!source||!decision||decision.operationId!=='upgrade:'+upgradeId||decision.kind!=='format-upgrade'||decision.phase!=='verified'||decision.abandonedAt)throw new Error('请重新打开原课程并核对未发布升级与写入资格');
  await source.pause();const flag=new SharedArrayBuffer(4);Atomics.store(new Int32Array(flag),0,1);
  const live:Live={source,held:flag,decision,request:{sessionId:'',upgradeId,directory:decision.targetDirectory,backupDirectory:decision.report.backupDirectory}};this.live.set(sourceDirectory,live);return live;
 }
 async publish(sourceDirectory:string,upgradeId:string,source?:Source){
  const current=directoryStatus(sourceDirectory);
  if(current.decision?.phase==='published'){
   if(current.decision.operationId!=='upgrade:'+upgradeId)throw new Error('该源目录已发布另一升级');return (await this.recover(sourceDirectory)).decision!;
  }
  const live=await this.reacquire(sourceDirectory,upgradeId,source);
  try{
   const result:DirectoryDecision=await this.proof('publish',live);this.live.delete(sourceDirectory);await live.source.release();return result;
  }catch(e){
   const actual=directoryStatus(sourceDirectory),published=actual.decision?.phase==='published';
   await durableJSON(join(live.decision.targetDirectory,'upgrade-diagnostic.json'),{schema:'yizhi-upgrade-diagnostic-1',phase:published?'published-needs-recovery':'unfinished',message:(e as Error).message,backupDirectory:live.decision.report.backupDirectory});
   this.live.delete(sourceDirectory);if(published)await live.source.release();else await live.source.resume(!!live.request.automatic);throw e;
  }finally{Atomics.store(new Int32Array(live.held),0,0);}
 }
 async cancel(sourceDirectory:string,upgradeId:string,source?:Source){
  const live=await this.reacquire(sourceDirectory,upgradeId,source);
  const result=await this.proof('cancel',live);Atomics.store(new Int32Array(live.held),0,0);this.live.delete(sourceDirectory);await live.source.resume();return result;
 }
}
