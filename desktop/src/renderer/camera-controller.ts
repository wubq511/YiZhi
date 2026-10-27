import type { Viewport } from '@xyflow/react';
export type FollowState = 'idle' | 'following' | 'paused' | 'finished';
export interface CameraPort { get(): Viewport; set(viewport: Viewport): void; target(): { x: number; y: number; width: number; height: number } | undefined; bounds(): { width: number; height: number }; reduced(): boolean }
/** All automatic motion uses the same live viewport as gestures. No stale captured viewport writes. */
export class CameraController {
  private frame?: number;
  private generation = 0;
  private state: FollowState = 'idle';
  constructor(private port: CameraPort, private changed: (state: FollowState) => void) {}
  private cancel() { this.generation++; if (this.frame !== undefined) cancelAnimationFrame(this.frame); this.frame = undefined; }
  private change(state: FollowState) { this.state = state; this.changed(state); }
  restore(ended: boolean) { this.cancel(); this.change(ended ? 'finished' : 'paused'); }
  takeover() { this.cancel(); if (this.state === 'following') this.change('paused'); }
  start() { this.cancel(); this.change('following'); }
  finish() { this.cancel(); if (this.state !== 'idle') this.change('finished'); }
  resume() { this.cancel(); if (this.state !== 'finished') this.change('following'); this.locate(); }
  compensate(dx: number, dy: number) { const current = this.port.get(); this.port.set({ ...current, x: current.x - dx * current.zoom, y: current.y - dy * current.zoom }); }
  pan(dx: number, dy: number) { this.takeover(); const current = this.port.get(); this.port.set({ ...current, x: current.x + dx, y: current.y + dy }); }
  updated() { if (this.state === 'following') this.locate(); }
  private locate() {
    this.cancel(); const generation = this.generation;
    let previous = performance.now(); const end = previous + (this.port.reduced() ? 0 : 180);
    const step = (time: number) => {
      if (generation !== this.generation) return;
      this.frame = undefined;
      const target = this.port.target(); if (!target) return;
      const current = this.port.get(), bounds = this.port.bounds();
      const left = target.x * current.zoom + current.x, top = target.y * current.zoom + current.y;
      const width = target.width * current.zoom, height = target.height * current.zoom;
      const margin = 32, topMargin = 100;
      const dx = left < margin ? margin - left : left + Math.min(width, bounds.width - margin * 2) > bounds.width - margin ? bounds.width - margin - left - Math.min(width, bounds.width - margin * 2) : 0;
      const dy = top < topMargin ? topMargin - top : top + Math.min(height, bounds.height - topMargin - margin) > bounds.height - margin ? bounds.height - margin - top - Math.min(height, bounds.height - topMargin - margin) : 0;
      if (Math.abs(dx) + Math.abs(dy) < .5) return;
      const remaining = Math.max(0, end - time), elapsed = Math.max(1, time - previous); previous = time;
      const fraction = remaining === 0 ? 1 : Math.min(1, 1 - Math.pow(remaining / (remaining + elapsed), 3));
      this.port.set({ ...current, x: current.x + dx * fraction, y: current.y + dy * fraction });
      if (remaining > 0) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
  dispose() { this.cancel(); }
}
