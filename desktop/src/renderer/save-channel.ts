import type { DesktopBridge, OpenedCourse, SaveParagraph } from '../shared';
export type SaveState = { status: 'saved' | 'pending' | 'saving' | 'error'; error?: string };

/** Single in-flight command plus the latest pending input; failures retain the exact retry. */
export class ParagraphSaveChannel {
  private sequence: number;
  private revision: number;
  private confirmed: number;
  private latest?: { text: string; seq: number };
  private command?: SaveParagraph;
  private running?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private bridge: Pick<DesktopBridge, 'save'>, private course: OpenedCourse,
    private notify: (state: SaveState) => void) {
    this.sequence = this.confirmed = course.confirmedInputSeq;
    this.revision = course.revision;
  }
  input(text: string) {
    this.latest = { text, seq: ++this.sequence };
    this.notify({ status: 'pending' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 250);
  }
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async drain(): Promise<boolean> {
    while (this.command || (this.latest && this.latest.seq > this.confirmed)) {
      this.notify({ status: 'saving' });
      if (!this.command) {
        this.command = { sessionId: this.course.sessionId, operationId: crypto.randomUUID(),
          inputSeq: this.latest!.seq, baseRevision: this.revision,
          blockId: this.course.editableBlockId, text: this.latest!.text };
      }
      try {
        const receipt = await this.bridge.save(this.command);
        if (receipt.operationId !== this.command.operationId || receipt.inputSeq !== this.command.inputSeq ||
          receipt.sessionId !== this.command.sessionId || receipt.blockId !== this.command.blockId)
          throw new Error('保存确认与当前输入不匹配，请重试');
        this.revision = receipt.revision;
        this.confirmed = receipt.inputSeq;
        this.command = undefined;
      } catch (error) {
        const detail = (error as Error).message;
        this.notify({ status: 'error', error: /[\u4e00-\u9fff]/.test(detail) ? detail
          : '本地课程未能写入。请检查磁盘空间和目录权限后重试。' });
        return false;
      }
    }
    this.notify({ status: 'saved' });
    return true;
  }
}
