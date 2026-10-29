// Opt-in, local-only acceptance. The input is read/copied as files; never opened by Core/SQLite.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {cp,mkdir,readFile,readdir,rename,writeFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {developmentDirectory} from './paths.mjs';
const output=developmentDirectory(fileURLToPath(new URL('../..',import.meta.url)));
const require=createRequire(import.meta.url),{DevelopmentCourseService:CourseService}=require(join(output,'course-service.cjs'));
const script=fileURLToPath(import.meta.url),worker=join(output,'worker.cjs');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
async function fileHash(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function treeHashes(directory){const files={};async function walk(prefix=''){for(const name of (await readdir(join(directory,prefix))).sort()){
 const relative=join(prefix,name),path=join(directory,relative),stat=await lstat(path);assert.ok(!stat.isSymbolicLink(),'evidence must contain ordinary files');
 if(stat.isDirectory())await walk(relative);else files[relative]=await fileHash(path);
 }}await walk();return files;}
function service(){const clock=new SharedArrayBuffer(8);Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()));return new CourseService(worker,{retentionScheduling:{clock,manual:true}});}
async function capture(directory){
 const core=service();try{
  const c=await core.open(directory),graph=await core.graph(c.sessionId),units={},drafts={};
  for(const node of graph.nodes){units[node.id]=await core.readUnit(c.sessionId,node.id);drafts[node.id]=(await core.read(c.sessionId,node.id)).drafts;}
  const records=[],history=[],operations=[];let after,before;
  do{const page=await core.migration.records({...c,after,limit:100});records.push(...page.records);after=page.next;}while(after);
  do{const page=await core.migration.history({...c,before,limit:100});history.push(...page.entries);before=page.next;}while(before);
  // IDs/checkpoint facts have no public list API. Read only this OWN COPY; receipts themselves use Core.
  const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});let receiptIds,checkpointFacts;
  try{receiptIds=db.prepare('SELECT id FROM migration_receipts ORDER BY id').all().map(r=>String(r.id));checkpointFacts=JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE key='legacy-checkpoint-facts'").get().value));}finally{db.close();}
  for(const operationId of receiptIds)operations.push(await core.migration.operation({...c,operationId}));
  const list=await core.agent.list(c),conversations=[];for(const chat of list.conversations)conversations.push(await core.agent.get({...c,conversationId:chat.id}));
  const sources=await core.sources.list(c);for(const version of sources.versions){const bytes=await core.sources.readResource({...c,versionId:version.versionId,begin:0,end:Math.min(64,version.byteLength)});assert.equal(bytes.total,version.byteLength);assert.ok(bytes.bytes.length>0);}
  const resources={};for(const name of (await readdir(join(directory,'resources'))).sort())if(/^[a-f0-9]{64}$/.test(name)){resources[name]=await fileHash(join(directory,'resources',name));assert.equal(resources[name],name);}
  const data={courseId:c.courseId,generation:c.generation,eventCursor:c.eventCursor,graph,units,drafts,records,history,operations,checkpointFacts,
   notes:await core.annotations.list(c),drawings:await core.drawings.list(c),reading:await core.readingState(c.sessionId),review:await core.reviewStates(c.sessionId),
   sources,citations:await core.sources.citations(c),sourceContext:await core.sources.context(c),pending:await core.migration.pending(c),conversations,
   retentionDays:(await core.retention.get(c)).days,legacy:await core.migration.content(c),resources};
  const facts={units:graph.nodes.length,themes:graph.groups.length,relations:graph.edges.length,resources:Object.keys(resources).length,registeredSources:sources.versions.length,
   origins:records.length,history:history.length,receipts:operations.length,checkpointFacts:checkpointFacts.length,checkpointTimesUnknown:checkpointFacts.every(v=>v.committedAt===null),
   notes:data.notes.length,orphanNotes:data.notes.filter(n=>n.current.status==='orphan').length,noteTombstones:records.filter(r=>r.namespace==='notes'&&r.deleted).length,
   conversations:conversations.length,messages:conversations.reduce((n,c)=>n+c.messages.length,0),tasks:conversations.reduce((n,c)=>n+c.tasks.length,0),
   completedTasks:conversations.flatMap(c=>c.tasks).every(t=>t.status==='completed'),unresolvedDrafts:data.pending.filter(p=>p.state==='unresolved').length,retentionDays:data.retentionDays};
  return {courseFormat:c.courseFormat,runtime:c.runtime,facts,semanticSha256:digest(data),domains:Object.fromEntries(Object.entries(data).map(([key,value])=>[key,digest(value)]))};
 }finally{await core.close();}
}
async function child(executable,args){await new Promise((resolve,reject)=>{const p=spawn(executable,[script,...args],{stdio:'inherit',shell:false,env:{...process.env,...(executable!==process.execPath?{ELECTRON_RUN_AS_NODE:'1'}:{})}});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('independent verification exited '+code)));});}
const [mode,...args]=process.argv.slice(2);
if(mode==='_capture'){
 const result=await capture(resolve(args[0]));await writeFile(args[1],JSON.stringify(result,null,2));console.log(JSON.stringify({stage:'independent-open',directory:args[0],...result}));
}else if(mode==='_archive'){
 const core=service();try{const c=await core.open(resolve(args[0]));await core.backup.create({...c,directory:resolve(args[1]),backupId:'actual-format2-archive'});await core.backup.verify({directory:resolve(args[1])});}finally{await core.close();}
}else{
 if(!mode||!args[0])throw new Error('Usage: node tools/desktop/verify-upgrade.mjs READ_ONLY_EVIDENCE NEW_ROOT [T25_RECONCILIATION]');
 const evidence=resolve(mode),root=resolve(args[0]),original=await treeHashes(evidence);await mkdir(root);const source=join(root,'source COPY'),target=join(root,'upgrade target'),beforeBackup=join(root,'before-upgrade full backup'),portable=join(root,'portable format2 中文 course'),archive=join(root,'format2 full backup'),restored=join(root,'restored format2');
 await cp(evidence,source,{recursive:true});const baseline=await capture(source);assert.equal(baseline.courseFormat,1);
 if(args[1]){
  const accepted=JSON.parse(await readFile(args[1],'utf8'));for(const [key,value] of Object.entries({units:84,themes:20,relations:43,resources:44,registeredSources:16,origins:accepted.verified.documents,history:accepted.verified.history,receipts:accepted.verified.operations,checkpointFacts:51,notes:1,orphanNotes:1,noteTombstones:1,conversations:2,messages:4,tasks:2,unresolvedDrafts:1,retentionDays:140}))assert.equal(baseline.facts[key],value,key);
  assert.equal(baseline.facts.checkpointTimesUnknown,true);assert.equal(baseline.facts.completedTasks,true);
 }
 await writeFile(join(root,'baseline.json'),JSON.stringify(baseline,null,2));console.log(JSON.stringify({stage:'baseline',...baseline}));
 const core=service();let publication;try{
  const c=await core.open(source);const preparation=await core.upgrade.prepare({...c,directory:target,backupDirectory:beforeBackup,upgradeId:'actual-personal-1-to-2'});
  assert.equal(preparation.phase,'verified');assert.equal(preparation.kind,'format-upgrade');await core.backup.verify({directory:beforeBackup});
  publication=await core.upgrade.publish({...c,upgradeId:'actual-personal-1-to-2'});assert.equal(publication.phase,'published');
 }finally{await core.close();}
 const upgraded=await capture(target);assert.equal(upgraded.courseFormat,2);assert.deepEqual(upgraded.domains,baseline.domains,'all public semantic domains survived upgrade');
 await cp(target,portable,{recursive:true});await rename(source,source+' hidden');await rename(target,target+' hidden');
 const embedded=createRequire(new URL('../../desktop/package.json',import.meta.url))('electron');await child(embedded,['_capture',portable,join(root,'portable.json')]);const moved=JSON.parse(await readFile(join(root,'portable.json'),'utf8'));assert.deepEqual(moved.domains,baseline.domains);
 await child(embedded,['_archive',portable,archive]);
 const verifier=service();let manifest;try{manifest=await verifier.backup.verify({directory:archive});assert.equal(manifest.resources.length,baseline.facts.resources);}finally{await verifier.close();}
 const archiveBefore=await treeHashes(archive); // Archive verified BEFORE any writable restore open.
 await cp(archive,restored,{recursive:true});await child(embedded,['_capture',restored,join(root,'restored.json')]);const restoredResult=JSON.parse(await readFile(join(root,'restored.json'),'utf8'));assert.deepEqual(restoredResult.domains,baseline.domains);
 assert.deepEqual(await treeHashes(archive),archiveBefore,'immutable archive unchanged by opening its restore copy');assert.deepEqual(await treeHashes(evidence),original,'input evidence unchanged');
 const result={schema:'yizhi-t26-actual-acceptance-1',evidence,root,portable,archive,restored,beforeBackup,publicationId:publication.id,originalEvidenceFiles:original,originalEvidenceUnchanged:true,archiveVerifiedBeforeWritableRestore:true,
  format:2,facts:baseline.facts,semanticSha256:baseline.semanticSha256,domainHashes:baseline.domains,runtimes:{upgrade:upgraded.runtime,portable:moved.runtime,archive:manifest.runtime,restore:restoredResult.runtime},archiveManifestSha256:await fileHash(join(archive,'backup-manifest.json'))};
 await writeFile(join(root,'reconciliation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({stage:'complete',...result}));
}
