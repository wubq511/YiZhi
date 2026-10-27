/* Build static SVG strokes. Fixed seeds keep shapes stable across edits and reloads.
   Geometry stays aligned; only the pen strokes have small variations. */
const fs = require("node:fs");
const path = require("node:path");
const rough = require("./vendor/roughjs/rough.cjs.js");
const generator = rough.generator();
const base = {
  roughness: 1.45,
  bowing: 1.35,
  preserveVertices: true,
  strokeWidth: 1.5,
  fillStyle: "solid",
  disableMultiStrokeFill: true,
};
function render(drawables) {
  return drawables.flatMap(drawable => generator.toPaths(drawable)).map(p => {
    const kind = p.stroke === "none" ? "sketch-fill" : "sketch-stroke";
    return `<path class="${kind}" d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || "none"}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("\n");
}
function rect(x, y, width, height, options) {
  return generator.rectangle(x, y, width, height, { ...base, ...options });
}
function line(d, options) {
  return generator.path(d, { ...base, fill: "none", ...options });
}
function arrow(d, end, tangent, seed) {
  const angle = Math.atan2(end[1] - tangent[1], end[0] - tangent[0]);
  const back = [end[0] - 10 * Math.cos(angle), end[1] - 10 * Math.sin(angle)];
  const left = [back[0] - 4 * Math.sin(angle), back[1] + 4 * Math.cos(angle)];
  const right = [back[0] + 4 * Math.sin(angle), back[1] - 4 * Math.cos(angle)];
  const options = { stroke: "var(--line)", roughness: 0.85, seed };
  return [line(d, options), line(`M${left}L${end}L${right}`, { ...options, seed: seed + 1, roughness: 0.55 })];
}
const drawings = {
  selection: [rect(8, 7, 284, 176, { seed: 1027, stroke: "var(--condition-line)", fill: "var(--condition-fill)" })],
  result: [rect(8, 7, 344, 206, { seed: 2026, stroke: "var(--signal-line)", fill: "var(--signal-fill)", strokeWidth: 1.6 })],
  note: [
    rect(3, 3, 314, 124, { seed: 3017, stroke: "var(--note-line)", fill: "var(--note-fill)", roughness: 1.2, strokeWidth: 1.3 }),
    line("M5 8L5 122", { seed: 3018, stroke: "#c2974f", strokeWidth: 2.8, roughness: 0.5 }),
  ],
  input: [rect(2, 2, 236, 52, { seed: 3043, stroke: "var(--condition-line)", fill: "var(--condition-fill)", roughness: 0.95, strokeWidth: 1.2 })],
  circuit: [
    line("M156 30L286 68L286 236L156 269Z", { seed: 4013, stroke: "#71859a", fill: "#f7f9fc", strokeWidth: 1.8 }),
    line("M50 70L156 70M50 181L156 181M50 236L156 236", { seed: 4021, stroke: "#bec6cf", strokeWidth: 1.5, roughness: 0.6 }),
    line("M50 125L155 125Q190 124 220 153L284 153L375 153", { seed: 4033, stroke: "var(--signal-ink)", strokeWidth: 3.2, roughness: 0.65 }),
    line("M220 298L220 255", { seed: 4047, stroke: "var(--condition-ink)", strokeWidth: 1.6, roughness: 0.6 }),
  ],
  connections: [
    ...arrow("M335 402Q367 401 406 390", [406, 390], [367, 401], 5021),
    ...arrow("M794 390Q820 393 850 369", [850, 369], [820, 393], 5033),
    ...arrow("M1020 510L1020 532", [1020, 532], [1020, 510], 5047),
  ],
  underline: [line("M2 9Q90 5 175 9T348 8", { seed: 6011, stroke: "#c2e3d4", strokeWidth: 4, roughness: 1.2, disableMultiStroke: true })],
};
const filename = path.join(__dirname, "index.html");
let html = fs.readFileSync(filename, "utf8");
for (const [name, drawables] of Object.entries(drawings)) {
  const start = `<!-- sketch:${name} -->`;
  const end = `<!-- /sketch:${name} -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(html)) throw new Error(`Missing sketch slot: ${name}`);
  html = html.replace(pattern, () => `${start}\n${render(drawables)}\n${end}`);
}
fs.writeFileSync(filename, html);
process.stdout.write(`Generated ${Object.keys(drawings).length} static hand-drawn SVG groups.\n`);
