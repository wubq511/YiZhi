import { useEffect, useRef, useState } from 'react';
import type { BoardNode, BoardScene } from '../board-layout';
import type { CourseGraph } from '../shared';
import type { BoardProjectionRequest, BoardProjectionResponse } from './board-worker';

/** Keeps one worker job and at most one newer request; intermediate measurements are coalesced. */
export function useBoardScene(sessionId:string|undefined,graph:CourseGraph|undefined,placements:BoardNode[],level:'themes'|'units',relationView:string) {
  const [result,setResult]=useState<{sessionId:string;scene:BoardScene}|undefined>();
  const [failure,setFailure]=useState<{sessionId:string;message:string}|undefined>();
  const worker=useRef<Worker|undefined>(undefined), sequence=useRef(0), busy=useRef(false);
  const queued=useRef<{sessionId:string;request:BoardProjectionRequest}|undefined>(undefined);
  const active=useRef<{sessionId:string;id:number}|undefined>(undefined), latest=useRef(0);
  useEffect(()=>{
    const instance=new Worker(new URL('./board-worker.js',import.meta.url),{type:'module'});
    worker.current=instance;
    const send=()=>{
      if(busy.current||!queued.current)return;
      const next=queued.current;queued.current=undefined;busy.current=true;active.current={sessionId:next.sessionId,id:next.request.id};
      try {instance.postMessage(next.request);}
      catch(error) {busy.current=false;active.current=undefined;setFailure({sessionId:next.sessionId,message:error instanceof Error?error.message:'布局计算无法启动'});}
    };
    instance.onmessage=(event:MessageEvent<BoardProjectionResponse>)=>{
      const finished=active.current;
      if(!finished||finished.id!==event.data.id)return;
      busy.current=false;active.current=undefined;
      if(event.data.id===latest.current) {
        if('scene' in event.data) {setResult({sessionId:finished.sessionId,scene:event.data.scene});setFailure(undefined);}
        else setFailure({sessionId:finished.sessionId,message:event.data.error});
      }
      send();
    };
    instance.onerror=()=>{
      const failed=active.current;busy.current=false;active.current=undefined;
      if(failed&&failed.id===latest.current)setFailure({sessionId:failed.sessionId,message:'布局计算未能启动，请重新打开课程'});
    };
    // The request effect may already have queued the first snapshot.
    send();
    return ()=>{instance.terminate();if(worker.current===instance)worker.current=undefined;busy.current=false;active.current=undefined;};
  },[]);
  useEffect(()=>{
    if(!sessionId||!graph) {queued.current=undefined;return;}
    const request:BoardProjectionRequest={id:++sequence.current,graph,placements,level,relationView};
    latest.current=request.id;queued.current={sessionId,request};setFailure(undefined);
    if(!busy.current&&worker.current) {
      const next=queued.current;queued.current=undefined;busy.current=true;active.current={sessionId,id:request.id};
      try {worker.current.postMessage(next.request);}
      catch(error) {busy.current=false;active.current=undefined;setFailure({sessionId,message:error instanceof Error?error.message:'布局计算无法启动'});}
    }
  },[sessionId,graph,placements,level,relationView]);
  return {scene:result?.sessionId===sessionId?result?.scene:undefined,error:failure?.sessionId===sessionId?failure?.message:undefined};
}
