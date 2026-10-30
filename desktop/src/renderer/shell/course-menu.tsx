import { ChevronDown, Archive, History, RotateCcw, Settings2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
export function CourseMenu({ backup, history, restore, settings }: { backup(): void; history(): void; restore(): void; settings(): void }) {
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="course-menu-trigger" aria-label="课程菜单"/>}><span className="course-mark">绎</span><span>数字逻辑与部件设计</span><ChevronDown size={16}/></DropdownMenuTrigger>
    <DropdownMenuContent className="course-menu" sideOffset={8}>
      <DropdownMenuItem onClick={backup}><Archive/>完整备份</DropdownMenuItem>
      <DropdownMenuItem onClick={history}><History/>课程历史</DropdownMenuItem>
      <DropdownMenuItem onClick={restore}><RotateCcw/>整课历史恢复</DropdownMenuItem>
      <DropdownMenuSeparator/>
      <DropdownMenuItem onClick={settings}><Settings2/>课程设置 · 历史与空间</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
