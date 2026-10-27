import type { LayoutPlacement } from './layout';
import type { RelationBasis, RelationCommand, RelationReceipt } from './relation-api';
import type { BuiltinDefinition } from './experiments-api';
export interface ConsistencyContext {
  layout: Array<LayoutPlacement & { version: number }>;
  relations: RelationBasis;
  experiments: Array<{ blockId: string; definition: BuiltinDefinition; signature: string }>;
}
export interface ConsistencyEdits {
  layout?: LayoutPlacement[];
  relations?: Pick<RelationCommand, 'changes' | 'groupChanges'>;
  experiments?: Array<{ blockId: string; formula: string; formulaBlockId?: string; sourceCitationId: string }>;
}
export interface ConsistencyReceipt {
  layoutUnitIds: string[];
  relation?: RelationReceipt;
  definitions: Array<{ blockId: string; revision: number; proof: { kind: string; assignments: number; digest: string; sourceCitationId: string } }>;
}
