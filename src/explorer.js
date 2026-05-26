// ============ SOURCE EXPLORER (compat shim) ============
//
// The standalone modal explorer is gone. The Exhibits tab now hosts the
// browse/search/cite experience inline. This shim preserves the
// `window.SourceExplorer.open(ws_id, opts)` entry point so the editor
// cite picker, the Cmd-K shortcut, and the sidebar "Explore" button all
// just open the Exhibits tab (optionally focusing search or scrolling
// to a specific exhibit).

(function () {
  function open(ws_id, opts) {
    opts = opts || {};
    if (!ws_id) {
      if (window.DOM && window.DOM.toast) window.DOM.toast('NO WORKSPACE', 'Open a workspace first.');
      return;
    }
    if (typeof window.__openExhibitsTab === 'function') {
      window.__openExhibitsTab({
        sourceId: opts.sourceId || null,
        query: opts.initialQuery || opts.query || null,
        focusSearch: !opts.sourceId,
      });
      return;
    }
    // Workspace shell hasn't published the opener yet — try a soft retry.
    setTimeout(() => {
      if (typeof window.__openExhibitsTab === 'function') {
        window.__openExhibitsTab({
          sourceId: opts.sourceId || null,
          query: opts.initialQuery || opts.query || null,
          focusSearch: !opts.sourceId,
        });
      }
    }, 80);
  }

  window.SourceExplorer = { open };
})();
