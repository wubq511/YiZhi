import { MathfieldElement } from 'mathlive';
import katex from 'katex';
import type { NodeView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { ReadingBlock } from '../../shared';

MathfieldElement.fontsDirectory = './mathlive-fonts';
MathfieldElement.soundsDirectory = null;

export function formulaView(initial: PMNode, changed: (blockId: string, latex: string, complete: boolean) => void,
  draft: (blockId: string) => string | undefined): NodeView {
  let block = initial.attrs.block as ReadingBlock;
  const dom = document.createElement('div'); dom.className = 'editor-formula'; dom.contentEditable = 'false';
  dom.dataset.blockId = block.id;
  const staticMath = document.createElement('div'); staticMath.className = 'formula'; staticMath.setAttribute('role', 'math');
  const edit = document.createElement('button'); edit.textContent = '编辑公式'; edit.type = 'button';
  const state = document.createElement('span'); state.className = 'formula-draft'; state.setAttribute('role', 'status');
  let field: MathfieldElement | undefined;
  const paint = () => {
    staticMath.innerHTML = katex.renderToString(String(block.payload.latex), { throwOnError: false, trust: false, displayMode: true });
    staticMath.setAttribute('aria-label', String(block.payload.latex));
    state.textContent = draft(block.id) !== undefined ? '未完成公式 · 草稿已保留，正式公式保持原值' : '';
  };
  const input = () => {
    if (!field) return;
    const latex = field.getValue('latex');
    const complete = field.errors.length === 0 && !/\\placeholder\b/.test(latex) && !!latex.trim();
    changed(block.id, latex, complete);
    state.textContent = complete ? '' : '未完成公式 · 正在保留草稿';
  };
  edit.onclick = () => {
    if (!field) {
      field = new MathfieldElement();
      field.mathVirtualKeyboardPolicy = 'manual';
      field.setAttribute('aria-label', '编辑公式内容');
      field.value = draft(block.id) ?? String(block.payload.latex);
      field.addEventListener('input', input);
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
    staticMath.hidden = true; field.hidden = false; field.focus();
    edit.hidden = true;
  };
  const leave = document.createElement('button'); leave.type = 'button'; leave.textContent = '返回正文'; leave.hidden = true;
  edit.addEventListener('click', () => { leave.hidden = false; });
  leave.onclick = () => {
    if (field) field.hidden = true;
    staticMath.hidden = false; edit.hidden = false; leave.hidden = true; paint();
    dom.dispatchEvent(new CustomEvent('formula-exit', { bubbles: true }));
  };
  dom.append(staticMath, edit, leave, state); paint();
  return { dom, stopEvent: () => true, ignoreMutation: () => true,
    update(node) {
      if (node.type.name !== 'formula' || node.attrs.block.id !== block.id) return false;
      const next = node.attrs.block as ReadingBlock;
      // Own acknowledgements and node-view updates never reset active input or its inner history.
      if (next.payload.latex !== block.payload.latex && field && !field.hasFocus() && draft(block.id) === undefined &&
        field.getValue() !== next.payload.latex) field.setValue(String(next.payload.latex), { silenceNotifications: true });
      block = next; paint(); return true;
    }, destroy() { field?.removeEventListener('input', input); },
  };
}
