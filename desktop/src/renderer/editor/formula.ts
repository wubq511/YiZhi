import { formulaModel, formulaEdit } from './formula-selection';
import type { FormulaModel, FormulaEditProof } from '../../annotation-api';
import { MathfieldElement } from 'mathlive';
import katex from 'katex';
import type { NodeView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { ReadingBlock } from '../../shared';
import { observation } from '../../acceptance-observation';

MathfieldElement.fontsDirectory = './mathlive-fonts';
MathfieldElement.soundsDirectory = null;

export function formulaView(initial: PMNode, changed: (blockId: string, latex: string, complete: boolean, proof?: FormulaEditProof, restored?: boolean) => void,
  draft: (blockId: string) => string | undefined, annotate: (block: ReadingBlock, field: MathfieldElement) => void): NodeView {
  let block = initial.attrs.block as ReadingBlock;
  const dom = document.createElement('div'); dom.className = 'editor-formula'; dom.contentEditable = 'false';
  dom.dataset.blockId = block.id;
  const staticMath = document.createElement('div'); staticMath.className = 'formula'; staticMath.setAttribute('role', 'math');
  const edit = document.createElement('button'); edit.textContent = '编辑公式'; edit.type = 'button';
  const state = document.createElement('span'); state.className = 'formula-draft'; state.setAttribute('role', 'status');
  let field: MathfieldElement | undefined;
  const resource = observation.resource('mathlive.instances');
  let temporary = false;
  let restoring = false, inputScheduled = false;
  let beforeInput: { model: FormulaModel; range: readonly number[] } | undefined;
  const select = document.createElement('button'); select.type = 'button'; select.textContent = '选择公式片段';
  const add = document.createElement('button'); add.type = 'button'; add.textContent = '批注公式选段'; add.hidden = true;
  add.onmousedown = event => event.preventDefault();
  add.onclick = () => { if (field) annotate(block, field); };
  const before = () => { if (field && field.selection.ranges.length === 1) beforeInput = { model: formulaModel(field, String(block.payload.latex)), range: [...field.selection.ranges[0]] }; };
  const paint = () => {
    staticMath.innerHTML = katex.renderToString(String(block.payload.latex), { throwOnError: false, trust: false, displayMode: true });
    staticMath.setAttribute('aria-label', String(block.payload.latex));
    state.textContent = draft(block.id) !== undefined ? '未完成公式 · 草稿已保留，正式公式保持原值' : '';
  };
  const processInput = () => {
    if (!field) return;
    const latex = field.getValue('latex');
    const complete = field.errors.length === 0 && !/\\placeholder\b/.test(latex) && !!latex.trim();
    const proof = beforeInput && formulaEdit(block.id, beforeInput.model, formulaModel(field), beforeInput.range);
    beforeInput = undefined;
    changed(block.id, latex, complete, proof, restoring); restoring = false;
    state.textContent = complete ? '' : '未完成公式 · 正在保留草稿';
  };
  const input = () => { if (!inputScheduled) { inputScheduled = true; queueMicrotask(() => { inputScheduled = false; processInput(); }); } };
  const enter = (readOnly: boolean) => {
    if (!field) {
      temporary = readOnly;
      field = new MathfieldElement();
      resource.set(1);
      field.mathVirtualKeyboardPolicy = 'manual';
      field.setAttribute('aria-label', '编辑公式内容');
      field.value = draft(block.id) ?? String(block.payload.latex);
      field.addEventListener('input', input);
      field.addEventListener('beforeinput', before);
      field.addEventListener('undo-state-change', event => {
        if (['undo', 'redo'].includes((event as CustomEvent).detail?.type)) { restoring = true; input(); }
      });
      // Capture before MathLive/PM keymaps. Exactly one owner handles the shortcut.
      field.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
          event.preventDefault(); event.stopImmediatePropagation();
          field!.executeCommand(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
          input();
        }
      }, true);
      dom.insertBefore(field, state);
    }
    field.readOnly = readOnly; field.dataset.annotationSelection = String(readOnly);
    staticMath.hidden = true; field.hidden = false; field.focus();
    edit.hidden = true; select.hidden = true; add.hidden = false; leave.hidden = false;
  };
  edit.onclick = () => enter(false);
  select.onclick = () => enter(true);
  const leave = document.createElement('button'); leave.type = 'button'; leave.textContent = '返回正文'; leave.hidden = true;

  leave.onclick = () => {
    if (field && temporary) { field.remove(); field = undefined; resource.set(0); }
    else if (field) { field.hidden = true; field.readOnly = false; field.dataset.annotationSelection = 'false'; }
    staticMath.hidden = false; edit.hidden = false; select.hidden = false; add.hidden = true; leave.hidden = true; paint();
    dom.dispatchEvent(new CustomEvent('formula-exit', { bubbles: true }));
  };
  dom.addEventListener('formula-annotation-reveal', event => {
    const detail = (event as CustomEvent).detail; enter(true);
    if (field && detail.model && JSON.stringify(formulaModel(field, String(block.payload.latex))) === JSON.stringify(detail.model)) field.selection = { ranges: [[detail.from, detail.to]] };
  });
  dom.append(staticMath, edit, select, add, leave, state); paint();
  return { dom, stopEvent: () => true, ignoreMutation: () => true,
    update(node) {
      if (node.type.name !== 'formula' || node.attrs.block.id !== block.id) return false;
      const next = node.attrs.block as ReadingBlock;
      // Own acknowledgements and node-view updates never reset active input or its inner history.
      if (next.payload.latex !== block.payload.latex && field && !field.hasFocus() && draft(block.id) === undefined &&
        field.getValue() !== next.payload.latex) field.setValue(String(next.payload.latex), { silenceNotifications: true });
      block = next; paint(); return true;
    }, destroy() { field?.removeEventListener('input', input); resource.close(); },
  };
}
