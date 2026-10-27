import { relationClient } from '../relation-api';
import { Worker } from 'node:worker_threads';
import { commandClient } from '../command-api';
import type { CourseGraph, CourseUnit, ReadingState, OpenedCourse, SaveParagraph, SaveReceipt, DraftInput, DraftReceipt, EditCommand, EditReceipt, EditHistory, EventPage } from '../shared';

/** One instance belongs to the application host, shared by all its windows/courses. */
export class CourseService {
  readonly relations = relationClient((action, payload) => this.request(action, payload));
  readonly commands = commandClient((action, payload) => this.request(action, payload));
  private readonly worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private stopped = false;
  private closing?: Promise<void>;
  private failure?: Error;
  constructor(workerPath: string) {
    this.worker = new Worker(workerPath);
    this.worker.on('message', message => {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error));
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', code => { this.stopped = true; fail(new Error(`课程核心已停止 (${code})`)); });
  }
  private request<T>(action: string, payload?: unknown): Promise<T> {
    if (this.stopped || this.failure || this.closing) return Promise.reject(this.failure ?? new Error('课程核心正在退出'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, action, payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  open(directory: string): Promise<OpenedCourse> { return this.request('open', { directory }); }
  read(sessionId: string): Promise<OpenedCourse> { return this.request('read', { sessionId }); }
  graph(sessionId: string): Promise<CourseGraph> { return this.request('graph', { sessionId }); }
  readUnit(sessionId: string, unitId: string): Promise<CourseUnit> { return this.request('readUnit', { sessionId, unitId }); }
  readingState(sessionId: string): Promise<ReadingState | null> { return this.request('readingState', { sessionId }); }
  setReadingState(sessionId: string, state: ReadingState): Promise<void> { return this.request('setReadingState', { sessionId, state }); }
  save(command: SaveParagraph): Promise<SaveReceipt> { return this.request('save', command); }
  saveDraft(input: DraftInput): Promise<DraftReceipt> { return this.request('saveDraft', input); }
  commitEdit(command: EditCommand): Promise<EditReceipt> { return this.request('commitEdit', command); }
  queryOperation(sessionId: string, operationId: string): Promise<SaveReceipt | null> { return this.request('queryOperation', { sessionId, operationId }); }
  history(sessionId: string): Promise<EditHistory[]> { return this.request('history', { sessionId }); }
  readEvents(sessionId: string, after: number, limit = 64): Promise<EventPage> { return this.request('readEvents', { sessionId, after, limit }); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.stopped) return Promise.resolve();
    const drained = this.request<void>('close');
    this.closing = drained.finally(async () => { await this.worker.terminate(); });
    return this.closing;
  }
}
