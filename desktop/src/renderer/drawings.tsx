import rough from 'roughjs';
import type { LayoutPlacement } from '../layout';
import type { PlacementEdit } from '../drawing-api';
import type { AnnotationSelection, PersonalNote } from '../annotation-api';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent } from 'react';
import type { DrawingAnchor, DrawingApply, DrawingGeometry, DrawingKind, DrawingValue, PersonalDrawing } from '../drawing-api';
import { equal } from '../editor-api';
import type { Viewport } from '@xyflow/react';
import './drawings.css';

export interface DrawingHandle { recordPlacement(edit: PlacementEdit): void; flush(): Promise<boolean>; highlight(selection: AnnotationSelection): Promise<void> }
const names: Record<DrawingKind, string> = { rectangle: '矩形', ellipse: '椭圆', arrow: '个人箭头', line: '直线', wave: '波浪线', highlighter: '荧光笔' };
const generator=rough.generator();
function Drawing({ value, id='preview' }: { value: DrawingValue; id?:string }) {
  const { x, y, width: w, height: h } = value.geometry;
  const options={seed:[...id].reduce((n,c)=>n+c.charCodeAt(0),1),roughness:.8,stroke:'#79551f',strokeWidth:2,disableMultiStroke:false};
  let shape;
  if(value.kind==='rectangle')shape=generator.rectangle(Math.min(x,x+w),Math.min(y,y+h),Math.abs(w),Math.abs(h),options);
  else if(value.kind==='ellipse')shape=generator.ellipse(x+w/2,y+h/2,Math.abs(w),Math.abs(h),options);
  else if(value.kind==='highlighter')return <g className="drawing-ink"><line x1={x} y1={y} x2={x+w} y2={y+h}/></g>;
  else {
    let d=`M${x},${y} l${w},${h}`;
    if(value.kind==='wave'){
      const length=Math.max(1,Math.hypot(w,h)),amplitude=length/50,nx=-h/length*amplitude,ny=w/length*amplitude;
      d=`M${x},${y}`;for(let i=1;i<=16;i++){const t=i/16,m=(i-.5)/16,sign=i%2?1:-1;d+=` Q${x+w*m+nx*sign},${y+h*m+ny*sign} ${x+w*t},${y+h*t}`;}
    }else if(value.kind==='arrow'){
      const angle=Math.atan2(h,w),size=Math.hypot(w,h)/8;
      d+=` M${x+w-size*Math.cos(angle-.45)},${y+h-size*Math.sin(angle-.45)} L${x+w},${y+h} L${x+w-size*Math.cos(angle+.45)},${y+h-size*Math.sin(angle+.45)}`;
    }
    shape=generator.path(d,options);
  }
  return <g className="drawing-ink">{generator.toPaths(shape).map((p,i)=><path key={i} d={p.d} vectorEffect="non-scaling-stroke"/>)}</g>;
}
export const Drawings = forwardRef<DrawingHandle, { sessionId: string; viewport: Viewport; takeover(): void; pan(dx:number,dy:number):void; prepare(): Promise<boolean>; paint(notes: PersonalNote[]): void; contentKey: string; waitLayout(): Promise<boolean>; restorePlacement(before: LayoutPlacement,after: LayoutPlacement,done:()=>void):void }>(function Drawings({ sessionId, viewport, takeover, pan, prepare, paint, contentKey, waitLayout, restorePlacement }, ref) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState<DrawingKind>();
  const [space,setSpace]=useState<'board'|'object'|'image'>('board');
  const [,redraw]=useState(0);
  const [notes,setNotes]=useState<PersonalNote[]>([]);
  const [selected, setSelected] = useState<string>();
  const [records, setRecords] = useState<PersonalDrawing[]>([]);
  const [preview, setPreview] = useState<DrawingValue>();
  const [status, setStatus] = useState('已保存'), [error, setError] = useState<string>();
  const layer = useRef<SVGSVGElement>(null);
  const spaceHeld=useRef(false),panGesture=useRef<{x:number;y:number}|undefined>(undefined);
  const gesture = useRef<{ start: { x: number; y: number }; value: DrawingValue; id?: string; mode?: 'move' | 'resize' } | undefined>(undefined);
  const recordsRef=useRef(records); recordsRef.current=records;
  type Step = { kind:'drawing'; id: string; before: DrawingValue | null; after: DrawingValue | null } | {kind:'placement';edit:PlacementEdit};
  const [historyBusy,setHistoryBusy]=useState(false), historyWork=useRef(false);
  const past=useRef<Step[]>([]), future=useRef<Step[]>([]), versions=useRef(new Map<string,number>());
  const onSaved=useRef<((record: PersonalDrawing)=>void) | undefined>(undefined);
  const pending = useRef<DrawingApply | undefined>(undefined), saving = useRef<Promise<boolean> | undefined>(undefined);
  const paintRef=useRef(paint);paintRef.current=paint;
  const refresh = async () => {
    const [drawings,notes]=await Promise.all([window.yizhi.drawings.list({sessionId}),window.yizhi.annotations.list({sessionId})]);
    setRecords(previous=>equal(previous,drawings)?previous:drawings);
    setNotes(previous=>equal(previous,notes)?previous:notes);
    const ids=new Set(drawings.flatMap(r=>r.value?.anchor.space==='text'?[r.value.anchor.noteId]:[]));
    paintRef.current(notes.filter(n=>ids.has(n.id)));
  };
  useEffect(()=>{let disposed=false,cursor=0;const poll=async()=>{try{const events=await window.yizhi.readEvents(sessionId,cursor);if(disposed)return;if(events.kind==='reset'||events.cursor!==cursor){cursor=events.cursor;await refresh();}}catch(e){if(!disposed)setError((e as Error).message);}};void refresh();const timer=setInterval(()=>void poll(),200);return()=>{disposed=true;clearInterval(timer);};},[sessionId]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[contentKey]);
  const save = (): Promise<boolean> => {
    if (saving.current) return saving.current;
    if (!pending.current) return Promise.resolve(true);
    const request = pending.current; setStatus('正在保存'); setError(undefined);
    const work = (async () => {
      try {
        if(request.selection&&!await prepare())throw new Error('正文尚未保存，请先重试正文保存。');
        const found = await window.yizhi.drawings.query({ sessionId, operationId: request.operationId });
        const saved = found ?? await window.yizhi.drawings.apply(request);
        versions.current.set(saved.id,saved.version);
        setRecords(previous => previous.some(r=>r.id===saved.id)?previous.map(r=>r.id===saved.id?saved:r):[...previous,saved]);
        onSaved.current?.(saved); onSaved.current=undefined;
        pending.current = undefined; setPreview(undefined); setStatus('已保存'); return true;
      } catch (e) { setStatus('未保存'); setError((e as Error).message); return false; }
      finally { saving.current = undefined; }
    })(); saving.current = work; return work;
  };
  const apply = (id: string, value: DrawingValue | null, done: (saved: PersonalDrawing)=>void) => {
    if(pending.current) return;
    const old=recordsRef.current.find(r=>r.id===id);
    pending.current={sessionId,operationId:crypto.randomUUID(),id,expectedVersion:versions.current.get(id)??old?.version??0,value};
    onSaved.current=done; if(value) setPreview(value); void save();
  };
  const commit = (id: string, value: DrawingValue | null) => {
    const old=recordsRef.current.find(r=>r.id===id)?.value??null;
    if(equal(old,value)) {setPreview(undefined);return;}
    apply(id,value,saved=>{past.current.push({kind:'drawing',id,before:old,after:saved.value});future.current=[];setSelected(saved.value?id:undefined);});
  };
  const undo = async (redo=false) => {
    if(pending.current||historyWork.current) return;
    historyWork.current=true;setHistoryBusy(true);
    if(!await waitLayout()){historyWork.current=false;setHistoryBusy(false);return;}
    const source=redo?future.current:past.current, destination=redo?past.current:future.current, step=source.at(-1);
    if(!step){historyWork.current=false;setHistoryBusy(false);return;}
    const done=()=>{source.pop();destination.push(step);historyWork.current=false;setHistoryBusy(false);};
    if(step.kind==='placement'){restorePlacement(redo?step.edit.before:step.edit.after,redo?step.edit.after:step.edit.before,done);return;}
    apply(step.id,redo?step.after:step.before,()=>{done();setSelected(step.id);});
  };
  useImperativeHandle(ref, () => ({ recordPlacement(edit){past.current.push({kind:'placement',edit});future.current=[];redraw(n=>n+1);}, flush: save, async highlight(selection) {
    setOpen(true);setKind(undefined);
    if(pending.current) return;
    if(!selection.fragments.length||selection.fragments.some(f=>f.field!=='text')){setError('请先选择正文中的文字范围。');return;}
    const id=crypto.randomUUID(),value:DrawingValue={kind:'highlighter',anchor:{space:'text',noteId:''},geometry:{x:0,y:0,width:1,height:1}};
    pending.current={sessionId,operationId:crypto.randomUUID(),id,expectedVersion:0,value,selection};
    onSaved.current=saved=>{past.current.push({kind:'drawing',id,before:null,after:saved.value});future.current=[];setSelected(id);};await save();await refresh();
  } }));
  const frame = (anchor: DrawingAnchor) => {
    const board=layer.current?.getBoundingClientRect();if(!board)return;
    if(anchor.space==='board')return {x:board.left+viewport.x,y:board.top+viewport.y,width:viewport.zoom,height:viewport.zoom};
    if(anchor.space==='text')return;
    const article=layer.current!.closest('main')?.querySelector<HTMLElement>(`article[data-unit-id="${CSS.escape(anchor.unitId)}"]`);
    if(!article)return;
    const target=anchor.blockId?article.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchor.blockId)}"]`):article;
    const element=anchor.space==='image'?target?.querySelector<HTMLElement>('figure img, figure svg'):target;
    if(!element)return;const box=element.getBoundingClientRect();if(!box.width||!box.height)return;
    return {x:box.left,y:box.top,width:anchor.space==='image'?box.width:viewport.zoom,height:anchor.space==='image'?box.height:viewport.zoom};
  };
  const point = (event: {clientX:number;clientY:number},anchor:DrawingAnchor={space:'board'}) => {
    const f=frame(anchor)!;const p={x:(event.clientX-f.x)/f.width,y:(event.clientY-f.y)/f.height};
    return anchor.space==='image'?{x:Math.max(0,Math.min(1,p.x)),y:Math.max(0,Math.min(1,p.y))}:p;
  };
  const project = (value:DrawingValue):DrawingValue|undefined=>{
    const f=frame(value.anchor),board=layer.current?.getBoundingClientRect();if(!f||!board)return;
    const g=value.geometry;return {...value,geometry:{x:(f.x-board.left-viewport.x+g.x*f.width)/viewport.zoom,y:(f.y-board.top-viewport.y+g.y*f.height)/viewport.zoom,width:g.width*f.width/viewport.zoom,height:g.height*f.height/viewport.zoom}};
  };
  useEffect(()=>{let raf:number;const update=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>redraw(n=>n+1));};const observer=new ResizeObserver(update);const board=layer.current?.closest('main');for(const el of board?.querySelectorAll('article,figure')??[])observer.observe(el);update();return()=>{observer.disconnect();cancelAnimationFrame(raf);};},[viewport,contentKey,records]);
  const cancel = () => { panGesture.current=undefined;if(!gesture.current&&pending.current)return;gesture.current=undefined; setPreview(undefined); };
  useEffect(() => { const key=(event: globalThis.KeyboardEvent)=>{
    const path=event.composedPath();
    if(event.defaultPrevented || event.isComposing || path.some(el=>el instanceof HTMLElement && (el.matches('input,textarea,select,math-field,[role=textbox]') || el.isContentEditable))) return;
    const target=event.target as Element | null;
    if(!target?.closest('main.board') || target.closest('.relations-panel,.source-dialog')) return;
    if(event.key==='Escape' && gesture.current){event.preventDefault();cancel();return;}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.stopPropagation();undo(event.shiftKey);}
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&target.closest('.drawing-layer')&&selected){
      const record=recordsRef.current.find(r=>r.id===selected),v=record?.value;if(!v||v.anchor.space==='text'||record.status!=='attached')return;
      event.preventDefault();const size=v.anchor.space==='image'?.02:24,dx=event.key==='ArrowLeft'?-size:event.key==='ArrowRight'?size:0,dy=event.key==='ArrowUp'?-size:event.key==='ArrowDown'?size:0;
      const g=v.geometry;commit(selected,{...v,geometry:target.matches('.drawing-resize')?{...g,width:g.width+dx,height:g.height+dy}:{...g,x:g.x+dx,y:g.y+dy}});
    }
    else if((event.key==='Delete'||event.key==='Backspace')&&selected){event.preventDefault();commit(selected,null);}
  };const spaceDown=(event:globalThis.KeyboardEvent)=>{if(event.code==='Space'&&(event.target as Element|null)?.closest('.drawing-layer')){spaceHeld.current=true;event.preventDefault();}};const up=(event:globalThis.KeyboardEvent)=>{if(event.code==='Space')spaceHeld.current=false;};const blur=()=>{spaceHeld.current=false;cancel();};window.addEventListener('keydown',spaceDown,true);window.addEventListener('keydown',key);window.addEventListener('keyup',up,true);window.addEventListener('blur',blur);return()=>{window.removeEventListener('keydown',spaceDown,true);window.removeEventListener('keydown',key);window.removeEventListener('keyup',up,true);window.removeEventListener('blur',blur);};});
  const start = (event: PointerEvent<SVGSVGElement>) => {
    if(event.button===1||spaceHeld.current){event.preventDefault();event.stopPropagation();takeover();layer.current!.focus();layer.current!.setPointerCapture(event.pointerId);panGesture.current={x:event.clientX,y:event.clientY};return;}
    if (!kind || pending.current || event.button!==0) return;
    event.preventDefault(); event.stopPropagation(); takeover(); layer.current!.focus(); layer.current!.setPointerCapture(event.pointerId);
    let anchor:DrawingAnchor={space:'board'};
    if(space!=='board'){
      const elements=document.elementsFromPoint(event.clientX,event.clientY),target=elements.find(el=>space==='image'?el.matches('figure img,figure svg'):el.closest('article[data-unit-id]'));
      const article=target?.closest<HTMLElement>('article[data-unit-id]'),block=target?.closest<HTMLElement>('[data-block-id]');
      if(!article||(space==='image'&&!block)){setError(space==='image'?'请在图像上绘制。':'请在单元上绘制。');return;}
      anchor={space,unitId:article.dataset.unitId!,...(space==='image'?{blockId:block!.dataset.blockId}: {})};
    }
    const start=point(event,anchor), value: DrawingValue={ kind,anchor,geometry:{...start,width:0,height:0} };
    gesture.current={start,value}; setPreview(value);
  };
  const move = (event: PointerEvent<SVGSVGElement>, finish=false) => {
    if(panGesture.current){event.preventDefault();event.stopPropagation();pan(event.clientX-panGesture.current.x,event.clientY-panGesture.current.y);panGesture.current=finish?undefined:{x:event.clientX,y:event.clientY};return;}
    const g=gesture.current; if(!g) return;
    event.preventDefault(); event.stopPropagation(); const p=point(event,g.value.anchor);
    const dx=p.x-g.start.x,dy=p.y-g.start.y;
    const geometry: DrawingGeometry=g.mode==='move'?{...g.value.geometry,x:g.value.geometry.x+dx,y:g.value.geometry.y+dy}:
      g.mode==='resize'?{...g.value.geometry,width:g.value.geometry.width+dx,height:g.value.geometry.height+dy}:{...g.value.geometry,width:dx,height:dy};
    if(g.value.anchor.space==='image'&&g.mode==='move'){
      geometry.x=Math.max(-Math.min(0,geometry.width),Math.min(1-Math.max(0,geometry.width),geometry.x));
      geometry.y=Math.max(-Math.min(0,geometry.height),Math.min(1-Math.max(0,geometry.height),geometry.y));
    }
    const value={...g.value,geometry}; setPreview(value);
    if(finish) { gesture.current=undefined; if(Math.hypot(geometry.width*(frame(value.anchor)?.width??1),geometry.height*(frame(value.anchor)?.height??1))<4) { setPreview(undefined); return; }
      commit(g.id??crypto.randomUUID(),value); setKind(undefined); }
  };
  const adjust = (event: PointerEvent<SVGGElement | SVGRectElement>, record: PersonalDrawing, mode: 'move' | 'resize') => {
    if(spaceHeld.current||event.button===1)return;
    if(kind||pending.current||!record.value||record.value.anchor.space==='text'||event.button!==0) return;
    event.preventDefault();event.stopPropagation();takeover();layer.current!.focus();layer.current!.setPointerCapture(event.pointerId);
    setSelected(record.id);gesture.current={start:point(event,record.value.anchor),value:record.value,id:record.id,mode};
  };
  const renderRecord=(r:PersonalDrawing)=>{
    if(!r.value||r.value.anchor.space==='text'||r.status!=='attached')return null;
    const value=project(preview&&gesture.current?.id===r.id?preview:r.value);if(!value)return null;const g=value.geometry;
    return <g key={r.id} data-drawing-id={r.id} className={`personal-drawing ${r.value.kind}${open?' drawing-selectable':''}`} onPointerDown={e=>adjust(e,r,'move')}>
      <rect className="drawing-hit" x={Math.min(g.x,g.x+g.width)} y={Math.min(g.y,g.y+g.height)} width={Math.max(10,Math.abs(g.width))} height={Math.max(10,Math.abs(g.height))}/>
      <title>{names[value.kind]} · 个人标注</title><Drawing value={value} id={r.id}/>
      {selected===r.id&&open&&<rect className="drawing-resize" role="slider" tabIndex={0} aria-label="调整个人图形尺寸" aria-valuenow={Math.round(g.width)} x={g.x+g.width-6/viewport.zoom} y={g.y+g.height-6/viewport.zoom} width={12/viewport.zoom} height={12/viewport.zoom} onPointerDown={e=>adjust(e,r,'resize')}/>}
    </g>;
  };
  const chosen=records.find(r=>r.id===selected);
  return <>
    <div className="drawing-entry"><button aria-expanded={open} onClick={()=>{setOpen(!open);setKind(undefined);cancel();}}>绘图标注</button><span role="status" aria-label="绘图同步状态" className={status==='未保存'?'drawing-save-error':''}>{status}</span></div>
    {open && <section className="drawing-tools" aria-label="个人绘图工具">
      <label>标注坐标 <select aria-label="标注坐标" value={space} onChange={e=>{cancel();setSpace(e.target.value as typeof space);}}><option value="board">画板坐标</option><option value="object">对象坐标</option><option value="image">图像相对几何</option></select></label>
      <div role="toolbar" aria-label="绘图工具">{Object.entries(names).map(([id,name])=><button key={id} disabled={!!pending.current} aria-pressed={kind===id} onClick={()=>{cancel();setKind(id as DrawingKind);}}>{name}</button>)}<button onClick={()=>{setKind(undefined);cancel();}}>结束绘图</button></div>
      <div role="toolbar" aria-label="画板撤销"><button disabled={!!pending.current||historyBusy||!past.current.length} onClick={()=>undo()}>撤销画板</button><button disabled={!!pending.current||historyBusy||!future.current.length} onClick={()=>undo(true)}>重做画板</button></div>
      <div className="drawing-list">{records.map((r,i)=><button key={r.id} aria-pressed={selected===r.id} onClick={()=>{setSelected(r.id);setKind(undefined);}}>{`选择${names[(r.value??r.original).kind]} ${i+1}`}{r.status==='orphan'?' · 待重新关联':r.status==='deleted'?' · 已删除':''}</button>)}</div>
      {chosen&&<div className="drawing-details"><details><summary>原语境与几何</summary><p>{names[chosen.original.kind]} · {chosen.original.anchor.space==='board'?'画板':chosen.original.anchor.space==='text'?'文字范围':chosen.original.anchor.unitId}</p><pre>{JSON.stringify(chosen.original.geometry)}</pre>{chosen.original.anchor.space==='text'&&notes.find(n=>n.id===(chosen.original.anchor as {noteId:string}).noteId)?.original.fragments.map((f,i)=><blockquote key={i}>{f.quote}</blockquote>)}{(chosen.original.anchor.space==='image'||chosen.original.anchor.space==='object')&&chosen.original.anchor.block&&<p>{String(chosen.original.anchor.block.payload.alt??chosen.original.anchor.block.payload.text??chosen.original.anchor.block.kind)}</p>}</details>
        {chosen.status==='deleted'&&<button disabled={!!pending.current} onClick={async()=>{const history=await window.yizhi.drawings.history({sessionId,id:chosen.id});commit(chosen.id,history.at(-1)?.before??chosen.original);}}>找回已删除图形</button>}
        {chosen.status==='orphan'&&chosen.value?.anchor.space!=='text'&&<button disabled={!!pending.current} onClick={()=>{const rect=layer.current!.getBoundingClientRect();commit(chosen.id,{kind:chosen.original.kind,anchor:{space:'board'},geometry:{x:(rect.width/2-viewport.x)/viewport.zoom,y:(rect.height/2-viewport.y)/viewport.zoom,width:150/viewport.zoom,height:70/viewport.zoom}});}}>找回到画板</button>}
        {chosen.value?.anchor.space==='text'&&<p>文字范围与原语境可在“个人批注”中重新关联。</p>}
        <button disabled={!!pending.current||!chosen.value} onClick={()=>commit(chosen.id,null)}>删除个人图形</button>
      </div>}
      <p>选择工具后拖动绘制；Esc 取消。箭头仅为个人标注。</p>
      {error && <><p role="alert">{error} 图形仍保留，请重试。</p><button onClick={()=>void save()}>重试保存绘图</button>{pending.current&&<button disabled={!!saving.current} onClick={async()=>{
        const request=pending.current;pending.current=undefined;onSaved.current=undefined;gesture.current=undefined;setPreview(undefined);historyWork.current=false;setHistoryBusy(false);
        if(request&&error.includes('图形已变化')){versions.current.delete(request.id);past.current=past.current.filter(step=>step.kind!=='drawing'||step.id!==request.id);future.current=future.current.filter(step=>step.kind!=='drawing'||step.id!==request.id);}
        await refresh();setError(undefined);setStatus('已保存');
      }}>放弃未保存绘图</button>}</>}
    </section>}
    <svg ref={layer} className={`drawing-layer${kind?' drawing-active':''}`} tabIndex={-1} aria-label="个人图形标注" onPointerDown={start} onPointerMove={e=>move(e)} onPointerUp={e=>move(e,true)} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.zoom})`}>
        {records.map(renderRecord)}
        {preview && !gesture.current?.id && project(preview) && <g className={`personal-drawing drawing-preview ${preview.kind}`}><Drawing value={project(preview)!}/></g>}
      </g>
    </svg>
  </>;
});
