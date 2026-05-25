// ============ SOURCE PANEL + ARCHIVE FLOW ============

(function () {
  const { el, mount, clear, fmtBytes, fmtTimeAgo, fileExt } = window.DOM;

  function buildPanel(doc_id, ed) {
    const list = el('div.srclist');
    const importArea = buildImportArea(doc_id, () => { sourcesRefresh(); });

    const panel = el('div.sourcepanel',
      el('div.head',
        el('h3', 'Sources'),
        el('div', { style: { display: 'flex', gap: '6px' } },
          el('button.ghost', { onClick: () => archiveAll(doc_id, ed) }, 'PRESERVE ALL'),
        ),
      ),
      importArea,
      list,
    );

    function sourcesRefresh() {
      refresh();
      ed.refreshSources();
    }

    function refresh() {
      clear(list);
      const sources = Store.listSources(doc_id);
      const hidden = Store.listHiddenSources(doc_id);
      if (sources.length === 0 && hidden.length === 0) {
        list.appendChild(el('div', { style: { padding: '30px 14px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: '13px', border: '1px dashed var(--border)', margin: '8px 0' } },
          'No sources yet. Drop files here or click UPLOAD.'));
      } else {
        for (const s of sources) list.appendChild(card(s, doc_id, ed));
        if (hidden.length > 0) {
          const archDetails = el('details', { open: true, style: { marginTop: '14px', borderTop: '1px solid var(--border)', paddingTop: '10px' } },
            el('summary', { style: { cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: '12px', fontWeight: '600', color: 'var(--ink-dim)', padding: '6px 0', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '6px' } },
              icon('trash', 12),
              'Bin · ' + hidden.length + ' tossed source' + (hidden.length === 1 ? '' : 's'),
            ),
            el('div', { style: { fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)', margin: '0 0 8px', lineHeight: '1.5' } },
              'Tossed sources stay here until you restore or delete forever. Archived-to-archive.org items can never be truly deleted.',
            ),
            el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              ...hidden.map(s => card(s, doc_id, ed, { hiddenSection: true })),
            ),
          );
          list.appendChild(archDetails);
        }
      }
    }

    // Drag-and-drop on panel
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.background = 'var(--chrome-2)'; });
    panel.addEventListener('dragleave', () => { panel.style.background = ''; });
    panel.addEventListener('drop', async (e) => {
      e.preventDefault();
      panel.style.background = '';
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (const f of files) { await Store.uploadSource(doc_id, f, {}); }
      refresh();
      ed.refreshSources();
    });

    return { node: panel, refresh };
  }

  function buildImportArea(doc_id, onChange) {
    let mode = 'file';
    const wrap = el('div', { style: { margin: '0 0 10px' } });

    // Tabs
    const fileTab = el('button.active', { onClick: () => setMode('file') }, icon('file-arrow-up'), ' FILE');
    const urlTab = el('button', { onClick: () => setMode('url') }, icon('globe'), ' URL');
    const tabs = el('div.import-tabs', fileTab, urlTab);

    // File drop zone
    const dropzone = el('div.upload-dropzone',
      icon('cloud-arrow-up', 24),
      el('div', { style: { fontSize: '12px', color: 'var(--ink)' } }, 'Drop files here, or click to choose'),
      el('div', { style: { fontSize: '10px', color: 'var(--ink-faint)', marginTop: '4px' } }, 'PDF · DOCX · Image · Audio · Video · Any file'),
    );
    dropzone.addEventListener('click', () => openFilePicker(doc_id, { refreshSources: onChange }));
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault(); dropzone.classList.remove('dragover');
      for (const f of e.dataTransfer.files) await Store.uploadSource(doc_id, f, {});
      onChange();
    });

    // URL import
    const urlInput = el('input', { type: 'url', placeholder: 'https://example.com/article' });
    const goBtn = el('button.primary', { onClick: () => doImport() }, icon('download-simple'), ' IMPORT');
    const status = el('div.status', '');
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doImport(); } });

    const urlBox = el('div.url-import',
      el('div.label', icon('globe'), 'Snapshot a web page'),
      el('div.row', urlInput, goBtn),
      status,
      el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '6px', lineHeight: '1.5' } },
        'Fetched server-side via the n8n feed proxy, sanitised, and stored as an HTML snapshot. ',
        'Archive it to Internet Archive when you\'re ready to publish.'),
    );
    urlBox.style.display = 'none';

    async function doImport() {
      const u = urlInput.value.trim();
      if (!u) { urlInput.focus(); return; }
      status.className = 'status'; status.textContent = 'Fetching via proxy…';
      goBtn.disabled = true;
      try {
        const meta = await Store.importFromUrl(doc_id, u);
        status.className = 'status ok';
        status.textContent = 'Snapshot saved: ' + meta.title;
        urlInput.value = '';
        onChange();
      } catch (e) {
        status.className = 'status error';
        status.textContent = e.message || String(e);
      } finally {
        goBtn.disabled = false;
      }
    }

    function setMode(m) {
      mode = m;
      fileTab.classList.toggle('active', m === 'file');
      urlTab.classList.toggle('active', m === 'url');
      dropzone.style.display = m === 'file' ? '' : 'none';
      urlBox.style.display = m === 'url' ? '' : 'none';
      if (m === 'url') setTimeout(() => urlInput.focus(), 30);
    }

    wrap.appendChild(tabs);
    wrap.appendChild(dropzone);
    wrap.appendChild(urlBox);
    return wrap;
  }

  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  function card(s, doc_id, ed, opts) {
    opts = opts || {};
    const archived = !!s.archive_org_url;
    const isWeb = !!s.source_url;
    const node = el('div.srccard' + (archived ? '.archived' : '.pending') + (opts.hiddenSection ? '.is-hidden' : ''),
      { draggable: true, onDragstart: (e) => {
        e.dataTransfer.setData('application/x-drafteo-source', s.source_id);
        e.dataTransfer.setData('text/plain', '{{cite:' + s.source_id + '}}');
        e.dataTransfer.effectAllowed = 'copyLink';
      } },
      el('div.r1',
        el('div.fileico', isWeb ? '🌐' : DOM.fileExt(s.mime, s.filename)),
        el('div',
          el('div.ttl', s.title || s.filename, isWeb ? el('span.badge-web', icon('globe'), 'WEB') : null),
          el('div.meta', DOM.fmtBytes(s.size_bytes) + ' · ' + (s.filename) + ' · ' + DOM.fmtTimeAgo(s.uploaded_at)),
          isWeb ? el('a.source-url', { href: s.source_url, target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), s.source_url) : null,
        ),
      ),
      s.description ? el('div.desc', s.description) : null,
      s.tags && s.tags.length ? el('div.tags', ...s.tags.map(t => el('span.tag', t))) : null,
      archived ? el('div.archived-link',
        el('span', '⛓'), el('span', { style: { textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '9px', color: 'var(--ok)' } }, 'Archived'),
        el('a', { href: s.archive_org_url, target: '_blank', rel: 'noopener', style: { color: 'var(--accent-soft)', textDecoration: 'underline', wordBreak: 'break-all' } }, s.archive_org_url),
      ) : null,
      el('div.actions',
        el('button.ghost', { onClick: () => openMetaModal(doc_id, s, () => ed.refreshSources()) }, 'EDIT'),
        el('button.ghost', { onClick: () => insertCitation(s, ed) }, 'CITE'),
        archived
          ? el('button.ghost', { disabled: true, style: { color: 'var(--ok)' } }, 'PRESERVED ✓')
          : el('button.primary', { onClick: () => openArchiveModal(doc_id, s, ed) }, 'PRESERVE →'),
        opts.hiddenSection
          ? el('div', { style: { display: 'flex', gap: '6px' } },
              el('button.ghost', { onClick: async () => { await Store.hideSource(doc_id, s.source_id, false); ed.refreshSources(); }, title: 'Restore from bin' }, 'RESTORE'),
              archived
                ? el('button.ghost', { disabled: true, title: 'Archive.org is permanent', style: { color: 'var(--ink-faint)' } }, 'PERMANENT')
                : el('button.ghost', { onClick: async () => {
                    const ok = await DOM.confirmDialog({
                      title: 'Delete forever?',
                      body: 'Permanently remove "' + (s.title || s.filename) + '". This cannot be undone. Citations to it will become orphaned.',
                      confirmLabel: 'Delete forever', cancelLabel: 'Cancel', danger: true,
                    });
                    if (!ok) return;
                    await Store.deleteSource(doc_id, s.source_id);
                    ed.refreshSources();
                  }, style: { color: 'var(--err)' } }, 'DELETE FOREVER'),
            )
          : el('button.ghost', { onClick: async () => {
              // Toss always moves to bin (soft delete). Recoverable from the Bin section.
              await Store.hideSource(doc_id, s.source_id, true);
              ed.refreshSources();
              DOM.toast('TOSSED', '"' + (s.title || s.filename) + '" moved to Bin · undo by expanding the Bin section below', 4500);
            }, style: { color: 'var(--ink-faint)' }, title: 'Move to Bin (recoverable)' }, 'TOSS'),
      ),
    );
    return node;
  }

  function insertCitation(s, ed) {
    ed.insertCitation(s.source_id);
  }

  function openFilePicker(doc_id, ed) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.onchange = async () => {
      for (const f of inp.files) { await Store.uploadSource(doc_id, f, {}); }
      ed.refreshSources();
    };
    inp.click();
  }

  function openMetaModal(doc_id, s, refresh) {
    const title = el('input', { type: 'text', value: s.title || '' });
    const desc = el('textarea', { rows: 3 }, s.description || '');
    const tags = el('input', { type: 'text', value: (s.tags || []).join(', '), placeholder: 'metro, audit, FOIA' });

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); }
    async function submit() {
      await Store.updateSource(doc_id, s.source_id, {
        title: title.value.trim(),
        description: desc.value.trim(),
        tags: tags.value.split(',').map(t => t.trim()).filter(Boolean),
      });
      close();
      refresh();
    }
    const modal = el('div.modal', { onClick: e => e.stopPropagation() },
      el('div.m-head', el('div', el('div.ttl', 'Edit source'), el('div.sub', s.filename)), el('button.ghost', { onClick: close }, '✕')),
      el('div.m-body',
        lbl('Title'), title,
        lbl('Description'), desc,
        lbl('Tags (comma-separated)'), tags,
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '14px', lineHeight: '1.6' } },
          'Filename · ' + s.filename, el('br'),
          'MIME · ' + s.mime, el('br'),
          'Size · ' + fmtBytes(s.size_bytes), el('br'),
          'mxc · ' + s.mxc_uri, el('br'),
          'Archive · ' + (s.archive_org_url || 'not yet archived'),
        ),
      ),
      el('div.m-foot', el('div'), el('div.actions',
        el('button.ghost', { onClick: close }, 'CANCEL'),
        el('button.primary', { onClick: submit }, 'SAVE'),
      )),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(() => title.focus(), 60);
  }

  function lbl(t) {
    return el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', margin: '0 0 6px' } }, t);
  }

  // ============ archive consent modal ============
  function openArchiveModal(doc_id, s, ed) {
    const checks = {
      permanence: false,
      privacy: false,
      rights: false,
    };

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); }

    function chk(key, ttl, sub) {
      const cb = el('input', { type: 'checkbox', onChange: (e) => { checks[key] = e.target.checked; updateState(); } });
      return el('label', { style: { display: 'flex', gap: '12px', padding: '14px', border: '1px solid var(--border)', marginBottom: '8px', cursor: 'pointer', alignItems: 'flex-start', background: 'var(--chrome-2)', borderRadius: '4px' } },
        cb,
        el('div',
          el('div', { style: { fontFamily: 'var(--sans)', fontWeight: '600', fontSize: '13px', color: 'var(--ink)' } }, ttl),
          el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-dim)', marginTop: '3px', lineHeight: '1.55' } }, sub),
        ),
      );
    }

    let busy = false;
    const submit = el('button.primary', { onClick: doArchive, disabled: true }, 'Preserve forever');
    const cancelBtn = el('button.ghost', { onClick: close }, 'Cancel');

    // Inline progress UI — replaces the consent checks once archiving starts.
    const progressWrap = el('div.archive-progress', { style: { display: 'none' } });
    const progressLabel = el('div.archive-progress-label', 'Preparing…');
    const progressBarFill = el('div.archive-bar-fill', { style: { width: '0%' } });
    const progressBarTrack = el('div.archive-bar-track', progressBarFill);
    const progressPct = el('div.archive-progress-pct', '0%');
    const progressLog = el('div.archive-progress-log', '');
    progressWrap.appendChild(el('div.archive-progress-row', progressLabel, progressPct));
    progressWrap.appendChild(progressBarTrack);
    progressWrap.appendChild(progressLog);

    const status = el('div', { style: { fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--ink-faint)', minHeight: '16px', marginTop: '12px' } });

    function updateState() {
      const ready = Object.values(checks).every(Boolean) && !busy;
      submit.disabled = !ready;
    }

    async function doArchive() {
      if (busy) return;
      busy = true; updateState();
      submit.textContent = 'Archiving…';
      submit.disabled = true;
      cancelBtn.disabled = true;
      cancelBtn.style.opacity = '0.4';

      // Reveal progress UI in-place
      progressWrap.style.display = 'block';

      // Track in a global map so an open source viewer can show its own bar
      window.__archivingSources = window.__archivingSources || {};
      window.__archivingSources[s.source_id] = { stage: 'preparing', pct: 0, label: 'Preparing…' };
      function emit(detail) {
        window.dispatchEvent(new CustomEvent('drafteo:source-archive-progress', { detail }));
      }
      emit({ source_id: s.source_id, stage: 'preparing', pct: 0, label: 'Preparing…' });

      function setProgress(p) {
        const pct = Math.max(0, Math.min(100, p.pct || 0));
        progressBarFill.style.width = pct + '%';
        progressPct.textContent = pct + '%';
        progressLabel.textContent = p.label || p.stage;
        if (p.stage === 'uploading' && p.total) {
          progressLog.textContent = DOM.fmtBytes(p.sent || 0) + ' of ' + DOM.fmtBytes(p.total) + ' sent';
        } else if (p.stage === 'processing') {
          progressLog.textContent = 'Internet Archive is ingesting the file (this usually takes 15–30 s).';
        } else if (p.stage === 'preparing') {
          progressLog.textContent = 'Reading binary from local media store…';
        } else if (p.stage === 'done') {
          progressLog.textContent = 'Done.';
        }
        window.__archivingSources[s.source_id] = { ...p };
        emit({ source_id: s.source_id, ...p });
      }

      try {
        await Store.archiveSource(doc_id, s.source_id, setProgress);
        const updated = Store.getSource(doc_id, s.source_id);
        progressBarFill.style.width = '100%';
        progressPct.textContent = '100%';
        progressLabel.textContent = 'Archived ✓';
        progressLog.innerHTML = '';
        progressLog.appendChild(el('a', { href: updated.archive_org_url, target: '_blank', rel: 'noopener', style: { color: 'var(--accent)', textDecoration: 'underline', wordBreak: 'break-all' } }, updated.archive_org_url));
        DOM.toast('ARCHIVED ✓', updated.archive_org_url || ('"' + (s.title || s.filename) + '" published.'), 6000);
        ed.refreshSources();
        delete window.__archivingSources[s.source_id];
        // Auto-close after a beat so user can see success
        setTimeout(close, 1800);
      } catch (e) {
        progressBarFill.style.width = '100%';
        progressBarFill.style.background = 'var(--err)';
        progressLabel.textContent = 'Failed';
        progressLog.textContent = (e.message || String(e)).slice(0, 240);
        progressLog.style.color = 'var(--err)';
        DOM.toast('ARCHIVE FAILED', (e.message || String(e)).slice(0, 160), 7000);
        delete window.__archivingSources[s.source_id];
        cancelBtn.disabled = false;
        cancelBtn.style.opacity = '';
        cancelBtn.textContent = 'Close';
        busy = false;
      }
    }

    const modal = el('div.modal', { style: { width: 'min(580px, 96vw)' }, onClick: e => e.stopPropagation() },
      el('div.m-head', el('div', el('div.ttl', 'Publish to Internet Archive'), el('div.sub', 'Permanent · CC-BY-4.0 · all-or-nothing')), el('button.ghost', { onClick: close }, '✕')),
      el('div.m-body',
        el('div', { style: { fontFamily: 'var(--sans)', fontSize: '14px', color: 'var(--ink-dim)', lineHeight: '1.65', marginBottom: '16px' } },
          'You\'re about to publish ',
          el('strong', { style: { color: 'var(--ink)', fontWeight: 600 } }, '"' + (s.title || s.filename) + '"'),
          ' to ',
          el('em', 'archive.org'),
          '. The file becomes part of the permanent public record. ',
          'Your draft\'s citations to this source will resolve to its archive.org URL.',
        ),
        el('div', { style: { padding: '10px 12px', background: 'color-mix(in srgb, var(--warn) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', borderRadius: '4px', fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--warn)', marginBottom: '14px' } },
          el('strong', { style: { fontWeight: 600 } }, 'No redactions. '),
          'Archive.org publishing is all-or-nothing. If your source contains anything you don\'t want public, redact it in the original file first and re-upload before publishing here.',
        ),
        chk('permanence', 'Permanence', 'I understand this will be permanently uploaded to the Internet Archive and cannot be deleted.'),
        chk('privacy', 'Privacy', 'I have reviewed this file in full and confirm it contains no private information that should not be public.'),
        chk('rights', 'Rights', el('span', 'I have the right to publish this material under ',
          el('a', { href: 'https://creativecommons.org/licenses/by/4.0/', target: '_blank', rel: 'noopener', style: { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px' } }, 'CC-BY-4.0'),
          '.')),
        status,
      ),
      el('div.m-foot',
        el('div', { style: { color: 'var(--ink-faint)', fontFamily: 'var(--sans)', fontSize: '11px' } }, 'Webhook: PROVeo · kind=source'),
        el('div.actions', cancelBtn, submit),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
  }

  async function archiveAll(doc_id, ed) {
    const pending = Store.listSources(doc_id).filter(s => !s.archive_org_url);
    if (pending.length === 0) { DOM.toast('NOTHING TO ARCHIVE', 'All sources already published.'); return; }
    if (!confirm('Archive ' + pending.length + ' source' + (pending.length === 1 ? '' : 's') + ' to archive.org? You will be asked for consent on each.')) return;
    for (const s of pending) {
      await new Promise(resolve => {
        const wrap = { closed: false };
        openArchiveModal(doc_id, s, { refreshSources: () => { ed.refreshSources(); if (!wrap.closed) { wrap.closed = true; resolve(); } } });
        // resolve when modal closes via scrim too
        const obs = new MutationObserver(() => {
          if (!document.body.contains(document.querySelector('.scrim'))) {
            obs.disconnect();
            if (!wrap.closed) { wrap.closed = true; resolve(); }
          }
        });
        obs.observe(document.body, { childList: true });
      });
    }
  }

  window.SourcePanel = { build: buildPanel, openArchive: openArchiveModal };
})();
