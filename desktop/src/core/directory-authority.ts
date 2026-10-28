import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { acquireLegacyLease,coursePath } from './migration';
import { hashFile } from './immutable-resource';
const schema='yizhi-directory-transition-1',sourceMarker=(root:string)=>join(root,'.review-board','directory-transition.json'),targetMarker=(root:string)=>join(root,'directory-authority.json');
const parse=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export interface DirectoryDecision {schema:typeof schema;id:string;operationId:string;kind:'legacy-migration';courseId:string;sourceDirectory:string;targetDirectory:string;sourceVersion:Record<string,unknown>;phase:'verified'|'published';preparedAt:string;publishedAt?:string;proof:{databaseSha256:string;resources:Array<{path:string;sha256:string;byteLength:number}>};report:any}
export interface CutoverScheduling {beforePublish?:SharedArrayBuffer;afterPublish?:SharedArrayBuffer}
export function durableDecision(path:string,value:unknown){
 mkdirSync(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.partial',fd=openSync(temp,'wx');
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);
 const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
function checked(path:string):DirectoryDecision {
 const v=parse(path);if(v.schema!==schema||!v.id||!v.operationId||!v.courseId||!['verified','published'].includes(v.phase)||!v.sourceDirectory||!v.targetDirectory||!v.sourceVersion||!v.proof)throw new Error('切换完成事实无效，拒绝写入');
 if(v.phase==='published'&&(!v.publishedAt||!/^[a-f0-9]{64}$/.test(v.proof.databaseSha256)))throw new Error('切换完成事实缺失');return v;
}
export function sourceVersion(root:string){
 const m=parse(join(root,'课程.json')),state=coursePath(root,m.state),db=new DatabaseSync(state,{readOnly:true});
 try {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_journal'").get()&&db.prepare('SELECT 1 FROM content_journal').get())throw new Error('旧内容事务尚未完成，请正常重开并关闭旧服务后迁移');
  const metadata=db.prepare('SELECT * FROM course_metadata').get()!;
  return {courseId:m.courseId,generation:Number(metadata.generation),sequence:Number(metadata.sequence),manifest:hashFile(join(root,'课程.json')).sha256,knowledge:hashFile(coursePath(root,m.knowledge)).sha256,layout:hashFile(coursePath(root,m.layout)).sha256,state:hashFile(state).sha256,wal:existsSync(state+'-wal')&&lstatSync(state+'-wal').size?hashFile(state+'-wal').sha256:null};
 }finally{db.close();}
}
export function sealDirectory(root:string){
 const proof={databaseSha256:hashFile(join(root,'course.sqlite')).sha256,resources:[] as Array<{path:string;sha256:string;byteLength:number}>};
 const folder=join(root,'resources');if(existsSync(folder))for(const name of readdirSync(folder).sort()){
  const path=join(folder,name);if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('目标资源存在非普通文件');
  const value=hashFile(path);if(/^[a-f0-9]{64}$/.test(name)&&value.sha256!==name)throw new Error('目标资源摘要不符');proof.resources.push({path:'resources/'+name,...value});
 }return proof;
}
function verifyTarget(v:DirectoryDecision){if(!equal(sealDirectory(v.targetDirectory),v.proof))throw new Error('已核验目标发生变化，未发布切换');}
/** No writable DB is opened just to resolve the authority. A prepared copy cannot self-publish. */
export function directoryStatus(directory:string):DirectoryDecision|null {
 const root=realpathSync(directory),path=existsSync(sourceMarker(root))?sourceMarker(root):existsSync(targetMarker(root))?targetMarker(root):undefined;
 return path?checked(path):null;
}
export function admitDirectory(directory:string){
 if(existsSync(join(directory,'课程.json'))&&!existsSync(join(directory,'course.sqlite')))throw new Error('旧课程须先完成迁移，不能作为新版课程写入');
 if(existsSync(sourceMarker(directory))){const v=checked(sourceMarker(directory));if(v.phase==='published')throw new Error('原目录已迁移，只有已核验目标可写：'+v.targetDirectory);}
 if(!existsSync(targetMarker(directory)))return;
 const v=checked(targetMarker(directory));if(v.phase==='published')return;
 const source=existsSync(sourceMarker(v.sourceDirectory))?checked(sourceMarker(v.sourceDirectory)):null;
 if(source?.phase!=='published'||source.id!==v.id||!equal(source.proof,v.proof))throw new Error('此迁移目标尚未发布，仍以原目录为准');
 verifyTarget(source);durableDecision(targetMarker(directory),source);
}
export function recoverDirectory(directory:string){
 const v=directoryStatus(directory);if(!v)return {directory:realpathSync(directory),decision:null};
 if(v.phase==='verified')return {directory:v.sourceDirectory,decision:v};
 admitDirectory(v.targetDirectory);return {directory:v.targetDirectory,decision:v};
}
const live=new Map<string,{lease:Awaited<ReturnType<typeof acquireLegacyLease>>;decision:DirectoryDecision}>();
export async function closeDirectoryLeases(){for(const {lease} of live.values())await lease.close();live.clear();}
export async function prepareDirectory(request:{sourceDirectory:string;contentCandidateDirectory:string;directory:string;operationId:string},materialize:(directory:string,source:string)=>Promise<any>){
 const source=realpathSync(request.sourceDirectory),target=resolve(request.directory),candidate=realpathSync(request.contentCandidateDirectory);
 if(typeof request.operationId!=='string'||!request.operationId||request.operationId.length>160)throw new Error('切换操作身份无效');
 if(existsSync(target)||target.startsWith(source+'/')||source.startsWith(target+'/')||candidate===source)throw new Error('切换目标必须为源课程外的全新目录');
 if(!existsSync(join(candidate,'content-candidate.json')))throw new Error('须提供已完成的T24内容候选');
 const lease=await acquireLegacyLease(source);lease.child.stdin!.write(JSON.stringify({action:'hold'})+'\n');
 try{
  const version=sourceVersion(source),id=randomUUID();mkdirSync(target);
  const preparing={schema,id,operationId:request.operationId,courseId:version.courseId,kind:'legacy-migration',sourceDirectory:source,targetDirectory:target,sourceVersion:version,phase:'verified',preparedAt:new Date().toISOString(),proof:{databaseSha256:'',resources:[]},report:null} as DirectoryDecision;
  durableDecision(targetMarker(target),preparing);
  await cp(candidate,target,{recursive:true,force:false,errorOnExist:false});
  const report=await materialize(target,source),decision={...preparing,report,proof:sealDirectory(target)};
  if(!equal(sourceVersion(source),version))throw new Error('源版本已变化，不能发布');
  durableDecision(targetMarker(target),decision);durableDecision(sourceMarker(source),decision);
  live.set(source,{lease,decision});return decision;
 }catch(error){await lease.close();throw error;}
}
async function gate(buffer?:SharedArrayBuffer){if(!buffer)return;const flag=new Int32Array(buffer);Atomics.store(flag,0,1);Atomics.notify(flag,0);while(Atomics.load(flag,0)===1)await new Promise(r=>setTimeout(r,10));}
export async function publishDirectory(request:{sourceDirectory:string;operationId:string},scheduling?:CutoverScheduling){
 const source=realpathSync(request.sourceDirectory),saved=directoryStatus(source);
 if(saved?.phase==='published'){if(saved.operationId!==request.operationId)throw new Error('该源课程已由另一迁移发布');admitDirectory(saved.targetDirectory);return saved;}
 const own=live.get(source);if(!own||own.decision.operationId!==request.operationId)throw new Error('切换租约已失效，须重新核对源版本并准备');
 try{
  await gate(scheduling?.beforePublish);
  if(own.lease.child.exitCode!==null||!equal(sourceVersion(source),own.decision.sourceVersion))throw new Error('源写入资格或源版本已变化，拒绝切换');
  verifyTarget(own.decision);
  const receipt:DirectoryDecision={...own.decision,phase:'published',publishedAt:new Date().toISOString()};
  durableDecision(sourceMarker(source),receipt); // The single atomic authority commit point.
  await gate(scheduling?.afterPublish);
  durableDecision(targetMarker(receipt.targetDirectory),receipt);live.delete(source);await own.lease.close();return receipt;
 }catch(error){live.delete(source);await own.lease.close();throw error;}
}
