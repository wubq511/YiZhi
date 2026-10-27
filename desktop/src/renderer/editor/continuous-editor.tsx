import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OpenedCourse, ReadingBlock } from '../../shared';
import type { ParagraphSaveChannel } from '../save-channel';
import { ContinuousEditor } from './controller';
import './editor.css';

export function ContinuousUnitEditor({ course, channel, disabled, composition, renderBlock, controller }: {
  course: OpenedCourse; channel: ParagraphSaveChannel; disabled: boolean;
  composition(active: boolean): void; renderBlock(block: ReadingBlock): ReactNode;
  controller(instance: ContinuousEditor | null): void;
}) {
  const element = useRef<HTMLDivElement>(null), instance = useRef<ContinuousEditor | null>(null);
  const latest = useRef({ composition, renderBlock, controller }); latest.current = { composition, renderBlock, controller };
  const roots = useRef(new Map<HTMLElement, { root: Root; block: ReadingBlock }>());
  useEffect(() => {
    if (!element.current) return;
    const editor = new ContinuousEditor(element.current, course, channel, {
      composition: active => latest.current.composition(active),
      renderOpaque(element, block) {
        const root = createRoot(element); roots.current.set(element, { root, block });
        root.render(latest.current.renderBlock(block));
        return () => { roots.current.delete(element); queueMicrotask(() => root.unmount()); };
      },
    });
    instance.current = editor; latest.current.controller(editor);
    return () => { editor.destroy(); instance.current = null; latest.current.controller(null); };
  }, [channel]);
  useEffect(() => { instance.current?.setEditable(!disabled); }, [disabled]);
  useEffect(() => { instance.current?.reconcile(course); }, [course]);
  useEffect(() => { for (const { root, block } of roots.current.values()) root.render(renderBlock(block)); }, [renderBlock]);
  return <section className="continuous-editor">
    <div className="editor-tools" role="toolbar" aria-label="正文编辑工具" onMouseDown={event => event.preventDefault()}>
      <span>正文 · 连续编辑，自动保存</span>
      <button disabled={disabled} onClick={() => instance.current?.undo()}>撤销正文</button>
      <button disabled={disabled} onClick={() => instance.current?.redo()}>重做正文</button>
      <button disabled={disabled} onClick={() => instance.current?.insertFormula()}>插入公式</button>
      <button disabled={disabled} onClick={() => instance.current?.moveSelected(-1)}>上移当前块</button>
      <button disabled={disabled} onClick={() => instance.current?.moveSelected(1)}>下移当前块</button>
      <button disabled={disabled} onClick={() => instance.current?.splitFirst()}>拆分首段为两段</button>
    </div>
    <div ref={element} />
  </section>;
}
