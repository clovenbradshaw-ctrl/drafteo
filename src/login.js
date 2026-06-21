// ============ LOGIN VIEW ============

(function () {
  const { el, mount } = window.DOM;

  function render(root, onLoggedIn) {
    const u = el('input', { type: 'text', placeholder: '@you:hyphae.social', autocomplete: 'username' });
    const p = el('input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
    const h = el('input', { type: 'text', placeholder: 'https://hyphae.social', value: 'https://hyphae.social' });
    const hLabel = el('label', 'Homeserver');
    const hWrap = el('div.hsfield', { style: { display: 'none' } }, hLabel, h);
    const err = el('div', { style: { color: 'var(--err)', fontSize: '11px', marginTop: '10px', minHeight: '14px', fontFamily: 'var(--mono)' } });
    let busy = false;
    let hsManuallyToggled = false;

    const hsToggle = el('button.hslink', {
      type: 'button',
      onClick: (e) => {
        e.preventDefault();
        hsManuallyToggled = true;
        const showing = hWrap.style.display !== 'none';
        hWrap.style.display = showing ? 'none' : '';
        hsToggle.textContent = showing ? 'Use a different homeserver' : 'Use Hyphae (default)';
      },
    }, 'Use a different homeserver');

    // If the user types a full Matrix ID (@name:server), the homeserver is
    // implied — hide the homeserver field and just use the server part.
    function syncHomeserverVisibility() {
      const v = u.value.trim();
      const isFullMxid = /^@?[^:\s]+:[a-z0-9.-]+\.[a-z]{2,}/i.test(v);
      if (isFullMxid) {
        hWrap.style.display = 'none';
        hsToggle.style.display = 'none';
      } else {
        hsToggle.style.display = '';
        if (!hsManuallyToggled) hWrap.style.display = 'none';
      }
    }
    u.addEventListener('input', syncHomeserverVisibility);

    let stuckTimer = null;
    function showStuckHint() {
      resetWrap.style.display = '';
    }
    function hideStuckHint() {
      resetWrap.style.display = 'none';
      if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    }

    async function doLogin() {
      if (busy) return;
      err.textContent = '';
      busy = true;
      submit.textContent = 'CONNECTING…';
      submit.disabled = true;
      // If sign-in is still spinning after 20s, surface the reset
      // escape hatch — most legitimate logins complete well inside
      // that window, and a longer wait usually means a stale local
      // store has wedged the SDK.
      if (stuckTimer) clearTimeout(stuckTimer);
      stuckTimer = setTimeout(showStuckHint, 20000);
      try {
        // If user provided @name:server, pull the server out of the mxid.
        let user = u.value.trim();
        let homeserver = h.value.trim();
        const m = user.match(/^@?([^:\s]+):([a-z0-9.-]+\.[a-z]{2,})$/i);
        if (m) {
          user = m[1];
          homeserver = 'https://' + m[2];
        }
        const session = await Store.login(user, p.value, homeserver);
        hideStuckHint();
        onLoggedIn(session);
      } catch (e) {
        err.textContent = e.message || String(e);
        submit.textContent = 'SIGN IN';
        submit.disabled = false;
        busy = false;
        // Leave the reset link visible if it's already showing — a
        // real error after a long wait is exactly the case where the
        // user should still have one click to recover.
      }
    }

    const submit = el('button.primary', { type: 'submit', onClick: (e) => { e.preventDefault(); doLogin(); } }, 'SIGN IN');

    // Escape hatch for the "stuck on CONNECTING…" failure mode: a stale
    // crypto store / orphaned session in IndexedDB can wedge the SDK
    // mid-bootstrap. Store.wipeAll() clears every browser-side store
    // and reloads. Hidden until login has been spinning long enough
    // that something has likely gone wrong.
    const resetLink = el('a', {
      href: '#',
      style: { color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' },
      onClick: (e) => {
        e.preventDefault();
        if (!confirm('Reset local data and reload?\n\nThis clears the cached session and encryption keys on this device. Your messages on the server are not affected. You will need to sign in again (and enter your recovery key if prompted).')) return;
        try { window.Store.wipeAll(); }
        catch (err2) {
          console.error('[login] wipeAll failed', err2);
          try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
          location.reload();
        }
      },
    }, 'Reset local data');
    const resetWrap = el('div.reset-hint', {
      style: { display: 'none', marginTop: '10px', fontSize: '11px', color: 'var(--ink-faint)' },
    }, 'Sign-in is taking longer than usual. ', resetLink, ' to clear cached encryption state and try again.');

    const signupCta = el('a.signup-cta', {
      href: 'https://hyphae.social',
      target: '_blank',
      rel: 'noopener',
    },
      el('div.signup-cta-main',
        el('span.signup-cta-ttl', 'New here?'),
        el('span.signup-cta-sub', 'Create a free Hyphae account →'),
      ),
    );

    const form = el('form.loginform', {
      onSubmit: (e) => { e.preventDefault(); doLogin(); }
    },
      el('div.ttl',
        el('span', 'Sign in'),
        el('span', { style: { color: 'var(--ink-faint)' } }, 'Matrix'),
      ),
      signupCta,
      el('label', 'Username or full Matrix ID'),
      u,
      el('label', 'Password'),
      p,
      hWrap,
      hsToggle,
      el('div.actions', submit),
      err,
      resetWrap,
      el('div.hint',
        'Hyphae is the default homeserver. Already have a Matrix account on another server? ',
        el('a', { href: '#', onClick: (e) => { e.preventDefault(); hsManuallyToggled = true; hWrap.style.display = ''; hsToggle.textContent = 'Use Hyphae (default)'; h.focus(); }, style: { color: 'var(--accent)', textDecoration: 'underline' } }, 'Use it here'),
        '. Find more servers at ',
        el('a', { href: 'https://servers.joinmatrix.org/', target: '_blank', rel: 'noopener', style: { color: 'var(--accent)', textDecoration: 'underline' } }, 'servers.joinmatrix.org'),
        '.',
      ),
    );

    syncHomeserverVisibility();

    const view = el('div.login',
      el('div.left',
        el('div.logo',
          el('span.mark'),
          el('span', 'DraftEO')
        ),
        el('div',
          el('h1', 'Write in private. ', el('em', 'Publish'), ' the sources.'),
          el('div.blurb',
            'DraftEO is an end-to-end encrypted writing app built on Matrix. ',
            'Drafts, sources, and comments stay encrypted between you and the people you invite — your homeserver can\'t read them, and neither can we.',
          ),
          el('div.blurb', { style: { marginTop: '14px' } },
            'When a draft is ready, publish its sources to the Internet Archive in one click. ',
            'Every footnote becomes a permanent archive.org URL, so readers can verify every claim against the original document — forever.',
          ),
        ),
        el('div.meta',
          el('div', el('span.k', 'End-to-end encrypted'), 'Matrix · Megolm'),
          el('div', el('span.k', 'Permanent sources'), 'archive.org · CC-BY-4.0'),
        ),
      ),
      el('div.right', form),
    );

    mount(root, view);
    setTimeout(() => u.focus(), 50);
  }

  window.LoginView = { render };
})();
