/**
 * stubs.js — Last remaining window-globals + the live Megolm self-test.
 *
 * The crypto self-test runs an actual encrypt/decrypt round-trip
 * through matrix-encrypt-attachment (the same path source uploads use),
 * confirming the WebCrypto-backed pipeline is healthy. It also checks
 * that the foundation client has crypto initialized.
 *
 * Result is cached and updated whenever a session is established.
 */

import { encryptAttachment, decryptAttachment } from 'matrix-encrypt-attachment';
import { getClient } from './client.js';

let _cachedTest = null;

async function runRealSelfTest() {
  const plain = new TextEncoder().encode('DraftEO crypto self-test ' + Date.now());
  try {
    const { data, info } = await encryptAttachment(plain.buffer);
    const back = await decryptAttachment(data, info);
    const ok = back.byteLength === plain.byteLength &&
      new Uint8Array(back).every((b, i) => b === plain[i]);
    const cryptoEnabled = (() => {
      try {
        const c = getClient();
        return !!(c && (c.getCrypto?.() || c.isCryptoEnabled?.()));
      } catch { return false; }
    })();
    return {
      ok: ok && cryptoEnabled,
      algorithm: 'AES-CTR + SHA-256 (attachments) · Megolm (rooms)',
      attachment_roundtrip: ok,
      room_crypto: cryptoEnabled,
      checked_at: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), checked_at: Date.now() };
  }
}

(function () {
  window.MX = window.MX || {
    getCryptoSelfTest() {
      if (_cachedTest) return _cachedTest;
      // First call: optimistic placeholder while the async test runs.
      _cachedTest = { ok: false, pending: true, algorithm: 'pending' };
      runRealSelfTest().then((r) => {
        _cachedTest = r;
        try { window.dispatchEvent(new CustomEvent('drafteo:crypto-checked', { detail: r })); }
        catch (_) {}
      });
      return _cachedTest;
    },
    async refreshCryptoSelfTest() {
      _cachedTest = await runRealSelfTest();
      try { window.dispatchEvent(new CustomEvent('drafteo:crypto-checked', { detail: _cachedTest })); }
      catch (_) {}
      return _cachedTest;
    },
  };

  // Re-run after a login or session-restore — the bare-metal client
  // only becomes available then.
  window.addEventListener('drafteo:session-restored', () => window.MX.refreshCryptoSelfTest());
  window.addEventListener('drafteo:logged-in', () => window.MX.refreshCryptoSelfTest());
})();
