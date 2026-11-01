import { ChevronDown, Archive, History, RotateCcw, Settings2 } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
export function CourseMenu({ backup, history, restore, settings }: { backup(pointer: boolean): void; history(pointer: boolean): void; restore(pointer: boolean): void; settings(pointer: boolean): void }) {
  const handoff = useRef(false);
  const open = (action: (pointer: boolean) => void, pointer: boolean) => { handoff.current = true; action(pointer); };
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="course-menu-trigger" aria-label="课程菜单"><span>数字逻辑与部件设计</span><ChevronDown size={16}/></Button></DropdownMenuTrigger>
    <DropdownMenuContent className="course-menu" sideOffset={8} onCloseAutoFocus={event => { if (handoff.current) { handoff.current = false; event.preventDefault(); document.querySelector<HTMLButtonElement>('dialog.history-panel[open] button')?.focus({preventScroll:true}); } }}>
      <DropdownMenuItem onClick={event => open(backup, event.detail > 0)}><Archive/>完整备份</DropdownMenuItem>
      <DropdownMenuItem onClick={event => open(history, event.detail > 0)}><History/>课程历史</DropdownMenuItem>
      <DropdownMenuItem onClick={event => open(restore, event.detail > 0)}><RotateCcw/>整课历史恢复</DropdownMenuItem>
      <DropdownMenuSeparator/>
      <DropdownMenuItem onClick={event => open(settings, event.detail > 0)}><Settings2/>课程设置</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
