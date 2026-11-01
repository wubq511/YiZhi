export type MessageMode = 'steer' | 'queue';
const key = 'yizhi.agent.message-mode';

/** PRODUCT.md makes this a setting rather than a per-send choice, so the composer and 课程设置 read one value. */
export function readMessageMode(): MessageMode {
  try { return localStorage.getItem(key) === 'queue' ? 'queue' : 'steer'; } catch { return 'steer'; }
}
export function writeMessageMode(mode: MessageMode) {
  try { localStorage.setItem(key, mode); } catch { /* preference only */ }
  window.dispatchEvent(new Event('yizhi:message-mode'));
}
export function subscribeMessageMode(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === key) listener(); };
  window.addEventListener('yizhi:message-mode', listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener('yizhi:message-mode', listener); window.removeEventListener('storage', storage); };
}
