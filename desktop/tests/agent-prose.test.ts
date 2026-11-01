import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AgentProse } from '../src/renderer/agent-prose';

const html = (text: string) => renderToStaticMarkup(createElement(AgentProse, { text }));

test('markdown headings become real heading elements instead of being flattened into bold text', () => {
  const rendered = html('## 位权\n\n每一位的权等于基数乘以位序。');
  assert.match(rendered, /^<div class="agent-prose"><h3>位权<\/h3>/);
  assert.match(rendered, /<p>每一位的权等于基数乘以位序。<\/p>/);
  assert.ok(!rendered.includes('<strong>位权</strong>'), 'a heading must not degrade into bold prose');
});

test('list markers render as list items rather than literal dashes and digits', () => {
  const bullets = html('- 个位\n- 十位\n- 百位');
  assert.match(bullets, /<ul><li>个位<\/li><li>十位<\/li><li>百位<\/li><\/ul>/);
  assert.ok(!bullets.includes('- 个位'), 'the marker must not survive as visible text');
  const ordered = html('1. 写下位序\n2. 乘以基数幂');
  assert.match(ordered, /<ol><li>写下位序<\/li><li>乘以基数幂<\/li><\/ol>/);
  assert.ok(!ordered.includes('1. 写下位序'));
});

test('inline emphasis, code and KaTeX keep working inside blocks', () => {
  const rendered = html('**位置记数法** 的位权写作 `10^k`，也就是 $10^k$。');
  assert.match(rendered, /<strong>位置记数法<\/strong>/);
  assert.match(rendered, /<code>10\^k<\/code>/);
  assert.match(rendered, /class="katex"/);
});

test('a rendered formula survives as KaTeX output', () => {
  assert.match(html('位权公式 \\(10^k\\)。'), /class="katex"/);
});

test('model output cannot inject markup, and a link shows its destination instead of a dead anchor', () => {
  assert.ok(!html('<img src=x onerror=alert(1)>').includes('<img'), 'raw HTML must stay escaped text');
  const linked = html('详见 [课件](https://example.com/a)。');
  assert.ok(!linked.includes('<a '), 'the learning window denies navigation, so an anchor would be a dead control');
  assert.match(linked, /课件 https:\/\/example\.com\/a。/);
});

test('a quoted passage renders as a quote block and blank lines split paragraphs', () => {
  assert.match(html('> 原文摘录'), /<blockquote>原文摘录<\/blockquote>/);
  assert.match(html('第一段\n\n第二段'), /<p>第一段<\/p><p>第二段<\/p>/);
});

test('a single newline stays a line break so 课程依据 and 补充解释 do not fuse into one block', () => {
  const rendered = html('课程依据：位置的权决定数值。\n补充解释：例如 22 的两个 2 分别表示 20 和 2。');
  assert.match(rendered, /课程依据：位置的权决定数值。<br\/>补充解释/);
  assert.ok(!rendered.includes('数值。 补充解释'), 'the two sections must not be joined by a space');
});
