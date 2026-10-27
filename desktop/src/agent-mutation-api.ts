import type { ConsistencyEdits } from './consistency-api';
export type AgentIntent = 'question' | 'modify' | 'add-to-board';
export interface AgentIdentity { sessionId: string; taskId: string; attemptId: string; generation: number }
/** Narrow proposal. The Core compiles it against the immutable read basis into editor patches. */
export interface AgentMutation {
 operationId: string; basisId: string; conclusionOrMethodChanged: boolean;
 updates?: {blockId:string;text?:string;latex?:string}[];
 remove?: string[]; moves?: {blockId:string;beforeId?:string}[];
 copies?: {blockId:string;beforeId?:string}[];
 insert?: {kind:'paragraph'|'formula';text?:string;latex?:string;beforeId?:string}[];
 layout?: ConsistencyEdits['layout']; relations?: ConsistencyEdits['relations'];
 experiments?: Array<NonNullable<ConsistencyEdits['experiments']>[number] & {
   config: {dataSignals:string[];selectBits:string[]}; inputNames?:string[];
 }>;
}
