import type { DatabaseSync } from 'node:sqlite';
import type { BackupResource } from '../backup-api';

/** Actual current/recovery dependencies, not a copy of formal or hidden content.
 * The Worker registers this predicate with T23's trusted resource-root registry. */
export function generationRetentionResourceRoot(db:DatabaseSync,sha256:string):boolean {
  return generationRetentionResourceRoots(db).some(r=>r.sha256===sha256);
}
/** Enumerates even a declared missing artifact; backup must not infer roots from existing files. */
export function generationRetentionResourceRoots(db:DatabaseSync):BackupResource[] {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_bases'").get())return [];
  const refs=new Map<string,BackupResource>();
  const add=(sha256:string,byteLength:number|null=null)=>{if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('生成恢复资源摘要无效');refs.set(sha256,{sha256,byteLength,path:'resources/'+sha256,declaredBy:['generation_bases.payload']});};
  const bases=db.prepare(`SELECT b.payload FROM generation_bases b
    JOIN agent_tasks t ON t.attempt_id=b.attempt_id
    WHERE (json_extract(t.payload,'$.status')<>'completed' AND json_extract(t.payload,'$.continuedByTaskId') IS NULL)
      OR EXISTS(SELECT 1 FROM generation_candidates c
        WHERE c.attempt_id=b.attempt_id AND json_extract(c.result,'$.status')='retained'
          AND json_extract(c.proposal,'$.basisId')=b.id)`).all();
  for(const row of bases){
    const basis=JSON.parse(String(row.payload));
    add(basis.sourceSha);add(basis.artifactDigest);
    const artifact=db.prepare('SELECT payload FROM parse_artifacts WHERE id=?').get(basis.spec.artifactId);
    if(!artifact)continue;
    const ref=JSON.parse(String(artifact.payload));
    for(const r of [ref.resource,...ref.resources])add(r.sha256,r.byteLength);
  }
  return [...refs.values()];
}
