(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ReviewContentProvider = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  const NATURES = {
    'official-solution': '官方答案',
    'derived-solution': '据题干推导',
    'self-test': '编制自测',
    'authored-example': '依据课程方法编制的例题',
  };
  const states = new Map();
  const definitions = new Map();
  const esc = value => String(value ?? '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const paragraphs = value => String(value ?? '').split(/\n{2,}/)
    .map(part => `<p>${esc(part).replaceAll('\n', '<br>')}</p>`).join('');
  const math = latex => `<span class="math" data-math="${esc(latex)}"></span>`;
  const cell = value => value && typeof value === 'object' && 'latex' in value
    ? math(value.latex) : esc(value);
  const assetUrl = value => {
    const text = String(value ?? '');
    if (text.startsWith('期中/资源/')) return `/course-assets/${text.slice('期中/资源/'.length)}`;
    return text.startsWith('/') ? text : '';
  };
  const bit = value => Number(value) ? 1 : 0;

  function evaluateMux(config, inputs) {
    const selectedIndex = (config.selectBits || []).reduce((value, name) => value * 2 + bit(inputs[name]), 0);
    const evaluateSignal = signal => {
      const text = String(signal);
      if (text === '0' || text === '1') return Number(text);
      if (text.startsWith('¬')) return 1 - bit(inputs[text.slice(1)]);
      return bit(inputs[text]);
    };
    return { selectedIndex, value: evaluateSignal(config.dataSignals[selectedIndex]) };
  }

  function evaluateDecoder(config, inputs) {
    const enabled = Object.entries(config.enable || {})
      .every(([name, expected]) => bit(inputs[name]) === bit(expected));
    const selectedIndex = (config.addressBits || []).reduce((value, name) => value * 2 + bit(inputs[name]), 0);
    const count = config.outputs || 8;
    const outputs = Array.from({ length: count }, (_, index) => {
      if (!enabled) return config.activeLowOutputs ? 1 : 0;
      const active = index === selectedIndex;
      return config.activeLowOutputs ? (active ? 0 : 1) : (active ? 1 : 0);
    });
    return { enabled, selectedIndex, outputs };
  }

  function question(unit, identifier) {
    return (unit.questions || []).find(item => item.questionId === identifier)?.question || null;
  }

  function renderChildren(block, unit) {
    const inline = block.kind === 'example' || block.kind === 'exercise';
    return (block.children || []).map(child => renderBlock(inline ? { ...child, role: 'core' } : child, unit)).join('');
  }

  function renderTable(payload) {
    return `${payload.title ? `<h4>${esc(payload.title)}</h4>` : ''}<div class="reading-table-wrap"><table class="reading-table"><thead><tr>${payload.columns.map(value => `<th>${cell(value)}</th>`).join('')}</tr></thead><tbody>${payload.rows.map(row => `<tr>${row.map(value => `<td>${cell(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderInteractive(block) {
    const payload = block.payload;
    definitions.set(block.id, { config: payload.config, inputs: payload.inputs });
    const inputs = Object.keys(payload.inputs || {});
    return `<div class="reading-interactive" data-component="${esc(payload.component)}" data-block-id="${esc(block.id)}"><svg class="reading-interactive-svg" data-interactive-svg role="img" aria-label="${esc(payload.config.label || payload.component)}"></svg><div class="reading-controls">${inputs.map(name => {
      const toggleLabel = payload.component === 'kmap' && name === 'showCorners' ? '显示跨边圈组' : null;
      return `<button type="button" data-interactive-input="${esc(name)}" aria-pressed="false"><span>${esc(toggleLabel || name)}</span>${toggleLabel ? '' : '<b data-input-value></b>'}</button>`;
    }).join('')}</div><div class="reading-interactive-output" data-interactive-output aria-live="polite"></div></div>`;
  }

  function renderExample(block, unit) {
    const payload = block.payload;
    const q = payload.questionId ? question(unit, payload.questionId) : null;
    const problem = q?.stem || payload.problem || '';
    const solution = block.children?.length ? '' : (q?.solution || '');
    const provenance = `${payload.questionId ? `${esc(payload.questionId)} · ` : ''}${esc(NATURES[payload.answerNature] || payload.answerNature)}`;
    return `<details class="material reading-example" id="${esc(block.id)}"><summary>${esc(payload.title)}<span class="material-tag">例题 · 展开即读完整解法</span></summary><div class="material-content"><div class="reading-problem">${paragraphs(problem)}</div><p class="reading-provenance">${provenance}</p>${solution ? `<div class="reading-solution">${paragraphs(solution)}</div>` : ''}${renderChildren(block, unit)}</div></details>`;
  }

  function renderExercise(block, unit) {
    const payload = block.payload;
    const q = payload.questionId ? question(unit, payload.questionId) : null;
    const problem = q?.stem || payload.problem || '';
    const solution = block.children?.length ? '' : (q?.solution || '');
    const provenance = `${payload.questionId ? `${esc(payload.questionId)} · ` : ''}${esc(NATURES[payload.answerNature] || payload.answerNature)}`;
    return `<section class="reading-exercise" id="${esc(block.id)}"><h4>${esc(payload.title)}</h4><div class="reading-problem">${paragraphs(problem)}</div><p class="reading-provenance">${provenance}</p><div class="reveal-actions">${payload.hint ? `<button type="button" data-reveal="${esc(block.id)}-hint" aria-expanded="false">看提示</button>` : ''}<button type="button" data-reveal="${esc(block.id)}-answer" aria-expanded="false">看答案与步骤</button></div>${payload.hint ? `<div id="${esc(block.id)}-hint" class="hint" hidden><span class="reading-hint-label">学习提示</span>${paragraphs(payload.hint)}</div>` : ''}<div id="${esc(block.id)}-answer" class="answer" hidden><span class="reading-answer-label">答案与步骤</span>${solution ? paragraphs(solution) : ''}${renderChildren(block, unit)}</div></section>`;
  }

  function renderBlock(block, unit) {
    const payload = block.payload || {};
    if (block.kind === 'example') return renderExample(block, unit);
    if (block.kind === 'exercise') return renderExercise(block, unit);
    let body = '';
    if (block.kind === 'paragraph') body = paragraphs(payload.text);
    else if (block.kind === 'formula') body = `<div class="math-row">${math(payload.latex)}</div>${payload.caption ? `<p>${esc(payload.caption)}</p>` : ''}`;
    else if (block.kind === 'figure') {
      const url = assetUrl(payload.asset);
      body = payload.asset
        ? (url ? `<figure><img src="${esc(url)}" alt="${esc(payload.alt)}" decoding="async">${payload.caption ? `<figcaption>${esc(payload.caption)}</figcaption>` : ''}</figure>`
          : '<p class="reading-error">图示资源路径无效或缺失。</p>')
        : `<figure class="reading-semantic-figure" data-figure-config="${esc(JSON.stringify(payload.config))}" data-figure-alt="${esc(payload.alt)}"></figure>`;
    } else if (block.kind === 'table') body = renderTable(payload);
    else if (block.kind === 'steps') body = `<ol class="steps">${payload.items.map(item => `<li>${esc(item)}</li>`).join('')}</ol>${renderChildren(block, unit)}`;
    else if (block.kind === 'callout') {
      const tone = ['blue', 'green', 'amber'].includes(payload.tone) ? payload.tone : 'amber';
      const label = tone === 'blue' ? '课程说明' : tone === 'green' ? '结论与验证' : '课程提醒';
      body = `<div class="reading-callout ${tone}"><span class="reading-callout-label">${label}</span>${paragraphs(payload.text)}</div>`;
    }
    else if (block.kind === 'knowledge-reference') body = `<button type="button" class="reading-knowledge-reference" data-focus="${esc(payload.targetUnitId)}">回看知识主位置：${esc(payload.targetUnitId)}<small>${esc(payload.intent)}</small></button>`;
    else if (block.kind === 'interactive') body = renderInteractive(block);
    else body = '<p class="reading-error">此正文块暂不能显示。</p>';
    if (block.role !== 'core') {
      return `<details class="material reading-block" id="${esc(block.id)}"><summary>${esc(payload.title || '补充材料')}<span class="material-tag">${block.role === 'supplement' ? '补充说明' : '收纳材料'}</span></summary><div class="material-content">${body}</div></details>`;
    }
    const hasComponentClass = ['callout', 'knowledge-reference', 'interactive', 'table'].includes(block.kind);
    return `<div class="reading-block${hasComponentClass ? '' : ` reading-${esc(block.kind)}`}" data-block-id="${esc(block.id)}">${body}</div>`;
  }

  function render(unit) {
    const reading = unit?.reading;
    if (!reading || !Array.isArray(reading.blocks)) return null;
    return `${reading.status === 'draft' ? '<p class="reading-draft">正文草稿，尚未完成证据与阅读验收。</p>' : ''}${reading.blocks.map(block => renderBlock(block, unit)).join('')}`;
  }

  function svgElement(tag, attributes = {}, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function drawing(svg) {
    const generator = window.rough?.generator();
    const append = drawable => {
      if (generator) {
        for (const item of generator.toPaths(drawable)) {
          svg.append(svgElement('path', {
            d: item.d, stroke: item.stroke, 'stroke-width': item.strokeWidth,
            fill: item.fill || 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          }));
        }
      }
    };
    return {
      line(d, color = '#7798bc', width = 1.8, seed = 17) {
        if (generator) append(generator.path(d, { stroke: color, strokeWidth: width, roughness: .8, bowing: 1.35, preserveVertices: true, seed }));
        else svg.append(svgElement('path', { d, fill: 'none', stroke: color, 'stroke-width': width }));
      },
      rect(x, y, w, h, stroke = '#7798bc', fill = 'none', seed = 77) {
        if (generator) append(generator.rectangle(x, y, w, h, { stroke, fill, fillStyle: 'solid', roughness: 1.45, bowing: 1.35, preserveVertices: true, strokeWidth: 1.5, seed, disableMultiStrokeFill: true }));
        else svg.append(svgElement('rect', { x, y, width: w, height: h, fill, stroke, 'stroke-width': 1.5 }));
      },
      text(x, y, value, size = 22, color = '#27384a', anchor = 'start') {
        svg.append(svgElement('text', { x, y, 'font-size': size, fill: color, 'text-anchor': anchor }, value));
      },
      circle(x, y, r, color = '#7798bc') {
        svg.append(svgElement('circle', { cx: x, cy: y, r, fill: '#fff', stroke: color, 'stroke-width': 1.8 }));
      },
    };
  }

  function drawMux(element, config, inputs) {
    const svg = element.querySelector('[data-interactive-svg]');
    svg.setAttribute('viewBox', '0 0 520 330');
    svg.replaceChildren();
    const draw = drawing(svg);
    const result = evaluateMux(config, inputs);
    draw.line('M180 30L360 66V230L180 267Z');
    draw.text(270, 100, `${config.dataSignals.length}:1 MUX`, 25, '#27384a', 'middle');
    config.dataSignals.forEach((signal, index) => {
      const y = 63 + index * 53;
      const active = index === result.selectedIndex;
      const color = active ? '#286b58' : '#b7c3ce';
      draw.line(`M95 ${y}H180`, color, active ? 3.5 : 1.6, 320 + index);
      draw.text(18, y + 8, `I${index} = ${signal}`, 22, active ? '#286b58' : '#6f7d89');
      if (active) draw.line(`M180 ${y}Q240 ${y} 270 143H440`, '#286b58', 3.5, 330 + index);
    });
    draw.text(450, 151, 'Y', 27, '#286b58');
    draw.text(270, 305, config.selectBits.map(name => `${name}=${bit(inputs[name])}`).join('  '), 21, '#345d88', 'middle');
    element.querySelector('[data-interactive-output]').textContent = `选中 I${result.selectedIndex}，Y = ${config.dataSignals[result.selectedIndex]} = ${result.value}`;
  }

  function drawDecoder(element, config, inputs) {
    const svg = element.querySelector('[data-interactive-svg]');
    svg.setAttribute('viewBox', '0 0 500 420');
    svg.replaceChildren();
    const draw = drawing(svg);
    const result = evaluateDecoder(config, inputs);
    draw.rect(175, 20, 150, 315, '#7798bc', '#f0f5fc', 610);
    draw.text(250, 48, '74LS138', 25, '#27384a', 'middle');
    config.addressBits.forEach((name, index) => {
      const y = 105 + index * 64;
      draw.line(`M65 ${y}H175`, '#345d88', 1.8, 611 + index);
      draw.text(15, y + 8, `${name}=${bit(inputs[name])}`, 22, '#345d88');
    });
    result.outputs.forEach((value, index) => {
      const y = 68 + index * 33;
      const active = result.enabled && index === result.selectedIndex;
      draw.line(`M337 ${y}H440`, active ? '#286b58' : '#b2c0cc', active ? 3.5 : 1.5, 625 + index);
      draw.circle(331, y, 6, active ? '#286b58' : '#7798bc');
      draw.text(343, y - 8, `Y̅${index}`, 19, active ? '#286b58' : '#6f7d89');
      draw.text(457, y + 7, String(value), 23, active ? '#286b58' : '#6f7d89');
    });
    Object.keys(config.enable).forEach((name, index) => {
      const x = 202 + index * 49;
      if (config.enable[name] === 0) draw.circle(x, 342, 6);
      draw.text(x, 407, `${name}=${bit(inputs[name])}`, 19, '#345d88', 'middle');
    });
    element.querySelector('[data-interactive-output]').textContent = result.enabled
      ? `已使能，第 ${result.selectedIndex} 路输出为 0，其余 7 路为 1。`
      : '使能条件不满足，8 路输出全部为 1。';
  }

  function drawKmap(element, config, inputs) {
    const svg = element.querySelector('[data-interactive-svg]');
    svg.setAttribute('viewBox', '0 0 620 300');
    svg.replaceChildren();
    const draw = drawing(svg);
    const rows = config.cells.length;
    const columns = config.cells[0].length;
    const x = 140, y = 55, w = 90, h = 75;
    draw.rect(x, y, columns * w, rows * h, '#7798bc', '#fff', 510);
    config.columnOrder.forEach((value, index) => draw.text(x + index * w + w / 2, y - 17, value, 22, '#345d88', 'middle'));
    config.cells.forEach((row, r) => {
      draw.text(x - 25, y + r * h + 46, String(r), 22, '#345d88', 'middle');
      row.forEach((value, c) => {
        if (inputs.showCorners && config.highlight === 'wrap-four' && (c === 0 || c === columns - 1)) {
          draw.rect(x + c * w + 4, y + r * h + 4, w - 8, h - 8, '#286b58', '#e2f1e8', 520 + r * columns + c);
        }
        draw.text(x + c * w + w / 2, y + r * h + 47, String(value), 27, value ? '#286b58' : '#27384a', 'middle');
      });
    });
    draw.text(45, 70, 'A / BC', 20, '#345d88');
    element.querySelector('[data-interactive-output]').textContent = inputs.showCorners
      ? '首列和末列跨边相邻，四个 1 可以合成一组；圈内只有 C 恒为 0。'
      : '两位坐标顺序为 00、01、11、10；点击按钮观察跨边相邻。';
  }

  function drawInteractive(element) {
    const identifier = element.dataset.blockId;
    const definition = definitions.get(identifier);
    if (!definition) throw new Error(`找不到交互配置：${identifier}`);
    const config = definition.config;
    const inputs = states.get(identifier);
    if (element.dataset.component === 'mux') drawMux(element, config, inputs);
    else if (element.dataset.component === 'decoder') drawDecoder(element, config, inputs);
    else if (element.dataset.component === 'kmap') drawKmap(element, config, inputs);
    element.querySelectorAll('[data-interactive-input]').forEach(button => {
      const value = bit(inputs[button.dataset.interactiveInput]);
      button.setAttribute('aria-pressed', String(Boolean(value)));
      const valueElement = button.querySelector('[data-input-value]');
      if (valueElement) valueElement.textContent = value;
    });
  }

  function drawSemanticFigures(root) {
    root.querySelectorAll('.reading-semantic-figure').forEach(figure => {
      const config = JSON.parse(figure.dataset.figureConfig || '{}');
      const svg = svgElement('svg', { viewBox: '0 0 640 240', role: 'img', 'aria-label': figure.dataset.figureAlt });
      const draw = drawing(svg);
      const nodes = config.nodes || [];
      const positions = new Map(nodes.map((node, index) => [node.id || index, {
        x: Number(node.x ?? 100 + (index % 3) * 210),
        y: Number(node.y ?? 70 + Math.floor(index / 3) * 100),
        label: node.label || String(node.id || index),
      }]));
      for (const edge of config.edges || []) {
        const from = positions.get(edge.from), to = positions.get(edge.to);
        if (from && to) draw.line(`M${from.x} ${from.y}L${to.x} ${to.y}`, '#7798bc', 1.8, 700 + nodes.length);
      }
      for (const position of positions.values()) {
        draw.rect(position.x - 70, position.y - 28, 140, 56, '#7798bc', '#f6f9fc', 720 + position.x);
        draw.text(position.x, position.y + 7, position.label, 18, '#27384a', 'middle');
      }
      figure.replaceChildren(svg);
      if (config.caption) {
        const caption = document.createElement('figcaption');
        caption.textContent = config.caption;
        figure.append(caption);
      }
    });
  }

  function afterRender(root) {
    if (typeof document === 'undefined') return;
    try {
      if (!document.getElementById('review-content-style')) {
        const link = document.createElement('link');
        link.id = 'review-content-style';
        link.rel = 'stylesheet';
        link.href = '/web/content/content.css';
        document.head.append(link);
      }
      if (window.MathLive) {
        root.querySelectorAll('[data-math]').forEach(element => {
          element.innerHTML = window.MathLive.convertLatexToMarkup(element.dataset.math, { displayMode: false });
        });
      }
      root.querySelectorAll('.reading-interactive').forEach(element => {
        const identifier = element.dataset.blockId;
        if (!states.has(identifier)) states.set(identifier, { ...definitions.get(identifier).inputs });
        if (!element.dataset.bound) {
          element.dataset.bound = 'true';
          element.addEventListener('click', event => {
            const button = event.target.closest('[data-interactive-input]');
            if (!button) return;
            const current = states.get(identifier);
            const name = button.dataset.interactiveInput;
            current[name] = 1 - bit(current[name]);
            states.set(identifier, current);
            drawInteractive(element);
            window.dispatchEvent(new CustomEvent('review-content-input', { detail: { blockId: identifier, inputs: { ...current } } }));
          });
        }
        drawInteractive(element);
      });
      drawSemanticFigures(root);
    } catch (error) {
      const diagnostic = document.createElement('pre');
      diagnostic.className = 'reading-error';
      diagnostic.textContent = `正文组件渲染失败：${error.message || error}`;
      root.prepend(diagnostic);
      console.error('正文组件渲染失败', error);
    }
  }

  function captureState() {
    return Object.fromEntries([...states].map(([identifier, inputs]) => [identifier, { ...inputs }]));
  }

  function restoreState(saved) {
    for (const [identifier, inputs] of Object.entries(saved || {})) states.set(identifier, { ...inputs });
    if (typeof document !== 'undefined') document.querySelectorAll('.reading-interactive').forEach(drawInteractive);
  }

  return {
    render,
    afterRender,
    captureState,
    restoreState,
    logic: { evaluateMux, evaluateDecoder },
  };
});
