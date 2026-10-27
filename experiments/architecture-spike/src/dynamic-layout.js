// Isolated downward projection: baseline order is stable; only collisions add displacement.
// Width is fixed in this spike. Arbitrary free-form ordering/group constraints are out of scope.
export function createDynamicLayout({ nodes, width, stats }) {
  const baseline = new Map(nodes.map(n => [n.id, { ...n.position }]));
  let projected = new Map(nodes.map(n => [n.id, { ...n.position }]));
  const heights = new Map(nodes.map(n => [n.id, n.data.height]));
  let flow, camera, frame = 0, dragging = null;
  const queue = () => { if (!frame) frame = requestAnimationFrame(flush); };
  function flush() {
    frame = 0;
    if (!flow || dragging) return;
    const ordered = [...baseline.keys()].sort((a, b) => baseline.get(a).y - baseline.get(b).y || a.localeCompare(b));
    const placed = [];
    const positions = new Map();
    for (const id of ordered) {
      const base = baseline.get(id);
      let y = base.y;
      for (const prev of placed) {
        if (base.x < prev.x + width && base.x + width > prev.x) y = Math.max(y, prev.y + prev.height + 40);
      }
      positions.set(id, { x: base.x, y });
      placed.push({ x: base.x, y, height: heights.get(id) });
    }
    projected = positions;
    const current = flow.getNodes();
    const changed = current.filter(n => n.position.x !== positions.get(n.id).x || n.position.y !== positions.get(n.id).y || n.data.height !== heights.get(n.id));
    if (!changed.length) return;
    const anchor = camera.captureAnchor();
    stats.layoutCommits++;
    stats.lastMoved = changed.filter(n => n.position.y !== positions.get(n.id).y).map(n => n.id);
    flow.setNodes(current.map(n => changed.includes(n) ? {
      ...n, position: positions.get(n.id), style: { ...n.style, height: heights.get(n.id) },
      data: { ...n.data, height: heights.get(n.id) },
    } : n));
    // Write outside ResizeObserver delivery; measuring the natural article cannot feed back
    // from the wrapper's projected height. Keep cached sizes when content unmounts.
    requestAnimationFrame(() => { camera.restoreAnchor(anchor); camera.reconcileVisibility(); });
  }
  return {
    attach(f, c) { flow = f; camera = c; queue(); },
    observe(id, article) {
      const observer = new ResizeObserver(entries => {
        const h = Math.ceil(entries[0].borderBoxSize?.[0]?.blockSize || article.offsetHeight);
        if (Math.abs(h - heights.get(id)) < 1) return;
        heights.set(id, h); stats.sizeReports++; queue();
      });
      observer.observe(article);
      return () => observer.disconnect();
    },
    dragStart(id, position) { dragging = { id, start: { ...(projected.get(id) || position) }, base: { ...baseline.get(id) } }; },
    move(id, position) { baseline.set(id, { ...position }); queue(); },
    dragStop(id, position) {
      // A drag edits the manual baseline by its gesture delta, not by baking in the
      // temporary displacement currently contributed by expanded neighbors.
      if (dragging?.id === id) baseline.set(id, {
        x: dragging.base.x + position.x - dragging.start.x,
        y: dragging.base.y + position.y - dragging.start.y,
      });
      dragging = null; queue();
    },
    snapshot() { return { baseline: Object.fromEntries(baseline), heights: Object.fromEntries(heights), pending: Boolean(frame), dragging: Boolean(dragging) }; },
  };
}
