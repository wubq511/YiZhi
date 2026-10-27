(() => {
  'use strict';
  const esc = value => String(value ?? '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const labels = { knowledge: '知识', notes: '个人笔记', conversations: '学习对话', sources: '原文' };
  let current = null;
  let references = [];
  let serial = 0;

  function refsForUnit(unit) {
    const refs = [];
    const seen = new Set();
    function add(ref) {
      if (!ref?.sourceId || !ref?.versionId) return;
      const pages = ref.pdfPages || [];
      const locations = ref.section ? [{ section: ref.section }]
        : pages.map((pdfPage, index) => ({ pdfPage, bookPage: ref.bookPages?.[index] }));
      for (const location of locations) {
        const item = { sourceId: ref.sourceId, versionId: ref.versionId, ...location };
        const key = JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(item);
        }
      }
    }
    (unit.sourceRefs || []).forEach(add);
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.sourceRefs)) value.sourceRefs.forEach(add);
      if (Array.isArray(value)) value.forEach(walk);
      else Object.values(value).forEach(walk);
    }
    walk(unit.reading || {});
    return refs;
  }

  function queryFor(ref) {
    const params = new URLSearchParams({ sourceId: ref.sourceId, versionId: ref.versionId });
    for (const key of ['pdfPage', 'bookPage', 'section']) {
      if (ref[key] !== undefined && ref[key] !== null) params.set(key, ref[key]);
    }
    return params;
  }

  async function jsonRequest(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `请求失败（${response.status}）`);
    return data;
  }

  function locationText(data) {
    if (data.location.section) return `小节：${data.location.section}`;
    const pages = [`PDF 第 ${data.location.pdfPage} 页`];
    if (data.location.bookPage) pages.push(`中文书页 ${data.location.bookPage}`);
    return pages.join(' · ');
  }

  function render(data) {
    document.getElementById('source-title').textContent = data.title;
    document.getElementById('source-caption').textContent = `${data.displayName} · ${locationText(data)}`;
    const pages = document.getElementById('source-pages');
    const refButtons = references.map((ref, index) => {
      const active = ref.sourceId === current.sourceId && ref.versionId === current.versionId
        && ref.pdfPage === current.pdfPage && ref.section === current.section;
      return `<button type="button" data-source-ref-index="${index}" aria-pressed="${active}">${esc(ref.sourceId)}${ref.pdfPage ? ` · P${ref.pdfPage}` : ''}${ref.section ? ` · ${esc(ref.section)}` : ''}</button>`;
    }).join('');
    const page = current.pdfPage || 1;
    const toolbar = data.location.pdfPage ? `<div class="source-navigation"><button type="button" data-source-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← 上一页</button><span>${page} / ${data.pageCount}</span><button type="button" data-source-page="${page + 1}" ${page >= data.pageCount ? 'disabled' : ''}>下一页 →</button></div>` : '';
    const image = data.pageImageUrl ? `<a href="${esc(data.pageImageUrl)}" target="_blank" rel="noopener"><img class="source-full-page" src="${esc(data.pageImageUrl)}" alt="${esc(data.title)}${esc(locationText(data))}" loading="lazy"></a>` : '';
    const text = data.textStatus === 'unavailable'
      ? '<p class="source-warning">此页没有可可靠取得的文本。可以核对完整原页，并只携带本页上下文，不能声称选中了文字。</p>'
      : `<pre id="source-text" tabindex="0">${esc(data.text)}</pre>`;
    pages.innerHTML = `${refButtons ? `<div class="source-ref-list">${refButtons}</div>` : ''}${toolbar}<p><a href="${esc(data.resourceUrl)}" target="_blank" rel="noopener">打开指定版本原件 ↗</a></p>${image}${text}<div class="source-selection-actions"><button type="button" data-source-selection="text" ${data.textStatus === 'unavailable' ? 'disabled' : ''}>携带所选文字</button><button type="button" data-source-selection="page">携带本页上下文</button><span id="source-selection-status" role="status"></span></div>`;
    pages.onclick = async event => {
      const refButton = event.target.closest('[data-source-ref-index]');
      if (refButton) {
        load(references[Number(refButton.dataset.sourceRefIndex)], references);
        return;
      }
      const pageButton = event.target.closest('[data-source-page]');
      if (pageButton && !pageButton.disabled) {
        load({ ...current, pdfPage: Number(pageButton.dataset.sourcePage), bookPage: undefined }, references);
        return;
      }
      const selection = event.target.closest('[data-source-selection]');
      if (!selection) return;
      const selectedText = selection.dataset.sourceSelection === 'text' ? window.getSelection()?.toString() : null;
      if (selection.dataset.sourceSelection === 'text' && !selectedText) {
        document.getElementById('source-selection-status').textContent = '请先在文本区选择文字；也可以改为携带本页。';
        return;
      }
      const location = {};
      for (const key of ['pdfPage', 'bookPage', 'section']) if (current[key] !== undefined) location[key] = current[key];
      const payload = { sourceId: current.sourceId, versionId: current.versionId, location };
      if (selectedText) payload.text = selectedText;
      try {
        const result = await jsonRequest('/api/v1/source-selections', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        document.getElementById('source-selection-status').textContent = result.contentKind === 'text' ? '已携带真实选中文字。' : '已携带本页上下文，未声称选中文字。';
        window.dispatchEvent(new CustomEvent('review-source-selection', { detail: result }));
      } catch (error) {
        document.getElementById('source-selection-status').textContent = error.message;
      }
    };
  }

  async function load(ref, refs = references) {
    const ticket = ++serial;
    references = refs.length ? refs : [ref];
    current = { ...ref };
    document.getElementById('source-title').textContent = '正在读取原文…';
    document.getElementById('source-caption').textContent = `${ref.sourceId} · ${ref.versionId}`;
    document.getElementById('source-pages').innerHTML = '<p>正在核对资料版本和位置。</p>';
    try {
      const data = await jsonRequest(`/api/v1/sources/resolve?${queryFor(ref)}`);
      if (ticket !== serial) return;
      current = { ...current, ...data.location };
      render(data);
    } catch (error) {
      if (ticket !== serial) return;
      document.getElementById('source-title').textContent = '原文不可用';
      document.getElementById('source-pages').innerHTML = `<p class="source-warning system-error">${esc(error.message)}</p>`;
    }
  }

  async function search(text, scopes) {
    const params = new URLSearchParams({ q: text });
    if (scopes?.length) params.set('scopes', scopes.join(','));
    return jsonRequest(`/api/v1/search?${params}`);
  }

  function renderSearchResults(container, data) {
    const query = String(data.query || '').trim();
    const emphasize = value => {
      const text = String(value || ''), index = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
      return index < 0 ? esc(text) : `${esc(text.slice(0, index))}<mark>${esc(text.slice(index, index + query.length))}</mark>${esc(text.slice(index + query.length))}`;
    };
    const snippetFor = item => {
      let text = String(item.snippet || '');
      const nameAt = item.name ? text.indexOf(item.name) : -1;
      if (nameAt >= 0) text = text.slice(nameAt + item.name.length);
      return text.replace(/\bRB-[A-Z0-9-]+\b/gi, '').replace(/\bdataSignals\b/g, '').replace(/\s{2,}/g, ' ').replace(/^[…\s·:：-]+/, '').trim();
    };
    const warnings = (data.sourceWarnings || []).map(warning => {
      const location = warning.location || {};
      const position = location.pdfPages?.length ? `PDF 第 ${location.pdfPages.join('、')} 页`
        : location.section || location.sections?.join('、') || '';
      return `<p class="search-warning">${esc(warning.title || warning.sourceId)} · ${esc(warning.versionId)}${position ? ` · ${esc(position)}` : ''}：${esc(warning.message || '此处没有可靠文本，可回查原页。')}</p>`;
    }).join('');
    if (!data.items.length) {
      container.innerHTML = '<p class="empty-filter">当前范围没有匹配内容。</p>' + warnings;
      return;
    }
    const attributesFor = item => {
      const location = item.location || {};
      const themeUnit = location.themeId && window.COURSE_DATA?.units.find(unit => unit.themeId === location.themeId);
      if (location.unitId) return `data-focus="${esc(location.unitId)}"${location.blockId ? ` data-search-block="${esc(location.blockId)}"` : ''}`;
      if (themeUnit) return `data-focus="${esc(themeUnit.id)}"`;
      if (location.conversationId) return `data-conversation-id="${esc(location.conversationId)}"${location.messageId ? ` data-message-id="${esc(location.messageId)}"` : ''}`;
      if (item.scope === 'sources') return `data-source-result="true" data-source-id="${esc(item.id)}" data-version-id="${esc(item.version)}"${location.pdfPage ? ` data-pdf-page="${location.pdfPage}"` : ''}${location.bookPage ? ` data-book-page="${location.bookPage}"` : ''}${location.section ? ` data-section="${esc(location.section)}"` : ''}`;
      return '';
    };
    const genericHit = item => {
      const location = item.location || {}, attributes = attributesFor(item), snippet = snippetFor(item);
      const position = location.pdfPage ? `PDF 第 ${location.pdfPage} 页` : location.section ? `小节 ${location.section}` : '';
      const revision = ['notes', 'conversations'].includes(item.scope) ? `修订 ${item.version}` : item.scope === 'sources' ? String(item.version) : '';
      const body = `<strong>${emphasize(item.name)}</strong><small>${esc([item.id, position, revision].filter(Boolean).join(' · '))}</small>${snippet ? `<span>${emphasize(snippet)}</span>` : ''}`;
      return attributes ? `<button type="button" class="course-search-hit" ${attributes}>${body}</button>` : `<article class="course-search-hit">${body}</article>`;
    };
    container.innerHTML = data.scopes.map(scope => {
      const items = data.items.filter(item => item.scope === scope), consumed = new Set();
      if (!items.length) return '';
      const results = items.map(item => {
        if (consumed.has(item)) return '';
        if (item.entityType !== 'unit') return genericHit(item);
        const group = items.filter(other => other.entityType === 'unit' && other.id === item.id && !consumed.has(other));
        group.forEach(other => consumed.add(other));
        const summary = group.find(other => !other.location?.blockId), fragments = group.filter(other => other.location?.blockId);
        const unitId = (summary || item).location.unitId, summarySnippet = summary ? snippetFor(summary) : '';
        const heading = `<button type="button" class="course-search-hit course-search-unit-heading" data-focus="${esc(unitId)}"><strong>${emphasize(item.name)}</strong><small>${esc(item.id)}${fragments.length ? ` · ${fragments.length} 处正文匹配` : ' · 知识单元'}</small>${summarySnippet ? `<span>${emphasize(summarySnippet)}</span>` : ''}</button>`;
        const matches = fragments.map((fragment, index) => `<button type="button" class="course-search-fragment" data-focus="${esc(unitId)}" data-search-block="${esc(fragment.location.blockId)}"><small>正文片段 ${index + 1}</small><span>${emphasize(snippetFor(fragment))}</span></button>`).join('');
        return `<article class="course-search-unit">${heading}${matches ? `<div class="course-search-fragments">${matches}</div>` : ''}</article>`;
      }).join('');
      return `<section class="course-search-group"><h3>${esc(labels[scope] || scope)}<span>${items.length}</span></h3>${results}</section>`;
    }).join('') + warnings;
  }

  window.ReviewSourceTools = {
    refsForUnit,
    load,
    search,
    renderSearchResults,
    captureSource: () => current ? { current: { ...current }, references: references.map(ref => ({ ...ref })), textScroll: document.getElementById('source-text')?.scrollTop || 0 } : null,
    restoreSource: saved => saved?.current ? load(saved.current, saved.references || []) : null,
  };
})();
