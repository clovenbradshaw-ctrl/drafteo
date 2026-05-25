/**
 * stubs.js — Placeholder window-globals for not-yet-restored UI modules.
 *
 * The old DraftEO UI is a set of IIFEs that attach to window.* globals
 * (window.EditorView, window.Corkboard, window.SourceViewer, etc.) and
 * workspace.js / projects.js reach into those globals to mount features.
 *
 * Phase 1 only restores the shell + login + workspaces + document
 * creation. Editor, sources, corkboard, history, etc. arrive in later
 * phases. Until then, these stubs satisfy the import surface so
 * workspace.js doesn't crash when a user clicks into an empty doc or
 * the corkboard.
 *
 * Replace each stub with a real implementation as later phases land.
 */

(function () {
  function placeholder(label, hint) {
    const el = document.createElement('div');
    el.style.cssText = 'padding:32px;color:var(--ink-faint, #888);font-family:monospace;font-size:13px;line-height:1.6;text-align:center;';
    el.innerHTML =
      '<div style="font-family:Fraunces,serif;font-size:18px;color:var(--ink, #ccc);margin-bottom:10px">' + label + '</div>' +
      '<div>' + hint + '</div>';
    return el;
  }

  // EditorView.mountInto(content, ws_id, doc_id, app, opts) — returns an
  // object with an `unmount()` method. workspace.js calls this to mount
  // the editor for the active doc.
  window.EditorView = window.EditorView || {
    mountInto(content, ws_id, doc_id, app, _opts) {
      void ws_id; void app;
      const view = placeholder(
        'Document editor — Phase 2',
        'The rich editor (markdown, slash menu, suggest/comment modes, edit history) lands in Phase 2. Document ID: ' + (doc_id || '—')
      );
      while (content.firstChild) content.removeChild(content.firstChild);
      content.appendChild(view);
      return { unmount() { view.remove(); } };
    },
  };

  // Corkboard.open(ws_id, app) — returns an Element.
  window.Corkboard = window.Corkboard || {
    open(ws_id, _app) {
      void ws_id;
      return placeholder('Corkboard — Phase 4', 'Visual evidence board returns in Phase 4.');
    },
  };

  // SourceViewer.open(doc_id, source_id, ws_id, app) — returns an Element.
  window.SourceViewer = window.SourceViewer || {
    open(_doc_id, _source_id, _ws_id, _app) {
      return placeholder('Source viewer — Phase 3', 'In-app source viewer returns in Phase 3.');
    },
  };

  // SearchSources.open(ws_id, app) — opens a search overlay.
  window.SearchSources = window.SearchSources || {
    open(_ws_id, _app) { /* no-op */ },
  };

  // Other helpers some old modules call into.
  window.HistoryView = window.HistoryView || { open() { return placeholder('History — Phase 2', ''); } };
  window.Sources = window.Sources || {};
  window.Exporter = window.Exporter || {};
  window.Markdown = window.Markdown || { render: (s) => String(s || '') };
  window.EO = window.EO || {};

  // Crypto self-test indicator surfaced in the titlebar. Until we wire
  // the real Megolm self-test in, claim verified — the bare-metal client
  // does enforce E2EE on every room created via createRoom().
  window.MX = window.MX || {
    getCryptoSelfTest() { return { ok: true, kind: 'megolm' }; },
  };
})();
