import { equal } from './editor-api';

/** A conservative single changed range, measured in Unicode code points. */
export function textRange(before: string, after: string) {
  const a = Array.from(before), b = Array.from(after);
  let start = 0, end = a.length, tail = b.length;
  while (start < end && start < tail && a[start] === b[start]) start++;
  while (end > start && tail > start && a[end - 1] === b[tail - 1]) { end--; tail--; }
  return { start, end, text: b.slice(start, tail).join('') };
}
/** Only provably independent text ranges/fields merge. Ambiguity keeps both versions. */
export function integrateValue(before: any, student: any, incoming: any): { value: any; compatible: boolean } {
  if (equal(before, student)) return { value: incoming, compatible: true };
  if (equal(before, incoming) || equal(student, incoming)) return { value: student, compatible: true };
  if (typeof before === 'string' && typeof student === 'string' && typeof incoming === 'string') {
    const a = textRange(before, student), b = textRange(before, incoming);
    if (a.end < b.start || b.end < a.start || (a.end === b.start && a.start !== a.end) || (b.end === a.start && b.start !== b.end)) {
      const points = Array.from(before);
      for (const r of [a, b].sort((x, y) => y.start - x.start)) points.splice(r.start, r.end - r.start, ...Array.from(r.text));
      return { value: points.join(''), compatible: true };
    }
  }
  if (before && student && incoming && typeof before === 'object' && !Array.isArray(before) &&
    typeof student === 'object' && !Array.isArray(student) && typeof incoming === 'object' && !Array.isArray(incoming)) {
    const value: Record<string, any> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(student), ...Object.keys(incoming)])) {
      const part = integrateValue(before[key], student[key], incoming[key]);
      if (!part.compatible) return { value: student, compatible: false };
      if (part.value !== undefined) value[key] = part.value;
    }
    return { value, compatible: true };
  }
  return { value: student, compatible: false };
}
