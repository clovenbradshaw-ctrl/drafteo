// ============ STORE ============
// Local persistence mirroring Matrix state-event shapes. Each call is
// async-shaped so swapping in real mx.request() is mechanical.
//
// Matrix mapping:
//   Workspace          = parent Space (E2EE on by default for members-only rooms)
//   Document           = child room within workspace space
//   Membership         = m.room.member invites / joins (per workspace)
//   Doc body cache     = state event com.intelechia.drafteo.doc
//   Source             = state event com.intelechia.drafteo.source     (state_key = source_id)
//   Comment            = state event com.intelechia.drafteo.comment    (state_key = comment_id)
//   Suggestion         = state event com.intelechia.drafteo.suggestion (state_key = suggestion_id)
//   EO edit / restore  = timeline event com.intelechia.drafteo.edit    (append-only fold log)
//
// The body markdown is the fold of the EO edit log. The .doc state event
// is just a hydration cache and can always be rebuilt from the log.

(function () {
  // Persistence layer.
  //
  // Workspaces and documents have a real Matrix room as their identity —
  // workspaces are encrypted m.space rooms, documents are encrypted rooms
  // parented to that space. The room_id IS the workspace/document id.
  //
  // Everything else (sources, comments, suggestions, edit log, snapshots,
  // boards, holons, exhibits, media) is mirrored in an in-memory cache
  // that gets serialized as an AES-GCM ciphertext blob in localStorage.
  // The key is derived from the Matrix access_token via PBKDF2-SHA256
  // (200k iterations) with a per-install random salt. The access_token is
  // never persisted in plaintext into the encrypted blob; it lives in the
  // separate matrix-session entry under drafteo.matrix.session, which
  // matrix-js-sdk also needs to rehydrate the client.
  //
  // Threat model:
  //  - At rest on disk: ciphertext. Without the access_token, the blob
  //    is uncrackable on commodity hardware.
  //  - With the access_token: equivalent to Matrix itself — anyone with
  //    the token can act as the user against the homeserver, so giving
  //    them local cache too is the same security boundary.
  //  - Future multi-user collab: documents are real encrypted rooms, so
  //    Megolm-encrypted timeline events between members are the path
  //    (Phase 2). The local cache becomes a sync mirror.

  const KEY_ENC = 'drafteo.v1.enc';
  const KEY_LEGACY = 'drafteo.v1';
  const SALT_KEY = 'drafteo.cache.salt';

  function nowIso() { return new Date().toISOString(); }

  function blank() {
    return {
      session: null,
      space_id: null,
      workspaces: {},
      workspace_order: [],
      documents: {},
      doc_order: {},
      sources: {},
      comments: {},
      suggestions: {},
      editlog: {},
      snapshots: {},
      media: {},
    };
  }

  let state = blank();
  let cryptoKey = null;
  let bootDone = false;
  const bootWaiters = [];

  function b64enc(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64dec(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function getOrCreateSalt() {
    try {
      let s = localStorage.getItem(SALT_KEY);
      if (s) return b64dec(s);
    } catch (_) {}
    const salt = crypto.getRandomValues(new Uint8Array(16));
    try { localStorage.setItem(SALT_KEY, b64enc(salt)); } catch (_) {}
    return salt;
  }

  async function deriveKey(accessToken) {
    if (!accessToken || !crypto || !crypto.subtle) return null;
    const salt = getOrCreateSalt();
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(accessToken),
      'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  async function encryptBlob(obj) {
    if (!cryptoKey) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
    return b64enc(iv) + '.' + b64enc(new Uint8Array(ct));
  }

  async function decryptBlob(s) {
    if (!cryptoKey || !s) return null;
    const dot = s.indexOf('.');
    if (dot < 0) return null;
    try {
      const iv = b64dec(s.slice(0, dot));
      const ct = b64dec(s.slice(dot + 1));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) { return null; }
  }

  async function loadCache() {
    let raw = null;
    try { raw = localStorage.getItem(KEY_ENC); } catch (_) {}
    if (!raw) {
      // Migrate any pre-existing plaintext cache into the encrypted slot,
      // then drop it.
      try {
        const legacy = localStorage.getItem(KEY_LEGACY);
        if (legacy && cryptoKey) {
          const obj = JSON.parse(legacy);
          Object.assign(state, blank(), obj);
          await flushNow();
          localStorage.removeItem(KEY_LEGACY);
          return;
        }
      } catch (_) {}
      return;
    }
    const decoded = await decryptBlob(raw);
    if (decoded) Object.assign(state, blank(), decoded);
  }

  let pendingFlush = null;
  async function flushNow() {
    if (!cryptoKey) return;
    const blob = await encryptBlob(state);
    if (!blob) return;
    try { localStorage.setItem(KEY_ENC, blob); }
    catch (e) { console.warn('persist failed', e); }
  }
  function persist() {
    // Coalesce: schedule a single flush per microtask tick. Awaiting the
    // returned promise is optional — most callers just fire-and-forget.
    if (!cryptoKey) return Promise.resolve();
    if (pendingFlush) return pendingFlush;
    pendingFlush = Promise.resolve().then(async () => {
      try { await flushNow(); } finally { pendingFlush = null; }
    });
    return pendingFlush;
  }

  // ---- Boot: rehydrate Matrix session and load the encrypted cache ----
  async function bootstrap() {
    try {
      const sess = await (window.MX && window.MX.restoreSession ? window.MX.restoreSession() : null);
      if (sess) {
        state.session = sess;
        cryptoKey = await deriveKey(sess.access_token);
        await loadCache();
        // Pull the latest source state for every document room we know
        // about. Fires off in the background so boot isn't blocked by
        // network — the UI will refresh as events stream in.
        scheduleSourceHydration().catch((e) => console.warn('source hydration failed', e));
      }
    } catch (e) {
      console.warn('Store bootstrap failed', e);
    } finally {
      bootDone = true;
      while (bootWaiters.length) bootWaiters.shift()();
    }
  }

  // Watch each document room's timeline for fresh source events so other
  // members' updates appear without a reload. Idempotent per room.
  const _liveSubs = new Map();
  function watchRoomSources(doc_id) {
    if (_liveSubs.has(doc_id)) return;
    if (!window.MX || !window.MX.subscribeRoomEvents) return;
    const off = window.MX.subscribeRoomEvents(doc_id, 'com.intelechia.drafteo.source', (event) => {
      try {
        const content = event.getContent();
        if (!content || !content.source_id) return;
        applySourceEvent(doc_id, content);
        try { window.dispatchEvent(new CustomEvent('drafteo:sources-updated', { detail: { doc_id, source_id: content.source_id } })); } catch (_) {}
        persist();
      } catch (e) { console.warn('live source event failed', e); }
    });
    _liveSubs.set(doc_id, off);
  }

  // Apply a source event payload to the local index using latest-wins
  // semantics on (source_id, updated_at). Tombstones (deleted:true) drop
  // the local entry.
  function applySourceEvent(doc_id, content) {
    if (!content || !content.source_id) return;
    state.sources[doc_id] = state.sources[doc_id] || {};
    const existing = state.sources[doc_id][content.source_id];
    const incomingTs = content.updated_at || content.uploaded_at || '';
    if (existing) {
      const existingTs = existing.updated_at || existing.uploaded_at || '';
      if (existingTs && incomingTs && existingTs > incomingTs) return; // ours is newer
    }
    if (content.deleted) {
      delete state.sources[doc_id][content.source_id];
      return;
    }
    // Drop the matrix-event-specific marker; keep the rest.
    const meta = Object.assign({}, content);
    delete meta.deleted;
    state.sources[doc_id][content.source_id] = meta;
  }

  async function hydrateSourcesForRoom(doc_id) {
    if (!window.MX || !window.MX.isReady || !window.MX.isReady()) return;
    watchRoomSources(doc_id);
    let events = [];
    try {
      events = await window.MX.readTimelineHistory(doc_id, 'com.intelechia.drafteo.source', { maxPages: 2 });
    } catch (_) { return; }
    if (!events || events.length === 0) return;
    // Iterate oldest -> newest so applySourceEvent's latest-wins works.
    events.sort((a, b) => a.getTs() - b.getTs());
    let touched = false;
    for (const ev of events) {
      const c = ev.getContent();
      if (!c || !c.source_id) continue;
      applySourceEvent(doc_id, c);
      touched = true;
    }
    if (touched) {
      persist();
      try { window.dispatchEvent(new CustomEvent('drafteo:sources-updated', { detail: { doc_id } })); } catch (_) {}
    }
  }

  async function scheduleSourceHydration() {
    if (!window.MX || !window.MX.isReady) return;
    // Wait for sync to finish so room timelines are populated.
    const wait = async () => {
      for (let i = 0; i < 40; i++) {
        if (window.MX.isReady()) return true;
        await new Promise(r => setTimeout(r, 250));
      }
      return window.MX.isReady();
    };
    if (!(await wait())) return;
    const roomIds = Object.keys(state.documents || {});
    await Promise.all(roomIds.map(id => hydrateSourcesForRoom(id).catch(() => {})));
  }
  const bootPromise = bootstrap();
  function ready() { return bootDone ? Promise.resolve() : new Promise((r) => bootWaiters.push(r)); }

  function latency(ms) { return new Promise(r => setTimeout(r, ms || 60 + Math.random() * 100)); }
  function uuid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  // ============ SESSION ============
  // Real Matrix password login through matrix-js-sdk. After login, the
  // MatrixClient is up with Olm/Megolm crypto initialized and /sync
  // running. The cache encryption key gets derived from the access_token
  // immediately so that workspace/document mutations are persisted
  // through ciphertext from the first write.
  async function login(user, pass, homeserver) {
    if (!user || !pass) throw new Error('Username and password required.');
    if (!homeserver || !String(homeserver).trim()) {
      throw new Error('Homeserver required (e.g. https://hyphae.social).');
    }
    const cleanedUser = user.replace(/^@/, '').split(':')[0];
    const sess = await window.MX.loginWithPassword({
      homeserver, username: cleanedUser, password: pass,
    });
    state.session = sess;
    cryptoKey = await deriveKey(sess.access_token);
    await loadCache();
    await persist();
    return state.session;
  }
  function session() { return state.session; }
  async function logout() {
    state.session = null;
    cryptoKey = null;
    try { localStorage.removeItem(KEY_ENC); } catch (_) {}
    try { await window.MX.logout(); } catch (_) {}
    // Wipe in-memory state so a fresh login starts blank.
    Object.assign(state, blank());
  }

  // ============ WORKSPACES ============
  // A workspace IS an encrypted Matrix Space. The room_id returned by
  // createRoom becomes the workspace id — that way every consumer that
  // already keys on `ws.id` keeps working, and Phase 2 multi-user only
  // needs to start listening to room events.
  async function createWorkspace({ title, description }) {
    if (!state.session) throw new Error('Not logged in');
    const me = state.session.matrix_id;
    const id = await window.MX.createEncryptedSpace();
    state.workspaces[id] = {
      id,
      matrix_room_id: id,
      title: (title || 'Untitled workspace').trim(),
      description: (description || '').trim(),
      e2ee: true,
      owner: me,
      members: [{ matrix_id: me, role: 'owner', status: 'joined', joined_at: nowIso() }],
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.workspace_order.unshift(id);
    state.doc_order[id] = [];
    await persist();
    return state.workspaces[id];
  }
  async function updateWorkspace(id, patch) {
    if (!state.workspaces[id]) throw new Error('No workspace');
    Object.assign(state.workspaces[id], patch, { updated_at: nowIso() });
    // Title/description live only in the AES-encrypted local cache. We
    // deliberately do NOT mirror them to m.room.name/m.room.topic — those
    // are plaintext state events the homeserver can read.
    await persist();
    return state.workspaces[id];
  }
  async function deleteWorkspace(id) {
    try { await window.MX.leaveRoom(id); } catch (_) {}
    // Also leave child document rooms.
    for (const d of (state.doc_order[id] || [])) {
      try { await window.MX.leaveRoom(d); } catch (_) {}
      delete state.documents[d];
      delete state.sources[d];
      delete state.comments[d];
      delete state.suggestions[d];
      delete state.editlog[d];
      delete state.snapshots[d];
    }
    delete state.workspaces[id];
    state.workspace_order = state.workspace_order.filter(x => x !== id);
    delete state.doc_order[id];
    await persist();
  }
  function listWorkspaces() {
    return state.workspace_order.map(id => state.workspaces[id]).filter(Boolean);
  }
  function getWorkspace(id) { return state.workspaces[id]; }

  // ---- members / invites ----
  async function inviteMember(ws_id, matrix_id, role) {
    const ws = state.workspaces[ws_id];
    if (!ws) throw new Error('No workspace');
    const cleaned = normalizeMatrixId(matrix_id);
    if (!cleaned) throw new Error('Enter a Matrix ID like @user:hyphae.social');
    if (ws.members.find(m => m.matrix_id === cleaned)) throw new Error('Already a member.');
    // Real Matrix invite — homeserver will fail this if the user doesn't
    // exist or the inviter lacks permission, and we surface that.
    try { await window.MX.inviteUser(ws_id, cleaned); }
    catch (e) {
      const code = e && (e.errcode || (e.data && e.data.errcode));
      if (code === 'M_FORBIDDEN') throw new Error('Not allowed to invite to this workspace.');
      if (code === 'M_LIMIT_EXCEEDED') throw new Error('Too many invites. Wait a moment.');
      throw new Error('Invite failed: ' + ((e && e.message) || code || 'unknown'));
    }
    // Also invite to every existing document room so they can read drafts.
    for (const d of (state.doc_order[ws_id] || [])) {
      try { await window.MX.inviteUser(d, cleaned); } catch (_) {}
    }
    ws.members.push({ matrix_id: cleaned, role: role || 'editor', status: 'invited', invited_at: nowIso() });
    ws.updated_at = nowIso();
    await persist();
    return ws;
  }
  async function updateMember(ws_id, matrix_id, patch) {
    await latency();
    const ws = state.workspaces[ws_id];
    const m = ws && ws.members.find(x => x.matrix_id === matrix_id);
    if (!m) throw new Error('No member');
    Object.assign(m, patch);
    ws.updated_at = nowIso();
    persist();
    return m;
  }
  async function removeMember(ws_id, matrix_id) {
    await latency();
    const ws = state.workspaces[ws_id];
    if (!ws) return;
    ws.members = ws.members.filter(m => m.matrix_id !== matrix_id);
    ws.updated_at = nowIso();
    persist();
  }

  function normalizeMatrixId(s) {
    s = (s || '').trim();
    if (!s) return null;
    if (!s.startsWith('@')) s = '@' + s;
    if (!s.includes(':')) {
      const hs = (state.session && state.session.homeserver || 'hyphae.social').replace(/^https?:\/\//, '');
      s = s + ':' + hs;
    }
    if (!/^@[a-z0-9._-]+:[a-z0-9.-]+$/i.test(s)) return null;
    return s.toLowerCase();
  }

  // ============ DOCUMENTS ============
  // A document IS an encrypted Matrix room parented to the workspace
  // Space. We invite every joined workspace member to the room so
  // current members can read it via Megolm; future joiners get invited
  // automatically by inviteMember.
  async function createDocument(ws_id, { title, dek }) {
    if (!state.workspaces[ws_id]) throw new Error('No workspace');
    const ws = state.workspaces[ws_id];
    const id = await window.MX.createEncryptedRoom({ parentSpaceId: ws_id });
    // Invite existing workspace members (best-effort).
    for (const m of (ws.members || [])) {
      if (m.matrix_id !== state.session.matrix_id) {
        try { await window.MX.inviteUser(id, m.matrix_id); } catch (_) {}
      }
    }
    state.documents[id] = {
      id,
      workspace_id: ws_id,
      title: (title || 'Untitled draft').trim(),
      dek: (dek || '').trim(),
      body_markdown: '',
      version: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.doc_order[ws_id] = state.doc_order[ws_id] || [];
    state.doc_order[ws_id].unshift(id);
    state.sources[id] = {};
    state.comments[id] = {};
    state.suggestions[id] = {};
    state.snapshots[id] = { 1: '' };
    state.editlog[id] = [{
      id: 'e_' + uuid(),
      eo_operator: 'DEF',
      site: 'document',
      resolution: 'Draft created',
      version_from: 0,
      version_to: 1,
      timestamp: nowIso(),
      author: state.session.matrix_id,
    }];
    persist();
    // New room — start watching it for source events as they arrive.
    watchRoomSources(id);
    return state.documents[id];
  }

  async function saveDocument(doc_id, patch, editEntry) {
    await latency();
    const doc = state.documents[doc_id];
    if (!doc) throw new Error('No document');
    const version_from = doc.version;
    const next = Object.assign({}, doc, patch, { updated_at: nowIso(), version: version_from + 1 });
    state.documents[doc_id] = next;
    // snapshot body at this version for the scrubber preview
    state.snapshots[doc_id] = state.snapshots[doc_id] || {};
    state.snapshots[doc_id][next.version] = next.body_markdown || '';
    if (editEntry) {
      const entry = Object.assign({
        id: 'e_' + uuid(),
        version_from,
        version_to: next.version,
        timestamp: nowIso(),
        author: state.session.matrix_id,
      }, editEntry);
      state.editlog[doc_id] = state.editlog[doc_id] || [];
      state.editlog[doc_id].unshift(entry);
      // Mirror to Matrix as an encrypted timeline event so other members
      // see edits and the homeserver can never read them. Best-effort —
      // local mirror is the source of truth until full sync replay lands.
      try {
        if (window.MX && window.MX.isReady && window.MX.isReady()) {
          window.MX.sendEncrypted(doc_id, 'com.intelechia.drafteo.edit', entry).catch(() => {});
        }
      } catch (_) {}
    }
    persist();
    return next;
  }

  // Restore is itself a forward EO event of operator ROL — the log stays
  // append-only, so the restore is reversible by scrubbing past it again.
  async function restoreToVersion(doc_id, target_version) {
    const snap = state.snapshots[doc_id] && state.snapshots[doc_id][target_version];
    if (snap === undefined) throw new Error('No snapshot at v' + target_version);
    return saveDocument(doc_id, { body_markdown: snap }, {
      eo_operator: 'ROL',
      site: 'document',
      resolution: 'Restored to v' + target_version,
      restore_target: target_version,
    });
  }

  async function deleteDocument(doc_id) {
    const d = state.documents[doc_id];
    if (!d) return;
    const ws = d.workspace_id;
    try { await window.MX.leaveRoom(doc_id); } catch (_) {}
    delete state.documents[doc_id];
    delete state.sources[doc_id];
    delete state.comments[doc_id];
    delete state.suggestions[doc_id];
    delete state.editlog[doc_id];
    delete state.snapshots[doc_id];
    if (state.doc_order[ws]) state.doc_order[ws] = state.doc_order[ws].filter(x => x !== doc_id);
    await persist();
  }

  function listDocuments(ws_id) {
    return (state.doc_order[ws_id] || []).map(id => state.documents[id]).filter(Boolean);
  }
  function getDocument(id) { return state.documents[id]; }
  function getEditLog(doc_id) { return state.editlog[doc_id] || []; }
  function getSnapshot(doc_id, version) {
    return (state.snapshots[doc_id] || {})[version];
  }

  // ============ SOURCES ============
  // Push the canonical source meta into the document room as an encrypted
  // timeline event. Best-effort — local state is the source of truth until
  // Matrix re-delivers it; failures are logged but don't break local UX.
  async function publishSourceToMatrix(doc_id, meta) {
    try {
      if (!window.MX || !window.MX.isReady || !window.MX.isReady()) return;
      watchRoomSources(doc_id);
      // Strip any local-only blobs before sending.
      const payload = Object.assign({}, meta);
      delete payload.data_url;
      payload.updated_at = nowIso();
      await window.MX.sendEncrypted(doc_id, 'com.intelechia.drafteo.source', payload);
    } catch (e) { console.warn('publishSourceToMatrix failed', e); }
  }

  // Upload the binary to the homeserver media repo so other members /
  // devices can fetch it. Returns the real mxc URI on success, or null.
  async function uploadBinaryToMatrix(blob, opts) {
    try {
      if (!window.MX || !window.MX.isReady || !window.MX.isReady()) return null;
      return await window.MX.uploadMedia(blob, opts);
    } catch (e) { console.warn('uploadMedia failed', e); return null; }
  }

  async function uploadSource(doc_id, file, patch) {
    await latency(180 + Math.random() * 320);
    const data_url = await readFileAsDataURL(file);
    const source_id = 'src_' + uuid();
    // Try to push the binary to the homeserver. Fall back to a synthetic
    // mxc if the upload fails so local UX still works.
    const realMxc = await uploadBinaryToMatrix(file, { name: file.name, type: file.type });
    const mxc = realMxc || ('mxc://local/' + uuid());
    state.media[mxc] = { data_url, mime: file.type, filename: file.name };
    const meta = Object.assign({
      source_id,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      size_bytes: file.size,
      mxc_uri: mxc,
      title: file.name.replace(/\.[^.]+$/, ''),
      description: '',
      tags: [],
      uploaded_at: nowIso(),
      uploader: state.session && state.session.matrix_id,
      archive_org_url: null,
      archive_org_identifier: null,
      archived_at: null,
    }, patch || {});
    state.sources[doc_id] = state.sources[doc_id] || {};
    state.sources[doc_id][source_id] = meta;
    persist();
    publishSourceToMatrix(doc_id, meta);
    return meta;
  }
  async function updateSource(doc_id, source_id, patch) {
    await latency();
    const s = state.sources[doc_id] && state.sources[doc_id][source_id];
    if (!s) throw new Error('No source');
    Object.assign(s, patch, { updated_at: nowIso() });
    persist();
    publishSourceToMatrix(doc_id, s);
    return s;
  }
  async function deleteSource(doc_id, source_id) {
    await latency();
    if (state.sources[doc_id]) delete state.sources[doc_id][source_id];
    persist();
    // Tombstone so other members/devices drop the source too.
    try {
      if (window.MX && window.MX.isReady && window.MX.isReady()) {
        await window.MX.sendEncrypted(doc_id, 'com.intelechia.drafteo.source', {
          source_id, deleted: true, updated_at: nowIso(),
        });
      }
    } catch (e) { console.warn('deleteSource matrix push failed', e); }
  }
  // Soft-hide an archived source from the main list (can't truly delete —
  // archive.org is permanent — but we can hide it locally).
  async function hideSource(doc_id, source_id, hidden) {
    await latency();
    const s = state.sources[doc_id] && state.sources[doc_id][source_id];
    if (!s) return;
    s.hidden = !!hidden;
    s.updated_at = nowIso();
    persist();
    publishSourceToMatrix(doc_id, s);
    return s;
  }
  function listSources(doc_id, opts) {
    const m = state.sources[doc_id] || {};
    let arr = Object.values(m);
    if (!opts || !opts.includeHidden) arr = arr.filter(s => !s.hidden);
    // Newest first.
    return arr.sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
  }
  function listHiddenSources(doc_id) {
    const m = state.sources[doc_id] || {};
    return Object.values(m).filter(s => s.hidden).sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
  }
  function getSource(doc_id, source_id) {
    return (state.sources[doc_id] || {})[source_id];
  }

  // Import a web page via the n8n feed proxy. Fetches, sanitises, and
  // stores the cleaned HTML as a source — same shape as a file upload
  // but with extra `source_url` / `snapshot_at` metadata.
  async function importFromUrl(doc_id, url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http(s)://');
    const proxyUrl = 'https://n8n.intelechia.com/webhook/feed?url=' + encodeURIComponent(url);
    let raw;
    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error('Proxy returned ' + res.status);
      raw = await res.text();
    } catch (e) {
      throw new Error('Fetch failed: ' + (e.message || e));
    }
    const snap = sanitiseHtml(raw, url);
    const source_id = 'src_' + uuid();
    const htmlBlob = new Blob([snap.html], { type: 'text/html' });
    const realMxc = await uploadBinaryToMatrix(htmlBlob, { name: snap.filename, type: 'text/html' });
    const mxc = realMxc || ('mxc://local/' + uuid());
    state.media[mxc] = { data_url: 'data:text/html;base64,' + btoa(unescape(encodeURIComponent(snap.html))), mime: 'text/html', filename: snap.filename };
    const meta = {
      source_id,
      filename: snap.filename,
      mime: 'text/html',
      size_bytes: htmlBlob.size,
      mxc_uri: mxc,
      title: snap.title,
      description: 'Web snapshot of ' + url,
      tags: ['web-snapshot'],
      source_url: url,
      snapshot_at: nowIso(),
      plaintext: snap.plaintext.slice(0, 200000),
      uploaded_at: nowIso(),
      uploader: state.session && state.session.matrix_id,
      archive_org_url: null,
      archive_org_identifier: null,
      archived_at: null,
    };
    state.sources[doc_id] = state.sources[doc_id] || {};
    state.sources[doc_id][source_id] = meta;
    persist();
    publishSourceToMatrix(doc_id, meta);
    return meta;
  }

  function sanitiseHtml(rawHtml, sourceUrl) {
    let doc;
    try {
      const parser = new DOMParser();
      doc = parser.parseFromString(rawHtml, 'text/html');
    } catch (_) {
      return { html: '<html><body><pre>' + rawHtml.replace(/</g, '&lt;') + '</pre></body></html>', title: sourceUrl, filename: filenameFromUrl(sourceUrl), plaintext: rawHtml };
    }
    // strip dangerous nodes
    doc.querySelectorAll('script, iframe, noscript, object, embed, link[rel="preload"][as="script"]').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(node => {
      for (const a of [...node.attributes]) {
        if (a.name.startsWith('on')) node.removeAttribute(a.name);
        if (a.name === 'srcset') node.removeAttribute(a.name);
      }
    });
    // resolve relative urls
    let base;
    try { base = new URL(sourceUrl); } catch (_) { base = null; }
    if (base) {
      doc.querySelectorAll('[href]').forEach(n => { try { n.setAttribute('href', new URL(n.getAttribute('href'), base).href); } catch (_) {} });
      doc.querySelectorAll('[src]').forEach(n => { try { n.setAttribute('src', new URL(n.getAttribute('src'), base).href); } catch (_) {} });
      const baseTag = doc.createElement('base'); baseTag.href = base.origin + '/'; doc.head && doc.head.prepend(baseTag);
    }
    const title = (doc.querySelector('title') && doc.querySelector('title').textContent.trim()) || sourceUrl;
    const html = '<!doctype html>\n<!-- Snapshot captured ' + nowIso() + ' from ' + sourceUrl + ' by DraftEO -->\n' + doc.documentElement.outerHTML;
    // Try to pull the readable text — prefer <article>/<main>, strip nav/aside/footer chrome.
    let plaintextRoot = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    if (plaintextRoot && plaintextRoot !== doc.body) {
      // good — use the cleaner subtree
    } else if (doc.body) {
      const clone = doc.body.cloneNode(true);
      clone.querySelectorAll('nav, header, footer, aside, form, button, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]').forEach(n => n.remove());
      plaintextRoot = clone;
    }
    const rawText = (plaintextRoot && (plaintextRoot.innerText || plaintextRoot.textContent) || '').trim();
    // Collapse runs of whitespace/blank lines.
    const plaintext = rawText
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .reduce((acc, line) => {
        if (acc.length && acc[acc.length - 1] === line) return acc; // de-dup consecutive
        acc.push(line);
        return acc;
      }, [])
      .join('\n');
    return { html, title, plaintext, filename: filenameFromUrl(sourceUrl) };
  }

  function filenameFromUrl(url) {
    try {
      const u = new URL(url);
      const slug = (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80) || 'webpage';
      return slug + '.html';
    } catch (_) { return 'webpage.html'; }
  }

  // ---- stages + checkpoints ----
  const STAGES = ['drafting', 'reporting', 'editing', 'ready', 'published'];

  async function setStage(doc_id, stage) {
    await latency();
    const doc = state.documents[doc_id];
    if (!doc) throw new Error('No document');
    const prev = doc.stage || 'drafting';
    doc.stage = stage;
    doc.updated_at = nowIso();
    state.editlog[doc_id] = state.editlog[doc_id] || [];
    state.editlog[doc_id].unshift({
      id: 'e_' + uuid(),
      eo_operator: 'DEF',
      site: 'stage',
      resolution: 'Stage: ' + prev + ' → ' + stage,
      version_from: doc.version, version_to: doc.version,
      timestamp: nowIso(),
      author: state.session && state.session.matrix_id,
      stage_change: { from: prev, to: stage },
    });
    persist();
    return doc;
  }

  async function createCheckpoint(doc_id, name) {
    await latency();
    const doc = state.documents[doc_id];
    if (!doc) throw new Error('No document');
    state.checkpoints = state.checkpoints || {};
    state.checkpoints[doc_id] = state.checkpoints[doc_id] || [];
    const ck = {
      id: 'ck_' + uuid(),
      name: (name || 'Untitled checkpoint').trim(),
      version: doc.version,
      created_at: nowIso(),
      author: state.session && state.session.matrix_id,
    };
    state.checkpoints[doc_id].unshift(ck);
    state.editlog[doc_id] = state.editlog[doc_id] || [];
    state.editlog[doc_id].unshift({
      id: 'e_' + uuid(),
      eo_operator: 'DEF',
      site: 'checkpoint',
      resolution: '⭐ Checkpoint: ' + ck.name,
      version_from: doc.version, version_to: doc.version,
      timestamp: ck.created_at,
      author: ck.author,
      checkpoint_id: ck.id,
    });
    persist();
    return ck;
  }

  async function renameCheckpoint(doc_id, ck_id, name) {
    await latency();
    const list = (state.checkpoints && state.checkpoints[doc_id]) || [];
    const ck = list.find(c => c.id === ck_id);
    if (!ck) throw new Error('No checkpoint');
    ck.name = name.trim() || ck.name;
    persist();
    return ck;
  }

  async function deleteCheckpoint(doc_id, ck_id) {
    await latency();
    if (state.checkpoints && state.checkpoints[doc_id]) {
      state.checkpoints[doc_id] = state.checkpoints[doc_id].filter(c => c.id !== ck_id);
      persist();
    }
  }

  function listCheckpoints(doc_id) {
    return (state.checkpoints && state.checkpoints[doc_id]) || [];
  }

  // Archive flow — uploads to the real archive-upload webhook.
  // Endpoint: https://n8n.intelechia.com/webhook/archive-upload
  // n8n receives the binary + metadata, PUTs to s3.us.archive.org, and
  // returns the real archive.org URL. We DO NOT fake a URL — if the call
  // fails or the response is missing a URL, the source stays unarchived
  // and the UI surfaces the error.
  // The PROVeo endpoint is the general-purpose one (any mime, validates
  // consent, returns the real archive.org URL). archive-upload hardcodes
  // video mediatype so it only works for movies.
  const ARCHIVE_URL = 'https://n8n.intelechia.com/webhook/archiveo';
  // Archive a source. onProgress is called repeatedly with
  // { stage, pct, sent, total, label } as the upload and remote-processing
  // phases advance. Stages: 'preparing' | 'uploading' | 'processing' | 'done'.
  async function archiveSource(doc_id, source_id, onProgress) {
    const s = state.sources[doc_id] && state.sources[doc_id][source_id];
    if (!s) throw new Error('No source');
    let media = state.media[s.mxc_uri];
    if (!media && s.mxc_uri && s.mxc_uri.startsWith('mxc://') && !s.mxc_uri.startsWith('mxc://local/')) {
      // Cold cache (e.g. on another device): pull the binary down from
      // the homeserver before we try to archive it.
      await _hydrateMediaFromMatrix(s.mxc_uri);
      media = state.media[s.mxc_uri];
    }
    if (!media) throw new Error('Source binary missing from media store.');
    const prog = typeof onProgress === 'function' ? onProgress : () => {};

    prog({ stage: 'preparing', pct: 0, label: 'Preparing binary…' });
    const blob = await dataUrlToBlob(media.data_url, s.mime);

    const fd = new FormData();
    fd.append('data', blob, asciiSafe(s.filename));
    let kind = 'source';
    if (s.source_url) kind = 'document';
    else if (s.mime && (s.mime.startsWith('video/') || s.mime.startsWith('audio/') || s.mime.startsWith('image/'))) kind = 'media';
    else if (s.mime && (s.mime.includes('csv') || s.mime.includes('json') || s.mime === 'application/x-ndjson')) kind = 'dataset';
    else if (s.mime && (s.mime === 'application/pdf' || s.mime.startsWith('text/') || s.mime.includes('officedocument'))) kind = 'document';
    fd.append('kind', kind);
    fd.append('mime', s.mime);
    fd.append('filename', asciiSafe(s.filename));
    fd.append('title', asciiSafe(s.title || s.filename));
    fd.append('description', asciiSafe(s.description || (s.source_url ? 'Web snapshot of ' + s.source_url : '')));
    fd.append('license', 'CC-BY-4.0');
    fd.append('consent_acknowledged', 'permanence');
    fd.append('consent_acknowledged', 'privacy');
    fd.append('consent_acknowledged', 'rights');
    if (s.tags && s.tags.length) fd.append('tags', s.tags.join(';'));
    if (s.source_url) fd.append('parent_identifier', s.source_url);

    // XHR so we get real upload progress events (fetch can't).
    const { status, raw } = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ARCHIVE_URL);
      let uploadDone = false;
      let waitTimer = null;
      let waitStart = 0;
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
          prog({ stage: 'uploading', pct, sent: e.loaded, total: e.total, label: 'Uploading to archive.org…' });
        } else {
          prog({ stage: 'uploading', pct: 0, label: 'Uploading to archive.org…' });
        }
      });
      xhr.upload.addEventListener('load', () => {
        uploadDone = true;
        waitStart = Date.now();
        prog({ stage: 'processing', pct: 0, label: 'Archive.org is processing the file…' });
        // Synthetic progress while we wait for the webhook response.
        // We don't know the real ETA, so creep an estimated bar up to ~95%.
        waitTimer = setInterval(() => {
          const elapsed = (Date.now() - waitStart) / 1000;
          // ~25s expected -> reach 90% around there, then plateau.
          const pct = Math.min(95, Math.round((1 - Math.exp(-elapsed / 12)) * 95));
          prog({ stage: 'processing', pct, label: 'Archive.org is processing the file…' });
        }, 400);
      });
      xhr.addEventListener('load', () => {
        if (waitTimer) clearInterval(waitTimer);
        resolve({ status: xhr.status, raw: xhr.responseText || '' });
      });
      xhr.addEventListener('error', () => {
        if (waitTimer) clearInterval(waitTimer);
        reject(new Error('Could not reach archive endpoint.'));
      });
      xhr.addEventListener('abort', () => {
        if (waitTimer) clearInterval(waitTimer);
        reject(new Error('Archive request aborted.'));
      });
      xhr.send(fd);
    });

    let result = null;
    try { result = raw ? JSON.parse(raw) : null; } catch (_) {}

    if (status < 200 || status >= 300) {
      const msg = (result && (result.errors || result.error || result.message)) || ('HTTP ' + status + (raw ? ' · ' + raw.slice(0, 160) : ''));
      throw new Error(Array.isArray(msg) ? msg.join(', ') : msg);
    }
    if (!result || result.success === false) {
      const msg = (result && (result.errors || result.error)) || 'Archive endpoint returned no payload.';
      throw new Error(Array.isArray(msg) ? msg.join(', ') : msg);
    }

    const archive = result.archive || result;
    const ident = archive.identifier;
    const url = archive.url;
    if (!ident || !url) {
      throw new Error('Archive response missing identifier/url.');
    }
    s.archive_org_identifier = ident;
    s.archive_org_url = url;
    s.archive_org_filename = archive.filename || s.filename;
    s.archived_at = nowIso();
    persist();
    prog({ stage: 'done', pct: 100, label: 'Archived ✓' });
    // Broadcast so open source viewers re-render their headers/badges.
    try {
      window.dispatchEvent(new CustomEvent('drafteo:source-archived', {
        detail: { doc_id, source_id, archive_org_url: url, archive_org_identifier: ident }
      }));
    } catch (_) {}
    return s;
  }

  async function dataUrlToBlob(dataUrl, mime) {
    const r = await fetch(dataUrl);
    return await r.blob();
  }

  // n8n writes these fields into archive.org S3 headers, which reject any
  // non-ASCII byte. Replace common Unicode punctuation, then strip the rest.
  function asciiSafe(s) {
    if (!s) return '';
    return String(s)
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2013\u2014\u2015]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u0000-\u001F\u007F-\uFFFF]/g, '')
      .trim();
  }

  function getMedia(mxc) {
    if (!mxc) return null;
    const cached = state.media[mxc];
    if (cached) return cached;
    // Not in local cache — kick off an async fetch from the homeserver
    // (only if it's a real mxc, not our local synthetic one). We return
    // null right now; once the fetch completes, the source viewer will
    // re-render via the `drafteo:media-cached` event and pick up the blob.
    if (mxc.startsWith('mxc://') && !mxc.startsWith('mxc://local/')) {
      _hydrateMediaFromMatrix(mxc);
    }
    return null;
  }

  const _mediaFetching = new Set();
  async function _hydrateMediaFromMatrix(mxc) {
    if (_mediaFetching.has(mxc)) return;
    if (!window.MX || !window.MX.downloadMedia) return;
    _mediaFetching.add(mxc);
    try {
      const blob = await window.MX.downloadMedia(mxc);
      if (!blob) return;
      const data_url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      state.media[mxc] = { data_url, mime: blob.type, filename: '' };
      persist();
      try { window.dispatchEvent(new CustomEvent('drafteo:media-cached', { detail: { mxc } })); } catch (_) {}
    } catch (e) {
      console.warn('media hydration failed', mxc, e);
    } finally {
      _mediaFetching.delete(mxc);
    }
  }

  // ============ COMMENTS ============
  async function createComment(doc_id, { anchor_id, quote, body }) {
    await latency();
    const me = state.session.matrix_id;
    const id = 'cmt_' + uuid();
    const c = {
      id, anchor_id, quote: quote || '',
      thread: [{ author: me, body, ts: nowIso() }],
      resolved: false,
      created_at: nowIso(),
    };
    state.comments[doc_id] = state.comments[doc_id] || {};
    state.comments[doc_id][id] = c;
    persist();
    return c;
  }
  async function replyComment(doc_id, comment_id, body) {
    await latency();
    const c = state.comments[doc_id] && state.comments[doc_id][comment_id];
    if (!c) throw new Error('No comment');
    c.thread.push({ author: state.session.matrix_id, body, ts: nowIso() });
    persist();
    return c;
  }
  async function resolveComment(doc_id, comment_id, resolved) {
    await latency();
    const c = state.comments[doc_id] && state.comments[doc_id][comment_id];
    if (!c) throw new Error('No comment');
    c.resolved = !!resolved;
    persist();
    return c;
  }
  function listComments(doc_id) {
    return Object.values(state.comments[doc_id] || {});
  }

  // ============ SUGGESTIONS ============
  async function createSuggestion(doc_id, { anchor_id, original, proposed, note }) {
    await latency();
    const me = state.session.matrix_id;
    const id = 'sug_' + uuid();
    const s = {
      id, anchor_id,
      original: original || '',
      proposed: proposed || '',
      note: note || '',
      author: me,
      status: 'pending',
      created_at: nowIso(),
    };
    state.suggestions[doc_id] = state.suggestions[doc_id] || {};
    state.suggestions[doc_id][id] = s;
    persist();
    return s;
  }
  async function updateSuggestion(doc_id, sug_id, patch) {
    await latency();
    const s = state.suggestions[doc_id] && state.suggestions[doc_id][sug_id];
    if (!s) throw new Error('No suggestion');
    Object.assign(s, patch);
    persist();
    return s;
  }
  function listSuggestions(doc_id) {
    return Object.values(state.suggestions[doc_id] || {});
  }

  // ============ MEDIA helpers ============
  function readFileAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // ============ CITATION VIEWER URL ============
  // Builds the inline-citation hyperlink the reader follows. Points at the
  // GitHub Pages mini-viewer that renders the source from archive.org with
  // the cited span highlighted.
  const VIEWER_BASE = 'https://clovenbradshaw-ctrl.github.io/drafteo/view.html';
  function buildCitationUrl(source, footnote) {
    if (!source) return '';
    if (source.archive_org_identifier) {
      const params = new URLSearchParams();
      params.set('src', source.archive_org_identifier);
      if (source.filename) params.set('file', source.filename);
      if (source.mime) params.set('type', mimeKind(source.mime));
      if (footnote && footnote.page) params.set('page', footnote.page);
      if (footnote && footnote.supporting_quote) params.set('q', footnote.supporting_quote);
      if (footnote && footnote.note) params.set('note', footnote.note);
      return VIEWER_BASE + '#' + params.toString().replace(/%20/g, '+');
    }
    // Not yet archived — link to the source's original URL if it has one,
    // else fall back to a placeholder anchor.
    if (source.source_url) return source.source_url;
    return '#pending-archive';
  }
  function mimeKind(mime) {
    if (!mime) return 'other';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'text/html') return 'html';
    if (mime.startsWith('text/') || mime.includes('csv')) return 'text';
    return 'other';
  }

  // ============ EXHIBITS ============
  // A workspace-scoped collection of saved text spans (clipped from sources
  // or drafts). Each exhibit has permanent provenance — source_id (or doc_id),
  // char offsets when applicable, text, optional label, created_at, author.
  async function createExhibit(ws_id, patch) {
    await latency();
    state.exhibits = state.exhibits || {};
    state.exhibits[ws_id] = state.exhibits[ws_id] || {};
    const id = 'exh_' + uuid();
    const item = Object.assign({
      id, ws_id,
      source_id: null,
      doc_id: null,
      text: '',
      label: '',
      char_start: null,
      char_end: null,
      created_at: nowIso(),
      author: state.session && state.session.matrix_id,
    }, patch || {});
    state.exhibits[ws_id][id] = item;
    persist();
    return item;
  }
  async function updateExhibit(ws_id, id, patch) {
    const e = state.exhibits && state.exhibits[ws_id] && state.exhibits[ws_id][id];
    if (!e) throw new Error('No exhibit');
    Object.assign(e, patch);
    persist();
    return e;
  }
  async function deleteExhibit(ws_id, id) {
    if (state.exhibits && state.exhibits[ws_id]) {
      delete state.exhibits[ws_id][id];
      persist();
    }
  }
  function listExhibits(ws_id) {
    const m = (state.exhibits && state.exhibits[ws_id]) || {};
    return Object.values(m).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  }
  function getExhibit(ws_id, id) {
    return (state.exhibits && state.exhibits[ws_id] && state.exhibits[ws_id][id]);
  }

  async function wipeAll() {
    Object.assign(state, blank());
    cryptoKey = null;
    try { localStorage.removeItem(KEY_ENC); } catch (_) {}
    try { localStorage.removeItem(KEY_LEGACY); } catch (_) {}
    try { localStorage.removeItem(SALT_KEY); } catch (_) {}
    try { await window.MX.wipeAll(); } catch (_) {}
  }

  // ============ EVIDENCE / CORKBOARD ============
  // Each workspace can have multiple named boards. Each board has its own
  // set of cards (evidence) and connector strings.
  function ensureBoards(ws_id) {
    state.boards = state.boards || {};
    if (!state.boards[ws_id] || !state.boards[ws_id].length) {
      const id = 'bd_' + uuid();
      state.boards[ws_id] = [{ id, name: 'Main board', created_at: nowIso() }];
      state.boardActive = state.boardActive || {};
      state.boardActive[ws_id] = id;
    }
    return state.boards[ws_id];
  }
  function listBoards(ws_id) { ensureBoards(ws_id); return state.boards[ws_id]; }
  function activeBoard(ws_id) {
    ensureBoards(ws_id);
    state.boardActive = state.boardActive || {};
    return state.boardActive[ws_id] || state.boards[ws_id][0].id;
  }
  async function setActiveBoard(ws_id, board_id) {
    ensureBoards(ws_id);
    state.boardActive[ws_id] = board_id;
    persist();
  }
  async function createBoard(ws_id, name) {
    ensureBoards(ws_id);
    const id = 'bd_' + uuid();
    state.boards[ws_id].push({ id, name: (name || 'New board').trim(), created_at: nowIso() });
    state.boardActive[ws_id] = id;
    persist();
    return id;
  }
  async function renameBoard(ws_id, board_id, name) {
    const b = (state.boards[ws_id] || []).find(x => x.id === board_id);
    if (b) { b.name = name.trim() || b.name; persist(); }
  }
  async function deleteBoard(ws_id, board_id) {
    if (!state.boards[ws_id]) return;
    if (state.boards[ws_id].length <= 1) throw new Error('Need at least one board.');
    state.boards[ws_id] = state.boards[ws_id].filter(x => x.id !== board_id);
    if (state.boardActive[ws_id] === board_id) state.boardActive[ws_id] = state.boards[ws_id][0].id;
    // Drop cards/strings on that board
    if (state.evidence && state.evidence[ws_id]) {
      for (const id of Object.keys(state.evidence[ws_id])) {
        if (state.evidence[ws_id][id].board_id === board_id) delete state.evidence[ws_id][id];
      }
    }
    if (state.strings && state.strings[ws_id]) {
      state.strings[ws_id] = (state.strings[ws_id] || []).filter(s => s.board_id !== board_id);
    }
    persist();
  }

  async function createEvidence(ws_id, patch) {
    await latency();
    ensureBoards(ws_id);
    const id = 'ev_' + uuid();
    const item = Object.assign({
      id, ws_id,
      board_id: state.boardActive[ws_id],
      source_id: null,
      doc_id: null,
      quote: '',
      note: '',
      tags: [],
      color: 'amber',
      x: 40 + Math.round(Math.random() * 240),
      y: 40 + Math.round(Math.random() * 160),
      w: 220, h: 160,
      created_at: nowIso(),
      author: state.session && state.session.matrix_id,
    }, patch || {});
    state.evidence = state.evidence || {};
    state.evidence[ws_id] = state.evidence[ws_id] || {};
    state.evidence[ws_id][id] = item;
    persist();
    return item;
  }
  async function updateEvidence(ws_id, ev_id, patch) {
    const e = state.evidence && state.evidence[ws_id] && state.evidence[ws_id][ev_id];
    if (!e) throw new Error('No evidence');
    Object.assign(e, patch);
    persist();
    return e;
  }
  async function deleteEvidence(ws_id, ev_id) {
    if (state.evidence && state.evidence[ws_id]) {
      delete state.evidence[ws_id][ev_id];
      // Also drop any strings touching this card
      if (state.strings && state.strings[ws_id]) {
        state.strings[ws_id] = state.strings[ws_id].filter(s => s.from !== ev_id && s.to !== ev_id);
      }
      persist();
    }
  }
  function listEvidence(ws_id, board_id) {
    ensureBoards(ws_id);
    const bid = board_id || state.boardActive[ws_id];
    const m = (state.evidence && state.evidence[ws_id]) || {};
    return Object.values(m).filter(e => (e.board_id || state.boards[ws_id][0].id) === bid)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  }

  // ---- Strings / connectors ----
  async function createString(ws_id, from, to, label) {
    state.strings = state.strings || {};
    state.strings[ws_id] = state.strings[ws_id] || [];
    const id = 'str_' + uuid();
    state.strings[ws_id].push({
      id, from, to,
      board_id: state.boardActive[ws_id],
      label: label || '',
      created_at: nowIso(),
    });
    persist();
    return id;
  }
  async function updateString(ws_id, id, patch) {
    const s = (state.strings && state.strings[ws_id] || []).find(x => x.id === id);
    if (s) { Object.assign(s, patch); persist(); }
  }
  async function deleteString(ws_id, id) {
    if (state.strings && state.strings[ws_id]) {
      state.strings[ws_id] = state.strings[ws_id].filter(x => x.id !== id);
      persist();
    }
  }
  function listStrings(ws_id, board_id) {
    ensureBoards(ws_id);
    const bid = board_id || state.boardActive[ws_id];
    return (state.strings && state.strings[ws_id] || []).filter(s => (s.board_id || state.boards[ws_id][0].id) === bid);
  }

  // ---- Holons (named groups of cards) ----
  async function createHolon(ws_id, patch) {
    ensureBoards(ws_id);
    state.holons = state.holons || {};
    state.holons[ws_id] = state.holons[ws_id] || [];
    const id = 'hol_' + uuid();
    state.holons[ws_id].push(Object.assign({
      id,
      board_id: state.boardActive[ws_id],
      name: 'Holon',
      cardIds: [],
      color: '',
      created_at: nowIso(),
    }, patch || {}));
    persist();
    return id;
  }
  async function updateHolon(ws_id, id, patch) {
    const list = state.holons && state.holons[ws_id] || [];
    const h = list.find(x => x.id === id);
    if (h) { Object.assign(h, patch); persist(); }
  }
  async function deleteHolon(ws_id, id) {
    if (state.holons && state.holons[ws_id]) {
      state.holons[ws_id] = state.holons[ws_id].filter(x => x.id !== id);
      persist();
    }
  }
  function listHolons(ws_id, board_id) {
    ensureBoards(ws_id);
    const bid = board_id || state.boardActive[ws_id];
    return (state.holons && state.holons[ws_id] || []).filter(h => (h.board_id || state.boards[ws_id][0].id) === bid);
  }

  // ============ FUZZY SOURCE SEARCH ============
  // Searches sources across ALL docs in a workspace using a tiny subsequence-
  // based scorer (no dependencies). Returns ranked results with the doc they
  // live in attached.
  function searchSourcesInWorkspace(ws_id, query) {
    const q = (query || '').trim().toLowerCase();
    const results = [];
    const docIds = state.doc_order[ws_id] || [];
    for (const did of docIds) {
      const doc = state.documents[did];
      if (!doc) continue;
      const m = state.sources[did] || {};
      for (const s of Object.values(m)) {
        if (s.hidden) continue;
        const score = fuzzyScore(q, [s.title, s.filename, s.source_url, s.description, (s.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase());
        if (q === '' || score > 0) results.push({ source: s, doc, score });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 50);
  }
  // simple subsequence + acronym + start-of-word scorer
  function fuzzyScore(query, target) {
    if (!query) return 1;
    if (!target) return 0;
    let qi = 0, score = 0, streak = 0, prevWord = true;
    for (let i = 0; i < target.length && qi < query.length; i++) {
      const c = target[i];
      if (c === query[qi]) {
        score += 1 + streak;
        if (prevWord) score += 2;
        streak++;
        qi++;
      } else {
        streak = 0;
      }
      prevWord = !/[a-z0-9]/.test(c);
    }
    if (qi < query.length) return 0;
    // Bonus if the whole query is a substring
    if (target.includes(query)) score += 10;
    return score;
  }

  window.Store = {
    ready,
    login, logout, session,
    createWorkspace, updateWorkspace, deleteWorkspace, listWorkspaces, getWorkspace,
    inviteMember, updateMember, removeMember, normalizeMatrixId,
    createDocument, saveDocument, deleteDocument, listDocuments, getDocument,
    restoreToVersion, getEditLog, getSnapshot,
    setStage, createCheckpoint, renameCheckpoint, deleteCheckpoint, listCheckpoints,
    STAGES,
    uploadSource, importFromUrl, updateSource, deleteSource, hideSource, listSources, listHiddenSources, getSource, archiveSource,
    getMedia,
    createComment, replyComment, resolveComment, listComments,
    createSuggestion, updateSuggestion, listSuggestions,
    createEvidence, updateEvidence, deleteEvidence, listEvidence,
    listBoards, activeBoard, setActiveBoard, createBoard, renameBoard, deleteBoard,
    createString, updateString, deleteString, listStrings,
    createHolon, updateHolon, deleteHolon, listHolons,
    createExhibit, updateExhibit, deleteExhibit, listExhibits, getExhibit,
    searchSourcesInWorkspace,
    buildCitationUrl, VIEWER_BASE,
    wipeAll,
  };
})();
