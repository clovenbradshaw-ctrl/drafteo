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
    let mode = 'markdown';
    const md = exportToSubstackMarkdown(doc_id);
    const html = exportToHTML(doc_id);
    const area = el('textarea', { readonly: 'readonly', style: { width: '100%', height: '360px', fontFamily: 'var(--mono)', fontSize: '12px', background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)', padding: '12px', resize: 'vertical' } }, md);

    const pending = Store.listSources(doc_id).filter(s => !s.archive_org_url);
    const warn = pending.length > 0 ? el('div', { style: { marginBottom: '10px', padding: '8px 12px', border: '1px solid rgba(200,154,58,0.4)', color: 'var(--warn)', fontFamily: 'var(--mono)', fontSize: '11px' } },
      '⚠ ' + pending.length + ' source' + (pending.length === 1 ? '' : 's') + ' not yet archived. Their citations will appear as "not yet archived" until you publish them.'
    ) : null;

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
    function setMode(m) {
      mode = m;
      area.value = m === 'markdown' ? md : html;
      tabMd.classList.toggle('active', m === 'markdown');
      tabHtml.classList.toggle('active', m === 'html');
    }
    const tabMd = el('button.ghost.active', { onClick: () => setMode('markdown') }, 'SUBSTACK MARKDOWN');
    const tabHtml = el('button.ghost', { onClick: () => setMode('html') }, 'HTML');

    function copy() {
      navigator.clipboard.writeText(area.value).then(() => DOM.toast('COPIED', mode === 'markdown' ? 'Markdown on clipboard.' : 'HTML on clipboard.'));
    }
    function download() {
      const doc = Store.getDocument(doc_id);
      const base = (doc.title || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'draft';
      const blob = new Blob([area.value], { type: mode === 'markdown' ? 'text/markdown' : 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = base + (mode === 'markdown' ? '.md' : '.html');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }

    const modal = el('div.modal', { style: { width: 'min(820px, 96vw)' }, onClick: e => e.stopPropagation() },
      el('div.m-head',
        el('div', el('div.ttl', 'Export'), el('div.sub', 'Citations resolve to archive.org URLs')),
        el('div', { style: { display: 'flex', gap: '6px' } }, tabMd, tabHtml,
          el('button.ghost', { onClick: () => scrim.remove(), style: { marginLeft: '6px' } }, '✕')),
      ),
      el('div.m-body',
        warn,
        area,
      ),
      el('div.m-foot',
        el('div', { style: { color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: '10px' } },
          'Substack: footnote markers + archive.org URLs in references.',
        ),
        el('div.actions',
          el('button.ghost', { onClick: copy }, 'COPY'),
          el('button.primary', { onClick: download }, 'DOWNLOAD'),
        ),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
  }

  window.Exporter = { openModal: openExportModal, toMarkdown: exportToSubstackMarkdown, toHTML: exportToHTML };
})();
