// ============ CORKBOARD ============
// Workspace-scoped boards of evidence cards + connector strings.
// Each card is a clipped quote (optionally tied to a source and/or doc),
// positioned on a 2D canvas (or shown as a table). Multiple named boards.

(function () {
  const { el, mount, clear } = window.DOM;

  function icon(name, size) {
    const i = document.createElement('i');
    i.className = 'ph ph-' + name;
    if (size) i.style.fontSize = size + 'px';
    return i;
  }

  const COLORS = [
    { key: 'amber',  swatch: '#e8c89a', text: '#3a2a14' },
    { key: 'olive',  swatch: '#b9c79f', text: '#2d3520' },
    { key: 'rose',   swatch: '#e3b3a3', text: '#3a1d18' },
    { key: 'sky',    swatch: '#a8c3da', text: '#1a2a3a' },
    { key: 'lilac',  swatch: '#c5b0d6', text: '#28203a' },
    { key: 'plain',  swatch: '#ece5d2', text: '#1a1814' },
  ];
  function colorFor(key) { return COLORS.find(c => c.key === key) || COLORS[0]; }

  const STRING_COLORS = [
    { key: 'connect',     name: 'Connects',        color: '#c47a2b' },
    { key: 'supports',    name: 'Supports',        color: '#4f7a44' },
    { key: 'contradicts', name: 'Contradicts',     color: '#963d22' },
    { key: 'see-also',    name: 'See also',        color: '#7aa5c8' },
    { key: 'follows',     name: 'Follows from',    color: '#b48ec8' },
  ];
  function stringColor(key) {
    return (STRING_COLORS.find(s => s.key === key) || STRING_COLORS[0]).color;
  }

  function open(ws_id, app) {
    let view = 'canvas';
    let stringMode = null;
    let holonMode = null; // {selecting: true, cardIds: Set} while drawing
    let zoom = 1;
    let pan = { x: 0, y: 0 };
    const host = el('div.corkboard');

    const boardTabs = el('div.cork-boardtabs');
    const heading = el('div.cork-head',
      el('div.cork-title',
        el('div', { style: { fontFamily: 'var(--display)', fontSize: '22px', fontWeight: 700, color: 'var(--ink)' } }, 'Corkboards'),
        el('div', { style: { fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--ink-faint)' } },
          'Drag pins between cards to tie them with strings. Double-click a card for details.'),
      ),
      el('div.cork-actions',
        el('div.cork-zoom',
          el('button.ghost', { onClick: () => setZoom(zoom * 0.85), title: 'Zoom out' }, icon('minus')),
          el('button.ghost', { onClick: () => { zoom = 1; pan = { x: 0, y: 0 }; applyTransform(); }, title: 'Reset zoom' }, el('span', { class: 'zoom-lbl' }, '100%')),
          el('button.ghost', { onClick: () => setZoom(zoom * 1.15), title: 'Zoom in' }, icon('plus')),
        ),
        el('button.ghost', { onClick: cleanUp, title: 'Auto-arrange cards in a tidy grid' }, icon('broom'), 'Clean up'),
        el('button.primary', { onClick: addBlank }, icon('plus'), 'Add card'),
      ),
    );

    const canvasHost = el('div.cork-canvas');
    const stringsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stringsSvg.setAttribute('class', 'cork-strings');
    const tableHost = el('div.cork-table');

    host.appendChild(heading);
    host.appendChild(boardTabs);
    host.appendChild(canvasHost);
    host.appendChild(tableHost);

    function setView(v) {
      view = v;
      canvasHost.style.display = v === 'canvas' ? '' : 'none';
      tableHost.style.display = v === 'table' ? '' : 'none';
      heading.querySelectorAll('.cork-viewtoggle button').forEach((b, i) => {
        b.classList.toggle('active', (i === 0 && v === 'canvas') || (i === 1 && v === 'table'));
      });
      renderAll();
    }

    function renderBoardTabs() {
      clear(boardTabs);
      const boards = Store.listBoards(ws_id);
      const active = Store.activeBoard(ws_id);
      for (const b of boards) {
        const t = el('button.cork-tab' + (b.id === active ? '.active' : ''),
          { onClick: () => { Store.setActiveBoard(ws_id, b.id); renderAll(); renderBoardTabs(); }, onDblclick: () => renameBoardPrompt(b) },
          el('span', b.name),
        );
        if (b.id === active && boards.length > 1) {
          t.appendChild(el('span.close', { onClick: (e) => { e.stopPropagation(); deleteBoardConfirm(b); } }, icon('x')));
        }
        boardTabs.appendChild(t);
      }
      boardTabs.appendChild(el('button.cork-tab-add', { onClick: addBoard, title: 'New board' }, icon('plus')));
    }

    async function addBoard() {
      const name = prompt('Board name', 'New board');
      if (!name) return;
      await Store.createBoard(ws_id, name);
      renderBoardTabs();
      renderAll();
    }
    async function renameBoardPrompt(b) {
      const name = prompt('Rename board', b.name);
      if (!name) return;
      await Store.renameBoard(ws_id, b.id, name);
      renderBoardTabs();
    }
    async function deleteBoardConfirm(b) {
      const ok = await DOM.confirmDialog({ title: 'Delete board?', body: 'All cards and strings on "' + b.name + '" will be removed. Sources and drafts are untouched.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await Store.deleteBoard(ws_id, b.id); } catch (e) { DOM.toast('CANT DELETE', e.message); return; }
      renderBoardTabs();
      renderAll();
    }

    function renderAll() {
      if (view === 'canvas') renderCanvas();
      else renderTable();
    }

    // ---- pin-drag connector ----
    let pinDrag = null;
    let pinPreview = null;
    function startPinDrag(fromEv, pin, x0, y0) {
      pinDrag = { fromId: fromEv.id, originX: x0, originY: y0, currentX: x0, currentY: y0 };
      pinPreview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      pinPreview.setAttribute('class', 'cork-pin-preview');
      pinPreview.setAttribute('width', window.innerWidth);
      pinPreview.setAttribute('height', window.innerHeight);
      pinPreview.setAttribute('viewBox', '0 0 ' + window.innerWidth + ' ' + window.innerHeight);
      pinPreview.style.position = 'fixed';
      pinPreview.style.left = '0';
      pinPreview.style.top = '0';
      pinPreview.style.width = '100vw';
      pinPreview.style.height = '100vh';
      pinPreview.style.pointerEvents = 'none';
      pinPreview.style.zIndex = '9999';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('stroke', 'var(--accent)');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-dasharray', '6 4');
      pinPreview.appendChild(path);
      document.body.appendChild(pinPreview);
      updatePreview();
    }
    function updatePreview() {
      if (!pinDrag || !pinPreview) return;
      const ax = pinDrag.originX, ay = pinDrag.originY;
      const bx = pinDrag.currentX, by = pinDrag.currentY;
      const dx = (bx - ax) * 0.3;
      const d = 'M ' + ax + ' ' + ay + ' C ' + (ax + dx) + ' ' + ay + ', ' + (bx - dx) + ' ' + by + ', ' + bx + ' ' + by;
      pinPreview.firstChild.setAttribute('d', d);
    }
    window.addEventListener('mousemove', (e) => {
      if (!pinDrag) return;
      pinDrag.currentX = e.clientX;
      pinDrag.currentY = e.clientY;
      updatePreview();
    });
    window.addEventListener('mouseup', async (e) => {
      if (!pinDrag) return;
      // Find which card (if any) is under the cursor
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const card = target && target.closest && target.closest('.cork-card');
      const toId = card && card.dataset && card.dataset.id;
      if (pinPreview) { pinPreview.remove(); pinPreview = null; }
      if (toId && toId !== pinDrag.fromId) {
        const fromId = pinDrag.fromId;
        pinDrag = null;
        const existing = Store.listStrings(ws_id).filter(s => (s.from === fromId && s.to === toId) || (s.from === toId && s.to === fromId));
        const usedKinds = new Set(existing.map(s => s.kind || 'connect'));
        const defaultKind = (STRING_COLORS.find(c => !usedKinds.has(c.key)) || STRING_COLORS[0]).key;
        const result = await connectionLabelDialog({ kind: defaultKind });
        if (result !== null) {
          await Store.createString(ws_id, fromId, toId, result.label);
          const justAdded = Store.listStrings(ws_id).slice(-1)[0];
          await Store.updateString(ws_id, justAdded.id, { kind: result.kind, direction: result.direction });
          renderCanvas();
        }
      } else {
        pinDrag = null;
      }
    });

    function connectionLabelDialog(suggested) {
      return new Promise((resolve) => {
        // No default kind — user picks (or leaves blank for plain "connect").
        let kind = (suggested && suggested.kind) || null;
        let direction = 'none';
        const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(null); } });
        function close(v) { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
        function onKey(e) {
          if (e.key === 'Escape') close(null);
          else if (e.key === 'Enter' && e.target !== inp) close({ label: inp.value.trim(), kind: kind || 'connect', direction });
        }
        const inp = el('input', { type: 'text', placeholder: 'e.g. contradicts, supports, see also…' });
        const kindRow = el('div.seg-row');
        for (const c of STRING_COLORS) {
          const btn = el('button.seg-pill' + (kind === c.key ? '.active' : ''), {
            type: 'button',
            onClick: () => { kind = (kind === c.key) ? null : c.key; refreshKinds(); },
          },
            el('span.seg-dot', { style: { background: c.color } }),
            el('span', c.name),
          );
          kindRow.appendChild(btn);
        }
        function refreshKinds() {
          [...kindRow.children].forEach((b, i) => b.classList.toggle('active', STRING_COLORS[i].key === kind));
        }

        const dirRow = el('div.seg-row');
        const DIRS = [['none', '─', 'Undirected'], ['forward', '→', 'Forward'], ['backward', '←', 'Backward'], ['both', '↔', 'Both ways']];
        for (const [k, sym, name] of DIRS) {
          const btn = el('button.seg-pill' + (direction === k ? '.active' : ''),
            { type: 'button', onClick: () => { direction = k; refreshDirs(); }, title: name },
            el('span.seg-sym', sym),
            el('span', name),
          );
          dirRow.appendChild(btn);
        }
        function refreshDirs() {
          [...dirRow.children].forEach((b, i) => b.classList.toggle('active', DIRS[i][0] === direction));
        }

        const skip = el('button.ghost', { onClick: () => close({ label: '', kind: kind || 'connect', direction }) }, 'Connect without label');
        const ok = el('button.primary', { onClick: () => close({ label: inp.value.trim(), kind: kind || 'connect', direction }) }, 'Connect');
        const cancel = el('button.ghost', { onClick: () => close(null) }, 'Cancel');
        const modal = el('div.modal', { style: { width: 'min(520px, 96vw)' }, onClick: (e) => e.stopPropagation() },
          el('div.m-head', el('div', el('div.ttl', 'Tie these cards together'), el('div.sub', 'Label, kind, and direction — all optional, all changeable later')), el('button.ghost', { onClick: () => close(null) }, '✕')),
          el('div.m-body',
            el('label', 'Label'),
            inp,
            el('label', 'Kind'),
            kindRow,
            el('label', 'Direction'),
            dirRow,
          ),
          el('div.m-foot', skip, el('div.actions', cancel, ok)),
        );
        scrim.appendChild(modal);
        document.body.appendChild(scrim);
        document.addEventListener('keydown', onKey);
        setTimeout(() => inp.focus(), 50);
      });
    }

    function renderCanvas() {
      clear(canvasHost);
      const inner = el('div.cork-canvas-inner');
      canvasHost.appendChild(inner);
      inner.appendChild(stringsSvg);
      const items = Store.listEvidence(ws_id);
      if (items.length === 0) {
        canvasHost.appendChild(el('div.cork-empty',
          el('div', { style: { fontFamily: 'var(--display)', fontSize: '52px', color: 'var(--accent-deep)', fontStyle: 'italic' } }, '§'),
          el('div', { style: { fontFamily: 'var(--display)', fontSize: '20px', fontWeight: 700, color: 'var(--ink)', marginTop: '10px' } }, 'No evidence on this board yet.'),
          el('div', { style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-dim)', maxWidth: '420px', textAlign: 'center', margin: '6px auto 18px', lineHeight: 1.55 } },
            'Highlight any text in a draft and pick "Pin to corkboard", or click + Add card to start.'),
          el('button.primary', { onClick: addBlank }, icon('plus'), 'Add card'),
        ));
        return;
      }
      // Draw holons first (behind cards)
      renderHolons(inner);
      for (const ev of items) inner.appendChild(canvasCard(ev));
      renderStrings();
      applyTransform();
    }

    function applyTransform() {
      const inner = canvasHost.querySelector('.cork-canvas-inner');
      if (!inner) return;
      inner.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')';
      inner.style.transformOrigin = '0 0';
      const lbl = heading.querySelector('.zoom-lbl');
      if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
    }
    // Pan by dragging the empty canvas
    let panDrag = null;
    canvasHost.addEventListener('mousedown', (e) => {
      if (e.target !== canvasHost && !e.target.classList.contains('cork-canvas-inner')) return;
      panDrag = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
      canvasHost.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!panDrag) return;
      pan.x = panDrag.origX + (e.clientX - panDrag.startX);
      pan.y = panDrag.origY + (e.clientY - panDrag.startY);
      applyTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!panDrag) return;
      panDrag = null;
      canvasHost.style.cursor = '';
    });
    // Wheel-zoom (Ctrl/Cmd + wheel)
    canvasHost.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });
    function setZoom(z) {
      zoom = Math.max(0.3, Math.min(3, z));
      applyTransform();
    }

    function renderHolons(inner) {
      const holons = Store.listHolons ? Store.listHolons(ws_id) : [];
      const items = Store.listEvidence(ws_id);
      const itemsById = {};
      items.forEach(e => { itemsById[e.id] = e; });
      for (const h of holons) {
        const memberCards = (h.cardIds || []).map(id => itemsById[id]).filter(Boolean);
        if (memberCards.length === 0) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of memberCards) {
          minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
          maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
        }
        const pad = 22;
        const node = el('div.cork-holon', {
          style: { left: (minX - pad) + 'px', top: (minY - pad) + 'px', width: (maxX - minX + pad * 2) + 'px', height: (maxY - minY + pad * 2) + 'px', borderColor: h.color || 'var(--accent)' },
          dataset: { id: h.id },
        },
          el('div.cork-holon-label', { contenteditable: 'true', onBlur: (e) => Store.updateHolon(ws_id, h.id, { name: e.target.textContent.trim() }) }, h.name || 'Holon'),
          el('button.cork-holon-x', { onClick: async () => { await Store.deleteHolon(ws_id, h.id); renderCanvas(); }, title: 'Remove holon' }, icon('x', 12)),
        );
        inner.appendChild(node);
      }
    }

    function startHolonMode() {
      holonMode = { cardIds: new Set() };
      DOM.toast('GROUP MODE', 'Click cards to add to a group. Press Esc when done. Drag-select coming soon.', 5000);
      canvasHost.classList.add('cork-holon-mode');
    }
    function endHolonMode() {
      holonMode = null;
      canvasHost.classList.remove('cork-holon-mode');
      [...canvasHost.querySelectorAll('.cork-card.in-holon-pick')].forEach(c => c.classList.remove('in-holon-pick'));
    }
    document.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        if (holonMode && holonMode.cardIds.size > 0) {
          const name = prompt('Name this group / holon:', 'Holon');
          if (name && Store.createHolon) {
            await Store.createHolon(ws_id, { name: name.trim(), cardIds: [...holonMode.cardIds] });
            endHolonMode();
            renderCanvas();
          } else {
            endHolonMode();
          }
        } else {
          endHolonMode();
          endStringMode();
        }
      }
    });

    function renderStrings() {
      while (stringsSvg.firstChild) stringsSvg.removeChild(stringsSvg.firstChild);
      // Size the SVG to match the canvas-inner coordinate space.
      stringsSvg.setAttribute('width', '4000');
      stringsSvg.setAttribute('height', '3000');
      stringsSvg.setAttribute('viewBox', '0 0 4000 3000');
      stringsSvg.setAttribute('preserveAspectRatio', 'none');
      stringsSvg.style.position = 'absolute';
      stringsSvg.style.left = '0';
      stringsSvg.style.top = '0';
      stringsSvg.style.width = '4000px';
      stringsSvg.style.height = '3000px';
      stringsSvg.style.pointerEvents = 'none';
      stringsSvg.style.zIndex = '1';
      const strings = Store.listStrings(ws_id);
      const itemsById = {};
      Store.listEvidence(ws_id).forEach(e => { itemsById[e.id] = e; });
      // Pre-compute "pair index" so multiple strings between the same two
      // cards are drawn with a different curvature each.
      const pairCounts = {};
      const pairOrders = {};
      for (const s of strings) {
        const key = [s.from, s.to].sort().join('|');
        pairCounts[key] = (pairCounts[key] || 0) + 1;
        pairOrders[s.id] = pairCounts[key] - 1;
      }

      // Build arrow marker defs if not already present
      let defs = stringsSvg.querySelector('defs');
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        stringsSvg.appendChild(defs);
      }
      // Re-create defs each render so colors stay in sync
      while (defs.firstChild) defs.removeChild(defs.firstChild);
      for (const c of STRING_COLORS) {
        for (const dir of ['s', 'e']) {
          const id = 'arrow-' + c.key + '-' + dir;
          const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
          marker.setAttribute('id', id);
          marker.setAttribute('viewBox', '0 0 10 10');
          marker.setAttribute('refX', dir === 'e' ? '8' : '2');
          marker.setAttribute('refY', '5');
          marker.setAttribute('markerWidth', '6');
          marker.setAttribute('markerHeight', '6');
          marker.setAttribute('orient', dir === 'e' ? 'auto' : 'auto-start-reverse');
          const tri = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          tri.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
          tri.setAttribute('fill', c.color);
          marker.appendChild(tri);
          defs.appendChild(marker);
        }
      }

      for (const s of strings) {
        const a = itemsById[s.from], b = itemsById[s.to];
        if (!a || !b) continue;
        const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
        const bx = b.x + b.w / 2, by = b.y + b.h / 2;

        // Multiple-strings curvature offset
        const pairIdx = pairOrders[s.id] || 0;
        const pairKey = [s.from, s.to].sort().join('|');
        const total = pairCounts[pairKey];
        const lineDx = bx - ax, lineDy = by - ay;
        const len = Math.max(1, Math.hypot(lineDx, lineDy));
        const nx = -lineDy / len, ny = lineDx / len; // perpendicular normal
        const offsetMagnitude = total > 1 ? (pairIdx - (total - 1) / 2) * 38 : 0;
        const midX = (ax + bx) / 2 + nx * offsetMagnitude;
        const midY = (ay + by) / 2 + ny * offsetMagnitude;

        const d = 'M ' + ax + ' ' + ay + ' Q ' + midX + ' ' + midY + ', ' + bx + ' ' + by;
        const kind = s.kind || 'connect';
        const col = stringColor(kind);
        const dir = s.direction || 'none'; // 'forward' | 'backward' | 'both' | 'none'

        // Wide invisible hit target
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '24');
        hit.setAttribute('fill', 'none');
        hit.style.pointerEvents = 'stroke';
        hit.style.cursor = 'pointer';
        hit.addEventListener('mouseenter', () => { path.setAttribute('stroke-width', '5'); if (labelText) { labelText.style.opacity = '1'; labelBg.style.opacity = '1'; } });
        hit.addEventListener('mouseleave', () => { path.setAttribute('stroke-width', '2.5'); });
        hit.addEventListener('click', (e) => { e.stopPropagation(); openStringMenu(e, s); });
        stringsSvg.appendChild(hit);

        // Visible path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'cork-str-path');
        path.setAttribute('stroke', col);
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linecap', 'round');
        if (dir === 'forward' || dir === 'both') path.setAttribute('marker-end', 'url(#arrow-' + kind + '-e)');
        if (dir === 'backward' || dir === 'both') path.setAttribute('marker-start', 'url(#arrow-' + kind + '-s)');
        path.style.pointerEvents = 'none';
        path.dataset.id = s.id;
        stringsSvg.appendChild(path);

        let labelText = null, labelBg = null;
        if (s.label) {
          // White-ish background plate behind the label
          labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          const labelLen = s.label.length;
          labelBg.setAttribute('x', midX - (labelLen * 4 + 8));
          labelBg.setAttribute('y', midY - 18);
          labelBg.setAttribute('width', labelLen * 8 + 16);
          labelBg.setAttribute('height', 22);
          labelBg.setAttribute('rx', 4);
          labelBg.setAttribute('fill', 'var(--chrome)');
          labelBg.setAttribute('stroke', col);
          labelBg.setAttribute('stroke-width', '1');
          labelBg.style.pointerEvents = 'none';
          stringsSvg.appendChild(labelBg);
          labelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          labelText.setAttribute('x', midX);
          labelText.setAttribute('y', midY - 3);
          labelText.setAttribute('class', 'cork-str-label');
          labelText.setAttribute('text-anchor', 'middle');
          labelText.setAttribute('fill', col);
          labelText.style.pointerEvents = 'none';
          labelText.textContent = s.label;
          stringsSvg.appendChild(labelText);
        }
      }
    }

    function editStringLabel(s) {
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      const inp = el('input', { type: 'text', value: s.label || '', placeholder: 'Label this connection' });
      function close() { scrim.remove(); }
      async function save() {
        await Store.updateString(ws_id, s.id, { label: inp.value.trim() });
        close();
        renderStrings();
      }
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); });
      const modal = el('div.modal', { style: { width: 'min(440px, 96vw)' }, onClick: (e) => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Edit label')), el('button.ghost', { onClick: close }, '✕')),
        el('div.m-body', el('label', 'Label'), inp),
        el('div.m-foot', el('div'), el('div.actions', el('button.ghost', { onClick: close }, 'Cancel'), el('button.primary', { onClick: save }, 'Save'))),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
    }

    function openStringMenu(e, s) {
      const menu = el('div.context-menu', { style: { left: e.clientX + 'px', top: e.clientY + 'px', minWidth: '240px' } });
      menu.appendChild(el('div', { style: { padding: '6px 12px', fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Kind'));
      for (const c of STRING_COLORS) {
        menu.appendChild(el('div', { onClick: async () => { menu.remove(); await Store.updateString(ws_id, s.id, { kind: c.key }); renderStrings(); } },
          el('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: c.color, display: 'inline-block', marginRight: '8px', flexShrink: 0 } }),
          c.name + ((s.kind || 'connect') === c.key ? '  ✓' : ''),
        ));
      }
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      menu.appendChild(el('div', { style: { padding: '6px 12px', fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Direction'));
      const dirs = [
        ['none',     'Undirected  ─'],
        ['forward',  'Forward  →'],
        ['backward', 'Backward  ←'],
        ['both',     'Both ways  ↔'],
      ];
      for (const [k, lbl] of dirs) {
        menu.appendChild(el('div', { onClick: async () => { menu.remove(); await Store.updateString(ws_id, s.id, { direction: k }); renderStrings(); } },
          lbl + ((s.direction || 'none') === k ? '  ✓' : '')));
      }
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      menu.appendChild(el('div', { onClick: () => { menu.remove(); editStringLabel(s); } }, icon('pencil-simple'), 'Edit label'));
      menu.appendChild(el('div', { style: { color: 'var(--err)' }, onClick: async () => {
        menu.remove();
        const ok = await DOM.confirmDialog({ title: 'Cut this string?', confirmLabel: 'Cut', danger: true });
        if (ok) { await Store.deleteString(ws_id, s.id); renderStrings(); }
      } }, icon('scissors'), 'Cut'));
      document.body.appendChild(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    }

    function startStringMode() {
      stringMode = { fromId: null };
      DOM.toast('CONNECT MODE', 'Click a card, then click another to tie them.', 4000);
      canvasHost.classList.add('cork-connect-mode');
    }
    function endStringMode() {
      stringMode = null;
      canvasHost.classList.remove('cork-connect-mode');
    }

    function renderTable() {
      clear(tableHost);
      const items = Store.listEvidence(ws_id);
      if (items.length === 0) {
        tableHost.appendChild(el('div.cork-empty', el('div', { style: { fontFamily: 'var(--sans)', fontSize: '14px', color: 'var(--ink-faint)', padding: '40px', textAlign: 'center' } }, 'No evidence on this board yet.')));
        return;
      }
      const table = el('table.cork-tbl',
        el('thead', el('tr',
          el('th', ''),
          el('th', 'Quote'),
          el('th', 'Note'),
          el('th', 'Source / Draft'),
          el('th', 'Tags'),
          el('th', 'Added'),
          el('th', ''),
        )),
        el('tbody', ...items.map(ev => tableRow(ev))),
      );
      tableHost.appendChild(table);
    }

    function canvasCard(ev) {
      const c = colorFor(ev.color);
      const node = el('div.cork-card', {
        style: { left: ev.x + 'px', top: ev.y + 'px', width: ev.w + 'px', minHeight: ev.h + 'px', background: c.swatch, color: c.text },
        dataset: { id: ev.id },
      });

      // The whole non-interactive area of the card is draggable.
      let drag = null;
      node.addEventListener('mousedown', (e) => {
        if (stringMode) return;
        const t = e.target;
        if (t.closest('button, a, [contenteditable="true"], .cork-handle, input, textarea')) return;
        drag = { startX: e.clientX, startY: e.clientY, origX: ev.x, origY: ev.y };
        node.style.zIndex = 50;
        node.classList.add('dragging');
        e.preventDefault();
      });
      function onMove(e) {
        if (!drag) return;
        ev.x = Math.max(0, drag.origX + (e.clientX - drag.startX));
        ev.y = Math.max(0, drag.origY + (e.clientY - drag.startY));
        node.style.left = ev.x + 'px';
        node.style.top = ev.y + 'px';
        renderStrings();
      }
      function onUp() {
        if (!drag) return;
        Store.updateEvidence(ws_id, ev.id, { x: ev.x, y: ev.y });
        drag = null;
        node.style.zIndex = '';
        node.classList.remove('dragging');
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);

      // Resize handle
      const resize = el('div.cork-handle', icon('arrows-out-cardinal', 12));
      let rdrag = null;
      resize.addEventListener('mousedown', (e) => { rdrag = { startX: e.clientX, startY: e.clientY, origW: ev.w, origH: ev.h }; e.preventDefault(); e.stopPropagation(); });
      window.addEventListener('mousemove', (e) => {
        if (!rdrag) return;
        ev.w = Math.max(170, rdrag.origW + (e.clientX - rdrag.startX));
        ev.h = Math.max(110, rdrag.origH + (e.clientY - rdrag.startY));
        node.style.width = ev.w + 'px';
        node.style.minHeight = ev.h + 'px';
        renderStrings();
      });
      window.addEventListener('mouseup', async () => {
        if (!rdrag) return;
        await Store.updateEvidence(ws_id, ev.id, { w: ev.w, h: ev.h });
        rdrag = null;
      });

      // String mode click handler — also handles holon mode
      node.addEventListener('click', async (e) => {
        if (holonMode) {
          e.stopPropagation();
          if (holonMode.cardIds.has(ev.id)) { holonMode.cardIds.delete(ev.id); node.classList.remove('in-holon-pick'); }
          else { holonMode.cardIds.add(ev.id); node.classList.add('in-holon-pick'); }
          return;
        }
      });

      // String pins — left/right/top/bottom anchors. Drag from one pin to a
      // card to draw a string.
      const PIN_POSITIONS = [
        { side: 't', x: 0.5, y: 0 },
        { side: 'r', x: 1.0, y: 0.5 },
        { side: 'b', x: 0.5, y: 1 },
        { side: 'l', x: 0,   y: 0.5 },
      ];
      for (const p of PIN_POSITIONS) {
        const pin = el('div.cork-pin' + ' cork-pin-' + p.side, { title: 'Drag to another card to connect' });
        pin.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          startPinDrag(ev, p, e.clientX, e.clientY);
        });
        node.appendChild(pin);
      }

      // Right-click menu
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); openCardMenu(e, ev); });
      // Double-click to open detail modal
      node.addEventListener('dblclick', (e) => {
        if (e.target.closest('[contenteditable="true"], button, a')) return;
        openCardDetailModal(ev);
      });

      // Title (first line, larger)
      const titleEd = el('div.cork-title-line', { contenteditable: 'true', spellcheck: 'true' }, ev.quote || '');
      titleEd.dataset.placeholder = 'Title';
      titleEd.addEventListener('blur', () => Store.updateEvidence(ws_id, ev.id, { quote: titleEd.textContent.trim() }));
      titleEd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          bodyEd.focus();
        }
      });

      // Body
      const bodyEd = el('div.cork-body-line', { contenteditable: 'true', spellcheck: 'true' }, ev.note || '');
      bodyEd.dataset.placeholder = 'Body';
      bodyEd.addEventListener('blur', () => Store.updateEvidence(ws_id, ev.id, { note: bodyEd.textContent.trim() }));

      // Source link (small bottom line) — clickable if linked
      const srcLine = el('div.cork-srcline');
      if (ev.source_id) {
        for (const d of Store.listDocuments(ws_id)) {
          const s = Store.getSource(d.id, ev.source_id);
          if (s) {
            srcLine.appendChild(el('a', { href: '#', onClick: (e) => { e.preventDefault(); app.openDocument(ws_id, d.id); }, style: { color: c.text, textDecoration: 'underline', fontSize: '11px', opacity: 0.85 } },
              icon('paperclip', 11), ' ', s.title || s.filename,
              ev.span_quote ? ' · "' + ev.span_quote.slice(0, 30) + (ev.span_quote.length > 30 ? '…' : '') + '"' : '',
            ));
            break;
          }
        }
      } else if (ev.doc_id) {
        const d = Store.getDocument(ev.doc_id);
        if (d) srcLine.appendChild(el('a', { href: '#', onClick: (e) => { e.preventDefault(); app.openDocument(ws_id, d.id); }, style: { color: c.text, textDecoration: 'underline', fontSize: '11px', opacity: 0.85 } }, icon('file-text', 11), ' ', d.title || 'Draft'));
      }

      const closeBtn = el('button.cork-close', { onClick: async () => {
        const ok = await DOM.confirmDialog({ title: 'Remove this card?', body: '"' + (ev.quote || 'Empty card').slice(0, 80) + '"', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        await Store.deleteEvidence(ws_id, ev.id);
        renderAll();
      } }, icon('x'));

      node.appendChild(closeBtn);
      node.appendChild(titleEd);
      node.appendChild(bodyEd);
      if (srcLine.firstChild) node.appendChild(srcLine);
      node.appendChild(resize);
      return node;
    }

    function openCardMenu(e, ev) {
      const menu = el('div.context-menu', { style: { left: e.clientX + 'px', top: e.clientY + 'px', minWidth: '220px' } });
      function row(ic, text, action) {
        return el('div', { onClick: () => { menu.remove(); action(); } }, icon(ic), text);
      }
      menu.appendChild(row('paperclip', 'Link to a source or exhibit…', () => linkToReference(ev)));
      menu.appendChild(row('arrows-out-line-vertical', 'Connect to another card…', () => { startStringMode(); stringMode.fromId = ev.id; }));
      menu.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }));
      menu.appendChild(row('trash', 'Remove card', async () => {
        const ok = await DOM.confirmDialog({ title: 'Remove this card?', confirmLabel: 'Remove', danger: true });
        if (ok) { await Store.deleteEvidence(ws_id, ev.id); renderAll(); }
      }));
      document.body.appendChild(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    }

    function linkToReference(ev) {
      // Build records — sources (per doc) and workspace-scoped exhibits.
      const sources = [];
      for (const d of Store.listDocuments(ws_id)) {
        for (const s of Store.listSources(d.id)) sources.push({ kind: 'source', source: s, doc: d });
      }
      const exhibits = Store.listExhibits(ws_id).map(ex => ({ kind: 'exhibit', exhibit: ex }));

      let mode = ev.exhibit_id ? 'exhibit' : 'source';
      let picked = null;
      // Pre-pick current link
      if (ev.exhibit_id) picked = exhibits.find(r => r.exhibit.id === ev.exhibit_id) || null;
      else if (ev.source_id) picked = sources.find(r => r.source.source_id === ev.source_id) || null;

      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });

      // Tab bar
      const sourcesTab = el('button.seg-pill' + (mode === 'source' ? '.active' : ''), {
        type: 'button', onClick: () => { mode = 'source'; refreshTabs(); render(input.value); }
      }, icon('paperclip', 12), 'Sources', el('span.tab-count', String(sources.length)));
      const exhibitsTab = el('button.seg-pill' + (mode === 'exhibit' ? '.active' : ''), {
        type: 'button', onClick: () => { mode = 'exhibit'; refreshTabs(); render(input.value); }
      }, icon('scissors', 12), 'Exhibits', el('span.tab-count', String(exhibits.length)));
      const tabRow = el('div.seg-row', { style: { marginBottom: '10px' } }, sourcesTab, exhibitsTab);
      function refreshTabs() {
        sourcesTab.classList.toggle('active', mode === 'source');
        exhibitsTab.classList.toggle('active', mode === 'exhibit');
      }

      const input = el('input', { type: 'text', placeholder: 'Filter…', style: { marginBottom: '10px' } });
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '40vh', overflowY: 'auto' } });
      const spanTa = el('textarea', { rows: 2, placeholder: '(Optional) pin a specific span/passage from the reference' }, ev.span_quote || '');

      function srcRow(rec) {
        const s = rec.source;
        return el('button.ref-row' + (picked === rec ? '.selected' : ''),
          { type: 'button', onClick: () => { picked = rec; render(input.value); } },
          el('div.ref-ico', { style: { background: 'var(--accent-deep)', color: 'var(--accent-soft)' } },
            s.source_url ? icon('globe', 14) : el('span', DOM.fileExt(s.mime, s.filename))),
          el('div.ref-body',
            el('div.ref-ttl', s.title || s.filename),
            el('div.ref-sub',
              s.archive_org_url
                ? el('span.ref-badge.ok', icon('check-circle', 9), 'ARCHIVED')
                : el('span.ref-badge.warn', 'NOT ARCHIVED'),
              el('span.ref-meta', rec.doc.title || 'Untitled draft'),
            ),
          ),
        );
      }
      function exhRow(rec) {
        const ex = rec.exhibit;
        const provSrc = ex.provenance && (ex.provenance.source_title || ex.provenance.filename);
        return el('button.ref-row' + (picked === rec ? '.selected' : ''),
          { type: 'button', onClick: () => { picked = rec; render(input.value); } },
          el('div.ref-ico', { style: { background: 'color-mix(in srgb, var(--accent) 22%, var(--chrome-2))', color: 'var(--accent)' } },
            icon('scissors', 14)),
          el('div.ref-body',
            el('div.ref-ttl', ex.label || ('"' + (ex.text || '').slice(0, 70) + (ex.text && ex.text.length > 70 ? '…' : '') + '"')),
            el('div.ref-sub',
              ex.provenance && ex.provenance.archive_org_url
                ? el('span.ref-badge.ok', icon('check-circle', 9), 'ARCHIVED SRC')
                : el('span.ref-badge.warn', 'SOURCE NOT ARCHIVED'),
              el('span.ref-meta', provSrc || 'No source attached'),
            ),
          ),
        );
      }

      function render(q) {
        clear(list);
        const needle = (q || '').toLowerCase().trim();
        let recs, rowFn;
        if (mode === 'source') {
          recs = sources;
          if (needle) {
            recs = recs.filter(rec => {
              const h = [rec.source.title, rec.source.filename, rec.source.source_url, rec.doc.title, (rec.source.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
              return h.includes(needle);
            });
          }
          rowFn = srcRow;
        } else {
          recs = exhibits;
          if (needle) {
            recs = recs.filter(rec => {
              const ex = rec.exhibit;
              const h = [ex.label, ex.text, ex.note, (ex.tags || []).join(' '), ex.provenance && ex.provenance.source_title, ex.provenance && ex.provenance.filename].filter(Boolean).join(' ').toLowerCase();
              return h.includes(needle);
            });
          }
          rowFn = exhRow;
        }
        if (recs.length === 0) {
          const what = mode === 'source' ? 'sources' : 'exhibits';
          list.appendChild(el('div', { style: { padding: '20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--sans)', fontSize: '13px' } },
            needle ? 'No ' + what + ' match.' : 'No ' + what + ' yet in this workspace.'));
        } else {
          for (const rec of recs) list.appendChild(rowFn(rec));
        }
        save.disabled = !picked;
      }
      input.addEventListener('input', () => render(input.value));

      const save = el('button.primary', { onClick: async () => {
        if (!picked) return;
        const patch = { span_quote: spanTa.value.trim() };
        if (picked.kind === 'source') {
          patch.source_id = picked.source.source_id;
          patch.doc_id = picked.doc.id;
          patch.exhibit_id = null;
        } else {
          patch.exhibit_id = picked.exhibit.id;
          patch.source_id = picked.exhibit.source_id || null;
          patch.doc_id = picked.exhibit.doc_id || null;
        }
        await Store.updateEvidence(ws_id, ev.id, patch);
        scrim.remove();
        renderAll();
      }, disabled: true }, 'Link');

      const modal = el('div.modal', { style: { width: 'min(640px, 96vw)' }, onClick: e => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Link card'), el('div.sub', 'Tie this card to a source file or a saved exhibit (works across all draft versions)')), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body',
          tabRow,
          input,
          list,
          el('label', { style: { marginTop: '10px' } }, 'Span / passage (optional)'),
          spanTa,
        ),
        el('div.m-foot', el('div'),
          el('div.actions', el('button.ghost', { onClick: () => scrim.remove() }, 'Cancel'), save),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      render('');
      setTimeout(() => input.focus(), 50);
    }
    // Back-compat alias for any old call sites.
    const linkToSource = linkToReference;

    function sourceMetaLine(ev) {
      const label = sourceLabel(ev);
      if (!label) return null;
      return el('div.cork-meta', icon(ev.source_id ? 'paperclip' : 'file-text', 11), label);
    }
    function sourceLabel(ev) {
      if (ev.source_id) {
        for (const d of Store.listDocuments(ws_id)) {
          const s = Store.getSource(d.id, ev.source_id);
          if (s) return (s.title || s.filename) + (s.archive_org_url ? ' · archived' : '');
        }
      }
      if (ev.doc_id) {
        const d = Store.getDocument(ev.doc_id);
        if (d) return 'Draft: ' + d.title;
      }
      return '';
    }

    function tableRow(ev) {
      const c = colorFor(ev.color);
      return el('tr', { dataset: { id: ev.id } },
        el('td', el('span.cork-tbl-swatch', { style: { background: c.swatch } })),
        el('td', el('div.cork-tbl-quote', ev.quote || '(empty)')),
        el('td', el('div.cork-tbl-note', ev.note || '')),
        el('td', el('div.cork-tbl-src', sourceLabel(ev) || '—')),
        el('td', el('div.cork-tbl-tags', (ev.tags || []).map(t => el('span.tag', t)))),
        el('td', el('div.cork-tbl-time', DOM.fmtTimeAgo(ev.created_at))),
        el('td',
          el('button.ghost', { onClick: async () => {
            const ok = await DOM.confirmDialog({ title: 'Remove this card?', confirmLabel: 'Remove', danger: true });
            if (ok) { await Store.deleteEvidence(ws_id, ev.id); renderAll(); }
          } }, icon('trash'))
        ),
      );
    }

    async function addBlank() {
      await Store.createEvidence(ws_id, { quote: '', note: '' });
      renderAll();
    }

    async function cleanUp() {
      const items = Store.listEvidence(ws_id);
      if (items.length === 0) return;
      const cols = Math.max(1, Math.ceil(Math.sqrt(items.length)));
      const cellW = 260, cellH = 200, gap = 24;
      const startX = 40, startY = 40;
      for (let i = 0; i < items.length; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const x = startX + c * (cellW + gap);
        const y = startY + r * (cellH + gap);
        await Store.updateEvidence(ws_id, items[i].id, { x, y, w: cellW - 20, h: cellH - 20 });
      }
      renderCanvas();
      DOM.toast('TIDIED', 'Cards arranged in a grid.', 2500);
    }

    function openCardDetailModal(ev) {
      const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) scrim.remove(); } });
      const titleInp = el('input', { type: 'text', value: ev.quote || '', placeholder: 'Title' });
      const bodyTa = el('textarea', { rows: 6, placeholder: 'Body', value: ev.note || '' });
      bodyTa.value = ev.note || '';

      const linkedBox = el('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' } });
      function renderLinked() {
        clear(linkedBox);
        const linked = [];
        if (ev.source_id) {
          for (const d of Store.listDocuments(ws_id)) {
            const s = Store.getSource(d.id, ev.source_id);
            if (s) { linked.push({ kind: 'source', source: s, doc: d }); break; }
          }
        }
        if (ev.doc_id) {
          const d = Store.getDocument(ev.doc_id);
          if (d) linked.push({ kind: 'doc', doc: d });
        }
        if (linked.length === 0) {
          linkedBox.appendChild(el('div', { style: { fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--ink-faint)', fontStyle: 'italic' } }, 'Not linked to any source or draft yet.'));
        } else {
          for (const l of linked) {
            if (l.kind === 'source') {
              linkedBox.appendChild(el('div', { style: { padding: '10px 12px', background: 'var(--chrome-2)', border: '1px solid var(--border)', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '10px' } },
                el('div', { style: { width: '32px', height: '32px', display: 'grid', placeItems: 'center', background: 'var(--accent-deep)', color: 'var(--accent-soft)', fontFamily: 'var(--mono)', fontSize: '10px', borderRadius: '3px' } }, l.source.source_url ? '🌐' : DOM.fileExt(l.source.mime, l.source.filename)),
                el('div', { style: { flex: 1 } },
                  el('div', { style: { fontWeight: 600 } }, l.source.title || l.source.filename),
                  el('div', { style: { fontSize: '11px', color: 'var(--ink-faint)' } }, (l.source.archive_org_url ? '✓ Archived · ' : '○ Not archived · ') + (l.doc.title || 'Untitled')),
                  ev.span_quote ? el('div', { style: { fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: '12px', color: 'var(--ink-dim)', marginTop: '4px', borderLeft: '2px solid var(--accent)', paddingLeft: '8px' } }, '"' + ev.span_quote + '"') : null,
                ),
                el('button.ghost', { onClick: () => { scrim.remove(); app.openDocument(ws_id, l.doc.id); } }, 'Open draft'),
                l.source.archive_org_url ? el('a.ghost', { href: l.source.archive_org_url, target: '_blank', rel: 'noopener', style: { padding: '6px 10px', border: '1px solid var(--border)', textDecoration: 'none', fontSize: '12px', borderRadius: '4px' } }, 'archive.org ↗') : null,
              ));
            } else {
              linkedBox.appendChild(el('div', { style: { padding: '10px 12px', background: 'var(--chrome-2)', border: '1px solid var(--border)', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '10px' } },
                el('div', { style: { width: '32px', height: '32px', display: 'grid', placeItems: 'center', background: 'var(--accent-deep)', color: 'var(--accent-soft)' } }, '§'),
                el('div', { style: { flex: 1 } },
                  el('div', { style: { fontWeight: 600 } }, 'Draft: ' + l.doc.title),
                  el('div', { style: { fontSize: '11px', color: 'var(--ink-faint)' } }, 'v' + l.doc.version),
                ),
                el('button.ghost', { onClick: () => { scrim.remove(); app.openDocument(ws_id, l.doc.id); } }, 'Open'),
              ));
            }
          }
        }
        linkedBox.appendChild(el('div', { style: { marginTop: '4px' } },
          el('button.ghost', { onClick: () => { scrim.remove(); linkToSource(ev); }, style: { fontSize: '12px' } }, icon('paperclip'), ev.source_id ? ' Change linked source' : ' Link to a source')));
      }
      renderLinked();

      const provenance = el('div', { style: { fontFamily: 'var(--sans)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '14px', lineHeight: 1.7 } },
        el('div', el('strong', 'Created: '), DOM.fmtTimeAgo(ev.created_at), ev.author ? ' by ' + ev.author : ''),
        el('div', el('strong', 'Card ID: '), ev.id),
        el('div', el('strong', 'Board: '), ev.board_id || '—'),
      );

      const modal = el('div.modal', { style: { width: 'min(640px, 96vw)' }, onClick: (e) => e.stopPropagation() },
        el('div.m-head', el('div', el('div.ttl', 'Card details'), el('div.sub', 'Linked sources, full body, provenance')), el('button.ghost', { onClick: () => scrim.remove() }, '✕')),
        el('div.m-body',
          el('label', 'Title'),
          titleInp,
          el('label', 'Body'),
          bodyTa,
          el('label', 'Linked to'),
          linkedBox,
          provenance,
        ),
        el('div.m-foot',
          el('button.ghost', { onClick: async () => {
            const ok = await DOM.confirmDialog({ title: 'Remove this card?', confirmLabel: 'Remove', danger: true });
            if (!ok) return;
            await Store.deleteEvidence(ws_id, ev.id);
            scrim.remove();
            renderAll();
          }, style: { color: 'var(--err)' } }, 'Remove card'),
          el('div.actions',
            el('button.ghost', { onClick: () => scrim.remove() }, 'Close'),
            el('button.primary', { onClick: async () => {
              await Store.updateEvidence(ws_id, ev.id, { quote: titleInp.value.trim(), note: bodyTa.value });
              scrim.remove();
              renderAll();
            } }, 'Save'),
          ),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      setTimeout(() => titleInp.focus(), 50);
    }

    renderBoardTabs();
    renderAll();
    setView('canvas');
    // Floating legend
    const legend = el('div.cork-legend');
    legend.appendChild(el('div.cork-legend-head', 'Connection legend'));
    for (const c of STRING_COLORS) {
      legend.appendChild(el('div.cork-legend-row',
        el('span', { style: { width: '14px', height: '3px', background: c.color, borderRadius: '2px', display: 'inline-block' } }),
        el('span', c.name),
      ));
    }
    host.appendChild(legend);
    return host;
  }

  // Pin API for editor's selection toolbar
  async function pin(ws_id, payload, opts) {
    const item = await Store.createEvidence(ws_id, payload);
    DOM.toast('PINNED', '"' + ((item.quote || '').slice(0, 80) || 'evidence') + '" added to corkboard', 4000);
    return item;
  }

  window.Corkboard = { open, pin, COLORS };
})();
