import type { DatabaseSync } from 'node:sqlite';

/** Actual current/recovery dependencies, not a copy of formal or hidden content.
 * The Worker registers this predicate with T23's trusted resource-root registry. */
export function generationRetentionResourceRoot(db:DatabaseSync,sha256:string):boolean {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_bases'").get())return false;
  const bases=db.prepare(`SELECT b.payload FROM generation_bases b
    JOIN agent_tasks t ON t.attempt_id=b.attempt_id
    WHERE (json_extract(t.payload,'$.status')<>'completed' AND json_extract(t.payload,'$.continuedByTaskId') IS NULL)
      OR EXISTS(SELECT 1 FROM generation_candidates c
        WHERE c.attempt_id=b.attempt_id AND json_extract(c.result,'$.status')='retained'
          AND json_extract(c.proposal,'$.basisId')=b.id)`).all();
  for(const row of bases){
    const basis=JSON.parse(String(row.payload));
    if(basis.sourceSha===sha256||basis.artifactDigest===sha256)return true;
    const artifact=db.prepare('SELECT payload FROM parse_artifacts WHERE id=?').get(basis.spec.artifactId);
    if(!artifact)continue;
    const ref=JSON.parse(String(artifact.payload));
    if(ref.resource.sha256===sha256||ref.resources.some((resource:{sha256:string})=>resource.sha256===sha256))return true;
  }
  return false;
}
