import { useState, type ReactNode } from 'react';
import { Braces, Check, CircleAlert, Clock, FileText, Layers, ListChecks, Search, Send, Sparkle } from 'lucide-react';
import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
  TraceDescription, TraceIcon, TraceLine, TraceTitle,
} from './components/ui/trace';
import type { AgentTask, ReasoningSegment } from '../agent-api';

export type ToolFact = { taskId: string; name: string; purpose: string; referenceId: string; digest: string; references: string[]; hasRecoveryPayload: boolean };

/** Student-readable names for the narrow yizhi_* tools the executor actually offers. An unlisted name is shown as-is rather than invented. */
const toolLabel: Record<string, { label: string; icon: typeof Search }> = {
  yizhi_read_target: { label: '读取单元正文', icon: FileText },
  yizhi_list_sources: { label: '列出已登记原文版本', icon: ListChecks },
  yizhi_read_citation: { label: '核对原文引用', icon: Search },
  yizhi_read_source_page: { label: '读取原页', icon: FileText },
  yizhi_queue_guidance: { label: '安排为新事项', icon: Send },
  yizhi_read_edit_context: { label: '读取最新正文与保护范围', icon: Layers },
  yizhi_apply_group: { label: '保存一组修改', icon: Check },
  yizhi_query_group: { label: '查询修改保存结果', icon: CircleAlert },
  yizhi_publish_lesson: { label: '发布小主题内容', icon: Check },
  yizhi_query_lesson: { label: '查询小主题发布结果', icon: CircleAlert },
};

const seconds = (from: string, to: string | null) => {
  const start = Date.parse(from), end = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const value = Math.max(0, Math.round((end - start) / 1000));
  return value ? ` · ${value} 秒` : '';
};

function ToolRow({ fact, running, error }: { fact: ToolFact; running: boolean; error?: string }) {
  const known = toolLabel[fact.name];
  const Icon = known?.icon ?? Braces;
  return <TraceCollapsible>
    <TraceCollapsibleTrigger>
      <TraceLine status={error ? 'error' : running ? 'running' : undefined}>
        <TraceIcon><Icon /></TraceIcon>
        <TraceTitle>{known?.label ?? fact.name}</TraceTitle>
        {fact.references.length > 0 && <TraceDescription>{fact.references.length} 处引用</TraceDescription>}
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent>
      <p>实际工具：<code>{fact.name}</code></p>
      {error && <p>该次调用返回失败：{error}</p>}
      {fact.references.length > 0 && <p>本次引用：{fact.references.join('、')}</p>}
      <p>结果指纹 {fact.digest.slice(0, 12)}</p>
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/** Streams open while the model is thinking, collapses itself once the item completes, and stays reopenable. */
function ReasoningRow({ segment }: { segment: ReasoningSegment }) {
  // A student collapsing a still-running row must be able to; the stream only decides the default.
  const [choice, setChoice] = useState<boolean | null>(null);
  const streaming = segment.state === 'streaming';
  return <TraceCollapsible open={choice ?? streaming} onOpenChange={setChoice}>
    <TraceCollapsibleTrigger>
      <TraceLine status={streaming ? 'running' : undefined}>
        <TraceIcon><Sparkle /></TraceIcon>
        <TraceTitle>{streaming ? '正在思考' : segment.state === 'partial' ? '思考（未完整收到）' : '思考'}</TraceTitle>
        <TraceDescription>{seconds(segment.startedAt, segment.endedAt).replace(/^ · /, '')}</TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>
    {/* Bounded height keeps the stream anchor stable when a long chain collapses. */}
    <TraceCollapsibleContent className="max-h-44 overflow-y-auto">
      <p className="whitespace-pre-wrap">{segment.text}</p>
      {segment.state === 'complete' && <p>以上是模型自己的思考记录，不是课程结论。</p>}
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/** Everything about how one answer was produced, in the order it actually happened. */
export function AgentTrace({ task, reasonings, facts, live, receipts }: { task: AgentTask; reasonings: ReasoningSegment[]; facts: ToolFact[]; live: boolean; receipts?: ReactNode }) {
  const failures = new Map((task.toolErrors ?? []).map(item => [item.name, item.error]));
  if (!reasonings.length && !facts.length && !receipts) return null;
  return <Trace aria-label="回答产生过程">
    {reasonings.map(segment => <ReasoningRow key={segment.id} segment={segment} />)}
    {facts.map((fact, index) => <ToolRow key={`${fact.referenceId}-${fact.digest.slice(0, 8)}`} fact={fact}
      error={failures.get(fact.name)} running={live && index === facts.length - 1} />)}
    {receipts}
  </Trace>;
}
