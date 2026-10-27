import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { closeHistory, undo, redo } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { OpenedCourse, ReadingBlock } from '../../shared';
import { equal } from '../../editor-api';
import type { ContentPatch } from '../../editor-api';
import type { ParagraphSaveChannel } from '../save-channel';
import { atom, baseExtensions, blocksOf, delta, freshClipboard, project } from './document';
import { formulaView } from './formula';

export interface EditorOptions {
  renderOpaque(element: HTMLElement, block: ReadingBlock): () => void;
  composition(active: boolean): void;
}
/** Owns only an active B's ephemeral projection/history. Durable truth lives behind SaveBridge. */
export class ContinuousEditor {
  readonly editor: Editor;
  private previous: ReadingBlock[];
  private drafts = new Map<string, string>();
  private composing = false;
  private pending?: OpenedCourse;
  constructor(element: HTMLElement, private course: OpenedCourse, private channel: ParagraphSaveChannel, private options: EditorOptions) {
    channel.useContentPatches();
    const recovered = structuredClone(course.unit.reading.blocks);
    const recovery = channel.recovery();
    for (const block of recovered) if (block.kind === 'paragraph') block.payload.text = channel.text(block.id) ?? block.payload.text;
    // Recover only a verified original basis. Incompatible drafts remain durable for reconciliation.
    if (recovery.patch && course.drafts.some(d => d.input.baseRevision === course.revision)) {
      for (const u of recovery.patch.updates) { const b = recovered.find(b => b.id === u.blockId); if (b && equal(b.payload, u.before)) b.payload = u.after; }
      if (recovery.patch.structure && equal(recovery.patch.structure.before, recovered.map(b => b.id))) {
        const byId = new Map([...recovered, ...recovery.patch.structure.inserted].map(b => [b.id, b]));
        recovered.splice(0, recovered.length, ...recovery.patch.structure.after.map(id => byId.get(id)!));
      }
    }
    this.drafts = new Map(recovery.formulaDrafts.map(f => [f.blockId, f.latex]));
    this.previous = recovered;
    const opaque = atom('opaque').extend({ addNodeView: () => ({ node }) => {
      const dom = document.createElement('div'); dom.contentEditable = 'false'; dom.dataset.blockId = node.attrs.block.id;
      dom.className = 'editor-preserved';
      const cleanup = options.renderOpaque(dom, node.attrs.block);
      return { dom, stopEvent: () => true, ignoreMutation: () => true, destroy: cleanup };
    } });
    const formula = atom('formula').extend({ addNodeView: () => ({ node }) => formulaView(node,
      (id, latex, complete) => this.formulaInput(id, latex, complete), id => this.drafts.get(id)) });
    this.editor = new Editor({ element, extensions: [...baseExtensions, opaque, formula],
      content: { type: 'doc', content: recovered.map(project) },
      editorProps: { attributes: { role: 'textbox', 'aria-label': '连续编辑正文', 'aria-multiline': 'true', class: 'continuous-prose nodrag nopan' },
        transformPasted: freshClipboard,
        handleDOMEvents: {
          compositionstart: () => { this.composing = true; options.composition(true); return false; },
          compositionend: () => { this.composing = false; options.composition(false);
            queueMicrotask(() => { this.changed(); if (this.pending) this.reconcile(this.pending); }); return false; },
          blur: () => { queueMicrotask(() => { if (this.pending) this.reconcile(this.pending); }); return false; },
        },
      },
      onUpdate: ({ transaction, appendedTransactions }) => {
        const correspondences = [transaction, ...appendedTransactions].flatMap(tr => tr.getMeta('editorCorrespondence') ?? []);
        this.changed(correspondences, !!transaction.getMeta('external'));
      },
    });
    // Paragraph aliases remain programmatically focusable for accessibility/legacy IPC tests,
    // while ProseMirror owns the single native editing focus and selection observer.
    this.editor.view.dom.addEventListener('focusin', event => {
      if ((event.target as HTMLElement).matches('p[data-block-id]')) queueMicrotask(() => {
        const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        this.editor.view.dom.focus({ preventScroll: true });
        if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
      });
    });
    element.addEventListener('formula-exit', () => this.editor.commands.focus());
  }
  private changed(correspondence: ContentPatch['correspondence'] = [], external = false) {
    if (this.composing) return;
    const current = blocksOf(this.editor.state.doc);
    const patch = delta(this.previous, current, this.course.unit.id, correspondence);
    if (!external && (patch.updates.length || patch.structure)) {
      // Exact adjacent joins are proven by the actual edited before/after documents.
      for (let i = 1; i < this.previous.length; i++) {
        const left = this.previous[i - 1], right = this.previous[i], survivor = current.find(b => b.id === left.id);
        if (left.kind === 'paragraph' && right.kind === 'paragraph' && !current.some(b => b.id === right.id) &&
          survivor?.payload.text === left.payload.text + right.payload.text)
          patch.correspondence.push({ kind: 'merge', sourceId: right.id, targetId: left.id, offset: Array.from(String(left.payload.text)).length });
      }
      this.channel.edit({ changes: [], patch, formulaDrafts: this.formulaDrafts(current) });
    }
    this.previous = current;
  }
  private formulaDrafts(blocks = this.previous) {
    const live = new Set(blocks.map(b => b.id));
    return [...this.drafts].filter(([id]) => live.has(id)).map(([blockId, latex]) => ({ blockId, latex }));
  }
  private formulaInput(id: string, latex: string, complete: boolean) {
    if (!complete) { this.drafts.set(id, latex); this.channel.edit({ changes: [], formulaDrafts: this.formulaDrafts() }); return; }
    const hadDraft = this.drafts.delete(id);
    let found = false;
    this.editor.state.doc.forEach((node, pos) => {
      if (node.attrs.block.id === id && node.attrs.block.payload.latex !== latex) {
        found = true;
        const block = { ...node.attrs.block, payload: { ...node.attrs.block.payload, latex } };
        this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(pos, undefined, { block }).setMeta('addToHistory', false));
      }
    });
    if (!found && hadDraft) this.channel.edit({ changes: [], patch: { updates: [], correspondence: [] }, formulaDrafts: this.formulaDrafts() });
  }
  setEditable(editable: boolean) {
    this.editor.setEditable(editable);
    this.editor.view.dom.querySelectorAll('math-field').forEach(field => { (field as HTMLElement & { readOnly: boolean }).readOnly = !editable; });
    this.editor.view.dom.querySelectorAll<HTMLButtonElement>('.editor-formula button').forEach(button => { button.disabled = !editable; });
  }
  undo() { undo(this.editor.state, this.editor.view.dispatch); }
  redo() { redo(this.editor.state, this.editor.view.dispatch); }
  splitFirst() {
    const first = this.editor.state.doc.firstChild;
    if (first?.type.name !== 'paragraph' || first.textContent.length < 2) return;
    const offset = Array.from(first.textContent).slice(0, Math.floor(Array.from(first.textContent).length / 2)).join('').length;
    this.editor.view.dispatch(closeHistory(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, offset + 1))));
    this.editor.commands.splitBlock();
  }
  insertFormula() {
    this.editor.commands.insertContent({ type: 'formula', attrs: { block: { id: `student-${crypto.randomUUID()}`, kind: 'formula', payload: { latex: 'x' } } } });
  }
  /** Explicit internal object move provides identity evidence; clipboard IDs never do. */
  moveSelected(direction: -1 | 1) {
    const { state, view } = this.editor, position = state.selection.$from.depth ? state.selection.$from.before(1) : state.selection.from;
    const nodes: Array<{ node: PMNode; pos: number }> = [];
    state.doc.forEach((node, pos) => nodes.push({ node, pos }));
    const index = nodes.findIndex(n => n.pos === position), target = index + direction;
    if (index < 0 || target < 0 || target >= nodes.length) return;
    const item = nodes[index], adjacent = nodes[target];
    const tr = closeHistory(state.tr).delete(item.pos, item.pos + item.node.nodeSize);
    const destination = direction < 0 ? adjacent.pos : adjacent.pos + adjacent.node.nodeSize - item.node.nodeSize;
    tr.insert(destination, item.node).setMeta('editorCorrespondence', [{ kind: 'move', sourceId: item.node.attrs.block.id, targetId: item.node.attrs.block.id }]);
    tr.setSelection(item.node.isTextblock ? TextSelection.create(tr.doc, destination + 1) : NodeSelection.create(tr.doc, destination));
    view.dispatch(tr); view.focus();
  }
  /** External updates are range transactions, never setContent/recreate. T06 extends protection/integration. */
  reconcile(snapshot: OpenedCourse): boolean {
    if (snapshot.revision <= this.course.revision) return true;
    if (this.composing) { this.pending = snapshot; return false; }
    const current = blocksOf(this.editor.state.doc), next = snapshot.unit.reading.blocks;
    if (!equal(current.map(b => b.id), next.map(b => b.id))) { this.pending = snapshot; return false; }
    let tr = this.editor.state.tr;
    const { from, to } = this.editor.state.selection;
    let blocked = false;
    this.editor.state.doc.forEach((node, pos) => {
      const incoming = next.find(b => b.id === node.attrs.block.id)!;
      if (equal(current.find(b => b.id === incoming.id), incoming)) return;
      if ((this.editor.view.hasFocus() && from <= pos + node.nodeSize && to >= pos) || this.drafts.has(incoming.id)) { blocked = true; return; }
      const mapped = tr.mapping.map(pos);
      if (node.type.name === 'paragraph' && incoming.kind === 'paragraph') {
        tr.insertText(String(incoming.payload.text), mapped + 1, mapped + node.nodeSize - 1);
        tr.setNodeMarkup(mapped, undefined, { block: incoming });
      } else tr.replaceWith(mapped, mapped + node.nodeSize, this.editor.schema.nodeFromJSON(project(incoming)));
    });
    if (tr.docChanged) this.editor.view.dispatch(tr.setMeta('external', true).setMeta('addToHistory', false));
    this.pending = blocked ? snapshot : undefined;
    if (!blocked) this.course = snapshot;
    return !blocked;
  }
  destroy() { this.editor.destroy(); }
}
