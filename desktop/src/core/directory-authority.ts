import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join,resolve,dirname,basename } from 'node:path';
import { acquireLegacyLease,coursePath,legacySaveBarrier } from './migration';
import { hashFile } from './immutable-resource';
const schema='yizhi-directory-transition-1',sourceMarker=(root:string)=>existsSync(join(root,'课程.json'))?join(root,'.review-board','directory-transition.json'):join(root,'directory-transition.json'),targetMarker=(root:string)=>join(root,'directory-authority.json');
const parse=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export interface DirectoryDecision {schema:typeof schema;id:string;operationId:string;kind:'legacy-migration'|'format-upgrade';courseId:string;sourceDirectory:string;targetDirectory:string;sourceVersion:Record<string,unknown>;phase:'verified'|'published';preparedAt:string;publishedAt?:string;abandonedAt?:string;proof:{databaseSha256:string;resources:Array<{path:string;sha256:string;byteLength:number}>};report:any}
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
  return {courseId:m.courseId,generation:Number(metadata.generation),sequence:Number(metadata.sequence),saveBarrier:legacySaveBarrier(root,m.courseId,Number(metadata.generation),Number(metadata.sequence)),manifest:hashFile(join(root,'课程.json')).sha256,knowledge:hashFile(coursePath(root,m.knowledge)).sha256,layout:hashFile(coursePath(root,m.layout)).sha256,state:hashFile(state).sha256,wal:existsSync(state+'-wal')&&lstatSync(state+'-wal').size?hashFile(state+'-wal').sha256:null};
 }finally{db.close();}
}
export function sealDirectory(root:string){
 const proof={databaseSha256:hashFile(join(root,'course.sqlite')).sha256,resources:[] as Array<{path:string;sha256:string;byteLength:number}>};
 const db=new DatabaseSync(join(root,'course.sqlite'),{readOnly:true});
 try{
  const required=new Map<string,number|undefined>();
  const add=(r:any)=>{if(!r||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256))throw new Error('登记资源缺少可核对摘要');const size=r.byteLength??r.size,previous=required.get(r.sha256);if(previous!==undefined&&size!==undefined&&previous!==size)throw new Error('同一登记资源的长度事实不一致');required.set(r.sha256,size??previous);};
  const read=(table:string,column:string)=>db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)?db.prepare(`SELECT ${column} payload FROM ${table}`).all().map(r=>JSON.parse(String(r.payload))):[];
  for(const v of read('source_versions','payload'))add(v);
  for(const v of read('parse_artifacts','payload')){add(v.resource);for(const r of v.resources??[])add(r);}
  for(const v of read('exchange_resources','payload'))add(v);
  for(const v of read('extension_packages','manifest'))for(const r of v.resources??[])add(r);
  const legacy=db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();if(legacy)for(const r of JSON.parse(String(legacy.value)).report.resources)add(r);
  for(const [sha,size] of required){const file=join(root,'resources',sha);if(!existsSync(file))throw new Error('登记资源缺失：'+sha);const actual=hashFile(file);if(actual.sha256!==sha||size!==undefined&&actual.byteLength!==size)throw new Error('登记资源摘要或长度不符：'+sha);}
 }finally{db.close();}
 const folder=join(root,'resources');if(existsSync(folder))for(const name of readdirSync(folder).sort()){
  const path=join(folder,name);if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('目标资源存在非普通文件');
  const value=hashFile(path);if(/^[a-f0-9]{64}$/.test(name)&&value.sha256!==name)throw new Error('目标资源摘要不符');proof.resources.push({path:'resources/'+name,...value});
 }return proof;
}
function verifyTarget(v:DirectoryDecision){if(!equal(sealDirectory(v.targetDirectory),v.proof))throw new Error('已核验目标发生变化，未发布切换');}
/** No writable DB is opened just to resolve the authority. A prepared copy cannot self-publish. */
function readDirectoryDecision(directory:string):DirectoryDecision|null {
 const root=realpathSync(directory),path=existsSync(sourceMarker(root))?sourceMarker(root):existsSync(targetMarker(root))?targetMarker(root):undefined;
 return path?checked(path):null;
}
export function admitDirectory(directory:string){
 if(existsSync(join(directory,'课程.json'))&&!existsSync(join(directory,'course.sqlite')))throw new Error('旧课程须先完成迁移，不能作为新版课程写入');
 if(existsSync(sourceMarker(directory))){const v=checked(sourceMarker(directory));if(v.phase==='published')throw new Error('原目录已迁移，只有已核验目标可写：'+v.targetDirectory);}
 if(!existsSync(targetMarker(directory)))return;
 const v=checked(targetMarker(directory));if(v.phase==='published'){
  const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});
  try{if(db.prepare("SELECT value FROM metadata WHERE key='courseId'").get()?.value!==v.courseId)throw new Error('本地课程身份与发布证明不符，拒绝写入');}finally{db.close();}return;
 }
 const source=existsSync(sourceMarker(v.sourceDirectory))?checked(sourceMarker(v.sourceDirectory)):null;
 if(source?.phase!=='published'||source.id!==v.id||!equal(source.proof,v.proof))throw new Error('此迁移目标尚未发布，仍以原目录为准');
 verifyTarget({...source,targetDirectory:directory});durableDecision(targetMarker(directory),source);
}
export interface DirectoryStatus {directory:string;role:'source'|'target'|'ordinary';phase:'verified'|'published'|'ordinary'|'abandoned';decision:DirectoryDecision|null;targetAvailable:boolean}
export function directoryStatus(directory:string):DirectoryStatus {
 const root=realpathSync(directory),decision=readDirectoryDecision(root),role=existsSync(sourceMarker(root))?'source':existsSync(targetMarker(root))?'target':'ordinary';
 return {directory:root,role,phase:decision?.abandonedAt?'abandoned':decision?.phase??'ordinary',decision,targetAvailable:role==='target'&&decision?.phase==='published'||!!decision&&existsSync(decision.targetDirectory)};
}
export function recoverDirectory(directory:string){
 const status=directoryStatus(directory),v=status.decision;if(!v)return {directory:status.directory,decision:null};
 if(status.role==='target'){admitDirectory(status.directory);return {directory:status.directory,decision:v};}
 if(v.sourceDirectory!==status.directory)throw new Error('源目录身份与原发布事实不符，只能只读核对原记录');
 if(v.phase==='verified')return {directory:status.directory,decision:v};
 if(!existsSync(v.targetDirectory))throw new Error('原路径的已发布目标不存在；请选择完整迁移后课程的当前位置，原目录仍只读');
 admitDirectory(v.targetDirectory);return {directory:realpathSync(v.targetDirectory),decision:v};
}

