import type { SearchHit } from '../../search-api';
import { codePointOffset, utf16Offset, type AnnotationSelection, type PersonalNote, type FormulaEditProof, type TextEditProof } from '../../annotation-api';
import { formulaModel } from './formula-selection';
import type { MathfieldElement } from 'mathlive';
import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { closeHistory, undo, redo, isHistoryTransaction } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { OpenedCourse, ReadingBlock } from '../../shared';
import { equal } from '../../editor-api';
import type { ContentPatch } from '../../editor-api';
import type { ParagraphSaveChannel } from '../save-channel';
import { atom, baseExtensions, blocksOf, delta, freshClipboard, project } from './document';
import { formulaView } from './formula';
import type { FormulaEditing } from './nested-formula';
import { unitBlocks } from '../../reading-model';
import { integrateValue, textRange } from '../../content-integration';
import type { CandidateCheck } from '../../command-api';

export interface EditorOptions {
  annotate(selection: AnnotationSelection): void;
  renderOpaque(element: HTMLElement, block: ReadingBlock, editing: FormulaEditing): { update(block: ReadingBlock): void; destroy(): void };
  composition(active: boolean): void;
  commands: import('../../shared').StudentCommands;
  status(checks: CandidateCheck[]): void;
}
export interface DisplayedFragment {
  blockId: string; field: 'text'; formalRevision: number; contentVersion?: number;
  source: 'formal' | 'student-draft'; block: ReadingBlock;
  projection: { version: 1; encoding: 'unicode-code-points'; text: string };
  from: number; to: number; quote: string;
}
/** Owns only an active B's ephemeral projection/history. Durable truth lives behind SaveBridge. */
export class ContinuousEditor {
  readonly editor: Editor;
  private previous: ReadingBlock[];
  private drafts = new Map<string, string>();
  private composing = false;
  private composedTextEdits: TextEditProof[] = [];
  private editorId = crypto.randomUUID();
  private protectionSequence = 0;
  private protectionWork = Promise.resolve();
  private protectedIds = new Set<string>();
  private desiredIds = new Set<string>();
  private engaged = false;
  private protectionFailed = false;
  private destroyed = false;
  private outsidePointer = (event: PointerEvent) => {
    if (this.engaged && !this.editor.view.dom.closest('.continuous-editor')?.contains(event.target as globalThis.Node)) {
      this.engaged = false; this.setProtection([], 'editing');
    }
  };
  private shown = new Map<string, { revision: number; version?: number; block: ReadingBlock }>();
  constructor(element: HTMLElement, private course: OpenedCourse, private channel: ParagraphSaveChannel, private options: EditorOptions) {
    channel.useContentPatches();
    const recovery = channel.recovery();
    const recovered = recovery.blocks;
    this.drafts = new Map(recovery.formulaDrafts.map(f => [f.blockId, f.latex]));
    this.previous = recovered;
    for (const block of unitBlocks(course.unit)) this.shown.set(block.id, { revision: course.revision, version: course.blockVersions?.[block.id], block: structuredClone(block) });
    const editing: FormulaEditing = {
      changed: (id, latex, complete, proof, restored) => this.formulaInput(id, latex, complete, proof, restored),
      draft: id => this.drafts.get(id), annotate: (block, field) => options.annotate(this.captureFormula(block, field)),
    };
    const opaque = atom('opaque').extend({ addNodeView: () => ({ node }) => {
      const dom = document.createElement('div'); dom.contentEditable = 'false'; dom.dataset.blockId = node.attrs.block.id;
      dom.className = 'editor-preserved';
      const rendered = options.renderOpaque(dom, node.attrs.block, editing), id = node.attrs.block.id;
      return { dom, stopEvent: () => true, ignoreMutation: () => true, destroy: () => rendered.destroy(),
        update(next) { if (next.type.name !== 'opaque' || next.attrs.block.id !== id) return false; rendered.update(next.attrs.block); return true; } };
    } });
    const formula = atom('formula').extend({ addNodeView: () => ({ node }) => formulaView(node,
      (id, latex, complete, proof, restored) => this.formulaInput(id, latex, complete, proof, restored), id => this.drafts.get(id), (block, field) => {
        options.annotate(this.captureFormula(block, field));
      }) });
    const highlights = Extension.create({ name: 'personalAnnotationHighlights', addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
      state: { init: () => DecorationSet.empty, apply(tr, previous, oldState) {
        const ranges = tr.getMeta('annotationLocations') as Array<{ from: number; to: number }> | undefined;
        return ranges ? DecorationSet.create(tr.doc, ranges.map(r => Decoration.inline(r.from, r.to, { class: 'annotation-highlight' })))
          : tr.docChanged || (tr.selectionSet && !tr.selection.eq(oldState.selection)) ? DecorationSet.empty : previous;
      } }, props: { decorations(state) { return this.getState(state); } },
    })] });
    const searchHighlights = Extension.create({ name: 'courseSearchHighlights', addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
      state: { init: () => DecorationSet.empty, apply(tr, previous, oldState) {
        const location = tr.getMeta('searchLocation') as { blockFrom: number; blockTo: number; from: number; to: number } | undefined;
        if (location) return DecorationSet.create(tr.doc, [
          Decoration.node(location.blockFrom, location.blockTo, { 'data-search-current': 'true' }),
          Decoration.inline(location.from, location.to, { class: 'search-exact-match' }),
        ]);
        return tr.getMeta('clearSearchLocation') || tr.docChanged || tr.selectionSet && !tr.selection.eq(oldState.selection) ? DecorationSet.empty : previous;
      } }, props: { decorations(state) { return this.getState(state); } },
    })] });
    const drawingHighlights = Extension.create({ name: 'drawingTextHighlights', addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
      state: { init: () => DecorationSet.empty, apply(tr, previous) {
        const ranges = tr.getMeta('drawingLocations') as Array<{ from: number; to: number }> | undefined;
        return ranges ? DecorationSet.create(tr.doc, ranges.map(r => Decoration.inline(r.from,r.to,{class:'drawing-text-highlight'}))) : previous.map(tr.mapping,tr.doc);
      } }, props: { decorations(state) { return this.getState(state); } },
    })] });
    this.editor = new Editor({ element, extensions: [...baseExtensions, opaque, formula, highlights, drawingHighlights, searchHighlights],
      content: { type: 'doc', content: recovered.map(project) },
      editorProps: { attributes: { role: 'textbox', 'aria-label': '连续编辑正文', 'aria-multiline': 'true', class: 'continuous-prose nodrag nopan' },
        transformPasted: freshClipboard,
        handleDOMEvents: {
          focus: () => { this.engaged = true; queueMicrotask(() => this.selectionChanged()); return false; },
          compositionstart: () => { this.composing = true; options.composition(true); this.selectionChanged(); return false; },
          compositionend: () => { this.composing = false; options.composition(false);
            queueMicrotask(() => { this.changed(); this.selectionChanged(); }); return false; },
          blur: (_view, event) => {
            // App deactivation has no in-document destination. Keep the exact paragraph/selection.
            if ((event as FocusEvent).relatedTarget && !element.contains((event as FocusEvent).relatedTarget as globalThis.Node)) {
              this.engaged = false; this.setProtection([], 'editing');
            }
            return false;
          },
        },
      },
      onUpdate: ({ transaction, appendedTransactions }) => {
        const correspondences = [transaction, ...appendedTransactions].flatMap(tr => tr.getMeta('editorCorrespondence') ?? []);
        const textEdits: TextEditProof[] = [];
        if (!transaction.getMeta('external')) for (const tr of [transaction, ...appendedTransactions]) for (let i = 0; i < tr.steps.length; i++) {
          const step = tr.steps[i].toJSON(), before = tr.docs[i];
          if (step.stepType !== 'replace' || step.from === undefined || step.to === undefined) continue;
          const start = before.resolve(step.from), end = before.resolve(step.to);
          if (start.parent.type.name !== 'paragraph' || start.parent !== end.parent) continue;
          const after = (tr.docs[i + 1] ?? tr.doc).nodeAt(start.before(1));
          if (after?.type.name !== 'paragraph' || after.attrs.block.id !== start.parent.attrs.block.id) continue;
          const from = codePointOffset(start.parent.textContent, start.parentOffset), to = codePointOffset(start.parent.textContent, end.parentOffset);
          const inserted = (tr.steps[i] as any).slice?.content.textBetween(0, (tr.steps[i] as any).slice.content.size) ?? '';
          if (Array.from(start.parent.textContent).slice(0, from).join('') + inserted + Array.from(start.parent.textContent).slice(to).join('') === after.textContent)
            textEdits.push({ blockId: after.attrs.block.id, before: start.parent.textContent, after: after.textContent, from, to, inserted });
        }
        this.changed(correspondences, !!transaction.getMeta('external'), transaction.getMeta('formulaProof'), textEdits, isHistoryTransaction(transaction) || !!transaction.getMeta('formulaRestore'));
      },
      onSelectionUpdate: () => { if (this.engaged) this.selectionChanged(); },
    });
    Object.assign(this.editor.storage, { courseSelection: { capture: () => this.captureSelection(), captureAnnotation: () => this.captureAnnotation(), settle: () => this.settleProtection() } });
    // Paragraph aliases provide block-level labels without separate pointer focus.
    // Explicit alias focus still transfers to ProseMirror's single editing host.
    this.editor.view.dom.addEventListener('focusin', event => {
      const formula = (event.target as HTMLElement).closest<HTMLElement>('.editor-formula');
      if (formula?.dataset.blockId) { this.engaged = true; this.setProtection([formula.dataset.blockId], (event.target as MathfieldElement).readOnly ? 'selection' : 'editing'); }
      if ((event.target as HTMLElement).matches('p[data-block-id]')) queueMicrotask(() => {
        const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        if(range&&this.editor.view.dom.contains(range.startContainer)&&this.editor.view.dom.contains(range.endContainer)) {
          this.editor.view.dom.focus({ preventScroll: true });
          if(selection){selection.removeAllRanges();selection.addRange(range);}
        }else this.editor.view.focus();
      });
    });
    element.addEventListener('formula-exit', () => this.editor.commands.focus());
    document.addEventListener('pointerdown', this.outsidePointer, true);
  }
  /** Actual shown projection for T07. Never substitutes the latest open() body for held DOM offsets. */
  captureSelection() {
    const fragments: DisplayedFragment[] = [], { from, to } = this.editor.state.selection;
    this.editor.state.doc.forEach((node, pos) => {
      if (node.type.name !== 'paragraph' || from >= pos + node.nodeSize - 1 || to <= pos + 1) return;
      const block = blocksOf(this.editor.state.doc).find(b => b.id === node.attrs.block.id)!;
      const shown = this.shown.get(block.id), text = node.textContent;
      const start = codePointOffset(text, Math.max(0, from - pos - 1));
      const end = codePointOffset(text, Math.min(text.length, to - pos - 1));
      fragments.push({ blockId: block.id, field: 'text', block: structuredClone(block), formalRevision: shown?.revision ?? this.course.revision,
        contentVersion: shown?.version, source: equal(shown?.block, block) ? 'formal' : 'student-draft',
        projection: { version: 1, encoding: 'unicode-code-points', text }, from: start, to: end,
        quote: Array.from(text).slice(start, end).join('') });
    });
    return { formalRevision: fragments[0]?.formalRevision ?? this.course.revision, latestFormalRevision: this.course.revision, fragments };
  }
  captureAnnotation(): AnnotationSelection {
    const field = [...this.editor.view.dom.querySelectorAll<MathfieldElement>('math-field:not([hidden])')].find(field => field.hasFocus());
    if (field) {
      const id = field.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
      const block = unitBlocks({reading:{blocks:this.previous}}).find(b => b.id === id);
      if (block && !field.selectionIsCollapsed) return this.captureFormula(block, field);
    }
    return { unitId: this.course.unit.id, fragments: this.captureSelection().fragments };
  }
  private captureFormula(block: ReadingBlock, field: MathfieldElement): AnnotationSelection {
    const shown = this.shown.get(block.id), latex = field.getValue();
    const actual = structuredClone(block);
    // MathLive may normalize serialization without changing the shown formal expression.
    if (this.drafts.has(block.id)) actual.payload.latex = latex;
    const projection = formulaModel(field, String(actual.payload.latex));
    return { unitId: this.course.unit.id, fragments: field.selection.ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
      .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]).map(([from, to]) => ({
        blockId: block.id, block: actual, field: 'latex', formalRevision: shown?.revision ?? this.course.revision,
        contentVersion: shown?.version, source: equal(shown?.block, actual) ? 'formal' : 'student-draft',
        projection, from, to, quote: field.getValue([from, to]),
      })) };
  }
  /** Editor-owned decorations survive PM's DOM reconciliation; search does not edit content. */
  revealSearch(hit: SearchHit): boolean {
    if (hit.field !== 'text') return false;
    let location: { blockFrom: number; blockTo: number; from: number; to: number } | undefined;
    this.editor.state.doc.forEach((node, pos) => {
      if (node.type.name !== 'paragraph' || node.attrs.block.id !== hit.blockId) return;
      if (node.textContent !== hit.text || Array.from(node.textContent).slice(hit.start, hit.end).join('') !== hit.quote) throw new Error('当前显示版本不同，请重新搜索');
      location = { blockFrom: pos, blockTo: pos + node.nodeSize, from: pos + 1 + utf16Offset(node.textContent, hit.start), to: pos + 1 + utf16Offset(node.textContent, hit.end) };
    });
    if (!location) return false;
    this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, location.from, location.to)).setMeta('searchLocation', location).setMeta('addToHistory', false));
    this.editor.view.focus(); return true;
  }
  clearSearch() { this.editor.view.dispatch(this.editor.state.tr.setMeta('clearSearchLocation', true).setMeta('addToHistory', false)); }
  async revealAnnotation(note: PersonalNote) {
    if (note.current.status !== 'attached') throw new Error('此批注待重新关联，请先选择新的片段。');
    const locations = note.current.fragments;
    const current = unitBlocks({reading:{blocks:blocksOf(this.editor.state.doc)}});
    for (const l of locations) {
      const block = current.find(b => b.id === l.blockId);
      if (!block) throw new Error('当前显示内容尚未对齐，请结束输入或选择后重试。');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(block))))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (digest !== l.version || !equal(unitBlocks({reading:{blocks:blocksOf(this.editor.state.doc)}}).find(b => b.id === l.blockId), block)) throw new Error('当前显示版本不同，请结束输入或选择后重试。');
    }
    if (locations[0].field === 'latex') {
      const l = locations[0], element = [...this.editor.view.dom.querySelectorAll<HTMLElement>('.editor-formula')].find(e => e.dataset.blockId === l.blockId);
      element?.dispatchEvent(new CustomEvent('formula-annotation-reveal', { detail: l })); return;
    }
    const ranges: Array<{ from: number; to: number }> = [];
    for (const location of locations) this.editor.state.doc.forEach((node, pos) => {
      if (node.attrs.block.id === location.blockId) ranges.push({ from: pos + 1 + utf16Offset(node.textContent, location.from), to: pos + 1 + utf16Offset(node.textContent, location.to) });
    });
    if (!ranges.length) throw new Error('当前选段暂不可见');
    const first = ranges[0];
    this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, first.from, first.to)).setMeta('annotationLocations', ranges));
    this.editor.view.focus();
  }
  private paintSequence = 0;
  async paintDrawings(notes: PersonalNote[]) {
    const sequence = ++this.paintSequence, doc = this.editor.state.doc, blocks = blocksOf(doc);
    const ranges: Array<{from:number;to:number}> = [];
    for (const note of notes) for (const location of note.current.fragments) {
      if (location.status !== 'attached' || location.field !== 'text') continue;
      const block = blocks.find(b=>b.id===location.blockId);
      if (!block) continue;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(block))))].map(n=>n.toString(16).padStart(2,'0')).join('');
      if (digest !== location.version) continue;
      doc.forEach((node,pos)=>{if(node.attrs.block.id===location.blockId && node.type.name==='paragraph') ranges.push({from:pos+1+utf16Offset(node.textContent,location.from),to:pos+1+utf16Offset(node.textContent,location.to)});});
    }
    if (!this.destroyed && sequence===this.paintSequence && this.editor.state.doc===doc) this.editor.view.dispatch(this.editor.state.tr.setMeta('drawingLocations',ranges).setMeta('addToHistory',false));
  }
  private selectionChanged() {
    const ids: string[] = [], { from, to, empty } = this.editor.state.selection;
    this.editor.state.doc.forEach((node, pos) => {
      if (empty ? from >= pos && from < pos + node.nodeSize : from < pos + node.nodeSize && to > pos) ids.push(node.attrs.block.id);
    });
    this.setProtection(ids, !empty && !this.composing ? 'selection' : 'editing');
  }
  private protectionMode?: 'editing' | 'selection';
  private setProtection(ids: string[], mode: 'editing' | 'selection') {
    if (equal([...this.desiredIds], ids) && this.protectionMode === mode && !this.protectionFailed) return;
    const removed = [...this.protectedIds].some(id => !ids.includes(id));
    this.desiredIds = new Set(ids); this.protectionMode = mode;
    for (const id of ids) this.protectedIds.add(id);
    const sequence = ++this.protectionSequence;
    this.protectionWork = this.protectionWork.catch(() => {}).then(async () => {
      if (this.destroyed) return;
      if (removed) {
        await this.channel.flush();
        const p = this.channel.progress();
        if (p.inputSeq > p.durableInputSeq || this.composing) { this.protectionFailed = true; return; }
      }
      await this.options.commands.protect({ sessionId: this.course.sessionId, unitId: this.course.unit.id, editorId: this.editorId, sequence, blockIds: ids, mode,
        inputSeq: this.channel.progress().inputSeq });
      if (sequence === this.protectionSequence) { this.protectedIds = new Set(ids); this.protectionFailed = false; }
      if (removed) {
        this.options.status(await this.options.commands.recheck({ sessionId: this.course.sessionId }));
        this.reconcile(await this.channel.snapshot());
      }
    }).catch(error => { this.protectionFailed = true; this.options.status([{ candidateId: 'input-barrier', status: 'waiting', reason: (error as Error).message, objectIds: [...this.protectedIds] }]); });
  }
  settleProtection() { return this.protectionWork; }
  async inputConflicts() {
    const snapshot = await this.channel.snapshot();
    const draft = snapshot.drafts.find(d => d.input.sessionId === snapshot.sessionId) ?? snapshot.drafts.at(-1);
    if (!draft?.input.patch || draft.input.patch.structure) return [];
    return draft.input.patch.updates.flatMap(u => {
      const current = unitBlocks(snapshot.unit).find(b => b.id === u.blockId);
      return current && !integrateValue(u.before, current.payload, u.after).compatible
        ? [{ blockId: u.blockId, current: current.payload, student: u.after }] : [];
    });
  }
  async resolveInput(choice: 'student' | 'external') {
    await this.channel.flush();
    const snapshot = await this.channel.snapshot();
    const draft = snapshot.drafts.find(d => d.input.sessionId === snapshot.sessionId) ?? snapshot.drafts.at(-1);
    if (!draft) return;
    const conflicts = await this.inputConflicts();
    await this.options.commands.resolveInput({ sessionId: snapshot.sessionId, unitId: snapshot.unit.id, operationId: `resolve-input-${crypto.randomUUID()}`,
      draftSessionId: draft.input.sessionId, inputSeq: draft.input.inputSeq, basisRevision: snapshot.revision,
      blockIds: conflicts.map(c => c.blockId), choice });
    const resolved = await this.channel.snapshot(); this.channel.adoptResolution(resolved);
    this.protectedIds.clear(); this.desiredIds.clear(); this.protectionMode = undefined;
    this.reconcile(resolved);
    this.options.status(await this.options.commands.recheck({ sessionId: snapshot.sessionId }));
  }
  async resolveCandidate(candidateId: string, choice: 'current' | 'incoming') {
    await this.channel.flush();
    const snapshot = await this.channel.snapshot();
    await this.options.commands.resolveCandidate({ sessionId: snapshot.sessionId, candidateId, basisRevision: snapshot.revision, choice });
    this.reconcile(await this.channel.snapshot());
    this.options.status(await this.options.commands.recheck({ sessionId: snapshot.sessionId }));
  }
  private changed(correspondence: ContentPatch['correspondence'] = [], external = false, formulaProof?: FormulaEditProof, textEdits: TextEditProof[] = [], restored = false) {
    const current = blocksOf(this.editor.state.doc);
    if (this.composing) {
      if (!external) this.composedTextEdits.push(...textEdits);
      // An independent mapped transaction is already formal. It must not become part of
      // the student's later composition delta, while the live composing range keeps its old basis.
      if (external) this.previous = this.previous.map(block => this.protectedIds.has(block.id) ? block : current.find(b => b.id === block.id) ?? block);
      return;
    }
    const patch = delta(this.previous, current, this.course.unit.id, correspondence);
    if (restored) patch.restorations = current.filter(b => !equal(this.previous.find(old => old.id === b.id), b));
    if (formulaProof) patch.formulaEdits = [formulaProof];
    patch.textEdits = [...this.composedTextEdits, ...textEdits]; this.composedTextEdits = [];
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
    const live = new Set(unitBlocks({reading:{blocks}}).map(b => b.id));
    return [...this.drafts].filter(([id]) => live.has(id)).map(([blockId, latex]) => ({ blockId, latex }));
  }
  private formulaInput(id: string, latex: string, complete: boolean, proof?: FormulaEditProof, restored = false) {
    if (!complete) { this.drafts.set(id, latex); this.channel.edit({ changes: [], formulaDrafts: this.formulaDrafts() }); return; }
    const hadDraft = this.drafts.delete(id);
    let found = false;
    this.editor.state.doc.forEach((node, pos) => {
      const current = unitBlocks({reading:{blocks:[node.attrs.block]}}).find(b => b.id === id);
      if (current && current.payload.latex !== latex) {
        found = true;
        const block = structuredClone(node.attrs.block);
        unitBlocks({reading:{blocks:[block]}}).find(b => b.id === id)!.payload.latex = latex;
        this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(pos, undefined, { block }).setMeta('addToHistory', false).setMeta('formulaProof', proof).setMeta('formulaRestore', restored));
      }
    });
    if (!found && hadDraft) this.channel.edit({ changes: [], patch: { updates: [], correspondence: [] }, formulaDrafts: this.formulaDrafts() });
  }
  setEditable(editable: boolean) {
    this.editor.setEditable(editable);
    this.editor.view.dom.querySelectorAll('math-field').forEach(field => { (field as HTMLElement & { readOnly: boolean }).readOnly = !editable || (field as HTMLElement).dataset.annotationSelection === 'true'; });
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
  /** External updates map only changed ranges through the existing history and native selection. */
  private acknowledgeShown(block: ReadingBlock, snapshot: OpenedCourse, protectedAncestor = false) {
    const held = protectedAncestor || this.protectedIds.has(block.id);
    if (!held || !equal(this.shown.get(block.id)?.block, block))
      this.shown.set(block.id, { revision: snapshot.revision, version: snapshot.blockVersions?.[block.id], block: structuredClone(block) });
    for (const child of block.children ?? []) this.acknowledgeShown(child, snapshot, held);
  }
  reconcile(snapshot: OpenedCourse): boolean {
    if (snapshot.revision < this.course.revision) return true;
    this.course = snapshot;
    if (this.protectionFailed && !this.composing) this.setProtection([...this.desiredIds], this.protectionMode ?? 'editing');
    const current = blocksOf(this.editor.state.doc), next = snapshot.unit.reading.blocks;
    const structural = !equal(current.map(b => b.id), next.map(b => b.id));
    const deferStructure = structural && !!(this.composing || this.protectedIds.size || this.channel.pendingTargets().size);
    let tr = this.editor.state.tr;
    let blocked = deferStructure;
    if (structural && !deferStructure) {
      // Identity-preserving moves/deletions, rather than replacing the document or its editor state.
      for (let index = 0; index < next.length; index++) {
        const incoming = next[index];
        let position = 0, found = -1, oldNode: PMNode | undefined;
        tr.doc.forEach((node, pos, i) => { if (i < index) position += node.nodeSize; if (node.attrs.block.id === incoming.id) { found = pos; oldNode = node; } });
        if (found !== position || !oldNode) {
          if (oldNode) tr.delete(found, found + oldNode.nodeSize);
          tr.insert(position, oldNode ?? this.editor.schema.nodeFromJSON(project(incoming)));
        }
      }
      const keep = new Set(next.map(b => b.id));
      const removed: Array<{ pos: number; size: number }> = [];
      tr.doc.forEach((node, pos) => { if (!keep.has(node.attrs.block.id)) removed.push({ pos, size: node.nodeSize }); });
      for (const n of removed.reverse()) tr.delete(n.pos, n.pos + n.size);
    }
    const positions: Array<{ node: PMNode; pos: number }> = [];
    tr.doc.forEach((node, pos) => positions.push({ node, pos }));
    for (const { node, pos } of positions.reverse()) {
      const incoming = next.find(b => b.id === node.attrs.block.id)!;
      if (!incoming) { blocked = true; continue; }
      const displayed = current.find(b => b.id === incoming.id);
      if (equal(displayed, incoming)) {
        // A held selection retains its creation context even when an unrelated formal
        // revision arrives. A new own acknowledgement can still confirm its draft projection.
        this.acknowledgeShown(incoming, snapshot);
        continue;
      }
      const pending = this.channel.pendingTargets();
      if (unitBlocks({reading:{blocks:[incoming]}}).some(b => this.protectedIds.has(b.id) || this.drafts.has(b.id) || pending.has(b.id))) { blocked = true; continue; }
      if (node.type.name === 'paragraph' && incoming.kind === 'paragraph') {
        const range = textRange(node.textContent, String(incoming.payload.text)), points = Array.from(node.textContent);
        const start = points.slice(0, range.start).join('').length, end = points.slice(0, range.end).join('').length;
        if (start !== end || range.text) tr.insertText(range.text, pos + 1 + start, pos + 1 + end);
        tr.setNodeMarkup(pos, undefined, { block: incoming });
      } else tr.replaceWith(pos, pos + node.nodeSize, this.editor.schema.nodeFromJSON(project(incoming)));
      this.acknowledgeShown(incoming, snapshot);
    }
    if (tr.docChanged) this.editor.view.dispatch(tr.setMeta('external', true).setMeta('addToHistory', false));
    return !blocked;
  }
  async finish() { if (this.composing) return false; this.engaged = false; this.setProtection([], 'editing'); await this.settleProtection(); return this.channel.progress().inputSeq <= this.channel.progress().durableInputSeq; }
  destroy() { this.destroyed = true; document.removeEventListener('pointerdown', this.outsidePointer, true); this.editor.destroy(); }
}
