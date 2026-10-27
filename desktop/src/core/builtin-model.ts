import type { BuiltinDefinition, ExperimentResult } from '../experiments-api';

const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
const bit = (v: unknown) => v === 0 || v === 1;
export function inputsFor(d: BuiltinDefinition): string[] { return Object.keys(d.initialInputs); }
export function validateInputs(d: BuiltinDefinition, inputs: Record<string, number>) {
  const names = inputsFor(d);
  if (!inputs || Object.keys(inputs).length !== names.length || names.some(n => !bit(inputs[n]))) throw new Error('输入必须覆盖声明的全部布尔变量');
}
export function definitionFrom(payload: Record<string, any>): BuiltinDefinition {
  const { component: kind, config } = payload;
  const inputs = Object.fromEntries(Object.entries(payload.inputs ?? {}).map(([k, v]) => [k, Number(v)]));
  if (!['mux', 'decoder', 'kmap'].includes(kind) || !config || Object.keys(inputs).length > 6 || Object.keys(inputs).some(n => !identifier.test(n)) || Object.values(inputs).some(v => !bit(v))) throw new Error('不支持的内置实验定义');
  if (kind === 'mux') {
    const s = config.selectBits, data = config.dataSignals;
    if (!Array.isArray(s) || ![1, 2].includes(s.length) || new Set(s).size !== s.length || s.some(n => !(n in inputs)) ||
      !Array.isArray(data) || data.length !== 2 ** s.length || data.some(n => typeof n !== 'string' || (!['0', '1'].includes(n) && !(n.replace(/^¬/, '') in inputs)))) throw new Error('仅支持 2:1／4:1 MUX 字面量配置');
  } else if (kind === 'decoder') {
    if (!Array.isArray(config.addressBits) || config.addressBits.length !== 3 || config.outputs !== 8 || config.activeLowOutputs !== true ||
      !config.enable || Object.keys(config.enable).length !== 3 || Object.values(config.enable).filter(v => v === 1).length !== 1 || Object.values(config.enable).filter(v => v === 0).length !== 2 ||
      new Set([...config.addressBits, ...Object.keys(config.enable)]).size !== 6 || [...config.addressBits, ...Object.keys(config.enable)].some(n => !(n in inputs))) throw new Error('仅支持 74LS138 式低有效输出');
  } else if (JSON.stringify(config.columnOrder) !== '["00","01","11","10"]' || JSON.stringify(config.cells) !== '[[1,0,0,1],[1,0,0,1]]' || config.highlight !== 'wrap-four' || JSON.stringify(config.variables) !== '["A","B","C"]' || Object.keys(inputs).join() !== 'showCorners') throw new Error('仅支持既有跨边四格卡诺图');
  const d: BuiltinDefinition = { kind, config: structuredClone(config), initialInputs: inputs, outputName: kind === 'mux' ? payload.bindings?.output ?? 'Z' : kind === 'decoder' ? 'Y' : 'F', formula: '', revision: 1, check: 'verified' };
  d.formula = formulaFor(d);
  return d;
}
export function evaluate(d: BuiltinDefinition, inputs: Record<string, number>): ExperimentResult {
  validateInputs(d, inputs);
  if (d.kind === 'mux') {
    const selected = d.config.selectBits.reduce((v: number, n: string) => 2 * v + inputs[n], 0);
    const signal: string = d.config.dataSignals[selected];
    return { selected, output: signal === '0' || signal === '1' ? Number(signal) : signal.startsWith('¬') ? 1 - inputs[signal.slice(1)] : inputs[signal] };
  }
  if (d.kind === 'decoder') {
    const selected = d.config.addressBits.reduce((v: number, n: string) => 2 * v + inputs[n], 0);
    const enabled = Object.entries(d.config.enable).every(([n, v]) => inputs[n] === v);
    return { selected, enabled, outputs: Array.from({ length: 8 }, (_, i) => Number(!enabled || i !== selected)) };
  }
  return { highlighted: inputs.showCorners ? [0, 3, 4, 7] : [], output: undefined };
}
const literal = (n: string, value: number) => value ? n : `¬(${n})`;
export function formulaFor(d: BuiltinDefinition): string {
  if (d.kind === 'kmap') return 'F=¬C';
  if (d.kind === 'mux') return d.outputName + '=' + d.config.dataSignals.map((n: string, i: number) =>
    [...d.config.selectBits.map((s: string, j: number) => literal(s, (i >> (d.config.selectBits.length - 1 - j)) & 1)), n].join('·')).join('+');
  return Array.from({ length: 8 }, (_, i) => `Y${i}=¬(${[...Object.entries(d.config.enable).map(([n, v]) => literal(n, Number(v))),
    ...d.config.addressBits.map((n: string, j: number) => literal(n, (i >> (2 - j)) & 1))].join('·')})`).join('; ');
}
/** Deliberately small Boolean grammar. No eval, symbolic solver or arbitrary K-map. */
function expression(source: string, names: string[]): (bits: Record<string, number>) => number {
  // Validate indexed atoms BEFORE flattening subscripts: S_{10} is not S1 multiplied by 0.
  for (const atom of source.match(/[A-Za-z]_(?:\{[A-Za-z0-9]+\}|[A-Za-z0-9])/g) ?? []) {
    if (!names.includes(atom.replace(/[_{}]/g, ''))) throw new Error('公式使用了未声明的下标变量');
  }
  let s = source.replace(/\\(?:neg|lnot)\b/g, '¬').replace(/\\(?:left|right|,|;|!|quad|mathrm)/g, '').replace(/\\(?:cdot|land)/g, '·').replace(/\\(?:lor)/g, '+');
  // MathLive's braces and indexed identifiers are normalized without losing variable boundaries.
  for (let i = 0; i < 10; i++) s = s.replace(/\\(?:overline|bar)\{([^{}]*)\}/g, '¬($1)');
  s = s.replace(/_\{([^{}]+)\}/g, '$1').replace(/_/g, '').replace(/[{}]/g, c => c === '{' ? '(' : ')').replace(/\s/g, '');
  const tokens: string[] = []; let offset = 0;
  const ordered = [...names].sort((a, b) => b.length - a.length);
  while (offset < s.length) {
    const c = s[offset];
    const name = ordered.find(n => s.startsWith(n, offset));
    if (name) { tokens.push(name); offset += name.length; }
    else if ('01¬!~+|·*&()'.includes(c)) { tokens.push(c); offset++; }
    else throw new Error('公式超出布尔转换子集');
  }
  let p = 0;
  type Fn = (bits: Record<string, number>) => number;
  const atom = (): Fn => {
    const t = tokens[p++];
    if (['¬', '!', '~'].includes(t)) { const a = atom(); return b => 1 - a(b); }
    if (t === '(') { const a = sum(); if (tokens[p++] !== ')') throw new Error('括号未闭合'); return a; }
    if (t === '0' || t === '1') return () => Number(t);
    if (names.includes(t)) return b => b[t];
    throw new Error('公式尚未完整');
  };
  const product = (): Fn => {
    let a = atom();
    while (p < tokens.length && ![')', '+', '|'].includes(tokens[p])) {
      if (['·', '*', '&'].includes(tokens[p])) p++;
      const previous = a, next = atom(); a = b => previous(b) & next(b);
    }
    return a;
  };
  const sum = (): Fn => {
    let a = product();
    while (['+', '|'].includes(tokens[p])) { p++; const previous = a, next = product(); a = b => previous(b) | next(b); }
    return a;
  };
  const f = sum(); if (p !== tokens.length) throw new Error('公式不能完整转换'); return f;
}
export function assignments(names: string[]): Record<string, number>[] {
  return Array.from({ length: 2 ** names.length }, (_, i) => Object.fromEntries(names.map((n, j) => [n, (i >> j) & 1])));
}
export function convertFormula(d: BuiltinDefinition, formula: string): BuiltinDefinition {
  const next = { ...structuredClone(d), formula, revision: d.revision + 1, check: 'needs-check' as BuiltinDefinition['check'] };
  try {
    const rows = formula.split(';').map(row => row.trim().split('='));
    const names = d.kind === 'kmap' ? ['A', 'B', 'C'] : inputsFor(d);
    const functions = rows.map(row => expression(row.length === 2 ? row[1] : row[0], names));
    const all = assignments(names);
    if (d.kind === 'mux') {
      if (functions.length !== 1) return next;
      if (rows[0].length === 2 && identifier.test(rows[0][0])) next.outputName = rows[0][0];
      const candidates = ['0', '1', ...names, ...names.map(n => `¬${n}`)];
      const signals: string[] = [];
      for (let i = 0; i < d.config.dataSignals.length; i++) {
        const subset = all.filter(b => d.config.selectBits.reduce((v: number, n: string) => v * 2 + b[n], 0) === i);
        const candidate = candidates.find(c => subset.every(b => functions[0](b) === (c === '0' || c === '1' ? Number(c) : c.startsWith('¬') ? 1 - b[c.slice(1)] : b[c])));
        if (!candidate) return next;
        signals.push(candidate);
      }
      next.config.dataSignals = signals;
    } else if (d.kind === 'decoder') {
      if (rows.length !== 8 || rows.some((r, i) => r.length !== 2 || r[0].replace(/[_{}]/g, '') !== `Y${i}`) ||
        all.some(b => functions.some((f, i) => f(b) !== evaluate(d, b).outputs![i]))) return next;
    } else if (functions.length !== 1 || all.some(b => functions[0](b) !== 1 - b.C)) return next;
    next.check = 'verified';
  } catch { /* Preserve every unsupported or incomplete edit, never reuse an old result. */ }
  return next;
}
