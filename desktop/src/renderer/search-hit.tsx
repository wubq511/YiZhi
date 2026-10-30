import { useId, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from './components/ui/button';
import type { SearchHit, SearchScope } from '../search-api';
const labels: Record<SearchScope, string> = { knowledge: '知识', notes: '个人笔记', messages: '学习对话', sources: '来源原文' };
/** Same versioned result card and locator for literal and described search. */
export function SearchHitCard({ hit, locate, children }: { hit: SearchHit; locate(hit: SearchHit): void; children?: ReactNode }) {
  const titleId = useId();
  const match = hit.quote ? hit.excerpt.indexOf(hit.quote) : -1;
  const uniqueMatch = match >= 0 && hit.excerpt.indexOf(hit.quote, match + 1) < 0;
  return <article className="search-result"><div className="search-result-heading"><h3 id={titleId}>{hit.title}</h3><span className="search-result-kind">{labels[hit.scope]}</span></div>
    {hit.pdfPageIndex !== undefined && <p className="search-result-page">PDF 第 {hit.pdfPageIndex + 1} 页</p>}
    <p className="search-excerpt">{uniqueMatch ? <>{hit.excerpt.slice(0, match)}<mark>{hit.quote}</mark>{hit.excerpt.slice(match + hit.quote.length)}</> : hit.excerpt}</p>
    {children}<Button variant="ghost" size="sm" className="search-result-locate" aria-describedby={titleId} onClick={() => locate(hit)}>定位命中<ArrowRight size={14} aria-hidden="true"/></Button>
  </article>;
}
