'use strict';
// Static-only gate: compiles source, reads fixtures/hashes. No SQLite import,
// fixture replication, benchmark execution, Electron launch, or timing/RSS probe.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const plan = require('./plan.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function staticCheck(write = true) {
  const files = fs.readdirSync(__dirname).filter(n => n.endsWith('.cjs')).sort();
  const codeHashes = {};
  for (const name of files) {
    const bytes=fs.readFileSync(path.join(__dirname,name));
    new vm.Script(bytes.toString(),{filename:name}); codeHashes[name]=sha(bytes);
  }
  const helper='phys-footprint.py',helperBytes=fs.readFileSync(path.join(__dirname,helper));
  // Parse only: do not import/execute ctypes or call the measurement helper.
  execFileSync('python3',['-B','-c','import ast,sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])',helper],
    {input:helperBytes,stdio:['pipe','pipe','pipe']});
  codeHashes[helper]=sha(helperBytes);
  const fixture = JSON.parse(fs.readFileSync(plan.fixture,'utf8'));
  assert.equal(fixture.units.length,84);
  assert(fixture.units.every(u => u.id && Array.isArray(u.reading.blocks)));
  assert.equal(plan.rounds.length,3);
  for (const order of plan.rounds) assert.deepEqual([...order].sort(),['host','utility','worker']);
  const inputHashes = Object.fromEntries(plan.inputs.map(relative => [relative,sha(fs.readFileSync(path.resolve(__dirname,relative)))]));
  const result = {status:'prepared-not-run',checkedAt:new Date().toISOString(),
    staticParserNode:process.version,embeddedRuntimeValidated:false,sqliteExecuted:false,
    electronLaunched:false,timingOrResourceLoadRun:false,
    checks:['CJS syntax only','Python helper AST syntax only','84-unit fixture structure','three fixed carrier orders','read-only source hashes'],
    codeHashes,inputHashes,plan};
  if(write)fs.writeFileSync(path.join(__dirname,'preparation.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
if(require.main===module) console.log(JSON.stringify(staticCheck(),null,2));
module.exports={staticCheck};
