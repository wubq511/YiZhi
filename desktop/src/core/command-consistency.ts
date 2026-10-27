import { unitBlocks,changedCouplings,linkedExperiment,isBuiltin } from './consistency-links';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CourseGraph, CourseUnit, ReadingBlock } from '../shared';
import type { CommandRead, GroupCommand, GroupHistory, GroupResult } from '../command-api';
import type { ConsistencyBasis, ConsistencyContext, ConsistencyReceipt } from '../consistency-api';
import type { FormalRelations } from './formal-relations';
import type { Sources } from './sources';
import type { BuiltinExperiments } from './builtin-experiments';
import { layoutGraph, saveLayout } from './local-layout';
import { assignments, evaluate, formulaOutputs, convertFormula } from './builtin-model';
import { equal } from '../editor-api';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface ConsistencyPort {
  read(request: CommandRead): ConsistencyContext;
  apply(command: GroupCommand, before: CourseUnit, after: CourseUnit, context: ConsistencyBasis): { changes: GroupHistory['changes']; receipt: ConsistencyReceipt; publish(): void };
  committed?(result: GroupResult): void;
}
export class CommandConsistency implements ConsistencyPort {
  constructor(private db: DatabaseSync, private graph: CourseGraph, private relations: FormalRelations, private experiments: BuiltinExperiments, private sources: Sources) {}
  read(request: CommandRead): ConsistencyContext {
    const unitId = request.unitId ?? 'KU-001', graph = layoutGraph(this.db, this.graph), origin = graph.layout.nodes.find(n => n.unitId === unitId)!;
    const local = [origin, ...graph.layout.nodes.filter(n => n !== origin).sort((a,b) => Math.hypot(a.x-origin.x,a.y-origin.y)-Math.hypot(b.x-origin.x,b.y-origin.y)).slice(0,2)];
    const unit: CourseUnit = JSON.parse(String(this.db.prepare('SELECT payload FROM units WHERE id=?').get(unitId)!.payload));
    return { layout: local.map(n => ({ unitId: n.unitId, x: n.x, y: n.y, width: n.width, version: Number(this.db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(n.unitId)?.version ?? 0) })),
      relations: this.relations.read({ sessionId: request.sessionId, attemptId: request.attemptId }),
      experiments: unitBlocks(unit).filter(isBuiltin).map(b => {
        const definition = this.experiments.formalDefinition(unitId, b.id); return { blockId: b.id, definition, signature: hash(definition) };
      }) };
  }
  apply(command: GroupCommand, before: CourseUnit, after: CourseUnit, context: ConsistencyBasis) {
    if (!this.db.isTransaction) throw new Error('必要一致组缺少事务');
    this.relations.assertBasis({sessionId:command.sessionId,attemptId:command.attemptId,basisId:context.relations.basisId,generation:context.relations.generation});
    const edits = command.bundle ?? {}, changes: GroupHistory['changes'] = [], receipt: ConsistencyReceipt = { layoutUnitIds: [], definitions: [] };
    const publications: Array<() => void> = [];
    const currentLayout = layoutGraph(this.db, this.graph).layout.nodes;
    for (const old of context.layout) {
      const current = currentLayout.find(n => n.unitId === old.unitId)!;
      if (!equal([old.x,old.y,old.width],[current.x,current.y,current.width]) || old.version !== Number(this.db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(old.unitId)?.version ?? 0)) throw new Error('手动布局基线已变化，请重读后整理');
    }
    if (edits.layout && (edits.layout.length > 3 || edits.layout.some(n => !context.layout.some(old => old.unitId === n.unitId)))) throw new Error('整理只能覆盖目标与已读取的两个局部邻居');
    const planned = new Map((edits.experiments ?? []).map(e => [e.blockId,e]));
    if (planned.size !== (edits.experiments?.length ?? 0)) throw new Error('必要实验不能重复提交');
    for(const id of changedCouplings(before,after)) if(!planned.has(id))throw new Error('新增或变更的公式关联／实验缺少完整有限证明组');
    for(const formula of unitBlocks(after).filter(b=>linkedExperiment(b))) {
      const target=unitBlocks(after).find(b=>b.id===linkedExperiment(formula));
      if(!isBuiltin(target)||!context.experiments.some(e=>e.blockId===target!.id))throw new Error('新增实验或公式目标没有可验证的既有实验依据，候选需完整重读');
    }
    const find = (u: CourseUnit, id: string): ReadingBlock | undefined => {
      const walk = (bs: ReadingBlock[]): ReadingBlock | undefined => { for (const b of bs) { if (b.id === id) return b; const found = walk(b.children ?? []); if (found) return found; } }; return walk(u.reading.blocks);
    };
    for (const old of context.experiments) {
      if (hash(this.experiments.formalDefinition(before.id,old.blockId)) !== old.signature) throw new Error('实验正式定义已变化，请重新读取');
      const block = find(after,old.blockId), prior = find(before,old.blockId)!;
      if ((!block || !equal([block.payload.config,block.payload.inputs],[prior.payload.config,prior.payload.inputs])) && !planned.has(old.blockId)) throw new Error('实验配置变化必须连同公式校验作为完整组提交');
      for (const formula of unitBlocks(before).filter(b => linkedExperiment(b) === old.blockId)) if (!equal(find(after,formula.id)?.payload,formula.payload) && !planned.has(old.blockId)) throw new Error('关联公式变化缺少必要实验校验');
    }
    for (const proposal of edits.experiments ?? []) {
      const old = context.experiments.find(e => e.blockId === proposal.blockId), block = find(after,proposal.blockId);
      if (!old || !block) throw new Error('实验对象尚未读取或已删除');
      const citation = this.sources.citations().find(c => c.id === proposal.sourceCitationId);
      if (!citation?.quote || citation.target?.unitId !== before.id) throw new Error('有限计算纠错需要该单元实际保留的来源选文');
      const next = this.experiments.prepareDefinition(before.id,block,proposal.formula);
      if (proposal.formulaBlockId && find(after,proposal.formulaBlockId)?.payload.experimentBlockId !== block.id) throw new Error('公式正文缺少同组实验对应');
      const required = (find(before,block.id)?.payload.necessaryRelationIds ?? []) as string[];
      if (required.some(id => !edits.relations?.changes.some(c => c.id === id))) throw new Error('缺少直接受影响的正式关系纠正');
      const names = ['I0','I1','I2','I3','S0','S1'];
      if (next.definition.kind !== 'mux' || !equal(Object.keys(next.definition.initialInputs).sort(), [...names].sort())) throw new Error('当前独立校验仅覆盖实际六位4:1 MUX有限域');
      const rows = assignments(names), actual = rows.map(bits => evaluate(next.definition,bits).output), formula = formulaOutputs(proposal.formula,names);
      const expected = rows.map(bits => bits[['I0','I1','I2','I3'][2*bits.S1+bits.S0]]);
      for(const linked of unitBlocks(after).filter(b=>linkedExperiment(b)===block.id)) {
        if(typeof linked.payload.latex!=='string')throw new Error('关联公式正文缺失');
        const display=convertFormula(next.definition,linked.payload.latex);
        if(display.check!=='verified')throw new Error(`关联公式 ${linked.id} 不在支持的布尔语法内；请以当前输出名和精确变量名，使用¬、·、+的完整等式`);
        if(display.outputName!==next.definition.outputName)throw new Error(`关联公式输出名 ${display.outputName} 与实验 ${next.definition.outputName} 不一致`);
        if(!equal(formulaOutputs(linked.payload.latex,names),expected))throw new Error(`关联公式 ${linked.id} 的64组计算不符合来源中的通道索引`);
      }
      if (!equal(actual,expected) || !equal(formula,expected)) throw new Error('独立64组穷举失败：公式／实验与S1高位S0低位的来源语义不一致');
      const previousDefinition = this.experiments.formalDefinition(before.id,block.id);
      publications.push(next.apply());
      receipt.definitions.push({ blockId: block.id, revision: next.definition.revision, proof: { kind: 'four-channel-mux-independent-index-oracle', assignments: 64, digest: hash(expected), sourceCitationId: citation.id } });
      changes.push({ objectId: `experiment:${before.id}/${block.id}`, before: previousDefinition, after: next.definition, beforeVersion: previousDefinition.revision, afterVersion: next.definition.revision });
    }
    if (edits.relations) {
      if (edits.relations.changes.some(c => { const edge = c.value ?? this.relations.graph().edges.find(e => e.id === c.id); return !edge || ![edge.fromUnitId,edge.toUnitId].includes(before.id); })) throw new Error('不能夹带与本单元无直接关系的正式关系');
      const result = this.relations.applyInTransaction({ ...edits.relations, sessionId: command.sessionId, attemptId: command.attemptId, operationId: command.operationId,
        basisId: context.relations.basisId, generation: context.relations.generation });
      receipt.relation = result.receipt; changes.push(...result.changes);
    }
    if (edits.layout?.length) {
      saveLayout(this.db,this.graph,edits.layout);
      for (const next of edits.layout) {
        const old = context.layout.find(n => n.unitId === next.unitId)!;
        if (equal([old.x,old.y,old.width],[next.x,next.y,next.width])) continue;
        receipt.layoutUnitIds.push(next.unitId);
        changes.push({ objectId: `layout:${next.unitId}`, before: { unitId: old.unitId,x:old.x,y:old.y,width:old.width }, after: next,
          beforeVersion: old.version, afterVersion: Number(this.db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(next.unitId)!.version) });
      }
    }
    return { changes, receipt, publish: () => { for (const fn of publications) fn(); } };
  }
}
