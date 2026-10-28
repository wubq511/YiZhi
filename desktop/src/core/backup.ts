import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative,dirname,basename,sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BackupManifest, BackupRequest, BackupScheduling, FileDigest } from '../backup-api';
import { declaredResourceRoots } from './retention-resources';

const MANIFEST='backup-manifest.json',MARKER='backup-complete.json';
export async function durableJSON(path:string,value:unknown) {
 const file=await open(path+'.partial','w',0o600);
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 await rename(path+'.partial',path);
 const folder=await open(resolve(path,'..'),'r');try{await folder.sync();}finally{await folder.close();}
}
export async function fileDigest(path:string):Promise<FileDigest> {
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();if(!stat.isFile())throw new Error('资源不是普通文件: '+path);
  const hash=createHash('sha256');let byteLength=0;
  for await(const chunk of handle.createReadStream({autoClose:false})){hash.update(chunk);byteLength+=chunk.length;}
  return {sha256:hash.digest('hex'),byteLength};
 }finally{await handle.close();}
}
const equal=(a:FileDigest,b:FileDigest)=>a.sha256===b.sha256&&a.byteLength===b.byteLength;
async function gate(buffer?:SharedArrayBuffer){if(!buffer)return;const a=new Int32Array(buffer);Atomics.store(a,0,1);while(Atomics.load(a,0)===1)await new Promise(r=>setTimeout(r,5));}
async function jsonFile(path:string){return JSON.parse(await readFile(path,'utf8'));}
async function exists(path:string){try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}

