import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ExchangePreview } from '../exchange-api';
import './exchange-panel.css';

export function ExchangePanel({
  sessionId,
  narrow,
  onOpenChange,
  prepare,
  imported,
}: {
  sessionId: string;
  narrow: boolean;
  onOpenChange(open: boolean): void;
  prepare(): Promise<boolean>;
  imported(): Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [available, setAvailable] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [annotations, setAnnotations] = useState(false);
  const [preview, setPreview] = useState<ExchangePreview & { selectionId: string }>(),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const operation = useRef<string | undefined>(undefined),
    trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLElement>(null);
  const api = window.yizhi.exchange;
  useEffect(() => {
    onOpenChange(open);
    if (open) panel.current?.focus();
  }, [open]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!(await prepare())) throw new Error('当前输入尚未保存，请先完成输入再重试。');
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const show = () => {
    setOpen(true);
    void run(async () => {
      const units = await api.available({ sessionId });
      setAvailable(units);
      setSelected(units.map((u) => u.id));
    });
  };
  const close = () => {
    if (busy) return;
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const confirm = () =>
    void run(async () => {
      if (!preview) return;
      operation.current ??= crypto.randomUUID();
      const receipt = await api.confirmImport({
        sessionId,
        selectionId: preview.selectionId,
        operationId: operation.current,
      });
      setMessage(`已导入 ${receipt.unitIds.length} 个单元；已有个人内容保留。`);
      setPreview(undefined);
      operation.current = undefined;
      await imported();
      setAvailable(await api.available({ sessionId }));
    });
  return (
    <>
      <button ref={trigger} onClick={show} aria-expanded={open}>
        内容交换
      </button>
      {open &&
        createPortal(
          <section
            ref={panel}
            className="exchange-panel"
            role={narrow ? 'dialog' : 'region'}
            aria-modal={narrow || undefined}
            aria-label="内容交换包"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
              if (e.key === 'Tab' && narrow) {
                const controls = [
                  ...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'),
                ];
                const first = controls[0],
                  last = controls.at(-1);
                if (!first) {
                  e.preventDefault();
                  return;
                }
                if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
                  e.preventDefault();
                  last?.focus();
                } else if (
                  !e.shiftKey &&
                  (document.activeElement === last || document.activeElement === e.currentTarget)
                ) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <div className="exchange-heading">
              <h2>内容交换包</h2>
              <button onClick={close} disabled={busy}>
                关闭内容交换
              </button>
            </div>
            <p>
              开放格式 <strong>yizhi-exchange-1</strong> · 不是完整课程备份
            </p>
            <p>包含：所选单元的完整正文与结构身份、范围内正式关系、固定来源版本及所需 PDF／图片。文字与公式批注由你选择。</p>
            <p className="exchange-secondary">
              不包含：范围外单元及跨范围关系、复习状态、布局与阅读位置、个人图形标注、草稿、对话、任务、修改历史、实验运行现场、扩展包、独立来源摘录与题库。
            </p>
            <fieldset disabled={busy}>
              <legend>导出范围</legend>
              <div className="exchange-unit-list">
                {available.map((u) => (
                  <label key={u.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(u.id)}
                      onChange={(e) =>
                        setSelected((ids) => (e.target.checked ? [...ids, u.id] : ids.filter((id) => id !== u.id)))
                      }
                    />
                    <span>
                      {u.id} · {u.name}
                    </span>
                  </label>
                ))}
              </div>
              {!available.length && <p>正在读取可交换的已保存单元…</p>}
              <label className="exchange-note-choice">
                <input type="checkbox" checked={annotations} onChange={(e) => setAnnotations(e.target.checked)} />
                包含所选单元的文字与公式批注
              </label>
              <button
                disabled={!selected.length}
                onClick={() =>
                  void run(async () => {
                    const r = await api.chooseExport({ sessionId, unitIds: selected, annotations });
                    if (r)
                      setMessage(
                        `已导出 ${r.counts.units} 个单元、${r.counts.resources} 项资源${r.annotations ? '及文字与公式批注' : ''}。`,
                      );
                  })
                }
              >
                导出所选内容
              </button>
            </fieldset>
            <div className="exchange-import">
              <h3>导入内容</h3>
              <p>同身份的不同内容会整包拒绝。检查后才导入，原有正文、批注和学习状态保留。</p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const p = await api.chooseImport({ sessionId });
                    if (p) {
                      setPreview(p);
                      operation.current = undefined;
                      setMessage('');
                    }
                  })
                }
              >
                选择交换包并检查
              </button>
              {preview && (
                <div className="exchange-preview">
                  <p>
                    {preview.counts.units} 个单元 · {preview.counts.relations} 条正式关系 · {preview.counts.sources}{' '}
                    个固定来源版本 · {preview.counts.resources} 项资源
                  </p>
                  <p>
                    {preview.annotations ? `包含 ${preview.counts.notes} 条文字或公式批注` : '不包含文字或公式批注'} · 格式{' '}
                    {preview.formatVersion}
                  </p>
                  <button disabled={busy} onClick={confirm}>
                    {operation.current ? '重试本次导入' : '导入已检查内容'}
                  </button>
                </div>
              )}
            </div>
            <p role="status" aria-live="polite">
              {busy ? '正在检查或保存…' : message}
            </p>
            {error && (
              <p role="alert" className="exchange-error">
                {error}{' '}
                {preview ? '可重试本次导入；若包或课程已变化，请重新选择并检查。' : '请选择支持的完整范围后重试。'}
              </p>
            )}
          </section>,
          document.body,
        )}
    </>
  );
}
