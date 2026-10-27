/** Finite, trusted built-ins only. Generated packages use their own runtime (T13). */
export type BuiltinKind = 'mux' | 'decoder' | 'kmap';
export interface BuiltinDefinition {
  kind: BuiltinKind; config: Record<string, any>; initialInputs: Record<string, number>;
  outputName: string; formula: string; revision: number; check: 'verified' | 'needs-check';
}
export interface ExperimentState {
  inputs: Record<string, number>; simulationTime: number; step: number; seed: number;
}
export interface ExperimentResult { output?: number; selected?: number; enabled?: boolean; outputs?: number[]; highlighted?: number[] }
export interface ExperimentView {
  instanceId: string; unitId: string; blockId: string; generation: number; version: number;
  formulaScope?: 'independent'|'consistency-group';
  pendingDefinition?: BuiltinDefinition; gesture?: boolean; migrationError?: string; definition: BuiltinDefinition; state: ExperimentState; result: ExperimentResult | null;
  running: boolean; background: boolean; visible: boolean;
  phase: 'running' | 'paused' | 'needs-check' | 'pause-incomplete'; error?: string;
}
/** Complete serializable model state; no DOM, heap, wall-clock deadline or unconfirmed output. */
export interface ConfirmedExperimentSnapshot {
  schemaVersion: 'builtin-state-1'; instanceId: string; definitionRevision: number;
  state: ExperimentState;
}
export type ExperimentAction =
  { kind: 'gesture'; active: boolean } | { kind: 'migrate' | 'restart'; baseVersion: number } |
  { kind: 'inputs'; inputs: Record<string, number> } |
  { kind: 'formula'; formula: string; baseRevision: number } |
  { kind: 'run'; running: boolean } | { kind: 'background'; enabled: boolean } |
  { kind: 'visibility'; visible: boolean } | { kind: 'pause' } | { kind: 'recover' };
export interface ExperimentCommand {
  sessionId: string; instanceId: string; generation: number; operationId: string; action: ExperimentAction;
}
/** Lifecycle boundary: open initializes; run resumes/pauses; visibility pauses without
 * changing the student's running intent; snapshot returns only FULL SQLite-confirmed
 * state. pauseAll drains the close barrier; host close disposes the trusted timers.
 * These methods never execute generated code. */
export interface ExperimentsAPI {
  open(input: { sessionId: string; unitId: string; blockId: string }): Promise<ExperimentView>;
  read(input: { sessionId: string; instanceId: string }): Promise<ExperimentView>;
  snapshot(input: { sessionId: string; instanceId: string }): Promise<ConfirmedExperimentSnapshot>;
  act(command: ExperimentCommand): Promise<ExperimentView>;
  pauseAll(input: { sessionId: string }): Promise<ExperimentView[]>;
}
export function experimentsClient(invoke: (action: string, payload: any) => Promise<any>): ExperimentsAPI {
  return Object.fromEntries(['open', 'read', 'snapshot', 'act', 'pauseAll'].map(method =>
    [method, (payload: any) => invoke(`experiments:${method}`, payload)])) as unknown as ExperimentsAPI;
}
