import {workerData} from 'node:worker_threads';
import {realpathSync} from 'node:fs';
import {startCourseWorker} from '../../desktop/src/core/worker-runtime';
import {readCourseResource} from '../../desktop/src/core/course-resources';
import {prepareDirectory,publishDirectory,abandonDirectory,directoryTransition,directoryStatus,recoverDirectory,closeDirectoryLeases} from './migration-directory';
import {importPersonal,importPersonalRecords} from './migration-personal';
import {migratedHistory,migratedOperation} from './migration-history';
import {migrationRecords} from './migration-state';
import {snapshotLegacy,convertLegacy,legacyContent} from './migration';
startCourseWorker({accepts:action=>action.startsWith('migration:'),parallel:action=>['migration:prepare','migration:publish','migration:convert','migration:snapshot'].includes(action),close:closeDirectoryLeases,async dispatch(action,payload,{session,open,courses,releaseCourse}){let value:unknown;
    if(action==='migration:prepare')value=await prepareDirectory(payload,async(directory,source)=>{
      const opened=open(directory,true),key=realpathSync(directory),course=courses.get(key)!;
      try{return importPersonalRecords(course.db,source);}
      finally{await releaseCourse(key,course);}
    });
    else if(action==='migration:publish')value=await publishDirectory(payload,workerData?.cutoverScheduling);
    else if(action==='migration:abandon')value=await abandonDirectory(payload);
    else if(action==='migration:transition')value=directoryTransition(payload);
    else if(action==='migration:status')value=directoryStatus(payload.directory);
    else if(action==='migration:recover')value=recoverDirectory(payload.directory);
    else if(action==='migration:history')value=migratedHistory(session(payload.sessionId,action).db,payload);
    else if(action==='migration:operation')value=migratedOperation(session(payload.sessionId,action).db,payload.operationId);
    else if(action==='migration:pending'){const db=session(payload.sessionId,action).db;value=db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_pending'").get()?db.prepare('SELECT * FROM migration_pending ORDER BY id').all().map(r=>({id:r.id,namespace:r.namespace,key:r.record_key,purpose:r.purpose,state:r.state,payload:r.payload?JSON.parse(String(r.payload)):null,createdAt:r.created_at})):[];}
    else if (action === 'migration:records')value=migrationRecords(session(payload.sessionId,action).db,payload);
    else if (action === 'migration:personal') value=await importPersonal(session(payload.sessionId,action).db,payload.sourceDirectory);
    else if (action === 'migration:snapshot') value = await snapshotLegacy(payload);
    else if (action === 'migration:convert') value = await convertLegacy(payload, workerData?.migrationScheduling);
    else if (action === 'migration:content') value = legacyContent(session(payload.sessionId,action).db);
    else if (action === 'migration:resource') { const c=session(payload.sessionId,action); const directory=[...courses.entries()].find(([,v])=>v===c)![0]; value=readCourseResource(c.db,directory,payload.asset); }
    else throw new Error('未知开发迁入命令');return value;
}});
