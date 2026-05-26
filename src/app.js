// ============ APP ROUTER + THEME ============

(function () {
  const root = document.getElementById('root');

  const THEME_KEY = 'drafteo.theme';
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch (_) {}
    for (const btn of document.querySelectorAll('[data-theme-toggle] i')) {
      btn.className = 'ph ph-' + (t === 'light' ? 'sun' : 'moon-stars');
    }
  }
  function currentTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (_) {}
    if (t === 'light' || t === 'dark') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  const app = {
    toggleTheme() {
      const next = (document.documentElement.dataset.theme === 'light') ? 'dark' : 'light';
      applyTheme(next);
      // re-render whatever's mounted so themed icons refresh
      const session = window.Store.session();
      if (!session) { window.LoginView.render(root, () => app.openWorkspaceList()); return; }
      const state = currentRoute();
      if (state.route === 'workspace') app.openWorkspace(state.ws_id, state.doc_id);
      else app.openWorkspaceList();
    },
    openWorkspaceList() {
      route = { route: 'list' };
      window.WorkspaceView.render(root, app);
    },
    openWorkspace(ws_id, focus_doc_id) {
      route = { route: 'workspace', ws_id, doc_id: focus_doc_id || null };
      window.WorkspaceShell.render(ws_id, focus_doc_id || null, app);
    },
    openDocument(ws_id, doc_id) {
      app.openWorkspace(ws_id, doc_id);
    },
    async logout() {
      await window.Store.logout();
      start();
    },
  };

  let route = { route: 'list' };
  function currentRoute() { return route; }

  async function start() {
    // Standalone exhibit mini-page mode: when the URL hash carries an
    // encoded exhibit payload, hand the whole page over to the mini-page
    // renderer. Skips login + workspace boot so the link works for anyone
    // with the URL, even without a DraftEO session.
    if (window.ExhibitShare && window.ExhibitShare.takeOverIfExhibitHash()) return;

    applyTheme(currentTheme());
    // Wait for Matrix session restore + encrypted cache hydration before
    // deciding which view to render. Otherwise we'd flash the login
    // screen for users who already have a session.
    try { if (window.Store && window.Store.ready) await window.Store.ready(); } catch (_) {}
    if (window.Store.session()) {
      app.openWorkspaceList();
    } else {
      window.LoginView.render(root, () => app.openWorkspaceList());
    }
  }

  window.DraftEO = {
    wipeAll: () => { window.Store.wipeAll(); start(); },
    state: () => window.Store,
    app,
  };

  document.addEventListener('DOMContentLoaded', start);
  if (document.readyState !== 'loading') start();
})();
