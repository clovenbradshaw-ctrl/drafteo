// ============ SOURCES (URL INDEX) ============
// Workspace-scoped flat list of every exhibit's extracted name +
// canonical source URL. For each exhibit, the canonical URL is its
// archive.org URL if preserved there, otherwise the original
// `source_url` for web imports. File-only exhibits show "Local file".
//
// Sources are considered "in" the workspace — once a URL is here, you
// don't re-ingest it elsewhere; you cite it from any draft via the
// Cite picker. This view exposes copy/open/archive actions per row.
//
// Mounted in the workspace shell as the `__sources_index__` tab.

(function () {
  const { el, mount, clear } = window.DOM;

  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  // Resolve a source to the single URL the user wants — archive.org if
  // preserved, original web URL otherwise. Returns { url, kind } where
  // kind ∈ 'archive' | 'original' | 'none'.
  function canonicalUrl(s) {
    if (s.archive_org_url) return { url: s.archive_org_url, kind: 'archive' };
    if (s.source_url) return { url: s.source_url, kind: 'original' };
    return { url: null, kind: 'none' };
  }

  function open(ws_id, app) {
    const host = el('div.srcindex');

    const filterInput = el('input.srcindex-filter', {
      type: 'text',
      placeholder: 'Filter by name, URL, draft…',
      spellcheck: 'false',
      autocomplete: 'off',
    });

    const statusFilter = el('select.srcindex-statusfilter',
      el('option', { value: 'all' }, 'All sources'),
      el('option', { value: 'archive' }, 'Archived on archive.org'),
      el('option', { value: 'original' }, 'Web original (not yet archived)'),
      el('option', { value: 'none' }, 'Local file (no URL)'),
    );

    const exploreBtn = el('button.ghost', {
      onClick: () => {
        if (window.SourceExplorer && window.SourceExplorer.open) {
          window.SourceExplorer.open(ws_id, {});
        }
      },
      title: 'Open the source explorer: search, scrub, and grab passages',
    }, icon('magnifying-glass-plus'), ' EXPLORE');

    const copyAllBtn = el('button.ghost', {
      onClick: copyAllUrls,
      title: 'Copy every visible URL to the clipboard, one per line',
    }, icon('copy'), ' COPY URLs');

    const summary = el('div.srcindex-summary', '');

    const head = el('div.srcindex-head',
      el('div.srcindex-title',
        el('div', { style: { fontFamily: 'var(--display)', fontSize: '22px', fontWeight: 700, color: 'var(--ink)' } }, 'Sources'),
        el('div', { style: { fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--ink-faint)' } },
          'Every URL behind every exhibit in this workspace — archive.org if preserved, otherwise the original. Click ARCHIVE to preserve a source to archive.org.'),
      ),
      el('div.srcindex-actions',
        statusFilter,
        exploreBtn,
        copyAllBtn,
      ),
    );

    const filterRow = el('div.srcindex-filterrow', filterInput, summary);

    const table = el('div.srcindex-table');
    const empty = el('div.srcindex-empty');

    host.appendChild(head);
    host.appendChild(filterRow);
    host.appendChild(table);
    host.appendChild(empty);

    // Build the records once per render — re-pulled when the workspace
    // changes (sources event listener at the bottom).
    function gather() {
      const recs = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          recs.push({ source: s, doc: d, ...canonicalUrl(s) });
        }
      }
      recs.sort((a, b) => {
        // Archive-backed first, then web originals, then local files.
        const rank = (r) => r.kind === 'archive' ? 0 : r.kind === 'original' ? 1 : 2;
        const dr = rank(a) - rank(b);
        if (dr !== 0) return dr;
        const at = (a.source.title || a.source.filename || '').toLowerCase();
        const bt = (b.source.title || b.source.filename || '').toLowerCase();
        return at.localeCompare(bt);
      });
      return recs;
    }

    function currentlyVisible() {
      const all = gather();
      const q = (filterInput.value || '').toLowerCase().trim();
      const kind = statusFilter.value;
      return all.filter((r) => {
        if (kind !== 'all' && r.kind !== kind) return false;
        if (!q) return true;
        const hay = [
          r.source.title,
          r.source.filename,
          r.source.source_url,
          r.source.archive_org_url,
          r.doc.title,
          (r.source.tags || []).join(' '),
          r.source.description,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    function render() {
      clear(table);
      const recs = currentlyVisible();

      // Summary text counts by kind
      const all = gather();
      const counts = { archive: 0, original: 0, none: 0 };
      for (const r of all) counts[r.kind]++;
      summary.innerHTML = '';
      summary.appendChild(el('span', String(recs.length) + ' of ' + all.length + ' shown'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.ok', icon('check-circle', 11), ' ' + counts.archive + ' archived'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.warn', icon('globe', 11), ' ' + counts.original + ' original'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.mute', icon('file', 11), ' ' + counts.none + ' local'));

      if (recs.length === 0) {
        empty.style.display = 'block';
        empty.innerHTML = '';
        if (all.length === 0) {
          empty.appendChild(el('div', { style: { fontFamily: 'var(--display)', fontSize: '20px', fontWeight: 600, color: 'var(--ink-dim)', marginBottom: '6px' } }, 'No sources in this workspace yet.'));
          empty.appendChild(el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-faint)' } }, 'Open a draft and upload a file or import a URL to get started.'));
        } else {
          empty.appendChild(el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-faint)' } }, 'No sources match the current filter.'));
        }
        return;
      }
      empty.style.display = 'none';

      const header = el('div.srcindex-row.srcindex-rowhead',
        el('div.srcindex-cell.col-status', 'STATUS'),
        el('div.srcindex-cell.col-name', 'NAME'),
        el('div.srcindex-cell.col-url', 'URL'),
        el('div.srcindex-cell.col-doc', 'DRAFT'),
        el('div.srcindex-cell.col-act', ''),
      );
      table.appendChild(header);

      for (const r of recs) {
        table.appendChild(buildRow(r));
      }
    }

    function buildRow(r) {
      const s = r.source;
      const name = s.title || s.filename || 'Untitled source';

      const statusCell = el('div.srcindex-cell.col-status');
      if (r.kind === 'archive') {
        statusCell.appendChild(el('span.srcindex-badge.ok', icon('check-circle', 11), ' ARCHIVED'));
      } else if (r.kind === 'original') {
        statusCell.appendChild(el('span.srcindex-badge.warn', icon('globe', 11), ' WEB'));
      } else {
        statusCell.appendChild(el('span.srcindex-badge.mute', icon('file', 11), ' LOCAL'));
      }

      const nameCell = el('div.srcindex-cell.col-name',
        el('button.srcindex-namebtn', {
          onClick: () => openSourceInWorkspace(r.doc.id, s.source_id),
          title: 'Open this source',
        }, name),
      );
      if (s.description) {
        nameCell.appendChild(el('div.srcindex-namesub', s.description));
      }

      const urlCell = el('div.srcindex-cell.col-url');
      if (r.url) {
        urlCell.appendChild(el('a.srcindex-url', {
          href: r.url, target: '_blank', rel: 'noopener',
          title: r.url,
        }, r.url));
        if (r.kind === 'archive' && s.source_url) {
          urlCell.appendChild(el('a.srcindex-altlink', {
            href: s.source_url, target: '_blank', rel: 'noopener',
            title: 'Original (pre-archive) URL: ' + s.source_url,
          }, icon('arrow-square-out', 10), ' original'));
        }
      } else {
        urlCell.appendChild(el('span.srcindex-nourl', '— not yet archived'));
      }

      const docCell = el('div.srcindex-cell.col-doc',
        el('button.srcindex-docbtn', {
          onClick: () => app.openDocument(ws_id, r.doc.id),
          title: 'Open the draft this source is attached to',
        }, icon('file-text', 11), ' ', r.doc.title || 'Untitled draft'),
      );

      const actCell = el('div.srcindex-cell.col-act');
      if (r.kind === 'original') {
        actCell.appendChild(el('button.srcindex-archivebtn', {
          title: 'Preserve this source to archive.org',
          onClick: (e) => {
            e.stopPropagation();
            archiveOne(r);
          },
        }, icon('archive', 12), ' ARCHIVE'));
      }
      if (r.url) {
        actCell.appendChild(el('button.iconbtn.ghost', {
          title: 'Copy URL',
          onClick: async (e) => {
            e.stopPropagation();
            try {
              await navigator.clipboard.writeText(r.url);
              DOM.toast('COPIED', r.url.slice(0, 80) + (r.url.length > 80 ? '…' : ''), 2200);
            } catch (_) {
              DOM.toast('COPY FAILED', 'Clipboard unavailable in this browser', 2500);
            }
          },
        }, icon('copy', 13)));
      }

      const row = el('div.srcindex-row', statusCell, nameCell, urlCell, docCell, actCell);
      return row;
    }

    // Open the existing archive consent modal for this source. doc_id
    // is required by the underlying API but the resulting archive.org
    // URL is shared workspace-wide via the source record.
    function archiveOne(r) {
      if (!window.SourcePanel || !window.SourcePanel.openArchive) {
        DOM.toast('UNAVAILABLE', 'Archive flow not loaded.', 2500);
        return;
      }
      window.SourcePanel.openArchive(r.doc.id, r.source, {
        refreshSources: () => { try { render(); } catch (_) {} },
      });
    }

    function openSourceInWorkspace(doc_id, source_id) {
      // Reuse the workspace shell's source-tab opener if available.
      if (window.__openSourceTab) {
        try { window.__openSourceTab(doc_id, source_id); return; } catch (_) {}
      }
      // Fallback: just navigate to the draft.
      app.openDocument(ws_id, doc_id);
    }

    async function copyAllUrls() {
      const recs = currentlyVisible().filter(r => !!r.url);
      if (recs.length === 0) {
        DOM.toast('NO URLs', 'Nothing to copy in the current filter.', 2500);
        return;
      }
      const text = recs.map(r => {
        const name = r.source.title || r.source.filename || 'Untitled source';
        return name + '\t' + r.url;
      }).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        DOM.toast('COPIED', recs.length + ' URL' + (recs.length === 1 ? '' : 's') + ' copied (tab-separated: name → URL)', 3200);
      } catch (_) {
        DOM.toast('COPY FAILED', 'Clipboard unavailable in this browser', 2500);
      }
    }

    filterInput.addEventListener('input', render);
    statusFilter.addEventListener('change', render);

    // Re-render when sources change in any doc in this workspace.
    const onSourcesUpdated = () => { try { render(); } catch (_) {} };
    window.addEventListener('drafteo:sources-updated', onSourcesUpdated);
    // Detach when the host is removed from the DOM
    const mo = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        window.removeEventListener('drafteo:sources-updated', onSourcesUpdated);
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    render();
    return host;
  }

  window.SourcesIndex = { open };
})();
