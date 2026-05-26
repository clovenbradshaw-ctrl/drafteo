// ============ SOURCES (URL LIST) ============
//
// Sources are the URLs behind exhibits — nothing more. This view is
// strictly a links table: every exhibit's canonical URL (archive.org if
// preserved, otherwise the original web URL), filtered, copyable,
// archivable.
//
// For reading documents, searching across them, or grabbing passages,
// use the Exhibits tab. This tab is for citation-URL bookkeeping only.
//
// Mounted in the workspace shell as the `__sources_index__` tab.

(function () {
  const { el, clear } = window.DOM;

  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  function canonicalUrl(s) {
    if (s.archive_org_url) return { url: s.archive_org_url, kind: 'archive' };
    if (s.source_url) return { url: s.source_url, kind: 'original' };
    return { url: null, kind: 'none' };
  }

  function open(ws_id, app) {
    const host = el('div.srcurls');

    const filterInput = el('input.srcurls-filter', {
      type: 'text',
      placeholder: 'Filter by exhibit name, URL, draft…',
      spellcheck: 'false', autocomplete: 'off',
    });

    const statusFilter = el('select.srcurls-statusfilter',
      el('option', { value: 'all' }, 'All sources'),
      el('option', { value: 'archive' }, 'Archived on archive.org'),
      el('option', { value: 'original' }, 'Web original (not yet archived)'),
      el('option', { value: 'none' }, 'Local file (no URL)'),
    );

    const copyAllBtn = el('button.ghost', {
      onClick: copyAllUrls,
      title: 'Copy every visible URL to the clipboard, one per line',
    }, icon('copy'), ' COPY URLs');

    const openExhibitsBtn = el('button.ghost', {
      onClick: () => {
        if (window.__openExhibitsTab) window.__openExhibitsTab();
      },
      title: 'Open the Exhibits tab to read & cite passages',
    }, icon('files'), ' OPEN EXHIBITS');

    const summary = el('div.srcurls-summary', '');

    host.appendChild(el('div.srcurls-head',
      el('div.srcurls-title',
        el('div.srcurls-eyebrow', 'WORKSPACE'),
        el('div.srcurls-ttl', 'Sources'),
        el('div.srcurls-sub',
          'Citation links for every exhibit in this workspace — the archive.org URL ',
          'when preserved, the original web URL otherwise. To read or cite ',
          'documents, open the ', el('b', null, 'Exhibits'), ' tab.'),
      ),
      el('div.srcurls-actions', statusFilter, openExhibitsBtn, copyAllBtn),
    ));

    host.appendChild(el('div.srcurls-filterrow', filterInput, summary));

    const table = el('div.srcurls-table');
    const empty = el('div.srcurls-empty');
    host.appendChild(table);
    host.appendChild(empty);

    function letterOf(source_id) {
      // Use the bucket-aware letter map when buckets module is available;
      // fall back to flat workspace lettering otherwise.
      const recs = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          recs.push({ source: s, doc: d, doc_id: d.id, source_id: s.source_id });
        }
      }
      if (window.Buckets && window.Buckets.letterMap) {
        const map = window.Buckets.letterMap(ws_id, recs);
        return map[source_id] || '?';
      }
      recs.sort((a, b) => (a.source.uploaded_at || 0) - (b.source.uploaded_at || 0));
      const idx = recs.findIndex(r => r.source_id === source_id);
      if (idx < 0) return '?';
      if (window.ExhibitsIndex && window.ExhibitsIndex.letterFor) {
        return window.ExhibitsIndex.letterFor(idx);
      }
      return String.fromCharCode(65 + (idx % 26));
    }

    function gather() {
      const raw = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) {
          raw.push({ source: s, doc: d, ...canonicalUrl(s) });
        }
      }
      // Sort by bucket-aware letter when possible, otherwise upload order.
      if (window.Buckets && window.Buckets.letterMap) {
        const map = window.Buckets.letterMap(ws_id, raw.map(r =>
          ({ source: r.source, doc: r.doc, doc_id: r.doc.id, source_id: r.source.source_id })));
        raw.forEach(r => { r.letter = map[r.source.source_id] || '?'; });
        raw.sort((a, b) => a.letter.localeCompare(b.letter, undefined, { numeric: true }));
      } else {
        raw.sort((a, b) => (a.source.uploaded_at || 0) - (b.source.uploaded_at || 0));
        raw.forEach((r, i) => { r.letter = (window.ExhibitsIndex && window.ExhibitsIndex.letterFor) ? window.ExhibitsIndex.letterFor(i) : String.fromCharCode(65 + (i % 26)); });
      }
      return raw;
    }

    function currentlyVisible(all) {
      const q = (filterInput.value || '').toLowerCase().trim();
      const kind = statusFilter.value;
      return all.filter((r) => {
        if (kind !== 'all' && r.kind !== kind) return false;
        if (!q) return true;
        const hay = [
          r.letter, r.source.title, r.source.filename, r.source.source_url,
          r.source.archive_org_url, r.doc.title,
          (r.source.tags || []).join(' '), r.source.description,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    function render() {
      clear(table);
      const all = gather();
      const recs = currentlyVisible(all);

      const counts = { archive: 0, original: 0, none: 0 };
      for (const r of all) counts[r.kind]++;
      clear(summary);
      summary.appendChild(el('span', String(recs.length) + ' of ' + all.length + ' shown'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.ok', icon('check-circle', 11), ' ' + counts.archive + ' archived'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.warn', icon('globe', 11), ' ' + counts.original + ' original'));
      summary.appendChild(el('span.dot', '·'));
      summary.appendChild(el('span.tally.mute', icon('file', 11), ' ' + counts.none + ' local'));

      if (recs.length === 0) {
        empty.style.display = 'block';
        clear(empty);
        if (all.length === 0) {
          empty.appendChild(el('div.srcurls-empty-ttl', 'No sources yet'));
          empty.appendChild(el('div.srcurls-empty-sub',
            'Sources appear here once you import a URL or archive a file. ',
            'Open a draft and use the right-hand panel to add one.'));
        } else {
          empty.appendChild(el('div.srcurls-empty-sub', 'No sources match the current filter.'));
        }
        return;
      }
      empty.style.display = 'none';

      table.appendChild(el('div.srcurls-row.srcurls-rowhead',
        el('div.srcurls-cell.col-letter', ''),
        el('div.srcurls-cell.col-name', 'EXHIBIT'),
        el('div.srcurls-cell.col-url', 'CITATION URL'),
        el('div.srcurls-cell.col-doc', 'DRAFT'),
        el('div.srcurls-cell.col-act', ''),
      ));

      for (const r of recs) table.appendChild(buildRow(r));
    }

    function buildRow(r) {
      const s = r.source;
      const name = s.title || s.filename || 'Untitled source';

      const letterCell = el('div.srcurls-cell.col-letter',
        el('span.srcurls-letter', r.letter));

      const nameCell = el('div.srcurls-cell.col-name',
        el('button.srcurls-namebtn', {
          onClick: () => openInExhibits(r),
          title: 'Open this exhibit in the Exhibits tab',
        }, name),
        s.source_url ? el('span.srcurls-badge.warn', icon('globe', 9), ' WEB')
          : el('span.srcurls-badge.mute', icon('file', 9), ' FILE'),
      );
      if (s.description) nameCell.appendChild(el('div.srcurls-namesub', s.description));

      const urlCell = el('div.srcurls-cell.col-url');
      if (r.url) {
        urlCell.appendChild(el('a.srcurls-url', {
          href: r.url, target: '_blank', rel: 'noopener', title: r.url,
        }, r.url));
        if (r.kind === 'archive' && s.source_url) {
          urlCell.appendChild(el('a.srcurls-altlink', {
            href: s.source_url, target: '_blank', rel: 'noopener',
            title: 'Original (pre-archive) URL',
          }, icon('arrow-square-out', 9), ' original'));
        } else if (r.kind === 'original') {
          urlCell.appendChild(el('span.srcurls-pending', '— not yet preserved'));
        }
      } else {
        urlCell.appendChild(el('span.srcurls-nourl', '— local file, no URL'));
      }

      const docCell = el('div.srcurls-cell.col-doc',
        el('button.srcurls-docbtn', {
          onClick: () => app.openDocument(ws_id, r.doc.id),
          title: 'Open the draft this exhibit is attached to',
        }, icon('file-text', 11), ' ', r.doc.title || 'Untitled draft'),
      );

      const actCell = el('div.srcurls-cell.col-act');
      if (r.kind === 'original') {
        actCell.appendChild(el('button.srcurls-archivebtn', {
          title: 'Preserve this source to archive.org',
          onClick: (e) => { e.stopPropagation(); archiveOne(r); },
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
              DOM.toast('COPY FAILED', 'Clipboard unavailable.', 2500);
            }
          },
        }, icon('copy', 13)));
      }

      return el('div.srcurls-row', letterCell, nameCell, urlCell, docCell, actCell);
    }

    function openInExhibits(r) {
      if (window.__openExhibitsTab) {
        window.__openExhibitsTab({ sourceId: r.source.source_id });
      }
    }

    function archiveOne(r) {
      if (!window.SourcePanel || !window.SourcePanel.openArchive) {
        DOM.toast('UNAVAILABLE', 'Archive flow not loaded.', 2500);
        return;
      }
      window.SourcePanel.openArchive(r.doc.id, r.source, {
        refreshSources: () => { try { render(); } catch (_) {} },
      });
    }

    async function copyAllUrls() {
      const all = gather();
      const recs = currentlyVisible(all).filter(r => !!r.url);
      if (recs.length === 0) {
        DOM.toast('NO URLs', 'Nothing to copy in the current filter.', 2500);
        return;
      }
      const text = recs.map(r => {
        const name = r.source.title || r.source.filename || 'Untitled source';
        return 'Exhibit ' + r.letter + ' · ' + name + '\t' + r.url;
      }).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        DOM.toast('COPIED', recs.length + ' URL' + (recs.length === 1 ? '' : 's') + ' copied', 3000);
      } catch (_) {
        DOM.toast('COPY FAILED', 'Clipboard unavailable.', 2500);
      }
    }

    filterInput.addEventListener('input', render);
    statusFilter.addEventListener('change', render);

    const onUpdated = () => { try { render(); } catch (_) {} };
    window.addEventListener('drafteo:sources-updated', onUpdated);
    window.addEventListener('drafteo:buckets-updated', onUpdated);
    const mo = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        window.removeEventListener('drafteo:sources-updated', onUpdated);
        window.removeEventListener('drafteo:buckets-updated', onUpdated);
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    render();
    return host;
  }

  window.SourcesIndex = { open };
})();
