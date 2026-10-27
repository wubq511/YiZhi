/* Durable application conversations; execution belongs to the local bridge. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const labels = {queued:'排队中',running:'正在处理',needs_input:'需要处理',completed:'已完成',failed:'执行失败',interrupted:'已停止',reconciling:'核对任务状态'};
  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {cache:'no-store'} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || '请求未完成'), result.error);
    return result;
  }
  function inlineHTML(text) {
    const pattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|`[^`\n]+`)/g;
    return String(text || '').split(pattern).map(part => {
      if (/^(\$\$|\\\[|\\\()/.test(part)) {
        const latex = part.slice(2,-2);
        try { return `<span class="agent-math">${MathLive.convertLatexToMarkup(latex,{displayMode:!part.startsWith('\\(')})}</span>`; }
        catch { return esc(part); }
      }
      if (part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1,-1))}</code>`;
      return esc(part).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\b(KU-\d{3})\b/g,'<button type="button" class="agent-unit-link" data-agent-focus="$1">$1</button>').replaceAll('\n','<br>');
    }).join('');
  }
  function answerHTML(text) {
    const lines=String(text||'').replaceAll('\r\n','\n').split('\n'),out=[];
    const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
    for(let i=0;i<lines.length;i++){
      if(lines[i].trim().startsWith('```')){
        const code=[];for(i++;i<lines.length&&!lines[i].trim().startsWith('```');i++)code.push(lines[i]);
        out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');continue;
      }
      if(i+1<lines.length&&lines[i].includes('|')&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
        const header=cells(lines[i]);i+=2;const rows=[];
        for(;i<lines.length&&lines[i].includes('|')&&lines[i].trim();i++)rows.push(cells(lines[i]));i--;
        out.push('<div class="agent-table"><table><thead><tr>'+header.map(c=>'<th>'+inlineHTML(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+header.map((_,n)=>'<td>'+inlineHTML(row[n]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
      }
      if(/^\s*(\$\$|\\\[)/.test(lines[i])&&!/(\$\$|\\\])\s*$/.test(lines[i].replace(/^\s*(\$\$|\\\[)/,''))){
        const math=[lines[i]];for(i++;i<lines.length;i++){math.push(lines[i]);if(/(\$\$|\\\])\s*$/.test(lines[i]))break;}out.push(inlineHTML(math.join('\n')));continue;
      }
      out.push(inlineHTML(lines[i])+'<br>');
    }
    return out.join('');
  }
  function citationHTML(ref){
    const loc=ref.location||{};
    return `<button type="button" data-source-result="true" data-source-id="${esc(ref.sourceId)}" data-version-id="${esc(ref.versionId)}"${loc.pdfPage?` data-pdf-page="${loc.pdfPage}"`:''}${loc.bookPage?` data-book-page="${loc.bookPage}"`:''}${loc.section?` data-section="${esc(loc.section)}"`:''}>${esc(ref.displayName||ref.title||ref.sourceId)}${loc.pdfPage?' · PDF '+loc.pdfPage+' 页':''}${loc.bookPage?' / 书页 '+loc.bookPage:''}</button>`;
  }
  const uniqueCitations=refs=>[...new Map((refs||[]).map(ref=>[JSON.stringify([ref.sourceId,ref.versionId,ref.location]),ref])).values()];

  function mount(board) {
    const button = document.createElement('button');
    button.id = 'agent-toggle'; button.textContent = '学习助手';button.setAttribute('aria-expanded','false');
    $('.header-actions').prepend(button);
    const panel = document.createElement('aside');
    panel.id = 'agent-panel';panel.className = 'side-panel agent-panel';panel.hidden = true;
    panel.innerHTML = `<div class="panel-top"><div><span class="eyebrow">围绕当前内容继续学习</span><h2>学习助手</h2></div><button type="button" data-agent-close aria-label="收起学习助手">×</button></div>
      <div class="agent-conversation-bar"><select id="agent-conversation" aria-label="学习对话"></select><button id="agent-new">新对话</button><button id="agent-materials">资料版本</button><button id="agent-history">历史版本</button></div>
      <div id="agent-messages" class="agent-messages" aria-live="polite"></div><div id="agent-tasks"></div><div id="agent-prompts"></div>
      <div class="agent-compose"><p id="agent-target"></p><div id="agent-source-selection" hidden></div>
      <label>请求方式<select id="agent-intent"><option value="ask">提问</option><option value="edit">修改画板</option><option value="search">按描述查找</option></select></label>
      <textarea id="agent-draft" rows="4" placeholder="选中一句话提问，或写清希望修改什么" aria-label="学习问题或修改要求"></textarea>
      <div class="agent-submit-row"><select id="agent-model" aria-label="使用模型"><option value="">Codex 当前默认模型</option></select><button id="agent-send">发送</button></div>
      <p id="agent-feedback" role="status"></p></div>`;
    $('.workspace').append(panel);
    let state = {tasks:[],conversations:[],prompts:[]}, current = null, source = null, selection = null;
    let polling = false, pollTimer, draftTimer, draftTimerOwner, savingDraft = Promise.resolve(), uiTimer, modelsLoaded = false, requestInFlight = null;
    let messageSignature = '', taskSignature = '', uiDirty = false,uiTouched=false,stateLoaded=false;
    const drafts = new Map();
    let navigationVersion = 0;
    const ui = board.persistence.value('agent_ui','default') || {};
    panel.style.width = `${Math.max(280,Math.min(ui.width || 360,window.innerWidth*.6))}px`;
    function feedback(text) { $('#agent-feedback').textContent = text; }
    function saveUI() {
      clearTimeout(uiTimer);uiDirty = true;
      uiTimer = setTimeout(() => {uiDirty = false;board.persistence.put('agent_ui','default',{
        open:!panel.hidden,width:panel.offsetWidth || parseFloat(panel.style.width),conversationId:current,
        sourceSelection:source,selection,scroll:$('#agent-messages').scrollTop,intent:$('#agent-intent').value,
        model:$('#agent-model').value});},250);
    }
    function show(open=true,restoring=false) {
      if(!restoring)uiTouched=true;
      panel.hidden = !open;button.setAttribute('aria-expanded',String(open));
      board.panelChanged?.();saveUI();
      if (open && !modelsLoaded) loadModels();
    }
    async function loadModels() {
      modelsLoaded = true;
      try {
        const result = await request('/api/v1/agent/models');
        for (const model of result.models) {
          const option = document.createElement('option');option.value = model.model || model.id;
          option.textContent = model.displayName || option.value;$('#agent-model').append(option);
        }
        if (ui.model&&!uiTouched) $('#agent-model').value = ui.model;
        $('#agent-model').title = result.cliVersion;
      } catch(error) { feedback(error.message);modelsLoaded = false; }
    }
    function targetText() {
      const id = selection?.objectId || board.getState().selected;
      const unit = board.data.units.find(u=>u.id===id);
      $('#agent-target').textContent = `目标：${id || '尚未选择'}${unit?.name ? ' · '+unit.name : ''}${selection?.text ? '\n所选片段：'+selection.text.slice(0,180) : ''}`;
      $('#agent-source-selection').hidden = !source;
      $('#agent-source-selection').innerHTML = source ? `<span>${esc(source.displayName || source.title)} · ${esc(source.versionId)}${source.location?.pdfPage ? ' · PDF '+source.location.pdfPage+' 页' : ''}${source.text ? '<br>'+esc(source.text.slice(0,180)) : '<br>携带本页上下文'}</span><button type="button" data-agent-clear-source>×</button>` : '';
    }
    function render() {
      const conversations = [...state.conversations].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
      if (!current && conversations.length) activateConversation(conversations[0].conversationId);
      const picker = $('#agent-conversation'), before = picker.value;
      const options = conversations.map(c=>`<option value="${esc(c.conversationId)}">${esc(c.title || '学习对话')}</option>`).join('');
      if (picker.innerHTML !== options) picker.innerHTML = options;
      picker.value = current || '';
      const conversation = conversations.find(c=>c.conversationId===current);
      const messages = conversation?.messages || [];
      const signature = JSON.stringify(messages);
      if (signature !== messageSignature) {
        const root = $('#agent-messages'), atEnd = root.scrollHeight-root.scrollTop-root.clientHeight < 65;
        messageSignature = signature;
        root.innerHTML = messages.length ? messages.map(message=>`<article class="agent-message ${message.role==='user'?'user':'assistant'}" data-message-id="${esc(message.messageId)}"><div class="agent-message-label">${message.role==='user'?'你':'学习助手'}${message.pending?' · 正在回答':''}</div><div class="agent-message-body">${answerHTML(message.text)}</div>${message.sourceCitations?.length?'<div class="agent-citations">核对依据：'+uniqueCitations(message.sourceCitations).map(citationHTML).join('')+'</div>':''}${message.role==='assistant' && !message.pending ? `<button type="button" data-agent-add="${esc(message.messageId)}">加入画板</button>` : ''}</article>`).join('') : '<p class="agent-empty">选择画板内容后提问。普通回答保存在这里；选择“修改画板”或“加入画板”时才改正文。</p>';
        if (atEnd) root.scrollTop = root.scrollHeight;
      }
      const tasks = state.tasks.filter(t=>t.conversationId===current).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      const newTaskSignature = JSON.stringify([tasks,state.prompts,state.sourceUpdates]);
      if (newTaskSignature !== taskSignature) {
        taskSignature = newTaskSignature;
        $('#agent-tasks').innerHTML = tasks.slice(-5).map(task=>`<div class="agent-task" data-task-id="${esc(task.taskId)}"><strong>${esc(labels[task.status] || task.status)}</strong><span>${esc(task.target.objectId)} · ${esc(task.instruction.slice(0,45))}</span>${task.recoveryNote?`<p>${esc(task.recoveryNote)}</p>`:''}${task.error?`<p class="agent-error">${esc(task.error.message)}</p>`:''}<div>${['queued','running','needs_input','reconciling'].includes(task.status) ? `<button type="button" data-agent-control="stop" data-task="${esc(task.taskId)}">停止</button>`:''}${['interrupted','failed','needs_input'].includes(task.status) && !task.pendingRequest?`<button type="button" data-agent-control="continue" data-task="${esc(task.taskId)}">继续未完成部分</button>`:''}${task.status==='completed'?`<button type="button" data-agent-focus="${esc(task.target.objectId)}">前往目标</button>`:''}${(task.operationIds||[]).map((id,i)=>`<button type="button" data-agent-undo="${esc(id)}">撤回${task.operationIds.length>1?'第 '+(i+1)+' 次修改':'这次修改'}</button>`).join('')}</div>${task.pendingRequest?permissionHTML(task):''}</div>`).join('');
        for(const task of tasks.slice(-5)) {
          const row=panel.querySelector(`[data-task-id="${CSS.escape(task.taskId)}"]`);
          if(task.searchHits) {
            const hits=document.createElement('div');hits.className='agent-search-hits';
            hits.innerHTML=task.searchHits.length?task.searchHits.map(hit=>{
              const loc=hit.location||{};
              const attrs=loc.unitId?`data-agent-focus="${esc(loc.unitId)}"${loc.blockId?` data-search-block="${esc(loc.blockId)}"`:''}`:loc.conversationId?`data-conversation-id="${esc(loc.conversationId)}"${loc.messageId?` data-message-id="${esc(loc.messageId)}"`:''}`:
                hit.scope==='sources'?`data-source-result="true" data-source-id="${esc(hit.id)}" data-version-id="${esc(hit.version)}"${loc.pdfPage?` data-pdf-page="${loc.pdfPage}"`:''}${loc.section?` data-section="${esc(loc.section)}"`:''}`:'';
              return `<button type="button" ${attrs}><strong>${esc(hit.name)}</strong><br>${esc(hit.snippet)}</button>`;
            }).join(''):'<p>当前课程中没有找到可定位的内容。</p>';
            row?.append(hits);
          }
        }
        $('#agent-prompts').innerHTML = state.prompts.map(p=>`<div class="agent-prompt"><p>${esc(p.unitId)} 的重要结论或方法有变化：${esc(p.reason)}。要调整“已掌握”状态吗？</p><button data-mastery="keep" data-prompt="${esc(p.promptId)}">保持已掌握</button><button data-mastery="weak" data-prompt="${esc(p.promptId)}">改为薄弱</button><button data-mastery="todo" data-prompt="${esc(p.promptId)}">改为待复习</button></div>`).join('')+(state.sourceUpdates||[]).map(p=>`<div class="agent-prompt"><p title="${esc(p.versionId)}">资料“${esc(p.displayName)}”有了新版本。是否据此更新相关画板内容？</p><button data-material="later" data-update="${esc(p.updateId)}">暂不更新</button><button data-material="update" data-update="${esc(p.updateId)}">根据新版更新</button></div>`).join('');
      }
      targetText();
    }
    function permissionHTML(task) {
      const pending = task.pendingRequest, params = pending.params || {};
      const questions = params.questions || [];
      if (questions.length) return `<form data-agent-input="${esc(task.taskId)}"><p>执行器需要以下信息：</p>${questions.map(q=>`<label>${esc(q.question || q.header)}${q.options?.length?`<select name="${esc(q.id)}">${q.options.map(o=>`<option value="${esc(o.label)}">${esc(o.label)}${o.description?' — '+esc(o.description):''}</option>`).join('')}</select>`:`<input name="${esc(q.id)}" required>`}</label>`).join('')}<button type="submit">提交答复</button></form>`;
      return `<div class="agent-permission"><p>Codex 请求执行权限：${esc(params.command || params.reason || pending.method)}</p><button data-permission="decline" data-task="${esc(task.taskId)}">拒绝</button><button data-permission="accept" data-task="${esc(task.taskId)}">允许这次执行</button></div>`;
    }
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const oldOps = new Set(state.tasks.flatMap(t=>t.operationIds || []));
        state = await request('/api/v1/agent/state');
        const changed = stateLoaded?state.tasks.filter(t=>(t.operationIds||[]).some(id=>!oldOps.has(id))):[];
        stateLoaded=true;
        if (changed.length) await board.refreshContent?.([...new Set(changed.map(t=>t.target.objectId))]);
        render();
      } catch(error) { feedback(`助手暂时未连接：${error.message}。已保存内容仍可阅读。`); }
      finally {polling = false;}
    }
    const draftKey = identifier => identifier || 'new';
    function draftFor(identifier) {
      const key = draftKey(identifier);
      if (!drafts.has(key)) drafts.set(key, {
        text:board.persistence.value('editingDrafts','AGENT-'+key)?.text ??
          state.conversations.find(c=>c.conversationId===identifier)?.draft ?? '', version:0});
      return drafts.get(key);
    }
    function rememberDraft(identifier,text,input=false) {
      const draft=draftFor(identifier);
      if(input || draft.text!==text) draft.version++;
      draft.text=text;
      board.persistence.put('editingDrafts','AGENT-'+(identifier || 'new'),{type:'agent',conversationId:identifier,text});
      return {...draft};
    }
    function saveDraft(identifier=current,text=$('#agent-draft').value) {
      if(draftTimerOwner===draftKey(identifier)){clearTimeout(draftTimer);draftTimerOwner=null;}
      rememberDraft(identifier,text);
      if(identifier)savingDraft = savingDraft.catch(()=>{}).then(()=>request('/api/v1/agent/conversations',{
        conversationId:identifier,patch:{draft:text}})).catch(error=>feedback(`问题草稿尚未保存：${error.message}`));
      return savingDraft;
    }
    function activateConversation(identifier) {
      current=identifier;
      $('#agent-draft').value=draftFor(identifier).text;
      messageSignature='';taskSignature='';
    }
    async function switchConversation(identifier,{create=false,open=false,restoring=false}={}) {
      if(!restoring)uiTouched=true;
      const navigation=++navigationVersion;
      saveDraft(); // Capture the outgoing owner and text before any await or selection change.
      if(create) {
        const conversation=await request('/api/v1/agent/conversations',{});
        if(!state.conversations.some(c=>c.conversationId===conversation.conversationId))state.conversations.push(conversation);
        if(navigation!==navigationVersion)return;
        saveDraft(); // Keep any input typed while the new conversation was being created.
        identifier=conversation.conversationId;
        if(!current)rememberDraft(identifier,draftFor(null).text);
      }
      if(navigation!==navigationVersion)return;
      activateConversation(identifier);
      if(open)show(true,restoring);
      saveUI();render();
    }
    function queueDraft() {
      uiTouched=true;clearTimeout(draftTimer);
      const identifier=current,text=$('#agent-draft').value;
      rememberDraft(identifier,text,true);draftTimerOwner=draftKey(identifier);
      draftTimer=setTimeout(()=>saveDraft(identifier,text),350);
    }
    function acceptRequest(pending,task) {
      const identifier=task.conversationId,origin=pending.body.conversationId;
      const draft=draftFor(origin);
      const consumed=draft.version===pending.draft.version && draft.text===pending.draft.text &&
        draft.text.trim()===pending.body.instruction.trim();
      const text=consumed?'':draft.text;
      // A receipt only updates the draft which produced the request, never the visible other chat.
      saveDraft(identifier,text);
      if(current===origin && pending.navigation===navigationVersion) {
        if(identifier!==current)activateConversation(identifier);
        else $('#agent-draft').value=text;
      } else if(current===identifier) $('#agent-draft').value=text;
      feedback(task.requestKind==='ask'?'已提交，回答会保存在原对话。':'已提交，完成后会提示位置。');
      requestInFlight=null;$('#agent-retry')?.remove();saveUI();
    }
    async function submitPending(pending) {
      if(pending.sending || requestInFlight!==pending)return;
      pending.sending=true;$('#agent-send').disabled=true;
      try {
        await pending.draftSaved;
        const task=await request('/api/v1/agent/requests',pending.body);
        acceptRequest(pending,task);await poll();
      } catch(error) {
        feedback(`请求尚未确认：${error.message}。草稿已保留。`);
        if (!$('#agent-retry')) {
          const retry=document.createElement('button');retry.id='agent-retry';retry.textContent='重试同一请求';
          retry.onclick=()=>submitPending(pending);$('#agent-feedback').after(retry);
        }
      } finally {pending.sending=false;$('#agent-send').disabled=!!requestInFlight?.sending;}
    }
    async function send(instruction, target, kind, selectedSource=null) {
      if (requestInFlight) {feedback('上一条请求正在确认；重试会继续使用同一请求身份。');return;}
      const body = {requestId:'REQ-'+crypto.randomUUID(),conversationId:current,
        instruction,requestKind:kind,target:structuredClone(target),sourceSelection:structuredClone(selectedSource),
        model:$('#agent-model').value || null};
      const draftSaved=saveDraft(body.conversationId,$('#agent-draft').value);
      const pending={body,draft:{...draftFor(body.conversationId)},navigation:navigationVersion,draftSaved};
      requestInFlight=pending;
      return submitPending(pending);
    }
    button.onclick = event => {show(panel.hidden);if(event.detail===0&&!panel.hidden)$('#agent-draft').focus({preventScroll:true});};
    panel.addEventListener('click', async event => {
      const control = event.target.closest('[data-agent-control]'), focus = event.target.closest('[data-agent-focus]');
      const undo = event.target.closest('[data-agent-undo]'), mastery = event.target.closest('[data-mastery]');
      const add = event.target.closest('[data-agent-add]'), permission = event.target.closest('[data-permission]');
      const material = event.target.closest('[data-material]');
      try {
        if (event.target.closest('[data-agent-close]')) {show(false);button.focus({preventScroll:true});}
        if (event.target.closest('[data-agent-clear-source]')) {source=null;targetText();saveUI();}
        if (focus) {
          if(focus.dataset.searchBlock)board.focusLocation({unitId:focus.dataset.agentFocus,blockId:focus.dataset.searchBlock});
          else board.focusUnit(focus.dataset.agentFocus);
        }
        if (control) {await request('/api/v1/agent/control',{taskId:control.dataset.task,action:control.dataset.agentControl,...(control.dataset.agentControl==='continue'?{model:$('#agent-model').value||null}:{})});await poll();}
        if (undo) {await board.undo(undo.dataset.agentUndo);feedback('已撤回对应修改，后来笔记和标注保留。');await poll();}
        if (mastery) {await request('/api/v1/agent/prompts',{promptId:mastery.dataset.prompt,status:mastery.dataset.mastery});await board.persistence.poll();await poll();}
        if (material) {await request('/api/v1/agent/material-updates',{updateId:material.dataset.update,action:material.dataset.material,conversationId:current});await poll();}
        if (permission) {await request('/api/v1/agent/control',{taskId:permission.dataset.task,action:'resolve',response:{decision:permission.dataset.permission}});await poll();}
        if (add) {
          const conversation = state.conversations.find(c=>c.conversationId===current);
          const message = conversation.messages.find(m=>m.messageId===add.dataset.agentAdd);
          await send('把下面这段回答作为合适的补充讲解加入当前目标正文，保留依据和已有内容：\n'+message.text,message.target,'edit',message.sourceSelection);
        }
      } catch(error) {feedback(error.message);}
    });
    panel.addEventListener('submit', async event => {
      const form = event.target.closest('[data-agent-input]');if(!form)return;event.preventDefault();
      try {const answers=Object.fromEntries([...new FormData(form)].map(([key,value])=>[key,{answers:[value]}]));await request('/api/v1/agent/control',{taskId:form.dataset.agentInput,action:'resolve',response:{answers}});await poll();} catch(error){feedback(error.message);}
    });
    $('#agent-new').onclick=()=>switchConversation(null,{create:true}).catch(error=>feedback(error.message));
    $('#agent-conversation').onchange=event=>switchConversation(event.target.value).catch(error=>feedback(error.message));
    $('#agent-draft').addEventListener('input',queueDraft);
    $('#agent-draft').addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();$('#agent-send').click();}});
    $('#agent-send').onclick=()=>{const text=$('#agent-draft').value.trim();if(!text){feedback('先写下问题或修改要求。');return;}send(text,selection||{objectId:board.getState().selected},$('#agent-intent').value,source);};
    $('#agent-intent').onchange=saveUI;$('#agent-model').onchange=saveUI;
    $('#agent-history').onclick=()=>board.showHistory?.();
    $('#agent-materials').onclick=async()=>{
      try{
        const data=await request('/api/v1/materials'),dialog=document.createElement('dialog');dialog.className='history-dialog';
        dialog.innerHTML='<h2>课程资料版本</h2><p>选择 PDF、Markdown 或文本资料。保存新版会保留原版本；是否据此更新画板，在保存后另行选择。</p>';
        const select=document.createElement('select');select.setAttribute('aria-label','新增或替换哪份资料');
        const fresh=document.createElement('option');fresh.value='';fresh.textContent='新增一份资料';select.append(fresh);
        for(const item of data.sources){const option=document.createElement('option');option.value=item.sourceId;option.textContent=item.title+' · '+item.versions.length+' 个版本';select.append(option);}
        const title=document.createElement('input');title.placeholder='资料名称';title.setAttribute('aria-label','资料名称');
        const file=document.createElement('input');file.type='file';file.accept='.pdf,.md,.txt';file.setAttribute('aria-label','选择资料文件');
        const related=document.createElement('input');related.type='checkbox';related.checked=true;related.value=board.getState().selected;related.setAttribute('aria-label','关联当前单元');
        const relatedLabel=document.createElement('label');relatedLabel.className='material-related';relatedLabel.append(related,document.createTextNode('关联当前单元：'+(board.data.units.find(u=>u.id===related.value)?.name||related.value)));
        const versions=document.createElement('div'),status=document.createElement('p'),save=document.createElement('button'),close=document.createElement('button');
        save.textContent='保存资料版本';close.textContent='关闭';let pending=null;
        function refreshVersions(){pending=null;const item=data.sources.find(s=>s.sourceId===select.value);title.value=item?.title||'';related.checked=!item||(board.data.units.find(u=>u.id===related.value)?.sourceRefs||[]).some(r=>r.sourceId===item.sourceId);versions.innerHTML=(item?.versions||[]).map(v=>`<p><button type="button" data-source-result="true" data-source-id="${esc(item.sourceId)}" data-version-id="${esc(v.id)}"${v.totalPages?' data-pdf-page="1"':' data-section="全文"'}>${esc(v.displayName)} · ${v.totalPages?v.totalPages+' 页':'文本资料'}</button></p>`).join('');}
        select.onchange=refreshVersions;file.onchange=()=>{pending=null;};title.oninput=()=>{pending=null;};related.oninput=()=>{pending=null;};
        save.onclick=async()=>{
          if(!file.files[0]){status.textContent='先选择资料文件。';return;}
          try{
            save.disabled=true;status.textContent='正在保存资料版本…';
            if(!pending){const chosen=file.files[0];const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取所选资料'));reader.readAsDataURL(chosen);});pending={operationId:'OP-MATERIAL-'+crypto.randomUUID(),sourceId:select.value||null,title:title.value.trim()||chosen.name,name:chosen.name,contentBase64:base64,affectedUnitIds:related.checked?[related.value]:[]};}
            const result=await request('/api/v1/materials/import',pending);
            if(result.saved!==true)throw new Error('资料保存尚未确认');pending=null;status.textContent='资料版本已保存。旧引用保留，请在学习助手中选择是否更新画板。';await poll();
          }catch(error){status.textContent=error.message+'；所选文件和提交身份保留，可重试。';}finally{save.disabled=false;}
        };
        close.onclick=()=>{dialog.close();dialog.remove();};
        dialog.append(select,title,file,relatedLabel,versions,status,save,close);document.body.append(dialog);dialog.showModal();
      }catch(error){feedback(error.message);}
    };
    document.addEventListener('pointerup',event=>{
      const selected = window.getSelection(), article = event.target.closest?.('article.unit[data-unit]');
      if (selected?.toString().trim() && article && article.contains(selected.anchorNode) && article.contains(selected.focusNode)) {
        const block=selected.anchorNode.parentElement.closest('[data-block-id],details[id],.reading-exercise[id]');
        selection={objectId:article.dataset.unit,text:selected.toString(),blockId:block?.dataset.blockId||block?.id||null};targetText();saveUI();
      }
    });
    document.addEventListener('click',event=>{const article=event.target.closest?.('article.unit[data-unit]');if(article&&!window.getSelection()?.toString().trim()){selection=null;targetText();}});
    window.addEventListener('review-source-selection',event=>{source=structuredClone(event.detail);show();targetText();saveUI();});
    window.addEventListener('review-open-conversation',event=>{
      const {conversationId,messageId}=event.detail;
      switchConversation(conversationId,{open:true}).then(()=>{
        if(!messageId||current!==conversationId)return;
        const root=$('#agent-messages'),message=root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        if(!message){feedback('这条消息已变化，已打开所属对话。');return;}
        root.scrollTop+=message.getBoundingClientRect().top-root.getBoundingClientRect().top-12;
        message.classList.add('search-target');setTimeout(()=>message.classList.remove('search-target'),6000);saveUI();
      }).catch(error=>feedback(error.message));
    });
    new ResizeObserver(()=>{board.panelChanged?.();saveUI();}).observe(panel);
    $('#agent-messages').addEventListener('scroll',saveUI,{passive:true});
    const ready = poll().then(async()=>{
      if(!uiTouched && ui.conversationId && state.conversations.some(c=>c.conversationId===ui.conversationId))activateConversation(ui.conversationId);
      if(!current)await switchConversation(null,{create:true,restoring:true});
      else if(!uiTouched)activateConversation(current);
      if(!uiTouched){source=ui.sourceSelection||null;selection=ui.selection||null;$('#agent-intent').value=ui.intent||'ask';show(!!ui.open,true);$('#agent-messages').scrollTop=ui.scroll||0;}
      render();
    }).catch(error=>feedback(error.message));
    pollTimer=setInterval(poll,700);
    return {ready,show,request,poll,flush:()=>saveDraft(),destroy:()=>{clearInterval(pollTimer);clearTimeout(uiTimer);clearTimeout(draftTimer);}};
  }
  window.ReviewAgent={mount,answerHTML};
})();
