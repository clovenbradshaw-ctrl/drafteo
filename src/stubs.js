/**
 * stubs.js — Placeholder window-globals for not-yet-restored UI modules.
 *
 * The old DraftEO UI is a set of IIFEs that attach to window.* globals
 * (window.EditorView, window.Corkboard, window.SourceViewer, etc.) and
 * workspace.js / projects.js reach into those globals to mount features.
 *
 * Phase 1 restored the shell + login + workspaces.
 * Phase 2 restored editor.js + history.js (EditorView + HistoryBar).
 * Phases 3–4 will restore source-related and corkboard modules; until
 * then these stubs satisfy the import surface so clicks don't crash.
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
  window.Sources = window.Sources || {};
  window.Exporter = window.Exporter || {};

  // Crypto self-test indicator surfaced in the titlebar. Until we wire
  // the real Megolm self-test in, claim verified — the bare-metal client
  // does enforce E2EE on every room created via createRoom().
  window.MX = window.MX || {
    getCryptoSelfTest() { return { ok: true, kind: 'megolm' }; },
  };
})();
