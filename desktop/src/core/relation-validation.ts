import type { CourseGraph } from '../shared';
import type { RelationCommand, RelationSource } from '../relation-api';
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 20000;
const identity = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9_-]{0,180}$`).test(value);
export function validateRelationCommand(command: RelationCommand) {
  if (!record(command) || !text(command.operationId) || command.operationId.length > 200 || !text(command.basisId) ||
    !Number.isSafeInteger(command.generation) || !Array.isArray(command.changes) || command.changes.length > 500 ||
    (command.groupChanges !== undefined && (!Array.isArray(command.groupChanges) || command.groupChanges.length > 500)) ||
    JSON.stringify(command).length > 2_000_000) throw new Error('无效的正式关系操作身份或修改范围');
  for (const [changes, prefix] of [[command.changes, 'REL-'], [command.groupChanges ?? [], 'G']] as const) {
    const seen = new Set<string>();
    for (const change of changes) {
      if (!record(change) || !identity(change.id, prefix) || (change.value !== null && (!record(change.value) || change.value.id !== change.id)))
        throw new Error('正式关系或路线组身份无效');
      if (seen.has(change.id)) throw new Error('同一修改不能重复身份');
      seen.add(change.id);
    }
  }
}
export function validateRelationGraph(graph: CourseGraph, sources: RelationSource[], retired: string[]) {
  const active = new Set(graph.nodes.map(node => node.id));
  const endpoint = (id: string) => { if (!active.has(id) || retired.includes(id)) throw new Error('正式关系端点必须是有效且未退休的知识单元'); };
  const refs = (references: any) => {
    if (!Array.isArray(references) || !references.length || references.length > 100) throw new Error('正式关系需要有效来源与定位');
    for (const reference of references) {
      if (!record(reference)) throw new Error('正式关系来源无效');
      const source = sources.find(s => s.id === reference.sourceId), version = source?.versions.find(v => v.id === reference.versionId);
      if (!version) throw new Error('正式关系来源或固定版本无效');
      if (version.totalPages) {
        if (!Array.isArray(reference.pdfPages) || !reference.pdfPages.length || reference.pdfPages.some((p: number) => !Number.isSafeInteger(p) || p < 1 || p > version.totalPages!))
          throw new Error('正式关系来源页码无效');
      } else if (!text(reference.section)) throw new Error('非 PDF 来源需要有效章节定位');
    }
  };
  const edgeIds = new Set<string>(), facts = new Set<string>();
  for (const edge of graph.edges) {
    if (!identity(edge.id, 'REL-') || edgeIds.has(edge.id)) throw new Error('正式关系身份无效或重复');
    edgeIds.add(edge.id); endpoint(edge.fromUnitId); endpoint(edge.toUnitId);
    if (edge.fromUnitId === edge.toUnitId) throw new Error('正式关系不能形成自环');
    if (('status' in edge && edge.status !== 'approved') || !['requires', 'constructs', 'improves', 'inverse'].includes(edge.type) || typeof edge.directed !== 'boolean' ||
      edge.directed !== (edge.type !== 'inverse') || !['main', 'auxiliary'].includes(edge.view) || !text(edge.value))
      throw new Error('正式关系需要有效含义、方向、具体信息价值和主／辅助显示');
    refs(edge.sourceRefs);
    const endpoints = edge.directed ? [edge.fromUnitId, edge.toUnitId] : [edge.fromUnitId, edge.toUnitId].sort();
    const fact = `${endpoints.join(':')}:${edge.type}`;
    if (facts.has(fact)) throw new Error('不能用新身份重复同一正式关系');
    facts.add(fact);
    if (edge.requirementGroupId !== undefined && (edge.type !== 'requires' || !identity(edge.requirementGroupId, 'G')))
      throw new Error('只有前置关系可以进入有效路线组');
  }
  const grouped = new Set<string>(), groupIds = new Set<string>();
  for (const group of graph.requirementGroups) {
    if (!identity(group.id, 'G') || groupIds.has(group.id)) throw new Error('路线组身份无效或重复');
    groupIds.add(group.id); endpoint(group.targetUnitId);
    if (!['all', 'any'].includes(group.mode) || !text(group.value) || !Array.isArray(group.unitIds) || !Array.isArray(group.relationIds) ||
      !group.unitIds.length || group.unitIds.length !== group.relationIds.length || new Set(group.unitIds).size !== group.unitIds.length ||
      new Set(group.relationIds).size !== group.relationIds.length) throw new Error('路线组必须保留明确的 AND／OR 语义和完整成员');
    refs(group.sourceRefs);
    for (const unitId of group.unitIds) endpoint(unitId);
    const members = graph.edges.filter(e => e.requirementGroupId === group.id);
    if (members.length !== group.relationIds.length || members.some(e => e.type !== 'requires' || e.toUnitId !== group.targetUnitId ||
      !group.unitIds.includes(e.fromUnitId) || !group.relationIds.includes(e.id))) throw new Error('路线组与前置关系成员必须共同修改，不能留下悬空引用');
    for (const edge of members) grouped.add(edge.id);
  }
  if (graph.edges.some(e => e.requirementGroupId && !grouped.has(e.id))) throw new Error('前置关系不能引用不存在的路线组');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('前置关系不能形成环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of graph.edges) if (edge.type === 'requires' && edge.fromUnitId === id) visit(edge.toUnitId);
    visiting.delete(id); visited.add(id);
  };
  for (const id of active) visit(id);
}
