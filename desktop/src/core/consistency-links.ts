import type { CourseUnit,ReadingBlock } from '../shared';
import { equal } from '../editor-api';
import { unitBlocks } from '../reading-model';
export { unitBlocks } from '../reading-model';
export const isBuiltin=(block?:ReadingBlock)=>block?.kind==='interactive'&&['mux','decoder','kmap'].includes(block.payload.component);
export const linkedExperiment=(block?:ReadingBlock):string|undefined=>block?.kind==='formula'&&typeof block.payload.experimentBlockId==='string'?block.payload.experimentBlockId:undefined;
const definitionFields=(block?:ReadingBlock)=>block&&[block.kind,block.payload.component,block.payload.config,block.payload.inputs,block.payload.bindings,block.payload.necessaryRelationIds];
/** Both sides participate: new, removed and retargeted links require proof too. */
export function changedCouplings(before:CourseUnit,after:CourseUnit):Set<string> {
 const old=new Map(unitBlocks(before).map(b=>[b.id,b])),next=new Map(unitBlocks(after).map(b=>[b.id,b])),required=new Set<string>();
 for(const id of new Set([...old.keys(),...next.keys()])){
  const a=old.get(id),b=next.get(id);
  if((isBuiltin(a)||isBuiltin(b))&&!equal(definitionFields(a),definitionFields(b)))required.add(id);
  const left=linkedExperiment(a),right=linkedExperiment(b);
  if((left||right)&&!equal(a?.payload,b?.payload)){if(left)required.add(left);if(right)required.add(right);}
 }
 return required;
}
