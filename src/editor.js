// ============ EDITOR ============
// Three modes: edit / suggest / comment. Edit is direct writing;
// suggest produces tracked-change proposals; comment attaches a thread
// to a span of text. Citations are pill chips ({{cite:ID}} in markdown),
// inserted via slash command or by dragging a source from the sidebar.
//
// Save is debounced (5min idle) + Cmd+S + on-blur. Every save runs the
// EO classifier and appends one timeline event.

(function () {
  const { el, mount, clear, debounce } = window.DOM;

  // ============ stage pill + overflow menu + checkpoint prompts ============
  const STAGE_LABELS = {
    drafting:  { label: 'Drafting',     dot: '#a37820', tone: 'warn' },
    reporting: { label: 'Reporting',    dot: '#7aa5c8', tone: 'info' },
    editing:   { label: 'Editing',      dot: '#c47a2b', tone: 'accent' },
    ready:     { label: 'Ready',        dot: '#4f7a44', tone: 'ok'   },
    published: { label: 'Published',    dot: '#6b675c', tone: 'mute' },
  };

  function buildStagePill(doc_id, doc, onChange) {
    function paint(btn, stage) {
      const lbl = STAGE_LABELS[stage] || STAGE_LABELS.drafting;
      btn.innerHTML = '';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + lbl.dot + ';display:inline-block;';
      const txt = document.createElement('span');
      txt.textContent = lbl.label;
      const ch = document.createElement('i');
      ch.className = 'ph ph-caret-down';
      ch.style.fontSize = '10px';
      ch.style.marginLeft = '4px';
      btn.appendChild(dot); btn.appendChild(txt); btn.appendChild(ch);
    }
    const btn = el('button.ghost.stage-pill', { onClick: openMenu, title: 'Document stage' });
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-family:var(--sans);font-size:12px;font-weight:500;border:1px solid var(--border);border-radius:14px;background:var(--chrome-2);color:var(--ink);';
    paint(btn, doc.stage || 'drafting');

    function openMenu(e) {
      e && e.stopPropagation && e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      const menu = el('div.context-menu', { style: { left: (rect.left) + 'px', top: (rect.bottom + 4) + 'px', minWidth: '180px' } });
      for (const s of Store.STAGES) {
        const lbl = STAGE_LABELS[s];
        menu.appendChild(el('div', { onClick: async () => { menu.remove(); await Store.setStage(doc_id, s); doc.stage = s; paint(btn, s); onChange && onChange(); } },
          el('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: lbl.dot, display: 'inline-block' } }),
          el('span', lbl.label),
        ));
      }
      document.body.appendChild(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    }
    return { node: btn, refresh: () => paint(btn, (Store.getDocument(doc_id) || {}).stage || 'drafting') };
  }

  function buildOverflowMenu(doc_id, app, embedded, actions) {
    const btn = el('button.ghost.iconbtn', { title: 'More', onClick: open });
    btn.appendChild(icon('dots-three'));
    function open(e) {
      e && e.stopPropagation && e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      const menu = el('div.context-menu', { style: { right: '14px', top: (rect.bottom + 4) + 'px', minWidth: '220px' } });
      function row(ic, text, onClick, sub) {
        return el('div', { onClick: () => { menu.remove(); onClick(); } },
          icon(ic),
          el('div', el('div', text), sub ? el('div', { style: { fontSize: '11px', color: 'var(--ink-faint)' } }, sub) : null),
        );
      }
      menu.appendChild(row('star', 'Save checkpoint…', actions.saveCheckpoint, 'Pin this version with a name'));
      menu.appendChild(row('clock-counter-clockwise', 'Edit history', actions.openHistory));
      menu.appendChild(row('export', 'Export', actions.openExport, 'Markdown or HTML'));
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      const m = actions.getMode();
      menu.appendChild(row(m === 'edit' ? 'check' : 'pencil-simple', 'Edit mode' + (m === 'edit' ? ' ✓' : ''), () => actions.setMode('edit')));
      menu.appendChild(row(m === 'suggest' ? 'check' : 'git-pull-request', 'Suggest mode' + (m === 'suggest' ? ' ✓' : ''), () => actions.setMode('suggest')));
      menu.appendChild(row(m === 'comment' ? 'check' : 'chat-circle-dots', 'Comment mode' + (m === 'comment' ? ' ✓' : ''), () => actions.setMode('comment')));
      document.body.appendChild(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    }
    return { node: btn };
  }

  function promptCheckpoint(doc_id, onDone) {
    const name = prompt('Name this checkpoint:\n(e.g. "Pre-edit draft", "Ready for legal review")');
    if (!name) return;
    Store.createCheckpoint(doc_id, name).then(() => {
      DOM.toast('CHECKPOINT', '⭐ ' + name);
      onDone && onDone();
    });
  }

  function buildPage(ws_id, doc_id, app, opts) {
    opts = opts || {};
    const host = opts.host || document.getElementById('root');
    const embedded = !!opts.embedded;
    const onSaved = opts.onSaved || (() => {});
    const doc = Store.getDocument(doc_id);
    const ws = Store.getWorkspace(ws_id);
    if (!doc || !ws) { mount(host, el('div', { style: { padding: '40px', color: 'var(--ink-faint)' } }, 'Document not found.')); return; }

    // ---- state ----
    let mode = 'edit';
    let dirty = false;
    let lastSavedMarkdown = doc.body_markdown || '';
    let previewingVersion = null;
    let currentSelection = null;
    let sourceRefresh = null;
    let commentRefresh = null;
    let scrubberRebuild = null;

    // ---- DOM ----
    const titleInput = el('input.titleinput', { type: 'text', value: doc.title, onInput: () => markDirty() });
    const dekInput = el('input.dekinput', { type: 'text', placeholder: 'Standfirst / dek (optional)', value: doc.dek || '', onInput: () => markDirty() });

    const body = el('div.body', { contentEditable: 'true', spellcheck: 'true' });
    body.setAttribute('data-placeholder', 'Start writing. Type / for sources, citations, and blocks. Highlight text to comment or suggest.');

    const wordCountEl = el('span');
    const statusEl = el('div.statusdot.saved', el('span.dot'), el('span', 'SAVED'));

    const formatBar = buildFormatBar(body);
    const slashMenu = buildSlashMenu(doc_id, () => sourceRefresh && sourceRefresh());
    body.appendChild(slashMenu.node);

    // ---- page (writing surface) ----
    const page = el('div.page',
      el('input.titleinput', { /* placeholder visual */ }),  // re-anchored below
      titleInput,
      dekInput,
      body,
    );
    // remove placeholder anchor
    page.removeChild(page.firstChild);

    // ---- sidebar (tabs: sources + comments) ----
    const sourcesPanel = window.SourcePanel.build(doc_id, {
      insertCitation: (sid) => insertCitation(sid),
      refreshSources: () => { sourcesPanel.refresh(); render(); },
    });
    sourceRefresh = () => { sourcesPanel.refresh(); render(); };

    const commentsListEl = el('div.cmtlist');
    const commentsPanel = el('div.commentspanel',
      el('div.head',
        el('h3', 'Comments & suggestions'),
        el('div', el('span.count', '0'))
      ),
      commentsListEl,
    );

    const tabSources = el('button.tab.active', { onClick: () => setTab('sources') },
      icon('files'), ' SOURCES'
    );
    const tabComments = el('button.tab', { onClick: () => setTab('comments') },
      icon('chat-circle-text'), ' COMMENTS'
    );
    const sidebarTabs = el('div.sidebar-tabs', tabSources, tabComments);

    const sidebar = el('div.sidebar', sidebarTabs, sourcesPanel.node);

    function setTab(name) {
      tabSources.classList.toggle('active', name === 'sources');
      tabComments.classList.toggle('active', name === 'comments');
      clear(sidebar);
      sidebar.appendChild(sidebarTabs);
      sidebar.appendChild(name === 'sources' ? sourcesPanel.node : commentsPanel);
      if (name === 'comments' && commentRefresh) commentRefresh();
    }

    // ---- editor header (minimal: dot, stage pill, ··· menu) ----
    const stagePill = buildStagePill(doc_id, doc, () => { onSaved(); });
    const overflowMenu = buildOverflowMenu(doc_id, app, embedded, {
      openHistory: () => HistoryBar.openPanel(doc_id, externalEditor()),
      openExport: () => Exporter.openModal(doc_id),
      saveCheckpoint: () => promptCheckpoint(doc_id, () => { onSaved(); if (scrubberRebuild) scrubberRebuild(); }),
      setMode: (m) => setMode(m),
      getMode: () => mode,
    });
    const editorHeader = el('div.editorheader' + (embedded ? '.embedded' : ''),
      el('div.left'),
      el('div.center'),
      el('div.right',
        statusEl,
        stagePill.node,
        overflowMenu.node,
        embedded ? null : el('button.ghost', { onClick: () => app.toggleTheme(), title: 'Toggle theme', dataset: { themeToggle: '1' } }, icon('moon-stars')),
      ),
    );

    // ---- (hidden) mode pills — referenced by setMode but not rendered ----
    const modeEdit = document.createElement('button');
    const modeSuggest = document.createElement('button');
    const modeComment = document.createElement('button');

    // ---- mode banner (rendered but only shown when not in edit) ----
    const modeBanner = el('div.mode-banner', el('span.dot'), el('span'));
    function setMode(m) {
      mode = m;
      modeEdit.classList.toggle('active', m === 'edit');
      modeSuggest.classList.toggle('active', m === 'suggest');
      modeComment.classList.toggle('active', m === 'comment');
      body.classList.remove('mode-edit', 'mode-suggest', 'mode-comment');
      body.classList.add('mode-' + m);
      modeBanner.classList.remove('edit', 'suggest', 'comment');
      modeBanner.classList.add(m);
      const label = m === 'edit' ? 'Editing — your changes save directly.'
        : m === 'suggest' ? 'Suggesting — your edits become proposals others can accept or reject.'
        : 'Commenting — highlight any text to leave a comment.';
      modeBanner.querySelector('span:last-child').textContent = label;
      body.contentEditable = previewingVersion != null ? 'false' : (m === 'edit' ? 'true' : 'false');
    }

    // ---- scrubber bar (built after editorHandle) ----
    let scrubberBar = null;

    // ---- compose layout (no always-visible format bar; selection toolbar floats in instead) ----
    const gutter = el('div.gutter');
    const selToolbar = el('div.sel-toolbar', { style: { display: 'none' } });
    const container = el('div.editor',
      editorHeader,
      el('div.editorbody',
        el('div.pagewrap', el('div.pageinner', modeBanner, page, gutter, selToolbar)),
        sidebar,
      ),
    );

    // ---- save logic ----
    const doSave = async () => {
      if (previewingVersion != null) return;
      if (!dirty) return;
      const newMd = window.MD.fromDom(body);
      const newTitle = titleInput.value.trim() || 'Untitled draft';
      const newDek = dekInput.value;
      if (newMd === lastSavedMarkdown && doc.title === newTitle && (doc.dek || '') === newDek) {
        dirty = false; setStatus('saved');
        return;
      }
      setStatus('saving');
      const entry = window.EO.classify(lastSavedMarkdown, newMd);
      const updated = await Store.saveDocument(doc_id, {
        body_markdown: newMd, title: newTitle, dek: newDek,
      }, { eo_operator: entry.op, site: entry.site, resolution: entry.resolution });
      Object.assign(doc, updated);
      lastSavedMarkdown = newMd;
      dirty = false;
      setStatus('saved');
      if (scrubberRebuild) scrubberRebuild();
    };
    const debouncedSave = debounce(doSave, 4500); // safety net (well under 5 min for the prototype)
    function markDirty() { dirty = true; setStatus('dirty'); debouncedSave(); }

    // ---- selection-driven floating toolbar (Medium/Notion style) ----
    function placeSelToolbar() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !body.contains(sel.anchorNode)) {
        selToolbar.style.display = 'none';
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { selToolbar.style.display = 'none'; return; }
      const wrapRect = page.parentElement.getBoundingClientRect();
      selToolbar.style.display = 'flex';
      selToolbar.style.left = Math.max(8, rect.left + rect.width / 2 - wrapRect.left - selToolbar.offsetWidth / 2) + 'px';
      selToolbar.style.top = Math.max(8, rect.top - wrapRect.top - selToolbar.offsetHeight - 8) + 'px';
    }
    function exec(cmd, arg) {
      body.focus();
      document.execCommand(cmd, false, arg);
      body.dispatchEvent(new Event('input', { bubbles: true }));
      placeSelToolbar();
    }
    function block(tag) {
      body.focus();
      document.execCommand('formatBlock', false, tag);
      body.dispatchEvent(new Event('input', { bubbles: true }));
      placeSelToolbar();
    }
    selToolbar.appendChild(el('button', { title: 'Heading 2', onMousedown: (e) => { e.preventDefault(); block('H2'); } }, icon('text-h')));
    selToolbar.appendChild(el('button', { title: 'Bold (⌘B)', onMousedown: (e) => { e.preventDefault(); exec('bold'); } }, icon('text-b')));
    selToolbar.appendChild(el('button', { title: 'Italic (⌘I)', onMousedown: (e) => { e.preventDefault(); exec('italic'); } }, icon('text-italic')));
    selToolbar.appendChild(el('button', { title: 'Strikethrough', onMousedown: (e) => { e.preventDefault(); exec('strikeThrough'); } }, icon('text-strikethrough')));
    selToolbar.appendChild(el('button', { title: 'Inline code', onMousedown: (e) => { e.preventDefault(); wrapInline('code'); } }, icon('code')));
    selToolbar.appendChild(el('div.sep'));
    selToolbar.appendChild(el('button', { title: 'Bulleted list', onMousedown: (e) => { e.preventDefault(); exec('insertUnorderedList'); } }, icon('list-bullets')));
    selToolbar.appendChild(el('button', { title: 'Numbered list', onMousedown: (e) => { e.preventDefault(); exec('insertOrderedList'); } }, icon('list-numbers')));
    selToolbar.appendChild(el('button', { title: 'Blockquote', onMousedown: (e) => { e.preventDefault(); block('BLOCKQUOTE'); } }, icon('quotes')));
    selToolbar.appendChild(el('button', { title: 'Link', onMousedown: (e) => { e.preventDefault(); const u = prompt('Link URL'); if (u) exec('createLink', u); } }, icon('link')));
    selToolbar.appendChild(el('div.sep'));
    selToolbar.appendChild(el('button.accent', { title: 'Cite from sources', onMousedown: (e) => { e.preventDefault(); openCitePicker(); } }, icon('quotes'), el('span', ' Cite')));
    selToolbar.appendChild(el('button.accent', { title: 'Save selection as quote from new source (URL snapshot)', onMousedown: (e) => { e.preventDefault(); openGrabFromUrl(); } }, icon('link-simple'), el('span', ' From URL')));
    selToolbar.appendChild(el('div.sep'));
    selToolbar.appendChild(el('button', { title: 'Comment on this selection', onMousedown: (e) => { e.preventDefault(); const sel = window.getSelection(); if (sel && !sel.isCollapsed) openCommentPopover({ text: sel.toString(), range: sel.getRangeAt(0).cloneRange() }); } }, icon('chat-circle-text')));
    selToolbar.appendChild(el('button', { title: 'Suggest an edit', onMousedown: (e) => { e.preventDefault(); const sel = window.getSelection(); if (sel && !sel.isCollapsed) openSuggestPopover({ text: sel.toString(), range: sel.getRangeAt(0).cloneRange() }); } }, icon('git-pull-request')));

    // Helper to wrap inline-tag (used for inline <code>) — execCommand has
    // no direct command for it, so we do it manually with a Range.
    function wrapInline(tag) {
      body.focus();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const wrap = document.createElement(tag);
      try {
        wrap.appendChild(range.extractContents());
        range.insertNode(wrap);
        sel.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(wrap);
        sel.addRange(r);
        body.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (_) {}
    }

    document.addEventListener('selectionchange', () => {
      if (document.activeElement === titleInput || document.activeElement === dekInput) return;
      placeSelToolbar();
    });
    page.parentElement.addEventListener('scroll', placeSelToolbar, { passive: true });

    function openCitePicker() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const draftQuote = sel.toString();
      const range = sel.getRangeAt(0).cloneRange();
      const sources = Store.listSources(doc_id);
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });

      let chosen = null;
      const searchInp = el('input', { type: 'text', placeholder: 'Filter sources by title, tag, filename, URL…', style: { marginBottom: '10px' } });
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '36vh', overflowY: 'auto', marginBottom: '14px' } });
      const pageInp = el('input', { type: 'text', placeholder: 'p. 7  ·  Exhibit C  ·  rows 12–58' });
      const passageTa = el('textarea', { rows: 3, placeholder: 'Click an exhibit below — or type/paste the passage directly.' });

      // If user "Use as passage"d a span from the source viewer, prefill it
      // and show a small banner so they know it's been pulled in.
      const stagedPassage = window.__stagedPassage || '';
      const stagedBanner = stagedPassage
        ? el('div.staged-banner',
            icon('scissors', 12),
            el('span', { style: { fontFamily: 'var(--mono)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em' } }, 'Staged from source — '),
            el('span', { style: { color: 'var(--ink-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              '"' + stagedPassage.slice(0, 80) + (stagedPassage.length > 80 ? '…' : '') + '"'),
            el('button.ghost', {
              style: { padding: '2px 8px', fontSize: '11px' },
              onClick: () => { passageTa.value = ''; stagedBanner.remove(); window.__stagedPassage = null; renderPreview(); },
            }, 'Clear'),
          )
        : null;
      if (stagedPassage) passageTa.value = stagedPassage;
      const noteInp = el('input', { type: 'text', placeholder: 'Optional internal note (won\'t be published)' });
      const previewBox = el('div.cite-preview');

      // Unified "find passage" picker — searches BOTH saved exhibits AND the
      // source's plaintext. Results render as a clean two-section table.
      const exhSearch = el('input', { type: 'text', placeholder: 'Search saved exhibits and inside the source text…' });
      const exhList = el('div.cite-exh-list');
      const exhWrap = el('div.cite-exh-wrap', { style: { display: 'none' } },
        el('div.cite-exh-head',
          icon('magnifying-glass', 12),
          el('span', 'Find a passage'),
          el('span.cite-exh-count', ''),
        ),
        exhSearch,
        exhList,
      );

      function exhibitsForChosen() {
        if (!chosen) return [];
        const ws_id = window.__currentWs;
        if (!ws_id) return [];
        const all = Store.listExhibits(ws_id);
        const tied = all.filter(e => e.source_id === chosen.source_id);
        const other = all.filter(e => e.source_id !== chosen.source_id);
        return [...tied, ...other];
      }

      // Search inside the source's plaintext for matches. Returns
      // [{ snippet, offset }] where snippet has ~80 chars of context
      // around the match.
      function searchInSource(q) {
        if (!chosen || !q || q.length < 2) return [];
        const txt = chosen.plaintext || '';
        if (!txt) return [];
        const needle = q.toLowerCase();
        const lower = txt.toLowerCase();
        const hits = [];
        let i = 0;
        while (i < lower.length && hits.length < 25) {
          const idx = lower.indexOf(needle, i);
          if (idx < 0) break;
          const before = txt.slice(Math.max(0, idx - 60), idx);
          const match = txt.slice(idx, idx + needle.length);
          const after = txt.slice(idx + needle.length, idx + needle.length + 100);
          hits.push({ before, match, after, offset: idx });
          i = idx + needle.length;
        }
        return hits;
      }

      function renderExhibits(q) {
        clear(exhList);
        exhWrap.style.display = chosen ? '' : 'none';
        if (!chosen) return;
        const needle = (q || '').toLowerCase().trim();

        // ---- saved exhibits ----
        let exhibits = exhibitsForChosen();
        if (needle) {
          exhibits = exhibits.filter(ex => {
            const h = [ex.label, ex.text, ex.note, (ex.tags || []).join(' '), ex.provenance && ex.provenance.source_title].filter(Boolean).join(' ').toLowerCase();
            return h.includes(needle);
          });
        }

        // ---- in-source matches ----
        const srcHits = needle ? searchInSource(needle) : [];

        const totalCount = exhibits.length + srcHits.length;
        const count = exhWrap.querySelector('.cite-exh-count');
        if (count) count.textContent = totalCount ? String(totalCount) : (needle ? '0' : '');

        if (totalCount === 0) {
          if (needle) {
            exhList.appendChild(el('div.cite-exh-empty',
              el('div', 'No matches in saved exhibits or source text.'),
              el('div', { style: { marginTop: '4px', fontSize: '11px', color: 'var(--ink-faint)' } },
                'Try a shorter query, or type your passage in the field above.'),
            ));
          } else if (exhibitsForChosen().length === 0) {
            exhList.appendChild(el('div.cite-exh-empty',
              el('div', 'No saved exhibits in this workspace yet.'),
              el('div', { style: { marginTop: '4px', fontSize: '11px', color: 'var(--ink-faint)' } },
                'Type a query above to search the source text, or open the source and right-click to save exhibits.'),
            ));
          } else {
            exhList.appendChild(el('div.cite-exh-empty',
              'Type a query to filter exhibits or search inside the source.'));
          }
          return;
        }

        // ---- table ----
        const table = el('div.cite-table');

        if (exhibits.length > 0) {
          table.appendChild(el('div.cite-table-section', 'Saved exhibits (' + exhibits.length + ')'));
          for (const ex of exhibits) {
            const tied = ex.source_id === chosen.source_id;
            const txt = (ex.text || '').slice(0, 200);
            table.appendChild(el('button.cite-row',
              { type: 'button', onClick: () => pickExhibit(ex) },
              el('div.cite-cell.cite-cell-ico', icon('scissors', 13)),
              el('div.cite-cell.cite-cell-quote',
                el('div.cite-quote-text', highlight(txt + (ex.text && ex.text.length > 200 ? '…' : ''), needle)),
                ex.label ? el('div.cite-quote-label', ex.label) : null,
              ),
              el('div.cite-cell.cite-cell-meta',
                tied ? el('span.cite-pill.tied', 'this source') : el('span.cite-pill.cross', (ex.provenance && ex.provenance.source_title) ? ex.provenance.source_title.slice(0, 24) : 'other source'),
              ),
            ));
          }
        }

        if (srcHits.length > 0) {
          table.appendChild(el('div.cite-table-section', 'In source text (' + srcHits.length + ')'));
          for (const hit of srcHits) {
            table.appendChild(el('button.cite-row',
              { type: 'button', onClick: () => pickSourceHit(hit) },
              el('div.cite-cell.cite-cell-ico', icon('text-aa', 13)),
              el('div.cite-cell.cite-cell-quote',
                el('div.cite-quote-text',
                  hit.before ? el('span.cite-ctx', '…' + hit.before) : null,
                  el('span.cite-hit', hit.match),
                  el('span.cite-ctx', hit.after + '…'),
                ),
              ),
              el('div.cite-cell.cite-cell-meta',
                el('span.cite-pill.offset', 'char ' + hit.offset),
              ),
            ));
          }
        }

        exhList.appendChild(table);
      }

      // Lightweight highlight helper for the exhibit quote — wraps matches
      // in <span class="cite-hit"> without using innerHTML on user data.
      function highlight(text, needle) {
        if (!needle) return text;
        const out = [];
        const lower = text.toLowerCase();
        let i = 0;
        while (i < text.length) {
          const idx = lower.indexOf(needle, i);
          if (idx < 0) { out.push(text.slice(i)); break; }
          if (idx > i) out.push(text.slice(i, idx));
          out.push(el('span.cite-hit', text.slice(idx, idx + needle.length)));
          i = idx + needle.length;
        }
        return out;
      }

      function pickExhibit(ex) {
        passageTa.value = ex.text || '';
        if (ex.provenance && ex.provenance.page && !pageInp.value) pageInp.value = ex.provenance.page;
        renderPreview();
        [...exhList.querySelectorAll('.cite-row')].forEach(b => b.classList.remove('selected'));
      }
      function pickSourceHit(hit) {
        // Use a generous span — the match plus the after-text up to a
        // sentence-ish boundary (period/?/!). Lets the user click "Find" and
        // get a usable passage even without manually selecting.
        const fullAfter = (hit.after || '');
        const stop = fullAfter.search(/[.!?]\s/);
        const end = stop > 0 ? stop + 1 : Math.min(180, fullAfter.length);
        const sentenceAfter = fullAfter.slice(0, end);
        passageTa.value = (hit.match + sentenceAfter).trim();
        renderPreview();
        [...exhList.querySelectorAll('.cite-row')].forEach(b => b.classList.remove('selected'));
      }
      exhSearch.addEventListener('input', () => renderExhibits(exhSearch.value));

      function row(s) {
        return el('button', { style: { textAlign: 'left', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px', alignItems: 'center', width: '100%' }, onClick: () => { chosen = s; refreshPick(); } },
          el('div', { style: { width: '28px', height: '28px', display: 'grid', placeItems: 'center', background: 'var(--accent-deep)', color: 'var(--accent-soft)', fontFamily: 'var(--mono)', fontSize: '10px', borderRadius: '3px' } }, s.source_url ? '🌐' : DOM.fileExt(s.mime, s.filename)),
          el('div',
            el('div', { style: { fontWeight: 600, color: 'var(--ink)' } }, s.title || s.filename),
            el('div', { style: { fontSize: '11px', color: 'var(--ink-faint)', marginTop: '2px' } }, (s.archive_org_url ? '✓ Archived' : '○ Not archived') + ' · ' + (s.filename || s.source_url || '')),
          ),
        );
      }
      function render(q) {
        clear(list);
        if (sources.length === 0) {
          list.appendChild(el('div', { style: { padding: '16px', textAlign: 'center', color: 'var(--ink-faint)', border: '1px dashed var(--border)', fontFamily: 'var(--sans)', fontSize: '13px' } },
            'No sources yet. Add one in the right sidebar.'));
          return;
        }
        const needle = (q || '').toLowerCase().trim();
        const filtered = !needle ? sources : sources.filter(s => {
          const h = [s.title, s.filename, s.source_url, s.description, (s.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
          return h.includes(needle);
        });
        for (const s of filtered) {
          const r = row(s);
          if (chosen && chosen.source_id === s.source_id) r.classList.add('selected');
          list.appendChild(r);
        }
      }
      function refreshPick() {
        [...list.querySelectorAll('button')].forEach(b => b.classList.remove('selected'));
        if (chosen) {
          [...list.querySelectorAll('button')].forEach(b => {
            const t = b.querySelector('div:nth-child(2) > div:nth-child(1)');
            if (t && t.textContent === (chosen.title || chosen.filename)) b.classList.add('selected');
          });
        }
        renderPreview();
        renderExhibits('');
        exhSearch.value = '';
        submit.disabled = !chosen;
      }
      // Citation rendering mode for THIS citation. Defaults to the doc-wide
      // setting (doc.cite_default || 'inline'), but the user can override
      // per-citation in the dialog. Both export as Substack [^N] footnotes;
      // the difference is the in-editor visual: inline link vs superscript [N].
      doc.cite_default = doc.cite_default || 'inline';
      let citeMode = doc.cite_default;

      const modeInline = el('button.seg-pill' + (citeMode === 'inline' ? '.active' : ''),
        { type: 'button', onClick: () => { citeMode = 'inline'; refreshMode(); renderPreview(); } },
        icon('link', 12), 'Inline link');
      const modeFootnote = el('button.seg-pill' + (citeMode === 'footnote' ? '.active' : ''),
        { type: 'button', onClick: () => { citeMode = 'footnote'; refreshMode(); renderPreview(); } },
        icon('asterisk-simple', 12), 'Footnote');
      const modeRow = el('div.seg-row', modeInline, modeFootnote);
      function refreshMode() {
        modeInline.classList.toggle('active', citeMode === 'inline');
        modeFootnote.classList.toggle('active', citeMode === 'footnote');
      }

      function renderPreview() {
        clear(previewBox);
        if (!chosen) return;
        const archived = chosen.archive_org_url;
        const fnLine = '[^N]: ' + (chosen.title || chosen.filename)
          + (pageInp.value.trim() ? ', ' + pageInp.value.trim() : '')
          + (passageTa.value.trim() ? '. "' + passageTa.value.trim() + '"' : '')
          + (archived ? '. [Source](' + chosen.archive_org_url + ')' : ' [not yet archived]');
        // In-doc visual + export markdown
        const inlineSample = citeMode === 'inline'
          ? '… ' + (draftQuote.slice(0, 30) || 'your prose') + ' [' + (chosen.title || chosen.filename).slice(0, 28) + '](url) …'
          : '… ' + (draftQuote.slice(0, 30) || 'your prose') + '[^N] …';
        previewBox.appendChild(el('div.cite-pv-head',
          icon(citeMode === 'inline' ? 'link' : 'asterisk-simple', 11),
          el('span', citeMode === 'inline' ? 'Inline link — citation appears in flow.' : 'Footnote — appears as superscript [N] with note below.'),
        ));
        previewBox.appendChild(el('div.cite-pv-sec', 'In your draft'));
        previewBox.appendChild(el('pre.cite-pv-code', inlineSample));
        previewBox.appendChild(el('div.cite-pv-sec', 'Footnote (always emitted on export)'));
        previewBox.appendChild(el('pre.cite-pv-code', fnLine));
        if (!archived) {
          previewBox.appendChild(el('div.cite-pv-warn', icon('warning', 11), 'Source not yet preserved to archive.org. Citation URL will be added on archive.'));
        }
      }
      searchInp.addEventListener('input', () => render(searchInp.value));
      pageInp.addEventListener('input', renderPreview);
      passageTa.addEventListener('input', renderPreview);
      render('');

      const submit = el('button.primary', { onClick: () => {
        if (!chosen) return;
        attachCitation(range, chosen.source_id, draftQuote, {
          page: pageInp.value.trim(),
          supporting_quote: passageTa.value.trim(),
          note: noteInp.value.trim(),
          mode: citeMode,
        });
        window.__stagedPassage = null;
        scrim.remove();
      }, disabled: true }, 'Insert citation');

      const modal = el('div.modal', { style: { width: 'min(680px, 96vw)' }, onClick: e => e.stopPropagation() },
        el('div.m-head',
          el('div',
            el('div.ttl', 'Cite this passage'),
            el('div.sub', 'Your prose: "' + (draftQuote.length > 80 ? draftQuote.slice(0, 80) + '…' : draftQuote) + '"'),
          ),
          el('button.ghost', { onClick: () => scrim.remove() }, '✕'),
        ),
        el('div.m-body',
          el('label', 'Source'),
          searchInp,
          list,
          el('label', 'Page or location (optional)'),
          pageInp,
          el('label', 'Supporting passage from the source (optional, recommended)'),
          stagedBanner,
          passageTa,
          exhWrap,
          el('label', 'Internal note (optional, not published)'),
          noteInp,
          previewBox,
        ),
        el('div.m-foot',
          el('div', { style: { fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)' } }, 'Exports as [^N] footnote with archive.org URL on publish.'),
          el('div.actions', el('button.ghost', { onClick: () => scrim.remove() }, 'Cancel'), submit),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => searchInp.focus(), 60);
    }

    function attachCitation(range, source_id, draftQuote, opts) {
      opts = opts || {};
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      // Create a footnote entry on the document
      doc.footnotes = doc.footnotes || {};
      const fn_id = 'fn_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      const footnote = {
        source_id,
        draft_quote: draftQuote || '',
        supporting_quote: opts.supporting_quote || '',
        page: opts.page || '',
        note: opts.note || '',
        mode: opts.mode || (doc.cite_default || 'inline'),
      };
      doc.footnotes[fn_id] = footnote;
      // Build the viewer URL and wrap the selected range in an inline link.
      const source = Store.getSource(doc_id, source_id);
      const href = Store.buildCitationUrl(source, footnote);
      const a = document.createElement('a');
      a.className = 'cite-link' + (source && source.archive_org_url ? '' : ' cite-pending');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.dataset.cite = source_id;
      a.dataset.fn = fn_id;
      a.title = (source && source.title || '') + (opts.page ? ' · ' + opts.page : '') + (source && source.archive_org_url ? '' : ' (not yet archived)');
      try {
        a.appendChild(range.extractContents());
        range.insertNode(a);
      } catch (_) {
        // Fallback: insert as text after range
        a.textContent = draftQuote;
        range.collapse(false);
        range.insertNode(a);
      }
      // Move caret after the link
      range.setStartAfter(a); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
      markDirty();
      selToolbar.style.display = 'none';
    }

    function openGrabFromUrl() {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      const range = sel && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      const urlInput = el('input', { type: 'url', placeholder: 'https://example.com/article' });
      const status = el('div', { style: { fontSize: '12px', color: 'var(--ink-faint)', marginTop: '8px', minHeight: '16px' } });
      const submit = el('button.primary', { onClick: doIt }, 'Snapshot & cite');
      async function doIt() {
        const u = urlInput.value.trim();
        if (!u) { urlInput.focus(); return; }
        status.textContent = 'Fetching…'; submit.disabled = true;
        try {
          const meta = await Store.importFromUrl(doc_id, u);
          scrim.remove();
          sourcesPanel.refresh();
          if (range) attachCitation(range, meta.source_id, text);
          DOM.toast('SNAPSHOT', meta.title);
        } catch (e) {
          status.textContent = 'Error: ' + (e.message || e);
          submit.disabled = false;
        }
      }
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doIt(); });
      const modal = el('div.modal', { onClick: e => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Cite from URL'), el('div.sub', 'Snapshots the page, saves it as a source, and inserts a citation')), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body',
          text ? el('div', { style: { padding: '10px', background: 'var(--chrome-2)', borderLeft: '3px solid var(--accent)', fontStyle: 'italic', fontSize: '13px', color: 'var(--ink-dim)', marginBottom: '12px' } }, '"' + text + '"') : null,
          el('label', 'Page URL'),
          urlInput,
          status,
        ),
        el('div.m-foot', el('div'),
          el('div.actions', el('button.ghost', { onClick: () => scrim.remove() }, 'Cancel'), submit),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => urlInput.focus(), 60);
    }

    function setStatus(s) {
      statusEl.classList.remove('saved', 'dirty', 'error', 'syncing');
      statusEl.classList.add(s === 'error' ? 'error' : (s === 'saved' ? 'saved' : s === 'saving' ? 'syncing' : 'dirty'));
      // No text in the minimalist version — dot only. Title attr only.
      const txt = s === 'saved' ? 'All changes saved' : s === 'dirty' ? 'Unsaved changes' : s === 'saving' ? 'Saving…' : 'Error';
      statusEl.title = txt;
      const lbl = statusEl.querySelector('span:last-child');
      if (lbl) lbl.textContent = '';
    }

    // ---- listeners ----
    body.addEventListener('input', () => markDirty());
    body.addEventListener('blur', () => { if (dirty) doSave(); });
    titleInput.addEventListener('blur', () => { if (dirty) doSave(); });
    dekInput.addEventListener('blur', () => { if (dirty) doSave(); });
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); doSave();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirty) { e.preventDefault(); e.returnValue = ''; return ''; }
    });

    // ---- slash command (/) ----
    body.addEventListener('keyup', (e) => {
      if (e.key === '/') {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        slashMenu.openAt(rect, body.getBoundingClientRect());
      } else if (e.key === 'Escape') {
        slashMenu.close();
      }
    });

    // ---- selection handling for comment/suggest mode ----
    body.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const txt = sel.toString();
      if (!txt) return;
      currentSelection = { text: txt, range: sel.getRangeAt(0).cloneRange() };
      if (mode === 'comment') openCommentPopover(currentSelection);
      else if (mode === 'suggest') openSuggestPopover(currentSelection);
    });

    // ---- drag-source from sidebar ----
    body.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-drafteo-source')) e.preventDefault();
    });
    body.addEventListener('drop', (e) => {
      const sid = e.dataTransfer.getData('application/x-drafteo-source');
      if (sid) {
        e.preventDefault();
        const range = caretRangeFromPoint(e.clientX, e.clientY);
        if (range) {
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        }
        insertCitation(sid);
      }
    });

    function caretRangeFromPoint(x, y) {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (!p) return null;
        const r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r;
      }
      return null;
    }

    // ---- citation insertion ----
    function insertCitation(source_id) {
      // Synthesize a token in markdown, then re-render to refresh chips.
      const currentMd = window.MD.fromDom(body);
      // Insert at caret position by reading sel then mapping is tricky;
      // we instead append at caret by inserting an inline span and rerendering on save.
      const sel = window.getSelection();
      if (!sel.rangeCount || !body.contains(sel.anchorNode)) {
        // append at end of body
        const last = body.querySelector(':scope > :last-child');
        const span = makeChip(source_id);
        if (last && last.tagName !== 'PRE') last.appendChild(document.createTextNode(' '));
        if (last && last.tagName !== 'PRE') last.appendChild(span);
        else body.appendChild(el('p', span));
      } else {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const span = makeChip(source_id);
        range.insertNode(span);
        range.setStartAfter(span); range.collapse(true);
        sel.removeAllRanges(); sel.addRange(range);
      }
      markDirty();
      renumberChips();
    }

    function makeChip(source_id) {
      return el('span.cite', {
        contenteditable: 'false',
        dataset: { cite: source_id, num: '?' },
        title: 'Citation',
      }, '?');
    }

    function renumberChips() {
      const sources = Store.listSources(doc_id);
      const archivedSet = new Set(sources.filter(s => s.archive_org_url).map(s => s.source_id));
      const seen = new Map();
      let i = 1;
      for (const chip of body.querySelectorAll('.cite')) {
        const id = chip.dataset.cite;
        if (!seen.has(id)) { seen.set(id, i++); }
        const n = seen.get(id);
        chip.textContent = String(n);
        chip.dataset.num = String(n);
        if (archivedSet.has(id)) chip.classList.remove('unarchived');
        else chip.classList.add('unarchived');
      }
    }

    // ---- comment popover ----
    function openCommentPopover(selection) {
      closePopovers();
      const rect = selection.range.getBoundingClientRect();
      const quote = el('div.quote', selection.text);
      const ta = el('textarea', { placeholder: 'Leave a comment…' });
      const pop = el('div.cmt-popover', {
        style: { left: Math.min(rect.left + window.scrollX, window.innerWidth - 340) + 'px', top: (rect.bottom + window.scrollY + 6) + 'px' },
      },
        el('div.cp-head',
          el('span', 'New comment'),
          el('button.ghost', { onClick: () => pop.remove(), style: { padding: '0 4px' } }, '✕'),
        ),
        el('div.cp-body', quote, ta),
        el('div.cp-foot',
          el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)' } }, '↵ to submit'),
          el('div.actions',
            el('button.ghost', { onClick: () => pop.remove() }, 'CANCEL'),
            el('button.primary', { onClick: submit }, 'COMMENT'),
          ),
        ),
      );
      async function submit() {
        const body_text = ta.value.trim();
        if (!body_text) return;
        const anchor = wrapCommentAnchor(selection.range);
        await Store.createComment(doc_id, { anchor_id: anchor, quote: selection.text, body: body_text });
        pop.remove();
        markDirty();
        commentRefresh && commentRefresh();
      }
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
      document.body.appendChild(pop);
      setTimeout(() => ta.focus(), 30);
    }

    function wrapCommentAnchor(range) {
      const id = 'cmt_anchor_' + Math.random().toString(36).slice(2, 8);
      const wrap = el('span.commented', { dataset: { anchor: id } });
      try {
        wrap.appendChild(range.extractContents());
        range.insertNode(wrap);
      } catch (_) { /* selection across blocks — fall back to id only */ }
      return id;
    }

    // ---- suggestion popover ----
    function openSuggestPopover(selection) {
      closePopovers();
      const rect = selection.range.getBoundingClientRect();
      const proposed = el('textarea', { placeholder: 'Replacement text', value: selection.text });
      proposed.value = selection.text;
      const note = el('input', { type: 'text', placeholder: 'Optional note' });
      const pop = el('div.cmt-popover', {
        style: { left: Math.min(rect.left + window.scrollX, window.innerWidth - 340) + 'px', top: (rect.bottom + window.scrollY + 6) + 'px' },
      },
        el('div.cp-head', el('span', 'Suggest edit'),
          el('button.ghost', { onClick: () => pop.remove(), style: { padding: '0 4px' } }, '✕')),
        el('div.cp-body',
          el('div.quote', selection.text),
          proposed,
          el('div', { style: { height: '6px' } }),
          note,
        ),
        el('div.cp-foot',
          el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)' } }, 'others must accept'),
          el('div.actions',
            el('button.ghost', { onClick: () => pop.remove() }, 'CANCEL'),
            el('button.primary', { onClick: submit }, 'SUGGEST'),
          ),
        ),
      );
      async function submit() {
        const newText = proposed.value;
        if (newText === selection.text && !note.value.trim()) return;
        const anchor = 'sug_anchor_' + Math.random().toString(36).slice(2, 8);
        const span = el('span.suggest-del', { dataset: { anchor } }, selection.text);
        const ins = el('span.suggest-ins', { dataset: { anchor } }, newText);
        selection.range.deleteContents();
        selection.range.insertNode(ins);
        selection.range.insertNode(span);
        await Store.createSuggestion(doc_id, { anchor_id: anchor, original: selection.text, proposed: newText, note: note.value });
        pop.remove();
        markDirty();
        commentRefresh && commentRefresh();
      }
      document.body.appendChild(pop);
      setTimeout(() => proposed.focus(), 30);
    }

    function closePopovers() {
      for (const p of document.querySelectorAll('.cmt-popover')) p.remove();
    }

    body.addEventListener('click', (e) => {
      const c = e.target.closest && e.target.closest('.commented');
      if (c) flashGutter(c.dataset.anchor);
    });

    function flashGutter(anchor) {
      for (const g of gutter.querySelectorAll('.gcard')) {
        g.style.transform = '';
        if (g.dataset.anchor === anchor) {
          g.style.borderColor = 'var(--accent)';
          g.style.transform = 'translateX(-8px)';
          setTimeout(() => { g.style.borderColor = ''; g.style.transform = ''; }, 1200);
        }
      }
    }

    // ---- comments list renderer ----
    function renderCommentsList() {
      clear(commentsListEl);
      const comments = Store.listComments(doc_id);
      const suggestions = Store.listSuggestions(doc_id);
      commentsPanel.querySelector('.count').textContent = String(comments.length + suggestions.length);
      if (comments.length === 0 && suggestions.length === 0) {
        commentsListEl.appendChild(el('div', { style: { padding: '24px 14px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: '13px', border: '1px dashed var(--border)', margin: '8px 0' } },
          'Highlight any text and switch to COMMENT or SUGGEST mode.'));
        return;
      }
      for (const s of suggestions) commentsListEl.appendChild(suggestionCard(s));
      for (const c of comments) commentsListEl.appendChild(commentCard(c));
    }
    commentRefresh = renderCommentsList;

    function commentCard(c) {
      const replyInp = el('input', { type: 'text', placeholder: 'Reply…' });
      const node = el('div.cmtitem' + (c.resolved ? '.resolved' : ''), { dataset: { anchor: c.anchor_id } },
        el('div.head',
          el('div.who', el('span.av', initials((c.thread[0] || {}).author)), (c.thread[0] || {}).author || '—'),
          el('span.ago', DOM.fmtTimeAgo((c.thread[0] || {}).ts)),
        ),
        c.quote ? el('div.quote', c.quote) : null,
        ...c.thread.map(t => el('div.bubble',
          el('div.who', el('span.av', initials(t.author)), t.author, ' · ', el('span.ago', DOM.fmtTimeAgo(t.ts))),
          el('div.text', t.body))),
        c.resolved ? el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ok)', marginTop: '6px' } }, 'RESOLVED') : null,
        el('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
          replyInp,
          el('button.ghost', { onClick: async () => {
            if (!replyInp.value.trim()) return;
            await Store.replyComment(doc_id, c.id, replyInp.value.trim());
            replyInp.value = '';
            renderCommentsList();
          } }, 'REPLY'),
          el('button.ghost', { onClick: async () => { await Store.resolveComment(doc_id, c.id, !c.resolved); renderCommentsList(); } }, c.resolved ? 'REOPEN' : 'RESOLVE'),
        ),
      );
      replyInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') node.querySelector('button.ghost').click(); });
      return node;
    }

    function suggestionCard(s) {
      return el('div.cmtitem.suggestion' + (s.status !== 'pending' ? '.resolved' : ''), { dataset: { anchor: s.anchor_id } },
        el('div.head',
          el('div.who', el('span.av', initials(s.author)), s.author, ' · ', 'SUGGEST'),
          el('span.ago', DOM.fmtTimeAgo(s.created_at)),
        ),
        el('div.diff-snippet',
          el('span.del', s.original), el('br'),
          el('span.ins', s.proposed),
        ),
        s.note ? el('div.text', { style: { fontFamily: 'var(--serif)', fontSize: '12px', color: 'var(--ink-dim)' } }, s.note) : null,
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: s.status === 'accepted' ? 'var(--ok)' : s.status === 'rejected' ? 'var(--err)' : 'var(--warn)', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '0.14em' } }, s.status),
        s.status === 'pending' ? el('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
          el('button.ghost.accept', { onClick: () => acceptSuggestion(s) }, '✓ ACCEPT'),
          el('button.ghost.reject', { onClick: () => rejectSuggestion(s) }, '✕ REJECT'),
        ) : null,
      );
    }

    async function acceptSuggestion(s) {
      // Replace the .suggest-del span with the .suggest-ins text, drop both
      const del = body.querySelector('.suggest-del[data-anchor="' + s.anchor_id + '"]');
      const ins = body.querySelector('.suggest-ins[data-anchor="' + s.anchor_id + '"]');
      if (del) del.remove();
      if (ins) {
        const t = document.createTextNode(ins.textContent);
        ins.replaceWith(t);
      }
      await Store.updateSuggestion(doc_id, s.id, { status: 'accepted' });
      markDirty();
      renderCommentsList();
    }
    async function rejectSuggestion(s) {
      const del = body.querySelector('.suggest-del[data-anchor="' + s.anchor_id + '"]');
      const ins = body.querySelector('.suggest-ins[data-anchor="' + s.anchor_id + '"]');
      if (ins) ins.remove();
      if (del) {
        const t = document.createTextNode(del.textContent);
        del.replaceWith(t);
      }
      await Store.updateSuggestion(doc_id, s.id, { status: 'rejected' });
      markDirty();
      renderCommentsList();
    }

    // ---- gutter cards (small floating annotations beside text) ----
    function renderGutter() {
      clear(gutter);
      const comments = Store.listComments(doc_id);
      let topUsed = 0;
      for (const c of comments) {
        if (c.resolved) continue;
        const anchor = body.querySelector('.commented[data-anchor="' + c.anchor_id + '"]');
        if (!anchor) continue;
        const top = anchor.offsetTop;
        const last = c.thread[c.thread.length - 1];
        const card = el('div.gcard', {
          dataset: { anchor: c.anchor_id },
          style: { top: Math.max(top, topUsed) + 'px' },
          onClick: () => { setTab('comments'); flashGutter(c.anchor_id); },
        },
          el('div.ghead', el('div.who', el('span.av', initials(last.author)), last.author.split(':')[0]), el('span.ago', DOM.fmtTimeAgo(last.ts))),
          el('div.text', last.body),
        );
        gutter.appendChild(card);
        topUsed = Math.max(top, topUsed) + 84;
      }
    }

    // ---- initial render of body from markdown ----
    function render() {
      const sources = Store.listSources(doc_id);
      const { html } = window.MD.render(doc.body_markdown || '', sources);
      body.innerHTML = html;
      renumberChips();
      // Reattach known comment anchors as .commented spans is fine — anchors
      // only live in DOM during the active edit session for now.
      updateWordCount();
      renderGutter();
    }

    function updateWordCount() {
      const w = (body.textContent.match(/\b[\w'-]+\b/g) || []).length;
      wordCountEl.textContent = w + ' WORDS';
    }
    body.addEventListener('input', updateWordCount);

    // ---- preview / restore (called from scrubber) ----
    function externalEditor() {
      return {
        enterPreview(v) {
          previewingVersion = v;
          const snap = Store.getSnapshot(doc_id, v);
          if (snap === undefined) return;
          const sources = Store.listSources(doc_id);
          const r = window.MD.render(snap, sources);
          body.innerHTML = r.html;
          renumberChips();
          body.contentEditable = 'false';
          ensurePreviewBanner(true, v);
        },
        exitPreview() {
          previewingVersion = null;
          body.innerHTML = window.MD.render(doc.body_markdown || '', Store.listSources(doc_id)).html;
          renumberChips();
          body.contentEditable = mode === 'edit' ? 'true' : 'false';
          ensurePreviewBanner(false);
        },
        reload() {
          const d = Store.getDocument(doc_id);
          Object.assign(doc, d);
          lastSavedMarkdown = d.body_markdown || '';
          body.innerHTML = window.MD.render(d.body_markdown || '', Store.listSources(doc_id)).html;
          renumberChips();
          body.contentEditable = mode === 'edit' ? 'true' : 'false';
          dirty = false; setStatus('saved');
          if (scrubberRebuild) scrubberRebuild();
        },
        scrubTo(v) {
          this.enterPreview(v);
          scrubberRebuild && scrubberRebuild();
        },
      };
    }

    let previewBanner = null;
    function ensurePreviewBanner(show, v) {
      if (previewBanner) { previewBanner.remove(); previewBanner = null; }
      if (show) {
        previewBanner = el('div.preview-banner',
          icon('clock-counter-clockwise'),
          el('span', 'Previewing v' + v + ' (read-only) · drag the scrubber to compare, click RESTORE below'),
        );
        page.parentElement.insertBefore(previewBanner, page);
      }
    }

    // ---- scrubber init ----
    scrubberBar = window.HistoryBar.build(doc_id, externalEditor());
    scrubberRebuild = scrubberBar.rebuild;
    container.appendChild(scrubberBar.node);

    // ---- attach to host ----
    setMode('edit');
    mount(host, container);
    render();
    renderCommentsList();
    scrubberBar.rebuild();
    setTimeout(() => { if (!embedded) titleInput.focus(); }, 60);

    return { container, refresh: render };
  }

  // ============ format bar ============
  function buildFormatBar(body) {
    function exec(cmd, arg) {
      body.focus();
      document.execCommand(cmd, false, arg);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function block(tag) {
      body.focus();
      document.execCommand('formatBlock', false, tag);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function btn(ic, label, fn, title) {
      return el('button', { onClick: (e) => { e.preventDefault(); fn(); }, title: title || label }, icon(ic));
    }
    return el('div.formatbar',
      btn('text-h-one', 'H1', () => block('H1'), 'Heading 1'),
      btn('text-h-two', 'H2', () => block('H2'), 'Heading 2'),
      btn('text-h-three', 'H3', () => block('H3'), 'Heading 3'),
      el('div.sep'),
      btn('text-b', 'Bold', () => exec('bold'), 'Bold (⌘B)'),
      btn('text-italic', 'Italic', () => exec('italic'), 'Italic (⌘I)'),
      btn('text-strikethrough', 'Strike', () => exec('strikeThrough'), 'Strikethrough'),
      el('div.sep'),
      btn('quotes', 'Quote', () => block('BLOCKQUOTE'), 'Blockquote'),
      btn('list-bullets', 'UL', () => exec('insertUnorderedList'), 'Bulleted list'),
      btn('list-numbers', 'OL', () => exec('insertOrderedList'), 'Numbered list'),
      btn('code', 'Code', () => block('PRE'), 'Code block'),
      btn('minus', 'HR', () => exec('insertHorizontalRule'), 'Horizontal rule'),
      el('div.sep'),
      btn('link', 'Link', () => {
        const url = prompt('Link URL'); if (url) exec('createLink', url);
      }, 'Insert link'),
    );
  }

  // ============ slash menu ============
  function buildSlashMenu(doc_id, onChange) {
    const menu = el('div.slashmenu', { style: { display: 'none' } });

    function openAt(rect, bodyRect) {
      clear(menu);
      const sources = Store.listSources(doc_id);
      const items = [];
      items.push({ icon: 'text-h-one', label: 'Heading 1', sub: 'Large section header', action: () => document.execCommand('formatBlock', false, 'H1') });
      items.push({ icon: 'text-h-two', label: 'Heading 2', sub: 'Subsection', action: () => document.execCommand('formatBlock', false, 'H2') });
      items.push({ icon: 'quotes', label: 'Blockquote', sub: 'Pull quote', action: () => document.execCommand('formatBlock', false, 'BLOCKQUOTE') });
      items.push({ icon: 'code', label: 'Code block', sub: 'Monospaced', action: () => document.execCommand('formatBlock', false, 'PRE') });
      items.push({ icon: 'minus', label: 'Horizontal rule', sub: 'Section break', action: () => document.execCommand('insertHorizontalRule') });
      items.push({ icon: 'list-bullets', label: 'Bulleted list', sub: '', action: () => document.execCommand('insertUnorderedList') });
      items.push({ icon: 'list-numbers', label: 'Numbered list', sub: '', action: () => document.execCommand('insertOrderedList') });
      if (sources.length > 0) {
        menu.appendChild(el('div.section', 'Citations'));
        for (const s of sources) {
          menu.appendChild(row(
            s.archive_org_url ? 'link-simple' : 'warning-circle',
            s.title || s.filename,
            (s.archive_org_url ? 'Archived · ' : 'Unarchived · ') + s.filename,
            () => insertCitationByActiveEditor(s.source_id),
          ));
        }
        menu.appendChild(el('div.section', 'Blocks'));
      }
      for (const it of items) menu.appendChild(row(it.icon, it.label, it.sub, it.action));

      menu.style.display = '';
      menu.style.position = 'absolute';
      menu.style.left = (rect.left - bodyRect.left) + 'px';
      menu.style.top = (rect.bottom - bodyRect.top + 6) + 'px';
      // Remove the typed "/" char on action — simpler: leave it and let user backspace.
    }
    function close() { menu.style.display = 'none'; }
    function row(ic, label, sub, action) {
      return el('div.row', { onClick: () => { close(); removeSlash(); action(); onChange && onChange(); } },
        el('div.icocell', icon(ic)),
        el('div',
          el('div.lbl', label),
          sub ? el('div.sub', sub) : null,
        ),
      );
    }
    function removeSlash() {
      // Find caret, delete preceding "/" if present.
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      const node = r.startContainer;
      if (node && node.nodeType === Node.TEXT_NODE) {
        const i = r.startOffset;
        if (i > 0 && node.textContent[i - 1] === '/') {
          node.textContent = node.textContent.slice(0, i - 1) + node.textContent.slice(i);
          r.setStart(node, i - 1); r.collapse(true);
        }
      }
    }
    function insertCitationByActiveEditor(sid) {
      // Trigger a custom event the editor handler listens for.
      document.dispatchEvent(new CustomEvent('drafteo:insertcite', { detail: { source_id: sid } }));
    }

    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
    return { node: menu, openAt, close };
  }

  document.addEventListener('drafteo:insertcite', (e) => {
    const sid = e.detail.source_id;
    // Insert a chip at caret in the currently-focused .body
    const body = document.querySelector('.body[contenteditable="true"]');
    if (!body) return;
    const span = document.createElement('span');
    span.className = 'cite unarchived';
    span.contentEditable = 'false';
    span.dataset.cite = sid;
    span.dataset.num = '?';
    span.textContent = '?';
    const sel = window.getSelection();
    if (sel.rangeCount && body.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.insertNode(span);
      r.setStartAfter(span); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else {
      body.appendChild(span);
    }
    body.dispatchEvent(new Event('input', { bubbles: true }));
  });

  function initials(mid) {
    const name = (mid || '').replace(/^@/, '').split(':')[0];
    return (name.slice(0, 2) || '??').toUpperCase();
  }

  function icon(name) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    return i;
  }

  window.EditorView = {
    render: (ws_id, doc_id, app) => buildPage(ws_id, doc_id, app),
    mountInto: (host, ws_id, doc_id, app, opts) => buildPage(ws_id, doc_id, app, Object.assign({ host, embedded: true }, opts || {})),
  };
})();
