import type { Viewport } from '@xyflow/react';

const sameViewport = (a: Viewport, b: Viewport) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** Incremental wheel transforms awaiting the next paint, never a second live camera.
 * ReactFlow remains authoritative; any intervening external camera write invalidates the batch.
 */
export class PinchViewportFrame {
  private pending?: { base: Viewport; next: Viewport };
  private frame?: number;
  private generation = 0;
  constructor(private read: () => Viewport, private publish: (next: Viewport) => void) {}

  current(): Viewport {
    const live = this.read();
    if (this.pending && !sameViewport(live, this.pending.base)) this.cancel();
    return this.pending?.next ?? live;
  }

  pinch(factor: number, px: number, py: number) {
    const current = this.current();
    const zoom = Math.max(.04, Math.min(2, current.zoom * factor)), ratio = zoom / current.zoom;
    this.pending = { base: this.pending?.base ?? current,
      next: { x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio, zoom } };
    if (this.frame !== undefined) return;
    const generation = this.generation;
    this.frame = requestAnimationFrame(() => { if (generation === this.generation) this.flush(); });
  }

  flush() {
    const pending = this.pending;
    this.cancel();
    if (pending && sameViewport(this.read(), pending.base)) this.publish(pending.next);
  }

  cancel() {
    this.generation++;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined; this.pending = undefined;
  }
}
