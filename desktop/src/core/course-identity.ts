import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

/** OS-released write ownership across portable aliases, independent of publication facts.
 * The file contains no course data and is never a recovery authority or a PID/TTL lock.
 */
export function claimPortableIdentity(courseId:string){
 const directory=join(tmpdir(),'yizhi-portable-identity-'+(process.getuid?.()??'user'));mkdirSync(directory,{recursive:true,mode:0o700});
 const owner=new DatabaseSync(join(directory,createHash('sha256').update(courseId).digest('hex')+'.sqlite'));
 try{owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');return owner;}catch{owner.close();throw new Error('同一课程身份已由另一目录或应用持有写入资格；请先关闭原课程');}
}
