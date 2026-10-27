import { useRef, useState } from 'react';
import type { OpenedCourse } from '../shared';
import type { Attempt, CommandBasis, GroupCommand, RetainedCandidate } from '../command-api';
import './controlled-producer.css';

const targetId = 'RB-TH-01-03-expansion-terms';

/** Deliberately controlled producer. This is an acceptance surface, not an Agent runtime. */
export function ControlledProducer({ course, prepare, committed, settled, narrow, onOpenChange }: {
  course: OpenedCourse; prepare(): Promise<void>; committed(): Promise<void>; settled(): void; narrow: boolean; onOpenChange(open: boolean): void;
}) {
  const [attempt, setAttempt] = useState<Attempt>();
  const [basis, setBasis] = useState<CommandBasis>();
  const [candidate, setCandidate] = useState('');
  const [premise, setPremise] = useState('');
  const [status, setStatus] = useState('尚未读取依据。');
  const [substantive, setSubstantive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retained, setRetained] = useState<RetainedCandidate[]>([]);
  const pending = useRef<GroupCommand | undefined>(undefined);
  const receiptId = useRef<string | undefined>(undefined);
  const commands = window.yizhi.commands;
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try { await prepare(); await job(); }
    catch (error) { setStatus((error as Error).message); }
    finally { settled(); setBusy(false); }
  };
  const read = () => run(async () => {
    const active = await commands.startAttempt({ sessionId: course.sessionId, taskId: 'controlled-producer-demo', resume: true });
    const fresh = await commands.read({ sessionId: course.sessionId, attemptId: active.attemptId,
      objectIds: [course.editableBlockId, targetId] });
    const source = String(fresh.objects.find(object => object.id === course.editableBlockId)!.value.payload.text);
    const target = fresh.objects.find(object => object.id === targetId)!.value;
    // Re-read actually consumes current source and target; it never just relabels an old candidate.
    setCandidate(`${target.payload.text}\n【可控示例】读取的前提：${source}`);
    setPremise(source); setBasis(fresh); setAttempt(active); pending.current = undefined;
    setRetained(await commands.candidates({ sessionId: course.sessionId }));
    setStatus('已读取当前依据，并用它形成新的可控候选。');
  });
  const submit = () => run(async () => {
    if (!basis || !attempt) return;
    const original = basis.objects.find(object => object.id === targetId)!.value;
    pending.current ??= { sessionId: course.sessionId, attemptId: attempt.attemptId, operationId: crypto.randomUUID(),
      basisId: basis.basisId, changes: [{ objectId: targetId, value: { ...original, payload: { ...original.payload, text: candidate } } }],
      ...(substantive ? { semanticImpact: { version: 1 as const, unitId: 'KU-001', conclusionOrMethodChanged: true } } : {}) };
    const result = await commands.commit(pending.current);
    if (result.status === 'committed') {
      receiptId.current = result.operationId;
      await committed();
      setStatus(`正式修改已保存，实际变化 ${result.changedObjectIds.length} 个对象。`);
    } else setStatus(result.reason!);
    setRetained(await commands.candidates({ sessionId: course.sessionId }));
  });
  return <details className="controlled-producer" onToggle={event => onOpenChange(event.currentTarget.open)} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    } else if (narrow && event.key === 'Tab') {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('summary, button:not(:disabled), textarea:not(:disabled)')].filter(item => item.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus(); }
    }
  }}>
    <summary>可控生产者 · 验证入口</summary>
    <div className="producer-panel">
    <p>此入口用固定规则生成候选，验证课程保存、冲突与停止。尚未连接真实 Agent。</p>
    <div className="producer-actions"><button disabled={busy} onClick={() => void read()}>{basis ? '重读并整合' : '读取当前依据'}</button>
      <button disabled={busy || !attempt} onClick={() => void run(async () => {
        const stopped = await commands.stop({ sessionId: course.sessionId, attemptId: attempt!.attemptId });
        setAttempt(stopped); setStatus('本次尝试已停止；已经保存的修改保留。');
      })}>停止本次尝试</button></div>
    {basis && <>
      <details><summary>本次读取的前提</summary><p>{premise}</p></details>
      <label>可控候选内容<textarea rows={5} value={candidate} disabled={busy}
        onChange={event => { setCandidate(event.target.value); pending.current = undefined; }} /></label>
      <label><input type="checkbox" checked={substantive} disabled={busy} onChange={event => { setSubstantive(event.target.checked); pending.current = undefined; }} /> 本次会改变重要结论或方法（阶段 II 元数据演示）</label>
      <div className="producer-actions"><button disabled={busy || !candidate} onClick={() => void submit()}>提交可控修改</button>
        <button disabled={busy || !receiptId.current} onClick={() => void run(async () => {
          const receipt = await commands.query({ sessionId: course.sessionId, operationId: receiptId.current! });
          setStatus(receipt?.status === 'committed' ? '已保存的原回执已核对。' : '尚未找到保存回执，请保留候选后重读。');
        })}>核对最近提交</button></div>
    </>}
    <p role="status" aria-label="可控生产者状态" aria-live="polite">{busy ? '正在核对课程…' : status}</p>
    {retained.length > 0 && <details><summary>保留的旧候选（{retained.length}）</summary>
      {retained.map(item => <div key={item.result.operationId}><p>{item.result.reason}</p>
        <p>{String(item.command.changes[0]?.value.payload?.text ?? '结构与依赖候选已保留')}</p></div>)}
    </details>}
    </div>
  </details>;
}
