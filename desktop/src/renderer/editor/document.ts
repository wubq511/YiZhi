import { Node, Extension, type JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory, history, undo, redo } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { ContentPatch } from '../../editor-api';
import { equal } from '../../editor-api';
import type { ReadingBlock } from '../../shared';

export const newId = () => `student-${crypto.randomUUID()}`;
function clipboardBlock(element: HTMLElement): ReadingBlock | null {
  try {
    const block = JSON.parse(element.dataset.courseBlock ?? 'null');
    return block && typeof block.id === 'string' && typeof block.kind === 'string' && block.payload && typeof block.payload === 'object' ? block : null;
  } catch { return null; }
}
export function copyBlock(block: ReadingBlock): ReadingBlock {
  return { ...structuredClone(block), id: newId(), ...(block.children ? { children: block.children.map(copyBlock) } : {}) };
}
export function project(block: ReadingBlock): JSONContent {
  const editable = !block.children?.length;
  if (block.kind === 'paragraph' && editable) return { type: 'paragraph', attrs: { block },
    ...(block.payload.text ? { content: [{ type: 'text', text: String(block.payload.text) }] } : {}) };
  return { type: block.kind === 'formula' && editable ? 'formula' : 'opaque', attrs: { block } };
}
export function blocksOf(doc: PMNode): ReadingBlock[] {
  const blocks: ReadingBlock[] = [];
  doc.forEach(node => {
    const block: ReadingBlock = structuredClone(node.attrs.block);
    if (node.type.name === 'paragraph') block.payload.text = node.textContent;
    blocks.push(block);
  });
  return blocks;
}
export function delta(before: ReadingBlock[], after: ReadingBlock[], unitId: string,
  correspondence: ContentPatch['correspondence'] = []): ContentPatch {
  const old = new Map(before.map(b => [b.id, b]));
  const ids = after.map(b => b.id), prior = before.map(b => b.id);
  return { updates: after.filter(b => old.has(b.id) && !equal(old.get(b.id)!.payload, b.payload))
    .map(b => ({ blockId: b.id, before: old.get(b.id)!.payload, after: b.payload })),
    ...(!equal(ids, prior) ? { structure: { parentId: unitId, before: prior, after: ids, inserted: after.filter(b => !old.has(b.id)) } } : {}),
    correspondence };
}
export function freshClipboard(slice: Slice): Slice {
  const map = (fragment: Fragment): Fragment => Fragment.fromArray(fragment.content.map(node => {
    const attrs = node.attrs.block ? { ...node.attrs, block: copyBlock(node.attrs.block) } : node.attrs;
    return node.isText ? node : node.type.create(attrs, map(node.content), node.marks);
  }));
  return new Slice(map(slice.content), slice.openStart, slice.openEnd);
}
export const ContinuousParagraph = Paragraph.extend({
  addAttributes() { return { block: { default: null, rendered: false, parseHTML: clipboardBlock } }; },
  renderHTML({ node }) { return ['p', { 'data-block-id': node.attrs.block?.id, 'data-course-block': JSON.stringify(node.attrs.block) }, 0]; },
});
export const IdentityAndHistory = Extension.create({
  name: 'courseIdentityAndHistory',
  priority: 1100,
  addKeyboardShortcuts() {
    const boundary = () => { this.editor.view.dispatch(closeHistory(this.editor.state.tr)); return false; };
    return { Enter: boundary,
      Backspace: () => this.editor.state.selection.empty && this.editor.state.selection.$from.parentOffset === 0 ? boundary() : false,
      Delete: () => this.editor.state.selection.empty && this.editor.state.selection.$from.parentOffset === this.editor.state.selection.$from.parent.content.size ? boundary() : false,
      'Mod-z': () => undo(this.editor.state, this.editor.view.dispatch),
      'Mod-Shift-z': () => redo(this.editor.state, this.editor.view.dispatch),
      'Mod-y': () => redo(this.editor.state, this.editor.view.dispatch) };
  },
  addProseMirrorPlugins() {
    return [history(), new Plugin({ props: { decorations(state) {
      const decorations: Decoration[] = []; let index = 0;
      state.doc.forEach((node, pos) => { if (node.type.name === 'paragraph') {
        const i = index++;
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { role: 'textbox', tabindex: '-1',
          'aria-label': i === 0 ? '编辑首段正文' : i === 1 ? '编辑第二段正文' : `编辑第 ${i + 1} 段正文`, 'aria-multiline': 'true' }));
      } }); return DecorationSet.create(state.doc, decorations);
    } }, appendTransaction(transactions, _old, state) {
      if (!transactions.some(tr => tr.docChanged)) return null;
      const ids = new Set<string>(), tr = state.tr;
      const correspondence: ContentPatch['correspondence'] = [];
      state.doc.forEach((node, pos) => {
        const original = node.attrs.block as ReadingBlock | null;
        let block = original;
        if (!block || ids.has(block.id)) {
          const id = newId();
          block = node.type.name === 'paragraph' ? { id, kind: 'paragraph', payload: { text: node.textContent } }
            : copyBlock(original!);
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, block });
          if (original) {
            let left: PMNode | undefined;
            state.doc.forEach(n => { if (!left && n.attrs.block?.id === original.id) left = n; });
            correspondence.push({ kind: 'split', sourceId: original.id, targetId: block.id,
              offset: Array.from(left?.textContent ?? '').length });
          }
        }
        ids.add(block.id);
      });
      return tr.steps.length ? tr.setMeta('editorCorrespondence', correspondence) : null;
    } })];
  },
});
export const baseExtensions = [Document, ContinuousParagraph, Text, IdentityAndHistory];
export function atom(name: 'opaque' | 'formula') {
  return Node.create({ name, group: 'block', atom: true, selectable: true, draggable: true,
    addAttributes() { return { block: { default: null, rendered: false, parseHTML: clipboardBlock } }; },
    parseHTML() { return [{ tag: `div[data-course-node="${name}"]`, getAttrs: el => clipboardBlock(el as HTMLElement) ? null : false }]; },
    renderHTML({ node }) { return ['div', { 'data-course-node': name, 'data-block-id': node.attrs.block?.id,
      // Clipboard serialization is ephemeral; only our actual node schema can recover an opaque object.
      'data-course-block': JSON.stringify(node.attrs.block) }]; },
  });
}
