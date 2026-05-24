// ============ WORKSPACE SHELL ============
// The "inside a workspace" view: tabs across the top, a file-tree
// sidebar on the left (drafts + sources), the editor in the middle.
// Clicking a workspace card from the home view lands you here, with
// one default draft auto-created and open in the first tab.

(function () {
  const { el, mount, clear, fmtTimeAgo } = window.DOM;

  function render(ws_id, focus_doc_id, app) {
    const ws = Store.getWorkspace(ws_id);
    const session = Store.session();
    if (!ws) { app.openWorkspaceList(); return; }

    // Auto-create a default draft if the workspace is empty
    let docs = Store.listDocuments(ws_id);
    if (docs.length === 0 && !focus_doc_id) {
      // Don't auto-create — show empty state with a prominent "New draft" CTA.
      docs = [];
    }

    // Load tab state (which docs are open + which is active)
    const TABS_KEY = 'drafteo.tabs.' + ws_id;
    let tabs = null;
    try { tabs = JSON.parse(localStorage.getItem(TABS_KEY) || 'null'); } catch (_) {}
    if (!tabs || !tabs.open) tabs = { open: [], active: null };
    tabs.open = (tabs.open || []).filter(id => Store.getDocument(id));
    if (focus_doc_id && Store.getDocument(focus_doc_id)) {
      if (!tabs.open.includes(focus_doc_id)) tabs.open.unshift(focus_doc_id);
      tabs.active = focus_doc_id;
    }
    if (tabs.open.length === 0) {
      // No drafts yet — show empty state in the main panel.
      tabs.active = null;
    }
    if (tabs.active && !tabs.open.includes(tabs.active)) tabs.active = tabs.open[0];
    saveTabs();
    function saveTabs() { try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch (_) {} }

    // Chrome
    const titlebar = el('div.titlebar',
      el('div.brand', { onClick: () => app.openWorkspaceList(), style: { cursor: 'pointer' } },
        el('span.mark'), el('span', 'DraftEO')),
      el('div.crumbs',
        el('a', { onClick: () => app.openWorkspaceList() }, 'Workspaces'),
        el('span.sep', '/'),
        el('span.current', ws.title),
      ),
      el('div.spacer'),
      el('div.statusdot.saved', el('span.dot'), el('span', 'E2EE · CONNECTED')),
      el('button.iconbtn.ghost', { onClick: () => app.toggleTheme(), title: 'Toggle theme', dataset: { themeToggle: '1' } }, themeIcon()),
      el('div.userchip',
        el('span.av', initials(session.matrix_id)),
        el('span', { style: { maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis' } }, session.display_name || session.matrix_id),
        el('button.ghost', { style: { padding: '1px 6px', fontSize: '10px', marginLeft: '6px' }, onClick: () => app.logout() }, 'LOGOUT'),
      ),
    );

    const sidebar = el('div.ws-sidebar');
    const tabbar = el('div.ws-tabbar');
    const content = el('div.ws-content');

    const shell = el('div.app.ws-shell',
      titlebar,
      el('div.ws-body',
        sidebar,
        el('div.ws-main', tabbar, content),
      ),
    );

    function renderSidebar() {
      window.__currentWs = ws_id;
      window.__refreshSidebar = renderSidebar;
      clear(sidebar);
      sidebar.appendChild(workspaceHeader(ws, app, () => render(ws_id, tabs.active, app)));

      // Search button
      const searchBtn = el('button.ws-search', { onClick: () => window.SearchSources.open(ws_id, app) },
        icon('magnifying-glass'),
        el('span', 'Search sources…'),
        el('span.kbd', '⌘K'),
      );
      sidebar.appendChild(searchBtn);

      // Corkboard button
      const corkBtn = el('button.ws-search', { style: { borderTop: 0 }, onClick: () => openCorkboard() },
        icon('squares-four'),
        el('span', 'Corkboard'),
        el('span.kbd', String(Store.listEvidence(ws_id).length || '')),
      );
      sidebar.appendChild(corkBtn);

      // Drafts section
      const draftsSection = el('div.ws-section');
      draftsSection.appendChild(el('div.ws-section-head',
        el('span', icon('files'), ' DRAFTS'),
        el('button.iconbtn.ghost', { title: 'New draft', onClick: () => newDraft() }, icon('plus')),
      ));
      const draftList = el('div.ws-tree');
      const allDocs = Store.listDocuments(ws_id);
      for (const d of allDocs) {
        const isOpen = tabs.open.includes(d.id);
        const isActive = d.id === tabs.active;
        const row = el('div.ws-tree-row' + (isActive ? '.active' : '') + (isOpen ? '.open' : ''),
          { onClick: () => openDoc(d.id), onContextmenu: (e) => { e.preventDefault(); docMenu(e, d); } },
          el('span.ico', icon(isActive ? 'file-text' : 'file')),
          el('span.name', d.title || 'Untitled'),
          el('span.meta', 'v' + d.version),
        );
        draftList.appendChild(row);
      }
      if (allDocs.length === 0) {
        draftList.appendChild(el('div.ws-tree-empty', 'No drafts yet.'));
      }
      draftsSection.appendChild(draftList);
      sidebar.appendChild(draftsSection);

      // Exhibits section — saved spans of evidence
      const exhibitsSection = el('div.ws-section');
      const exhibits = Store.listExhibits(ws_id);
      exhibitsSection.appendChild(el('div.ws-section-head',
        el('span', icon('scissors'), ' EXHIBITS'),
        el('span', { style: { fontSize: '10px', color: 'var(--ink-faint)' } }, exhibits.length ? String(exhibits.length) : ''),
      ));
      const exhibitsList = el('div.ws-tree');
      for (const ex of exhibits) {
        let provenanceLabel = '';
        if (ex.source_id) {
          for (const d of Store.listDocuments(ws_id)) {
            const s = Store.getSource(d.id, ex.source_id);
            if (s) { provenanceLabel = s.title || s.filename; break; }
          }
        } else if (ex.doc_id) {
          const d = Store.getDocument(ex.doc_id);
          if (d) provenanceLabel = d.title;
        }
        const row = el('div.ws-tree-row',
          { onClick: () => openExhibitDetail(ex), title: ex.text },
          el('span.ico', icon('quotes')),
          el('span.name', ex.label || (ex.text || '').slice(0, 50)),
          el('span.meta', provenanceLabel.slice(0, 14)),
        );
        exhibitsList.appendChild(row);
      }
      if (exhibits.length === 0) {
        exhibitsList.appendChild(el('div.ws-tree-empty', 'Select text in a source or draft and "Save as exhibit" to clip evidence here.'));
      }
      exhibitsSection.appendChild(exhibitsList);
      sidebar.appendChild(exhibitsSection);

      // Sources section (across all docs in this workspace)
      const sourcesSection = el('div.ws-section');
      sourcesSection.appendChild(el('div.ws-section-head',
        el('span', icon('paperclip'), ' SOURCES'),
        el('button.iconbtn.ghost', { title: 'Add a source to the active draft', onClick: () => addSourceToActive() }, icon('plus')),
      ));
      const sourceList = el('div.ws-tree');
      const allSources = [];
      for (const d of allDocs) {
        for (const s of Store.listSources(d.id)) allSources.push(Object.assign({ doc_id: d.id, doc_title: d.title }, s));
      }
      for (const s of allSources) {
        const isWeb = !!s.source_url;
        sourceList.appendChild(el('div.ws-tree-row',
          {
            onClick: () => openSource(s.doc_id, s.source_id),
            onContextmenu: (e) => { e.preventDefault(); openSourceMenu(e, s); },
            title: s.title + (s.archive_org_url ? ' (archived)' : ' (not archived)'),
          },
          el('span.ico', icon(isWeb ? 'globe' : 'file')),
          el('span.name', s.title || s.filename),
          el('span.meta', s.archive_org_url ? icon('check-circle') : icon('warning')),
        ));
      }
      if (allSources.length === 0) {
        sourceList.appendChild(el('div.ws-tree-empty', 'No sources yet. Upload or import in the active draft\'s right panel.'));
      }
      sourcesSection.appendChild(sourceList);
      sidebar.appendChild(sourcesSection);

      // Members section
      const membersSection = el('div.ws-section');
      membersSection.appendChild(el('div.ws-section-head',
        el('span', icon('users-three'), ' MEMBERS'),
        el('button.iconbtn.ghost', { title: 'Invite by Matrix ID', onClick: () => invite() }, icon('user-plus')),
      ));
      const mList = el('div.ws-members');
      for (const m of ws.members) {
        mList.appendChild(el('div.ws-member-row' + (m.status === 'invited' ? '.pending' : ''),
          el('span.av', initials(m.matrix_id)),
          el('div.who',
            el('div.name', m.matrix_id.replace(/^@/, '').split(':')[0]),
            el('div.role', m.role.toUpperCase() + (m.status === 'invited' ? ' · INVITED' : '')),
          ),
        ));
      }
      membersSection.appendChild(mList);
      sidebar.appendChild(membersSection);
    }

    function openExhibitDetail(ex) {
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      const labelInp = el('input', { type: 'text', value: ex.label || '', placeholder: 'Label (optional)' });
      let provenanceHtml = '';
      if (ex.source_id) {
        for (const d of Store.listDocuments(ws_id)) {
          const s = Store.getSource(d.id, ex.source_id);
          if (s) {
            provenanceHtml = 'Clipped from <strong>' + (s.title || s.filename) + '</strong>' + (s.archive_org_url ? ' · <a href="' + s.archive_org_url + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">archive.org</a>' : ' · not yet archived');
            break;
          }
        }
      } else if (ex.doc_id) {
        const d = Store.getDocument(ex.doc_id);
        if (d) provenanceHtml = 'Clipped from draft <strong>' + d.title + '</strong>';
      }
      const modal = el('div.modal', { style: { width: 'min(560px, 96vw)' }, onClick: (e) => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Exhibit'), el('div.sub', 'Permanent provenance · ' + DOM.fmtTimeAgo(ex.created_at) + (ex.author ? ' · by ' + ex.author : ''))), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body',
          el('label', 'Quote'),
          el('div', { style: { fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: '14px', color: 'var(--ink-dim)', borderLeft: '3px solid var(--accent)', paddingLeft: '12px', margin: '4px 0 14px', lineHeight: '1.6', whiteSpace: 'pre-wrap' } }, '"' + ex.text + '"'),
          el('label', 'Label (optional)'),
          labelInp,
          el('label', 'Provenance'),
          el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-dim)', html: provenanceHtml }, html: provenanceHtml || 'Origin unknown' }),
          (ex.char_start != null ? el('div', { style: { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '8px' } }, 'Characters ' + ex.char_start + '–' + ex.char_end) : null),
        ),
        el('div.m-foot',
          el('button.ghost', { style: { color: 'var(--err)' }, onClick: async () => {
            const ok = await DOM.confirmDialog({ title: 'Delete this exhibit?', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            await Store.deleteExhibit(ws_id, ex.id);
            scrim.remove();
            renderSidebar();
          } }, 'Delete exhibit'),
          el('div.actions',
            el('button.ghost', { onClick: () => scrim.remove() }, 'Close'),
            el('button.primary', { onClick: async () => {
              await Store.updateExhibit(ws_id, ex.id, { label: labelInp.value.trim() });
              scrim.remove();
              renderSidebar();
            } }, 'Save'),
          ),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => labelInp.focus(), 50);
    }

    function openSourceMenu(e, s) {
      const menu = el('div.context-menu', { style: { left: e.clientX + 'px', top: e.clientY + 'px', minWidth: '220px' } });
      function row(ic, text, action, style) {
        return el('div', { onClick: () => { closeMenu(); action(); }, style: style || null }, icon(ic), text);
      }
      menu.appendChild(row('eye', 'Open in viewer', () => openSource(s.doc_id, s.source_id)));
      menu.appendChild(row('pencil-simple', 'Rename / edit metadata', () => editSourceMeta(s)));
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      if (s.archive_org_url) {
        menu.appendChild(row('archive', 'Open on archive.org', () => window.open(s.archive_org_url, '_blank', 'noopener')));
      } else {
        menu.appendChild(row('upload-simple', 'Publish to archive.org…', () => publishSource(s)));
      }
      if (s.source_url) menu.appendChild(row('arrow-square-out', 'Open original URL', () => window.open(s.source_url, '_blank', 'noopener')));
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      menu.appendChild(row('trash', 'Toss to bin', async () => {
        await Store.hideSource(s.doc_id, s.source_id, true);
        renderSidebar();
        DOM.toast('TOSSED', '"' + (s.title || s.filename) + '" moved to Bin');
      }, { color: 'var(--err)' }));
      document.body.appendChild(menu);
      function closeMenu() { menu.remove(); }
      setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
    }

    function editSourceMeta(s) {
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      const titleInp = el('input', { type: 'text', value: s.title || '' });
      const descTa = el('textarea', { rows: 3 }, s.description || '');
      descTa.value = s.description || '';
      const tagsInp = el('input', { type: 'text', value: (s.tags || []).join(', '), placeholder: 'metro, OHS, audit' });
      const modal = el('div.modal', { onClick: (e) => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Edit source'), el('div.sub', s.filename)), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body',
          el('label', 'Title'), titleInp,
          el('label', 'Description'), descTa,
          el('label', 'Tags (comma-separated)'), tagsInp,
          el('div', { style: { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '12px', lineHeight: 1.6 } },
            'Filename · ' + s.filename, el('br'),
            'MIME · ' + s.mime, el('br'),
            'Size · ' + DOM.fmtBytes(s.size_bytes), el('br'),
            'archive.org · ' + (s.archive_org_url || 'not yet published')),
        ),
        el('div.m-foot', el('div'),
          el('div.actions',
            el('button.ghost', { onClick: () => scrim.remove() }, 'Cancel'),
            el('button.primary', { onClick: async () => {
              await Store.updateSource(s.doc_id, s.source_id, {
                title: titleInp.value.trim(),
                description: descTa.value.trim(),
                tags: tagsInp.value.split(',').map(t => t.trim()).filter(Boolean),
              });
              scrim.remove();
              renderSidebar();
            } }, 'Save'),
          ),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => titleInp.focus(), 50);
    }

    function publishSource(s) {
      // Delegate to the existing archive consent modal in the SourcePanel.
      if (window.SourcePanel && window.SourcePanel.openArchive) {
        window.SourcePanel.openArchive(s.doc_id, s, { refreshSources: () => renderSidebar() });
      } else {
        // Fallback: just open the source and let user click ARCHIVE from there
        openSource(s.doc_id, s.source_id);
      }
    }

    function focusSourcesPanel() {
      const tab = document.querySelector('.sidebar-tabs .tab');
      if (tab) tab.click();
    }

    function addSourceToActive() {
      // Need an active draft to attach the source to
      let targetDocId = null;
      if (typeof tabs.active === 'string' && tabs.active.indexOf('__') !== 0) targetDocId = tabs.active;
      if (!targetDocId) {
        const docs = Store.listDocuments(ws_id);
        targetDocId = docs[0] && docs[0].id;
      }
      if (!targetDocId) {
        // No drafts in the workspace yet — make one first, then prompt for source
        newDraft().then(() => addSourceToActive());
        return;
      }
      openAddSourceModal(targetDocId);
    }

    function openAddSourceModal(target_doc_id) {
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      let mode = 'file';
      const fileTab = el('button.ghost.active', { onClick: () => setMode('file') }, icon('file-arrow-up'), ' FILE');
      const urlTab = el('button.ghost', { onClick: () => setMode('url') }, icon('globe'), ' URL');
      const tabs = el('div', { style: { display: 'flex', gap: '6px', marginBottom: '12px' } }, fileTab, urlTab);

      const dropzone = el('div', { style: { border: '2px dashed var(--border-2)', padding: '32px', textAlign: 'center', fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-dim)', cursor: 'pointer', borderRadius: '6px' } },
        icon('cloud-arrow-up', 28),
        el('div', { style: { marginTop: '8px' } }, 'Drop files here, or click to choose'),
        el('div', { style: { fontSize: '11px', color: 'var(--ink-faint)', marginTop: '4px' } }, 'PDF · DOCX · Image · Audio · Video · Any file'),
      );
      dropzone.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true;
        inp.onchange = async () => {
          for (const f of inp.files) await Store.uploadSource(target_doc_id, f, {});
          scrim.remove(); renderSidebar();
          DOM.toast('UPLOADED', inp.files.length + ' source' + (inp.files.length === 1 ? '' : 's') + ' added');
        };
        inp.click();
      });
      dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; });
      dropzone.addEventListener('dragleave', () => dropzone.style.borderColor = '');
      dropzone.addEventListener('drop', async (e) => {
        e.preventDefault(); dropzone.style.borderColor = '';
        for (const f of e.dataTransfer.files) await Store.uploadSource(target_doc_id, f, {});
        scrim.remove(); renderSidebar();
        DOM.toast('UPLOADED', e.dataTransfer.files.length + ' source(s) added');
      });

      const urlInput = el('input', { type: 'url', placeholder: 'https://example.com/article' });
      const urlStatus = el('div', { style: { fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)', minHeight: '14px', marginTop: '8px' } });
      const urlGo = el('button.primary', { onClick: doImport }, 'Snapshot');
      async function doImport() {
        const u = urlInput.value.trim();
        if (!u) { urlInput.focus(); return; }
        urlStatus.textContent = 'Fetching via proxy…';
        urlGo.disabled = true;
        try {
          const meta = await Store.importFromUrl(target_doc_id, u);
          DOM.toast('SNAPSHOT', meta.title);
          scrim.remove(); renderSidebar();
        } catch (e) {
          urlStatus.textContent = 'Error: ' + (e.message || e);
          urlGo.disabled = false;
        }
      }
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
      const urlBox = el('div', { style: { display: 'none' } },
        el('label', 'Page URL'),
        el('div', { style: { display: 'flex', gap: '8px' } }, urlInput, urlGo),
        urlStatus,
        el('div', { style: { fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '10px', lineHeight: 1.5 } },
          'Fetched server-side via the n8n feed proxy, sanitised, and stored as an HTML snapshot. Archive it to archive.org when ready to publish.'),
      );

      function setMode(m) {
        mode = m;
        fileTab.classList.toggle('active', m === 'file');
        urlTab.classList.toggle('active', m === 'url');
        dropzone.style.display = m === 'file' ? '' : 'none';
        urlBox.style.display = m === 'url' ? '' : 'none';
        if (m === 'url') setTimeout(() => urlInput.focus(), 30);
      }

      const targetDoc = Store.getDocument(target_doc_id);
      const modal = el('div.modal', { style: { width: 'min(560px, 96vw)' }, onClick: (e) => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Add source'), el('div.sub', 'Attaching to: ' + (targetDoc && targetDoc.title || 'a draft'))), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body', tabs, dropzone, urlBox),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
    }

    function renderTabs() {
      clear(tabbar);
      const inner = el('div.tabs-inner');
      for (const id of tabs.open) {
        let label, ic;
        if (id === '__corkboard__') {
          label = 'Corkboard'; ic = 'squares-four';
        } else if (typeof id === 'string' && id.indexOf('__src__:') === 0) {
          const parts = id.split(':'); const did = parts[1], sid = parts[2];
          const s = Store.getSource(did, sid);
          if (!s) continue;
          label = s.title || s.filename; ic = s.source_url ? 'globe' : 'file';
        } else {
          const d = Store.getDocument(id);
          if (!d) continue;
          label = d.title || 'Untitled'; ic = 'file-text';
        }
        const isActive = id === tabs.active;
        const tab = el('div.ws-tab' + (isActive ? '.active' : ''),
          { onClick: () => { tabs.active = id; saveTabs(); renderTabs(); renderContent(); renderSidebar(); },
            onContextmenu: (e) => {
              if (typeof id === 'string' && (id.startsWith('__'))) return;
              e.preventDefault();
              const doc = Store.getDocument(id); if (doc) docMenu(e, doc);
            },
          },
          el('span.ico', icon(ic)),
          el('span.name', label),
          el('span.close', { onClick: (e) => { e.stopPropagation(); closeTab(id); } }, icon('x')),
        );
        inner.appendChild(tab);
      }
      const plus = el('button.ws-tab-plus', { onClick: newDraft, title: 'New draft' }, icon('plus'));
      inner.appendChild(plus);
      tabbar.appendChild(inner);
    }

    function openDoc(doc_id) {
      if (!tabs.open.includes(doc_id)) tabs.open.push(doc_id);
      tabs.active = doc_id;
      saveTabs();
      renderTabs();
      renderContent();
      renderSidebar();
    }

    function closeTab(doc_id) {
      tabs.open = tabs.open.filter(x => x !== doc_id);
      if (tabs.open.length === 0) {
        const all = Store.listDocuments(ws_id);
        if (all.length > 0) tabs.open = [all[0].id];
        else { newDraft(); return; }
      }
      if (!tabs.open.includes(tabs.active)) tabs.active = tabs.open[tabs.open.length - 1];
      saveTabs();
      renderTabs();
      renderContent();
      renderSidebar();
    }

    async function newDraft() {
      const d = await Store.createDocument(ws_id, { title: 'Untitled draft', dek: '' });
      openDoc(d.id);
    }

    function invite() {
      if (window.WorkspaceView && window.WorkspaceView.openInvite) {
        window.WorkspaceView.openInvite(ws, app, () => { ws = Store.getWorkspace(ws_id); renderSidebar(); });
      }
    }

    function docMenu(e, d) {
      const menu = el('div.context-menu', { style: { left: e.clientX + 'px', top: e.clientY + 'px' } },
        el('div', { onClick: () => { closeMenu(); openDoc(d.id); } }, icon('eye'), ' Open'),
        el('div', { onClick: () => { closeMenu(); renameDraft(d); } }, icon('pencil-simple'), ' Rename'),
        el('div', { onClick: () => { closeMenu(); duplicateDraft(d); } }, icon('copy'), ' Duplicate'),
        el('div', { onClick: () => { closeMenu(); makeSourceFromDraft(d); } }, icon('paperclip'), ' Make a source from this draft'),
        el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }),
        el('div', { onClick: async () => { closeMenu(); const ok = await DOM.confirmDialog({ title: 'Delete draft?', body: 'Delete "' + d.title + '"? Cannot be undone.', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true }); if (ok) { await Store.deleteDocument(d.id); closeTab(d.id); } }, style: { color: 'var(--err)' } }, icon('trash'), ' Delete'),
      );
      document.body.appendChild(menu);
      const closeMenu = () => menu.remove();
      setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
    }

    // Snapshot the current state of a draft and stash it as a citable source
    // (an .html snapshot) in another doc the user picks.
    async function makeSourceFromDraft(d) {
      const all = Store.listDocuments(ws_id).filter(x => x.id !== d.id);
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '50vh', overflowY: 'auto', marginTop: '10px' } });
      if (all.length === 0) {
        list.appendChild(el('div', { style: { padding: '20px', textAlign: 'center', color: 'var(--ink-faint)', border: '1px dashed var(--border)', fontFamily: 'var(--sans)', fontSize: '13px' } }, 'No other drafts in this workspace. Create one first to cite this draft from.'));
      } else {
        for (const target of all) {
          list.appendChild(el('button', { style: { textAlign: 'left', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px', alignItems: 'center' }, onClick: async () => {
            scrim.remove();
            await snapshotDraftIntoDoc(d, target.id);
          } },
            el('div', { style: { width: '28px', height: '28px', display: 'grid', placeItems: 'center', background: 'var(--accent-deep)', color: 'var(--accent-soft)', fontFamily: 'var(--mono)', fontSize: '10px' } }, '§'),
            el('div',
              el('div', { style: { fontWeight: 600, color: 'var(--ink)' } }, target.title || 'Untitled'),
              el('div', { style: { fontSize: '11px', color: 'var(--ink-faint)', marginTop: '2px' } }, 'v' + target.version + ' · ' + DOM.fmtTimeAgo(target.updated_at)),
            ),
          ));
        }
      }
      const modal = el('div.modal', { onClick: e => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Make "' + d.title + '" a source'), el('div.sub', 'Snapshot this draft (v' + d.version + ') and attach it as a source on another draft')), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body', list),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
    }

    async function snapshotDraftIntoDoc(srcDoc, target_doc_id) {
      const html = renderDraftAsHTML(srcDoc);
      const blob = new Blob([html], { type: 'text/html' });
      const filename = (srcDoc.title || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '-v' + srcDoc.version + '.html';
      const file = new File([blob], filename, { type: 'text/html' });
      const meta = await Store.uploadSource(target_doc_id, file, {
        title: srcDoc.title + ' (DraftEO snapshot · v' + srcDoc.version + ')',
        description: 'Snapshot of DraftEO draft "' + srcDoc.title + '" at version ' + srcDoc.version + '.',
        tags: ['drafteo-snapshot'],
        source_draft_id: srcDoc.id,
        source_draft_version: srcDoc.version,
      });
      DOM.toast('SOURCE CREATED', 'Snapshot of "' + srcDoc.title + '" attached.', 4500);
      // Switch to that target doc to show the new source
      openDoc(target_doc_id);
    }

    function renderDraftAsHTML(d) {
      const sources = Store.listSources(d.id);
      const { html } = window.MD.render(d.body_markdown || '', sources);
      return '<!doctype html><html><head><meta charset="utf-8"><title>' + (d.title || 'Draft') + '</title></head><body>'
        + '<h1>' + (d.title || 'Draft') + '</h1>'
        + (d.dek ? '<p><em>' + d.dek + '</em></p>' : '')
        + html
        + '</body></html>';
    }

    async function renameDraft(d) {
      const t = prompt('New title for "' + d.title + '"', d.title);
      if (!t || !t.trim()) return;
      await Store.saveDocument(d.id, { title: t.trim() }, { eo_operator: 'DEF', site: 'title', resolution: 'Renamed to "' + t.trim() + '"' });
      renderSidebar(); renderTabs();
      if (d.id === tabs.active) renderContent();
    }

    async function duplicateDraft(d) {
      const copy = await Store.createDocument(ws_id, { title: d.title + ' (copy)', dek: d.dek || '' });
      await Store.saveDocument(copy.id, { body_markdown: d.body_markdown || '' }, { eo_operator: 'DEF', site: 'document', resolution: 'Duplicated from ' + d.title });
      openDoc(copy.id);
    }

    function openCorkboard() {
      // Use the active content area to host the corkboard view, replacing the editor.
      tabs.active = '__corkboard__';
      renderTabs();
      clear(content);
      content.appendChild(window.Corkboard.open(ws_id, app));
    }

    function openSource(doc_id, source_id) {
      const key = '__src__:' + doc_id + ':' + source_id;
      if (!tabs.open.includes(key)) tabs.open.push(key);
      tabs.active = key;
      saveTabs();
      renderTabs();
      renderContent();
      renderSidebar();
    }

    let currentEditor = null;
    function renderContent() {
      clear(content);
      if (tabs.active === '__corkboard__') {
        content.appendChild(window.Corkboard.open(ws_id, app));
        return;
      }
      if (typeof tabs.active === 'string' && tabs.active.indexOf('__src__:') === 0) {
        const parts = tabs.active.split(':');
        const did = parts[1], sid = parts[2];
        content.appendChild(window.SourceViewer.open(did, sid, ws_id, app));
        return;
      }
      if (!tabs.active) {
        content.appendChild(el('div', { style: { flex: 1, display: 'grid', placeItems: 'center', padding: '40px', background: 'var(--surface)' } },
          el('div', { style: { textAlign: 'center', maxWidth: '440px' } },
            el('div', { style: { fontFamily: 'var(--display)', fontSize: '64px', color: 'var(--accent-deep)', lineHeight: 1, marginBottom: '14px', fontStyle: 'italic' } }, '§'),
            el('div', { style: { fontFamily: 'var(--display)', fontSize: '24px', fontWeight: 700, color: 'var(--ink)', marginBottom: '8px' } }, 'No drafts in this workspace yet.'),
            el('div', { style: { fontFamily: 'var(--sans)', fontSize: '14px', color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: '20px' } },
              'A workspace holds related drafts and the sources they cite. Start a fresh draft to begin writing.'),
            el('button.primary', { onClick: newDraft, style: { padding: '11px 20px', fontSize: '14px', fontWeight: 600 } }, '+ New draft'),
          ),
        ));
        return;
      }
      currentEditor = window.EditorView.mountInto(content, ws_id, tabs.active, app, {
        onSaved: () => { renderSidebar(); renderTabs(); },
        embedded: true,
      });
    }

    renderSidebar();
    renderTabs();
    renderContent();
    mount(document.getElementById('root'), shell);
  }

  function workspaceHeader(ws, app, refresh) {
    return el('div.ws-header',
      el('div.ws-title',
        el('div.ws-eyebrow', icon('folder-open'), ' WORKSPACE'),
        el('div.ws-name', ws.title),
        ws.description ? el('div.ws-desc', ws.description) : null,
      ),
      el('div.ws-meta',
        el('span.tag-status.ok', icon('lock-key'), ' E2EE'),
        el('span.tag-status', ws.members.length + ' MEMBER' + (ws.members.length === 1 ? '' : 'S')),
      ),
      el('button.ghost.ws-settings', { onClick: () => openSettings(ws, app, refresh) }, icon('gear'), ' SETTINGS'),
    );
  }

  function openSettings(ws, app, refresh) {
    if (window.WorkspaceView && window.WorkspaceView.openSettings) {
      window.WorkspaceView.openSettings(ws, app, refresh);
    }
  }

  function themeIcon() {
    const t = document.documentElement.dataset.theme;
    const i = document.createElement('i');
    i.className = 'ph ph-' + (t === 'light' ? 'sun' : 'moon-stars');
    return i;
  }

  function icon(name) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    return i;
  }

  function initials(mid) {
    const name = (mid || '').replace(/^@/, '').split(':')[0];
    return (name.slice(0, 2) || '??').toUpperCase();
  }

  window.WorkspaceShell = { render };
})();
