import type { SaveBridge, OpenedCourse, DraftInput, EditCommand, SaveReceipt, TextChange, ParagraphSplit } from '../shared';
import { composePatch, equal, patchTargets, type ContentPatch, type FormulaDraft } from '../editor-api';
export type SaveState = { status: 'saved' | 'draft' | 'pending' | 'saving' | 'error'; error?: string;
  inputSeq?: number; confirmedInputSeq?: number; draftInputSeq?: number };
export interface EditorDelta { changes: TextChange[]; splits?: ParagraphSplit[]; complete?: boolean;
  patch?: ContentPatch; formulaDrafts?: FormulaDraft[] }
export interface SaveChannelOptions {
  idleMs?: number; maxWaitMs?: number; pollMs?: number;
  /** Reconcile an external snapshot through editor transactions, preserving active input/selection. */
  onSnapshot?: (snapshot: OpenedCourse) => void;
}

/** One in-flight operation; the pending union retains every unconfirmed block and structural action. */
export class ParagraphSaveChannel {
  private sequence: number;
  private revision: number;
  private confirmed: number;
  private draftSaved = 0;
  private complete = true;
  private changes = new Map<string, TextChange & { seq: number }>();
  private splits: (ParagraphSplit & { seq: number })[] = [];
  private patches: { seq: number; patch: ContentPatch }[] = [];
  private formulaDrafts: FormulaDraft[] = [];
  private structured = false;
  private replacesDraft?: DraftInput['replacesDraft'];
  private command?: EditCommand;
  private running?: Promise<boolean>;
  private syncing?: Promise<void>;
  private idle?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private polling?: ReturnType<typeof setTimeout>;
  private cursor: number;
  private disposed = false;
  private lastState = '';
  constructor(private bridge: SaveBridge, private course: OpenedCourse,
    private notify: (state: SaveState) => void, private options: SaveChannelOptions = {}) {
    this.sequence = this.confirmed = course.confirmedInputSeq;
    this.revision = course.revision;
    this.cursor = course.eventCursor;
    const recovery = course.drafts.find(d => d.input.sessionId === course.sessionId) ?? course.drafts.at(-1);
    if (recovery) {
      const input = recovery.input;
      const sameSession = input.sessionId === course.sessionId;
      this.sequence = sameSession ? input.inputSeq : 1;
      this.revision = input.baseRevision;
      this.complete = input.complete;
      for (const change of input.changes) this.changes.set(change.blockId, { ...change, seq: this.sequence });
      this.splits = (input.splits ?? []).map(split => ({ ...split, seq: this.sequence }));
      if (input.patch) this.patches = [{ seq: this.sequence, patch: input.patch }];
      this.formulaDrafts = input.formulaDrafts ?? [];
      if (!sameSession) this.replacesDraft = { sessionId: input.sessionId, inputSeq: input.inputSeq };
      else this.draftSaved = input.inputSeq;
      this.publish('draft');
      if (input.complete) {
        this.command = { ...input, sessionId: course.sessionId, inputSeq: this.sequence,
          operationId: crypto.randomUUID(), ...(this.replacesDraft ? { replacesDraft: this.replacesDraft } : {}) };
        this.deadline = setTimeout(() => { void this.flush(); }, this.options.maxWaitMs ?? 1000);
      }
    }
    this.poll();
  }
  /** T01/T04 compatibility: edit the selected ordinary paragraph. */
  input(text: string) { this.edit({ changes: [{ blockId: this.course.editableBlockId, text }] }); }
  edit(delta: EditorDelta) {
    if (this.disposed) throw new Error('保存通道已关闭');
    const seq = ++this.sequence;
    for (const change of delta.changes) this.changes.set(change.blockId, { ...change, seq });
    this.splits.push(...(delta.splits ?? []).map(split => ({ ...split, seq })));
    if (delta.patch) {
      const pending = this.patches.at(-1);
      // At most an immutable in-flight delta plus one composed pending union, even with a stalled transport.
      if (pending && (!this.command || pending.seq > this.command.inputSeq)) {
        pending.patch = composePatch(pending.patch, delta.patch); pending.seq = seq;
      } else this.patches.push({ seq, patch: delta.patch });
    }
    if (delta.formulaDrafts) this.formulaDrafts = delta.formulaDrafts;
    this.complete = delta.complete ?? this.formulaDrafts.length === 0;
    this.publish('pending');
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.flush(); }, this.options.idleMs ?? 250);
    // Deliberately do not restart this deadline on each keystroke.
    this.deadline ??= setTimeout(() => { void this.flush(); }, this.options.maxWaitMs ?? 1000);
  }
  /** Recoverable local input. Reading this never replaces a live editor's DOM or Undo. */
  text(blockId: string): string | undefined { return this.changes.get(blockId)?.text; }
  /** Activate the continuous adapter before its first input; retain the original formal basis of old drafts. */
  useContentPatches() {
    if (this.structured) return;
    this.structured = true;
    const before = this.course.unit.reading.blocks, after = structuredClone(before);
    const converted = new Set<string>();
    for (const change of this.changes.values()) {
      const block = after.find(b => b.id === change.blockId && b.kind === 'paragraph' && !b.children?.length);
      if (block) { block.payload.text = change.text; converted.add(block.id); }
    }
    const convertedSplits = new Set<ParagraphSplit>();
    const correspondence: ContentPatch['correspondence'] = [];
    for (const split of this.splits) {
      const index = after.findIndex(b => b.id === split.blockId && b.kind === 'paragraph' && !b.children?.length);
      if (index < 0 || after.some(b => b.id === split.newBlockId)) continue;
      const block = after[index], text = Array.from(String(block.payload.text));
      if (split.offset < 0 || split.offset > text.length) continue;
      const next = { ...structuredClone(block), id: split.newBlockId, payload: { text: text.slice(split.offset).join('') } };
      block.payload.text = text.slice(0, split.offset).join(''); after.splice(index + 1, 0, next);
      convertedSplits.add(split); converted.add(block.id);
      correspondence.push({ kind: 'split', sourceId: block.id, targetId: next.id, offset: split.offset });
    }
    if (!converted.size && !convertedSplits.size) return;
    const old = new Map(before.map(b => [b.id, b]));
    let patch: ContentPatch = { updates: after.filter(b => old.has(b.id) && !equal(old.get(b.id)!.payload, b.payload))
      .map(b => ({ blockId: b.id, before: old.get(b.id)!.payload, after: b.payload })), correspondence,
      ...(convertedSplits.size ? { structure: { parentId: this.course.unit.id, before: before.map(b => b.id), after: after.map(b => b.id), inserted: after.filter(b => !old.has(b.id)) } } : {}) };
    for (const pending of this.patches) patch = composePatch(patch, pending.patch);
    this.patches = [{ seq: this.sequence, patch }];
    for (const id of converted) this.changes.delete(id);
    this.splits = this.splits.filter(split => !convertedSplits.has(split));
  }
  /** Initial recovery projection only. Live editors reconcile snapshots through range transactions. */
  recovery() { return { patch: this.patches.reduce<ContentPatch | undefined>((p, n) => composePatch(p, n.patch), undefined),
    formulaDrafts: structuredClone(this.formulaDrafts) }; }
  flush(): Promise<boolean> {
    clearTimeout(this.idle); clearTimeout(this.deadline); this.deadline = undefined;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }
  private publish(status: SaveState['status'], error?: string) {
    if (this.disposed) return;
    const state: SaveState = { status, inputSeq: this.sequence, confirmedInputSeq: this.confirmed,
      draftInputSeq: this.draftSaved, ...(error ? { error } : {}) };
    const key = JSON.stringify(state);
    if (key !== this.lastState) { this.lastState = key; this.notify(state); }
  }
  private accept(receipt: SaveReceipt) {
    const command = this.command;
    if (!command || receipt.operationId !== command.operationId || receipt.inputSeq !== command.inputSeq ||
      receipt.sessionId !== command.sessionId || receipt.blockId !== (command.changes[0]?.blockId ?? command.splits?.[0]?.blockId ?? patchTargets(command.patch)[0] ?? this.course.unit.id) ||
      receipt.revision !== command.baseRevision + 1) throw new Error('保存确认与当前输入不匹配，请重试');
    this.revision = receipt.revision;
    this.confirmed = Math.max(this.confirmed, receipt.inputSeq);
    for (const [id, change] of this.changes) if (change.seq <= receipt.inputSeq) this.changes.delete(id);
    this.splits = this.splits.filter(split => split.seq > receipt.inputSeq);
    this.patches = this.patches.filter(patch => patch.seq > receipt.inputSeq);
    this.publish(this.sequence <= this.confirmed ? 'saved' : 'saving');
  }
  private async drain(): Promise<boolean> {
    while (this.command || this.sequence > Math.max(this.confirmed, this.draftSaved)) {
      this.publish('saving');
      if (!this.command) {
        this.command = { sessionId: this.course.sessionId, operationId: crypto.randomUUID(), inputSeq: this.sequence,
          baseRevision: this.revision, complete: this.complete,
          changes: [...this.changes.values()].map(({ seq: _, ...change }) => change),
          splits: this.splits.map(({ seq: _, ...split }) => split),
          ...(this.patches.length ? { patch: this.patches.reduce<ContentPatch | undefined>((p, n) => composePatch(p, n.patch), undefined) } : {}),
          ...(this.formulaDrafts.length ? { formulaDrafts: structuredClone(this.formulaDrafts) } : {}),
          ...(this.replacesDraft ? { replacesDraft: this.replacesDraft } : {}) };
      }
      try {
        // An unknown result is reconciled under its original identity before any retry/new operation.
        const existing = await this.bridge.queryOperation(this.course.sessionId, this.command.operationId);
        if (existing) this.accept(existing);
        else {
          const { operationId: _, ...input } = this.command;
          const draftReceipt = await this.bridge.saveDraft(input);
          if (draftReceipt.sessionId !== input.sessionId || draftReceipt.inputSeq !== input.inputSeq)
            throw new Error('草稿确认与当前输入不匹配');
          this.draftSaved = Math.max(this.draftSaved, draftReceipt.inputSeq);
          this.replacesDraft = undefined;
          if (!input.complete) {
            this.command = undefined;
            continue;
          }
          const receipt = await this.bridge.commitEdit(this.command);
          this.accept(receipt);
        }
        this.command = undefined;
      } catch (error) {
        const detail = (error as Error).message;
        this.publish('error', /[\u4e00-\u9fff]/.test(detail) ? detail
          : '本地课程未能写入。请检查磁盘空间和目录权限后重试。');
        return false;
      }
    }
    this.publish(this.sequence <= this.confirmed ? 'saved' : 'draft');
    return true;
  }
  /** Replay is explicit and awaitable for reconnect and UI tests; repeated pages cannot reapply input. */
  synchronize(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.replay().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async replay() {
    let more = true;
    while (more && !this.disposed) {
      const page = await this.bridge.readEvents(this.course.sessionId, this.cursor, 64);
      if (page.kind === 'reset') {
        // A receipt may have fallen out of the event window; query it before consuming the snapshot.
        if (this.command) {
          const receipt = await this.bridge.queryOperation(this.course.sessionId, this.command.operationId);
          if (receipt) this.accept(receipt);
        }
        this.deliverSnapshot(page.snapshot);
        this.cursor = page.cursor;
        return;
      }
      let external = false;
      for (const event of page.events) {
        if (event.cursor <= this.cursor) continue;
        if (event.type === 'group.committed') external = true;
        if (event.type === 'content.committed') {
          if (event.receipt.operationId === this.command?.operationId) this.accept(event.receipt);
          else if (event.receipt.sessionId !== this.course.sessionId || event.receipt.inputSeq > this.confirmed) external = true;
        }
      }
      if (external) {
        const snapshot = await this.bridge.read(this.course.sessionId);
        this.deliverSnapshot(snapshot);
      }
      this.cursor = page.cursor;
      more = page.hasMore;
    }
  }
  private deliverSnapshot(snapshot: OpenedCourse) {
    this.options.onSnapshot?.(snapshot);
    // An idle reopened/slow window resumes the host's actual sequence rather than reusing an old one.
    // Dirty input keeps its original basis: an external snapshot cannot silently rebase it.
    if (!this.changes.size && !this.splits.length && !this.patches.length && this.sequence <= this.confirmed) {
      this.revision = snapshot.revision;
      this.sequence = this.confirmed = Math.max(this.confirmed, snapshot.confirmedInputSeq);
      this.publish(snapshot.drafts.length ? 'draft' : 'saved');
    }
  }
  private poll() {
    if (this.disposed || this.options.pollMs === 0) return;
    this.polling = setTimeout(() => {
      void this.synchronize().catch(() => { /* Retain cursor; reconnect polls replay from the last confirmed page. */ })
        .finally(() => this.poll());
    }, this.options.pollMs ?? 300);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.idle); clearTimeout(this.deadline); clearTimeout(this.polling);
  }
}
export { ParagraphSaveChannel as SaveChannel };
