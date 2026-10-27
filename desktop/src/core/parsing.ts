import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, constants, openSync, closeSync, readSync, lstatSync } from 'node:fs';
import { appendEvent, transaction } from './save-store';
import { hashFile } from './immutable-resource';
import { PARSE_CONFIG, PARSE_TOOL, publishBytes } from './parsing-tool';
import type { Sources } from './sources';
import type { ArtifactRef, ArtifactResource, ParseTask, ParsedPage, ParseScheduling } from '../parsing-api';
import type { SourceCommand } from '../sources-api';
const encode = JSON.stringify;
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const now = () => new Date().toISOString();

/** SQLite authority in the one Core; page tools own no database and never hold its dispatch queue. */
export class Parsing {
  private tools = new Set<Worker>();
  private closing = false;
  constructor(private db: DatabaseSync, private directory: string, private sources: Sources,
    private enqueue: (run: () => void) => void, private scheduling?: ParseScheduling) {
    db.exec(`CREATE TABLE IF NOT EXISTS parse_tasks(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parse_artifacts(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES source_versions(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parse_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT);`);
    for (const row of db.prepare('SELECT payload FROM parse_tasks').all()) {
      const task = JSON.parse(String(row.payload)) as ParseTask;
      if (task.status === 'running') {
        task.status = 'interrupted'; task.failure = '应用中断；已确认页面保留，请明确继续';
        const attempt = task.attempts.at(-1)!; attempt.failure = task.failure; attempt.finishedAt = now(); this.put(task);
      }
    }
  }
  private generation() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value); }
  private put(task: ParseTask) { this.db.prepare('INSERT INTO parse_tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(task.taskId,encode(task)); }
  get(taskId: string): ParseTask {
    if (!validId(taskId)) throw new Error('无效的解析任务');
    const row = this.db.prepare('SELECT payload FROM parse_tasks WHERE id=?').get(taskId);
    if (!row) throw new Error('解析任务不存在');
    const task = JSON.parse(String(row.payload)) as ParseTask;
    if (task.status === 'running' && !this.eligible(task)) { task.status = 'stopped'; task.failure = '任务资格已停止或课程代际已变化'; }
    return task;
  }
  private eligible(task: ParseTask) {
    const attempt = this.db.prepare('SELECT task_id,generation,status FROM cg_attempts WHERE id=?').get(task.attemptId);
    return !this.closing && task.generation === this.generation() && attempt?.task_id === task.taskId &&
      Number(attempt.generation) === task.generation && attempt.status === 'running';
  }
  list() { return this.db.prepare('SELECT id FROM parse_tasks ORDER BY rowid DESC').all().map(row=>this.get(String(row.id))); }
  query(operationId: string) { const row=this.db.prepare('SELECT receipt FROM parse_operations WHERE id=?').get(operationId); return row?.receipt ? JSON.parse(String(row.receipt)) : null; }
  private identity(kind: string, command: SourceCommand) {
    if (!validId(command.operationId)) throw new Error('无效的解析操作身份');
    const { sessionId: _, ...identity } = command;
    const hash = digest([kind,identity]);
    const old = this.db.prepare('SELECT digest,receipt FROM parse_operations WHERE id=?').get(command.operationId);
    if (old) { if (old.digest !== hash) throw new Error('同一操作不能换用不同内容');
      if(!old.receipt && command.generation!==this.generation()) throw new Error('课程代际已变化');
      return { hash, old:old.receipt ? JSON.parse(String(old.receipt)) : undefined }; }
    if (['operations','cg_candidates','source_operations','source_imports'].some(table=>this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(command.operationId)))
      throw new Error('操作身份已用于其他课程修改');
    if (command.generation !== this.generation()) throw new Error('课程代际已变化');
    this.db.prepare('INSERT INTO parse_operations VALUES (?,?,NULL)').run(command.operationId,hash);
    return { hash };
  }
  private receipt(command: SourceCommand, hash: string, value: unknown) {
    this.db.prepare('UPDATE parse_operations SET receipt=? WHERE id=? AND digest=?').run(encode(value),command.operationId,hash);
  }
  start(command: SourceCommand & { versionId: string }) {
    const identity = this.identity('start',command); if(identity.old) return identity.old as ParseTask;
    const source=this.sources.version(command.versionId);
    if(source.mediaType !== 'application/pdf') throw new Error('当前解析入口仅支持 PDF；图片需要另行 OCR');
    const task: ParseTask={taskId:randomUUID(),source,generation:command.generation,operationId:command.operationId,
      attemptId:randomUUID(),tool:PARSE_TOOL,config:PARSE_CONFIG,status:'running',confirmed:[],attempts:[]};
    transaction(this.db,()=>{
      this.newAttempt(task,command.operationId); this.put(task);
      appendEvent(this.db,{type:'parse.changed',taskId:task.taskId,attemptId:task.attemptId,kind:'started'});
      this.receipt(command,identity.hash,task);
    });
    this.launch(task); return task;
  }
  private newAttempt(task: ParseTask, operationId: string) {
    this.db.prepare('INSERT INTO cg_attempts VALUES (?,?,?,?)').run(task.attemptId,task.taskId,task.generation,'running');
    task.attempts.push({attemptId:task.attemptId,generation:task.generation,operationId,startedAt:now(),pagesStarted:[]});
  }
  continue(command: SourceCommand & {taskId:string}) {
    const identity=this.identity('continue',command); if(identity.old) return identity.old as ParseTask;
    const task=this.get(command.taskId);
    if(task.status==='running' || task.status==='completed') throw new Error('该任务正在运行或已经完成；重新解析请创建新任务');
    if(task.tool.version!==PARSE_TOOL.version || task.tool.adapter!==PARSE_TOOL.adapter || encode(task.config)!==encode(PARSE_CONFIG)) throw new Error('工具或配置已变化，请新建解析版本');
    transaction(this.db,()=>{
      this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=? AND status='running'").run(task.attemptId);
      const old=task.attempts.at(-1)!; old.finishedAt ??=now(); old.failure ??=task.failure ?? '已停止';
      task.attemptId=randomUUID(); task.generation=command.generation; task.status='running'; delete task.failure;
      this.newAttempt(task,command.operationId); this.put(task);
      appendEvent(this.db,{type:'parse.changed',taskId:task.taskId,attemptId:task.attemptId,kind:'continued'});
      this.receipt(command,identity.hash,task);
    });
    this.launch(task); return task;
  }
  stop(command: SourceCommand & {taskId:string;attemptId:string}) {
    const identity=this.identity('stop',command); if(identity.old) return identity.old as ParseTask;
    const task=this.get(command.taskId);
    if(task.attemptId!==command.attemptId) throw new Error('旧尝试不能停止新的解析尝试');
    return transaction(this.db,()=>{
      this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=?").run(task.attemptId);
      if(task.status!=='completed') { task.status='stopped'; task.attempts.at(-1)!.finishedAt=now(); }
      this.put(task); appendEvent(this.db,{type:'parse.changed',taskId:task.taskId,attemptId:task.attemptId,kind:'stopped'});
      this.receipt(command,identity.hash,task); return task;
    });
  }
  private stageId(task:ParseTask,pageIndex:number) {return `parse-stage:${digest([task.operationId,task.attemptId,pageIndex])}`;}
  private launch(task: ParseTask) {
    const pageIndex=Array.from({length:task.source.pdfPages},(_,i)=>i).find(i=>!task.confirmed.some(ref=>ref.pdfPageIndex===i));
    if(pageIndex===undefined) return;
    try {
      transaction(this.db,()=>{
        const operationId=this.stageId(task,pageIndex);
        if(['operations','cg_candidates','source_operations','source_imports','parse_operations'].some(table=>this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(operationId))) throw new Error('解析阶段操作身份已被使用');
        this.db.prepare('INSERT INTO parse_operations VALUES (?,?,NULL)').run(operationId,digest([task.attemptId,pageIndex]));
        task.attempts.at(-1)!.pagesStarted.push(pageIndex); this.put(task);
      });
      const tool=new Worker(join(__dirname,'parsing-tool.cjs'), {workerData:{kind:'parse-page',directory:this.directory,
        source:task.source,pageIndex,scheduling:this.scheduling}});
      this.tools.add(tool); let delivered=false;
      const receive=(message:any)=>{
        if(delivered) return; delivered=true;
        this.enqueue(()=>{
          if(this.closing) return;
          const current=this.get(task.taskId);
          // Same ordered eligibility boundary as commands.stop, generation changes and short course writes.
          if(current.attemptId!==task.attemptId || current.status!=='running' || !this.eligible(current)) {
            transaction(this.db,()=>{
              const attempt=current.attempts.find(a=>a.attemptId===task.attemptId)!;
              (attempt.outputs ??=[]).push({pdfPageIndex:pageIndex,status:'rejected',digest:message.resource?.sha256,failure:'迟到回调没有当前任务资格'});
              this.put(current);
            });return;
          }
          if(!message.ok) { this.fail(current,message.error); return; }
          try {
            transaction(this.db,()=>{
              if(!this.eligible(current)) throw new Error('解析登记资格已停止');
              const operationId=this.stageId(current,pageIndex);
              const ref:ArtifactRef={artifactId:randomUUID(),taskId:current.taskId,attemptId:current.attemptId,operationId,
                pdfPageIndex:pageIndex,digest:message.resource.sha256,resource:message.resource,resources:message.resources,confirmedAt:now(),origin:'parser'};
              this.db.prepare('INSERT INTO parse_artifacts VALUES (?,?,?)').run(ref.artifactId,current.source.versionId,encode(ref));
              (current.attempts.at(-1)!.outputs ??=[]).push({pdfPageIndex:pageIndex,status:'confirmed',digest:ref.digest});
              current.confirmed.push(ref); current.confirmed.sort((a,b)=>a.pdfPageIndex-b.pdfPageIndex);
              if(current.confirmed.length===current.source.pdfPages) { current.status='completed';current.attempts.at(-1)!.finishedAt=now();
                this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=?").run(current.attemptId); }
              this.put(current); this.db.prepare('UPDATE parse_operations SET receipt=? WHERE id=?').run(encode(ref),operationId);
              appendEvent(this.db,{type:'parse.changed',taskId:current.taskId,attemptId:current.attemptId,kind:'page-confirmed',artifactId:ref.artifactId});
            });
            if(current.status==='running') this.launch(current);
          } catch(error) { this.fail(this.get(task.taskId),(error as Error).message,{pdfPageIndex:pageIndex,digest:message.resource?.sha256}); }
        });
      };
      tool.on('message',receive); tool.on('error',error=>receive({ok:false,error:error.message}));
      tool.on('exit',code=>{this.tools.delete(tool);if(!delivered) receive({ok:false,error:`解析工具异常退出 (${code})`});});
    } catch(error) { this.fail(task,(error as Error).message); }
  }
  private fail(task:ParseTask,message:string, output?:{pdfPageIndex:number;digest?:string}) {
    transaction(this.db,()=>{
      task.status='failed';task.failure=String(message).slice(0,2000);
      const attempt=task.attempts.at(-1)!;
      (attempt.outputs ??=[]).push({pdfPageIndex:output?.pdfPageIndex ?? attempt.pagesStarted.at(-1)!,status:'failed',digest:output?.digest,failure:task.failure});
      attempt.failure=task.failure;attempt.finishedAt=now();this.put(task);
      this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=?").run(task.attemptId);
    });
  }
  artifacts(versionId:string) { this.sources.version(versionId);return this.db.prepare('SELECT payload FROM parse_artifacts WHERE version_id=? ORDER BY rowid').all(versionId).map(row=>JSON.parse(String(row.payload)) as ArtifactRef); }
  private ref(artifactId:string):ArtifactRef {
    if(!validId(artifactId)) throw new Error('无效的产物身份');
    const row=this.db.prepare('SELECT payload FROM parse_artifacts WHERE id=?').get(artifactId);
    if(!row) throw new Error('产物尚未确认或不存在');return JSON.parse(String(row.payload));
  }
  artifact(artifactId:string):ParsedPage {
    const ref=this.ref(artifactId),path=join(this.directory,ref.resource.relativePath);
    const actual=hashFile(path);
    if(actual.sha256!==ref.digest || actual.byteLength!==ref.resource.byteLength) throw new Error('结构化产物损坏，请保留旧引用并重新解析');
    if(actual.byteLength>8_000_000) throw new Error('产物超出当前读取范围');
    return JSON.parse(readFileSync(path,'utf8'));
  }
  async correct(command:SourceCommand & {artifactId:string;textId:string;text:string;note:string}) {
    const identity=this.identity('correct',command);if(identity.old) return identity.old as ArtifactRef;
    if(!validId(command.textId) || typeof command.text!=='string' || command.text.length>100000 || typeof command.note!=='string' || !command.note.trim() || command.note.length>2000) throw new Error('请提供有效文字及修正依据');
    const parent=this.ref(command.artifactId), page=this.artifact(command.artifactId);
    const text=page.text.find(t=>t.id===command.textId);if(!text) throw new Error('修正目标文字不存在；扫描页需要 OCR');
    text.text=command.text;text.corrected=true;page.correction={parentArtifactId:parent.artifactId,note:command.note,correctedAt:now()};
    const resource=await publishBytes(join(this.directory,'resources'),Buffer.from(encode(page)),'application/json');
    return transaction(this.db,()=>{
      if(command.generation!==this.generation()) throw new Error('课程代际已变化');
      const ref:ArtifactRef={...parent,artifactId:randomUUID(),operationId:command.operationId,digest:resource.sha256,resource,parentArtifactId:parent.artifactId,origin:'student-correction',confirmedAt:now()};
      this.db.prepare('INSERT INTO parse_artifacts VALUES (?,?,?)').run(ref.artifactId,page.source.versionId,encode(ref));
      appendEvent(this.db,{type:'parse.changed',taskId:ref.taskId,attemptId:ref.attemptId,kind:'corrected',artifactId:ref.artifactId});
      this.receipt(command,identity.hash,ref);return ref;
    });
  }
  readResource(request:{artifactId:string;sha256:string;begin:number;end:number}) {
    const ref=this.ref(request.artifactId);
    const resource=[ref.resource,...ref.resources].find(r=>r.sha256===request.sha256);
    if(!resource) throw new Error('产物资源未登记');
    const {begin,end}=request;
    if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin||end>resource.byteLength||end-begin>1024*1024) throw new Error('产物资源范围无效');
    const path=join(this.directory,resource.relativePath);
    if(lstatSync(join(this.directory,'resources')).isSymbolicLink()) throw new Error('产物资源目录无效');
    const actual=hashFile(path);
    if(actual.sha256!==resource.sha256||actual.byteLength!==resource.byteLength) throw new Error('产物资源损坏');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try { const bytes=new Uint8Array(end-begin);let offset=0;
      while(offset<bytes.length) { const n=readSync(fd,bytes,offset,bytes.length-offset,begin+offset);if(!n)throw new Error('产物资源读取不完整');offset+=n; }
      return {bytes,total:resource.byteLength,mediaType:resource.mediaType};
    } finally {closeSync(fd);}
  }
  async close() { this.closing=true;await Promise.all([...this.tools].map(tool=>tool.terminate()));this.tools.clear(); }
  dispatch(action:string,payload:any):unknown {
    const method=action.slice('parsing:'.length);
    if(method==='readResource')return this.readResource(payload);
    if(method==='get')return this.get(payload.taskId);if(method==='list')return this.list();
    if(method==='artifact')return this.artifact(payload.artifactId);if(method==='artifacts')return this.artifacts(payload.versionId);
    if(method==='query')return this.query(payload.operationId);
    if(method==='start')return this.start(payload);if(method==='continue')return this.continue(payload);
    if(method==='stop')return this.stop(payload);if(method==='correct')return this.correct(payload);
    throw new Error('未知解析命令');
  }
}
