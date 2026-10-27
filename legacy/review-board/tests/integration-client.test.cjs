const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/integration.js'),'utf8');

function mount({drafts={},generation=7,semanticRevision=3,dropFirst=true}={}) {
  const posted=[],documents={semanticChanges:{'KU-055':{value:null,revision:semanticRevision}}};
  const persistence={generation,documents,entries:ns=>ns==='editingDrafts'?Object.entries(drafts):[],
    read:(ns,key)=>documents[ns]?.[key]||{value:null,revision:0},
    put:(ns,key,value)=>{if(ns==='editingDrafts')drafts[key]=structuredClone(value);},
    addEventListener(){},notify(){}};
  const board={persistence,getState:()=>({selected:'KU-055'}),refreshContent:async()=>{},toast(){},flush:async()=>{}};
  let ready;
  const root={style:{setProperty(){}},getBoundingClientRect:()=>({height:45})};
  const viewport={style:{setProperty(){}},getBoundingClientRect:()=>({left:200,width:800})};
  const document={querySelector:selector=>selector==='#viewport'?viewport:root,
    querySelectorAll:()=>[],getElementById:()=>root,addEventListener(){}};
  const window={ReviewBoard:board,addEventListener:(name,callback)=>{if(name==='review-board-ready')ready=callback;}};
  const fetch=async(path,options)=>{
    if(!options?.method)return {ok:false,json:async()=>({error:{code:'not_found',message:'new entity'}})};
    const body=JSON.parse(options.body);posted.push(body);
    if(dropFirst&&posted.length===1)throw new Error('acknowledgement lost after commit');
    return {ok:true,json:async()=>({saved:true,operationId:body.operationId,generation:body.generation,changes:[]})};
  };
  class Observer{observe(){}}
  vm.runInNewContext(source,{window,document,fetch,structuredClone,crypto,ResizeObserver:Observer,MutationObserver:Observer});
  ready();return {board,persistence,posted,drafts};
}

test('relation lost acknowledgement retries the same identity and original generation',async()=>{
  const command={operationId:'OP-relation',generation:7,kind:'relation.create',
    relation:{fromUnitId:'KU-055',toUnitId:'KU-056',type:'constructs',value:'choice',sourceRefs:[]},
    expectedEntities:{'KU-055':{hash:'a'},'KU-056':{hash:'b'}}};
  const f=mount({drafts:{'pending:relation':{draft:structuredClone(command)}}});
  await assert.rejects(f.board.applyContent(command),/acknowledgement lost/);
  f.persistence.generation=9;
  await f.board.applyContent(command);
  assert.deepEqual(f.posted[1],f.posted[0]);
  assert.equal(f.posted[1].generation,7);
  assert.deepEqual(f.drafts['pending:relation'].draft,f.posted[0]);
});

test('formula acknowledgement loss survives reopen and later semantic revision without changing payload',async()=>{
  const command={operationId:'OP-formula',generation:7,actor:'student',kind:'knowledge.update',
    changes:[{namespace:'knowledge',key:'KU-055',value:{id:'KU-055'}}],
    expectedRevisions:{'knowledge:KU-055':4},expectedEntityHashes:{'KU-055':'original'},
    semanticImpact:{status:'needs-review',blockIds:['interactive']}};
  const first=mount({drafts:{'pending:block':{draft:structuredClone(command)}}});
  await assert.rejects(first.board.applyContent(command),/acknowledgement lost/);
  const reopened=mount({drafts:structuredClone(first.drafts),generation:9,semanticRevision:20,dropFirst:false});
  await reopened.board.applyContent(reopened.drafts['pending:block'].draft);
  assert.deepEqual(reopened.posted[0],first.posted[0]);
  assert.equal(reopened.posted[0].expectedRevisions['semanticChanges:KU-055'],3);
});

test('search result presentation keeps stable targets while removing internal display noise',()=>{
  const window={COURSE_DATA:{units:[{id:'KU-001',themeId:'TH-01'}]}},document={getElementById:()=>null};
  const client=fs.readFileSync(require('node:path').join(__dirname,'../web/content/source-search.js'),'utf8');
  vm.runInNewContext(client,{window,document,URLSearchParams,fetch});
  const container={innerHTML:''},unit={scope:'knowledge',entityType:'unit',id:'KU-055',name:'MUX 功能与 2:1/4:1 表达式',version:'8a63f6daeb7962be5ab52a10f070a79b2de16de6ece676982ba4ce9daf928759'};
  window.ReviewSourceTools.renderSearchResults(container,{query:'MUX',scopes:['knowledge'],sourceWarnings:[],items:[
    {...unit,snippet:'KU-055 TH-13 concept MUX 功能与 2:1/4:1 表达式 复用器 MUX 选择数据',location:{unitId:'KU-055'}},
    {...unit,snippet:'mux S1 RB-KU-055-formula-4 dataSignals Y',location:{unitId:'KU-055',blockId:'RB-KU-055-diagram'}},
    {scope:'knowledge',entityType:'theme',id:'TH-01',name:'复用器',snippet:'MUX',version:'hash',location:{themeId:'TH-01'}},
  ]});
  assert.match(container.innerHTML,/data-focus="KU-055"/);
  assert.match(container.innerHTML,/data-search-block="RB-KU-055-diagram"/);
  assert.match(container.innerHTML,/data-focus="KU-001"/);
  assert.match(container.innerHTML,/复用器 <mark>MUX<\/mark> 选择数据/);
  assert.doesNotMatch(container.innerHTML,/TH-13 concept|dataSignals|8a63f6/);
});
