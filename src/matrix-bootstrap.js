// Pulls Olm into the bundle and exposes it on globalThis so matrix-js-sdk's
// crypto layer can pick it up. Vite ships the .wasm as a fingerprinted
// asset; the URL gets resolved at build time and Olm.init() is told where
// to find it via locateFile.

import Olm from '@matrix-org/olm';
import olmWasmUrl from '@matrix-org/olm/olm.wasm?url';

globalThis.Olm = Olm;
globalThis.__olmWasmUrl = olmWasmUrl;
