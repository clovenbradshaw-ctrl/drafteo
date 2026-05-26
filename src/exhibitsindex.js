// ============ EXHIBITS ============
//
// Workspace-scoped explorer for every ingested document (PDF / web
// snapshot / file) across every draft. The Exhibits tab IS the explorer
// now — there is no separate "Source Explorer" modal anymore.
//
// Layout: three regions.
//   Top    — workspace-wide full-text search across every exhibit's
//            extracted text. Hits group by exhibit and click-to-jump
//            into the right pane with the span highlighted.
//   Left   — flat list of exhibits with a stable lettered label
//            (Exhibit A, B, C…) assigned by creation order in the
//            workspace.
//   Right  — selected exhibit's content. PDFs render with PDF.js so
//            text selection works and the active page is captured for
//            the citation. HTML/text renders inline. Image/AV opens in
//            a tab.
//
// Citation:
//   When the user selects text in the right pane, a sticky action bar
//   surfaces below the selection with two clear destinations:
//     • Save as cited text   → Store.createExhibit (a.k.a. "Citation")
//     • Stage for editor     → window.__stagedPassage, picked up by the
//                               next Cite click in an editor
//
// Mounted in the workspace shell as the `__exhibits_index__` tab.

(function () {
  const { el, clear } = window.DOM;

  // PDF.js comes in via a global from index.html. Workers are wired
  // there too. Guard for the case the CDN didn't load.
  function pdfjs() {
    return (typeof window !== 'undefined' && window.pdfjsLib) || null;
  }

  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  // ── Lettered labels ───────────────────────────────────────────────
  //
  // Lettering now lives in src/buckets.js — bucketed exhibits get a
  // prefix-scoped letter (`PX-A`, `DX-A`) restarting per bucket; the
  // unbucketed pool gets workspace-wide plain letters (`A`, `B`, `C`).
  // letterFor() and the grouping helper are kept here as fallbacks for
  // codepaths that don't have window.Buckets available yet.
  function letterFor(idx) {
    if (idx < 0) return '?';
    let n = idx;
    let out = '';
    while (true) {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return out;
  }

  // ── Plaintext cache + extraction (text/html + PDF) ────────────────────
  //
  // Cached per source_id so the workspace search bar can scan every
  // exhibit without re-fetching, and per-page so a PDF hit can land on
  // the right page.
  const textCache = new Map();      // source_id -> { full, pages: [{page,text}] }
  const blobUrlCache = new Map();   // source_id -> blob: URL (so PDF.js + iframes share)

  function dechrome(raw) {
    if (!raw) return '';
    const lines = raw.split('\n').map(l => l.trim());
    const out = [];
    let blanks = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l) { if (blanks++ < 1 && out.length > 0) out.push(''); continue; }
      blanks = 0;
      if (out.length && out[out.length - 1] === l) continue;
      out.push(l);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  function htmlToPlaintext(htmlString) {
    try {
      const p = new DOMParser();
      const doc = p.parseFromString(htmlString, 'text/html');
      doc.querySelectorAll('script, style, noscript, iframe').forEach(n => n.remove());
      const main = doc.querySelector('article, main, [role="main"]') || doc.body;
      if (!main) return '';
      main.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, dt, dd, br, hr, tr').forEach(n => n.insertAdjacentText('beforeend', '\n'));
      return (main.textContent || '').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch (_) { return ''; }
  }

  async function ensureBlobUrl(source) {
    if (!source) return null;
    if (blobUrlCache.has(source.source_id)) return blobUrlCache.get(source.source_id);
    let url = null;
    try { url = await Store.fetchMedia(source); } catch (_) {}
    if (!url && source.archive_org_identifier && (source.archive_org_filename || source.filename)) {
      url = 'https://archive.org/download/' + source.archive_org_identifier + '/' +
        encodeURIComponent(source.archive_org_filename || source.filename);
    }
    if (url) blobUrlCache.set(source.source_id, url);
    return url;
  }

  async function extractTextFor(source) {
    if (!source) return { full: '', pages: [] };
    if (textCache.has(source.source_id)) return textCache.get(source.source_id);
    if (source.plaintext) {
      const rec = { full: source.plaintext, pages: [] };
      textCache.set(source.source_id, rec);
      return rec;
    }

    const mime = (source.mime || '').toLowerCase();
    const isHtml = mime === 'text/html' || /\.html?$/i.test(source.filename || '');
    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(source.filename || '');
    const isTextLike = mime.startsWith('text/') || mime === 'application/json' ||
                       /\.(csv|tsv|md|txt|json)$/i.test(source.filename || '');

    const url = await ensureBlobUrl(source);
    if (!url) {
      const empty = { full: '', pages: [] };
      textCache.set(source.source_id, empty);
      return empty;
    }

    let rec = { full: '', pages: [] };
    try {
      if (isPdf && pdfjs()) {
        const task = pdfjs().getDocument({ url });
        const pdf = await task.promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          const txt = tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
          pages.push({ page: i, text: txt });
        }
        rec = { full: pages.map(p => p.text).join('\n\n'), pages };
      } else if (isHtml || isTextLike) {
        const r = await fetch(url);
        const raw = await r.text();
        const t = isHtml ? htmlToPlaintext(raw) : dechrome(raw);
        rec = { full: t, pages: [] };
      }
    } catch (e) {
      console.warn('[exhibits] extract failed for', source.title, e);
    }
    textCache.set(source.source_id, rec);
    return rec;
  }

  // ── Hit-preview helper for full-text search ───────────────────────────
  // Return up to `max` hits inside `text` with ~80 chars of context.
  function findHits(text, q, max) {
    const out = [];
    if (!text || !q) return out;
    const lo = text.toLowerCase();
    const needle = q.toLowerCase();
    let i = 0;
    while (out.length < max) {
      const idx = lo.indexOf(needle, i);
      if (idx < 0) break;
      const start = Math.max(0, idx - 70);
      const end = Math.min(text.length, idx + needle.length + 70);
      out.push({
        offset: idx,
        before: (start > 0 ? '…' : '') + text.slice(start, idx),
        match: text.slice(idx, idx + needle.length),
        after: text.slice(idx + needle.length, end) + (end < text.length ? '…' : ''),
      });
      i = idx + needle.length;
    }
    return out;
  }

  function pageForOffset(rec, offset) {
    if (!rec || !rec.pages || rec.pages.length === 0) return null;
    let cur = 0;
    for (const p of rec.pages) {
      const len = p.text.length + 2; // +2 for the "\n\n" we joined with
      if (offset < cur + len) return p.page;
      cur += len;
    }
    return rec.pages[rec.pages.length - 1].page;
  }

  // ── Main view ─────────────────────────────────────────────────────────
  function open(ws_id, app, initialOpts) {
    initialOpts = initialOpts || {};
    const host = el('div.exh');

    // Gather every exhibit, then group by bucket using src/buckets.js.
    function gather() {
      const recs = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          recs.push({ source: s, doc: d, doc_id: d.id, source_id: s.source_id });
        }
      }
      // groupExhibits assigns r.letter and r.bucket on each record.
      if (window.Buckets && window.Buckets.groupExhibits) {
        return window.Buckets.groupExhibits(ws_id, recs);
      }
      // Fallback when buckets module hasn't loaded: workspace-wide letters.
      recs.sort((a, b) => (a.source.uploaded_at || 0) - (b.source.uploaded_at || 0));
      recs.forEach((r, i) => { r.letter = letterFor(i); r.bucket = null; });
      return { groups: [], unbucketed: recs };
    }

    // Flatten the grouped recs back into a single array — handy for
    // search/lookup/active-rec resolution that doesn't care about groups.
    function flatten(grp) {
      return grp.groups.flatMap(g => g.recs).concat(grp.unbucketed);
    }

    let grouped = gather();
    let allRecs = flatten(grouped);
    let visibleRecs = allRecs.slice();
    let activeRec = null;       // selected exhibit
    let activeText = null;      // { full, pages }
    let captured = null;        // { text, before, after, page, charStart, charEnd }
    let workspaceQuery = '';
    let workspaceHits = null;   // { recId -> [{ before, match, after, offset, page }], total }
    let pendingScrollTarget = null; // { text, page } to jump to after middle renders

    // Layout
    const wsSearch = el('input.exh-wssearch-inp', {
      type: 'text',
      placeholder: 'Search across every exhibit in this workspace…',
      spellcheck: 'false', autocomplete: 'off',
    });
    const wsSearchStatus = el('span.exh-wssearch-status', '');
    const wsSearchHits = el('div.exh-wshits', { style: { display: 'none' } });

    const listFilter = el('input.exh-list-filter', {
      type: 'text', placeholder: 'Filter by name, URL, tag…',
      spellcheck: 'false', autocomplete: 'off',
    });
    const listEl = el('div.exh-list');
    const listSum = el('div.exh-list-sum');

    const middleHead = el('div.exh-mid-head');
    const middleBody = el('div.exh-mid-body');
    const findBar = el('div.exh-findbar', { style: { display: 'none' } });
    const findInp = el('input.exh-find-inp', {
      type: 'text', placeholder: 'Find in this exhibit…',
      spellcheck: 'false', autocomplete: 'off',
    });
    const findCount = el('span.exh-find-count', '');
    const findPrev = el('button.exh-find-btn', { onClick: () => jumpFind(-1) }, icon('caret-up', 12));
    const findNext = el('button.exh-find-btn', { onClick: () => jumpFind(1) }, icon('caret-down', 12));
    findBar.appendChild(icon('magnifying-glass', 12));
    findBar.appendChild(findInp);
    findBar.appendChild(findPrev);
    findBar.appendChild(findNext);
    findBar.appendChild(findCount);

    const captureBar = el('div.exh-capturebar', { style: { display: 'none' } });

    host.appendChild(el('div.exh-head',
      el('div.exh-head-ttls',
        el('div.exh-head-eyebrow', 'WORKSPACE'),
        el('div.exh-head-ttl', 'Exhibits'),
        el('div.exh-head-sub',
          'Every document ingested into this workspace. Click an exhibit to read it, ',
          'highlight a passage to cite it. Search the bar above to find a phrase across every exhibit.'),
      ),
      el('div.exh-head-search',
        icon('magnifying-glass', 14),
        wsSearch,
        wsSearchStatus,
      ),
    ));

    host.appendChild(wsSearchHits);

    const splitEl = el('div.exh-split',
      el('div.exh-left',
        el('div.exh-left-head',
          icon('files', 12),
          el('span', 'Exhibits'),
          listSum,
        ),
        el('div.exh-left-filter', icon('funnel', 11), listFilter),
        listEl,
      ),
      el('div.exh-mid',
        middleHead,
        findBar,
        middleBody,
        captureBar,
      ),
    );
    host.appendChild(splitEl);

    // ── List rendering (bucket-grouped) ──────────────────────────────
    //
    // visibleRecs holds the flat filtered set. We re-group it for
    // display so bucket sections appear in their stable creation order
    // and the unbucketed pool always sits at the bottom.
    const COLLAPSED_KEY = 'drafteo.exh.bucket-collapsed.' + ws_id;
    let collapsedBuckets = (() => {
      try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); }
      catch (_) { return new Set(); }
    })();
    function saveCollapsed() {
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedBuckets])); } catch (_) {}
    }

    function applyListFilter() {
      const q = (listFilter.value || '').toLowerCase().trim();
      if (!q) { visibleRecs = allRecs.slice(); }
      else {
        visibleRecs = allRecs.filter(r => {
          const hay = [
            r.source.title, r.source.filename, r.source.source_url,
            r.source.archive_org_url, r.source.description,
            (r.source.tags || []).join(' '), r.doc.title, r.letter,
            r.bucket ? (r.bucket.name + ' ' + (r.bucket.prefix || '')) : '',
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(q);
        });
      }
      renderList();
    }

    function renderList() {
      clear(listEl);
      if (allRecs.length === 0) {
        listEl.appendChild(el('div.exh-list-empty',
          el('div.exh-list-empty-ttl', 'No exhibits yet'),
          el('div.exh-list-empty-sub', 'Open a draft and upload a file or import a URL to add an exhibit to this workspace.'),
        ));
        listSum.textContent = '';
        return;
      }
      listSum.textContent = visibleRecs.length === allRecs.length
        ? String(allRecs.length)
        : visibleRecs.length + ' / ' + allRecs.length;

      // Re-bucket the visible recs (filter may have hidden some bucket
      // members; we still want the bucket header to show with its count).
      const visibleByBucket = new Map(); // bucket_id -> recs
      const visibleLoose = [];
      const visibleSet = new Set(visibleRecs.map(r => r.source_id));
      for (const r of allRecs) {
        if (!visibleSet.has(r.source_id)) continue;
        if (r.bucket) {
          const arr = visibleByBucket.get(r.bucket.id) || [];
          arr.push(r);
          visibleByBucket.set(r.bucket.id, arr);
        } else {
          visibleLoose.push(r);
        }
      }

      if (visibleRecs.length === 0) {
        listEl.appendChild(el('div.exh-list-empty-mini', 'No exhibits match this filter.'));
        renderListFooter();
        return;
      }

      // Render bucket sections in the order grouped() produced.
      for (const g of grouped.groups) {
        const recs = visibleByBucket.get(g.bucket.id);
        if (!recs || recs.length === 0) continue;
        listEl.appendChild(renderBucketSection(g.bucket, recs, recs.length === g.recs.length ? null : g.recs.length));
      }
      // Unbucketed (loose) section
      if (visibleLoose.length > 0) {
        listEl.appendChild(renderBucketSection(null, visibleLoose, grouped.unbucketed.length));
      }
      renderListFooter();
    }

    function renderListFooter() {
      const addBtn = el('button.exh-bucket-add',
        { onClick: openCreateBucketModal },
        '+ New bucket');
      listEl.appendChild(addBtn);
    }

    function renderBucketSection(bucket, recs, fullCount) {
      const isLoose = !bucket;
      const bucketKey = isLoose ? '__loose__' : bucket.id;
      const collapsed = collapsedBuckets.has(bucketKey);

      const head = el('div.exh-bucket-head',
        {
          onClick: () => {
            if (collapsed) collapsedBuckets.delete(bucketKey);
            else collapsedBuckets.add(bucketKey);
            saveCollapsed();
            renderList();
          },
          onContextmenu: isLoose ? null : (e) => { e.preventDefault(); openBucketMenu(e, bucket); },
          title: isLoose ? 'Exhibits with no bucket assignment'
                         : 'Right-click for rename / delete',
        },
        el('span.exh-bucket-caret', collapsed ? '▸' : '▾'),
        el('span.exh-bucket-prefix', isLoose ? '—' : (bucket.prefix || '··')),
        el('span.exh-bucket-name', isLoose ? 'No bucket' : bucket.name),
        el('span.exh-bucket-count', fullCount && fullCount !== recs.length
          ? recs.length + '/' + fullCount
          : String(recs.length)),
      );

      const section = el('div.exh-bucket' + (collapsed ? '.collapsed' : '') + (isLoose ? '.unbucketed' : ''));
      section.appendChild(head);
      if (collapsed) return section;

      const body = el('div.exh-bucket-body');
      for (const r of recs) body.appendChild(buildExhibitRow(r));
      section.appendChild(body);
      return section;
    }

    function buildExhibitRow(r) {
      const s = r.source;
      const kind = s.archive_org_url ? 'archived' : (s.source_url ? 'web' : 'local');
      const hitCount = workspaceHits && workspaceHits.byRec[r.source_id]
        ? workspaceHits.byRec[r.source_id].length : 0;
      const isActive = activeRec && activeRec.source_id === r.source_id;
      return el('button.exh-row' + (isActive ? '.active' : ''),
        {
          type: 'button',
          onClick: () => selectRec(r),
          onContextmenu: (e) => { e.preventDefault(); openRowMenu(e, r); },
        },
        el('div.exh-row-letter', r.letter),
        el('div.exh-row-body',
          el('div.exh-row-ttl', s.title || s.filename || 'Untitled exhibit'),
          el('div.exh-row-meta',
            el('span.exh-pill.' + (kind === 'archived' ? 'ok' : kind === 'web' ? 'warn' : 'mute'),
              icon(kind === 'archived' ? 'check-circle' : kind === 'web' ? 'globe' : 'file', 10),
              ' ', kind),
            el('span.exh-row-dot', '·'),
            el('span', mimeShort(s)),
          ),
        ),
        hitCount > 0
          ? el('div.exh-row-hits', String(hitCount))
          : null,
      );
    }

    // ── Bucket modals ───────────────────────────────────────────────
    function openCreateBucketModal() {
      promptBucket({
        title: 'New exhibit bucket',
        nameValue: '',
        prefixValue: '',
        confirmLabel: 'Create bucket',
        onConfirm: async ({ name, prefix }) => {
          if (!window.Buckets) return;
          await window.Buckets.createBucket(ws_id, { name, prefix });
        },
      });
    }

    function openRenameBucketModal(bucket) {
      promptBucket({
        title: 'Rename bucket',
        nameValue: bucket.name,
        prefixValue: bucket.prefix || '',
        confirmLabel: 'Save',
        onConfirm: async ({ name, prefix }) => {
          if (!window.Buckets) return;
          await window.Buckets.updateBucket(ws_id, bucket.id, { name, prefix });
        },
      });
    }

    function promptBucket(opts) {
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
      function close() { scrim.remove(); }

      const nameInp = el('input', {
        type: 'text', value: opts.nameValue || '',
        placeholder: 'Plaintiff · Defendant · Witness statements · …',
      });
      const prefixInp = el('input', {
        type: 'text', value: opts.prefixValue || '',
        placeholder: 'PX · DX · WS · (auto)',
        style: { textTransform: 'uppercase', letterSpacing: '0.04em' },
        maxlength: 6,
      });

      const modal = el('div.modal', { onClick: e => e.stopPropagation() },
        el('div.m-head',
          el('div',
            el('div.ttl', opts.title),
            el('div.sub', 'Bucketed exhibits get a prefix-scoped letter (PX-A, PX-B…). Leave the prefix blank to auto-derive it from the name.'),
          ),
          el('button.ghost', { onClick: close }, '✕'),
        ),
        el('div.m-body',
          el('label', 'Bucket name'),
          nameInp,
          el('label', { style: { marginTop: '12px' } }, 'Prefix (optional)'),
          prefixInp,
        ),
        el('div.m-foot',
          el('div'),
          el('div.actions',
            el('button.ghost', { onClick: close }, 'Cancel'),
            el('button.primary', {
              onClick: async () => {
                const name = (nameInp.value || '').trim();
                if (!name) { nameInp.focus(); return; }
                const prefix = (prefixInp.value || '').trim();
                await opts.onConfirm({ name, prefix });
                close();
              },
            }, opts.confirmLabel),
          ),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => nameInp.focus(), 50);
    }

    function openBucketMenu(e, bucket) {
      const menu = el('div.context-menu',
        { style: { left: e.clientX + 'px', top: e.clientY + 'px', minWidth: '200px' } });
      function row(ic, text, action, extra) {
        return el('div',
          { onClick: () => { closeMenu(); action(); }, style: extra || null },
          icon(ic, 13), ' ', text);
      }
      menu.appendChild(row('pencil-simple', 'Rename / edit prefix', () => openRenameBucketModal(bucket)));
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      menu.appendChild(row('trash', 'Delete bucket (exhibits become loose)',
        async () => {
          const ok = await DOM.confirmDialog({
            title: 'Delete bucket "' + bucket.name + '"?',
            body: 'Exhibits in this bucket return to the No-bucket pool. They keep their workspace-wide letters.',
            confirmLabel: 'Delete bucket',
            cancelLabel: 'Cancel',
            danger: true,
          });
          if (!ok) return;
          if (window.Buckets) await window.Buckets.deleteBucket(ws_id, bucket.id);
        },
        { color: 'var(--err)' }));
      document.body.appendChild(menu);
      function closeMenu() { menu.remove(); }
      setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
    }

    function openRowMenu(e, r) {
      const menu = el('div.context-menu',
        { style: { left: e.clientX + 'px', top: e.clientY + 'px', minWidth: '220px' } });
      function row(ic, text, action, extra) {
        return el('div',
          { onClick: () => { closeMenu(); action(); }, style: extra || null },
          icon(ic, 13), ' ', text);
      }
      menu.appendChild(row('arrow-square-out', 'Open in full viewer',
        () => { if (window.__openSourceTab) window.__openSourceTab(r.doc_id, r.source_id); }));

      // Bucket sub-menu (flat) — list all buckets + "remove from bucket"
      menu.appendChild(el('div', { style: { padding: '8px 10px 4px', fontFamily: 'var(--mono)', fontSize: '10px', letterSpacing: '0.12em', color: 'var(--ink-faint)' } }, 'MOVE TO BUCKET'));
      const buckets = (window.Buckets && window.Buckets.listBuckets) ? window.Buckets.listBuckets(ws_id) : [];
      for (const b of buckets) {
        const isCurrent = r.bucket && r.bucket.id === b.id;
        menu.appendChild(row('folder',
          (b.prefix ? b.prefix + ' · ' : '') + b.name + (isCurrent ? '  ✓' : ''),
          async () => {
            if (window.Buckets) await window.Buckets.setSourceBucket(ws_id, r.source_id, b.id);
          }));
      }
      menu.appendChild(row('folder-minus', 'Remove from bucket (loose)',
        async () => {
          if (window.Buckets) await window.Buckets.setSourceBucket(ws_id, r.source_id, null);
        }));
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      menu.appendChild(row('plus', 'New bucket…', openCreateBucketModal));

      document.body.appendChild(menu);
      function closeMenu() { menu.remove(); }
      setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
    }

    function mimeShort(s) {
      const m = (s.mime || '').toLowerCase();
      if (m === 'application/pdf') return 'PDF';
      if (m === 'text/html' || s.source_url) return 'Web';
      if (m.startsWith('image/')) return 'Image';
      if (m.startsWith('audio/')) return 'Audio';
      if (m.startsWith('video/')) return 'Video';
      if (m.startsWith('text/')) return 'Text';
      return DOM.fileExt ? DOM.fileExt(s.mime, s.filename) : 'File';
    }

    // ── Middle pane ─────────────────────────────────────────────────
    async function renderMiddle() {
      clear(middleHead);
      clear(middleBody);
      captureBar.style.display = 'none';
      captured = null;

      if (!activeRec) {
        findBar.style.display = 'none';
        middleBody.appendChild(el('div.exh-mid-empty',
          icon('arrow-left', 28),
          el('div.exh-mid-empty-ttl', 'Pick an exhibit on the left'),
          el('div.exh-mid-empty-sub',
            'Or use the workspace search up top to find a phrase across every exhibit at once.'),
        ));
        return;
      }

      const s = activeRec.source;
      const isPdf = (s.mime || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(s.filename || '');
      const isHtml = (s.mime || '').toLowerCase() === 'text/html' || !!s.source_url;
      const isMedia = (s.mime || '').startsWith('image/') ||
                       (s.mime || '').startsWith('audio/') ||
                       (s.mime || '').startsWith('video/');
      const archUrl = s.archive_org_url || s.source_url || null;

      // Header
      middleHead.appendChild(el('div.exh-mid-id',
        el('div.exh-mid-letter', activeRec.letter),
        el('div.exh-mid-ttls',
          el('div.exh-mid-ttl', s.title || s.filename || 'Untitled exhibit'),
          el('div.exh-mid-sub',
            el('span', isPdf ? 'PDF' : isHtml ? 'Web' : (s.mime || 'file')),
            el('span.exh-mid-dot', '·'),
            el('span', DOM.fmtBytes ? DOM.fmtBytes(s.size_bytes || 0) : (s.size_bytes || 0) + 'B'),
            archUrl ? el('span.exh-mid-dot', '·') : null,
            archUrl ? el('a.exh-mid-link', { href: archUrl, target: '_blank', rel: 'noopener' },
                          s.archive_org_url ? 'archive.org' : 'open original') : null,
          ),
        ),
      ));
      middleHead.appendChild(el('div.exh-mid-actions',
        el('button.exh-chip', {
          onClick: () => { if (window.__openSourceTab) window.__openSourceTab(activeRec.doc_id, activeRec.source_id); },
          title: 'Open the full source viewer for this exhibit',
        }, icon('arrow-square-out', 11), ' Full viewer'),
      ));

      if (isMedia) {
        findBar.style.display = 'none';
        middleBody.appendChild(el('div.exh-mid-media',
          icon((s.mime || '').startsWith('image/') ? 'image' : (s.mime || '').startsWith('audio/') ? 'speaker-high' : 'video', 36),
          el('div.exh-mid-empty-ttl', 'No inline text to grab'),
          el('div.exh-mid-empty-sub',
            'This exhibit is binary media. Open it in the full viewer to play or cite it as a whole-source reference.'),
          el('button.exh-chip', {
            onClick: () => { if (window.__openSourceTab) window.__openSourceTab(activeRec.doc_id, activeRec.source_id); },
          }, icon('arrow-square-out', 11), ' Open in full viewer'),
        ));
        return;
      }

      findBar.style.display = '';
      findInp.value = '';
      findCount.textContent = '';

      const loading = el('div.exh-mid-loading',
        el('div.exh-spinner'),
        el('span', 'Loading exhibit text…'),
      );
      middleBody.appendChild(loading);

      const reqRec = activeRec;
      const url = await ensureBlobUrl(s);
      if (reqRec !== activeRec) return;
      if (!url) {
        clear(middleBody);
        middleBody.appendChild(el('div.exh-mid-fallback',
          el('div.exh-mid-empty-ttl', 'Couldn\'t load the exhibit'),
          el('div.exh-mid-empty-sub',
            'The binary isn\'t in your local media store. ' +
            (archUrl ? 'Open the archive copy in a new tab to read it.' : 'No archive copy is available.')),
          archUrl ? el('a.exh-chip.primary', { href: archUrl, target: '_blank', rel: 'noopener' },
                       icon('arrow-square-out', 11), ' Open in new tab') : null,
        ));
        return;
      }

      activeText = await extractTextFor(s);
      if (reqRec !== activeRec) return;

      clear(middleBody);
      if (isPdf) {
        if (!pdfjs()) {
          middleBody.appendChild(pdfFallback(s, archUrl));
          return;
        }
        await renderPdfInto(middleBody, url, reqRec);
      } else if (isHtml || (s.mime || '').startsWith('text/')) {
        renderTextInto(middleBody, activeText.full || '');
      } else {
        middleBody.appendChild(pdfFallback(s, archUrl));
      }

      // Apply any pending workspace-search jump
      if (pendingScrollTarget) {
        const t = pendingScrollTarget; pendingScrollTarget = null;
        setTimeout(() => jumpToTextInMiddle(t.text, t.page), 80);
      }
    }

    function pdfFallback(s, archUrl) {
      return el('div.exh-mid-fallback',
        el('div.exh-mid-empty-ttl', 'PDF renderer unavailable'),
        el('div.exh-mid-empty-sub',
          'PDF.js didn\'t load. Open the exhibit in a new tab — or use the paste-and-cite fallback in the full viewer.'),
        archUrl ? el('a.exh-chip.primary', { href: archUrl, target: '_blank', rel: 'noopener' },
                     icon('arrow-square-out', 11), ' Open in new tab') : null,
      );
    }

    // ── PDF.js rendering with selectable text layer ──────────────────
    async function renderPdfInto(host, url, recAtStart) {
      const wrap = el('div.exh-pdf');
      host.appendChild(wrap);

      let pdf;
      try {
        pdf = await pdfjs().getDocument({ url }).promise;
      } catch (e) {
        host.removeChild(wrap);
        host.appendChild(pdfFallback(activeRec.source, activeRec.source.archive_org_url));
        return;
      }
      if (recAtStart !== activeRec) return;

      // Render each page sequentially. Each page = a positioned div
      // containing a canvas (image) and a text layer (selectable spans
      // matching the canvas glyphs 1:1, so the user selects what they
      // see). data-page-number on the page div is how citation pulls
      // the page out of the selection.
      const scale = 1.35;
      for (let i = 1; i <= pdf.numPages; i++) {
        if (recAtStart !== activeRec) return;
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const pageEl = el('div.exh-pdf-page', { dataset: { pageNumber: String(i) } });
        pageEl.style.width = viewport.width + 'px';
        pageEl.style.height = viewport.height + 'px';
        wrap.appendChild(pageEl);

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = 'exh-pdf-canvas';
        pageEl.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        const textLayerDiv = el('div.exh-pdf-textlayer');
        textLayerDiv.style.width = viewport.width + 'px';
        textLayerDiv.style.height = viewport.height + 'px';
        pageEl.appendChild(textLayerDiv);

        const pageLbl = el('div.exh-pdf-pagelbl', 'p. ' + i);
        pageEl.appendChild(pageLbl);

        await page.render({ canvasContext: ctx, viewport }).promise;
        if (recAtStart !== activeRec) return;

        try {
          const tc = await page.getTextContent();
          const textDivs = [];
          // pdf.js v3 API: renderTextLayer({ textContent, container,
          // viewport, textDivs }) → { promise }. v4 expects
          // textContentSource. Pass both so either build works.
          const tlTask = pdfjs().renderTextLayer({
            textContent: tc,
            textContentSource: tc,
            container: textLayerDiv,
            viewport,
            textDivs,
          });
          if (tlTask && tlTask.promise) await tlTask.promise;
          else if (tlTask && typeof tlTask.then === 'function') await tlTask;
        } catch (e) { /* text layer best-effort */ }
      }

      attachSelectionListener(wrap, true);
    }

    function renderTextInto(host, text) {
      const scroll = el('div.exh-text-scroll');
      const pre = el('pre.exh-text', text || '(no extractable text)');
      scroll.appendChild(pre);
      host.appendChild(scroll);
      attachSelectionListener(scroll, false);
    }

    // ── Selection → capture ──────────────────────────────────────────
    function attachSelectionListener(scope, isPdf) {
      const onChange = () => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed) { hideCapture(); return; }
        if (!scope.contains(sel.anchorNode) || !scope.contains(sel.focusNode)) return;
        const text = sel.toString().trim();
        if (!text || text.length < 2) { hideCapture(); return; }

        let page = null;
        if (isPdf) {
          page = pageFromNode(sel.anchorNode) || pageFromNode(sel.focusNode);
        } else if (activeText && activeText.pages && activeText.pages.length) {
          // Text-page heuristic if we have pages — usually we won't.
          page = null;
        }

        // Pull surrounding context from the visible text for the
        // citation provenance.
        let before = '', after = '';
        try {
          const range = sel.getRangeAt(0);
          before = extractContextBefore(range, scope, 100);
          after = extractContextAfter(range, scope, 100);
        } catch (_) {}

        captured = { text, before, after, page };
        showCapture();
      };
      scope.addEventListener('mouseup', onChange);
      scope.addEventListener('keyup', onChange);
      scope.addEventListener('touchend', onChange);
    }

    function pageFromNode(n) {
      let cur = n && n.nodeType === 3 ? n.parentNode : n;
      while (cur && cur !== document.body) {
        if (cur.dataset && cur.dataset.pageNumber) return parseInt(cur.dataset.pageNumber, 10);
        cur = cur.parentNode;
      }
      return null;
    }

    function extractContextBefore(range, scope, n) {
      const r = document.createRange();
      r.selectNodeContents(scope);
      r.setEnd(range.startContainer, range.startOffset);
      const s = r.toString();
      return s.slice(Math.max(0, s.length - n));
    }
    function extractContextAfter(range, scope, n) {
      const r = document.createRange();
      r.selectNodeContents(scope);
      r.setStart(range.endContainer, range.endOffset);
      const s = r.toString();
      return s.slice(0, n);
    }

    function showCapture() {
      clear(captureBar);
      const c = captured;
      const pagePill = c.page ? el('span.exh-cap-page', 'p. ' + c.page) : null;

      captureBar.appendChild(el('div.exh-cap-quote',
        c.before ? el('span.exh-cap-ctx', '…' + c.before.slice(-60).trim() + ' ') : null,
        el('mark.exh-cap-mark', c.text),
        c.after ? el('span.exh-cap-ctx', ' ' + c.after.slice(0, 60).trim() + '…') : null,
      ));
      captureBar.appendChild(el('div.exh-cap-meta',
        el('span.exh-cap-letter', activeRec ? activeRec.letter : '?'),
        el('span.exh-cap-srctitle', (activeRec && activeRec.source.title) || ''),
        pagePill,
        el('span.exh-cap-len', c.text.length + ' chars'),
      ));
      captureBar.appendChild(el('div.exh-cap-actions',
        el('button.exh-cap-btn.primary', {
          onClick: () => doSave(),
          title: 'Save this passage as cited text in the workspace sidebar',
        }, icon('scissors', 12), ' Save as cited text'),
        el('button.exh-cap-btn', {
          onClick: () => doStage(),
          title: 'Stash this passage for the next "Cite" click in an editor',
        }, icon('arrow-bend-up-right', 12), ' Stage for editor'),
        el('button.exh-cap-btn.ghost', {
          onClick: () => doCopyOnly(),
          title: 'Copy just the highlighted text',
        }, icon('copy', 12), ' Copy'),
        el('button.exh-cap-close', { onClick: hideCapture, title: 'Dismiss' }, '✕'),
      ));
      captureBar.style.display = '';
    }

    function hideCapture() {
      captureBar.style.display = 'none';
      clear(captureBar);
      captured = null;
    }

    async function doSave() {
      if (!captured || !activeRec) return;
      const c = captured;
      const s = activeRec.source;
      const pageStr = c.page ? 'p. ' + c.page : '';
      try {
        await Store.createExhibit(ws_id, {
          text: c.text,
          label: '',
          note: '',
          tags: pageStr ? [pageStr] : [],
          source_id: activeRec.source_id,
          doc_id: activeRec.doc_id,
          char_start: null, char_end: null,
          context_before: pageStr ? '[' + pageStr + '] ' + (c.before || '') : (c.before || ''),
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
            page: c.page || null,
            exhibit_letter: activeRec.letter,
          },
        });
        DOM.toast('CITED TEXT SAVED',
          'Exhibit ' + activeRec.letter + (c.page ? ' · p. ' + c.page : '') + ' — "' +
          c.text.slice(0, 60) + (c.text.length > 60 ? '…' : '') + '"', 3000);
        if (window.__refreshSidebar) window.__refreshSidebar();
        hideCapture();
      } catch (e) {
        DOM.toast('SAVE FAILED', e.message || String(e), 3500);
      }
    }

    function doStage() {
      if (!captured) return;
      const c = captured;
      const s = activeRec.source;
      const pageStr = c.page ? ' (Exhibit ' + activeRec.letter + ', p. ' + c.page + ')' : ' (Exhibit ' + activeRec.letter + ')';
      window.__stagedPassage = c.text + pageStr;
      DOM.toast('PASSAGE STAGED', 'Switch to a draft and click Cite to attach.', 4000);
    }

    async function doCopyOnly() {
      if (!captured) return;
      try { await navigator.clipboard.writeText(captured.text); DOM.toast('COPIED', captured.text.slice(0, 60), 2200); }
      catch (_) { DOM.toast('COPY FAILED', 'Clipboard unavailable.'); }
    }

    // ── Find inside current exhibit ──────────────────────────────────
    let findHitsArr = [];
    let findIdx = -1;
    function refreshFind() {
      // For text view, walk text nodes and wrap matches as <mark.exh-hit>.
      // For PDF view, use the text-layer spans (already in DOM).
      const q = (findInp.value || '').trim().toLowerCase();
      findHitsArr = [];
      findIdx = -1;
      const scope = middleBody;
      // Remove old marks (text view only)
      scope.querySelectorAll('mark.exh-hit').forEach(m => {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize && parent.normalize();
      });
      scope.querySelectorAll('.exh-pdf-textlayer .exh-hit-pdf').forEach(s => s.classList.remove('exh-hit-pdf', 'active'));

      if (!q) { findCount.textContent = ''; return; }

      // Text view
      const pre = scope.querySelector('pre.exh-text');
      if (pre) {
        const txt = pre.textContent;
        const lo = txt.toLowerCase();
        const pieces = [];
        let i = 0;
        while (true) {
          const idx = lo.indexOf(q, i);
          if (idx < 0) { pieces.push(document.createTextNode(txt.slice(i))); break; }
          if (idx > i) pieces.push(document.createTextNode(txt.slice(i, idx)));
          const m = el('mark.exh-hit', txt.slice(idx, idx + q.length));
          pieces.push(m);
          findHitsArr.push(m);
          i = idx + q.length;
        }
        clear(pre);
        for (const p of pieces) pre.appendChild(p);
      }

      // PDF view — flag spans whose text contains the query
      const spans = scope.querySelectorAll('.exh-pdf-textlayer span');
      spans.forEach(span => {
        if ((span.textContent || '').toLowerCase().includes(q)) {
          span.classList.add('exh-hit-pdf');
          findHitsArr.push(span);
        }
      });

      if (findHitsArr.length > 0) {
        findIdx = 0;
        focusFindIdx();
      }
      findCount.textContent = findHitsArr.length === 0 ? '0 / 0' : (findIdx + 1) + ' / ' + findHitsArr.length;
    }
    function focusFindIdx() {
      findHitsArr.forEach((m, i) => m.classList.toggle('active', i === findIdx));
      const cur = findHitsArr[findIdx];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    function jumpFind(dir) {
      if (findHitsArr.length === 0) return;
      findIdx = (findIdx + dir + findHitsArr.length) % findHitsArr.length;
      findCount.textContent = (findIdx + 1) + ' / ' + findHitsArr.length;
      focusFindIdx();
    }
    findInp.addEventListener('input', refreshFind);
    findInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); jumpFind(e.shiftKey ? -1 : 1); }
    });

    // Used by workspace-search-result → open exhibit, then jump to span.
    function jumpToTextInMiddle(text, page) {
      if (!text) return;
      // For PDFs: scroll to the page first, then find the span inside.
      if (page) {
        const pageEl = middleBody.querySelector('.exh-pdf-page[data-page-number="' + page + '"]');
        if (pageEl) pageEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      // Then run the in-exhibit find on a short prefix so it gets visually marked.
      findInp.value = text.slice(0, Math.min(text.length, 36));
      refreshFind();
    }

    // ── Workspace-wide search (top bar) ──────────────────────────────
    let wsSearchToken = 0;
    async function doWorkspaceSearch(q) {
      workspaceQuery = q;
      wsSearchToken++;
      const myToken = wsSearchToken;
      if (!q || q.length < 2) {
        workspaceHits = null;
        wsSearchStatus.textContent = '';
        wsSearchHits.style.display = 'none';
        renderList();
        return;
      }
      wsSearchStatus.textContent = 'Scanning ' + allRecs.length + ' exhibits…';
      wsSearchHits.style.display = '';
      clear(wsSearchHits);
      wsSearchHits.appendChild(el('div.exh-wshits-loading',
        el('div.exh-spinner'),
        el('span', 'Extracting & scanning exhibit text…'),
      ));

      const byRec = {};
      let total = 0;
      for (const r of allRecs) {
        if (myToken !== wsSearchToken) return;
        const rec = await extractTextFor(r.source);
        if (myToken !== wsSearchToken) return;
        const hits = findHits(rec.full || '', q, 6);
        if (hits.length) {
          // Attach page numbers for PDFs
          for (const h of hits) h.page = pageForOffset(rec, h.offset);
          byRec[r.source_id] = hits;
          total += hits.length;
        }
      }
      if (myToken !== wsSearchToken) return;
      workspaceHits = { byRec, total };
      renderWsHits();
      renderList();
      wsSearchStatus.textContent = total + ' hit' + (total === 1 ? '' : 's') +
        ' in ' + Object.keys(byRec).length + ' exhibit' + (Object.keys(byRec).length === 1 ? '' : 's');
    }

    function renderWsHits() {
      clear(wsSearchHits);
      if (!workspaceHits || workspaceHits.total === 0) {
        wsSearchHits.appendChild(el('div.exh-wshits-empty',
          'No matches for "' + workspaceQuery + '" in any exhibit\'s extracted text.'));
        return;
      }
      const head = el('div.exh-wshits-head',
        el('span', icon('list-bullets', 11),
          ' Hits across ' + Object.keys(workspaceHits.byRec).length + ' exhibit' +
          (Object.keys(workspaceHits.byRec).length === 1 ? '' : 's')),
        el('button.exh-wshits-close', { onClick: () => { wsSearch.value = ''; doWorkspaceSearch(''); } }, '✕ clear'),
      );
      wsSearchHits.appendChild(head);

      const list = el('div.exh-wshits-list');
      // Order: exhibits in letter order, hits in document order
      const recById = Object.fromEntries(allRecs.map(r => [r.source_id, r]));
      const ordered = Object.keys(workspaceHits.byRec)
        .map(sid => recById[sid]).filter(Boolean)
        .sort((a, b) => a.letter.localeCompare(b.letter, undefined, { numeric: true }));

      for (const r of ordered) {
        const hits = workspaceHits.byRec[r.source_id];
        list.appendChild(el('div.exh-wshits-grp',
          el('div.exh-wshits-grp-head',
            el('span.exh-row-letter', r.letter),
            el('span.exh-wshits-grp-ttl', r.source.title || r.source.filename || 'Untitled'),
            el('span.exh-wshits-grp-count', hits.length + ' hit' + (hits.length === 1 ? '' : 's')),
          ),
          ...hits.map(h => el('button.exh-wshits-hit', {
            onClick: () => openHit(r, h),
          },
            el('div.exh-wshits-hit-text',
              el('span.exh-wshits-hit-ctx', h.before),
              el('mark.exh-wshits-hit-mark', h.match),
              el('span.exh-wshits-hit-ctx', h.after),
            ),
            el('div.exh-wshits-hit-meta',
              h.page ? el('span.exh-pill.mute', 'p. ' + h.page) : null,
              el('span.exh-pill.go', icon('arrow-right', 9), ' open'),
            ),
          )),
        ));
      }
      wsSearchHits.appendChild(list);
    }

    function openHit(r, hit) {
      pendingScrollTarget = { text: hit.match, page: hit.page };
      selectRec(r);
    }

    // ── Wiring ──────────────────────────────────────────────────────
    function selectRec(r) {
      activeRec = r;
      hideCapture();
      renderList();
      renderMiddle();
    }

    listFilter.addEventListener('input', applyListFilter);

    let wsDebounce = null;
    wsSearch.addEventListener('input', () => {
      if (wsDebounce) clearTimeout(wsDebounce);
      const v = wsSearch.value;
      wsDebounce = setTimeout(() => doWorkspaceSearch(v.trim()), 250);
    });
    wsSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { wsSearch.value = ''; doWorkspaceSearch(''); }
    });

    const onSourcesUpdated = () => {
      grouped = gather();
      allRecs = flatten(grouped);
      applyListFilter();
      // Refresh active rec object
      if (activeRec) {
        const found = allRecs.find(r => r.source_id === activeRec.source_id);
        if (found) activeRec = found;
      }
    };
    window.addEventListener('drafteo:sources-updated', onSourcesUpdated);
    window.addEventListener('drafteo:buckets-updated', onSourcesUpdated);
    const mo = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        window.removeEventListener('drafteo:sources-updated', onSourcesUpdated);
        window.removeEventListener('drafteo:buckets-updated', onSourcesUpdated);
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Initial state
    renderList();
    renderMiddle();
    if (initialOpts.focusSearch) {
      setTimeout(() => { wsSearch.focus(); wsSearch.select && wsSearch.select(); }, 50);
    } else if (initialOpts.sourceId) {
      const rec = allRecs.find(r => r.source_id === initialOpts.sourceId);
      if (rec) selectRec(rec);
    } else if (allRecs.length === 1) {
      selectRec(allRecs[0]);
    }
    if (initialOpts.query) {
      wsSearch.value = initialOpts.query;
      doWorkspaceSearch(initialOpts.query);
    }

    return host;
  }

  window.ExhibitsIndex = { open, letterFor };
})();
