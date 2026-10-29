import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {cp} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireLegacyLease,legacySaveBarrier} from './migration';
import {coursePath} from '../../desktop/src/core/course-path';
import {hashFile} from '../../desktop/src/core/immutable-resource';
import {parse,schema,sourceMarker,targetMarker,archivePath,readDirectoryDecision,checked,equal,verifyTarget,durableDecision,admitDirectory,sealDirectory,publishVerifiedDirectory,type DirectoryDecision,type CutoverScheduling} from '../../desktop/src/core/directory-authority';
export {directoryStatus,recoverDirectory,directoryTransition} from '../../desktop/src/core/directory-authority';
export function sourceVersion(root:string){
 const m=parse(join(root,'课程.json')),state=coursePath(root,m.state),db=new DatabaseSync(state,{readOnly:true});
 try {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_journal'").get()&&db.prepare('SELECT 1 FROM content_journal').get())throw new Error('旧内容事务尚未完成，请正常重开并关闭旧服务后迁移');
  const metadata=db.prepare('SELECT * FROM course_metadata').get()!;
  return {courseId:m.courseId,generation:Number(metadata.generation),sequence:Number(metadata.sequence),saveBarrier:legacySaveBarrier(root,m.courseId,Number(metadata.generation),Number(metadata.sequence)),manifest:hashFile(join(root,'课程.json')).sha256,knowledge:hashFile(coursePath(root,m.knowledge)).sha256,layout:hashFile(coursePath(root,m.layout)).sha256,state:hashFile(state).sha256,wal:existsSync(state+'-wal')&&lstatSync(state+'-wal').size?hashFile(state+'-wal').sha256:null};
 }finally{db.close();}
}
const live=new Map<string,{lease:Awaited<ReturnType<typeof acquireLegacyLease>>;decision:DirectoryDecision}>();
/** Abandon only an unpublished intent under the same writer admission lease. */
export async function abandonDirectory(request:{sourceDirectory:string;operationId:string}){
 const source=realpathSync(request.sourceDirectory),current=readDirectoryDecision(source);
 if(!current||current.operationId!==request.operationId)throw new Error('没有匹配的未发布准备，原操作身份不能重绑定');
 if(current.phase==='published')throw new Error('已发布切换不能放弃或覆盖');
 if(current.abandonedAt)return current;
 const own=live.get(source),lease=own?.lease??await acquireLegacyLease(source);if(!own)lease.child.stdin!.write(JSON.stringify({action:'hold'})+'\n');
 try{if(lease.child.exitCode!==null)throw new Error('放弃准备前写入租约已失效');const abandoned={...current,abandonedAt:new Date().toISOString()};durableDecision(archivePath(source,current.operationId),abandoned);durableDecision(sourceMarker(source),abandoned);return abandoned;}
 finally{live.delete(source);await lease.close();}
}
export async function closeDirectoryLeases(){for(const {lease} of live.values())await lease.close();live.clear();}
export async function prepareDirectory(request:{sourceDirectory:string;contentCandidateDirectory:string;directory:string;operationId:string},materialize:(directory:string,source:string)=>Promise<any>){
 const source=realpathSync(request.sourceDirectory),target=join(realpathSync(dirname(resolve(request.directory))),basename(request.directory));
 if(typeof request.operationId!=='string'||!request.operationId||request.operationId.length>160)throw new Error('切换操作身份无效');
 const saved=readDirectoryDecision(source);
 if(existsSync(archivePath(source,request.operationId)))throw new Error('此操作身份已放弃，不能绑定新准备；请使用新身份');
 if(saved&&!saved.abandonedAt){
  if(saved.operationId!==request.operationId||saved.targetDirectory!==target)throw new Error('该源目录已有另一切换身份或不同目标，请先核对原切换');
  if(saved.phase==='published'){admitDirectory(target);return saved;}
  if(!equal(sourceVersion(source),saved.sourceVersion))throw new Error('源版本已变化，原准备不可继续，请选择新目标并重新转换');
  verifyTarget(saved);
  if(!live.has(source)){const lease=await acquireLegacyLease(source);lease.child.stdin!.write(JSON.stringify({action:'hold'})+'\n');
   try{if(!equal(sourceVersion(source),saved.sourceVersion))throw new Error('源版本已变化，不能重新取得旧切换资格');live.set(source,{lease,decision:saved});}catch(error){await lease.close();throw error;}}
  return saved;
 }
 if(existsSync(target)||target.startsWith(source+'/')||source.startsWith(target+'/'))throw new Error('切换目标必须为源课程外的全新目录');
 const candidate=realpathSync(request.contentCandidateDirectory);if(candidate===source)throw new Error('内容候选不能是原目录');
 if(!existsSync(join(candidate,'content-candidate.json')))throw new Error('须提供已完成的T24内容候选');
 const lease=await acquireLegacyLease(source);lease.child.stdin!.write(JSON.stringify({action:'hold'})+'\n');
 try{
  const version=sourceVersion(source),id=randomUUID();mkdirSync(target);
  const preparing={schema,id,operationId:request.operationId,courseId:version.courseId,kind:'legacy-migration',sourceDirectory:source,targetDirectory:target,sourceVersion:version,phase:'verified',preparedAt:new Date().toISOString(),proof:{databaseSha256:'',resources:[]},report:null} as DirectoryDecision;
  durableDecision(targetMarker(target),preparing);
  // Staging never inherits a candidate's write qualification: its own verified
  // guard must remain in place throughout copying and materialization.
  await cp(candidate,target,{recursive:true,force:false,errorOnExist:false,filter:path=>path!==targetMarker(candidate)&&path!==sourceMarker(candidate)});
  const report=await materialize(target,source),decision={...preparing,report,proof:sealDirectory(target)};
  if(!equal(sourceVersion(source),version))throw new Error('源版本已变化，不能发布');
  durableDecision(targetMarker(target),decision);durableDecision(sourceMarker(source),decision);
  live.set(source,{lease,decision});return decision;
 }catch(error){await lease.close();throw error;}
}
export async function publishDirectory(request:{sourceDirectory:string;operationId:string},scheduling?:CutoverScheduling){
 const source=realpathSync(request.sourceDirectory),saved=readDirectoryDecision(source);
 if(saved?.phase==='published'){if(saved.operationId!==request.operationId)throw new Error('该源课程已由另一迁移发布');admitDirectory(saved.targetDirectory);return saved;}
 const own=live.get(source);if(!own||own.decision.operationId!==request.operationId)throw new Error('切换租约已失效，须重新核对源版本并准备');
 return publishVerifiedDirectory(own.decision,{assertHeld(){if(own.lease.child.exitCode!==null||!equal(sourceVersion(source),own.decision.sourceVersion))throw new Error('源写入资格或源版本已变化，拒绝切换');},async close(){live.delete(source);await own.lease.close();}},scheduling);
}
