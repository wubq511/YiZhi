/** One finite, prebuilt course extension, never an arbitrary program loader. */
export const EXTENSION_VERSIONS = ['1.0.0', '1.1.0', '2.0.0'] as const;
export type ExtensionVersion = typeof EXTENSION_VERSIONS[number];
export interface ExtensionManifest {
  packageId: 'parity-lab'; packageVersion: ExtensionVersion; interfaceVersion: 'extension-api-1';
  inputVersion: 'bits-3-v1' | 'bits-4-v1'; stateVersion: 'parity-state-1' | 'parity-state-2' | 'parity-state-3';
  entry: 'index.html'; sha256: string; license: 'MIT'; inputs: string[]; editableFields: string[];
  resources: { path: string; sha256: string; byteLength: number; mediaType: string; license: 'MIT' }[];
  migratesFrom: string[]; learningResult: string; stepMs: 250;
}
export interface ExtensionState {
  inputs: Record<string, number>; step: number; simulationTime: number; seed: number; output: number;
  ones?: number;
}
export interface ExtensionView {
  id: 'parity-lab'; unitId: 'KU-001'; blockId: 'extension-parity-lab'; instanceId: string; generation: number; revision: number;
  definition: ExtensionManifest; pending?: ExtensionManifest; checked: ExtensionVersion[];
  state: ExtensionState; inputs: Record<string, number>; running: boolean; visible: boolean; background: boolean; gesture: boolean;
  phase: 'needs-check' | 'pausing' | 'paused' | 'running' | 'pause-incomplete' | 'conflict'; error?: string;
}
export interface ExtensionIdentity { instanceId: string; generation: number; definitionVersion: ExtensionVersion }
export type ExtensionAction =
  { kind: 'validate'; version: ExtensionVersion; report: { outputs: string; lifecycle: boolean; migration: boolean } } |
  { kind: 'run'; running: boolean } | {kind:'visibility'; visible:boolean} | {kind:'background'; enabled:boolean} |
  {kind:'inputs'; inputs:Record<string,number>} | {kind:'gesture'; active:boolean} |
  {kind:'confirm'; mode:'step'|'input'|'pause'; baseRevision:number; definitionVersion:ExtensionVersion; state:ExtensionState} |
  {kind:'fail'; error:string} | {kind:'recover'} |
  {kind:'definition';version:ExtensionVersion} | {kind:'upgrade';version:ExtensionVersion;baseRevision:number;state:ExtensionState} |
  {kind:'restart';version:ExtensionVersion;baseRevision:number} | {kind:'migrationFailed';error:string};
export interface ExtensionCommand { sessionId: string; instanceId: string; generation: number; operationId: string; action: ExtensionAction }
export interface ExtensionsAPI {
  open(input: {sessionId: string}): Promise<ExtensionView>;
  read(input: {sessionId: string}): Promise<ExtensionView>;
  act(input: ExtensionCommand): Promise<ExtensionView>;
  /** Host-only registered immutable bytes; deliberately absent from the preload. */
  resource(input: {sessionId: string; version: ExtensionVersion; path: string}): Promise<{bytes: Uint8Array; mediaType: string}>;
}
export function extensionsClient(invoke: (action: string, payload: any) => Promise<any>): ExtensionsAPI {
  return Object.fromEntries(['open', 'read', 'act', 'resource'].map(m => [m, (p: any) => invoke(`extensions:${m}`, p)])) as unknown as ExtensionsAPI;
}
/** An independent finite truth oracle, from odd population counts of the ordered binary minterms. */
export const PARITY_ORACLES: Record<ExtensionVersion, string> = { '1.0.0': '01101001', '1.1.0': '01101001', '2.0.0': '0110100110010110' };
