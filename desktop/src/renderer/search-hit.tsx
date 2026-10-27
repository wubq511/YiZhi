import type { ReactNode } from 'react';
import type { SearchHit, SearchScope } from '../search-api';
const labels: Record<SearchScope, string> = { knowledge: '知识', notes: '个人笔记', messages: '学习对话', sources: '来源原文' };
/** Same versioned result card and locator for literal and described search. */
export function SearchHitCard({ hit, locate, children }: { hit: SearchHit; locate(hit: SearchHit): void; children?: ReactNode }) {
  return <article className="search-result"><p className="search-result-kind">{labels[hit.scope]}{hit.pdfPageIndex !== undefined && ` · PDF 第 ${hit.pdfPageIndex + 1} 页`}</p><h3>{hit.title}</h3><p className="search-excerpt">{hit.excerpt}</p>
    <details><summary>身份与版本</summary><p>{hit.entityId}{hit.blockId && ` · ${hit.blockId}`} · {hit.field}</p><p>版本 {hit.version}</p>{hit.projectionId && <p>文本投影 {hit.projectionId} · {hit.convention}</p>}</details>
    {children}<button onClick={() => locate(hit)}>定位命中</button>
  </article>;
}
