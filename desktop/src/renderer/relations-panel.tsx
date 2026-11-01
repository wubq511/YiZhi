import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { useEffect, useRef, useState, type Ref, type KeyboardEvent, type MouseEvent } from 'react';
import type { CourseGraph } from '../shared';
import type { FormalRelation, RelationBasis, RelationCommand, RequirementGroup } from '../relation-api';
import './relations-panel.css';

type Props = { graph: CourseGraph; sessionId: string; view: string; narrow: boolean; panelRef: Ref<HTMLElement>;
  open: boolean; motion: boolean; onClose(event: MouseEvent<HTMLButtonElement>): void; onKeyDown(event: KeyboardEvent<HTMLElement>): void; onGraph(graph: CourseGraph): void; focusIds?: string[]; onNavigate(id: string): void };
const types: Record<string, string> = { requires: '前置', constructs: '构造', improves: '优化', inverse: '互逆' };

/** Formal graph consumers reread after shared durable events, including cursor expiry. */
export function useRelationEvents(sessionId: string | undefined, onGraph: (graph: CourseGraph) => void) {
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false, cursor = 0;
    const poll = async () => {
      try {
        const page = await window.yizhi.readEvents(sessionId, cursor);
        if (disposed) return;
        if (page.kind === 'reset' || page.events.some(e => e.type === 'relations.committed' || e.type === 'exchange.imported')) {
          const graph = await window.yizhi.graph(sessionId);
          if (!disposed) onGraph(graph);
        }
        cursor = page.cursor;
      } catch { /* Existing graph remains visible; next poll reconciles the durable cursor. */ }
      if (!disposed) timer = setTimeout(poll, 400);
    };
    let timer = setTimeout(poll, 0);
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId, onGraph]);
}

