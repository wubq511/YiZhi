import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import './sonner.css';

// Adapted from shadcn/ui Radix Nova; this app currently uses a light theme.
export function Toaster(props: ToasterProps) {
  return <Sonner
    theme="light"
    className="workspace-toaster"
    position="top-right"
    offset={{ top: 130, right: 16 }}
    mobileOffset={{ top: 122, right: 12, left: 12 }}
    closeButton
    containerAriaLabel="通知"
    style={{ '--width': 'min(360px, calc(100vw - 24px))' } as CSSProperties}
    icons={{
      success: <CircleCheck size={17}/>,
      info: <Info size={17}/>,
      warning: <TriangleAlert size={17}/>,
      error: <OctagonX size={17}/>,
      loading: <LoaderCircle size={17} className="animate-spin"/>,
      close: <X size={16}/>,
    }}
    toastOptions={{
      closeButtonAriaLabel: '关闭提示',
      classNames: { toast: 'workspace-toast', closeButton: 'workspace-toast-close' },
    }}
    {...props}
  />;
}
