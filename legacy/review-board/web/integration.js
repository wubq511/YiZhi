/* Feature modules share this host, the course command boundary and one history. */
(() => {
  'use strict';
  async function json(path, body) {
    const response = await fetch(path, body === undefined ? {cache:'no-store'} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || '操作未完成'),result.error);
    return result;
  }
  function mount() {
    const board = window.ReviewBoard, persistence = board.persistence, subscribers = new Set();
    let undoOperationId=null,redoOperationId=null,refreshing=null;
    const notify = () => subscribers.forEach(listener=>listener());
    const absorb = result => {
      for(const change of result.changes || []) {
        persistence.documents[change.namespace] ||= {};
        if (persistence.read(change.namespace,change.key).revision <= change.revision)
          persistence.documents[change.namespace][change.key]={value:change.value,revision:change.revision};
      }
      if(result.generation)persistence.generation=result.generation;
      if(result.changes?.some(c=>c.namespace==='layout'))board.relayout?.();
      // Do not skip queued events: an HTTP receipt is not an event-stream cursor.
      notify();persistence.notify();
    };
    const getEntity=id=>json('/api/v1/content/'+encodeURIComponent(id));
    function semanticMarkers() {
      for(const notice of document.querySelectorAll('.semantic-warning'))notice.remove();
      for(const [unitId,value] of persistence.entries('semanticChanges')) {
        if(value?.status!=='needs-review')continue;
        const article=document.getElementById(unitId);if(!article)continue;
        const warning=document.createElement('p');warning.className='semantic-warning';
        warning.textContent='相关公式或图示已编辑，下面的探索结果需要核对：'+(value.reason||'尚未重新确认绑定语义。');
        article.querySelector('.unit-content')?.prepend(warning);
        for(const blockId of value.blockIds||[]) {
          const block=[...article.querySelectorAll('[data-block-id],details[id]')].find(el=>(el.dataset.blockId||el.id)===blockId);
          if(block)block.dataset.semanticStatus='needs-review';
        }
      }
    }
    async function refreshContent() {
      if(refreshing)return refreshing;
      refreshing=board.refreshContent().then(()=>{semanticMarkers();notify();}).finally(()=>{refreshing=null;});
      return refreshing;
    }
    async function applyContent(input) {
      let command=structuredClone(input);
      if(command.kind==='relation.create') {
        const relation={...command.relation,id:'REL-'+crypto.randomUUID(),status:'approved'};
        if(relation.route)relation.value+='\n路线说明：'+relation.route;
        delete relation.route;
        const generation=command.generation,record=await getEntity(relation.id).catch(error=>{
          if(error.code!=='not_found')throw error;return {revision:0};});
        command={operationId:command.operationId,actor:'student',kind:'knowledge.relation',generation,
          changes:[{namespace:'knowledge',key:relation.id,value:relation}],
          expectedRevisions:{['knowledge:'+relation.id]:record.revision},
          expectedHashes:Object.fromEntries(Object.entries(command.expectedEntities||{}).map(([id,base])=>['knowledge:'+id,base.hash]))};
        if(relation.requirementGroupId){
          const base=await getEntity(relation.requirementGroupId),group=structuredClone(base.entity);
          if(relation.type!=='requires'||group.targetUnitId!==relation.toUnitId)throw new Error('该前置路线组不属于指定目标单元');
          group.relationIds=[...new Set([...group.relationIds,relation.id])];group.unitIds=[...new Set([...group.unitIds,relation.fromUnitId])];
          command.changes.push({namespace:'knowledge',key:group.id,value:group});
          command.expectedRevisions['knowledge:'+group.id]=base.revision;command.expectedHashes['knowledge:'+group.id]=base.hash;
        }
      }
      if(command.expectedEntityHashes&&!command.expectedHashes)command.expectedHashes=Object.fromEntries(
        Object.entries(command.expectedEntityHashes).map(([id,hash])=>['knowledge:'+id,hash]));
      if(command.semanticImpact) {
        const id=command.changes.find(c=>c.namespace==='knowledge')?.key;
        if(id) {
          const current=persistence.read('semanticChanges',id);
          command.changes.push({namespace:'semanticChanges',key:id,value:command.semanticImpact});
          command.expectedRevisions['semanticChanges:'+id]=current.revision;
        }
        delete command.semanticImpact;
      }
      // The controller retries this same object. Freeze generated identities and
      // revision baselines before the first POST, including its persisted draft.
      for(const key of Object.keys(input))delete input[key];
      Object.assign(input,structuredClone(command));
      for(const [key,value] of persistence.entries('editingDrafts')) {
        if(value?.draft?.operationId===command.operationId)
          persistence.put('editingDrafts',key,{draft:structuredClone(command)});
      }
      const result=await json('/api/v1/commands',command);
      if(result.saved!==true)throw new Error('课程写入尚未确认');
      absorb(result);undoOperationId=result.operationId;redoOperationId=null;
      await refreshContent();return result;
    }
    async function applyPersonal(changes,kind='personal.edit',metadata={}) {
      const command={operationId:metadata.operationId||'OP-'+crypto.randomUUID(),actor:'student',kind,
        generation:persistence.generation,changes,
        expectedRevisions:metadata.expectedRevisions||Object.fromEntries(changes.map(c=>
          [c.namespace+':'+c.key,persistence.read(c.namespace,c.key).revision]))};
      const result=await json('/api/v1/commands',command);
      if(result.saved!==true)throw new Error('个人内容保存尚未确认');
      absorb(result);undoOperationId=result.operationId;redoOperationId=null;return result;
    }
    async function undo(operationId) {
      if(!operationId)throw new Error('没有可以撤回的操作');
      const result=await json('/api/v1/history/undo',{operationId});
      absorb(result);redoOperationId=result.operationId;undoOperationId=null;
      await refreshContent();return result;
    }
    async function redo(operationId) {
      const result=await json('/api/v1/history/undo',{operationId});
      absorb(result);undoOperationId=result.operationId;redoOperationId=null;
      await refreshContent();return result;
    }
    async function showHistory() {
      try {
        const data=await json('/api/v1/history'),versions=data.versions||data;
        const dialog=document.createElement('dialog');dialog.className='history-dialog';
        const heading=document.createElement('h2');heading.textContent='整幅历史版本';
        const copy=document.createElement('p');copy.textContent='恢复所选版本的课程内容与当时个人状态。当前内容会先保存为恢复点；任务执行记录继续保留。撤回某一次修改请使用编辑工具或任务中的“撤回”。';
        const select=document.createElement('select');select.setAttribute('aria-label','要恢复的历史版本');
        for(const v of versions) {const option=document.createElement('option');option.value=v.sequence;option.textContent=`${v.sequence} · ${v.label} · 第 ${v.generation} 代`;select.append(option);}
        const status=document.createElement('p'),restore=document.createElement('button'),close=document.createElement('button');let restoreRequest=null;
        restore.textContent='恢复所选版本';restore.disabled=!versions.length;close.textContent='关闭';
        close.onclick=()=>{dialog.close();dialog.remove();};
        select.onchange=()=>{restoreRequest=null;};
        restore.onclick=async()=>{try{restore.disabled=true;await board.flush();restoreRequest||={sequence:Number(select.value),generation:persistence.generation,operationId:'OP-RESTORE-'+crypto.randomUUID()};const result=await json('/api/v1/history/restore',restoreRequest);absorb(result);await persistence.resolveConflict(false);await refreshContent();undoOperationId=redoOperationId=null;restoreRequest=null;status.textContent='已恢复。当前状态保留在恢复点中，旧任务不会继续写入。';}catch(error){status.textContent=error.message;}finally{restore.disabled=false;}};
        dialog.append(heading,copy,select,status,restore,close);document.body.append(dialog);dialog.showModal();
      }catch(error){board.toast(error.message);}
    }
    const host={
      selectedUnit:()=>board.getState().selected,getState:board.getState,getEntity,applyContent,applyPersonal,
      personalEntries:namespace=>persistence.entries(namespace).map(([key,value])=>({key,value,revision:persistence.read(namespace,key).revision})),
      history:()=>({undoOperationId,redoOperationId}),undo,redo,
      subscribe:listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);},
      onRefresh:listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);},
      stageDraft:(key,value)=>persistence.put('editingDrafts',key,value===null?{cleared:true}:{draft:value}),
      recoverDrafts:()=>persistence.entries('editingDrafts').filter(([,v])=>v?.draft).map(([key,v])=>({key,value:v.draft})),
      refreshContent,toast:board.toast,focusUnit:board.focusUnit,
    };
    Object.assign(board,{getEntity,applyContent,applyPersonal,undo,redo,showHistory});
    board.editing=window.ReviewEditing?.mount(host);
    board.agent=window.ReviewAgent?.mount(board);
    const migrate=document.createElement('button'),migrationStatus=document.createElement('p');
    migrate.textContent='保存并停止旧课程';migrationStatus.setAttribute('role','status');migrationStatus.setAttribute('aria-label','迁移准备状态');
    migrationStatus.hidden=true;document.querySelector('.header-actions').append(migrate);document.body.append(migrationStatus);
    let composing=false,migrationOperation=null;
    document.addEventListener('compositionstart',()=>{composing=true;},true);document.addEventListener('compositionend',()=>{composing=false;},true);
    migrate.onclick=async()=>{
      migrationStatus.hidden=false;migrationStatus.setAttribute('role','status');
      if(composing){migrationStatus.setAttribute('role','alert');migrationStatus.textContent='中文候选输入尚未完成，请完成后再停止课程。';return;}
      document.body.inert=true;migrationStatus.textContent='正在确认最新输入并停止旧课程…';
      try{
        await board.editing?.flush();await board.agent?.flush();
        const deadline=Date.now()+15000;
        while(persistence.busy){if(Date.now()>deadline)throw new Error('在途保存尚未确认');await new Promise(r=>setTimeout(r,20));}
        if(persistence.problem&&!await persistence.retry())throw new Error('最新输入尚未确认：'+(persistence.problem?.message||'请先处理保存问题'));
        await board.flush();
        while(persistence.busy||persistence.hasPending()){
          if(persistence.problem||Date.now()>deadline)throw new Error('最新输入尚未确认，请重试保存');
          if(!persistence.busy)await persistence.flush();else await new Promise(r=>setTimeout(r,20));
        }
        migrationOperation||='MIGRATION-BARRIER-'+crypto.randomUUID();
        const receipt=await json('/api/v1/migration/prepare',{operationId:migrationOperation,confirmedSequence:persistence.sequence});
        if(receipt.saved!==true)throw new Error('停止完成事实尚未确认');
        migrationStatus.textContent='旧课程已停止，最新输入已确认。请在绎知中选择此课程文件夹迁移。';
      }catch(error){document.body.inert=false;migrationStatus.setAttribute('role','alert');migrationStatus.textContent='课程尚未停止：'+error.message+'。输入仍保留，请重试。';}
    };
    const viewport=document.querySelector('#viewport'),editingRoot=document.querySelector('[data-review-editing-root]');
    const positionTools=()=>{
      if(!editingRoot)return;
      const box=viewport.getBoundingClientRect();
      editingRoot.style.left=(box.left+box.width/2)+'px';
      editingRoot.style.maxWidth=Math.max(180,box.width-24)+'px';
      editingRoot.style.setProperty('--editing-available-width',Math.max(220,Math.min(490,box.width-24))+'px');
      viewport.style.setProperty('--editing-tools-height',Math.ceil(editingRoot.getBoundingClientRect().height+13)+'px');
    };
    const toolResize=new ResizeObserver(positionTools);
    toolResize.observe(viewport);
    if(editingRoot)toolResize.observe(editingRoot);
    positionTools();
    const enableText=()=>{board.textSelection=!document.getElementById('agent-panel')?.hidden;};
    new MutationObserver(enableText).observe(document.getElementById('agent-panel'),{attributes:true,attributeFilter:['hidden']});
    persistence.addEventListener('remote',event=>{
      if(event.detail.some(c=>c.namespace==='layout'))board.relayout?.();
      if(event.detail.some(c=>c.namespace==='knowledge'))refreshContent().catch(error=>board.toast(error.message));
      if(event.detail.some(c=>['notes','annotations','layout','knowledge','semanticChanges','review'].includes(c.namespace))){semanticMarkers();notify();}
    });
    persistence.addEventListener('committed',()=>{semanticMarkers();notify();});
    persistence.addEventListener('reload',()=>{semanticMarkers();notify();});
    window.addEventListener('review-content-refreshed',()=>{semanticMarkers();notify();});
    const flushEditing=()=>{try{Promise.resolve(board.editing?.flush()).catch(()=>{});board.agent?.flush();}catch{}};
    window.addEventListener('pagehide',flushEditing);
    document.addEventListener('click',event=>{
      const hit=event.target.closest('[data-conversation-id]');
      if(hit)window.dispatchEvent(new CustomEvent('review-open-conversation',{detail:{conversationId:hit.dataset.conversationId,messageId:hit.dataset.messageId}}));
    });
    semanticMarkers();
  }
  window.addEventListener('review-board-ready',mount,{once:true});
})();
