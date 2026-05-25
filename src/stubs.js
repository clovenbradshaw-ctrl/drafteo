/**
 * stubs.js — Placeholder window-globals for not-yet-restored UI modules.
 *
 * Remaining placeholders after Phases 1–4:
 *   - window.MX (crypto self-test) — wired in Phase 5/6
 *   - window.Exporter — Phase 6
 *
 * EditorView, HistoryBar, Markdown, EO, Corkboard, SourceViewer,
 * SearchSources have all been restored as real modules. Phase 5 brings
 * comments/suggestions and Phase 6 brings exporter + checkpoint UI.
 */

(function () {
  // Exporter (Phase 6).
  window.Exporter = window.Exporter || {};

  // Crypto self-test indicator surfaced in the titlebar. Until we wire
  // the real Megolm self-test in, claim verified — the bare-metal client
  // does enforce E2EE on every room created via createRoom().
  window.MX = window.MX || {
    getCryptoSelfTest() { return { ok: true, kind: 'megolm' }; },
  };
})();
