/* PROTOTYPE ONLY. A typography with upright geometry and an Excalidraw-like light palette.
   Formula and note edits live only in this page; no course files are written. */
const defaults = { input: "I_1=\\overline{z}", result: "F=I_1=\\overline{z}" };
const equations = { ...defaults };
let selectedEquation = "result";
let expandedKeyboard = false;
let camera = { x: 0, y: 0, scale: 1 };
let gesture = null;
let toastTimer;
const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const editorPanel = document.getElementById("editor-panel");

MathfieldElement.locale = "zh-cn";
MathfieldElement.fontsDirectory = new URL("./vendor/mathlive/fonts", location.href).href;
MathfieldElement.soundsDirectory = null;
const field = new MathfieldElement();
field.id = "visual-formula";
field.setAttribute("aria-label", "可视化公式输入");
field.mathVirtualKeyboardPolicy = "manual";
document.getElementById("mathfield-container").append(field);
mathVirtualKeyboard.layouts = ["numeric", "symbols", "greek"];

function markup(latex, display = false) {
  return MathLive.convertLatexToMarkup(latex || "\\placeholder{}", { displayMode: display });
}
function renderEquations() {
  document.querySelectorAll("[data-equation]").forEach(function (element) {
    const key = element.dataset.equation;
    element.querySelector(".math-render").innerHTML = markup(equations[key], true);
    element.classList.toggle("is-editing", !editorPanel.hidden && selectedEquation === key);
  });
}
function paintCamera() {
  world.style.transform = "translate(" + camera.x + "px," + camera.y + "px) scale(" + camera.scale + ")";
  document.getElementById("zoom-label").textContent = Math.round(camera.scale * 100) + "%";
}
function fitScene() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  camera.scale = Math.min((width - 40) / 1240, (height - 105) / 740, 1.35);
  camera.scale = Math.max(0.2, camera.scale);
  camera.x = (width - 1240 * camera.scale) / 2;
  camera.y = 50 + Math.max(0, (height - 105 - 740 * camera.scale) / 2);
  paintCamera();
}
function zoom(factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
  const next = Math.max(0.2, Math.min(2.4, camera.scale * factor));
  const ratio = next / camera.scale;
  camera.x = x - (x - camera.x) * ratio;
  camera.y = y - (y - camera.y) * ratio;
  camera.scale = next;
  paintCamera();
}
function openEditor(key = "result") {
  const previousWidth = viewport.clientWidth;
  selectedEquation = key;
  editorPanel.hidden = false;
  document.body.classList.add("editor-open");
  camera.x += (viewport.clientWidth - previousWidth) / 2;
  paintCamera();
  document.getElementById("open-editor").setAttribute("aria-pressed", "true");
  document.getElementById("editor-title").textContent = key === "input" ? "输入端公式" : "输出公式";
  field.setValue(equations[key], { silenceNotifications: true });
  document.getElementById("edit-status").textContent = "修改会直接显示在画板上";
  renderEquations();
  field.focus();
}
function closeEditor() {
  const previousWidth = viewport.clientWidth;
  editorPanel.hidden = true;
  document.body.classList.remove("editor-open");
  camera.x += (viewport.clientWidth - previousWidth) / 2;
  paintCamera();
  document.getElementById("open-editor").setAttribute("aria-pressed", "false");
  mathVirtualKeyboard.hide();
  expandedKeyboard = false;
  document.getElementById("more-symbols").textContent = "更多符号键盘";
  renderEquations();
}
function syncEquation() {
  equations[selectedEquation] = field.getValue("latex");
  renderEquations();
  document.getElementById("edit-status").textContent = "已在画板上更新";
}
function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { element.hidden = true; }, 4500);
}
function makeKeys(containerId, keys, withLabels = false) {
  const container = document.getElementById(containerId);
  keys.forEach(function (key) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "插入" + key[0]);
    button.title = key[0];
    button.innerHTML = '<span class="key-math">' + markup(key[2] || key[1]) + "</span>";
    if (withLabels) {
      const label = document.createElement("span");
      label.className = "key-label";
      label.textContent = key[0];
      button.append(label);
    }
    button.addEventListener("pointerdown", function (event) { event.preventDefault(); });
    button.addEventListener("click", function () {
      field.focus();
      field.insert(key[1], { selectionMode: "placeholder" });
      syncEquation();
    });
    container.append(button);
  });
}
makeKeys("basic-keys", [
  ["x", "x"], ["y", "y"], ["z", "z"], ["F", "F"], ["I", "I"], ["A", "A"], ["B", "B"],
  ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"], ["6", "6"],
  ["7", "7"], ["8", "8"], ["9", "9"], ["n", "n"], ["k", "k"], ["a", "a"], ["b", "b"]
]);
makeKeys("logic-keys", [
  ["等号", "="], ["非", "\\neg"], ["与", "\\land"], ["或", "\\lor"], ["异或", "\\oplus"], ["蕴含", "\\Rightarrow"],
  ["加号", "+"], ["乘号", "\\cdot"], ["等价", "\\Leftrightarrow"], ["小于", "<"], ["大于", ">"], ["不等号", "\\ne"]
]);
makeKeys("structure-keys", [
  ["上划线", "\\overline{#?}", "\\overline{x}"],
  ["分数", "\\frac{#?}{#?}", "\\frac{a}{b}"],
  ["括号", "\\left(#?\\right)", "\\left(x\\right)"],
  ["上标", "#?^{#?}", "x^n"],
  ["下标", "#?_{#?}", "x_i"],
  ["根号", "\\sqrt{#?}", "\\sqrt{x}"]
], true);