export function RelationsPanel({ graph, sessionId, view, narrow, panelRef, open, motion, onClose, onKeyDown, onGraph, focusIds, onNavigate }: Props) {
  const [basis, setBasis] = useState<RelationBasis>();
  const [draft, setDraft] = useState<FormalRelation>();
  const [route, setRoute] = useState('none');
  const [routeMode, setRouteMode] = useState<'all' | 'any'>('any');
  const [routeValue, setRouteValue] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('');
  const [trace, setTrace] = useState<CourseGraph['conditions']>();
  const [traceTarget, setTraceTarget] = useState('KU-044');
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<RelationCommand | undefined>(undefined);
  const changed = (value: FormalRelation) => { setDraft(value); pending.current = undefined; setError(''); };
  const begin = async (id?: string) => {
    setBusy(true); setError(''); setResult('');
    try {
      const next = await window.yizhi.relations.read({ sessionId });
      setBasis(next); onGraph(next.graph);
      const edge = next.graph.edges.find(e => e.id === id);
      const group = next.graph.requirementGroups.find(g => g.id === edge?.requirementGroupId);
      setDraft(edge ? structuredClone(edge) : { id: `REL-${crypto.randomUUID()}`, fromUnitId: '', toUnitId: '',
        type: 'requires', directed: true, view: 'main', value: '', sourceRefs: [] });
      setRoute(group?.id ?? 'none'); setRouteMode(group?.mode ?? 'any'); setRouteValue(group?.value ?? '');
      pending.current = undefined;
      requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('input')?.focus());
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const reread = async () => {
    setBusy(true);
    try { const next = await window.yizhi.relations.read({ sessionId }); setBasis(next); onGraph(next.graph);
      pending.current = undefined; setError(''); setResult('依据已更新，候选未改动。请核对端点、路线和来源后再次保存。'); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const submit = async (remove = false) => {
    if (!draft || !basis) return;
    setBusy(true); setError(''); setResult('');
    try {
      const edge = structuredClone(draft);
      // Route membership is always changed in the same course transaction as its facts.
      const groups = new Map(basis.graph.requirementGroups.map(group => [group.id, structuredClone(group)]));
      const original = basis.graph.edges.find(e => e.id === edge.id);
      const keepMembership = !remove && route === original?.requirementGroupId && edge.type === 'requires' && edge.fromUnitId === original?.fromUnitId && edge.toUnitId === original?.toUnitId;
      if (original?.requirementGroupId && !keepMembership) {
        const old = groups.get(original.requirementGroupId)!;
        old.relationIds = old.relationIds.filter(id => id !== edge.id);
        old.unitIds = basis.graph.edges.filter(e => old.relationIds.includes(e.id)).map(e => e.fromUnitId);
      }
      delete edge.requirementGroupId;
      if (!remove && edge.type === 'requires' && route !== 'none') {
        const id = route === 'new' ? `G${crypto.randomUUID()}` : route;
        const group: RequirementGroup = groups.get(id) ?? { id, targetUnitId: edge.toUnitId, mode: routeMode,
          unitIds: [], relationIds: [], value: routeValue, sourceRefs: structuredClone(edge.sourceRefs) };
        if (group.targetUnitId !== edge.toUnitId) throw new Error('路线组目标已变化，请重新选择同一目标的路线。');
        if (!group.relationIds.includes(edge.id)) { group.unitIds.push(edge.fromUnitId); group.relationIds.push(edge.id); }
        group.mode = routeMode; group.value = routeValue; groups.set(id, group); edge.requirementGroupId = id;
      }
      const groupChanges = [...groups.values()].filter(group => JSON.stringify(group) !== JSON.stringify(basis.graph.requirementGroups.find(g => g.id === group.id)))
        .map(group => ({ id: group.id, value: group.relationIds.length ? group : null }));
      const command = pending.current ?? { sessionId, basisId: basis.basisId, generation: basis.generation,
        operationId: crypto.randomUUID(), changes: [{ id: edge.id, value: remove ? null : edge }], groupChanges };
      pending.current = command;
      let receipt;
      try { receipt = await window.yizhi.relations.commit(command); }
      catch (failure) {
        // Query the original identity before allowing a new attempt after a transport failure.
        try { receipt = await window.yizhi.relations.query({ sessionId, operationId: command.operationId }); }
        catch { setUncertain(true); throw new Error('保存结果暂不明确，请核对原操作结果后继续'); }
        if (!receipt) { setUncertain(false); pending.current = undefined; throw failure; }
      }
      setUncertain(false);
      const next = await window.yizhi.relations.read({ sessionId });
      onGraph(next.graph); setBasis(next); setDraft(undefined); pending.current = undefined;
      setResult(remove ? '正式关系已移除；路线组与主题聚合已共同更新。' : '正式关系已保存；主／辅助／全部与主题聚合已共同更新。');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const name = (id: string) => `${id} ${graph.nodes.find(node => node.id === id)?.name ?? ''}`;
  const shown = graph.edges.filter(edge => view === 'all' || edge.view === view);
  const refs = draft?.sourceRefs ?? [];
  return <aside ref={panelRef} className="relations-panel" role={narrow ? 'dialog' : undefined} aria-modal={narrow && open || undefined} aria-label="关系详情" aria-hidden={!open || undefined} inert={!open} data-motion={motion?'pointer':undefined} data-exiting={!open?'':undefined} onKeyDown={onKeyDown}>
    <h2>关系详情</h2><Button variant="outline" size="sm" onClick={onClose}>关闭关系详情</Button>
    <p>个人箭头只作个人标注；正式关系在此独立审核。</p>
    <Button variant="outline" size="sm" disabled={busy || !!pending.current} onClick={() => void begin()}>新增正式关系</Button>
    {error && <p role="alert">{error} 候选仍保留，可修改后重试。</p>}
    <p role="status" aria-label="正式关系结果">{busy ? '正在核对正式关系…' : result}</p>
    {uncertain && <Button variant="outline" size="sm" disabled={busy} onClick={() => void submit()}>核对原操作结果</Button>}
    {focusIds && <section aria-label="所选关系成员"><h3>所选关系 · {focusIds.length} 条</h3>
      {focusIds.map(id => { const edge = graph.edges.find(item => item.id === id); return edge ? <div className="relation-member" key={id}>
        <p>{types[edge.type] ?? edge.type}：{name(edge.fromUnitId)} {edge.directed ? '→' : '↔'} {name(edge.toUnitId)}</p>
        <Button variant="outline" size="sm" onClick={() => onNavigate(edge.fromUnitId)}>定位起点</Button>{' '}
        <Button variant="outline" size="sm" onClick={() => onNavigate(edge.toUnitId)}>定位终点</Button>{' '}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void begin(edge.id)}>审核 {edge.id}</Button>
      </div> : <p key={id}>关系 {id} 已不可用</p>; })}
    </section>}
    {draft && basis && <form ref={form} className="relation-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h3>正式关系审核</h3><p>{draft.id}</p><fieldset disabled={busy || uncertain}>
        <label>起点单元<Input list="relation-units" value={draft.fromUnitId} onChange={e => changed({ ...draft, fromUnitId: e.target.value })} /></label>
        <label>终点单元<Input list="relation-units" value={draft.toUnitId} onChange={e => { changed({ ...draft, toUnitId: e.target.value }); setRoute('none'); }} /></label>
        <datalist id="relation-units">{graph.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</datalist>
        <label>关系含义<NativeSelect value={draft.type} onChange={e => { changed({ ...draft, type: e.target.value, directed: e.target.value !== 'inverse' }); if (e.target.value !== 'requires') setRoute('none'); }}>{Object.entries(types).map(([id, label]) => <NativeSelectOption key={id} value={id}>{label} · {id}</NativeSelectOption>)}</NativeSelect></label>
        <label className="relation-direction"><Checkbox checked={draft.directed} disabled={busy || uncertain} onCheckedChange={checked => changed({ ...draft, directed: checked === true })} />有向：起点 → 终点（互逆为无向）</label>
        <label>正式关系显示<NativeSelect value={draft.view} onChange={e => changed({ ...draft, view: e.target.value })}><NativeSelectOption value="main">主关系</NativeSelectOption><NativeSelectOption value="auxiliary">辅助关系</NativeSelectOption></NativeSelect></label>
        <label>具体信息价值<Textarea rows={4} value={draft.value} onChange={e => changed({ ...draft, value: e.target.value })} /></label>
        <h4>来源与固定版本</h4>
        {refs.map((reference, index) => {
          const update = (next: typeof reference) => changed({ ...draft, sourceRefs: refs.map((r, i) => i === index ? next : r) });
          const source = basis.sources.find(s => s.id === reference.sourceId);
          return <div className="relation-source" key={index}>
            <label>来源 {index + 1}<NativeSelect value={reference.sourceId} onChange={e => update({ sourceId: e.target.value, versionId: basis.sources.find(s => s.id === e.target.value)?.versions[0]?.id, pdfPages: [] })}>
              <NativeSelectOption value="">选择来源</NativeSelectOption>{basis.sources.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.id} · {s.title}</NativeSelectOption>)}
            </NativeSelect></label>
            <label>固定版本 {index + 1}<NativeSelect value={reference.versionId ?? ''} onChange={e => update({ ...reference, versionId: e.target.value })}><NativeSelectOption value="">选择版本</NativeSelectOption>{source?.versions.map(v => <NativeSelectOption key={v.id} value={v.id}>{v.id}</NativeSelectOption>)}</NativeSelect></label>
            <label>PDF 页码 {index + 1}<Input value={reference.pdfPages?.join(',') ?? ''} placeholder="如 25,26,27" onChange={e => update({ ...reference, pdfPages: e.target.value ? e.target.value.split(/[,，、\s]+/).map(Number) : [] })} /></label>
            <label>章节定位 {index + 1}<Input value={reference.section ?? ''} onChange={e => update({ ...reference, section: e.target.value })} /></label>
            <Button variant="outline" size="sm" type="button" onClick={() => changed({ ...draft, sourceRefs: refs.filter((_, i) => i !== index) })}>移除来源 {index + 1}</Button>
          </div>;
        })}
        <Button variant="outline" size="sm" type="button" onClick={() => changed({ ...draft, sourceRefs: [...refs, { sourceId: '', pdfPages: [] }] })}>添加来源</Button>
        {draft.type === 'requires' && <>
          <label>前置路线组<NativeSelect value={route} onChange={e => { setRoute(e.target.value); pending.current = undefined; const group = groupsFor(basis, e.target.value); if (group) { setRouteMode(group.mode); setRouteValue(group.value); } }}><NativeSelectOption value="none">不分组：必须条件</NativeSelectOption>{basis.graph.requirementGroups.filter(g => g.targetUnitId === draft.toUnitId).map(g => <NativeSelectOption key={g.id} value={g.id}>{g.id}</NativeSelectOption>)}<NativeSelectOption value="new">新建路线组</NativeSelectOption></NativeSelect></label>
          {route !== 'none' && <><label>路线规则<NativeSelect value={routeMode} onChange={e => { setRouteMode(e.target.value as 'all' | 'any'); pending.current = undefined; }}><NativeSelectOption value="all">全部需要 · AND</NativeSelectOption><NativeSelectOption value="any">任选一条 · OR</NativeSelectOption></NativeSelect></label><label>路线信息价值<Textarea value={routeValue} onChange={e => { setRouteValue(e.target.value); pending.current = undefined; }} /></label></>}
        </>}
        <div className="relation-actions"><Button size="sm" type="submit">保存正式关系</Button><Button variant="outline" size="sm" type="button" onClick={() => void reread()}>重新读取依据</Button><Button variant="outline" size="sm" type="button" onClick={() => { setDraft(undefined); setError(''); }}>取消审核</Button></div>
        {basis.graph.edges.some(edge => edge.id === draft.id) && <Button variant="destructive" size="sm" type="button" onClick={() => void submit(true)}>移除此正式关系</Button>}
      </fieldset>
    </form>}
    <section className="relation-prerequisites"><h3>前置条件</h3><p>未分组的项目全部必要；路线组保留 AND／OR。构造、优化、互逆不进入前置追溯。</p>
      <label>追溯单元<NativeSelect value={traceTarget} onChange={e => { setTraceTarget(e.target.value); setTrace(undefined); }}>{graph.nodes.map(node => <NativeSelectOption key={node.id} value={node.id}>{name(node.id)}</NativeSelectOption>)}</NativeSelect></label>
      <Button variant="outline" size="sm" onClick={async () => { try { const value = await window.yizhi.relations.prerequisites({ sessionId, unitId: traceTarget }); setTrace(value.conditions); } catch (failure) { setError((failure as Error).message); } }}>追溯全部前置</Button>
      {Object.entries(trace ?? graph.conditions).filter(([id]) => trace || id === traceTarget).map(([target, conditions]) => <section key={target}><h4>{name(target)}</h4>
        {conditions.required.map(id => <p key={id}>必须：{id}：{graph.nodes.find(node => node.id === id)?.name}</p>)}
        {conditions.groups.map(id => { const group = graph.requirementGroups.find(g => g.id === id)!; return <div key={id}><p>{group.id} · {group.mode === 'any' ? '任选一条' : '全部需要'}：{group.unitIds.map(name).join(group.mode === 'any' ? ' 或 ' : ' 且 ')}</p><p>{group.value}</p></div>; })}
      </section>)}
    </section>
    <h3>已审核正式关系 · {shown.length} 条</h3>
    {!shown.length && <p>此范围没有正式关系。可切换范围查看其他已审核关系。</p>}
    {shown.map(edge => <section className="relation-fact" key={edge.id}><h3>{edge.id} · {types[edge.type]} · {edge.type}</h3><p>{name(edge.fromUnitId)} {edge.directed ? '→' : '↔'} {name(edge.toUnitId)}</p><p>{edge.value}</p>
      <p>来源：{edge.sourceRefs.map(ref => `${ref.sourceId} · ${ref.versionId ?? '未记录版本'} · ${ref.pdfPages?.join('、') ?? ref.section ?? ''} ${ref.note ?? ''}`).join('；')}</p>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void begin(edge.id)}>审核 {edge.id}</Button></section>)}
  </aside>;
}
function groupsFor(basis: RelationBasis, id: string) { return basis.graph.requirementGroups.find(group => group.id === id); }
