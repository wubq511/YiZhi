import type { DatabaseSync } from 'node:sqlite';
import type { BackupResource } from '../backup-api';

/** Enumerate DECLARED refs, including missing files. Opaque operation/content digests are not resources.
 * Conservative extra refs in retained payloads are intentional; disk enumeration cannot prove completeness.
 */
function resourceDeclarations(){
 const refs=new Map<string,BackupResource>();
 const add=(hash:string,length:unknown,where:string)=>{
  if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('声明的资源摘要无效: '+where);
  if(length!==undefined&&(!Number.isSafeInteger(length)||Number(length)<0))throw new Error('声明的资源长度无效: '+where);
  const old=refs.get(hash);if(old&&length!==undefined&&old.byteLength!==null&&old.byteLength!==length)throw new Error('同一资源声明长度冲突: '+hash);
  if(old){if(length!==undefined)old.byteLength=Number(length);if(!old.declaredBy.includes(where))old.declaredBy.push(where);}
  else refs.set(hash,{sha256:hash,byteLength:length===undefined?null:Number(length),path:'resources/'+hash,declaredBy:[where]});
 };
 const walk=(v:any,where:string)=>{
  // Text/chat/code are opaque strings, even when their bytes look like a resource path.
  // Bare paths are declarations only in the actual figure payload schema below.
  if(typeof v==='string')return;
  if(!v||typeof v!=='object')return;
  if(Array.isArray(v)){for(const x of v)walk(x,where);return;}
  if(v.kind==='figure'&&typeof v.payload?.asset==='string'){
   const match=/^resources\/([a-f0-9]{64})$/.exec(v.payload.asset);if(match)add(match[1],undefined,where);
  }
  if(typeof v.sha256==='string'&&(v.byteLength!==undefined||v.relativePath!==undefined||typeof v.path==='string'&&v.path.startsWith('resources/'))){
   if(v.relativePath!==undefined&&v.relativePath!=='resources/'+v.sha256||typeof v.path==='string'&&v.path.startsWith('resources/')&&v.path!=='resources/'+v.sha256)throw new Error('资源路径与固定摘要不符: '+where);
   add(v.sha256,v.byteLength,where);
  }
  for(const x of Object.values(v))walk(x,where);
 };
 const required=(v:any,where:string)=>{
  if(!v||typeof v.sha256!=='string'||v.byteLength===undefined)throw new Error('资源声明缺少摘要或长度: '+where);
  add(v.sha256,v.byteLength,where);walk(v,where);
 };
 const list=(v:any,where:string)=>{if(!Array.isArray(v))throw new Error('资源声明清单无效: '+where);for(const r of v)required(r,where);};
 return {walk,required,list,sorted:()=>[...refs.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256))};
}
/** Trusted producer payload enumeration shares the same resource grammar as the snapshot scan. */
export function declaredResourcesIn(values:Iterable<unknown>,where:string):BackupResource[]{
 const declarations=resourceDeclarations();for(const value of values)declarations.walk(value,where);return declarations.sorted();
}
export function declaredResourceRoots(db:DatabaseSync):BackupResource[]{
 const {walk,required,list,sorted}=resourceDeclarations();
 const has=(table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
 // Required declarations are validated by their actual schema even when a redundant payload
 // elsewhere still happens to contain the same hash. Never silently omit a malformed root.
 for(const table of ['source_versions','exchange_resources'])if(has(table))for(const row of db.prepare(`SELECT payload FROM ${table}`).all())required(JSON.parse(String(row.payload)),table+'.payload');
 if(has('parse_artifacts'))for(const row of db.prepare('SELECT payload FROM parse_artifacts').all()){
  const ref=JSON.parse(String(row.payload));required(ref.resource,'parse_artifacts.payload');list(ref.resources,'parse_artifacts.payload');
 }
 if(has('extension_packages'))for(const row of db.prepare('SELECT manifest FROM extension_packages').all())list(JSON.parse(String(row.manifest)).resources,'extension_packages.manifest');
 if(has('metadata')){const legacy=db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();if(legacy)list(JSON.parse(String(legacy.value)).report?.resources,'metadata.value');}
 // Actual schema, including producer recovery domains. No renderer supplies SQL/resolver code.
 for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
  const name=String(table.name),quoted='"'+name.replaceAll('"','""')+'"';
  for(const c of db.prepare(`PRAGMA table_info(${quoted})`).all()){
   if(!/TEXT|JSON/i.test(String(c.type)))continue;
   const column='"'+String(c.name).replaceAll('"','""')+'"';
   for(const row of db.prepare(`SELECT ${column} v FROM ${quoted} WHERE ${column} IS NOT NULL`).iterate()){
    const text=String(row.v);if(!text.includes('resources/')&&!text.includes('"sha256"')&&!text.includes('"sourceSha"'))continue;
    try{walk(JSON.parse(text),name+'.'+String(c.name));}catch(e){if(text.startsWith('{')||text.startsWith('['))throw e;}
   }
  }
 }
 return sorted();
}
