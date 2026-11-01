import type { LayoutPlacement } from './layout';

export interface LayoutArrangementChange { before: LayoutPlacement; after: LayoutPlacement }
/** A read basis for one explicit arrangement, never an approval screen for ordinary reading. */
export interface LayoutArrangementPlan {
  basis: string;
  policyVersion: number;
  changes: LayoutArrangementChange[];
}
export interface LayoutArrangementReceipt {
  domain: 'layout-arrangement';
  operationId: string;
  status: 'committed' | 'unchanged';
  changedUnitIds: string[];
  cursor: number;
}
