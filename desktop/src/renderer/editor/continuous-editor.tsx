import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CandidateCheck } from '../../command-api';
import { createRoot, type Root } from 'react-dom/client';
import type { OpenedCourse, ReadingBlock } from '../../shared';
import type { ParagraphSaveChannel } from '../save-channel';
import { ContinuousEditor } from './controller';
import './editor.css';

export function ContinuousUnitEditor({ course, channel, disabled, saveError, composition, renderBlock, controller }: {
  course: OpenedCourse; channel: ParagraphSaveChannel; disabled: boolean;
  saveError?: boolean;
  composition(active: boolean): void; renderBlock(block: ReadingBlock): ReactNode;
  controller(instance: ContinuousEditor | null): void;
}) {
  const element = useRef<HTMLDivElement>(null), instance = useRef<ContinuousEditor | null>(null);
  const [checks, setChecks] = useState<CandidateCheck[]>([]);
  const [conflicts, setConflicts] = useState<Array<{ blockId: string; current: Record<string, any>; student: Record<string, any> }>>([]);
  const [resolving, setResolving] = useState(false), [failure, setFailure] = useState<string>();
  const latest = useRef({ composition, renderBlock, controller }); latest.current = { composition, renderBlock, controller };
  const roots = useRef(new Map<HTMLElement, { root: Root; block: ReadingBlock }>());
  useEffect(() => {
    if (!element.current) return;
    const editor = new ContinuousEditor(element.current, course, channel, {
      composition: active => latest.current.composition(active),
      commands: window.yizhi.commands, status: setChecks,
      renderOpaque(element, block) {
        const root = createRoot(element); roots.current.set(element, { root, block });
        root.render(latest.current.renderBlock(block));
        return () => { roots.current.delete(element); queueMicrotask(() => root.unmount()); };
      },
    });
    instance.current = editor; latest.current.controller(editor);
    return () => { editor.destroy(); instance.current = null; latest.current.controller(null); };
  }, [channel]);
  useEffect(() => { instance.current?.setEditable(!disabled && !resolving); }, [disabled, resolving]);
  useEffect(() => { let cancelled = false; if (saveError) void instance.current?.inputConflicts().then(items => { if (!cancelled) setConflicts(items); });
    else setConflicts([]); return () => { cancelled = true; }; }, [saveError, course]);
  useEffect(() => { instance.current?.reconcile(course); }, [course]);
  useEffect(() => { for (const { root, block } of roots.current.values()) root.render(renderBlock(block)); }, [renderBlock]);
  const resolve = async (action: () => Promise<void>) => {
    setResolving(true); setFailure(undefined);
    try { await action(); setConflicts([]); } catch (error) { setFailure((error as Error).message); }
    finally { setResolving(false); }
  };
  const text = (value: Record<string, any>) => String(value.text ?? value.latex ?? value.payload?.text ?? value.payload?.latex ?? '结构或关联内容');
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
    {checks.length > 0 && <div className="editor-integration" role="status" aria-label="同时修改处理">
      {checks.map(check => <div key={check.candidateId}><p>{check.status === 'committed' ? '已根据最新学生输入整合同时修改。' : check.status === 'needs-reread'
        ? '这项修改依赖的内容已改变，需要内容生产者重新读取并推导。当前内容继续保留。' : check.status === 'conflict'
        ? check.reason?.includes('读取依据') ? '这项修改依赖的内容已改变，需要重新推导。当前内容继续保留。' : '此处内容与学生输入不兼容。双方内容均已保留，请选择冲突部分的内容。' : check.reason}</p>
        {check.status === 'conflict' && <><dl>{check.parts?.map(part => <div key={part.objectId}><dt>当前内容</dt><dd>{text(part.current)}</dd><dt>同时修改的候选</dt><dd>{text(part.incoming)}</dd></div>)}</dl>
          <button disabled={resolving} onClick={() => void resolve(() => instance.current!.resolveCandidate(check.candidateId, 'current'))}>保留当前内容</button>
          {!check.reason?.includes('读取依据') && <button disabled={resolving} onClick={() => void resolve(() => instance.current!.resolveCandidate(check.candidateId, 'incoming'))}>此处使用外部修改</button>}</>}
      </div>)}
    </div>}
    {conflicts.length > 0 && <section className="editor-integration" aria-label="学生草稿冲突"><p>只有以下部分发生同处冲突，其他兼容修改会自动保留。</p>
      <dl>{conflicts.map(part => <div key={part.blockId}><dt>已保存的外部内容</dt><dd>{text(part.current)}</dd><dt>学生草稿</dt><dd>{text(part.student)}</dd></div>)}</dl>
      <button disabled={resolving} onClick={() => void resolve(() => instance.current!.resolveInput('student'))}>冲突处保留学生草稿</button>
      <button disabled={resolving} onClick={() => void resolve(() => instance.current!.resolveInput('external'))}>冲突处保留外部内容</button>
    </section>}
    {failure && <p role="alert">{failure}</p>}
    <div ref={element} />
  </section>;
}
