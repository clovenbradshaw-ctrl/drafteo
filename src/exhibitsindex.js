// ============ EXHIBITS INDEX ============
// Workspace-scoped flat list of every exhibit (ingested URL or document)
// across every draft. Clicking a row opens the exhibit viewer for the
// draft it belongs to, after a click+confirm step so the user lands on
// the right page intentionally.
//
// Also exports a JSON manifest of all cited-text snippets bound to
// exhibits in this workspace, with self-contained mini-page links — an
// AI can read it and emit citation hyperlinks that resolve to the
// archive.org-backed quote without reproducing the source text.
//
// Mounted in the workspace shell as the `__exhibits_index__` tab.

(function () {
  const { el, clear } = window.DOM;

  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  function open(ws_id, app) {
    const host = el('div.srcindex');

    const filterInput = el('input.srcindex-filter', {
      type: 'text',
      placeholder: 'Filter by title, URL, draft…',
      spellcheck: 'false',
      autocomplete: 'off',
    });

    const statusFilter = el('select.srcindex-statusfilter',
      el('option', { value: 'all' }, 'All exhibits'),
      el('option', { value: 'archived' }, 'Preserved on archive.org'),
      el('option', { value: 'pending' }, 'Not yet preserved'),
      el('option', { value: 'web' }, 'Web (URL import)'),
      el('option', { value: 'file' }, 'File upload'),
    );

    const exportBtn = el('button.ghost', {
      onClick: exportAiManifest,
      title: 'Download a JSON manifest of cited-text spans + mini-page links for AI consumption',
    }, icon('download-simple'), ' EXPORT JSON');

    const summary = el('div.srcindex-summary', '');

    const head = el('div.srcindex-head',
      el('div.srcindex-title',
        el('div', { style: { fontFamily: 'var(--display)', fontSize: '22px', fontWeight: 700, color: 'var(--ink)' } }, 'Exhibits'),
        el('div', { style: { fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--ink-faint)' } },
          'Every URL or document ingested into this workspace. Click a row to open it. Export JSON to give an AI the cited-text spans + mini-page links it can hyperlink without reproducing text.'),
      ),
      el('div.srcindex-actions',
        statusFilter,
        exportBtn,
      ),
    );

    const filterRow = el('div.srcindex-filterrow', filterInput, summary);
    const table = el('div.srcindex-table');
    const empty = el('div.srcindex-empty');

    host.appendChild(head);
    host.appendChild(filterRow);
    host.appendChild(table);
    host.appendChild(empty);

    function classify(s) {
      if (s.archive_org_url) return 'archived';
      if (s.source_url) return 'web';
      return 'file';
    }

    function gather() {
      const recs = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          recs.push({ source: s, doc: d, kind: classify(s) });
        }
      }
      recs.sort((a, b) => {
        const rank = (r) => r.kind === 'archived' ? 0 : r.kind === 'web' ? 1 : 2;
        const dr = rank(a) - rank(b);
        if (dr !== 0) return dr;
        return (a.source.title || a.source.filename || '').localeCompare(
          b.source.title || b.source.filename || '');
      });
      return recs;
    }

    function currentlyVisible() {
      const all = gather();
      const q = (filterInput.value || '').toLowerCase().trim();
      const k = statusFilter.value;
      return all.filter((r) => {
        if (k === 'pending' && r.kind === 'archived') return false;
        if (k !== 'all' && k !== 'pending' && r.kind !== k) return false;
        if (!q) return true;
        const hay = [
          r.source.title, r.source.filename, r.source.source_url,
          r.source.archive_org_url, r.doc.title,
          (r.source.tags || []).join(' '), r.source.description,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    function render() {
      clear(table);
      const recs = currentlyVisible();
      const all = gather();
      const counts = { archived: 0, web: 0, file: 0 };
      for (const r of all) counts[r.kind]++;
      summary.innerHTML = '';
      summary.appendChild(el('span', String(recs.length) + ' of ' + all.length + ' shown'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.ok', icon('check-circle', 11), ' ' + counts.archived + ' preserved'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.warn', icon('globe', 11), ' ' + counts.web + ' web'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.mute', icon('file', 11), ' ' + counts.file + ' file'));

      if (recs.length === 0) {
        empty.style.display = 'block';
        empty.innerHTML = '';
        if (all.length === 0) {
          empty.appendChild(el('div', { style: { fontFamily: 'var(--display)', fontSize: '20px', fontWeight: 600, color: 'var(--ink-dim)', marginBottom: '6px' } }, 'No exhibits in this workspace yet.'));
          empty.appendChild(el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-faint)' } }, 'Open a draft and upload a file or import a URL to add an exhibit.'));
        } else {
          empty.appendChild(el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-faint)' } }, 'No exhibits match the current filter.'));
        }
        return;
      }
      empty.style.display = 'none';

      const header = el('div.srcindex-row.srcindex-rowhead',
        el('div.srcindex-cell.col-status', 'STATUS'),
        el('div.srcindex-cell.col-name', 'TITLE'),
        el('div.srcindex-cell.col-url', 'SOURCE'),
        el('div.srcindex-cell.col-doc', 'DRAFT'),
        el('div.srcindex-cell.col-act', ''),
      );
      table.appendChild(header);
      for (const r of recs) table.appendChild(buildRow(r));
    }

    function buildRow(r) {
      const s = r.source;
      const url = s.archive_org_url || s.source_url || null;
      const name = s.title || s.filename || 'Untitled exhibit';

      const statusCell = el('div.srcindex-cell.col-status');
      if (r.kind === 'archived') {
        statusCell.appendChild(el('span.srcindex-badge.ok', icon('check-circle', 11), ' PRESERVED'));
      } else if (r.kind === 'web') {
        statusCell.appendChild(el('span.srcindex-badge.warn', icon('globe', 11), ' WEB'));
      } else {
        statusCell.appendChild(el('span.srcindex-badge.mute', icon('file', 11), ' FILE'));
      }

      const nameCell = el('div.srcindex-cell.col-name',
        el('button.srcindex-namebtn', {
          onClick: () => confirmAndOpen(r),
          title: 'Open this exhibit',
        }, name),
      );
      if (s.description) nameCell.appendChild(el('div.srcindex-namesub', s.description));

      const urlCell = el('div.srcindex-cell.col-url');
      if (url) {
        urlCell.appendChild(el('a.srcindex-url', { href: url, target: '_blank', rel: 'noopener', title: url }, url));
      } else {
        urlCell.appendChild(el('span.srcindex-nourl', '— local file only'));
      }

      const docCell = el('div.srcindex-cell.col-doc',
        el('button.srcindex-docbtn', {
          onClick: () => app.openDocument(ws_id, r.doc.id),
          title: 'Open the draft this exhibit is attached to',
        }, icon('file-text', 11), ' ', r.doc.title || 'Untitled draft'),
      );

      const actCell = el('div.srcindex-cell.col-act');
      actCell.appendChild(el('button.iconbtn.ghost', {
        title: 'Open this exhibit',
        onClick: (e) => { e.stopPropagation(); confirmAndOpen(r); },
      }, icon('arrow-right', 13)));

      return el('div.srcindex-row', statusCell, nameCell, urlCell, docCell, actCell);
    }

    // Click → confirm → open. The confirm is a deliberate stop so users
    // don't accidentally navigate away from work in progress.
    async function confirmAndOpen(r) {
      const ok = await DOM.confirmDialog({
        title: 'Open this exhibit?',
        body: 'Switch to the exhibit viewer for "' + (r.source.title || r.source.filename) + '" (attached to draft "' + (r.doc.title || 'Untitled') + '").',
        confirmLabel: 'Open exhibit',
        cancelLabel: 'Stay here',
      });
      if (!ok) return;
      if (window.__openSourceTab) {
        try { window.__openSourceTab(r.doc.id, r.source.source_id); return; } catch (_) {}
      }
      app.openDocument(ws_id, r.doc.id);
    }

    // ── JSON manifest export ─────────────────────────────────────────
    // Shape is tuned for an AI agent: every saved cited-text span gets
    // a verbatim `text` field (so the model can quote it deterministically),
    // a mini-page `url` it can hyperlink as the citation target, and just
    // enough provenance for the agent to render an attribution line.
    function exportAiManifest() {
      const exhibits = [];
      const sourceByAnchor = {};

      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          sourceByAnchor[s.source_id] = { source: s, doc: d };
          exhibits.push({
            exhibit_id: s.source_id,
            title: s.title || s.filename || 'Untitled exhibit',
            draft_title: d.title || 'Untitled draft',
            source_url: s.source_url || null,
            archive_url: s.archive_org_url || null,
            mime: s.mime || null,
            preserved: !!s.archive_org_url,
            tags: s.tags || [],
            cited_text: [],
          });
        }
      }

      const exhibitById = Object.fromEntries(exhibits.map(e => [e.exhibit_id, e]));
      const allCited = Store.listExhibits(ws_id); // saved snippets = "cited text"
      let citedCount = 0;
      for (const ct of allCited) {
        const tied = ct.source_id && sourceByAnchor[ct.source_id];
        const source = tied ? tied.source : null;
        let miniPageUrl = null;
        if (window.ExhibitShare && window.ExhibitShare.buildLink) {
          try { miniPageUrl = window.ExhibitShare.buildLink(ct, source); } catch (_) {}
        }
        const entry = {
          cited_text_id: ct._anchor || ct.id || null,
          text: ct.text || '',
          context_before: ct.context_before || '',
          context_after: ct.context_after || '',
          label: ct.label || '',
          note: ct.note || '',
          mini_page_url: miniPageUrl,
        };
        if (ct.source_id && exhibitById[ct.source_id]) {
          exhibitById[ct.source_id].cited_text.push(entry);
        } else {
          // Untied snippet — attach under a synthetic exhibit so the
          // model still sees the link and quote.
          const orphanKey = '__untied__';
          if (!exhibitById[orphanKey]) {
            exhibitById[orphanKey] = {
              exhibit_id: orphanKey,
              title: '(Untied cited text)',
              draft_title: null,
              source_url: null,
              archive_url: null,
              mime: null,
              preserved: false,
              tags: [],
              cited_text: [],
            };
            exhibits.push(exhibitById[orphanKey]);
          }
          exhibitById[orphanKey].cited_text.push(entry);
        }
        citedCount++;
      }

      const ws = Store.getWorkspace(ws_id);
      const manifest = {
        format: 'drafteo.ai-citation-manifest.v1',
        readme: 'Use mini_page_url as the href for any cited text. The AI MUST link to the URL — never reproduce the verbatim text — when emitting a citation in its output. The URL renders a self-contained mini-page showing the quote in the original archived document.',
        generated_at: new Date().toISOString(),
        workspace: {
          id: ws_id,
          title: ws ? ws.title : '',
        },
        counts: {
          exhibits: exhibits.length,
          cited_text: citedCount,
        },
        exhibits,
      };

      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = (ws && ws.title ? ws.title : 'workspace')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
      a.download = 'drafteo-' + slug + '-citations.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      DOM.toast('EXPORTED', exhibits.length + ' exhibit(s) · ' + citedCount + ' cited text span(s)', 3500);
    }

    filterInput.addEventListener('input', render);
    statusFilter.addEventListener('change', render);

    const onUpdated = () => { try { render(); } catch (_) {} };
    window.addEventListener('drafteo:sources-updated', onUpdated);
    const mo = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        window.removeEventListener('drafteo:sources-updated', onUpdated);
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    render();
    return host;
  }

  window.ExhibitsIndex = { open };
})();
