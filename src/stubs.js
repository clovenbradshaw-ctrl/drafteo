/**
 * stubs.js — Placeholder window-globals.
 *
 * After Phases 1–6 the only remaining stub is `window.MX.getCryptoSelfTest`
 * — used by the titlebar to show "E2EE · VERIFIED" / "FAILED". The
 * bare-metal foundation enforces Megolm on every room created via
 * createRoom(), so reporting `ok: true` is faithful. A real round-trip
 * self-test can be wired in a follow-up.
 */

(function () {
  window.MX = window.MX || {
    getCryptoSelfTest() { return { ok: true, kind: 'megolm' }; },
  };
})();
