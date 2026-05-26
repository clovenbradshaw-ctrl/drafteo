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

      const reds = Array.isArray(s.redactions) ? s.redactions : [];
      if (reds.length > 0 || s.redactions_applied_at) {
        head.appendChild(buildRedactionsPanel(s, reds));
      }

      return head;
    }

    function buildRedactionsPanel(s, reds) {
      const archived = !!s.archive_org_url;
      const pendingCount = reds.length;
      const wrap = el('div.srcv-redactions' + (pendingCount > 0 ? ' has-pending' : ''));
      const head = el('div.srcv-red-head',
        el('div.srcv-red-title',
          icon('eye-slash', 12),
          el('strong', pendingCount > 0
            ? pendingCount + ' pending redaction' + (pendingCount === 1 ? '' : 's')
            : 'Redactions applied'),
          s.redactions_applied_at
            ? el('span.srcv-red-applied', 'last applied ' + DOM.fmtTimeAgo(s.redactions_applied_at))
            : null,
        ),
        pendingCount > 0 && !archived
          ? el('button.srcv-red-apply', {
              onClick: () => doApplyRedactions(s),
              title: 'Rewrite the source bytes and cascade [REDACTED] into every citing exhibit',
            }, icon('warning', 12), el('span', 'APPLY DESTRUCTIVELY'))
          : null,
      );
      wrap.appendChild(head);

      if (archived && pendingCount > 0) {
        wrap.appendChild(el('div.srcv-red-warn',
          'This source is already on archive.org. The public copy is permanent — pending redactions can\'t be applied.'));
      }

      if (pendingCount > 0) {
        const list = el('div.srcv-red-list');
        for (const r of reds) {
          const meta = r.type === 'text' ? ((r.text || '').length + ' chars')
                    : r.type === 'rect' ? (Math.round((r.w || 0) * 100) + '% × ' + Math.round((r.h || 0) * 100) + '%')
                    : r.type === 'pdf-rect' ? ('PDF page ' + (r.page || '?')) : r.type;
          list.appendChild(el('div.srcv-red-row',
            el('span.srcv-red-type', r.type === 'text' ? 'TEXT' : r.type === 'rect' ? 'IMAGE' : 'PDF'),
            el('span.srcv-red-label', r.label || (r.text ? r.text.slice(0, 60) : meta)),
            el('span.srcv-red-range', meta),
            el('button.srcv-red-remove', {
              title: 'Remove this pending redaction',
              onClick: async () => {
                try { await Store.removeRedaction(doc_id, source_id, r.id); }
                catch (e) { DOM.toast('REMOVE FAILED', e.message || String(e)); }
              },
            }, icon('x', 12)),
          ));
        }
        wrap.appendChild(list);
      }

      return wrap;
    }

    async function doApplyRedactions(s) {
      const ok = await DOM.confirmDialog({
        title: 'Apply redactions destructively?',
        body: 'Rewrites the source bytes (re-uploaded as a fresh mxc) and replaces matching text in every exhibit that quotes this source with [REDACTED]. This cannot be undone.',
        confirmLabel: 'Apply destructively',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!ok) return;
      const progressNode = el('div.srcv-red-progress', 'Working…');
      headerSlot.appendChild(progressNode);
      try {
        await Store.applyRedactions(doc_id, source_id, {
          onProgress: (p) => { progressNode.textContent = p.label || p.stage || 'Working…'; },
        });
        DOM.toast('REDACTED', 'Bytes rewritten · exhibits updated · safe to archive', 5000);
        render();
      } catch (e) {
        DOM.toast('REDACTION FAILED', e.message || String(e), 7000);
        progressNode.textContent = 'Failed: ' + (e.message || String(e));
        progressNode.classList.add('srcv-red-progress-fail');
      }
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
              try {
                attachQuoteToolbar(ifr.contentDocument.body, ifr.contentDocument);
                paintPendingTextRedactions(ifr.contentDocument.body, ifr.contentDocument);
              } catch (_) {}
            });
          } else {
            const renderPre = (txt) => {
              const out = which === 'readable' ? dechrome(txt) : txt;
              if (!out) { slot.appendChild(el('div.srcv-empty', 'No text could be extracted.')); return; }
              const pre = el('pre.srcv-text.' + (which === 'readable' ? 'dechrome' : 'fullchrome'), out);
              slot.appendChild(pre);
              attachQuoteToolbar(pre);
              paintPendingTextRedactions(pre);
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
        const img = el('img', { src: inlineUrl, alt: s.title || s.filename });
        const wrap = el('div.srcv-image-wrap', img);
        body.appendChild(wrap);
        img.addEventListener('load', () => { try { attachImageRedactor(wrap, img); } catch (_) {} });
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
      if (mime === 'application/pdf') {
        const src = inlineUrl;
        if (!src) { body.appendChild(el('div.srcv-empty', 'No PDF source available.')); return; }
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

  // Paint pending text redactions in the live DOM as visible black-box
  // spans so the user can see exactly what will be destroyed. The spans
  // are visual overlays — the underlying text nodes stay intact, so
  // selection/save-as-exhibit/copy still see the original text.
  // Matching is content-based (text + surrounding context), so the same
  // redactions paint correctly in the formatted iframe, readable view,
  // and raw view.
  function paintPendingTextRedactions(textHost, scopeDoc) {
    const meta = window.__sourceContext || {};
    if (!meta.source_id || !meta.doc_id || !textHost) return;
    const s = Store.getSource(meta.doc_id, meta.source_id);
    const reds = s && Array.isArray(s.redactions) ? s.redactions.filter(r => r.type === 'text' && r.text) : [];
    if (reds.length === 0) return;
    const doc = scopeDoc || textHost.ownerDocument || document;

    // Clear any previous marks (re-paint is idempotent).
    try {
      textHost.querySelectorAll('.srcv-redact-mark').forEach((n) => {
        const t = doc.createTextNode(n.textContent);
        n.parentNode.replaceChild(t, n);
      });
      textHost.normalize();
    } catch (_) {}

    for (const r of reds) {
      try { paintOneRedaction(textHost, doc, r); } catch (e) {
        console.warn('[srcviewer] paint redaction failed', e);
      }
    }
  }

  function paintOneRedaction(textHost, doc, r) {
    // Build a fresh index per redaction so painting earlier ones doesn't
    // throw later ones off.
    const segs = [];
    let full = '';
    const walker = doc.createTreeWalker(textHost, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('srcv-redact-mark')) {
        full += n.nodeValue || '';
        segs.push({ node: n, start: full.length - (n.nodeValue || '').length, end: full.length, skip: true });
        continue;
      }
      const v = n.nodeValue || '';
      segs.push({ node: n, start: full.length, end: full.length + v.length, skip: false });
      full += v;
    }

    const range = locateText(full, r.text, r.context_before, r.context_after);
    if (!range) return;
    const [mStart, mEnd] = range;

    for (const seg of segs) {
      if (seg.skip) continue;
      if (seg.end <= mStart || seg.start >= mEnd) continue;
      const localS = Math.max(0, mStart - seg.start);
      const localE = Math.min(seg.node.nodeValue.length, mEnd - seg.start);
      if (localE <= localS) continue;
      const v = seg.node.nodeValue;
      const parent = seg.node.parentNode;
      if (!parent) continue;
      const frag = doc.createDocumentFragment();
      if (localS > 0) frag.appendChild(doc.createTextNode(v.slice(0, localS)));
      const mark = doc.createElement('span');
      mark.className = 'srcv-redact-mark';
      mark.textContent = v.slice(localS, localE);
      mark.title = 'Pending redaction · "' + (r.label || r.text).slice(0, 60) + '"';
      frag.appendChild(mark);
      if (localE < v.length) frag.appendChild(doc.createTextNode(v.slice(localE)));
      parent.replaceChild(frag, seg.node);
    }
  }

  // Same content-aware matching as legacy-store, mirrored here so we
  // don't add a cross-module import for one small function.
  function locateText(haystack, text, ctxBefore, ctxAfter) {
    if (!haystack || !text) return null;
    const norm = (s) => (s || '').replace(/\s+/g, ' ');
    const flat = norm(haystack);
    const target = norm(text);
    if (!target) return null;
    const flatToHay = [];
    {
      let j = 0;
      for (let i = 0; i < haystack.length; i++) {
        const isWs = /\s/.test(haystack[i]);
        if (isWs && j > 0 && flat[j - 1] === ' ') continue;
        flatToHay[j++] = i;
      }
      flatToHay[j] = haystack.length;
    }
    const before = norm(ctxBefore || '').slice(-40);
    const after  = norm(ctxAfter  || '').slice(0, 40);
    const candidates = [];
    if (before && after) candidates.push(before + target + after);
    if (before) candidates.push(before + target);
    if (after)  candidates.push(target + after);
    candidates.push(target);
    for (const cand of candidates) {
      const idx = flat.indexOf(cand);
      if (idx < 0) continue;
      const targetIdxInFlat = flat.indexOf(target, idx);
      if (targetIdxInFlat < 0 || targetIdxInFlat >= idx + cand.length) continue;
      const start = flatToHay[targetIdxInFlat];
      const end   = flatToHay[targetIdxInFlat + target.length];
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) return [start, end];
    }
    return null;
  }

  // Image redaction overlay: a transparent layer above the inline <img>
  // that captures drag-rectangles, stores them as 0..1 relative coords,
  // and shows existing pending rect-redactions as black boxes.
  function attachImageRedactor(wrap, img) {
    const meta = window.__sourceContext || {};
    if (!meta.source_id || !meta.doc_id) return;
    const s = Store.getSource(meta.doc_id, meta.source_id);
    if (!s || s.archive_org_url) return; // no redaction once archived

    let mode = 'view';
    const overlay = el('div.srcv-img-overlay');
    const drawLayer = el('div.srcv-img-draw');
    const toggle = el('button.srcv-img-redact-toggle',
      { onClick: () => setMode(mode === 'view' ? 'redact' : 'view') },
      el('i.ph.ph-eye-slash'), el('span', ' Redact mode'));

    wrap.style.position = wrap.style.position || 'relative';
    wrap.appendChild(overlay);
    overlay.appendChild(drawLayer);
    wrap.appendChild(toggle);

    function setMode(m) {
      mode = m;
      wrap.classList.toggle('srcv-img-redacting', m === 'redact');
      toggle.classList.toggle('active', m === 'redact');
      paintExisting();
    }

    function paintExisting() {
      while (drawLayer.firstChild) drawLayer.removeChild(drawLayer.firstChild);
      const cur = Store.getSource(meta.doc_id, meta.source_id);
      const reds = cur && Array.isArray(cur.redactions) ? cur.redactions.filter(r => r.type === 'rect') : [];
      for (const r of reds) {
        const rect = el('div.srcv-img-rect');
        rect.style.left   = (r.x * 100) + '%';
        rect.style.top    = (r.y * 100) + '%';
        rect.style.width  = (r.w * 100) + '%';
        rect.style.height = (r.h * 100) + '%';
        const rm = el('button.srcv-img-rect-remove', {
          title: 'Remove redaction',
          onClick: async (e) => {
            e.preventDefault(); e.stopPropagation();
            try { await Store.removeRedaction(meta.doc_id, meta.source_id, r.id); paintExisting(); }
            catch (err) { DOM.toast('REMOVE FAILED', err.message || String(err)); }
          },
        }, '✕');
        rect.appendChild(rm);
        drawLayer.appendChild(rect);
      }
    }

    let dragStart = null;
    let dragRect = null;
    overlay.addEventListener('mousedown', (e) => {
      if (mode !== 'redact') return;
      const bounds = overlay.getBoundingClientRect();
      dragStart = { x: e.clientX - bounds.left, y: e.clientY - bounds.top, bounds };
      dragRect = el('div.srcv-img-rect.srcv-img-rect-drawing');
      Object.assign(dragRect.style, { left: dragStart.x + 'px', top: dragStart.y + 'px', width: '0px', height: '0px' });
      drawLayer.appendChild(dragRect);
      e.preventDefault();
    });
    overlay.addEventListener('mousemove', (e) => {
      if (!dragStart || !dragRect) return;
      const x = Math.min(dragStart.bounds.width, Math.max(0, e.clientX - dragStart.bounds.left));
      const y = Math.min(dragStart.bounds.height, Math.max(0, e.clientY - dragStart.bounds.top));
      const left = Math.min(x, dragStart.x);
      const top  = Math.min(y, dragStart.y);
      const w = Math.abs(x - dragStart.x);
      const h = Math.abs(y - dragStart.y);
      Object.assign(dragRect.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
    });
    overlay.addEventListener('mouseup', async (e) => {
      if (!dragStart || !dragRect) return;
      const x = Math.min(dragStart.bounds.width, Math.max(0, e.clientX - dragStart.bounds.left));
      const y = Math.min(dragStart.bounds.height, Math.max(0, e.clientY - dragStart.bounds.top));
      const left = Math.min(x, dragStart.x);
      const top  = Math.min(y, dragStart.y);
      const w = Math.abs(x - dragStart.x);
      const h = Math.abs(y - dragStart.y);
      dragRect.remove(); dragRect = null;
      const b = dragStart.bounds; dragStart = null;
      if (w < 6 || h < 6) return; // ignore tiny drags
      try {
        await Store.addRedaction(meta.doc_id, meta.source_id, {
          type: 'rect', x: left / b.width, y: top / b.height,
          w: w / b.width, h: h / b.height,
          label: 'image area',
        });
        paintExisting();
      } catch (err) {
        DOM.toast('REDACT FAILED', err.message || String(err));
      }
    });

    paintExisting();
  }

  function attachQuoteToolbar(textHost, scopeDoc) {
    const bar = el('div.srcv-quotebar', { style: { display: 'none' } });
    // Capture the selection at the moment the bar appears — clicking a button
    // can collapse the selection in some browsers, so we don't want to depend
    // on it still being live when the handler runs.
    let captured = '';
    bar.appendChild(el('button', { onMousedown: (e) => e.preventDefault(), onClick: copySel }, icon('copy', 13), el('span', ' Copy')));
    bar.appendChild(el('button.accent', { onMousedown: (e) => e.preventDefault(), onClick: useAsQuote }, icon('quotes', 13), el('span', ' Use as passage')));
    bar.appendChild(el('button.accent', { onMousedown: (e) => e.preventDefault(), onClick: saveExhibit }, icon('scissors', 13), el('span', ' Save as exhibit')));
    // Redact only shows when the active source isn't archived yet — once
    // it's public on archive.org, destructive redaction is meaningless.
    const redactBtn = el('button.danger',
      { onMousedown: (e) => e.preventDefault(), onClick: redactSel, style: { display: 'none' } },
      icon('eye-slash', 13), el('span', ' Redact'));
    bar.appendChild(redactBtn);
    document.body.appendChild(bar);
    const sourceDoc = scopeDoc || document;

    function refreshRedactBtn() {
      const meta = window.__sourceContext || {};
      const src = (meta.source_id && meta.doc_id) ? Store.getSource(meta.doc_id, meta.source_id) : null;
      const ok = src && !src.archive_org_url && typeof Store.addRedaction === 'function';
      redactBtn.style.display = ok ? '' : 'none';
    }

    function place() {
      const sel = sourceDoc.getSelection ? sourceDoc.getSelection() : window.getSelection();
      if (!sel || sel.isCollapsed) { bar.style.display = 'none'; return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { bar.style.display = 'none'; return; }
      // Snapshot the live selection — clicks below shouldn't lose it.
      captured = sel.toString().trim();
      refreshRedactBtn();
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
    async function redactSel() {
      const t = selText();
      if (!t) return;
      const meta = window.__sourceContext || {};
      if (!meta.source_id || !meta.doc_id) {
        DOM.toast('NO SOURCE', 'Open a source first.');
        return;
      }
      const ctx = captureContext();
      const preview = t.length > 40 ? t.slice(0, 37) + '…' : t;
      try {
        await Store.addRedaction(meta.doc_id, meta.source_id, {
          type: 'text',
          text: t,
          context_before: ctx.before || '',
          context_after: ctx.after || '',
          label: preview,
        });
        DOM.toast('REDACTION QUEUED', '"' + preview + '" · apply destructively in the source viewer.', 5500);
        bar.style.display = 'none';
        try { sourceDoc.getSelection().removeAllRanges(); } catch (_) {}
      } catch (err) {
        DOM.toast('CANNOT REDACT', err.message || String(err), 6000);
      }
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
        row('archive.org', el('span', { style: { color: 'var(--warn)' } }, 'Not yet preserved — exhibit is referenceable but not yet immutable.'));
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
      DOM.toast('EXHIBIT SAVED', exhibit.label || ('"' + text.slice(0, 60) + '"'), 4000);
      if (window.__refreshSidebar) window.__refreshSidebar();
    }

    const modal = el('div.modal.exhibit-modal', { onClick: (e) => e.stopPropagation() },
      el('div.m-head',
        el('div',
          el('div.ttl', 'Save as exhibit'),
          el('div.sub', 'Provenance is captured immutably from the source — including the archive.org URL when preserved.'),
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
            : '⚠ Source not yet preserved. Archive it to make this exhibit immutable.'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'Cancel'),
          el('button.primary', { onClick: submit }, icon('scissors', 12), ' Save exhibit'),
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
