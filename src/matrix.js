// ============ MATRIX CLIENT ============
// Thin wrapper around matrix-js-sdk that exposes a single shared
// MatrixClient with crypto enabled (Olm/Megolm). Everything in Store
// that hits the homeserver routes through here.
//
// Boot order:
//   1. Olm WASM is loaded (matrix-bootstrap.js).
//   2. On login or restore, we create a MatrixClient with the user's
//      access_token + device_id + homeserver, call await initCrypto(),
//      then await startClient() to begin /sync.
//   3. The client lives on window.MX.client. Store mutators await
//      window.MX.ready before touching it.
//
// "E2EE" means:
//   - Rooms are created with m.room.encryption = m.megolm.v1.aes-sha2.
//   - Timeline events (m.room.message, our edit log) get encrypted.
//   - For data that conceptually wants to live in state events (sources,
//     comments, snapshots, etc.) we publish them as encrypted timeline
//     events with a stable logical id; the local index keeps the latest
//     per id. Matrix state events are *not* encrypted, so we don't use
//     them for sensitive content.

import * as sdk from 'matrix-js-sdk';

const SESSION_KEY = 'drafteo.matrix.session';

const state = {
  client: null,
  ready: null,           // Promise that resolves once crypto+sync are up
  status: 'idle',        // idle | logging-in | syncing | ready | error | stopped
  syncedOnce: false,
  listeners: new Set(),
};

function emit(ev) { for (const fn of state.listeners) { try { fn(ev); } catch (e) { console.error(e); } } }
export function subscribe(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function writeSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) {}
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

export function getClient() { return state.client; }
export function getStatus() { return state.status; }
export function getSession() { return readSession(); }
export function isReady() { return state.status === 'ready'; }
export function getCryptoSelfTest() { return state.cryptoSelfTest || null; }

function normalizeHomeserver(hs) {
  if (!hs) return null;
  let s = String(hs).trim();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

async function discoverHomeserver(hs) {
  const base = normalizeHomeserver(hs);
  if (!base) throw new Error('Homeserver required.');
  try {
    const r = await fetch(base + '/.well-known/matrix/client');
    if (r.ok) {
      const j = await r.json();
      const wk = j && j['m.homeserver'] && j['m.homeserver'].base_url;
      if (wk) return normalizeHomeserver(wk);
    }
  } catch (_) {}
  return base;
}

// Olm's own wasm fetcher swallows the real cause and surfaces
// "both async and sync fetching of the wasm failed" — useless for
// debugging. We pre-fetch the bytes ourselves so any HTTP failure
// surfaces with the actual status + URL, and so a successful fetch
// short-circuits Olm's loader via the `wasmBinary` option.
let olmInitPromise = null;
async function ensureOlmInitialized() {
  if (olmInitPromise) return olmInitPromise;
  if (!globalThis.Olm || typeof globalThis.Olm.init !== 'function') {
    throw new Error('Olm module did not load. Reload the page; if this persists the JS bundle may be corrupted.');
  }
  const url = globalThis.__olmWasmUrl;
  olmInitPromise = (async () => {
    let wasmBinary;
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) {
        throw new Error('Could not load encryption module (olm.wasm) — server returned HTTP ' + r.status + ' for ' + url + '. The site may be partially deployed; try a hard reload.');
      }
      wasmBinary = await r.arrayBuffer();
    } catch (e) {
      if (e && /Could not load encryption module/.test(e.message)) throw e;
      throw new Error('Could not load encryption module (olm.wasm) from ' + url + ': ' + (e && e.message ? e.message : e));
    }
    await globalThis.Olm.init({ wasmBinary, locateFile: () => url });
  })().catch((e) => { olmInitPromise = null; throw e; });
  return olmInitPromise;
}

