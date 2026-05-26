// ============ SOURCE VIEWER ============
// Robust source viewer: clean compact header + a body that picks the right
// inline renderer for each mime. Listens for archive completion so the
// header badge flips from "uploading" → "archived" without a remount.

(function () {
  const { el, mount, clear } = window.DOM;
  function icon(name, size) { const i = document.createElement('i'); i.className = 'ph ph-' + name; if (size) i.style.fontSize = size + 'px'; return i; }

  // De-chrome a raw plaintext capture: collapse blanks, drop runs of short
  // nav-ish lines (single words, all caps, etc), and remove duplicated lines.
  // Keep prose intact.
  function dechrome(raw) {
    if (!raw) return '';
    const lines = raw.split('\n').map(l => l.trim());
    const out = [];
    let blanks = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l) { if (blanks++ < 1 && out.length > 0) out.push(''); continue; }
      blanks = 0;
      // Skip lines that are too short to be prose and aren't headlines
      // (likely nav: "Home", "Subscribe", "Menu", "Skip to content", etc.)
      if (l.length < 24 && /^[A-Z\s|·•·>›/–\-]+$/.test(l) && !/[a-z]/.test(l)) continue;
      // Skip duplicate of previous
      if (out.length && out[out.length - 1] === l) continue;
      // Skip very short single-word links/buttons surrounded by other shorts
      if (l.length <= 14 && i > 0 && i < lines.length - 1) {
        const prev = lines[i - 1].trim();
        const next = lines[i + 1].trim();
        if ((prev.length <= 14 || !prev) && (next.length <= 14 || !next)) continue;
      }
      out.push(l);
    }
    // Trim trailing blanks
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  // Extract plaintext from an HTML blob using DOMParser. Skips script/style/
  // nav/footer/aside/header tags to keep things readable by default.
  function extractPlaintextFromHtml(htmlString) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      // Remove non-content nodes
      doc.querySelectorAll('script, style, noscript, iframe').forEach(n => n.remove());
      const main = doc.querySelector('article, main, [role="main"]') || doc.body;
      if (!main) return '';
      // innerText collapses whitespace and respects block-level boundaries
      // but DOMParser docs don't run layout — use textContent with block hints.
      const blockSel = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, dt, dd, br, hr, tr';
      main.querySelectorAll(blockSel).forEach(n => {
        n.insertAdjacentText('beforeend', '\n');
      });
      return (main.textContent || '').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch (_) {
      return '';
    }
  }

  function open(doc_id, source_id, ws_id, app) {
    window.__sourceContext = { doc_id, source_id };
    const host = el('div.srcviewer');

    // Header + body get re-rendered in place when the source changes
    // (e.g. archive.org webhook returns with the new URL/identifier).
    const headerSlot = el('div.srcv-header-slot');
    const bodySlot = el('div.srcv-body-slot');
    host.appendChild(headerSlot);
    host.appendChild(bodySlot);

    async function render() {
      const s = Store.getSource(doc_id, source_id);

      clear(headerSlot);
      clear(bodySlot);

      if (!s) {
        bodySlot.appendChild(el('div.srcv-empty', 'Source not found.'));
        return;
      }

      // ---- fetch + decrypt media ----
      // Old DraftEO cached every source as base64 in localStorage and
      // returned it synchronously. The bare-metal foundation keeps the
      // ciphertext on the homeserver and decrypts on demand, so we await
      // a Promise<blobUrl> from Store.fetchMedia (no-op for non-file or
      // URL-only sources).
      let blobUrl = null;
      if (s.mxc_uri) {
        bodySlot.appendChild(el('div.srcv-empty', 'Decrypting…'));
        try { blobUrl = await Store.fetchMedia(s); }
        catch (e) { console.warn('[srcviewer] fetchMedia failed', e); }
        clear(bodySlot);
      }
      const viewUrl = blobUrl || '';
      // archive.org/download/{id}/{filename} serves the original file with
      // proper Content-Type + CORS, so it renders inline in iframes for
      // every type archive.org accepts.
      const archiveDl = (s.archive_org_identifier && (s.archive_org_filename || s.filename))
        ? 'https://archive.org/download/' + s.archive_org_identifier + '/' + encodeURIComponent(s.archive_org_filename || s.filename)
        : null;

      headerSlot.appendChild(buildHeader(s, viewUrl));
      buildBody(bodySlot, s, viewUrl, archiveDl);
    }

    function buildHeader(s, viewUrl) {
      const isWeb = !!s.source_url;
      const archived = !!s.archive_org_url;
      const archiving = !!window.__archivingSources && window.__archivingSources[source_id];

      const status = archived
        ? el('a.srcv-status.ok', { href: s.archive_org_url, target: '_blank', rel: 'noopener', title: 'Open on archive.org' },
            icon('check-circle', 11), 'Archived → ', el('span.srcv-archive-id', s.archive_org_identifier || ''))
        : archiving
          ? el('span.srcv-status.busy', el('span.srcv-spin'), archiving.label || 'Archiving…')
          : el('span.srcv-status.pending', icon('clock', 11), 'Not yet published to archive.org');

      const head = el('div.srcv-head',
        el('div.srcv-id',
          el('div.srcv-fileico' + (isWeb ? '.web' : ''),
            isWeb ? icon('globe') : el('span', DOM.fileExt(s.mime, s.filename))),
          el('div.srcv-meta',
            el('div.srcv-ttl', s.title || s.filename),
            el('div.srcv-sub',
              el('span.srcv-chip', s.mime),
              el('span.srcv-dot'),
              el('span', DOM.fmtBytes(s.size_bytes)),
              isWeb ? el('span.srcv-dot') : null,
              isWeb ? el('span.srcv-host', new URL(s.source_url).hostname) : null,
              !isWeb && s.filename ? el('span.srcv-dot') : null,
              !isWeb && s.filename ? el('span.srcv-fname', s.filename) : null,
            ),
            el('div.srcv-status-row', status),
          ),
        ),
        el('div.srcv-actions',
          viewUrl ? el('a.srcv-btn', { href: viewUrl, target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), el('span', 'Open')) : null,
          viewUrl ? el('a.srcv-btn', { href: viewUrl, download: s.filename }, icon('download-simple'), el('span', 'Download')) : null,
          s.source_url ? el('a.srcv-btn', { href: s.source_url, target: '_blank', rel: 'noopener' }, icon('link'), el('span', 'Original')) : null,
          s.archive_org_url
            ? el('a.srcv-btn.archived', { href: s.archive_org_url, target: '_blank', rel: 'noopener' }, icon('archive'), el('span', 'View on archive.org'))
            : (!archiving && window.SourcePanel && window.SourcePanel.openArchive
                ? el('button.srcv-btn.preserve', {
                    onClick: () => window.SourcePanel.openArchive(doc_id, s, { refreshSources: () => render() })
                  }, icon('archive'), el('span', 'Preserve to archive.org'))
                : null),
        ),
      );

      // Live progress bar while archiving
      if (archiving) {
        head.appendChild(buildProgressBar(archiving));
      }

      // Archived URL row — make it copyable & visible
      if (archived) {
        head.appendChild(el('div.srcv-archive-row',
          el('span.srcv-archive-label', 'archive.org URL'),
          el('a.srcv-archive-url', { href: s.archive_org_url, target: '_blank', rel: 'noopener' }, s.archive_org_url),
          el('button.srcv-copy', {
            title: 'Copy URL',
            onClick: (e) => {
              e.preventDefault();
              navigator.clipboard.writeText(s.archive_org_url).then(() => DOM.toast('COPIED', s.archive_org_url));
            }
          }, icon('copy', 12)),
        ));
      }

      return head;
    }

    function buildProgressBar(state) {
      const pct = Math.max(0, Math.min(100, state.pct || 0));
      const fill = el('div.srcv-bar-fill', { style: { width: pct + '%' } });
      const label = el('span.srcv-bar-label', state.label || 'Working…');
      const pctText = el('span.srcv-bar-pct', pct + '%');
      return el('div.srcv-progress',
        el('div.srcv-bar-track', fill),
        el('div.srcv-bar-meta', label, pctText),
      );
    }

    function buildBody(body, s, viewUrl, archiveDl) {
      if (!viewUrl && !s.plaintext && !s.archive_org_url) {
        body.appendChild(el('div.srcv-empty',
          el('div.srcv-empty-ttl', 'No local copy available'),
          el('div.srcv-empty-sub', 'The binary is missing from your media store. Use the header buttons to open the original or the archive.org page.'),
        ));
        return;
      }

      const mime = s.mime || '';
      const isHtml = mime === 'text/html' || s.source_url;

      // --- Web snapshots / HTML: tab between formatted iframe + plain text ---
      if (isHtml) {
        const tabBar = el('div.srcv-tabs');
        const formBtn = el('button.srcv-tab.active', { onClick: () => show('formatted') }, icon('browser', 12), 'Formatted');
        const readBtn = el('button.srcv-tab', { onClick: () => show('readable') }, icon('text-aa', 12), 'Readable text');
        const rawBtn = el('button.srcv-tab', { onClick: () => show('raw') }, icon('code', 12), 'Raw text');
        tabBar.appendChild(formBtn);
        tabBar.appendChild(readBtn);
        tabBar.appendChild(rawBtn);
        body.appendChild(tabBar);

        const slot = el('div.srcv-tab-slot');
        body.appendChild(slot);

        // Resolve plaintext lazily — prefer cached `s.plaintext`; otherwise
        // fetch the blob/archive URL and run extractPlaintextFromHtml.
        let cachedText = s.plaintext || null;
        async function getPlaintext() {
          if (cachedText) return cachedText;
          const src = viewUrl || archiveDl;
          if (!src) return '';
          try {
            const r = await fetch(src);
            const html = await r.text();
            cachedText = extractPlaintextFromHtml(html);
            return cachedText;
          } catch (_) { return ''; }
        }

        function show(which) {
          clear(slot);
          formBtn.classList.toggle('active', which === 'formatted');
          readBtn.classList.toggle('active', which === 'readable');
          rawBtn.classList.toggle('active', which === 'raw');
          if (which === 'formatted') {
            const src = viewUrl || archiveDl;
            if (!src) { slot.appendChild(el('div.srcv-empty', 'No snapshot available.')); return; }
            const ifr = el('iframe.srcv-iframe', { src, sandbox: 'allow-same-origin' });
            slot.appendChild(ifr);
            ifr.addEventListener('load', () => {
              try { attachQuoteToolbar(ifr.contentDocument.body, ifr.contentDocument); } catch (_) {}
            });
          } else {
            const renderPre = (txt) => {
              const out = which === 'readable' ? dechrome(txt) : txt;
              if (!out) { slot.appendChild(el('div.srcv-empty', 'No text could be extracted.')); return; }
              const pre = el('pre.srcv-text.' + (which === 'readable' ? 'dechrome' : 'fullchrome'), out);
              slot.appendChild(pre);
              attachQuoteToolbar(pre);
            };
            if (cachedText) {
              renderPre(cachedText);
            } else {
              slot.appendChild(el('div.srcv-empty', 'Extracting plaintext…'));
              getPlaintext().then(t => {
                clear(slot);
                renderPre(t || '');
              });
            }
          }
        }
        show('formatted');
        return;
      }

      // --- Non-HTML text: render plaintext with readable/raw toggle ---
      if ((s.plaintext && mime.startsWith('text/')) ||
          mime.startsWith('text/') || mime === 'application/json' ||
          /\.(csv|tsv|md|txt|json)$/i.test(s.filename || '')) {

        const tabBar = el('div.srcv-tabs');
        const readBtn = el('button.srcv-tab.active', { onClick: () => show('readable') }, icon('text-aa', 12), 'Readable');
        const rawBtn = el('button.srcv-tab', { onClick: () => show('raw') }, icon('code', 12), 'Raw');
        tabBar.appendChild(readBtn);
        tabBar.appendChild(rawBtn);
        body.appendChild(tabBar);
        const slot = el('div.srcv-tab-slot');
        body.appendChild(slot);

        let cachedRaw = s.plaintext || null;

        function show(which) {
          clear(slot);
          readBtn.classList.toggle('active', which === 'readable');
          rawBtn.classList.toggle('active', which === 'raw');
          const render = (txt) => {
            const out = which === 'readable' ? dechrome(txt) : txt;
            if (!out) { slot.appendChild(el('div.srcv-empty', 'No content.')); return; }
            const pre = el('pre.srcv-text.' + (which === 'readable' ? 'dechrome' : 'fullchrome'), out);
            slot.appendChild(pre);
            attachQuoteToolbar(pre);
          };
          if (cachedRaw != null) {
            render(cachedRaw);
          } else {
            slot.appendChild(el('div.srcv-empty', 'Loading…'));
            fetch(viewUrl || archiveDl).then(r => r.text()).then(t => {
              cachedRaw = t;
              clear(slot);
              render(cachedRaw);
            }).catch(() => { clear(slot); slot.appendChild(el('div.srcv-empty', 'Could not read text contents.')); });
          }
        }
        show('readable');
        return;
      }

      const inlineUrl = viewUrl || archiveDl;

      if (mime.startsWith('image/')) {
        body.appendChild(el('div.srcv-image-wrap', el('img', { src: inlineUrl, alt: s.title || s.filename })));
        return;
      }
      if (mime.startsWith('audio/')) {
        body.appendChild(el('div.srcv-media-wrap', el('audio', { src: inlineUrl, controls: 'controls' })));
        return;
      }
      if (mime.startsWith('video/')) {
        body.appendChild(el('div.srcv-media-wrap', el('video', { src: inlineUrl, controls: 'controls' })));
        return;
      }
      // PDFs: browsers render natively from blob URLs in iframes
      // (Brave shields can block — fall back to archive.org URL if archived).
      // The native PDF viewer is a browser plugin, so we can't attach
      // selectionchange/contextmenu inside it. Surface a manual "Cite a
      // passage" affordance above the iframe — the user copies text from
      // the PDF, then pastes it into the dialog with a page number.
      if (mime === 'application/pdf') {
        const src = inlineUrl;
        if (!src) { body.appendChild(el('div.srcv-empty', 'No PDF source available.')); return; }
        body.appendChild(buildPdfCiteBar(s));
        body.appendChild(el('iframe.srcv-iframe', { src }));
        return;
      }

      // Any other binary: if we have an archive.org URL, iframe it
      // (archive.org sends correct content-type so the browser handles it).
      if (archiveDl) {
        body.appendChild(el('iframe.srcv-iframe', { src: archiveDl }));
        return;
      }

      // Final fallback — file is binary, no inline preview path.
      body.appendChild(el('div.srcv-empty',
        el('div.srcv-empty-ttl', 'No inline preview for this file type'),
        el('div.srcv-empty-sub', mime + ' — use the buttons above to open or download.'),
      ));
    }

    // ---- live updates ----
    const onArchived = (e) => {
      if (e.detail && e.detail.source_id === source_id) render();
    };
    const onProgress = (e) => {
      if (e.detail && e.detail.source_id === source_id) {
        // Re-render header only (cheap), keep body as-is.
        clear(headerSlot);
        const s = Store.getSource(doc_id, source_id);
        if (s) headerSlot.appendChild(buildHeader(s));
      }
    };
    const onSourcesUpdated = (e) => {
      if (!e.detail) return;
      if (e.detail.doc_id !== doc_id) return;
      if (e.detail.source_id && e.detail.source_id !== source_id) return;
      render();
    };
    const onMediaCached = (e) => {
      const s = Store.getSource(doc_id, source_id);
      if (s && e.detail && e.detail.mxc === s.mxc_uri) render();
    };
    window.addEventListener('drafteo:source-archived', onArchived);
    window.addEventListener('drafteo:source-archive-progress', onProgress);
    window.addEventListener('drafteo:sources-updated', onSourcesUpdated);
    window.addEventListener('drafteo:media-cached', onMediaCached);

    // Initial render
    render();

    return host;
  }

  function attachQuoteToolbar(textHost, scopeDoc) {
    const bar = el('div.srcv-quotebar', { style: { display: 'none' } });
    // Capture the selection at the moment the bar appears — clicking a button
    // can collapse the selection in some browsers, so we don't want to depend
    // on it still being live when the handler runs.
    let captured = '';
    bar.appendChild(el('button', { onMousedown: (e) => e.preventDefault(), onClick: copySel }, icon('copy', 13), el('span', ' Copy')));
    bar.appendChild(el('button.accent', { onMousedown: (e) => e.preventDefault(), onClick: useAsQuote }, icon('quotes', 13), el('span', ' Use as passage')));
    bar.appendChild(el('button.accent', { onMousedown: (e) => e.preventDefault(), onClick: saveExhibit }, icon('scissors', 13), el('span', ' Save as cited text')));
    document.body.appendChild(bar);
    const sourceDoc = scopeDoc || document;

    function place() {
      const sel = sourceDoc.getSelection ? sourceDoc.getSelection() : window.getSelection();
      if (!sel || sel.isCollapsed) { bar.style.display = 'none'; return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { bar.style.display = 'none'; return; }
      // Snapshot the live selection — clicks below shouldn't lose it.
      captured = sel.toString().trim();
      let offsetX = 0, offsetY = 0;
      if (scopeDoc && scopeDoc.defaultView && scopeDoc.defaultView.frameElement) {
        const f = scopeDoc.defaultView.frameElement.getBoundingClientRect();
        offsetX = f.left; offsetY = f.top;
      }
      bar.style.display = 'flex';
      bar.style.left = Math.max(8, rect.left + offsetX + window.scrollX) + 'px';
      bar.style.top = Math.max(8, rect.top + offsetY + window.scrollY - bar.offsetHeight - 8) + 'px';
    }
    sourceDoc.addEventListener('selectionchange', place);
    if (sourceDoc !== document) document.addEventListener('selectionchange', () => { bar.style.display = 'none'; });

    // Right-click on selected text: show OUR menu, not the browser's.
    // Works inside iframe content too (sandbox="allow-same-origin" keeps the
    // origin shared so we can attach contextmenu and call preventDefault).
    sourceDoc.addEventListener('contextmenu', (e) => {
      const sel = sourceDoc.getSelection ? sourceDoc.getSelection() : window.getSelection();
      if (!sel || sel.isCollapsed) return; // let browser handle when nothing selected
      e.preventDefault();
      e.stopPropagation();
      captured = sel.toString().trim();
      // Position bar at mouse pos (translated through iframe offset if needed)
      let offsetX = 0, offsetY = 0;
      if (scopeDoc && scopeDoc.defaultView && scopeDoc.defaultView.frameElement) {
        const f = scopeDoc.defaultView.frameElement.getBoundingClientRect();
        offsetX = f.left; offsetY = f.top;
      }
      bar.style.display = 'flex';
      // Render first to measure
      bar.style.left = '-9999px'; bar.style.top = '-9999px';
      requestAnimationFrame(() => {
        const w = bar.offsetWidth, h = bar.offsetHeight;
        let x = e.clientX + offsetX + window.scrollX + 4;
        let y = e.clientY + offsetY + window.scrollY + 4;
        // Keep inside viewport
        if (x + w > window.scrollX + window.innerWidth - 8) x = window.scrollX + window.innerWidth - w - 8;
        if (y + h > window.scrollY + window.innerHeight - 8) y = e.clientY + offsetY + window.scrollY - h - 4;
        bar.style.left = Math.max(8, x) + 'px';
        bar.style.top = Math.max(8, y) + 'px';
      });
    });

    function selText() {
      const sel = sourceDoc.getSelection ? sourceDoc.getSelection() : window.getSelection();
      const live = sel ? sel.toString().trim() : '';
      return live || captured || '';
    }

    // Compute character offset of a (node, offset) point within textHost
    // by walking text nodes in order. Returns null if the point isn't inside.
    function charOffsetIn(host, node, offset) {
      if (!host || !host.contains(node)) return null;
      let total = 0;
      const walker = sourceDoc.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      let cur;
      while ((cur = walker.nextNode())) {
        if (cur === node) return total + offset;
        total += cur.nodeValue.length;
      }
      return null;
    }

    // Capture ~120 chars before & after the selection for context preview.
    function captureContext() {
      try {
        const sel = sourceDoc.getSelection();
        if (!sel || sel.rangeCount === 0) return { before: '', after: '' };
        const range = sel.getRangeAt(0);
        const host = textHost || sourceDoc.body;
        if (!host) return { before: '', after: '' };
        const fullText = host.innerText || host.textContent || '';
        const selStr = sel.toString();
        const idx = fullText.indexOf(selStr);
        if (idx < 0) return { before: '', after: '' };
        return {
          before: fullText.slice(Math.max(0, idx - 120), idx),
          after: fullText.slice(idx + selStr.length, idx + selStr.length + 120),
        };
      } catch (_) { return { before: '', after: '' }; }
    }

    async function copySel() {
      const t = selText(); if (!t) return;
      try { await navigator.clipboard.writeText(t); DOM.toast('COPIED', '"' + t.slice(0, 80) + '"'); }
      catch (_) { DOM.toast('COPY FAILED', 'Browser blocked clipboard access.'); }
    }
    function useAsQuote() {
      const t = selText(); if (!t) return;
      window.__stagedPassage = t;
      DOM.toast('PASSAGE STAGED', 'Switch to a draft and click Cite to attach it.', 4500);
    }
    function saveExhibit() {
      const t = selText(); if (!t) return;
      const ws_id = window.__currentWs;
      if (!ws_id) { DOM.toast('NO WORKSPACE', 'Open a workspace first.'); return; }
      const meta = window.__sourceContext || {};

      let charStart = null, charEnd = null;
      try {
        const sel = sourceDoc.getSelection();
        const range = sel.getRangeAt(0);
        charStart = charOffsetIn(textHost, range.startContainer, range.startOffset);
        charEnd = charOffsetIn(textHost, range.endContainer, range.endOffset);
      } catch (_) {}

      const ctx = captureContext();
      const src = (meta.source_id && meta.doc_id) ? Store.getSource(meta.doc_id, meta.source_id) : null;

      openSaveExhibitDialog({
        ws_id,
        text: t,
        char_start: charStart,
        char_end: charEnd,
        context_before: ctx.before,
        context_after: ctx.after,
        source_id: meta.source_id || null,
        doc_id: meta.doc_id || null,
        source: src,
      });
      // Clear bar after launching dialog so it doesn't sit there blocking.
      bar.style.display = 'none';
    }
  }

  // Slim toolbar shown above the PDF iframe. The browser's native PDF
  // viewer doesn't expose selections to JS, so this is the entry point
  // for citing prose out of a PDF. The user copies from the PDF, then
  // clicks "Cite passage" and pastes into the dialog.
  function buildPdfCiteBar(source) {
    const ctx = window.__sourceContext || {};
    const bar = el('div.srcv-pdfcitebar',
      el('div.srcv-pdfcitebar-msg',
        icon('quotes', 12),
        el('span', 'Select text in the PDF, copy it (⌘C / Ctrl-C), then click '),
        el('strong', 'Cite passage'),
        el('span', ' to save it as cited text with full provenance.'),
      ),
      el('div.srcv-pdfcitebar-actions',
        el('button.srcv-btn.preserve', {
          onClick: () => openPdfPassageDialog({
            ws_id: window.__currentWs,
            source,
            source_id: ctx.source_id || null,
            doc_id: ctx.doc_id || null,
          }),
        }, icon('scissors', 13), el('span', ' Cite passage')),
      ),
    );
    return bar;
  }

  // Modal: paste-the-passage flow for PDFs (and anywhere a live DOM
  // selection isn't available). Asks for the passage text and an
  // optional page/location, auto-fills from clipboard when possible,
  // then hands off to the standard "Save as cited text" dialog.
  function openPdfPassageDialog(opts) {
    const { ws_id, source, source_id, doc_id } = opts;
    if (!ws_id) { DOM.toast('NO WORKSPACE', 'Open a workspace first.'); return; }

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    const passageTa = el('textarea', {
      rows: 6,
      placeholder: 'Paste the passage you selected in the PDF here (⌘V / Ctrl-V).',
      style: { width: '100%', fontFamily: 'var(--serif)', fontSize: '14px', lineHeight: '1.55' },
    });
    const pageInp = el('input', { type: 'text', placeholder: 'e.g. p. 2  ·  § C  ·  ¶ "Beginning July 1, 2017"' });
    const charsHint = el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '4px' } }, '0 chars');
    passageTa.addEventListener('input', () => {
      const n = (passageTa.value || '').length;
      charsHint.textContent = n + ' char' + (n === 1 ? '' : 's');
    });

    // Try to prefill from clipboard. Most browsers gate this behind a user
    // gesture; this modal opens from a click so we have permission.
    (async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const t = (await navigator.clipboard.readText() || '').trim();
          // Heuristic: only auto-fill if it looks like a passage (>= 8 chars,
          // not obviously a URL).
          if (t && t.length >= 8 && !/^https?:\/\/\S+$/i.test(t)) {
            passageTa.value = t;
            passageTa.dispatchEvent(new Event('input'));
          }
        }
      } catch (_) { /* permission denied — fine, user can paste manually */ }
      setTimeout(() => passageTa.focus(), 30);
    })();

    function next() {
      const text = (passageTa.value || '').trim();
      if (!text) { passageTa.focus(); DOM.toast('PASTE A PASSAGE', 'Copy text from the PDF, then paste it here.', 3000); return; }
      const page = pageInp.value.trim();
      const ctxBefore = page ? ('[' + page + '] ') : '';
      close();
      openSaveExhibitDialog({
        ws_id,
        text,
        char_start: null,
        char_end: null,
        context_before: ctxBefore,
        context_after: '',
        source_id,
        doc_id,
        source,
      });
    }

    const modal = el('div.modal', { style: { width: 'min(620px, 96vw)' }, onClick: (e) => e.stopPropagation() },
      el('div.m-head',
        el('div',
          el('div.ttl', 'Cite a PDF passage'),
          el('div.sub', 'Selections inside the browser\'s native PDF viewer aren\'t visible to the app — paste the passage below.'),
        ),
        el('button.ghost', { onClick: close }, '✕'),
      ),
      el('div.m-body',
        el('label', 'Passage'),
        passageTa,
        charsHint,
        el('label', { style: { marginTop: '10px' } }, 'Page or location (optional)'),
        pageInp,
        source ? el('div', { style: { marginTop: '14px', padding: '10px 12px', background: 'var(--chrome-2)', border: '1px solid var(--border)', borderRadius: '4px', fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--ink-dim)' } },
          el('div', { style: { fontWeight: 600, color: 'var(--ink)', marginBottom: '4px' } }, source.title || source.filename),
          source.archive_org_url
            ? el('div', icon('check-circle', 11), ' Archived — citation will be permanent.')
            : el('div', { style: { color: 'var(--warn)' } }, icon('warning', 11), ' Not yet archived — preserve to archive.org to make this citation immutable.'),
        ) : null,
      ),
      el('div.m-foot',
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)' } },
          'Next step: confirm provenance & save as cited text.'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'Cancel'),
          el('button.primary', { onClick: next }, icon('scissors', 12), ' Continue'),
        ),
      ),
    );

    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey);
  }

  // Dialog: confirm-and-enrich save. Shows the quote with surrounding context,
  // all auto-captured provenance, and editable label/note fields. Empty label
  // is OK — the user wants speed, but they should always SEE what they're
  // saving so they can spot wrong-source captures.
  function openSaveExhibitDialog(opts) {
    const { ws_id, text, char_start, char_end, context_before, context_after, source_id, doc_id, source } = opts;

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    const labelInp = el('input', { type: 'text', placeholder: 'Short label · optional', autofocus: 'autofocus' });
    const noteTa = el('textarea', { rows: 3, placeholder: 'Why does this matter? · optional · markdown OK' });
    const tagsInp = el('input', { type: 'text', placeholder: 'tags, comma, separated' });

    // Render the quote with grey context wings
    const quoteBlock = el('div.exhibit-quote',
      context_before ? el('span.exh-ctx', '…' + context_before) : null,
      el('mark.exh-mark', text),
      context_after ? el('span.exh-ctx', context_after + '…') : null,
    );

    // Provenance rows — every fact we'll permanently bind to this exhibit
    const provRows = [];
    function row(k, v) { provRows.push(el('div.prov-row', el('div.prov-k', k), el('div.prov-v', v))); }

    if (source) {
      row('Source', source.title || source.filename);
      if (source.source_url) row('Original URL', el('a', { href: source.source_url, target: '_blank', rel: 'noopener' }, source.source_url));
      if (source.archive_org_url) {
        row('archive.org', el('a', { href: source.archive_org_url, target: '_blank', rel: 'noopener' }, source.archive_org_url));
      } else {
        row('archive.org', el('span', { style: { color: 'var(--warn)' } }, 'Not yet preserved — cited text is referenceable but not yet immutable.'));
      }
      row('Mime', source.mime || '—');
      if (source.filename && !source.source_url) row('Filename', source.filename);
    } else {
      row('Source', el('span', { style: { color: 'var(--ink-faint)' } }, '(not tied to a stored source)'));
    }
    if (char_start != null && char_end != null) row('Char span', char_start + '–' + char_end + ' (' + (char_end - char_start) + ' chars)');
    row('Captured at', new Date().toLocaleString());

    const provBlock = el('div.exhibit-prov', ...provRows);

    async function submit() {
      const exhibit = await Store.createExhibit(ws_id, {
        text,
        label: labelInp.value.trim(),
        note: noteTa.value.trim(),
        tags: tagsInp.value.split(',').map(t => t.trim()).filter(Boolean),
        source_id,
        doc_id,
        char_start,
        char_end,
        context_before,
        context_after,
        // Permanently snapshot the provenance so the exhibit survives even
        // if the source is later renamed, deleted, or re-archived.
        provenance: source ? {
          source_title: source.title || source.filename,
          filename: source.filename,
          mime: source.mime,
          source_url: source.source_url || null,
          archive_org_url: source.archive_org_url || null,
          archive_org_identifier: source.archive_org_identifier || null,
          archive_org_filename: source.archive_org_filename || source.filename || null,
          captured_at: new Date().toISOString(),
        } : null,
      });
      close();
      DOM.toast('CITED TEXT SAVED', exhibit.label || ('"' + text.slice(0, 60) + '"'), 4000);
      if (window.__refreshSidebar) window.__refreshSidebar();
    }

    const modal = el('div.modal.exhibit-modal', { onClick: (e) => e.stopPropagation() },
      el('div.m-head',
        el('div',
          el('div.ttl', 'Save as cited text'),
          el('div.sub', 'Provenance is captured immutably from the exhibit — including the archive.org URL when preserved.'),
        ),
        el('button.ghost', { onClick: close }, '✕'),
      ),
      el('div.m-body',
        el('label.exh-label', 'Quote'),
        quoteBlock,
        el('label.exh-label', 'Label'),
        labelInp,
        el('label.exh-label', 'Why this matters'),
        noteTa,
        el('label.exh-label', 'Tags'),
        tagsInp,
        el('label.exh-label', 'Provenance'),
        provBlock,
      ),
      el('div.m-foot',
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)' } },
          source && source.archive_org_url
            ? '⛓ Bound to archive.org — citation is permanent.'
            : '⚠ Exhibit not yet preserved. Archive it to make this cited text immutable.'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'Cancel'),
          el('button.primary', { onClick: submit }, icon('scissors', 12), ' Save cited text'),
        ),
      ),
    );

    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey);
    setTimeout(() => labelInp.focus(), 80);
  }

  window.SourceViewer = { open };
})();
