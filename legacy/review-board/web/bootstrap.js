/* Load the course before mounting the same continuous reading surface. */
(async () => {
  const status = document.getElementById('save-label');
  try {
    const response = await fetch('/api/v1/course', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const boot = await response.json();
    if (!response.ok) throw new Error(boot.error?.message || '无法读取课程');
    window.COURSE_BOOT = boot;
    const savedUnit=boot.state.documents.reading?.default?.value?.selected;
    if(savedUnit&&!boot.view.units.some(u=>u.id===savedUnit)){
      const r=await fetch('/api/v1/entities/'+encodeURIComponent(savedUnit));
      if(r.ok){const unit=await r.json();if(unit.themeId){boot.view.units.push(unit);boot.view.restoredUnitIds=[unit.id];if(!boot.view.themes.some(t=>t.id===unit.themeId)){const t=await fetch('/api/v1/entities/'+encodeURIComponent(unit.themeId));if(t.ok)boot.view.themes.push(await t.json());}}}
    }
    window.COURSE_DATA = boot.view;
    if (boot.contentProvider) {
      const provider = document.createElement('script');
      provider.src = boot.contentProvider;
      await new Promise(resolve => { provider.onload = provider.onerror = resolve; document.head.append(provider); });
    }
    const script = document.createElement('script');
    script.src = '/web/app.js';
    script.onerror = () => { status.textContent = '阅读界面未能加载，请重新打开'; };
    document.body.append(script);
  } catch (error) {
    status.textContent = '课程未打开';
    const panel = document.getElementById('save-problem');
    panel.hidden = false;
    document.getElementById('save-problem-copy').textContent = `无法读取课程：${error.message}`;
    document.getElementById('retry-save').textContent = '重新打开';
    document.getElementById('retry-save').onclick = () => location.reload();
  }
})();
