/**
 * recovery-modals.js — Replaces the confirm()/prompt() fallback in the
 * Store shim with proper styled modals for recovery-key flows.
 *
 * Two flows:
 *   - display(key): show the generated recovery key on first login.
 *     Resolves once the user acknowledges they saved it.
 *   - ask(): prompt for the recovery key on a new device. Resolves with
 *     the entered key, or null if the user skips.
 *
 * Attached as window.RecoveryUI so it can be invoked from the IIFE
 * world. Uses the same .scrim / .modal classes already styled by
 * styles.css so it matches the rest of the UI.
 */

(function () {
  function el(tag, attrs, ...kids) {
    const m = String(tag).match(/^([a-z0-9]+)?(?:\.([a-z0-9._\-]+))?$/i);
    const n = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) n.className = m[2].replace(/\./g, ' ');
    if (attrs && typeof attrs === 'object' && !attrs.nodeType && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'class') n.className = ((n.className || '') + ' ' + v).trim();
        else n.setAttribute(k, v);
      }
    } else if (attrs != null) {
      kids.unshift(attrs);
    }
    for (const c of kids.flat()) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function withScrim(modal) {
    const scrim = el('div.scrim');
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    return scrim;
  }

  function display(key) {
    return new Promise((resolve) => {
      let modalRef;
      const ackBtn = el('button.primary', {
        onClick: () => { scrim.remove(); resolve(); },
      }, "I've saved it");
      const keyBox = el('div', {
        style: {
          background: 'var(--chrome)', border: '1px solid var(--border)',
          borderRadius: '6px', padding: '14px',
          fontFamily: 'var(--mono)', fontSize: '14px',
          color: 'var(--accent)', wordBreak: 'break-all',
          userSelect: 'all', cursor: 'text', marginBottom: '12px',
        },
      }, key);
      const copyBtn = el('button.ghost', {
        style: { marginRight: '8px' },
        onClick: async () => {
          try { await navigator.clipboard.writeText(key); copyBtn.textContent = 'Copied'; }
          catch (_) { copyBtn.textContent = 'Select + copy'; }
        },
      }, 'Copy key');

      modalRef = el('div.modal',
        { style: { width: 'min(560px, 96vw)', borderColor: 'var(--accent-soft)' } },
        el('div.m-head', el('div', el('div.ttl', 'Save your recovery key'))),
        el('div.m-body',
          el('div', {
            style: { fontFamily: 'var(--sans)', fontSize: '13px',
                     color: 'var(--ink-dim)', lineHeight: '1.7', marginBottom: '14px' },
          },
            'This key restores your message history on new browsers and devices. ',
            'Save it in a password manager or somewhere offline — ',
            el('b', 'it cannot be shown again'), '.',
          ),
          keyBox,
        ),
        el('div.m-foot',
          el('div'),
          el('div.actions', copyBtn, ackBtn),
        ),
      );

      const scrim = withScrim(modalRef);
      function onKey(e) {
        if (e.key === 'Escape') {
          // Don't accidentally dismiss; user must explicitly ack.
        } else if (e.key === 'Enter') {
          ackBtn.click();
        }
      }
      document.addEventListener('keydown', onKey, { once: false });
      // Auto-remove listener when scrim goes away
      const removal = new MutationObserver(() => {
        if (!document.contains(scrim)) {
          document.removeEventListener('keydown', onKey);
          removal.disconnect();
        }
      });
      removal.observe(document.body, { childList: true });
    });
  }

  function ask() {
    return new Promise((resolve) => {
      const input = el('input', {
        type: 'text', autocomplete: 'off',
        placeholder: 'EsTb …',
        style: {
          width: '100%', padding: '10px 12px',
          fontFamily: 'var(--mono)', fontSize: '13px',
          background: 'var(--chrome)', border: '1px solid var(--border)',
          borderRadius: '4px', color: 'var(--ink)',
        },
      });
      const close = (value) => { scrim.remove(); resolve(value); };
      const skipBtn = el('button.ghost', { onClick: () => close(null) }, 'Skip');
      const submitBtn = el('button.primary', {
        onClick: () => close(input.value.trim() || null),
      }, 'Unlock');

      const modalRef = el('div.modal',
        { style: { width: 'min(480px, 96vw)' } },
        el('div.m-head',
          el('div', el('div.ttl', 'Enter your recovery key')),
          el('button.ghost', { onClick: () => close(null) }, '✕'),
        ),
        el('div.m-body',
          el('div', {
            style: { fontFamily: 'var(--sans)', fontSize: '13px',
                     color: 'var(--ink-dim)', lineHeight: '1.7', marginBottom: '12px' },
          },
            'This device is new. Paste the recovery key from your first login to decrypt prior messages. ',
            'You can skip and still see anything sent after this device joined.',
          ),
          input,
        ),
        el('div.m-foot',
          el('div'),
          el('div.actions', skipBtn, submitBtn),
        ),
      );

      const scrim = withScrim(modalRef);
      setTimeout(() => input.focus(), 30);
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        else if (e.key === 'Enter') close(input.value.trim() || null);
      }
      document.addEventListener('keydown', onKey);
      const removal = new MutationObserver(() => {
        if (!document.contains(scrim)) {
          document.removeEventListener('keydown', onKey);
          removal.disconnect();
        }
      });
      removal.observe(document.body, { childList: true });
    });
  }

  window.RecoveryUI = { display, ask };
})();