/** Runs outside the ordered Core queue. Only the durable resource lease uses live DB writes. */
export class CourseBackups {
 private running=new Set<string>();
 constructor(private scheduling?:BackupScheduling){}
 async status(directory:string):Promise<BackupManifest>{
  const manifest:BackupManifest=await jsonFile(join(directory,MANIFEST));
  if(manifest.schema!=='yizhi-full-backup-1')throw new Error('不是完整课程备份');
  if(!await exists(join(directory,MARKER)))return {...manifest,phase:'unfinished',diagnostic:manifest.diagnostic??'备份未完成；请按原备份身份重试'};
  const marker=await jsonFile(join(directory,MARKER));
  if(marker.backupId!==manifest.backupId||!equal(marker.manifest,await fileDigest(join(directory,MANIFEST))))throw new Error('备份完成标记与清单不符');
  return manifest;
 }
 async verify(directory:string):Promise<BackupManifest>{
  const m=await this.status(directory);if(m.phase!=='complete'||!m.database)throw new Error('备份未完成，不能打开');
  if(!equal(m.database,await fileDigest(join(directory,'course.sqlite'))))throw new Error('备份数据库摘要不符');
  for(const r of m.resources){const d=await fileDigest(join(directory,r.path));if(d.sha256!==r.sha256||r.byteLength!==d.byteLength)throw new Error('备份资源摘要不符: '+r.path);}
  const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new Error('备份数据库结构损坏');}finally{db.close();}
  return m;
 }
 async create(request:BackupRequest,source:{directory:string;courseId:string;acquire:()=>void;release:()=>void},resume=false):Promise<BackupManifest>{
  const selected=resolve(request.directory),directory=join(await realpath(dirname(selected)),basename(selected)),origin=await realpath(source.directory);
  if(!request.backupId||!/^[\w-]{1,120}$/.test(request.backupId))throw new Error('备份身份无效');
  const outside=(path:string)=>path==='..'||path.startsWith('..'+sep);
  if(directory===origin||!outside(relative(origin,directory))||!outside(relative(directory,origin)))throw new Error('备份必须使用课程外的独立新目录');
  if(resume&&(await lstat(directory)).isSymbolicLink())throw new Error('备份目录不能是软链');
  if(this.running.has(directory))throw new Error('此备份正在进行');this.running.add(directory);
  let m:BackupManifest|undefined;
  try{
   if(resume){m=await jsonFile(join(directory,MANIFEST));if(m!.backupId!==request.backupId||m!.courseId!==source.courseId||m!.sourceDirectory!==origin)throw new Error('重试必须使用原课程和备份身份');
    if(await exists(join(directory,MARKER))){const result=await this.verify(directory);source.release();return result;}
   }else{
    await mkdir(directory); // Never adopt an existing arbitrary directory.
    m={schema:'yizhi-full-backup-1',backupId:request.backupId,courseId:source.courseId,sourceDirectory:origin,createdAt:new Date().toISOString(),phase:'snapshotting',resources:[],runtime:{node:process.versions.node,electron:process.versions.electron,sqlite:''}};
    await durableJSON(join(directory,MANIFEST),m);
   }
   source.acquire();
   const snapshot=join(directory,'backup-snapshot.sqlite');
   if(!m!.snapshot){
    await rm(snapshot,{force:true});await rm(snapshot+'.partial',{force:true});
    const db=new DatabaseSync(join(origin,'course.sqlite'),{readOnly:true});
    try{m!.runtime.sqlite=String(db.prepare('SELECT sqlite_version() v').get()!.v);await backup(db,snapshot+'.partial',{rate:64});}finally{db.close();}
    await rename(snapshot+'.partial',snapshot);
    m!.snapshot=await fileDigest(snapshot);
   }else if(!equal(m!.snapshot,await fileDigest(snapshot)))throw new Error('重试的原始快照摘要不符，拒绝混入新 live 清单');
   const rootDB=new DatabaseSync(snapshot,{readOnly:true});
   try{
    const declared=declaredResourceRoots(rootDB);
    if(m!.rootsExtracted&&JSON.stringify(declared)!==JSON.stringify(m!.resources))throw new Error('重试资源清单与原始快照不符');
    m!.resources=declared;m!.rootsExtracted=true;
   }finally{rootDB.close();}
   m!.phase='copying';delete m!.diagnostic;await durableJSON(join(directory,MANIFEST),m);
   await gate(this.scheduling?.afterSnapshot);
   const resourceFolder=await lstat(join(origin,'resources')).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT'&&!m!.resources.length)return undefined;throw e;});
   if(resourceFolder&&(!resourceFolder.isDirectory()||resourceFolder.isSymbolicLink()))throw new Error('课程资源目录不是独立目录');
   await mkdir(join(directory,'resources'),{recursive:true});
   await gate(this.scheduling?.beforeCopy);
   for(const r of m!.resources){
    const target=join(directory,r.path);
    if(await exists(target)){const d=await fileDigest(target);if(d.sha256===r.sha256&&(r.byteLength===null||r.byteLength===d.byteLength))continue;}
    const input=join(origin,r.path),partial=target+'.partial';
    const handle=await open(input,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{await pipeline(handle.createReadStream({autoClose:false}),createWriteStream(partial,{flags:'w',mode:0o600}));}finally{await handle.close();}
    const d=await fileDigest(partial);if(d.sha256!==r.sha256||r.byteLength!==null&&d.byteLength!==r.byteLength)throw new Error('资源摘要或长度不符: '+r.path);
    const fd=await open(partial,'r');try{await fd.sync();}finally{await fd.close();}await rename(partial,target);
   }
   // Final DB is built from the SAME immutable snapshot. Retry never takes a newer database.
   await rm(join(directory,'course.sqlite'),{force:true});
   const copied=new DatabaseSync(snapshot,{readOnly:true});try{await backup(copied,join(directory,'course.sqlite'));}finally{copied.close();}
   const finalDB=new DatabaseSync(join(directory,'course.sqlite'));
   try{
    finalDB.prepare("UPDATE retention_resource_leases SET state='released',released_at=? WHERE id=?").run(m!.createdAt,'backup:'+request.backupId);
    const report=finalDB.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
    if(report)await durableJSON(join(directory,'content-candidate.json'),JSON.parse(String(report.value)).report);
    finalDB.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
   }finally{finalDB.close();}
   m!.database=await fileDigest(join(directory,'course.sqlite'));
   // Resolve bare content-addressed refs to exact lengths from verified snapshot files.
   for(const r of m!.resources)if(r.byteLength===null)r.byteLength=(await fileDigest(join(directory,r.path))).byteLength;
   await gate(this.scheduling?.beforeMarker);
   m!.phase='complete';delete m!.diagnostic;await durableJSON(join(directory,MANIFEST),m);
   const folder=await open(join(directory,'resources'),'r');try{await folder.sync();}finally{await folder.close();}
   await durableJSON(join(directory,MARKER),{schema:'yizhi-full-backup-complete-1',backupId:m!.backupId,manifest:await fileDigest(join(directory,MANIFEST))});
   source.release();
   await rm(snapshot,{force:true});return m!;
  }catch(e){if(m&&!await exists(join(directory,MARKER))){m.phase='unfinished';m.diagnostic=String((e as Error).message);await durableJSON(join(directory,MANIFEST),m);}throw e;}
  finally{this.running.delete(directory);}
 }
}
