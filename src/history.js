// ============ HISTORY PANEL + TIME SCRUBBER ============
//
// The editor has a bottom bar that always shows a horizontal timeline
// of EO events. Each tick is colored by operator. Dragging the head or
// clicking a tick puts the editor into PREVIEW MODE: the page renders
// the snapshot at that version (read-only), with a banner offering
// RESTORE TO THIS VERSION. Restoring is itself a new ROL event in the
// log, so it never destroys older history — the log stays append-only
// and every restore is reversible by scrubbing past it again.

(function () {
  const { el, clear } = window.DOM;
  const OPS = window.EO.OPS;

  // ---- bottom scrubber bar that lives at the foot of the editor ----
  function buildBar(doc_id, editor) {
    const verlabel = el('div.verlabel', 'HEAD');
    const track = el('div.track', el('div.line'));
    const head = el('div.head');
    track.appendChild(head);

    const restoreBtn = el('button.primary', { onClick: () => doRestore() }, 'RESTORE');
    const exitBtn = el('button.ghost', { onClick: () => exitPreview() }, 'BACK TO LIVE');
    const fullHistoryBtn = el('button.ghost', { onClick: () => openHistoryPanel(doc_id, editor) }, 'FULL HISTORY');

    const bar = el('div.scrubber-bar',
      el('div.label', el('span.k', '⊢'), 'Time'),
      track,
      verlabel,
      el('div.actions',
        fullHistoryBtn,
        exitBtn,
        restoreBtn,
      ),
    );

    // Hide preview-only buttons until previewing
    exitBtn.style.display = 'none';
    restoreBtn.style.display = 'none';

    let previewVersion = null;
    let head_version = null;

    function getLog() {
      // Log is newest-first; build ascending list of unique versions.
      const log = Store.getEditLog(doc_id).slice().reverse();
      const seen = new Set();
      const pts = [];
      for (const e of log) {
        if (seen.has(e.version_to)) continue;
        seen.add(e.version_to);
        pts.push({ version: e.version_to, op: e.eo_operator, entry: e });
      }
      // Ensure version 1 (DEF) is there
      if (pts.length === 0) {
        const doc = Store.getDocument(doc_id);
        if (doc) pts.push({ version: 1, op: 'DEF', entry: { eo_operator: 'DEF', resolution: 'Created', timestamp: doc.created_at } });
      }
      return pts;
    }

    function rebuild() {
      // remove existing ticks
      for (const t of track.querySelectorAll('.tick')) t.remove();
      const pts = getLog();
      const doc = Store.getDocument(doc_id);
      head_version = doc.version;
      const minV = pts[0].version;
      const maxV = Math.max(head_version, pts[pts.length - 1].version);

      function pct(v) {
        if (maxV === minV) return 100;
        return ((v - minV) / (maxV - minV)) * 100;
      }

      for (const p of pts) {
        const tick = el('div.tick.' + p.op, {
          style: { left: pct(p.version) + '%' },
          title: 'v' + p.version + ' · ' + (OPS[p.op] && OPS[p.op].name || p.op) + ' · ' + (p.entry.resolution || ''),
          onClick: (e) => { e.stopPropagation(); enterPreview(p.version); },
        });
        track.appendChild(tick);
      }

      const showVer = previewVersion != null ? previewVersion : head_version;
      head.style.left = pct(showVer) + '%';
      verlabel.textContent = (previewVersion != null ? 'PREVIEW v' : 'HEAD v') + showVer + ' / ' + head_version;
    }

    // Click on the track to jump to nearest version
    track.addEventListener('click', (e) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const pts = getLog();
      const minV = pts[0].version;
      const maxV = Math.max(head_version, pts[pts.length - 1].version);
      const target = Math.round(minV + ratio * (maxV - minV));
      // Snap to nearest tick version (within 0.6 of a step)
      let best = pts[0];
      let bestD = Infinity;
      for (const p of pts) {
        const d = Math.abs(p.version - target);
        if (d < bestD) { bestD = d; best = p; }
      }
      enterPreview(best.version);
    });

    // Drag the head
    let dragging = false;
    head.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const pts = getLog();
      const minV = pts[0].version;
      const maxV = Math.max(head_version, pts[pts.length - 1].version);
      const target = Math.round(minV + ratio * (maxV - minV));
      let best = pts[0];
      let bestD = Infinity;
      for (const p of pts) {
        const d = Math.abs(p.version - target);
        if (d < bestD) { bestD = d; best = p; }
      }
      enterPreview(best.version);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    function enterPreview(v) {
      if (v === head_version) { exitPreview(); return; }
      previewVersion = v;
      bar.classList.add('preview');
      exitBtn.style.display = '';
      restoreBtn.style.display = '';
      editor.enterPreview(v);
      rebuild();
    }
    function exitPreview() {
      previewVersion = null;
      bar.classList.remove('preview');
      exitBtn.style.display = 'none';
      restoreBtn.style.display = 'none';
      editor.exitPreview();
      rebuild();
    }
    async function doRestore() {
      if (previewVersion == null) return;
      const v = previewVersion;
      await Store.restoreToVersion(doc_id, v);
      editor.exitPreview();
      previewVersion = null;
      bar.classList.remove('preview');
      exitBtn.style.display = 'none';
      restoreBtn.style.display = 'none';
      editor.reload();
      DOM.toast('RESTORED', 'Body reset to v' + v + ' as new ROL event. Reversible by scrubbing back.', 4500);
      rebuild();
    }

    return { node: bar, rebuild };
  }

  // ---- Full-screen history list ----
  function openHistoryPanel(doc_id, editor) {
    const log = Store.getEditLog(doc_id);
    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
    const list = el('div', { style: { maxHeight: '60vh', overflowY: 'auto' } });
    for (const e of log) {
      const op = OPS[e.eo_operator] || { glyph: '·', name: e.eo_operator, tone: '' };
      const row = el('div', { style: { padding: '12px 0', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '46px 1fr 90px 70px', gap: '12px', alignItems: 'center', cursor: 'pointer' },
        onClick: () => { scrim.remove(); editor.scrubTo(e.version_to); } },
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '14px', color: 'var(--accent-soft)', textAlign: 'center' } },
          el('div', op.glyph),
          el('div', { style: { fontSize: '8px', letterSpacing: '0.1em', color: 'var(--ink-faint)' } }, e.eo_operator),
        ),
        el('div',
          el('div', { style: { fontFamily: 'var(--serif)', fontSize: '14px', color: 'var(--ink)' } }, e.resolution || op.name),
          el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '3px', textTransform: 'uppercase', letterSpacing: '0.1em' } },
            (e.site || 'document') + ' · ' + (e.author || '').replace(/^@([^:]+).*$/, '$1')),
        ),
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-dim)' } }, DOM.fmtTimeAgo(e.timestamp)),
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--accent-soft)', textAlign: 'right' } }, 'v' + e.version_to),
      );
      list.appendChild(row);
    }
    const modal = el('div.modal', { style: { width: 'min(720px, 96vw)' }, onClick: e => e.stopPropagation() },
      el('div.m-head', el('div', el('div.ttl', 'Edit history'), el('div.sub', log.length + ' events · EO-notated, append-only')), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
      el('div.m-body', list),
      el('div.m-foot',
        el('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          ...Object.entries(OPS).map(([key, v]) =>
            el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.1em' } },
              el('span', { style: { color: 'var(--accent-soft)', marginRight: '4px' } }, v.glyph), key + ' · ' + v.name)
          ),
        ),
        el('button.ghost', { onClick: () => scrim.remove() }, 'CLOSE'),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
  }

  window.HistoryBar = { build: buildBar, openPanel: openHistoryPanel };
})();
