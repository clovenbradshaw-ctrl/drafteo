// ============ EXPORT (Substack markdown + HTML) ============

(function () {
  const { el } = window.DOM;

  function exportToSubstackMarkdown(doc_id) {
    const doc = Store.getDocument(doc_id);
    const sources = Store.listSources(doc_id);
    const srcById = {}; for (const s of sources) srcById[s.source_id] = s;
    const footnotes = doc.footnotes || {};

    // Each {{cite:KEY}} gets a sequential number; KEY can be a footnote id
    // (fn_*) or a bare source_id.
    const ordering = [];
    const seen = new Set();
    const re = /\{\{cite:([^}]+)\}\}/g;
    let m;
    while ((m = re.exec(doc.body_markdown || ''))) {
      if (!seen.has(m[1])) { ordering.push(m[1]); seen.add(m[1]); }
    }

    let body = (doc.body_markdown || '').replace(re, (_, id) => {
      const idx = ordering.indexOf(id);
      return '[^' + (idx + 1) + ']';
    });

    const fnLines = ordering.map((key, i) => {
      let source_id = key;
      let footnote = null;
      if (footnotes[key]) {
        footnote = footnotes[key];
        source_id = footnote.source_id;
      }
      const s = srcById[source_id];
      if (!s) return '[^' + (i + 1) + ']: Source not found.';
      const title = s.title || s.filename;
      const page = footnote && footnote.page ? ', ' + footnote.page : '';
      const passage = footnote && footnote.supporting_quote ? ' "' + footnote.supporting_quote + '"' : '';
      const link = s.archive_org_url ? '[Source](' + s.archive_org_url + ')' : '[Source: not yet archived]';
      return '[^' + (i + 1) + ']: ' + title + page + '.' + passage + ' ' + link;
    });
    const footnotesStr = fnLines.join('\n');

    let out = '# ' + doc.title + '\n\n';
    if (doc.dek) out += '*' + doc.dek + '*\n\n';
    out += body.trim() + '\n\n';
    if (footnotesStr) out += '---\n\n' + footnotesStr + '\n';
    return out;
  }

  // Substack-friendly rich HTML: citations become superscript links to
  // the source URL (archive.org if available, otherwise the source URL),
  // followed by a numbered "Notes" list at the bottom. Pasting this as
  // rich text into Substack preserves headings, lists, links, and the
  // footnote markers.
  function exportToSubstackHTML(doc_id) {
    const doc = Store.getDocument(doc_id);
    const sources = Store.listSources(doc_id);
    const footnotes = doc.footnotes || {};
    const srcById = {}; for (const s of sources) srcById[s.source_id] = s;

    // First-appearance ordering of all citation keys.
    const ordering = [];
    const seen = new Set();
    const re = /\{\{cite:([^}]+)\}\}/g;
    let m;
    const md = doc.body_markdown || '';
    while ((m = re.exec(md))) {
      if (!seen.has(m[1])) { ordering.push(m[1]); seen.add(m[1]); }
    }

    function resolve(key) {
      let source_id = key;
      let footnote = null;
      if (footnotes[key]) {
        footnote = footnotes[key];
        source_id = footnote.source_id;
      }
      return { source_id, footnote, source: srcById[source_id] };
    }

    function urlFor(s) {
      if (!s) return null;
      return s.archive_org_url || s.source_url || null;
    }

    // Render the body markdown using the existing renderer, then rewrite
    // <span class="cite"> chips into <sup><a>N</a></sup>.
    const { html: rawHtml } = window.MD.render(md, sources);
    const tmp = document.createElement('div');
    tmp.innerHTML = rawHtml;
    for (const chip of tmp.querySelectorAll('span.cite')) {
      const key = chip.dataset.cite;
      const idx = ordering.indexOf(key);
      const n = idx >= 0 ? idx + 1 : '?';
      const { source } = resolve(key);
      const link = urlFor(source);
      const sup = document.createElement('sup');
      if (link) {
        const a = document.createElement('a');
        a.href = link;
        a.textContent = '[' + n + ']';
        sup.appendChild(a);
      } else {
        sup.textContent = '[' + n + ']';
      }
      chip.replaceWith(sup);
    }
    const bodyHtml = tmp.innerHTML;

    // Notes list (numbered, with title + link).
    const notes = ordering.map((key, i) => {
      const { source, footnote } = resolve(key);
      if (!source) return '<li>Source not found.</li>';
      const title = escapeHtml(source.title || source.filename);
      const page = footnote && footnote.page ? ', ' + escapeHtml(footnote.page) : '';
      const passage = footnote && footnote.supporting_quote
        ? ' &ldquo;' + escapeHtml(footnote.supporting_quote) + '&rdquo;'
        : '';
      const link = urlFor(source);
      const linkHtml = link
        ? '<a href="' + escapeHtml(link) + '">' + escapeHtml(link) + '</a>'
        : '<em>not yet archived</em>';
      return '<li><strong>' + title + '</strong>' + page + '.' + passage + ' ' + linkHtml + '</li>';
    }).join('\n');

    const title = escapeHtml(doc.title || 'Untitled');
    const dek = doc.dek ? '<p><em>' + escapeHtml(doc.dek) + '</em></p>' : '';
    const notesBlock = notes
      ? '<hr/>\n<p><strong>Notes</strong></p>\n<ol>\n' + notes + '\n</ol>'
      : '';

    return '<h1>' + title + '</h1>\n' + dek + '\n' + bodyHtml + '\n' + notesBlock;
  }

  function exportToHTML(doc_id) {
    const doc = Store.getDocument(doc_id);
    const sources = Store.listSources(doc_id);
    const { html, ordering } = window.MD.render(doc.body_markdown || '', sources);
    const srcById = {}; for (const s of sources) srcById[s.source_id] = s;

    const fn = ordering.map((id, i) => {
      const s = srcById[id];
      if (!s) return '<li>Source not found.</li>';
      const link = s.archive_org_url ? '<a href="' + s.archive_org_url + '">' + s.archive_org_url + '</a>' : '<em>not yet archived</em>';
      return '<li id="fn-' + (i + 1) + '"><strong>' + (s.title || s.filename) + '.</strong> ' + link + (s.description ? ' — ' + s.description : '') + '</li>';
    }).join('\n');

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 720px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
  h1, h2, h3, h4 { font-family: Georgia, serif; }
  h1 { font-size: 36px; margin-bottom: 8px; }
  .dek { font-size: 17px; color: #555; font-style: italic; margin-bottom: 30px; }
  blockquote { border-left: 3px solid #c47a2b; padding-left: 18px; color: #444; font-style: italic; }
  pre { background: #f3eee5; padding: 14px; overflow-x: auto; font-family: 'Courier Prime', monospace; }
  .cite { display: inline-block; background: #c47a2b; color: white; font-size: 11px; padding: 1px 6px; margin: 0 2px; border-radius: 3px; vertical-align: super; }
  .cite.unarchived { background: #b08f5a; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 40px 0; }
  .footnotes { font-size: 14px; color: #555; }
  .footnotes li { margin-bottom: 8px; }
</style>
</head><body>
<h1>${escapeHtml(doc.title)}</h1>
${doc.dek ? '<div class="dek">' + escapeHtml(doc.dek) + '</div>' : ''}
${html}
${fn ? '<hr/><div class="footnotes"><ol>' + fn + '</ol></div>' : ''}
</body></html>`;
  }

  function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function openExportModal(doc_id) {
    let mode = 'substack';
    const md = exportToSubstackMarkdown(doc_id);
    const html = exportToHTML(doc_id);
    const substackHtml = exportToSubstackHTML(doc_id);

    // Rendered preview surface for the Substack tab — what you'll see
    // when you paste into Substack.
    const preview = el('div', {
      style: {
        width: '100%', height: '360px', overflowY: 'auto',
        background: '#fafafa', color: '#1a1a1a', border: '1px solid var(--border)',
        padding: '20px 24px', borderRadius: '3px',
        fontFamily: 'Georgia, serif', fontSize: '15px', lineHeight: '1.65',
      },
    });
    preview.innerHTML = substackHtml;

    // Raw-text surface (for Markdown / HTML tabs).
    const area = el('textarea', {
      readonly: 'readonly',
      style: { width: '100%', height: '360px', fontFamily: 'var(--mono)', fontSize: '12px', background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)', padding: '12px', resize: 'vertical', boxSizing: 'border-box' },
    });

    const surface = el('div', preview);  // swappable container

    const pending = Store.listSources(doc_id).filter(s => !s.archive_org_url);
    const warn = pending.length > 0 ? el('div', { style: { marginBottom: '10px', padding: '8px 12px', border: '1px solid rgba(200,154,58,0.4)', color: 'var(--warn)', fontFamily: 'var(--mono)', fontSize: '11px' } },
      '⚠ ' + pending.length + ' source' + (pending.length === 1 ? '' : 's') + ' not yet archived. Their citation links will point to the original URL until you publish to archive.org.'
    ) : null;

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });

    const subnote = el('div', { style: { color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: '10px' } });

    function setMode(m) {
      mode = m;
      tabSubstack.classList.toggle('active', m === 'substack');
      tabMd.classList.toggle('active', m === 'markdown');
      tabHtml.classList.toggle('active', m === 'html');
      while (surface.firstChild) surface.removeChild(surface.firstChild);
      if (m === 'substack') {
        preview.innerHTML = substackHtml;
        surface.appendChild(preview);
        subnote.textContent = 'Rendered preview · COPY puts rich text on clipboard so Substack pastes it formatted.';
      } else if (m === 'markdown') {
        area.value = md;
        surface.appendChild(area);
        subnote.textContent = 'Substack markdown source · for fenced-code-aware editors, not Substack itself.';
      } else {
        area.value = html;
        surface.appendChild(area);
        subnote.textContent = 'Full standalone HTML document.';
      }
    }
    const tabSubstack = el('button.ghost.active', { onClick: () => setMode('substack') }, 'SUBSTACK (RICH TEXT)');
    const tabMd = el('button.ghost', { onClick: () => setMode('markdown') }, 'MARKDOWN');
    const tabHtml = el('button.ghost', { onClick: () => setMode('html') }, 'HTML');

    async function copy() {
      try {
        if (mode === 'substack') {
          // Write both text/html and text/plain so the paste target picks
          // the richest format it supports — Substack picks text/html and
          // renders headings, links, lists, superscript notes.
          if (window.ClipboardItem && navigator.clipboard.write) {
            const item = new ClipboardItem({
              'text/html': new Blob([substackHtml], { type: 'text/html' }),
              'text/plain': new Blob([preview.innerText || ''], { type: 'text/plain' }),
            });
            await navigator.clipboard.write([item]);
          } else {
            // Fallback: select the preview, execCommand('copy').
            const range = document.createRange();
            range.selectNodeContents(preview);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
          }
          DOM.toast('COPIED', 'Rich text on clipboard — paste into Substack.');
        } else {
          await navigator.clipboard.writeText(area.value);
          DOM.toast('COPIED', mode === 'markdown' ? 'Markdown on clipboard.' : 'HTML on clipboard.');
        }
      } catch (e) {
        DOM.toast('COPY FAILED', (e.message || String(e)).slice(0, 120), 5000);
      }
    }
    function download() {
      const doc = Store.getDocument(doc_id);
      const base = (doc.title || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'draft';
      let payload, mime, ext;
      if (mode === 'markdown') {
        payload = md; mime = 'text/markdown'; ext = '.md';
      } else if (mode === 'html') {
        payload = html; mime = 'text/html'; ext = '.html';
      } else {
        // Substack rich-text — download as a minimal HTML doc so it
        // opens nicely in a browser or other editor.
        payload = '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(doc.title || 'Draft') + '</title></head><body>' + substackHtml + '</body></html>';
        mime = 'text/html'; ext = '.html';
      }
      const blob = new Blob([payload], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = base + ext;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }

    const modal = el('div.modal', { style: { width: 'min(820px, 96vw)' }, onClick: e => e.stopPropagation() },
      el('div.m-head',
        el('div', el('div.ttl', 'Export'), el('div.sub', 'Citations resolve to archive.org URLs')),
        el('div', { style: { display: 'flex', gap: '6px' } }, tabSubstack, tabMd, tabHtml,
          el('button.ghost', { onClick: () => scrim.remove(), style: { marginLeft: '6px' } }, '✕')),
      ),
      el('div.m-body',
        warn,
        surface,
      ),
      el('div.m-foot',
        subnote,
        el('div.actions',
          el('button.ghost', { onClick: copy }, 'COPY'),
          el('button.primary', { onClick: download }, 'DOWNLOAD'),
        ),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setMode('substack');
  }

  window.Exporter = { openModal: openExportModal, toMarkdown: exportToSubstackMarkdown, toHTML: exportToHTML, toSubstackHTML: exportToSubstackHTML };
})();
