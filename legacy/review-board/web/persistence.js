/* Course files are authoritative. Browser drafts cover unacknowledged saves only. */
(() => {
  'use strict';
  const copy = value => structuredClone(value);
  const signature = value => JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  class CoursePersistence extends EventTarget {
    constructor(snapshot) {
      super();
      this.courseId = snapshot.courseId;
      this.generation = snapshot.generation;
      this.sequence = snapshot.sequence;
      this.documents = copy(snapshot.documents);
      this.pending = new Map();
      this.inflight = null;
      this.busy = false;
      this.problem = null;
      this.cachePrefix = `review-board-drafts:${this.courseId}:`;
      this.clientId = crypto.randomUUID();
      try {
        const navigation = performance.getEntriesByType('navigation')[0]?.type;
        const oldClient = sessionStorage.getItem(`review-board-client:${this.courseId}`);
        if (oldClient && ['reload', 'back_forward'].includes(navigation)) this.clientId = oldClient;
        sessionStorage.setItem(`review-board-client:${this.courseId}`, this.clientId);
      } catch { /* Separate in-memory identity still prevents cross-window draft overwrites. */ }
      this.cacheKey = this.cachePrefix + this.clientId;
      this.recoverable = [];
      this.recoveryDismissed = false;
      this.adoptedDraft = null;
      this.timer = null;
      this.polling = false;
      this.cacheAvailable = true;
      try {
        const draft = JSON.parse(localStorage.getItem(this.cacheKey) || 'null');
        if (draft?.courseId === this.courseId) {
          this.inflight = draft.inflight || null;
          this.pending = new Map(draft.pending || []);
        }
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(this.cachePrefix) || key === this.cacheKey) continue;
          try {
            const raw = localStorage.getItem(key), old = JSON.parse(raw);
            if (old?.courseId === this.courseId && (old.inflight || old.pending?.length))
              this.recoverable.push({ key, raw, time: old.time || 0 });
          } catch { /* A damaged browser draft does not invalidate the saved course. */ }
        }
        this.recoverable.sort((a,b) => b.time - a.time);
      } catch { this.cacheAvailable = false; }
      this.pollTimer = setInterval(() => this.poll(), 2000);
      window.addEventListener('online', () => this.retry());
    }

    key(namespace, key) { return `${namespace}:${key}`; }
    read(namespace, key) {
      return this.documents[namespace]?.[key] || { value: null, revision: 0 };
    }
    value(namespace, key) {
      const id = this.key(namespace, key);
      const pending = this.pending.get(id);
      if (pending) return pending.value;
      const inflight = this.inflight?.changes.find(c => this.key(c.namespace, c.key) === id);
      return inflight ? inflight.value : this.read(namespace, key).value;
    }
    entries(namespace) {
      const keys = new Set(Object.keys(this.documents[namespace] || {}));
      for (const change of this.pending.values()) if (change.namespace === namespace) keys.add(change.key);
      for (const change of this.inflight?.changes || []) if (change.namespace === namespace) keys.add(change.key);
      return [...keys].map(key => [key, this.value(namespace, key)]);
    }
    hasPending() { return !!this.inflight || this.pending.size > 0; }
    notify() {
      const status = this.problem?.code === 'revision_conflict' ? 'conflict'
        : this.problem ? 'failed' : this.hasPending() ? 'saving'
          : this.recoverable.length && !this.recoveryDismissed ? 'draft' : 'saved';
      this.dispatchEvent(new CustomEvent('status', { detail: { status, problem: this.problem,
        cacheAvailable: this.cacheAvailable } }));
    }
    cache() {
      try {
        if (!this.hasPending()) localStorage.removeItem(this.cacheKey);
        else localStorage.setItem(this.cacheKey, JSON.stringify({ courseId: this.courseId, time: Date.now(),
          inflight: this.inflight, pending: [...this.pending] }));
        if (!this.hasPending() && this.adoptedDraft) {
          if (localStorage.getItem(this.adoptedDraft.key) === this.adoptedDraft.raw)
            localStorage.removeItem(this.adoptedDraft.key);
          this.adoptedDraft = null;
        }
      } catch { this.cacheAvailable = false; }
    }
    put(namespace, key, value) {
      const id = this.key(namespace, key);
      if (signature(this.value(namespace, key)) === signature(value)) return;
      this.pending.set(id, { namespace, key, value: copy(value),
        baseRevision: this.read(namespace, key).revision });
      this.cache();
      this.notify();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 320);
    }
    makeCommand() {
      if (this.inflight || !this.pending.size) return;
      const changes = [...this.pending.values()];
      this.inflight = { operationId: crypto.randomUUID(), actor: 'student',
        kind: 'personal.update', generation: this.generation,
        changes: changes.map(({ namespace, key, value }) => ({ namespace, key, value })),
        expectedRevisions: Object.fromEntries(changes.map(c =>
          [this.key(c.namespace, c.key), c.baseRevision])) };
      this.pending.clear();
      this.cache();
    }
    async flush({ keepalive = false } = {}) {
      clearTimeout(this.timer);
      if (this.busy || this.problem) return false;
      this.makeCommand();
      if (!this.inflight) { this.notify(); return true; }
      const command = this.inflight;
      this.busy = true;
      this.notify();
      try {
        const response = await fetch('/api/v1/commands', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), keepalive });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error?.message), result.error);
        if (result.saved !== true) throw new Error('保存尚未确认');
        for (const change of result.changes) {
          const current = this.read(change.namespace, change.key);
          this.documents[change.namespace] ||= {};
          if (current.revision <= change.revision)
            this.documents[change.namespace][change.key] = { value: change.value, revision: change.revision };
          const pending = this.pending.get(this.key(change.namespace, change.key));
          // Later input in this tab is based on the operation that just committed.
          if (pending && current.revision <= change.revision) pending.baseRevision = change.revision;
        }
        this.inflight = null;
        this.problem = null;
        this.cache();
        this.dispatchEvent(new CustomEvent('committed', { detail: result }));
        return true;
      } catch (error) {
        this.problem = { code: error.code || 'connection_failed',
          message: error.message || '暂时无法保存', details: error.details || {} };
        this.cache();
        return false;
      } finally {
        this.busy = false;
        this.notify();
        if (!this.problem && this.hasPending()) queueMicrotask(() => this.flush());
      }
    }
    async retry() {
      if (this.problem?.code === 'revision_conflict') { this.notify(); return false; }
      this.problem = null;
      return this.flush(); // Keep the same operation ID after a lost acknowledgement.
    }
    async resolveConflict(keepMine) {
      if (this.busy) return;
      try {
        const response = await fetch('/api/v1/state', { cache: 'no-store' });
        if (!response.ok) throw new Error('暂时无法读取已保存内容');
        const snapshot = await response.json();
        const changes = new Map((this.inflight?.changes || []).map(c => [this.key(c.namespace, c.key), c]));
        for (const [id, change] of this.pending) changes.set(id, change);
        this.documents = snapshot.documents;
        this.generation = snapshot.generation;
        this.sequence = snapshot.sequence;
        this.inflight = null;
        this.pending.clear();
        this.problem = null;
        if (keepMine) for (const [id, change] of changes) this.pending.set(id, {
          ...change, baseRevision: this.read(change.namespace, change.key).revision });
        this.cache();
        this.dispatchEvent(new CustomEvent('reload', { detail: { keepMine } }));
        this.notify();
        if (keepMine) await this.flush();
      } catch (error) {
        this.problem = { code: 'connection_failed', message: error.message };
        this.notify();
      }
    }
    recoverDraft() {
      if (this.hasPending() || !this.recoverable.length) return false;
      const draft = this.recoverable.shift(), data = JSON.parse(draft.raw);
      this.adoptedDraft = draft;
      this.inflight = data.inflight || null;
      this.pending = new Map(data.pending || []);
      this.problem = null;
      this.cache();
      this.dispatchEvent(new CustomEvent('reload', { detail: { keepMine: true, recoverDraft: true } }));
      this.notify();
      this.flush();
      return true;
    }
    async poll() {
      if (this.polling || this.busy || this.problem || document.hidden) return;
      this.polling = true;
      try {
        const response = await fetch(`/api/v1/events?after=${this.sequence}`, { cache: 'no-store' });
        if (!response.ok) return;
        const page = await response.json();
        const changed = [];
        for (const event of page.events) {
          if(event.generation>this.generation){
            if(this.hasPending())this.problem={code:'revision_conflict',message:'课程已经恢复到历史版本，请先核对未保存草稿。'};
            else this.generation=event.generation;
          }
          for (const change of event.changes) {
            const id = this.key(change.namespace, change.key);
            const ours = this.inflight?.operationId === event.operationId;
            const isDirty = this.pending.has(id) || this.inflight?.changes.some(c => this.key(c.namespace, c.key) === id);
            if (isDirty && !ours) continue; // A real save will report a CAS conflict; never erase local input.
            if (this.read(change.namespace, change.key).revision >= change.revision) continue;
            this.documents[change.namespace] ||= {};
            this.documents[change.namespace][change.key] = { value: change.value, revision: change.revision };
            changed.push(change);
          }
        }
        this.sequence = page.sequence;
        if (changed.length) this.dispatchEvent(new CustomEvent('remote', { detail: changed }));
        if(this.problem)this.notify();
      } catch { /* Readable content stays available while disconnected. */ }
      finally { this.polling = false; }
    }
  }
  window.CoursePersistence = CoursePersistence;
})();
