// ============ TINY DOM HELPERS ============
// Hyperscript-ish builder so the rest of the code stays readable
// without a framework. Returns real HTMLElements.

(function () {
  function el(tag, props, ...children) {
    // Allow el('div.foo.bar#x', {...})
    let id = null;
    const classes = [];
    const tagParts = tag.split(/([.#])/);
    let name = tagParts[0] || 'div';
    for (let i = 1; i < tagParts.length; i += 2) {
      const sep = tagParts[i];
      const val = tagParts[i + 1];
      if (sep === '.') classes.push(val);
      else if (sep === '#') id = val;
    }
    const node = document.createElement(name);
    if (id) node.id = id;
    if (classes.length) node.className = classes.join(' ');

    if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') {
          node.className = (node.className ? node.className + ' ' : '') + v;
        } else if (k === 'style' && typeof v === 'object') {
          Object.assign(node.style, v);
        } else if (k === 'dataset' && typeof v === 'object') {
          Object.assign(node.dataset, v);
        } else if (k === 'html') {
          node.innerHTML = v;
        } else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'ref' && typeof v === 'function') {
          v(node);
        } else if (k in node && k !== 'list') {
          try { node[k] = v; } catch (_) { node.setAttribute(k, v); }
        } else {
          node.setAttribute(k, v);
        }
      }
    } else if (props !== undefined) {
      children.unshift(props);
    }

    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      if (child instanceof Node) node.appendChild(child);
      else node.appendChild(document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  function mount(parent, node) { clear(parent); parent.appendChild(node); return node; }

  function svgIcon(path, opts) {
    const o = opts || {};
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', o.size || 14);
    s.setAttribute('height', o.size || 14);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', o.stroke || 1.6);
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtTimeAgo(iso) {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    const sec = Math.max(0, (Date.now() - then) / 1000);
    if (sec < 60) return Math.floor(sec) + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd ago';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fileExt(mime, filename) {
    if (filename) {
      const m = filename.match(/\.([a-z0-9]+)$/i);
      if (m) return m[1].toUpperCase().slice(0, 4);
    }
    if (!mime) return 'FILE';
    if (mime.startsWith('image/')) return mime.split('/')[1].toUpperCase().slice(0, 4);
    if (mime.includes('pdf')) return 'PDF';
    if (mime.includes('word')) return 'DOC';
    if (mime.includes('rfc822')) return 'EML';
    if (mime.startsWith('text/')) return 'TXT';
    return 'FILE';
  }

  function toast(ttl, msg, ms = 3000) {
    const t = el('div.toast',
      el('div.ttl', ttl),
      el('div.msg', msg)
    );
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(20px)'; t.style.transition = 'all 180ms'; }, ms - 200);
    setTimeout(() => t.remove(), ms);
  }

  // In-app confirm dialog — replaces window.confirm.
  // Returns a promise that resolves true (confirmed) or false (cancelled).
  function confirmDialog({ title, body, confirmLabel, cancelLabel, danger } = {}) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      function close(result) { scrim.remove(); resolve(result); }
      scrim.addEventListener('click', (e) => { if (e.target === scrim) close(false); });

      const modal = el('div.modal', { style: { width: 'min(440px, 96vw)' }, onClick: (e) => e.stopPropagation() },
        el('div.m-head',
          el('div', el('div.ttl', title || 'Are you sure?')),
          el('button.ghost', { onClick: () => close(false) }, '✕'),
        ),
        el('div.m-body',
          el('div', { style: { fontFamily: 'var(--sans)', fontSize: '14px', color: 'var(--ink-dim)', lineHeight: '1.6' } }, body || ''),
        ),
        el('div.m-foot',
          el('div'),
          el('div.actions',
            el('button.ghost', { onClick: () => close(false) }, cancelLabel || 'Cancel'),
            el('button' + (danger ? '' : '.primary'), {
              onClick: () => close(true),
              style: danger ? { background: 'var(--err)', borderColor: 'var(--err)', color: '#fff', fontWeight: '600' } : null,
            }, confirmLabel || 'Confirm'),
          ),
        ),
      );
      scrim.appendChild(modal);
      document.body.appendChild(scrim);
      function onKey(e) {
        if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', onKey); }
        else if (e.key === 'Enter') { close(true); document.removeEventListener('keydown', onKey); }
      }
      document.addEventListener('keydown', onKey);
    });
  }

  function debounce(fn, ms) {
    let h;
    return function (...args) {
      clearTimeout(h);
      h = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function uuid() {
    return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  window.DOM = { el, clear, mount, svgIcon, fmtBytes, fmtTimeAgo, fileExt, toast, confirmDialog, debounce, uuid };
})();
