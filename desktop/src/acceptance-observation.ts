/** Passive, opt-in aggregates. Never store payloads, IDs, keystrokes or an unbounded event log. */
export interface ObservationValue { current: number; peak: number; count: number; sum: number; min: number; max: number }
export type ObservationSnapshot = Record<string, ObservationValue>;
export interface CoreObservation {
  instanceId: string; threadId: number; courseIds: string[];
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
  counters: ObservationSnapshot;
}
export class Observation {
  private enabled = false;
  private values = new Map<string, ObservationValue>();
  enable() { this.enabled = true; }
  get active() { return this.enabled; }
  private entry(name: string) {
    let value = this.values.get(name);
    if (!value) { value = { current: 0, peak: 0, count: 0, sum: 0, min: 0, max: 0 }; this.values.set(name, value); }
    return value;
  }
  count(name: string, amount = 1) { if (this.enabled) { const value = this.entry(name); value.count += amount; } }
  sample(name: string, sample: number) {
    if (!this.enabled) return;
    const value = this.entry(name);
    value.min = value.count ? Math.min(value.min, sample) : sample;
    value.max = value.count ? Math.max(value.max, sample) : sample;
    value.count++; value.sum += sample;
  }
  resource(name: string) {
    let previous = 0, closed = false;
    const set = (next: number) => {
      if (!this.enabled || closed) return;
      const value = this.entry(name); value.current += next - previous;
      value.peak = Math.max(value.peak, value.current); previous = next;
    };
    return { set, close: () => { if (!closed) { set(0); closed = true; } } };
  }
  snapshot(): ObservationSnapshot { return Object.fromEntries([...this.values].map(([name, value]) => [name, { ...value }])); }
}
export const observation = new Observation();
