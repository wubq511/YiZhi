import { BookOpen, MousePointer2, Hand, Highlighter, Shapes, Square, Circle, ArrowUpRight, Minus, Waves, GitBranch, Undo2, Redo2, ChevronDown, Archive, Map, Plus, Maximize, ChevronUp } from 'lucide-react';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuGroup, DropdownMenuLabel } from '../components/ui/dropdown-menu';
import { useEditHistory } from './edit-history';
import type { DrawingKind } from '../../drawing-api';
import type { DrawingToolState } from '../drawings';
export type BoardTool = 'read' | 'select' | 'hand';
export function CanvasToolbar({ tool, chooseTool, drawing, chooseDrawing, changeSpace, manageDrawings, highlight, relations, relationView, changeRelations, capture }: {
  tool: BoardTool; chooseTool(tool: BoardTool): void; drawing: DrawingToolState; chooseDrawing(kind: DrawingKind): void; changeSpace(space: DrawingToolState['space']): void; manageDrawings(): void; highlight(): void;
  relations(): void; relationView: string; changeRelations(view: string): void; capture(): void;
}) {
  const history = useEditHistory();
  const shapeIcons = {rectangle:Square,ellipse:Circle,arrow:ArrowUpRight,line:Minus,wave:Waves,highlighter:Highlighter};
  const Shape = drawing.kind && drawing.kind !== 'highlighter' ? shapeIcons[drawing.kind] : Shapes;
  return <div className="canvas-toolbar board-tools" role="toolbar" aria-label="画板工具" onPointerDownCapture={capture}>
    <div className="tool-group">{([{id:'read',label:'阅读工具',Icon:BookOpen},{id:'select',label:'选择工具',Icon:MousePointer2},{id:'hand',label:'手形工具',Icon:Hand}] as const).map(({id,label,Icon}) => <Button key={id} variant="ghost" size="icon" aria-label={label} title={label} aria-pressed={!drawing.kind && tool === id} onClick={() => chooseTool(id)}><Icon/></Button>)}</div>
    <span className="toolbar-divider"/>
    <div className="tool-group"><Button variant="ghost" size="icon" aria-label="荧光笔" title="荧光笔：标记选中文字或在画板绘制" aria-pressed={drawing.kind === 'highlighter'} onMouseDown={e=>e.preventDefault()} onClick={highlight}><Highlighter/></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="tool-menu-trigger" aria-label="图形" aria-pressed={!!drawing.kind && drawing.kind !== 'highlighter'}/> }><Shape/><ChevronDown size={12}/></DropdownMenuTrigger>
        <DropdownMenuContent className="shape-menu" sideOffset={10}><DropdownMenuRadioGroup value={drawing.kind ?? ''} onValueChange={value => chooseDrawing(value as DrawingKind)}>
          {([{id:'rectangle',label:'矩形'},{id:'ellipse',label:'椭圆'},{id:'arrow',label:'个人箭头'},{id:'line',label:'直线'},{id:'wave',label:'波浪线'}] as const).map(({id,label})=>{const Icon=shapeIcons[id];return <DropdownMenuRadioItem key={id} value={id} disabled={drawing.pending}><Icon/>{label}</DropdownMenuRadioItem>;})}
        </DropdownMenuRadioGroup><DropdownMenuSeparator/><DropdownMenuGroup><DropdownMenuLabel>绘制位置</DropdownMenuLabel><DropdownMenuRadioGroup value={drawing.space} onValueChange={value => changeSpace(value as DrawingToolState['space'])}><DropdownMenuRadioItem value="board">画板</DropdownMenuRadioItem><DropdownMenuRadioItem value="object">当前对象</DropdownMenuRadioItem><DropdownMenuRadioItem value="image">图像内部</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuGroup><DropdownMenuSeparator/><DropdownMenuItem onClick={manageDrawings}><Archive/>管理与找回图形</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu></div>
    <span className="toolbar-divider"/>
    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="tool-menu-trigger" aria-label="关系"/>}><GitBranch/><ChevronDown size={12}/></DropdownMenuTrigger><DropdownMenuContent className="relation-menu" sideOffset={10}><DropdownMenuRadioGroup value={relationView} onValueChange={changeRelations}><DropdownMenuRadioItem value="main">主关系</DropdownMenuRadioItem><DropdownMenuRadioItem value="auxiliary">辅助关系</DropdownMenuRadioItem><DropdownMenuRadioItem value="all">全部关系</DropdownMenuRadioItem></DropdownMenuRadioGroup><DropdownMenuSeparator/><DropdownMenuItem onClick={relations}>查看与编辑正式关系</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    <span className="toolbar-divider"/>
    <div className="tool-group"><Button variant="ghost" size="icon" aria-label={`撤销${history.label}`} title={`撤销${history.label} ⌘Z`} disabled={!history.canUndo} onMouseDown={e=>e.preventDefault()} onClick={history.undo}><Undo2/></Button><Button variant="ghost" size="icon" aria-label={`重做${history.label}`} title={`重做${history.label} ⇧⌘Z`} disabled={!history.canRedo} onMouseDown={e=>e.preventDefault()} onClick={history.redo}><Redo2/></Button></div>
  </div>;
}
export function CanvasNavigation({ minimap, toggle, zoom, zoomIn, zoomOut, fit }: { minimap: boolean; toggle():void; zoom:number; zoomIn():void; zoomOut():void; fit():void }) {
  return <div className="canvas-navigation"><Button variant="ghost" size="icon" aria-label={minimap?'收起小地图':'展开小地图'} title={minimap?'收起小地图':'展开小地图'} onClick={toggle}>{minimap?<ChevronDown/>:<Map/>}</Button><span className="toolbar-divider"/><Button variant="ghost" size="icon" aria-label="缩小画板" onClick={zoomOut}><Minus/></Button><span className="canvas-zoom">{Math.round(zoom*100)}%</span><Button variant="ghost" size="icon" aria-label="放大画板" onClick={zoomIn}><Plus/></Button><span className="toolbar-divider"/><Button variant="ghost" size="icon" aria-label="全图" title="全图" onClick={fit}><Maximize/></Button></div>;
}
