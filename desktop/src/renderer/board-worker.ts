import { projectBoard, type BoardNode, type BoardScene } from '../board-layout';
import type { CourseGraph } from '../shared';

export interface BoardProjectionRequest {
  id:number;
  graph:CourseGraph;
  placements:BoardNode[];
  level:'themes'|'units';
  relationView:string;
}
export type BoardProjectionResponse = {id:number;scene:BoardScene} | {id:number;error:string};

// The complete relationship graph remains in the worker; the UI receives one
// consistent projection and never computes a full route set on a camera frame.
self.onmessage=(event:MessageEvent<BoardProjectionRequest>)=>{
  const {id,graph,placements,level,relationView}=event.data;
  try {self.postMessage({id,scene:projectBoard(graph,placements,level,relationView)} satisfies BoardProjectionResponse);}
  catch(error) {self.postMessage({id,error:error instanceof Error?error.message:'布局计算失败'} satisfies BoardProjectionResponse);}
};