field.addEventListener("input", syncEquation);
document.querySelectorAll("[data-command]").forEach(function (button) {
  button.addEventListener("pointerdown", function (event) { event.preventDefault(); });
  button.addEventListener("click", function () {
    field.focus();
    field.executeCommand(button.dataset.command);
    syncEquation();
  });
});
document.getElementById("clear-formula").addEventListener("pointerdown", function (event) { event.preventDefault(); });
document.getElementById("clear-formula").addEventListener("click", function () {
  field.focus();
  field.executeCommand("selectAll");
  field.executeCommand("deleteBackward");
  syncEquation();
});
document.getElementById("more-symbols").addEventListener("pointerdown", function (event) { event.preventDefault(); });
document.getElementById("more-symbols").addEventListener("click", function () {
  if (expandedKeyboard) {
    mathVirtualKeyboard.hide();
    expandedKeyboard = false;
    this.textContent = "更多符号键盘";
  } else {
    field.focus();
    mathVirtualKeyboard.show();
    expandedKeyboard = true;
    this.textContent = "收起符号键盘";
  }
});
document.querySelectorAll("[data-equation]").forEach(function (element) {
  element.addEventListener("click", function () { openEditor(element.dataset.equation); });
  element.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openEditor(element.dataset.equation);
    }
  });
});
document.getElementById("open-editor").addEventListener("click", function () { openEditor(selectedEquation); });
document.getElementById("close-editor").addEventListener("click", closeEditor);
document.getElementById("finish-edit").addEventListener("click", closeEditor);
document.getElementById("reset").addEventListener("click", function () {
  Object.assign(equations, defaults);
  document.querySelector(".note p").innerHTML = "先确认 xy 的顺序，再找数据端。<br>交换高低位，选中的一路也会变。";
  if (!editorPanel.hidden) field.setValue(equations[selectedEquation], { silenceNotifications: true });
  renderEquations();
  document.getElementById("edit-status").textContent = "已恢复样例公式";
  toast("已恢复样例公式和笔记");
});
document.getElementById("fullscreen").addEventListener("click", async function () {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("可使用浏览器菜单进入全屏");
  }
});
document.getElementById("zoom-in").addEventListener("click", function () { zoom(1.15); });
document.getElementById("zoom-out").addEventListener("click", function () { zoom(1 / 1.15); });
document.getElementById("fit").addEventListener("click", fitScene);
viewport.addEventListener("wheel", function (event) {
  event.preventDefault();
  const bounds = viewport.getBoundingClientRect();
  zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });
viewport.addEventListener("pointerdown", function (event) {
  if (event.button !== 0 || event.target.closest("button,.equation,.note,[contenteditable],.canvas-tools")) return;
  if (event.target.closest("h1,h2,p,td,th,.node-inner,.selector-code")) return;
  gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("dragging");
  event.preventDefault();
});
viewport.addEventListener("pointermove", function (event) {
  if (!gesture || gesture.pointer !== event.pointerId) return;
  camera.x = gesture.cameraX + event.clientX - gesture.x;
  camera.y = gesture.cameraY + event.clientY - gesture.y;
  paintCamera();
});
function finishPan() { gesture = null; viewport.classList.remove("dragging"); }
viewport.addEventListener("pointerup", finishPan);
viewport.addEventListener("pointercancel", finishPan);
document.addEventListener("keydown", function (event) {
  if (event.composedPath().some(function (element) { return element.tagName === "MATH-FIELD" || element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable; })) return;
  if (event.key === "Escape" && !editorPanel.hidden) closeEditor();
});
window.addEventListener("resize", function () { paintCamera(); });
renderEquations();
requestAnimationFrame(fitScene);
