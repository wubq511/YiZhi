import {fileURLToPath} from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { developmentDirectory } from './paths.mjs';
const require = createRequire(import.meta.url);
const output = developmentDirectory(fileURLToPath(new URL('../..', import.meta.url)));
const {DevelopmentCourseService:CourseService}=require(join(output,'course-service.cjs'));
const [action, source, destination] = process.argv.slice(2);
if (!['snapshot','convert','verify'].includes(action) || !source || (action !== 'verify' && !destination)) {
  console.error('Usage: node tools/desktop/verify-conversion.mjs snapshot|convert SOURCE NEW_DIRECTORY\n       node tools/desktop/verify-conversion.mjs verify CANDIDATE');
  process.exit(2);
}
const core = new CourseService(join(output,'worker.cjs'));
try {
  if (action === 'verify') {
    const opened=await core.open(resolve(source)),content=await core.migration.content({sessionId:opened.sessionId}),graph=await core.graph(opened.sessionId);
    for (const original of content.knowledge.units) {
      const stored=await core.readUnit(opened.sessionId,original.id);
      const { theme, ...raw } = stored;
      if (JSON.stringify(raw) !== JSON.stringify(Object.fromEntries(Object.entries(original).filter(([k])=>k!=='theme')))) throw new Error('Persisted content differs: '+original.id);
    }
    for(const item of content.report.resources){const bytes=await readFile(join(resolve(source),item.path));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Resource differs: '+item.asset);}
    const sources=await core.sources.list({sessionId:opened.sessionId});
    for(const version of sources.versions)await core.sources.page({sessionId:opened.sessionId,versionId:version.versionId,pdfPageIndex:0});
    console.log(JSON.stringify({scope:'content-candidate',counts:content.report.counts,readUnits:graph.nodes.length,verifiedResources:content.report.resources.length,readSourceVersions:sources.versions.length,runtime:opened.runtime},null,2));
  } else console.log(JSON.stringify(await core.migration[action]({sourceDirectory:resolve(source),directory:resolve(destination)}),null,2));
} finally { await core.close(); }
