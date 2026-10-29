import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { hashFile } from './immutable-resource';
import { declaredResourceRoots } from './retention-resources';
export const schema='yizhi-directory-transition-1',sourceMarker=(root:string)=>existsSync(join(root,'课程.json'))?join(root,'.review-board','directory-transition.json'):join(root,'directory-transition.json'),targetMarker=(root:string)=>join(root,'directory-authority.json');
export const parse=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
export const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export interface DirectoryDecision {schema:typeof schema;id:string;operationId:string;kind:'legacy-migration'|'format-upgrade';courseId:string;sourceDirectory:string;targetDirectory:string;sourceVersion:Record<string,unknown>;phase:'verified'|'published';preparedAt:string;publishedAt?:string;abandonedAt?:string;proof:{databaseSha256:string;resources:Array<{path:string;sha256:string;byteLength:number}>};report:any}
export interface CutoverScheduling {beforePublish?:SharedArrayBuffer;afterPublish?:SharedArrayBuffer}
export function durableDecision(path:string,value:unknown){
 mkdirSync(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.partial',fd=openSync(temp,'wx');
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);
 const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
export function checked(path:string):DirectoryDecision {
 const v=parse(path);if(v.schema!==schema||!v.id||!v.operationId||!v.courseId||!['verified','published'].includes(v.phase)||!v.sourceDirectory||!v.targetDirectory||!v.sourceVersion||!v.proof)throw new Error('切换完成事实无效，拒绝写入');
 if(v.phase==='published'&&(!v.publishedAt||!/^[a-f0-9]{64}$/.test(v.proof.databaseSha256)))throw new Error('切换完成事实缺失');return v;
}
export function sealDirectory(root:string){
 const proof={databaseSha256:hashFile(join(root,'course.sqlite')).sha256,resources:[] as Array<{path:string;sha256:string;byteLength:number}>};
 const db=new DatabaseSync(join(root,'course.sqlite'),{readOnly:true});
 try{
  const required=new Map(declaredResourceRoots(db).map(r=>[r.sha256,r.byteLength??undefined]));
  for(const [sha,size] of required){const file=join(root,'resources',sha);if(!existsSync(file))throw new Error('登记资源缺失：'+sha);const actual=hashFile(file);if(actual.sha256!==sha||size!==undefined&&actual.byteLength!==size)throw new Error('登记资源摘要或长度不符：'+sha);}
 }finally{db.close();}
 const folder=join(root,'resources');if(existsSync(folder))for(const name of readdirSync(folder).sort()){
  const path=join(folder,name);if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('目标资源存在非普通文件');
  const value=hashFile(path);if(/^[a-f0-9]{64}$/.test(name)&&value.sha256!==name)throw new Error('目标资源摘要不符');proof.resources.push({path:'resources/'+name,...value});
 }return proof;
}
export function verifyTarget(v:DirectoryDecision){if(!equal(sealDirectory(v.targetDirectory),v.proof))throw new Error('已核验目标发生变化，未发布切换');}
/** No writable DB is opened just to resolve the authority. A prepared copy cannot self-publish. */
export function readDirectoryDecision(directory:string):DirectoryDecision|null {
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

export const archivePath=(source:string,operationId:string)=>join(dirname(sourceMarker(source)),'directory-transitions',createHash('sha256').update(operationId).digest('hex')+'.json');
export function directoryTransition(request:{sourceDirectory:string;operationId:string}){
 const source=realpathSync(request.sourceDirectory),current=readDirectoryDecision(source),path=archivePath(source,request.operationId);
 return existsSync(path)?checked(path):current?.operationId===request.operationId?current:null;
}
async function gate(buffer?:SharedArrayBuffer){if(!buffer)return;const flag=new Int32Array(buffer);Atomics.store(flag,0,1);Atomics.notify(flag,0);while(Atomics.load(flag,0)===1)await new Promise(r=>setTimeout(r,10));}
/** T26 supplies its own quiesced-source lease and verified upgrade stage; no legacy conversion is required. */
export interface DirectoryPublicationLease {assertHeld():void|Promise<void>;close():Promise<void>}
/** New-format consumers use the SAME source/target facts and sealing protocol as legacy migration. */
export async function beginVerifiedDirectory(decision:Omit<DirectoryDecision,'proof'>,lease:DirectoryPublicationLease){
 await lease.assertHeld();
 if(decision.kind!=='format-upgrade'||decision.phase!=='verified'||decision.abandonedAt||!decision.id||!decision.operationId||decision.sourceDirectory===decision.targetDirectory)throw new Error('升级准备身份无效');
 if(existsSync(archivePath(decision.sourceDirectory,decision.operationId)))throw new Error('此升级身份已放弃，不能重新绑定');
 if(existsSync(sourceMarker(decision.sourceDirectory))&&!checked(sourceMarker(decision.sourceDirectory)).abandonedAt)throw new Error('原目录已有切换准备，请先核对或放弃原准备');
 if(existsSync(decision.targetDirectory))throw new Error('升级工作副本必须使用全新目录');
 mkdirSync(decision.targetDirectory);
 durableDecision(targetMarker(decision.targetDirectory),{...decision,proof:{databaseSha256:'',resources:[]}});
}
export async function prepareVerifiedDirectory(decision:Omit<DirectoryDecision,'proof'>,lease:DirectoryPublicationLease){
 await lease.assertHeld();const preparing=checked(targetMarker(decision.targetDirectory));
 if(preparing.id!==decision.id||preparing.operationId!==decision.operationId||preparing.phase!=='verified'||preparing.abandonedAt)throw new Error('升级工作副本准备身份变化');
 const verified:DirectoryDecision={...decision,proof:sealDirectory(decision.targetDirectory)};
 await lease.assertHeld();durableDecision(targetMarker(verified.targetDirectory),verified);durableDecision(sourceMarker(verified.sourceDirectory),verified);return verified;
}
export async function abandonVerifiedDirectory(request:{sourceDirectory:string;operationId:string},lease:DirectoryPublicationLease){
 try{
  await lease.assertHeld();const path=sourceMarker(request.sourceDirectory);if(!existsSync(path))return null;
  const current=checked(path);if(current.operationId!==request.operationId||current.phase==='published')throw new Error('只能放弃匹配的未发布升级准备');
  if(current.abandonedAt)return current;
  const abandoned={...current,abandonedAt:new Date().toISOString()};durableDecision(archivePath(request.sourceDirectory,current.operationId),abandoned);durableDecision(path,abandoned);return abandoned;
 }finally{await lease.close();}
}
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
