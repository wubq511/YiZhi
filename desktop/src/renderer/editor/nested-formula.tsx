import { createContext, useContext, useEffect, useRef } from 'react';
import katex from 'katex';
import type { ReadingBlock } from '../../shared';
import { formulaView } from './formula';

export type FormulaEditing = {
  changed: Parameters<typeof formulaView>[1];
  draft: Parameters<typeof formulaView>[2];
  annotate: Parameters<typeof formulaView>[3];
};
export const FormulaEditingContext = createContext<FormulaEditing | undefined>(undefined);

/** A prepared material stays one preserved object; its formula leaves use the same input owner. */
export function NestedFormula({ block }: { block: ReadingBlock }) {
  const editing = useContext(FormulaEditingContext), host = useRef<HTMLDivElement>(null);
  const view = useRef<ReturnType<typeof formulaView> | undefined>(undefined);
  useEffect(() => {
    if (!editing || !host.current) return;
    const current = formulaView({ attrs: { block }, type: { name: 'formula' } }, editing.changed, editing.draft, editing.annotate);
    host.current.replaceChildren(current.dom); view.current = current;
    return () => { current.destroy(); view.current = undefined; };
  }, [editing, block.id]);
  useEffect(() => { view.current?.update({ attrs: { block }, type: { name: 'formula' } }); }, [block]);
  return editing ? <div ref={host} /> : <div className="formula" data-search-field="latex" role="math" aria-label={block.payload.latex}
    dangerouslySetInnerHTML={{ __html: katex.renderToString(block.payload.latex, { throwOnError: false, trust: false, displayMode: true }) }} />;
}
