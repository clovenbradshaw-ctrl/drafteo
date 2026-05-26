// ============ EXHIBIT SHARE / MINI PAGE ============
// An exhibit can be turned into a shareable hyperlink that opens a clean
// mini-page showing the precise span on the original document, as hosted
// on archive.org. The URL is self-contained — every byte needed to render
// the mini-page rides in the hash, so a fresh browser with no DraftEO
// session can still view it.
//
// URL shape:
//   <origin>/<base>/#exhibit=<base64url(JSON)>
//
// Encoded JSON payload (short keys to keep URLs reasonable):
//   {
//     u:  download URL on archive.org (used as the inline source)
//     a:  details URL on archive.org (used for "View on archive.org")
//     m:  MIME type
//     t:  exhibit text (the quoted span)
//     b:  context_before (a chunk of text just before the span)
//     f:  context_after  (a chunk of text just after the span)
//     s:  source title
//     l:  exhibit label  (optional)
//     n:  note           (optional)
//   }

(function () {
  // ── base64url helpers (UTF-8 safe) ──────────────────────────────────────
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ── shareable URL construction ──────────────────────────────────────────
  // Returns null when the exhibit isn't backed by an archived source.
  function buildLink(exhibit, source) {
    const prov = exhibit && exhibit.provenance ? exhibit.provenance : {};
    const archiveId =
      (source && source.archive_org_identifier) || prov.archive_org_identifier || null;
    const archiveFile =
      (source && (source.archive_org_filename || source.filename)) ||
      prov.archive_org_filename || prov.filename || null;
    const archiveDetails =
      (source && source.archive_org_url) || prov.archive_org_url || null;
    if (!archiveId || !archiveFile || !archiveDetails) return null;

    const downloadUrl =
      'https://archive.org/download/' + archiveId + '/' + encodeURIComponent(archiveFile);

    const payload = {
      u: downloadUrl,
      a: archiveDetails,
      m: (source && source.mime) || prov.mime || '',
      t: exhibit.text || '',
      b: exhibit.context_before || '',
      f: exhibit.context_after || '',
      s: (source && (source.title || source.filename)) || prov.source_title || '',
      l: exhibit.label || '',
      n: exhibit.note || '',
    };
    const encoded = b64urlEncode(JSON.stringify(payload));
    const base = location.origin + location.pathname;
    return base + '#exhibit=' + encoded;
  }

  // ── text-fragment URL — works when the user opens archive.org directly
  // in a browser that supports text fragments. Useful as the "Open on
  // archive.org" link so the highlight survives outside our iframe too.
  function buildTextFragmentUrl(payload) {
    if (!payload.u || !payload.t) return payload.a || payload.u || '';
    const pre = (payload.b || '').trim().slice(-40);
    const suf = (payload.f || '').trim().slice(0, 40);
    let frag = '#:~:text=';
    if (pre) frag += encodeURIComponent(pre) + '-,';
    const t = payload.t.trim();
    if (t.length > 120) {
      frag += encodeURIComponent(t.slice(0, 50)) + ',' + encodeURIComponent(t.slice(-50));
    } else {
      frag += encodeURIComponent(t);
    }
    if (suf) frag += ',-' + encodeURIComponent(suf);
    return payload.u + frag;
  }

  // ── hash detection ─────────────────────────────────────────────────────
  function readExhibitHash() {
    const h = (location.hash || '').replace(/^#/, '');
    const m = h.match(/^exhibit=(.+)$/);
    if (!m) return null;
    try {
      return JSON.parse(b64urlDecode(m[1]));
    } catch (e) {
      console.warn('[exhibit-share] failed to decode hash payload', e);
      return null;
    }
  }

  // ── DOM helpers (intentionally local — runs before window.DOM is wired
  // when DraftEO boots straight into mini-page mode) ─────────────────────
  function e(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  // ── highlight a substring inside a live DOM tree ────────────────────────
  // Walks text nodes, builds a plaintext index, finds the best match using
  // (before + text + after) and falls back to (text) alone. Wraps the
  // matched range in a <mark> and scrolls it into view.
  function highlightSpan(root, doc, text, before, after) {
    if (!text) return false;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let full = '';
    const segs = []; // { node, start, end }
    let cur;
    while ((cur = walker.nextNode())) {
      const s = cur.nodeValue;
      segs.push({ node: cur, start: full.length, end: full.length + s.length });
      full += s;
    }
    if (!full) return false;

    // Try progressively looser matches so whitespace/punctuation drift
    // doesn't sink the lookup.
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const candidates = [];
    if (before && after) candidates.push(norm(before).slice(-40) + ' ' + norm(text) + ' ' + norm(after).slice(0, 40));
    if (before) candidates.push(norm(before).slice(-30) + ' ' + norm(text));
    candidates.push(norm(text));

    const flatNorm = full.replace(/\s+/g, ' ');
    // Build a mapping from "flat" indexes back into the original `full`
    // so we can convert match offsets without losing position.
    const flatToFull = new Int32Array(flatNorm.length + 1);
    {
      let j = 0;
      for (let i = 0; i < full.length; i++) {
        if (/\s/.test(full[i])) {
          // Each run of whitespace collapses to one space in flatNorm
          if (j > 0 && flatNorm[j - 1] === ' ') continue;
          flatToFull[j++] = i;
        } else {
          flatToFull[j++] = i;
        }
      }
      flatToFull[j] = full.length;
    }

    let matchStart = -1, matchLen = 0;
    for (const cand of candidates) {
      if (!cand) continue;
      const idx = flatNorm.indexOf(cand);
      if (idx >= 0) {
        // The "text" portion may not start at idx if we prefixed it with context.
        const textNorm = norm(text);
        const tIdx = flatNorm.indexOf(textNorm, idx);
        if (tIdx >= 0 && tIdx < idx + cand.length + 4) {
          matchStart = flatToFull[tIdx];
          matchLen = flatToFull[tIdx + textNorm.length] - matchStart;
          break;
        }
        matchStart = flatToFull[idx];
        matchLen = flatToFull[idx + cand.length] - matchStart;
        break;
      }
    }
    if (matchStart < 0) return false;
    const matchEnd = matchStart + matchLen;

    const findPos = (off) => {
      for (const s of segs) {
        if (off >= s.start && off <= s.end) return { node: s.node, offset: off - s.start };
      }
      return null;
    };
    const a = findPos(matchStart), b = findPos(matchEnd);
    if (!a || !b) return false;

    try {
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const mark = doc.createElement('mark');
      mark.className = 'exh-mini-mark';
      try {
        range.surroundContents(mark);
      } catch (_) {
        // The range crosses element boundaries — fall back to extract/insert.
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      }
      // Center it. rAF gives the browser a tick to lay out the iframe / DOM.
      requestAnimationFrame(() => {
        try { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      });
      return true;
    } catch (err) {
      console.warn('[exhibit-share] highlight failed', err);
      return false;
    }
  }

  // ── inject the mini-page stylesheet once ───────────────────────────────
  function ensureStyles() {
    if (document.getElementById('exh-mini-style')) return;
    const css = `
      .exh-mini-body { margin: 0; background: #0f1014; color: #e5e7eb;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        min-height: 100vh; }
      .exh-mini { max-width: 980px; margin: 0 auto; padding: 28px 24px 60px; }
      .exh-mini-head { display: flex; align-items: flex-start; gap: 18px;
        padding-bottom: 16px; border-bottom: 1px solid #2a2d36; margin-bottom: 20px; }
      .exh-mini-logo { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 12px; letter-spacing: 0.14em; color: #94a3b8; text-decoration: none;
        padding: 6px 10px; border: 1px solid #2a2d36; border-radius: 4px; white-space: nowrap; }
      .exh-mini-logo:hover { color: #e5e7eb; border-color: #475569; }
      .exh-mini-titlewrap { flex: 1; min-width: 0; }
      .exh-mini-eyebrow { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 10px; letter-spacing: 0.18em; color: #64748b; text-transform: uppercase;
        margin-bottom: 6px; }
      .exh-mini-title { font-size: 22px; font-weight: 600; color: #f8fafc;
        line-height: 1.25; word-wrap: break-word; }
      .exh-mini-source { font-size: 13px; color: #94a3b8; margin-top: 6px; word-wrap: break-word; }
      .exh-mini-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .exh-mini-btn { display: inline-flex; align-items: center; gap: 6px;
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
        padding: 8px 12px; border: 1px solid #2a2d36; border-radius: 4px;
        background: #14161c; color: #e5e7eb; cursor: pointer; text-decoration: none; }
      .exh-mini-btn:hover { border-color: #475569; background: #1e2128; }
      .exh-mini-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      .exh-mini-btn.primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
      .exh-mini-quote { margin: 8px 0 22px; padding: 16px 20px;
        border-left: 3px solid #fbbf24; background: #1a1c22; border-radius: 4px;
        font-size: 15px; line-height: 1.65; }
      .exh-mini-quote .ctx { color: #64748b; }
      .exh-mini-quote mark { background: #fbbf24; color: #0f1014;
        padding: 0 2px; border-radius: 2px; }
      .exh-mini-note { color: #cbd5e1; font-size: 13px; line-height: 1.55;
        margin-bottom: 22px; padding-left: 14px; border-left: 2px solid #2a2d36; }
      .exh-mini-doc-head { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
        color: #64748b; margin-bottom: 10px; display: flex; align-items: center;
        gap: 10px; }
      .exh-mini-doc-head .dot { width: 6px; height: 6px; border-radius: 50%;
        background: #475569; display: inline-block; }
      .exh-mini-doc-head.ok .dot { background: #22c55e; }
      .exh-mini-doc-head.warn .dot { background: #f97316; }
      .exh-mini-doc { background: #fff; color: #111; padding: 32px 36px;
        border-radius: 6px; line-height: 1.65; font-size: 15px;
        max-height: 70vh; overflow: auto; }
      .exh-mini-doc pre { white-space: pre-wrap; word-wrap: break-word;
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 13px; line-height: 1.55; margin: 0; }
      .exh-mini-doc.html-content img { max-width: 100%; height: auto; }
      .exh-mini-doc.html-content a { color: #1d4ed8; }
      .exh-mini-doc .exh-mini-mark { background: #fde047; color: #0f1014;
        padding: 1px 2px; border-radius: 2px;
        box-shadow: 0 0 0 4px rgba(253, 224, 71, 0.4); }
      .exh-mini-iframe { width: 100%; height: 70vh; border: 0; border-radius: 6px;
        background: #fff; }
      .exh-mini-fallback { padding: 28px; background: #14161c; border: 1px dashed #2a2d36;
        border-radius: 6px; text-align: center; color: #cbd5e1; }
      .exh-mini-fallback h3 { margin: 0 0 8px; font-size: 16px; color: #f8fafc; }
      .exh-mini-fallback p { margin: 0 0 16px; font-size: 13px; line-height: 1.55; }
      .exh-mini-spinner { display: inline-block; width: 12px; height: 12px;
        border: 2px solid #2a2d36; border-top-color: #94a3b8; border-radius: 50%;
        animation: exh-spin 0.7s linear infinite; }
      @keyframes exh-spin { to { transform: rotate(360deg); } }
      .exh-mini-foot { margin-top: 24px; padding-top: 16px;
        border-top: 1px solid #2a2d36;
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 11px; color: #64748b; text-align: center; }
      .exh-mini-foot a { color: #94a3b8; }
      @media (prefers-color-scheme: light) {
        .exh-mini-body { background: #f8fafc; color: #0f172a; }
        .exh-mini-head { border-bottom-color: #e2e8f0; }
        .exh-mini-logo { border-color: #e2e8f0; color: #475569; }
        .exh-mini-logo:hover { border-color: #94a3b8; color: #0f172a; }
        .exh-mini-eyebrow { color: #64748b; }
        .exh-mini-title { color: #0f172a; }
        .exh-mini-source { color: #475569; }
        .exh-mini-btn { background: #fff; border-color: #e2e8f0; color: #0f172a; }
        .exh-mini-btn:hover { border-color: #94a3b8; background: #f1f5f9; }
        .exh-mini-quote { background: #fff; }
        .exh-mini-note { color: #334155; border-left-color: #e2e8f0; }
        .exh-mini-fallback { background: #fff; border-color: #e2e8f0; color: #334155; }
        .exh-mini-fallback h3 { color: #0f172a; }
        .exh-mini-foot { border-top-color: #e2e8f0; color: #64748b; }
        .exh-mini-foot a { color: #334155; }
      }
    `;
    const tag = document.createElement('style');
    tag.id = 'exh-mini-style';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── render the mini-page ───────────────────────────────────────────────
  async function render(payload, mountEl) {
    ensureStyles();
    document.body.classList.add('exh-mini-body');
    document.title = (payload.l || payload.t || 'Exhibit').slice(0, 60) + ' · DraftEO';

    const mount = mountEl || document.getElementById('root') || document.body;
    while (mount.firstChild) mount.removeChild(mount.firstChild);

    const archiveUrl = payload.a || payload.u || '';
    const textFragUrl = buildTextFragmentUrl(payload);

    const quoteEl = e('div', { class: 'exh-mini-quote' },
      payload.b ? e('span', { class: 'ctx' }, '…' + payload.b + ' ') : null,
      e('mark', null, payload.t || ''),
      payload.f ? e('span', { class: 'ctx' }, ' ' + payload.f + '…') : null,
    );

    const base = location.origin + location.pathname;
    const head = e('div', { class: 'exh-mini-head' },
      e('a', { class: 'exh-mini-logo', href: base, title: 'Open DraftEO' }, '◆ DraftEO'),
      e('div', { class: 'exh-mini-titlewrap' },
        e('div', { class: 'exh-mini-eyebrow' }, 'Exhibit'),
        e('div', { class: 'exh-mini-title' }, payload.l || (payload.t || '').slice(0, 80) || 'Exhibit'),
        payload.s ? e('div', { class: 'exh-mini-source' }, 'from ', e('strong', null, payload.s)) : null,
      ),
      e('div', { class: 'exh-mini-actions' },
        archiveUrl
          ? e('a', { class: 'exh-mini-btn', href: archiveUrl, target: '_blank', rel: 'noopener' }, '↗ archive.org')
          : null,
        e('button', { class: 'exh-mini-btn primary', onclick: copyShareUrl }, '⧉ Copy link'),
      ),
    );

    function copyShareUrl() {
      const url = location.href;
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        ta.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(fallback);
      } else fallback();
      flashToast('Link copied');
    }

    const docHead = e('div', { class: 'exh-mini-doc-head' },
      e('span', { class: 'dot' }),
      e('span', null, 'Loading source from archive.org…'),
      e('span', { class: 'exh-mini-spinner', style: { marginLeft: '6px' } }),
    );

    const docSlot = e('div', null, e('div', { class: 'exh-mini-fallback' },
      e('p', null, 'Fetching the archived document…')));

    const wrap = e('div', { class: 'exh-mini' },
      head,
      quoteEl,
      payload.n ? e('div', { class: 'exh-mini-note' }, payload.n) : null,
      docHead,
      docSlot,
      e('div', { class: 'exh-mini-foot' },
        'Permanently preserved on ',
        e('a', { href: archiveUrl, target: '_blank', rel: 'noopener' }, 'archive.org'),
        '. The span above is highlighted within the original document.',
      ),
    );

    mount.appendChild(wrap);

    // ── load the document inline (with highlight) or fall back to iframe ─
    await loadAndHighlight(payload, docSlot, docHead, textFragUrl);
  }

  function flashToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: '#0f172a', color: '#f8fafc', padding: '10px 18px', borderRadius: '4px',
      fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase',
      fontFamily: 'ui-monospace, monospace', zIndex: '9999',
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  async function loadAndHighlight(payload, slot, head, textFragUrl) {
    const mime = (payload.m || '').toLowerCase();
    const isText = mime.startsWith('text/') || mime === 'application/json'
      || mime === '' || mime === 'application/xhtml+xml';
    const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml'
      || /\.html?$/i.test(payload.u || '');
    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(payload.u || '');

    // Text/HTML: fetch and render inline. archive.org's /download/ endpoint
    // sends Access-Control-Allow-Origin: * for most items.
    if (isText) {
      try {
        const r = await fetch(payload.u);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = await r.text();
        while (slot.firstChild) slot.removeChild(slot.firstChild);

        if (isHtml) {
          // Render the page's main content inline (sanitised) and highlight.
          const parser = new DOMParser();
          const parsed = parser.parseFromString(body, 'text/html');
          parsed.querySelectorAll('script, style, noscript, iframe, link[rel="stylesheet"]').forEach(n => n.remove());
          parsed.querySelectorAll('*').forEach((node) => {
            for (const attr of [...node.attributes]) {
              if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
            }
          });
          const main = parsed.querySelector('article, main, [role="main"]') || parsed.body || parsed.documentElement;
          const container = e('div', { class: 'exh-mini-doc html-content' });
          container.appendChild(main.cloneNode(true));
          slot.appendChild(container);
          const ok = highlightSpan(container, document, payload.t, payload.b, payload.f);
          setStatus(head, ok ? 'ok' : 'warn',
            ok ? 'Showing the archived document with the span highlighted'
               : 'Showing the archived document — exact span not located, see quote above');
        } else {
          // Plaintext — wrap in <pre> and highlight.
          const pre = e('pre', null, body);
          const container = e('div', { class: 'exh-mini-doc' }, pre);
          slot.appendChild(container);
          const ok = highlightSpan(pre, document, payload.t, payload.b, payload.f);
          setStatus(head, ok ? 'ok' : 'warn',
            ok ? 'Showing the archived document with the span highlighted'
               : 'Showing the archived document — exact span not located, see quote above');
        }
        return;
      } catch (err) {
        console.warn('[exhibit-share] inline fetch failed, falling back to iframe', err);
      }
    }

    // Binary / fetch-blocked: iframe the file directly. PDFs render natively;
    // images/audio/video do too. The text-fragment URL gives the browser a
    // hint for HTML content even inside an iframe (best-effort).
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    const iframeSrc = isHtml ? textFragUrl : payload.u;
    const iframe = e('iframe', {
      class: 'exh-mini-iframe',
      src: iframeSrc,
      referrerpolicy: 'no-referrer',
    });
    slot.appendChild(iframe);
    setStatus(head, 'ok', isPdf
      ? 'Showing the archived PDF — see the quote above for the exact span'
      : 'Showing the archived document — see the quote above for the exact span');

    // If everything failed to even point somewhere, surface a graceful fallback.
    if (!payload.u) {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      slot.appendChild(e('div', { class: 'exh-mini-fallback' },
        e('h3', null, 'No archived document available'),
        e('p', null, 'This exhibit isn\'t backed by an archive.org-hosted source.'),
      ));
      setStatus(head, 'warn', 'Quote shown above only');
    }
  }

  function setStatus(head, cls, msg) {
    while (head.firstChild) head.removeChild(head.firstChild);
    head.className = 'exh-mini-doc-head ' + cls;
    head.appendChild(e('span', { class: 'dot' }));
    head.appendChild(e('span', null, msg));
  }

  // ── boot: if the page loads with an exhibit hash, take over before the
  // normal app router has a chance to render. app.js calls
  // `takeOverIfExhibitHash()` and skips its own start() when we return true.
  function takeOverIfExhibitHash() {
    const payload = readExhibitHash();
    if (!payload) return false;
    // Render asynchronously but signal sync that we've claimed the page.
    Promise.resolve().then(() => render(payload));
    return true;
  }

  // Live navigation: if the user pastes a new exhibit link into the same tab.
  window.addEventListener('hashchange', () => {
    const payload = readExhibitHash();
    if (payload) render(payload);
  });

  window.ExhibitShare = {
    buildLink,
    buildTextFragmentUrl,
    takeOverIfExhibitHash,
    render,
  };
})();
