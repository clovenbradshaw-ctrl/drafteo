// ============ FUZZY SOURCE SEARCH MODAL ============
// Workspace-wide source search with subsequence-based scoring.
// Opens with Cmd/Ctrl+K from inside a workspace.

(function () {
  const { el, clear } = window.DOM;
  function icon(name) { const i = document.createElement('i'); i.className = 'ph ph-' + name; return i; }

  function open(ws_id, app, opts) {
    opts = opts || {};
    const scrim = el('div.scrim.search-scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }

    const input = el('input', {
      type: 'text',
      placeholder: 'Search all sources in this workspace…',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const list = el('div.search-list');
    let selectedIdx = 0;

    function render(q) {
      clear(list);
      const results = Store.searchSourcesInWorkspace(ws_id, q);
      if (results.length === 0) {
        list.appendChild(el('div.search-empty', q ? 'No sources match "' + q + '".' : 'No sources in this workspace yet.'));
        selectedIdx = -1;
        return;
      }
      selectedIdx = Math.min(selectedIdx, results.length - 1);
      if (selectedIdx < 0) selectedIdx = 0;
      results.forEach((r, i) => {
        const s = r.source;
        const isWeb = !!s.source_url;
        const row = el('button.search-row' + (i === selectedIdx ? '.selected' : ''),
          { onClick: () => { close(); pick(r); }, onMouseenter: () => { selectedIdx = i; refreshSelection(); } },
          el('div.search-ico', isWeb ? icon('globe') : el('span', DOM.fileExt(s.mime, s.filename))),
          el('div.search-body',
            el('div.search-ttl', s.title || s.filename),
            el('div.search-meta',
              (s.archive_org_url ? '✓ Archived' : '○ Not archived'),
              ' · ',
              (isWeb ? (s.source_url || '') : s.filename),
              ' · in ',
              el('em', r.doc.title || 'Untitled'),
            ),
            s.description ? el('div.search-desc', s.description) : null,
          ),
        );
        list.appendChild(row);
      });
    }
    function refreshSelection() {
      [...list.querySelectorAll('.search-row')].forEach((r, i) => r.classList.toggle('selected', i === selectedIdx));
    }

    function pick(r) {
      // Navigate the user to the doc that owns this source and switch the
      // sidebar to the sources tab.
      if (opts.onPick) { opts.onPick(r); return; }
      app.openDocument(ws_id, r.doc.id);
    }

    input.addEventListener('input', () => render(input.value));
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, list.querySelectorAll('.search-row').length - 1); refreshSelection(); scrollSel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); refreshSelection(); scrollSel(); }
      else if (e.key === 'Enter') {
        const row = list.querySelectorAll('.search-row')[selectedIdx];
        if (row) row.click();
      }
    }
    function scrollSel() {
      const row = list.querySelectorAll('.search-row')[selectedIdx];
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }
    document.addEventListener('keydown', onKey);

    const modal = el('div.search-modal', { onClick: e => e.stopPropagation() },
      el('div.search-head',
        icon('magnifying-glass'),
        input,
        el('span.search-kbd', 'Esc'),
      ),
      list,
      el('div.search-foot',
        el('span', '↑↓ navigate'),
        el('span', '↵ open'),
        el('span', 'Fuzzy match across title, filename, URL, tags'),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    render('');
    setTimeout(() => input.focus(), 40);
  }

  // Global hotkey binding (Cmd/Ctrl + K)
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      // Determine current workspace from URL state or DraftEO route
      const ws = window.__currentWs;
      if (ws) {
        e.preventDefault();
        open(ws, window.DraftEO && window.DraftEO.app);
      }
    }
  });

  window.SearchSources = { open };
})();
