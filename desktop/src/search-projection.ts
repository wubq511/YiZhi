import type { CourseUnit, ReadingBlock } from './shared';
export interface ReadableField { field: string; text: string; blockId?: string; disclosure: string[] }
/** The fields that the reader actually renders. Opaque payloads are deliberately excluded. */
export function knowledgeFields(unit: CourseUnit): ReadableField[] {
  const result: ReadableField[] = [];
  const put = (field: string, text: unknown, blockId?: string, disclosure: string[] = []) => {
    if (typeof text === 'string' && text.length) result.push({ field, text, blockId, disclosure });
  };
  put('name', unit.name); put('outcome', unit.outcome);
  if (Array.isArray(unit.aliases)) unit.aliases.forEach((alias, i) => put(`aliases.${i}`, alias));
  const walk = (blocks: ReadingBlock[], disclosure: string[]) => {
    for (const block of blocks) {
      const p = block.payload, id = block.id;
      const add = (field: string, text: unknown, path = disclosure) => put(field, text, id, path);
      if (block.kind === 'paragraph' || block.kind === 'callout') add('text', p.text);
      else if (block.kind === 'formula') add('latex', p.latex);
      else if (block.kind === 'table') {
        p.columns?.forEach((s: unknown, i: number) => add(`columns.${i}`, s));
        p.rows?.forEach((row: unknown[], i: number) => row.forEach((s, j) => add(`rows.${i}.${j}`, typeof s === 'number' ? String(s) : s)));
      } else if (block.kind === 'steps') p.items?.forEach((s: unknown, i: number) => add(`items.${i}`, s));
      else if (block.kind === 'example' || block.kind === 'exercise') {
        add('title', p.title); add('problem', p.problem, [...disclosure, id]);
        add('hint', p.hint, [...disclosure, id, `${id}:hint`]);
      } else if (block.kind === 'knowledge-reference') add('intent', p.intent);
      else if (block.kind === 'figure' && p.asset) { add('alt', p.alt); add('caption', p.caption); }
      else if (block.kind === 'figure' && p.config?.nodes) {
        add('alt', p.alt); add('config.caption', p.config.caption);
        p.config.nodes.forEach((n: any, i: number) => add(`config.nodes.${i}.label`, n.label));
      } else if (block.kind === 'interactive' && ['mux', 'decoder', 'kmap'].includes(p.component)) add('title', p.title);
      const childrenPath = ['example', 'exercise'].includes(block.kind) ? [...disclosure, id, ...(block.kind === 'exercise' ? [`${id}:answer`] : [])] : disclosure;
      // Unknown renderers only show retained JSON; those bytes aren't readable course prose.
      if (['callout', 'steps', 'example', 'exercise'].includes(block.kind)) walk(block.children ?? [], childrenPath);
    }
  };
  walk(unit.reading.blocks, []); return result;
}
/** Identity projection: case, compatibility characters, spaces and operators remain distinct. */
export const searchText = (text: string) => text;
