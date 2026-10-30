import { ChevronDown, Archive, History, RotateCcw, Settings2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
export function CourseMenu({ backup, history, restore, settings }: { backup(pointer: boolean): void; history(pointer: boolean): void; restore(pointer: boolean): void; settings(pointer: boolean): void }) {
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="course-menu-trigger" aria-label="课程菜单"/>}><span className="course-mark">绎</span><span>数字逻辑与部件设计</span><ChevronDown size={16}/></DropdownMenuTrigger>
    <DropdownMenuContent className="course-menu" sideOffset={8}>
      <DropdownMenuItem onClick={event => backup(event.detail > 0)}><Archive/>完整备份</DropdownMenuItem>
      <DropdownMenuItem onClick={event => history(event.detail > 0)}><History/>课程历史</DropdownMenuItem>
      <DropdownMenuItem onClick={event => restore(event.detail > 0)}><RotateCcw/>整课历史恢复</DropdownMenuItem>
      <DropdownMenuSeparator/>
      <DropdownMenuItem onClick={event => settings(event.detail > 0)}><Settings2/>课程设置 · 历史与空间</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
