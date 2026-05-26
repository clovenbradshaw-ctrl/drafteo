// ============ SOURCE EXPLORER ============
// Workspace-wide modal for browsing every source, searching inside any
// one of them, grabbing a span, and producing a citation — independent
// of any active editor selection. The cite picker in editor.js, the
// Cmd/K palette, and the sidebar "Explore" button all open this modal.
//
// Layout: three panes.
//   Left   — sources list (fuzzy filter across title/URL/tags/draft/desc)
//   Middle — selected source's plaintext, with in-source find + highlight
//   Right  — currently-selected span + action buttons (save / copy / stage)
//
// Span output ("all three"):
//   • Save as exhibit          → Store.createExhibit, surfaces in sidebar
//   • Save + copy citation     → above + clipboard "quote — Source (url)"
//   • Stage for next cite      → window.__stagedPassage for next editor cite
//
// Citation format (for clipboard): `"<quote>" — <title>[, <page>] (<url>)`

(function () {
  const { el, clear } = window.DOM;
  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  // Light-touch heuristic dechrome — same shape as srcviewer.js. Kept
  // local so the module is self-contained.
  function dechrome(raw) {
    if (!raw) return '';
    const lines = raw.split('\n').map(l => l.trim());
    const out = [];
    let blanks = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l) { if (blanks++ < 1 && out.length > 0) out.push(''); continue; }
      blanks = 0;
      if (l.length < 24 && /^[A-Z\s|·•·>›/–\-]+$/.test(l) && !/[a-z]/.test(l)) continue;
      if (out.length && out[out.length - 1] === l) continue;
      if (l.length <= 14 && i > 0 && i < lines.length - 1) {
        const prev = lines[i - 1].trim();
        const next = lines[i + 1].trim();
        if ((prev.length <= 14 || !prev) && (next.length <= 14 || !next)) continue;
      }
      out.push(l);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  function extractPlaintextFromHtml(htmlString) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      doc.querySelectorAll('script, style, noscript, iframe').forEach(n => n.remove());
      const main = doc.querySelector('article, main, [role="main"]') || doc.body;
      if (!main) return '';
      const blockSel = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, dt, dd, br, hr, tr';
      main.querySelectorAll(blockSel).forEach(n => { n.insertAdjacentText('beforeend', '\n'); });
      return (main.textContent || '').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch (_) { return ''; }
  }

  function subseqMatch(hay, needle) {
    let i = 0;
    for (let j = 0; j < hay.length && i < needle.length; j++) {
      if (hay[j] === needle[i]) i++;
    }
    return i === needle.length;
  }

  // Cache extracted plaintext per source so flipping between sources is fast.
  const textCache = new Map(); // source_id -> string

  async function getPlaintextFor(s, doc_id) {
    if (!s) return '';
    if (textCache.has(s.source_id)) return textCache.get(s.source_id);
    if (s.plaintext) { textCache.set(s.source_id, s.plaintext); return s.plaintext; }

    const mime = s.mime || '';
    const isHtml = mime === 'text/html' || !!s.source_url;
    const isTextLike = mime.startsWith('text/') || mime === 'application/json' ||
                       /\.(csv|tsv|md|txt|json)$/i.test(s.filename || '');

    let url = null;
    try { url = await Store.fetchMedia(s); } catch (_) {}
    if (!url && s.archive_org_identifier && (s.archive_org_filename || s.filename)) {
      url = 'https://archive.org/download/' + s.archive_org_identifier + '/' +
            encodeURIComponent(s.archive_org_filename || s.filename);
    }
    if (!url) { textCache.set(s.source_id, ''); return ''; }

    try {
      const r = await fetch(url);
      const raw = await r.text();
      const out = isHtml ? extractPlaintextFromHtml(raw) : (isTextLike ? raw : '');
      textCache.set(s.source_id, out);
      return out;
    } catch (_) {
      textCache.set(s.source_id, '');
      return '';
    }
  }

  function canonicalCitationUrl(s) {
    return s && (s.archive_org_url || s.source_url) || '';
  }

  function formatCitation(s, quote, page) {
    const title = (s && (s.title || s.filename)) || 'Untitled source';
    const url = canonicalCitationUrl(s);
    const parts = ['"' + quote + '"', '— ' + title];
    if (page) parts[1] += ', ' + page;
    if (url) parts.push('(' + url + ')');
    return parts.join(' ');
  }

  // Render plaintext into a host with <mark> spans wrapping query hits.
  // Returns { hits: [<mark>...], textLen } so callers can navigate them.
  function renderWithHits(host, text, query) {
    clear(host);
    const hits = [];
    if (!text) {
      host.appendChild(el('div.expl-empty-inline', 'No text extracted for this source.'));
      return { hits, textLen: 0 };
    }
    if (!query) {
      host.appendChild(document.createTextNode(text));
      return { hits, textLen: text.length };
    }
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
      const idx = lower.indexOf(q, i);
      if (idx < 0) { host.appendChild(document.createTextNode(text.slice(i))); break; }
      if (idx > i) host.appendChild(document.createTextNode(text.slice(i, idx)));
      const m = el('mark.expl-hit', text.slice(idx, idx + q.length));
      host.appendChild(m);
      hits.push(m);
      i = idx + q.length;
    }
    return { hits, textLen: text.length };
  }

  // Compute character offset of a (node, offset) point within `host` by
  // walking text nodes in document order.
  function charOffsetIn(host, node, offset) {
    if (!host || !host.contains(node)) return null;
    let total = 0;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
    let cur;
    while ((cur = walker.nextNode())) {
      if (cur === node) return total + offset;
      total += cur.nodeValue.length;
    }
    return null;
  }

  function open(ws_id, opts) {
    opts = opts || {};
    if (!ws_id) { DOM.toast('NO WORKSPACE', 'Open a workspace first.'); return; }

    // ── Source records: every source in every doc of the workspace ──
    function gather() {
      const recs = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          recs.push({ source: s, doc: d, doc_id: d.id, source_id: s.source_id });
        }
      }
      return recs;
    }

    // ── Filter records by query (subsequence over haystack) ──
    function filterRecs(recs, q) {
      if (!q) return recs.slice();
      const needle = q.toLowerCase().trim();
      if (!needle) return recs.slice();
      // Two-tier: substring matches first, then subsequence — substring
      // matches are the user's mental model when they type a whole word.
      const subs = [];
      const subseq = [];
      for (const r of recs) {
        const hay = [
          r.source.title, r.source.filename, r.source.source_url,
          r.source.archive_org_url, r.source.description,
          (r.source.tags || []).join(' '), r.doc.title,
        ].filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(needle)) subs.push(r);
        else if (subseqMatch(hay, needle)) subseq.push(r);
      }
      return subs.concat(subseq);
    }

    // ── Modal scaffolding ──
    const scrim = el('div.scrim.expl-scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('drafteo:sources-updated', onSourcesUpdated);
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      // Navigate matches with F3 / Shift-F3 when find input is focused
      if (findInput && document.activeElement === findInput) {
        if (e.key === 'Enter') { e.preventDefault(); jumpHit(e.shiftKey ? -1 : 1); }
        else if (e.key === 'F3') { e.preventDefault(); jumpHit(e.shiftKey ? -1 : 1); }
      }
    }

    // ── State ──
    const allRecs = gather();
    let visibleRecs = allRecs.slice();
    let activeRec = null;       // { source, doc, doc_id, source_id }
    let activeText = '';        // plaintext for active source
    let findQuery = '';
    let hitMarks = [];          // <mark> elements in middle pane
    let activeHit = 0;
    let captured = null;        // { text, charStart, charEnd, before, after }
    let mediaActive = false;    // middle pane is showing PDF/image/audio/video
    let sortMode = 'title';     // 'title' | 'status' | 'draft'
    let groupMode = false;      // group rows by status (archived / web / local)
    let listLimit = 80;         // incremental render cap; "Show all" expands
    let exhibitCounts = null;   // source_id -> int, lazily computed per workspace

    // ── Elements ──
    const queryInput = el('input.expl-search-inp', {
      type: 'text',
      placeholder: 'Filter sources by name, URL, tag, draft…',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    if (opts.initialQuery) queryInput.value = opts.initialQuery;

    const listEl = el('div.expl-list');
    const listSummary = el('div.expl-list-sum');

    const sortSel = el('select.expl-sort-sel', { title: 'Sort sources' },
      el('option', { value: 'title' }, 'Title'),
      el('option', { value: 'status' }, 'Status'),
      el('option', { value: 'draft' }, 'Draft'),
    );
    sortSel.value = sortMode;
    sortSel.addEventListener('change', () => {
      sortMode = sortSel.value;
      listLimit = 80;
      renderList();
    });
    const groupBtn = el('button.expl-group-btn', {
      type: 'button',
      title: 'Group sources by status',
      onClick: () => {
        groupMode = !groupMode;
        groupBtn.classList.toggle('active', groupMode);
        listLimit = 80;
        renderList();
      },
    }, icon('squares-four', 12), ' Group');
    const sortBar = el('div.expl-sort-bar',
      el('label.expl-sort-lbl', 'Sort'),
      sortSel,
      groupBtn,
    );

    const findInput = el('input.expl-find-inp', {
      type: 'text',
      placeholder: 'Find in source — type then ↵ to jump',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    const findCount = el('span.expl-find-count', '');
    const findPrev = el('button.expl-find-btn', {
      onClick: () => jumpHit(-1), title: 'Previous match',
    }, icon('caret-up', 12));
    const findNext = el('button.expl-find-btn', {
      onClick: () => jumpHit(1), title: 'Next match',
    }, icon('caret-down', 12));

    const middleHead = el('div.expl-mid-head');   // title + meta of open source
    const middleBody = el('div.expl-mid-body');   // text host with <mark>s
    const middleEmpty = el('div.expl-mid-empty',
      icon('arrow-left'),
      el('div', { style: { fontFamily: 'var(--display)', fontSize: '18px', fontWeight: 600, color: 'var(--ink-dim)', marginTop: '10px' } }, 'Pick a source on the left'),
      el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-faint)', marginTop: '4px', maxWidth: '320px' } },
        'Then search inside it and grab a passage to cite. Selections appear on the right with save / copy / stage actions.'),
    );

    const rightPane = el('div.expl-right');

    // ── List helpers: status bucket, sort, exhibits-per-source ──
    function statusOf(s) {
      if (s.archive_org_url) return 'archived';
      if (s.source_url) return 'web';
      return 'local';
    }
    const STATUS_RANK = { archived: 0, web: 1, local: 2 };
    const STATUS_LABEL = { archived: 'Archived', web: 'Web sources', local: 'Local files' };
    const STATUS_ICON = { archived: 'check-circle', web: 'globe', local: 'file' };

    function compareRecs(a, b) {
      if (sortMode === 'status') {
        const d = STATUS_RANK[statusOf(a.source)] - STATUS_RANK[statusOf(b.source)];
        if (d !== 0) return d;
      } else if (sortMode === 'draft') {
        const d = (a.doc.title || '').localeCompare(b.doc.title || '');
        if (d !== 0) return d;
      }
      const ta = (a.source.title || a.source.filename || '').toLowerCase();
      const tb = (b.source.title || b.source.filename || '').toLowerCase();
      return ta.localeCompare(tb);
    }

    function getExhibitCount(source_id) {
      if (!exhibitCounts) {
        exhibitCounts = {};
        const all = Store.listExhibits(ws_id) || [];
        for (const ex of all) {
          if (!ex.source_id) continue;
          exhibitCounts[ex.source_id] = (exhibitCounts[ex.source_id] || 0) + 1;
        }
      }
      return exhibitCounts[source_id] || 0;
    }

    function buildRow(r) {
      const s = r.source;
      const isWeb = !!s.source_url;
      const isActive = activeRec && activeRec.source_id === r.source_id;
      const cited = getExhibitCount(r.source_id);
      const status = statusOf(s);
      const statusPill = status === 'archived'
        ? el('span.expl-pill.ok', icon('check-circle', 10), ' archived')
        : status === 'web'
          ? el('span.expl-pill.warn', icon('globe', 10), ' web')
          : el('span.expl-pill.mute', icon('file', 10), ' local');
      const openBtn = el('span.expl-row-open', {
        title: 'Open this source in a full tab',
        onClick: (e) => { e.stopPropagation(); openInTab(r); },
      }, icon('arrow-square-out', 12));
      return el('button.expl-row' + (isActive ? '.active' : ''),
        { type: 'button', onClick: () => selectRec(r) },
        el('div.expl-row-ico' + (isWeb ? '.web' : ''),
          isWeb ? icon('globe') : el('span', DOM.fileExt(s.mime, s.filename))),
        el('div.expl-row-body',
          el('div.expl-row-ttl-line',
            el('div.expl-row-ttl', s.title || s.filename || 'Untitled source'),
            openBtn,
          ),
          el('div.expl-row-meta',
            statusPill,
            el('span.expl-row-dot', '·'),
            el('span.expl-row-doc', r.doc.title || 'Untitled draft'),
            cited > 0 ? el('span.expl-row-dot', '·') : null,
            cited > 0 ? el('span.expl-pill.cited', icon('quotes', 10), ' ' + cited + ' cited') : null,
          ),
          s.description ? el('div.expl-row-desc', s.description) : null,
        ),
      );
    }

    // ── Build list ──
    function renderList() {
      clear(listEl);
      const total = allRecs.length;
      const shown = visibleRecs.length;

      if (shown === 0) {
        if (total === 0) {
          listEl.appendChild(el('div.expl-list-empty',
            icon('books', 22),
            el('div.expl-list-empty-ttl', 'No sources yet'),
            el('div.expl-list-empty-sub', 'Add files or URLs from a draft\'s Sources panel, then come back here to browse and cite.'),
          ));
        } else {
          listEl.appendChild(el('div.expl-list-empty',
            icon('magnifying-glass', 22),
            el('div.expl-list-empty-ttl', 'No sources match'),
            el('div.expl-list-empty-sub', 'Try a shorter query, or clear the filter.'),
            el('button.expl-chip', { onClick: () => { queryInput.value = ''; queryInput.dispatchEvent(new Event('input')); } },
              ' Clear filter'),
          ));
        }
        listSummary.textContent = total === 0 ? '0 sources' : '0 of ' + total + ' shown';
        return;
      }

      listSummary.textContent = shown === total
        ? shown + ' source' + (shown === 1 ? '' : 's')
        : shown + ' of ' + total + ' shown';

      const sorted = visibleRecs.slice().sort(compareRecs);

      if (groupMode) {
        const groups = { archived: [], web: [], local: [] };
        for (const r of sorted) groups[statusOf(r.source)].push(r);
        let rendered = 0;
        for (const key of ['archived', 'web', 'local']) {
          const recs = groups[key];
          if (recs.length === 0) continue;
          listEl.appendChild(el('div.expl-group-head',
            icon(STATUS_ICON[key], 10),
            el('span', STATUS_LABEL[key]),
            el('span.expl-group-count', recs.length),
          ));
          for (const r of recs) {
            if (rendered >= listLimit) break;
            listEl.appendChild(buildRow(r));
            rendered++;
          }
          if (rendered >= listLimit) break;
        }
        if (sorted.length > listLimit) appendMoreSentinel(sorted.length);
      } else {
        const slice = sorted.slice(0, listLimit);
        for (const r of slice) listEl.appendChild(buildRow(r));
        if (sorted.length > listLimit) appendMoreSentinel(sorted.length);
      }
    }

    function appendMoreSentinel(total) {
      const remaining = total - listLimit;
      const btn = el('button.expl-list-more', {
        type: 'button',
        onClick: () => { listLimit = Infinity; renderList(); },
      }, 'Show ' + remaining + ' more');
      listEl.appendChild(btn);
      // Auto-expand if the user scrolls to the sentinel — cheap virtualization
      try {
        const obs = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              obs.disconnect();
              listLimit = Infinity;
              renderList();
              return;
            }
          }
        }, { root: listEl, rootMargin: '200px' });
        obs.observe(btn);
      } catch (_) {}
    }

    // ── Build middle pane for active source ──
    async function renderMiddle() {
      clear(middleHead);
      clear(middleBody);
      mediaActive = false;
      if (!activeRec) {
        middleBody.appendChild(middleEmpty.cloneNode(true));
        findInput.value = '';
        findInput.disabled = true;
        findCount.textContent = '';
        return;
      }
      findInput.disabled = false;
      const s = activeRec.source;
      const isWeb = !!s.source_url;
      const url = canonicalCitationUrl(s);

      // Header: title + action chips
      middleHead.appendChild(el('div.expl-mid-id',
        el('div.expl-mid-ico' + (isWeb ? '.web' : ''),
          isWeb ? icon('globe') : el('span', DOM.fileExt(s.mime, s.filename))),
        el('div.expl-mid-ttls',
          el('div.expl-mid-ttl', s.title || s.filename || 'Untitled source'),
          el('div.expl-mid-sub',
            el('span', s.mime || '—'),
            el('span.expl-mid-dot', '·'),
            el('span', DOM.fmtBytes(s.size_bytes || 0)),
            url ? el('span.expl-mid-dot', '·') : null,
            url ? el('a.expl-mid-link', { href: url, target: '_blank', rel: 'noopener' },
                    s.archive_org_url ? 'archive.org' : 'original') : null,
          ),
        ),
      ));
      middleHead.appendChild(el('div.expl-mid-actions',
        el('button.expl-chip', {
          onClick: () => openInTab(activeRec),
          title: 'Open this source in a full tab',
        }, icon('arrow-square-out', 12), ' Open tab'),
      ));

      // Body — pick renderer by mime
      const mime = s.mime || '';
      const isPdf = mime === 'application/pdf';
      const isImage = mime.startsWith('image/');
      const isAudio = mime.startsWith('audio/');
      const isVideo = mime.startsWith('video/');
      const isMedia = isPdf || isImage || isAudio || isVideo;

      if (isMedia) {
        mediaActive = true;
        captured = null;
        const archiveDl = (s.archive_org_identifier && (s.archive_org_filename || s.filename))
          ? 'https://archive.org/download/' + s.archive_org_identifier + '/' + encodeURIComponent(s.archive_org_filename || s.filename)
          : null;

        // Toolbar above the preview — primary cite action and external link
        const toolbar = el('div.expl-media-bar',
          el('div.expl-media-bar-lbl',
            icon(isPdf ? 'file-pdf' : isImage ? 'image' : isAudio ? 'speaker-high' : 'video', 12),
            el('span', isPdf ? 'PDF preview · select text below or paste a passage'
              : isImage ? 'Image · cite as whole-source reference'
              : isAudio ? 'Audio · cite a timestamp or whole source'
              : 'Video · cite a timestamp or whole source'),
          ),
          el('div.expl-media-bar-actions',
            isPdf ? el('button.expl-chip.expl-chip-primary', {
              onClick: () => openPdfPaste(activeRec),
            }, icon('scissors', 12), ' Paste & cite passage') : null,
            url ? el('a.expl-chip', { href: url, target: '_blank', rel: 'noopener' },
              icon('arrow-square-out', 12), ' Open original') : null,
          ),
        );
        middleBody.appendChild(toolbar);

        // Loading shim while we resolve the blob URL
        const stage = el('div.expl-media-stage', el('div.expl-empty-inline', 'Loading preview…'));
        middleBody.appendChild(stage);

        const reqRec = activeRec;
        (async () => {
          let blobUrl = null;
          try { blobUrl = await Store.fetchMedia(s); } catch (_) {}
          if (reqRec !== activeRec) return;
          const src = blobUrl || archiveDl || url || null;
          clear(stage);
          if (!src) {
            stage.appendChild(el('div.expl-empty-inline',
              'No local copy available. Use the buttons above to open the original.'));
            return;
          }
          if (isImage) {
            stage.appendChild(el('div.expl-media-img-wrap',
              el('img.expl-media-img', { src, alt: s.title || s.filename || 'image' })));
          } else if (isAudio) {
            stage.appendChild(el('div.expl-media-player-wrap',
              el('audio.expl-media-player', { src, controls: 'controls' })));
          } else if (isVideo) {
            stage.appendChild(el('div.expl-media-player-wrap',
              el('video.expl-media-player', { src, controls: 'controls' })));
          } else { // PDF
            stage.appendChild(el('iframe.expl-media-frame', { src, title: s.title || s.filename || 'PDF' }));
          }
        })();

        renderRight();
        return;
      }

      mediaActive = false;
      // Text-y body
      const textHost = el('div.expl-text');
      middleBody.appendChild(el('div.expl-text-scroll', textHost));

      // Loading shim while we fetch + extract
      textHost.appendChild(el('div.expl-empty-inline', 'Loading source text…'));
      const reqRec = activeRec;
      const t = await getPlaintextFor(s, activeRec.doc_id);
      // Drop stale completions if the user moved on
      if (reqRec !== activeRec) return;
      activeText = t || '';
      const out = renderWithHits(textHost, activeText, findQuery);
      hitMarks = out.hits;
      activeHit = hitMarks.length ? 0 : -1;
      updateFindCount();
      highlightActive();
      attachSelectionListener(textHost);
    }

    function updateFindCount() {
      if (!findQuery) { findCount.textContent = ''; return; }
      if (hitMarks.length === 0) { findCount.textContent = '0 / 0'; return; }
      findCount.textContent = (activeHit + 1) + ' / ' + hitMarks.length;
    }

    function highlightActive() {
      hitMarks.forEach((m, i) => m.classList.toggle('active', i === activeHit));
      const cur = hitMarks[activeHit];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function jumpHit(dir) {
      if (hitMarks.length === 0) return;
      activeHit = (activeHit + dir + hitMarks.length) % hitMarks.length;
      updateFindCount();
      highlightActive();
    }

    function attachSelectionListener(host) {
      function onChange() {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed) return;
        if (!host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) return;
        const text = sel.toString().trim();
        if (!text) return;
        let charStart = null, charEnd = null;
        try {
          const range = sel.getRangeAt(0);
          charStart = charOffsetIn(host, range.startContainer, range.startOffset);
          charEnd = charOffsetIn(host, range.endContainer, range.endOffset);
        } catch (_) {}
        const full = host.textContent || '';
        let before = '', after = '';
        if (charStart != null && charEnd != null) {
          before = full.slice(Math.max(0, charStart - 120), charStart);
          after = full.slice(charEnd, charEnd + 120);
        }
        captured = { text, charStart, charEnd, before, after };
        renderRight();
      }
      host.addEventListener('mouseup', onChange);
      host.addEventListener('keyup', onChange);
    }

    // ── Build right pane ──
    function renderRight() {
      clear(rightPane);

      // No source picked yet
      if (!activeRec) {
        rightPane.appendChild(el('div.expl-right-head',
          el('div.expl-right-ttl', opts.onPick ? 'Pick a passage' : 'Cite from a source'),
          el('div.expl-right-sub', 'Choose a source on the left to begin.'),
        ));
        rightPane.appendChild(el('div.expl-right-empty',
          icon('arrow-left', 22),
          el('div.expl-right-empty-ttl', 'Nothing open yet'),
          el('div.expl-right-empty-sub', 'Pick a source from the list, then highlight text to grab a span.'),
        ));
        return;
      }

      // No live selection — coach based on source type
      if (!captured) {
        rightPane.appendChild(el('div.expl-right-head',
          el('div.expl-right-ttl', opts.onPick ? 'Pick a passage' : 'Cite from this source'),
          el('div.expl-right-sub', mediaActive
            ? (activeRec.source.mime === 'application/pdf'
                ? 'Select text inline, or paste a passage to cite.'
                : 'Cite the whole source, or open in a tab for full controls.')
            : 'Highlight text in the middle pane to grab a span.'),
        ));

        if (mediaActive) {
          const s = activeRec.source;
          const isPdf = s.mime === 'application/pdf';
          // Primary action varies by media kind
          rightPane.appendChild(el('div.expl-actions',
            isPdf ? el('button.expl-act.expl-act-primary', {
              onClick: () => openPdfPaste(activeRec),
              title: 'Paste a passage you copied from the PDF',
            }, icon('scissors', 12), ' Paste & cite passage') : el('button.expl-act.expl-act-primary', {
              onClick: () => doCiteWhole(),
              title: 'Cite this entire source — no selection',
            }, icon('bookmark-simple', 12), ' Cite whole source'),
            el('button.expl-act.expl-act-ghost', {
              onClick: () => openInTab(activeRec),
              title: 'Open this source in a full tab',
            }, icon('arrow-square-out', 12), ' Open in tab'),
          ));
        } else {
          rightPane.appendChild(el('div.expl-right-empty',
            icon('cursor-text', 22),
            el('div.expl-right-empty-ttl', 'How to cite'),
            el('ol.expl-right-steps',
              el('li', 'Find a passage in the middle pane (use the find bar above)'),
              el('li', 'Highlight the text you want to cite'),
              el('li', 'Pick an action below — save, copy, or stage'),
            ),
          ));
        }

        renderTiedExhibits();
        return;
      }

      // Live selection — show quote + actions with clear hierarchy
      rightPane.appendChild(el('div.expl-right-head',
        el('div.expl-right-ttl', opts.onPick ? 'Selected passage' : 'Selection'),
        el('div.expl-right-sub', opts.onPick
          ? 'Confirm to insert into your draft.'
          : 'Pick an action to cite this span.'),
      ));

      const c = captured;
      rightPane.appendChild(el('div.expl-quote',
        c.before ? el('span.expl-quote-ctx', '…' + c.before) : null,
        el('mark.expl-quote-mark', c.text),
        c.after ? el('span.expl-quote-ctx', c.after + '…') : null,
      ));

      const pageInp = el('input.expl-page', {
        type: 'text',
        placeholder: 'p. 12  ·  § 4  ·  ¶ "Beginning July 1…"',
      });

      rightPane.appendChild(el('label.expl-right-lbl', 'Page / location ', el('span.expl-right-lbl-opt', '(optional)')));
      rightPane.appendChild(pageInp);

      if (opts.onPick) {
        // Picker mode — primary CTA is "Use this passage", save/copy are secondary
        rightPane.appendChild(el('div.expl-actions',
          el('button.expl-act.expl-act-primary', {
            onClick: () => {
              opts.onPick({
                text: c.text,
                source: activeRec.source,
                doc_id: activeRec.doc_id,
                source_id: activeRec.source_id,
                char_start: c.charStart,
                char_end: c.charEnd,
                context_before: c.before,
                context_after: c.after,
              });
              close();
            },
            title: 'Insert this passage into your draft',
          }, icon('check', 12), ' Use this passage'),
        ));
        rightPane.appendChild(el('div.expl-actions-sec',
          el('button.expl-act-text', {
            onClick: () => doSave({ copy: false, page: pageInp.value.trim() }),
            title: 'Also save as a permanent exhibit',
          }, icon('scissors', 10), ' Save as exhibit'),
          el('button.expl-act-text', {
            onClick: () => doCopyQuote(),
            title: 'Copy just the highlighted text',
          }, icon('quotes', 10), ' Copy quote'),
        ));
      } else {
        // Standard mode — primary "Save", secondary "Save + copy", tertiary copy/stage
        rightPane.appendChild(el('div.expl-actions',
          el('button.expl-act.expl-act-primary', {
            onClick: () => doSave({ copy: false, page: pageInp.value.trim() }),
            title: 'Save as cited text — provenance & archive URL captured immutably',
          }, icon('scissors', 12), ' Save as exhibit'),
          el('button.expl-act', {
            onClick: () => doSave({ copy: true, page: pageInp.value.trim() }),
            title: 'Save AND copy a formatted citation to the clipboard',
          }, icon('copy', 12), ' Save + copy citation'),
        ));
        rightPane.appendChild(el('div.expl-actions-sec',
          el('button.expl-act-text', {
            onClick: () => doStage({ page: pageInp.value.trim() }),
            title: 'Stash for the next time you cite in an editor',
          }, icon('arrow-square-out', 10), ' Stage for editor'),
          el('button.expl-act-text', {
            onClick: () => doCopyQuote(),
            title: 'Copy just the highlighted text',
          }, icon('quotes', 10), ' Copy quote only'),
        ));
      }

      renderTiedExhibits();
    }

    async function doCiteWhole() {
      if (!activeRec) return;
      const s = activeRec.source;
      try {
        await Store.createExhibit(ws_id, {
          text: '[Whole source: ' + (s.title || s.filename || 'Untitled') + ']',
          label: '',
          note: '',
          tags: [],
          source_id: activeRec.source_id,
          doc_id: activeRec.doc_id,
          char_start: null,
          char_end: null,
          context_before: '',
          context_after: '',
          provenance: {
            source_title: s.title || s.filename,
            filename: s.filename,
            mime: s.mime,
            source_url: s.source_url || null,
            archive_org_url: s.archive_org_url || null,
            archive_org_identifier: s.archive_org_identifier || null,
            archive_org_filename: s.archive_org_filename || s.filename || null,
            captured_at: new Date().toISOString(),
            whole_source: true,
          },
        });
        DOM.toast('CITED WHOLE SOURCE', s.title || s.filename || 'Source', 2800);
        exhibitCounts = null; // invalidate cache
        if (window.__refreshSidebar) window.__refreshSidebar();
        renderList();
        renderRight();
      } catch (e) {
        DOM.toast('SAVE FAILED', e.message || String(e), 3500);
      }
    }

    function renderTiedExhibits() {
      if (!activeRec) return;
      const all = Store.listExhibits(ws_id) || [];
      const tied = all.filter(e => e.source_id === activeRec.source_id);
      if (tied.length === 0) return;
      const wrap = el('div.expl-tied');
      wrap.appendChild(el('div.expl-tied-head',
        icon('books', 12),
        el('span', 'Already cited from this source (' + tied.length + ')')));
      for (const ex of tied) {
        wrap.appendChild(el('div.expl-tied-row',
          el('div.expl-tied-text', '"' + (ex.text || '').slice(0, 140) + (ex.text && ex.text.length > 140 ? '…' : '') + '"'),
          ex.label ? el('div.expl-tied-lbl', ex.label) : null,
        ));
      }
      rightPane.appendChild(wrap);
    }

    async function doSave({ copy, page }) {
      if (!captured || !activeRec) return;
      const s = activeRec.source;
      const c = captured;
      try {
        await Store.createExhibit(ws_id, {
          text: c.text,
          label: '',
          note: '',
          tags: [],
          source_id: activeRec.source_id,
          doc_id: activeRec.doc_id,
          char_start: c.charStart,
          char_end: c.charEnd,
          context_before: page ? '[' + page + '] ' + (c.before || '') : (c.before || ''),
          context_after: c.after || '',
          provenance: {
            source_title: s.title || s.filename,
            filename: s.filename,
            mime: s.mime,
            source_url: s.source_url || null,
            archive_org_url: s.archive_org_url || null,
            archive_org_identifier: s.archive_org_identifier || null,
            archive_org_filename: s.archive_org_filename || s.filename || null,
            captured_at: new Date().toISOString(),
            page: page || null,
          },
        });
        if (copy) {
          const cite = formatCitation(s, c.text, page);
          try { await navigator.clipboard.writeText(cite); } catch (_) {}
          DOM.toast('CITED + COPIED', cite.slice(0, 80) + (cite.length > 80 ? '…' : ''), 3200);
        } else {
          DOM.toast('CITED TEXT SAVED', '"' + c.text.slice(0, 60) + '"', 3000);
        }
        if (window.__refreshSidebar) window.__refreshSidebar();
        exhibitCounts = null; // invalidate cache so list badge increments
        renderList();
        renderTiedExhibits();
      } catch (e) {
        DOM.toast('SAVE FAILED', e.message || String(e), 3500);
      }
    }

    function doStage({ page }) {
      if (!captured) return;
      const text = page ? '[' + page + '] ' + captured.text : captured.text;
      window.__stagedPassage = text;
      DOM.toast('PASSAGE STAGED', 'Switch to a draft and click Cite to attach it.', 4000);
    }

    async function doCopyQuote() {
      if (!captured) return;
      try { await navigator.clipboard.writeText(captured.text); DOM.toast('COPIED', '"' + captured.text.slice(0, 80) + '"', 2400); }
      catch (_) { DOM.toast('COPY FAILED', 'Clipboard unavailable.', 2400); }
    }

    function openInTab(rec) {
      if (window.__openSourceTab) {
        close();
        try { window.__openSourceTab(rec.doc_id, rec.source_id); return; } catch (_) {}
      }
    }

    function openPdfPaste(rec) {
      if (window.SourceViewer && window.SourceViewer.openPdfPassage) {
        close();
        window.SourceViewer.openPdfPassage({
          ws_id, source: rec.source,
          source_id: rec.source_id, doc_id: rec.doc_id,
        });
      } else {
        // Fallback — open the source in a tab where the PDF cite button lives
        openInTab(rec);
      }
    }

    function selectRec(r) {
      activeRec = r;
      captured = null;
      findInput.value = '';
      findQuery = '';
      hitMarks = [];
      activeHit = -1;
      renderList();
      renderRight();
      renderMiddle();
    }

    // ── Wire events ──
    queryInput.addEventListener('input', () => {
      visibleRecs = filterRecs(allRecs, queryInput.value);
      listLimit = 80;
      renderList();
      // If active source is no longer in the visible set, keep it open
      // but reflect filtered state; user can clear query.
    });

    findInput.addEventListener('input', () => {
      findQuery = findInput.value.trim();
      if (!activeRec) return;
      // Re-render only the text host
      const host = middleBody.querySelector('.expl-text');
      if (!host) return;
      const out = renderWithHits(host, activeText, findQuery);
      hitMarks = out.hits;
      activeHit = hitMarks.length ? 0 : -1;
      updateFindCount();
      highlightActive();
      attachSelectionListener(host);
    });

    const onSourcesUpdated = () => {
      // Refresh list/active source on background event (e.g. archive done)
      const fresh = gather();
      allRecs.length = 0;
      for (const r of fresh) allRecs.push(r);
      visibleRecs = filterRecs(allRecs, queryInput.value);
      exhibitCounts = null;
      // Refresh activeRec source object if it still exists
      if (activeRec) {
        const found = allRecs.find(r => r.source_id === activeRec.source_id);
        if (found) activeRec = found;
      }
      renderList();
    };
    window.addEventListener('drafteo:sources-updated', onSourcesUpdated);

    // ── Mount ──
    const modal = el('div.expl-modal', { onClick: e => e.stopPropagation() },
      el('div.expl-head',
        el('div.expl-head-ttls',
          el('div.expl-head-ttl', 'Source explorer'),
          el('div.expl-head-sub', 'Browse every source in this workspace · search · grab a span · cite.'),
        ),
        el('button.expl-close', { onClick: close, title: 'Close (Esc)' }, '✕'),
      ),
      el('div.expl-body',
        // Left pane
        el('div.expl-left',
          el('div.expl-left-search', icon('magnifying-glass', 12), queryInput),
          sortBar,
          listSummary,
          listEl,
        ),
        // Middle pane
        el('div.expl-mid',
          el('div.expl-find-bar',
            icon('magnifying-glass', 12),
            findInput,
            findPrev,
            findNext,
            findCount,
          ),
          middleHead,
          middleBody,
        ),
        // Right pane
        rightPane,
      ),
      el('div.expl-foot',
        el('span', 'Esc close'),
        el('span.expl-foot-dot', '·'),
        el('span', '↵ jump next match'),
        el('span.expl-foot-dot', '·'),
        el('span', 'Shift+↵ previous'),
      ),
    );

    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey);

    // Initial render
    renderList();
    if (opts.sourceId && opts.docId) {
      const target = allRecs.find(r => r.source_id === opts.sourceId && r.doc_id === opts.docId);
      if (target) selectRec(target);
      else renderMiddle();
    } else if (visibleRecs.length === 1) {
      selectRec(visibleRecs[0]);
    } else {
      renderMiddle();
    }
    renderRight();

    setTimeout(() => {
      if (opts.initialQuery && !activeRec) findInput.focus();
      else queryInput.focus();
      queryInput.select && queryInput.select();
    }, 40);
  }

  window.SourceExplorer = { open };
})();