async function buildClient(session) {
  await ensureOlmInitialized();

  // Persist session + crypto state in IndexedDB so reloads don't have to
  // re-download history or regenerate Olm device keys (which would break
  // decryption of prior Megolm sessions).
  const idb = globalThis.indexedDB;
  let store, cryptoStore;
  if (idb) {
    try {
      store = new sdk.IndexedDBStore({ indexedDB: idb, dbName: 'drafteo-store' });
      await store.startup();
      cryptoStore = new sdk.IndexedDBCryptoStore(idb, 'drafteo-crypto');
    } catch (e) {
      console.warn('IndexedDB store init failed, falling back to memory', e);
      store = undefined;
      cryptoStore = undefined;
    }
  }

  const client = sdk.createClient({
    baseUrl: session.homeserver,
    accessToken: session.access_token,
    userId: session.matrix_id,
    deviceId: session.device_id,
    timelineSupport: true,
    store,
    cryptoStore,
  });

  // Initialize legacy crypto (Olm/Megolm). The Rust crypto path requires
  // an IndexedDB-backed store and a few more boot steps; legacy is good
  // enough for "actually E2EE" without that complexity today.
  if (typeof client.initCrypto === 'function') {
    await client.initCrypto();
  } else if (typeof client.initRustCrypto === 'function') {
    await client.initRustCrypto();
  }

  // Trust all devices by default so first messages aren't blocked by
  // unverified-device errors. The honest tradeoff: this lets MITM-via-
  // compromised-homeserver inject devices. Real verification UI is a
  // follow-up (Phase 3 in the rewrite plan).
  if (client.setGlobalErrorOnUnknownDevices) client.setGlobalErrorOnUnknownDevices(false);

  return client;
}

// Prove the Megolm round-trip works on this client. Creates an outbound
// + inbound group session, encrypts a known plaintext, decrypts it back,
// and verifies the result matches. Called once after login. The result
// surfaces on window.MX.cryptoSelfTest so the UI can show "verified".
function runMegolmSelfTest() {
  const Olm = globalThis.Olm;
  if (!Olm || !Olm.OutboundGroupSession) return { ok: false, reason: 'olm-unavailable' };
  let outbound, inbound;
  try {
    outbound = new Olm.OutboundGroupSession(); outbound.create();
    inbound = new Olm.InboundGroupSession(); inbound.create(outbound.session_key());
    const pt = 'drafteo-e2ee-selftest-' + Math.random().toString(36).slice(2);
    const ct = outbound.encrypt(pt);
    const out = inbound.decrypt(ct);
    return { ok: out.plaintext === pt, algorithm: 'm.megolm.v1.aes-sha2' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  } finally {
    try { outbound && outbound.free(); } catch (_) {}
    try { inbound && inbound.free(); } catch (_) {}
  }
}

async function startSync(client) {
  return new Promise((resolve, reject) => {
    const onSync = (s) => {
      if (s === 'PREPARED' || s === 'SYNCING') {
        state.syncedOnce = true;
        client.off('sync', onSync);
        resolve();
      } else if (s === 'ERROR') {
        // Don't reject — sync may recover. Log and let caller decide.
        console.warn('Matrix sync ERROR (continuing)');
      }
    };
    client.on('sync', onSync);
    client.startClient({ initialSyncLimit: 20 }).catch(reject);
  });
}

export async function loginWithPassword({ homeserver, username, password }) {
  if (!username || !password) throw new Error('Username and password required.');
  if (!homeserver) throw new Error('Homeserver required.');
  state.status = 'logging-in';
  emit({ type: 'status', status: state.status });

  const baseUrl = await discoverHomeserver(homeserver);

  // Use a temporary client to perform login so we get device_id + token.
  const tmp = sdk.createClient({ baseUrl });
  let resp;
  try {
    resp = await tmp.loginWithPassword(username, password);
  } catch (e) {
    state.status = 'error';
    emit({ type: 'status', status: state.status, error: e });
    const code = e && (e.errcode || e.data && e.data.errcode);
    if (code === 'M_FORBIDDEN') throw new Error('Wrong username or password.');
    if (code === 'M_USER_DEACTIVATED') throw new Error('This account has been deactivated.');
    if (code === 'M_LIMIT_EXCEEDED') throw new Error('Too many login attempts. Wait a minute and try again.');
    throw new Error((e && e.message) || 'Login failed.');
  }

  const session = {
    matrix_id: resp.user_id,
    display_name: username,
    homeserver: baseUrl,
    device_id: resp.device_id,
    access_token: resp.access_token,
    logged_in_at: new Date().toISOString(),
  };
  writeSession(session);

  await bringUpClient(session);
  return session;
}

async function bringUpClient(session) {
  state.status = 'syncing';
  emit({ type: 'status', status: state.status });
  const client = await buildClient(session);
  state.client = client;
  state.cryptoSelfTest = runMegolmSelfTest();
  if (!state.cryptoSelfTest.ok) {
    console.error('Megolm self-test FAILED', state.cryptoSelfTest);
  } else {
    console.info('Megolm self-test passed (' + state.cryptoSelfTest.algorithm + ')');
  }
  state.ready = startSync(client).then(() => {
    state.status = 'ready';
    emit({ type: 'status', status: state.status });
    emit({ type: 'ready' });
  }).catch((e) => {
    state.status = 'error';
    emit({ type: 'status', status: state.status, error: e });
    throw e;
  });
  await state.ready;
  return client;
}

export async function restoreSession() {
  const s = readSession();
  if (!s || !s.access_token) return null;
  try { await bringUpClient(s); return s; }
  catch (e) {
    console.warn('Matrix restore failed', e);
    state.status = 'error';
    return null;
  }
}

export async function logout() {
  if (state.client) {
    try { await state.client.logout(true); } catch (_) {}
    try { state.client.stopClient(); } catch (_) {}
    // Wipe IndexedDB crypto + sync stores so the next user on this
    // browser doesn't inherit our device keys / Megolm sessions.
    try { await state.client.clearStores(); } catch (_) {}
  }
  state.client = null;
  state.ready = null;
  state.status = 'stopped';
  clearSession();
  emit({ type: 'status', status: state.status });
}

export async function wipeAll() {
  await logout();
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('drafteo.')) localStorage.removeItem(k);
    }
  } catch (_) {}
}

