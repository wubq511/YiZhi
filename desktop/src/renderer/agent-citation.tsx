import { Button } from './components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './components/ui/hover-card';
import type { SourceCitation, SourceVersion } from '../sources-api';

type Reference = { citation: SourceCitation; version: SourceVersion };

/**
 * The answer's sources ride as numbered markers rather than a separate evidence card: a citation belongs to the
 * sentence it supports. The marker is also the accessible trigger, so keyboard reaches the quote and the locator.
 */
export function AgentCitations({ references, open }: { references: Reference[]; open(citation: SourceCitation): void }) {
  if (!references.length) return null;
  return <div className="agent-citations" aria-label="固定课程出处">
    <ol>
      {references.map(({ citation, version }, index) => <li key={citation.id}>
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button variant="ghost" size="xs" className="agent-citation-marker"
              aria-label={`出处 ${index + 1}：${version.title} PDF 第 ${citation.pdfPageIndex + 1} 页`}>{index + 1}</Button>
          </HoverCardTrigger>
          <HoverCardContent align="start" className="agent-citation-card">
            {citation.quote
              ? <blockquote>{citation.quote}</blockquote>
              : <p>{citation.textStatus === 'no-text-layer' ? '无可靠文字层，仅携带原页／选区，未做 OCR' : '原页／选区出处'}</p>}
            <p className="agent-citation-meta"><span className="agent-nowrap">{version.title}</span><span className="agent-nowrap"> · PDF 第 {citation.pdfPageIndex + 1} 页</span><span className="agent-nowrap"> · 印刷页 {citation.printedPage?.label ?? '未核对'}</span></p>
            <Button variant="link" size="xs" onClick={() => open(citation)}>定位原页</Button>
          </HoverCardContent>
        </HoverCard>
      </li>)}
    </ol>
  </div>;
}
