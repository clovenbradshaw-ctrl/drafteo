// Pulls Olm into the bundle and exposes it on globalThis so matrix-js-sdk's
// crypto layer can pick it up. Vite ships the .wasm as a fingerprinted
// asset; the URL gets resolved at build time and Olm.init() is told where
// to find it via locateFile.

// IMPORTANT: @matrix-org/olm's init() does an implicit-global assignment
// `OLM_OPTIONS = opts` which throws in strict-mode ES-module bundles
// unless a global of that name already exists. Pre-define it (with the
// correct locateFile baked in) so init() always succeeds.
import olmWasmUrl from '@matrix-org/olm/olm.wasm?url';
globalThis.__olmWasmUrl = olmWasmUrl;
globalThis.OLM_OPTIONS = { locateFile: () => olmWasmUrl };

import Olm from '@matrix-org/olm';
globalThis.Olm = Olm;