// Ensure a room has encryption enabled. Idempotent — checks existing state.
export async function ensureEncryption(client, roomId) {
  try {
    const enc = client.getRoom(roomId)?.currentState?.getStateEvents('m.room.encryption', '');
    if (enc) return;
    await client.sendStateEvent(roomId, 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, '');
  } catch (e) {
    console.warn('ensureEncryption failed', e);
  }
}

// IMPORTANT: m.room.name and m.room.topic are state events, and Matrix
// never encrypts state events — the homeserver always sees them. To keep
// titles/descriptions out of server-visible cleartext, we DO NOT set them
// on the room. Drafteo's Store keeps its own copy in the AES-encrypted
// local cache (and, for cross-device sync, in encrypted timeline events).
// Other Matrix clients (Element, etc.) will show these rooms as unnamed —
// that's the price of not leaking titles.
export async function createEncryptedSpace() {
  const client = state.client;
  if (!client) throw new Error('Matrix client not ready.');
  const r = await client.createRoom({
    preset: 'private_chat',
    visibility: 'private',
    creation_content: { type: 'm.space' },
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'invited' } },
    ],
  });
  return r.room_id;
}

export async function createEncryptedRoom({ parentSpaceId } = {}) {
  const client = state.client;
  if (!client) throw new Error('Matrix client not ready.');
  const initial_state = [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'invited' } },
  ];
  if (parentSpaceId) {
    initial_state.push({
      type: 'm.space.parent',
      state_key: parentSpaceId,
      content: { canonical: true, via: [parentSpaceId.split(':').pop()] },
    });
  }
  const r = await client.createRoom({
    preset: 'private_chat',
    visibility: 'private',
    initial_state,
  });
  // Add the child to the space (best-effort).
  if (parentSpaceId) {
    try {
      const via = [parentSpaceId.split(':').pop()];
      await client.sendStateEvent(parentSpaceId, 'm.space.child', { via, suggested: false }, r.room_id);
    } catch (e) { console.warn('space.child failed', e); }
  }
  return r.room_id;
}

// Send an encrypted timeline event with our custom type.
export async function sendEncrypted(roomId, type, content) {
  const client = state.client;
  if (!client) throw new Error('Matrix client not ready.');
  return client.sendEvent(roomId, type, content);
}

// Upload a Blob/File to the homeserver media repo. Returns the mxc:// URI.
// NOTE: this writes the binary in plaintext to the homeserver — the bytes
// are NOT E2EE. Encrypting attachments (m.file scheme with AES-CTR key in
// the timeline event) is the right next step; for now the source meta
// IS encrypted in the timeline event, just not the binary.
export async function uploadMedia(blob, opts) {
  const client = state.client;
  if (!client) throw new Error('Matrix client not ready.');
  const res = await client.uploadContent(blob, {
    name: (opts && opts.name) || undefined,
    type: (opts && opts.type) || (blob && blob.type) || 'application/octet-stream',
    progressHandler: (opts && opts.progressHandler) || undefined,
  });
  return res && res.content_uri;
}

