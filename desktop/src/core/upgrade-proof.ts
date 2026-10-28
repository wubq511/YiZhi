import { parentPort,workerData } from 'node:worker_threads';
import { beginVerifiedDirectory,prepareVerifiedDirectory,abandonVerifiedDirectory,publishVerifiedDirectory,recoverDirectory,type DirectoryPublicationLease } from './directory-authority';
import { nativeSourceVersion } from './native-upgrade-source';
import './migration-state';
import { registerRetentionResourceRoot } from './retention-resources';
import { generationRetentionResourceRoot,generationRetentionResourceRoots } from './generation-retention';
registerRetentionResourceRoot('t30-generation-recovery',generationRetentionResourceRoot,generationRetentionResourceRoots);
const {action,decision,held}=workerData;
if(action==='cancel')decision.sourceVersion={...decision.sourceVersion,...nativeSourceVersion(decision.sourceDirectory)};
const lease:DirectoryPublicationLease={
 assertHeld(){
  if(Atomics.load(new Int32Array(held),0)!==1)throw new Error('升级停写租约已失效');
  const actual=nativeSourceVersion(decision.sourceDirectory);
  for(const key of ['courseId','generation','sequence','courseFormat','dataDigest'] as const)if(actual[key]!==decision.sourceVersion[key])throw new Error('升级停写后源版本发生变化: '+key);
 },async close(){Atomics.store(new Int32Array(held),0,0);},
};
void(async()=>{try{const result=action==='sourceVersion'?nativeSourceVersion(workerData.directory):action==='recover'?recoverDirectory(workerData.directory):action==='begin'?await beginVerifiedDirectory(decision,lease):action==='prepare'?await prepareVerifiedDirectory(decision,lease):action==='publish'?await publishVerifiedDirectory(decision,lease,workerData.cutoverScheduling):action==='cancel'?await abandonVerifiedDirectory({sourceDirectory:decision.sourceDirectory,operationId:decision.operationId},lease):(()=>{throw new Error('未知升级核验动作');})();parentPort!.postMessage({ok:true,result});}catch(e){parentPort!.postMessage({ok:false,error:(e as Error).message});}})();