const live=new Map<string,{lease:Awaited<ReturnType<typeof acquireLegacyLease>>;decision:DirectoryDecision}>();
const archivePath=(source:string,operationId:string)=>join(dirname(sourceMarker(source)),'directory-transitions',createHash('sha256').update(operationId).digest('hex')+'.json');
export function directoryTransition(request:{sourceDirectory:string;operationId:string}){
 const source=realpathSync(request.sourceDirectory),current=readDirectoryDecision(source),path=archivePath(source,request.operationId);
 return existsSync(path)?checked(path):current?.operationId===request.operationId?current:null;
}
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
  await cp(candidate,target,{recursive:true,force:false,errorOnExist:false});
  const report=await materialize(target,source),decision={...preparing,report,proof:sealDirectory(target)};
  if(!equal(sourceVersion(source),version))throw new Error('源版本已变化，不能发布');
  durableDecision(targetMarker(target),decision);durableDecision(sourceMarker(source),decision);
  live.set(source,{lease,decision});return decision;
 }catch(error){await lease.close();throw error;}
}
async function gate(buffer?:SharedArrayBuffer){if(!buffer)return;const flag=new Int32Array(buffer);Atomics.store(flag,0,1);Atomics.notify(flag,0);while(Atomics.load(flag,0)===1)await new Promise(r=>setTimeout(r,10));}
/** T26 supplies its own quiesced-source lease and verified upgrade stage; no legacy conversion is required. */
export interface DirectoryPublicationLease {assertHeld():void|Promise<void>;close():Promise<void>}
export async function publishVerifiedDirectory(decision:DirectoryDecision,lease:DirectoryPublicationLease,scheduling?:CutoverScheduling){
 try{
  if(decision.phase!=='verified'||decision.abandonedAt||!decision.operationId||!decision.id||decision.sourceDirectory===decision.targetDirectory)throw new Error('只能发布具有独立源与目标的已核验切换，已放弃身份不可复用');
  await gate(scheduling?.beforePublish);await lease.assertHeld();verifyTarget(decision);
  const existing=existsSync(sourceMarker(decision.sourceDirectory))?checked(sourceMarker(decision.sourceDirectory)):null;
  if(existing?.abandonedAt||existing?.phase==='verified'&&(existing.id!==decision.id||existing.operationId!==decision.operationId||!equal(existing.proof,decision.proof)))throw new Error('源准备身份已变化或放弃，拒绝覆盖');
  if(existing?.phase==='published'&&existing.id!==decision.id)throw new Error('源目录已发布另一权威，不能覆盖完成事实');
  const receipt:DirectoryDecision=existing?.phase==='published'?existing:{...decision,phase:'published',publishedAt:new Date().toISOString()};
  durableDecision(sourceMarker(receipt.sourceDirectory),receipt); // Sole atomic authority commit point.
  await gate(scheduling?.afterPublish);durableDecision(targetMarker(receipt.targetDirectory),receipt);return receipt;
 }finally{await lease.close();}
}
export async function publishDirectory(request:{sourceDirectory:string;operationId:string},scheduling?:CutoverScheduling){
 const source=realpathSync(request.sourceDirectory),saved=readDirectoryDecision(source);
 if(saved?.phase==='published'){if(saved.operationId!==request.operationId)throw new Error('该源课程已由另一迁移发布');admitDirectory(saved.targetDirectory);return saved;}
 const own=live.get(source);if(!own||own.decision.operationId!==request.operationId)throw new Error('切换租约已失效，须重新核对源版本并准备');
 return publishVerifiedDirectory(own.decision,{assertHeld(){if(own.lease.child.exitCode!==null||!equal(sourceVersion(source),own.decision.sourceVersion))throw new Error('源写入资格或源版本已变化，拒绝切换');},async close(){live.delete(source);await own.lease.close();}},scheduling);
}