// Fetch a Matrix mxc:// binary as a Blob. Tries authenticated download
// first (Matrix 1.11+ requires it), falls back to legacy unauthenticated.
export async function downloadMedia(mxc) {
  const client = state.client;
  if (!client || !mxc || !mxc.startsWith('mxc://')) return null;
  // Try authenticated download URL first.
  let url = null;
  try { url = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, true, true, true); } catch (_) {}
  if (url) {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + client.getAccessToken() } });
      if (r.ok) return await r.blob();
    } catch (_) {}
  }
  // Legacy unauthenticated URL (older homeservers).
  let legacy = null;
  try { legacy = client.mxcUrlToHttp(mxc); } catch (_) {}
  if (legacy) {
    try {
      const r = await fetch(legacy);
      if (r.ok) return await r.blob();
    } catch (_) {}
  }
  return null;
}

// Read room timeline events of a given type, scanning back through paginated
// history so older events are available too. Best-effort: bail out quietly
// if pagination fails (e.g. peek not allowed).
export async function readTimelineHistory(roomId, type, opts) {
  const client = state.client;
  if (!client) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  const max = (opts && opts.maxPages) || 4;
  for (let i = 0; i < max; i++) {
    const tl = room.getLiveTimeline();
    try {
      const more = await client.paginateEventTimeline(tl, { backwards: true, limit: 100 });
      if (!more) break;
    } catch (_) { break; }
  }
  return readTimeline(roomId, type);
}

// Read all timeline events of a given type from a room. Uses the live
// timeline that's accumulated via sync; doesn't paginate backwards yet.
export function readTimeline(roomId, type) {
  const client = state.client;
  if (!client) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  const out = [];
  const tl = room.getLiveTimeline().getEvents();
  for (const ev of tl) {
    if (ev.getType() === type && !ev.isRedacted()) out.push(ev);
  }
  return out;
}

// List joined Spaces (workspaces).
export function listJoinedSpaces() {
  const client = state.client;
  if (!client) return [];
  return client.getRooms().filter((r) => {
    const create = r.currentState.getStateEvents('m.room.create', '');
    return create && create.getContent().type === 'm.space' && r.getMyMembership() === 'join';
  });
}

// List rooms that are children of a given space.
export function listSpaceChildren(spaceId) {
  const client = state.client;
  if (!client) return [];
  const space = client.getRoom(spaceId);
  if (!space) return [];
  const children = space.currentState.getStateEvents('m.space.child');
  const out = [];
  for (const ev of children) {
    const child = client.getRoom(ev.getStateKey());
    if (child && child.getMyMembership() === 'join') out.push(child);
  }
  return out;
}

// Convenience: invite a Matrix ID to a room.
export async function inviteUser(roomId, mxid) {
  const client = state.client;
  if (!client) throw new Error('Matrix client not ready.');
  return client.invite(roomId, mxid);
}

// Convenience: leave/forget a room.
export async function leaveRoom(roomId) {
  const client = state.client;
  if (!client) throw new Error('Matrix client not ready.');
  try { await client.leave(roomId); } catch (_) {}
  try { await client.forget(roomId); } catch (_) {}
}

// Subscribe to NEW encrypted timeline events of a given type on a room.
// Returns an unsubscribe fn. Fires whenever a fresh (live) event of the
// matching type arrives — typically because another member sent it.
// Encrypted events arrive twice: once as the `m.room.encrypted` shell on
// `Room.timeline`, then again on `Event.decrypted` once the cleartext is
// available. We listen to both so the cleartext-typed match still fires.
export function subscribeRoomEvents(roomId, type, handler) {
  const client = state.client;
  if (!client) return () => {};
  const seen = new WeakSet();
  function dispatch(event, room) {
    if (!room || room.roomId !== roomId) return;
    if (event.getType() !== type) return;
    if (event.isRedacted()) return;
    if (seen.has(event)) return;
    seen.add(event);
    handler(event);
  }
  const onTimeline = (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return; // backfill — not a live event
    dispatch(event, room);
  };
  const onDecrypted = (event) => {
    const room = client.getRoom(event.getRoomId());
    dispatch(event, room);
  };
  client.on('Room.timeline', onTimeline);
  client.on('Event.decrypted', onDecrypted);
  return () => {
    try { client.removeListener('Room.timeline', onTimeline); } catch (_) {}
    try { client.removeListener('Event.decrypted', onDecrypted); } catch (_) {}
  };
}

window.MX = {
  loginWithPassword, restoreSession, logout, wipeAll,
  getClient, getStatus, getSession, isReady, subscribe,
  getCryptoSelfTest,
  createEncryptedSpace, createEncryptedRoom, sendEncrypted, readTimeline,
  readTimelineHistory, subscribeRoomEvents,
  uploadMedia, downloadMedia,
  listJoinedSpaces, listSpaceChildren,
  inviteUser, leaveRoom, ensureEncryption,
};
