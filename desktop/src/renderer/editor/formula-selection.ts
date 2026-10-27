import type { MathfieldElement } from 'mathlive';
import type { FormulaModel, FormulaEditProof } from '../../annotation-api';
import { equal } from '../../editor-api';
/** Public MathLive model offsets, scoped to this exact expression. No runtime atom IDs. */
export function formulaModel(field: MathfieldElement, sourceLatex = field.getValue()): FormulaModel {
  return { version: 1, encoding: 'mathlive-model', latex: sourceLatex,
    cells: Array.from({ length: field.lastOffset }, (_, i) => ({ latex: field.getValue([i, i + 1]), depth: field.getElementInfo(i + 1)?.depth ?? 0 })) };
}
export function formulaEdit(blockId: string, before: FormulaModel, after: FormulaModel, range: readonly number[]): FormulaEditProof | undefined {
  const from = Math.min(...range), to = Math.max(...range), inserted = after.cells.length - before.cells.length + to - from;
  if (inserted < 0 || !equal(before.cells.slice(0, from), after.cells.slice(0, from)) ||
    !equal(before.cells.slice(to), after.cells.slice(from + inserted))) return;
  return { blockId, before, after, from, to, inserted };
}
