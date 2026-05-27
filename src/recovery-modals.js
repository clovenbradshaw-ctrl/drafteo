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

  // ── Security panel ─────────────────────────────────────────────────
  // Status grid + actions for the recovery-key flow. Opened from the
  // "E2EE · …" pill in the header. Reads Store.getEncryptionStatus()
  // and offers a "Reset recovery key" affordance that rotates 4S +
  // key backup under a freshly generated recovery key.

  function statusRow(label, value, tone) {
    const colors = {
      ok:    'var(--ok, #6b9961)',
      warn:  'var(--warn, #c79042)',
      err:   'var(--err, #c75450)',
      muted: 'var(--ink-faint)',
    };
    return el('div', {
      style: {
        display: 'grid', gridTemplateColumns: '1fr auto',
        gap: '12px', padding: '8px 0',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--sans)', fontSize: '13px',
      },
    },
      el('span', { style: { color: 'var(--ink-dim)' } }, label),
      el('span', {
        style: {
          color: colors[tone] || colors.muted,
          fontFamily: 'var(--mono)', fontSize: '12px',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        },
      }, value),
    );
  }

  function panel() {
    return new Promise((resolve) => {
      const body = el('div.m-body');
      let scrim;
      const close = () => { scrim.remove(); resolve(); };

      function renderBody(status) {
        body.textContent = '';
        if (!status || !status.connected) {
          body.appendChild(el('div', {
            style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--ink-dim)' },
          }, 'Not signed in.'));
          return;
        }
        if (!status.cryptoReady) {
          body.appendChild(el('div', {
            style: { fontFamily: 'var(--sans)', fontSize: '13px', color: 'var(--warn)' },
          }, 'Encryption is still initialising. Wait a moment and reopen this panel.'));
          return;
        }

        const intro = el('div', {
          style: {
            fontFamily: 'var(--sans)', fontSize: '13px',
            color: 'var(--ink-dim)', lineHeight: '1.7', marginBottom: '12px',
          },
        },
          'Your data lives in end-to-end encrypted Matrix rooms. ',
          'A ',
          el('b', 'recovery key'),
          ' is what restores your drafts and history on a new browser or after clearing site data. ',
          'Without it, a cache wipe means historical messages stay encrypted forever.',
        );
        body.appendChild(intro);

        if (status.recoveryAckPending) {
          body.appendChild(el('div', {
            style: {
              border: '1px solid var(--warn)', background: 'rgba(199,144,66,0.08)',
              padding: '10px 12px', borderRadius: '4px', marginBottom: '12px',
              fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--warn)',
              lineHeight: '1.6',
            },
          },
            el('b', "Save your recovery key. "),
            'You generated one on first login but never confirmed it was saved. ',
            'If you can\'t find it, click ',
            el('b', 'Reset recovery key'),
            ' below to mint a new one.',
          ));
        }

        body.appendChild(statusRow(
          'Cross-signing',
          status.crossSigningReady ? 'Ready' : 'Not ready',
          status.crossSigningReady ? 'ok' : 'warn',
        ));
        body.appendChild(statusRow(
          'This device verified',
          status.deviceTrusted == null ? '—' : (status.deviceTrusted ? 'Yes' : 'No'),
          status.deviceTrusted == null ? 'muted' : (status.deviceTrusted ? 'ok' : 'warn'),
        ));
        body.appendChild(statusRow(
          'Key backup',
          status.backupActive
            ? ('Active · v' + status.backupVersion + (status.backupCount != null ? ' · ' + status.backupCount + ' sessions' : ''))
            : 'Off',
          status.backupActive ? 'ok' : 'err',
        ));
        body.appendChild(statusRow(
          'Backup key cached',
          status.backupKeyCached ? 'Yes' : 'No',
          status.backupKeyCached ? 'ok' : 'warn',
        ));

        const note = el('div', {
          style: {
            fontFamily: 'var(--mono)', fontSize: '10px',
            color: 'var(--ink-faint)', lineHeight: '1.7', marginTop: '14px',
          },
        });
        if (status.userMxid) note.appendChild(el('div', status.userMxid));
        if (status.deviceId) note.appendChild(el('div', 'Device · ' + status.deviceId));
        body.appendChild(note);
      }

      async function refresh() {
        let status = null;
        try { status = await window.Store.getEncryptionStatus(); }
        catch (e) { console.warn('[security] status failed', e); }
        renderBody(status);
      }

      const closeBtn = el('button.ghost', { onClick: close }, 'Close');
      const ackBtn = el('button.ghost', {
        onClick: () => { window.Store.acknowledgeRecoveryKey(); refresh(); },
      }, "I've saved my key");
      const resetBtn = el('button.primary', {
        onClick: async () => {
          resetBtn.disabled = true;
          const prevText = resetBtn.textContent;
          resetBtn.textContent = 'Rotating…';
          try {
            await window.Store.rotateRecoveryKey();
          } catch (e) {
            alert('Reset failed: ' + (e?.message || e));
          } finally {
            resetBtn.disabled = false;
            resetBtn.textContent = prevText;
            refresh();
          }
        },
      }, 'Reset recovery key');

      const modal = el('div.modal',
        { style: { width: 'min(560px, 96vw)' } },
        el('div.m-head',
          el('div', el('div.ttl', 'Encryption & recovery')),
          el('button.ghost', { onClick: close }, '✕'),
        ),
        body,
        el('div.m-foot',
          el('div'),
          el('div.actions', ackBtn, resetBtn, closeBtn),
        ),
      );

      scrim = withScrim(modal);
      refresh();
    });
  }

  window.RecoveryUI = { display, ask, panel };
})();
