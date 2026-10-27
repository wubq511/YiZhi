import { readOnlyCLIArgs } from './isolation';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Bidirectional JSON-RPC: server requests must not wait behind outstanding client RPCs. */
export class AppServerRPC {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failure?: Error;
  private stderr = '';
  private closed: Promise<void>;
  constructor(path: string, cwd: string, env: NodeJS.ProcessEnv,
    private notification: (method: string, params: any) => void,
    private serverRequest: (method: string, params: any, id: string | number) => Promise<any>,
    private disconnected: (error: Error) => void) {
    this.child = spawn(path, ['app-server', '--listen', 'stdio://', ...readOnlyCLIArgs], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()));
    const lines = createInterface({ input: this.child.stdout });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-2000); });
    lines.on('line', line => {
      try {
        if (line.length > 4_000_000) throw new Error('执行器协议消息过大');
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          void this.serverRequest(message.method, message.params, message.id).then(
            result => this.send({ id: message.id, result }),
            error => this.send({ id: message.id, error: { code: -32601, message: String(error.message ?? error) } }),
          ).catch(error => this.fail(error));
        } else if (message.id !== undefined) {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(`app-server ${message.error.code}: ${message.error.message}`));
          else waiter.resolve(message.result);
        } else if (typeof message.method === 'string') this.notification(message.method, message.params);
        else throw new Error('执行器返回无效 JSON-RPC');
      } catch (error) { this.fail(new Error(`执行器协议错误：${(error as Error).message}`)); this.child.kill(); }
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('exit', (code, signal) => { lines.close(); this.fail(new Error(`执行器已断开 (${code ?? signal})${this.stderr ? ': ' + this.stderr.trim() : ''}`)); });
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear(); this.disconnected(error);
  }
  private send(message: any) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  notify(method: string, params: any = {}) { this.send({ method, params }); }
  request<T = any>(method: string, params: any, timeout = 30_000): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`执行器请求超时：${method}，结果未知`)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.send({ id, method, params }); } catch (error) { this.pending.get(id)?.reject(error as Error); this.pending.delete(id); }
    });
  }
  async close() {
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
