function snapshot() {
  const out={versions:process.versions,processType:process.type,openedDatabase:false};
  try {
    const sqlite=require('node:sqlite');
    out.sqlite={requireSucceeded:true,exports:Object.keys(sqlite),Database:typeof sqlite.Database,DatabaseSync:typeof sqlite.DatabaseSync};
  } catch(e) {out.sqlite={requireSucceeded:false,error:String(e),code:e.code};}
  return out;
}
if(process.parentPort){process.parentPort.postMessage(snapshot());setTimeout(()=>process.exit(0),30);}
else module.exports=snapshot;
