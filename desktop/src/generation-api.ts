import type { AgentIdentity } from './agent-mutation-api';
import type { GroupResult } from './command-api';

/** One bounded source-backed topic. The unit/theme identities belong to the request, not the model. */
export interface GenerationSpec {
  unitId: string; themeId: string; themeName: string;
  sourceVersionId: string; artifactId: string; pdfPageIndex: number;
}
export interface FiniteExample {
  problem: string; steps?: string; hint?: string; answer: string;
  inputs: Record<'S1'|'S0'|'I0'|'I1'|'I2'|'I3', number>; output: number;
}
export type EvidenceIds = Record<'enable'|'selection'|'formula'|'example'|'exercise', string[]>;
export interface LessonProposal {
  operationId: string; basisId: string; stage: 'lesson' | 'practice';
  title?: string; outcome?: string; intro?: string; derivation?: string; formula?: string;
  example?: FiniteExample; exercise?: FiniteExample; evidence: EvidenceIds;
}
export interface GenerationCheck { layer: 'structure'|'identity'|'reference'|'version'|'course'|'source-meaning'|'finite'|'experiment';
  status: 'passed'|'failed'|'unknown'|'not-applicable'; detail: string }
export interface GenerationResult extends GroupResult { stage: LessonProposal['stage']; checks: GenerationCheck[] }
export interface GenerationContext {
  basisId: string; spec: GenerationSpec; source: {sourceId:string;versionId:string;sha256:string};
  artifact: {artifactId:string;digest:string;pdfPageIndex:number;coordinateSpace:string;structureRole:string|null;view:number[]};
  target: {formalRevision:number|null;studentDraftVersion:number;generation:number};
  sourceText: Array<{id:string;text:string;bounds:number[]}>;
  sourceTable: Array<{select:string;data:string;output:number;evidenceIds:string[]}>;
  evidenceIds: EvidenceIds; completedStages: Array<{stage:'lesson'|'practice';operationId:string;receipt:GenerationResult}>;
  pendingStages: Array<'lesson'|'practice'>; retained: Array<{operationId:string;stage:'lesson'|'practice';reason:string;proposal:LessonProposal;checks:GenerationCheck[]}>;
}
export type GenerationRequest = AgentIdentity & {input:LessonProposal};
export interface GenerationCandidateView {operationId:string;stage:'lesson'|'practice';reason:string;proposal:LessonProposal;checks:GenerationCheck[];attemptId:string}
