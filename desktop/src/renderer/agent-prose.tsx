import katex from 'katex';
import type { ReactNode } from 'react';

const inline = /\*\*([^*]+)\*\*|`([^`]+)`|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g;

/** Inline subset only. Text stays as React children, so model output can never inject markup; KaTeX is the sole HTML producer. */
function inlineNodes(text: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let start = 0, match: RegExpExecArray | null, n = 0;
  while ((match = inline.exec(text))) {
    if (match.index > start) parts.push(text.slice(start, match.index));
    const id = `${key}-${n++}`;
    if (match[1]) parts.push(<strong key={id}>{match[1]}</strong>);
    else if (match[2]) parts.push(<code key={id}>{match[2]}</code>);
    else parts.push(<span key={id} className="agent-math" dangerouslySetInnerHTML={{
      __html: katex.renderToString(match[3] ?? match[4] ?? match[5] ?? match[6],
        { throwOnError: false, trust: false, displayMode: Boolean(match[4] ?? match[5]) }),
    }} />);
    start = inline.lastIndex;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

const heading = /^(#{1,6})\s+(.+)$/;
const bullet = /^\s*[-*+]\s+(.+)$/;
const numbered = /^\s*(\d+)[.)]\s+(.+)$/;
const quote = /^\s*>\s?(.*)$/;

/** A link is shown with its destination visible instead of becoming an in-app anchor: the learning window denies navigation, so a hidden target would be a dead control. */
function visibleLinks(text: string) { return text.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `${label && label !== url ? `${label} ` : ''}${url}`); }

export function AgentProse({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let index = 0, paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const key = `p${blocks.length}`;
    // A single newline stays a line break: the answer contract separates 课程依据 and 补充解释 on their own lines,
    // and markdown's soft-break-joins-paragraph rule would fuse them into one block.
    const nodes: ReactNode[] = [];
    paragraph.forEach((line, i) => {
      if (i) nodes.push(<br key={`${key}-br${i}`} />);
      nodes.push(...inlineNodes(visibleLinks(line), `${key}-${i}`));
    });
    blocks.push(<p key={key}>{nodes}</p>);
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { flush(); index++; continue; }
    const head = heading.exec(line);
    if (head) {
      flush();
      const level = Math.min(4, head[1].length + 1);
      const Tag = (`h${level}`) as 'h3' | 'h4';
      blocks.push(<Tag key={`h${blocks.length}`}>{inlineNodes(visibleLinks(head[2]), `h${blocks.length}`)}</Tag>);
      index++; continue;
    }
    if (bullet.test(line)) {
      flush();
      const items: string[] = [];
      while (index < lines.length && bullet.test(lines[index])) { items.push(bullet.exec(lines[index])![1]); index++; }
      blocks.push(<ul key={`u${blocks.length}`}>{items.map((item, i) => <li key={i}>{inlineNodes(visibleLinks(item), `u${blocks.length}-${i}`)}</li>)}</ul>);
      continue;
    }
    if (numbered.test(line)) {
      flush();
      const items: string[] = [];
      while (index < lines.length && numbered.test(lines[index])) { items.push(numbered.exec(lines[index])![2]); index++; }
      blocks.push(<ol key={`o${blocks.length}`}>{items.map((item, i) => <li key={i}>{inlineNodes(visibleLinks(item), `o${blocks.length}-${i}`)}</li>)}</ol>);
      continue;
    }
    if (quote.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && quote.test(lines[index])) { quoted.push(quote.exec(lines[index])![1]); index++; }
      blocks.push(<blockquote key={`q${blocks.length}`}>{inlineNodes(visibleLinks(quoted.join(' ')), `q${blocks.length}`)}</blockquote>);
      continue;
    }
    paragraph.push(line.trim());
    index++;
  }
  flush();
  return <div className="agent-prose">{blocks}</div>;
}
