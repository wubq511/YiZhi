import katex from 'katex';
import type { ReactNode } from 'react';
/** Small safe reading subset: React escapes prose; only KaTeX produces trusted HTML. */
export function AgentProse({ text }: { text: string }) {
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  const tokens = /\*\*([^*]+)\*\*|`([^`]+)`|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g;
  const parts: ReactNode[] = []; let start = 0, match: RegExpExecArray | null;
  while ((match = tokens.exec(text))) {
    if (match.index > start) parts.push(text.slice(start, match.index));
    const key = match.index;
    if (match[1]) parts.push(<strong key={key}>{match[1]}</strong>);
    else if (match[2]) parts.push(<code key={key}>{match[2]}</code>);
    else parts.push(<span key={key} className="agent-math" dangerouslySetInnerHTML={{ __html: katex.renderToString(match[3] ?? match[4] ?? match[5] ?? match[6], { throwOnError: false, trust: false, displayMode: Boolean(match[4] ?? match[5]) }) }} />);
    start = tokens.lastIndex;
  }
  if (start < text.length) parts.push(text.slice(start));
  return <div className="agent-prose">{parts}</div>;
}
