/** Controlled timing only; never a successful database or resource substitute. */
export interface MigrationScheduling { beforeRegistration?: SharedArrayBuffer }
export interface MigrationTarget { sourceDirectory: string; directory: string }
export interface MigrationReport {
  schema: 'yizhi-content-candidate-1'; scope: 'content-candidate'; sourceDirectory: string;
  counts: { themes: number; units: number; answerableQuestions: number; questionRecords: number; mappings: number; relations: number };
  sourceHashes: Record<string, string>; unitHashes: Record<string, string>;
  resources: Array<{ asset: string; path: string; sha256: string; byteLength: number; mediaType: string }>;
  gaps: string[]; differences: string[];
}
export interface LegacyContent { manifest: Record<string, any>; knowledge: Record<string, any>; layout: Record<string, any>; report: MigrationReport;retention?:{originalUnitBodies:'expired';expiredAt:string;registeredAt:string} }
export function migrationClient(invoke: (action: string, payload: any) => Promise<any>) {
  return {
    prepare:(request:{sourceDirectory:string;contentCandidateDirectory:string;directory:string;operationId:string}):Promise<import('./core/directory-authority').DirectoryDecision>=>invoke('migration:prepare',request),
    publish:(request:{sourceDirectory:string;operationId:string}):Promise<import('./core/directory-authority').DirectoryDecision>=>invoke('migration:publish',request),
    status:(request:{directory:string}):Promise<import('./core/directory-authority').DirectoryDecision|null>=>invoke('migration:status',request),
    recover:(request:{directory:string}):Promise<{directory:string;decision:import('./core/directory-authority').DirectoryDecision|null}>=>invoke('migration:recover',request),
    personal: (request: {sessionId:string;sourceDirectory:string}): Promise<any> => invoke('migration:personal', request),
    snapshot: (request: MigrationTarget): Promise<{ directory: string; files: Record<string, string> }> => invoke('migration:snapshot', request),
    convert: (request: MigrationTarget): Promise<MigrationReport> => invoke('migration:convert', request),
    content: (request: { sessionId: string }): Promise<LegacyContent> => invoke('migration:content', request),
    resource: (request: { sessionId: string; asset: string }): Promise<{ bytes: Uint8Array; mediaType: string }> => invoke('migration:resource', request),
  };
}
