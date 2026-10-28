import type { DatabaseSync } from 'node:sqlite';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { HistoryChange } from '../history-api';
import { equal } from '../editor-api';
export function unitObjects(unit:CourseUnit):Map<string,Record<string,any>> {
  const objects=new Map<string,Record<string,any>>();
  const walk=(blocks:ReadingBlock[],parent:string)=>{
    objects.set(`structure:${parent}`,{blockIds:blocks.map(b=>b.id)});
    for(const block of blocks) {const {children,...self}=block;objects.set(block.id,self);walk(children??[],block.id);}
  };
  walk(unit.reading.blocks,unit.id);return objects;
}
export function objectVersions(db:DatabaseSync,unit:CourseUnit) {
  const read=db.prepare('SELECT version FROM cg_objects WHERE id=?');
  return new Map([...unitObjects(unit).keys()].map(id=>[id,Number(read.get(id)?.version??0)]));
}
/** Actual changed objects only, including descendants and their original parent/order. */
export function unitChanges(db:DatabaseSync,before:CourseUnit,after:CourseUnit,versions:Map<string,number>):HistoryChange[] {
  const a=unitObjects(before),b=unitObjects(after),changes:HistoryChange[]=[];
  for(const id of new Set([...a.keys(),...b.keys()])) {
    const old=a.get(id)??null,next=b.get(id)??null;
    if(equal(old,next))continue;
    // A removed parent retains its empty structure identity, just as a removed block retains a tombstone.
    changes.push({objectId:id,before:old,after:next,beforeVersion:versions.get(id)??Number(db.prepare('SELECT version FROM cg_objects WHERE id=?').get(id)?.version??1)-1,
      afterVersion:Number(db.prepare('SELECT version FROM cg_objects WHERE id=?').get(id)?.version??0)});
  }
  return changes;
}
