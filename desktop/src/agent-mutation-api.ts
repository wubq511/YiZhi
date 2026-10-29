import type { ConsistencyEdits } from './consistency-api';
export type AgentIntent = 'question' | 'modify' | 'add-to-board' | 'generate';
export interface AgentIdentity { sessionId: string; taskId: string; attemptId: string; generation: number }
/** Narrow proposal. The Core compiles it against the immutable read basis into editor patches. */
export interface AgentMutation {
 operationId: string; basisId: string; conclusionOrMethodChanged: boolean;
 replaces?: string[];
 updates?: {blockId:string;text?:string;latex?:string}[];
 remove?: string[]; moves?: {blockId:string;beforeId?:string}[];
 copies?: {blockId:string;beforeId?:string}[];
 insert?: {kind:'paragraph'|'formula';text?:string;latex?:string;beforeId?:string}[];
 layout?: ConsistencyEdits['layout']; relations?: {changes: Array<{id:string;value:string;citationIds:string[]}>};
 experiments?: Array<NonNullable<ConsistencyEdits['experiments']>[number] & {
   config: {dataSignals:string[];selectBits:string[]}; inputNames?:string[];
 }>;
}

export type AgentMutationContext = Omit<import('./command-api').CommandBasis,'context'> & {
 context: { layout: import('./consistency-api').ConsistencyContext['layout']; experiments: import('./consistency-api').ConsistencyContext['experiments']; relations: {graph: Pick<import('./shared').CourseGraph,'edges'>;sources:import('./relation-api').RelationSource[]} };
 unitId: string; content: import('./shared').CourseUnit; submittedTarget: import('./agent-api').QuestionSnapshot['target'];
 concurrentChanges: import('./agent-api').AgentDelivery[];
 pendingGroups: Array<{ candidateId: string; status: import('./command-api').CandidateCheck['status']; reason?: string;
   proposal: Pick<import('./command-api').GroupCommand, 'changes' | 'patch' | 'bundle'> }>;
 capabilities: {updates:string;structure:string;layout:string;experiment:string};
};
