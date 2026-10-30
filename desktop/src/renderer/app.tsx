import { createRoot } from 'react-dom/client';
import { Workspace } from './workspace';
if (window.yizhi.titleBarInset) document.documentElement.dataset.titlebar = 'inset';
createRoot(document.getElementById('root')!).render(<Workspace />);
