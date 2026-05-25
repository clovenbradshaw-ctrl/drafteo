/**
 * legacy-store.js — Store API shim
 *
 * Translates the old DraftEO Store API (window.Store.X) to the new
 * bare-metal Matrix foundation (client.js, rooms.js, model.js,
 * operators.js, fold.js, EventStore in store.js).
 *
 * Phase 1 surface:
 *   ready(), session(), login(), logout(), normalizeMatrixId(),
 *   listWorkspaces(), getWorkspace(), createWorkspace(), updateWorkspace(),
 *   deleteWorkspace(), inviteMember(), updateMember(), removeMember(),
 *   listDocuments(), getDocument(), createDocument(), saveDocument(stub),
 *   deleteDocument(),
 *   listSources(), listExhibits(), listEvidence(),
 *   updateSource(stub), hideSource(stub), uploadSource(stub),
 *   importFromUrl(stub), updateExhibit(stub), deleteExhibit(stub),
 *   getSource(stub), wipeAll(),
 *
 * Later phases extend this with edit log, comments, suggestions, boards,
 * checkpoints, archive flow, etc.
 *
 * Sets `window.Store` so the unchanged old UI modules (projects.js,
 * workspace.js, login.js) can use it directly.
 */

import {
  login as fLogin,
  restoreSession as fRestoreSession,
  logout as fLogout,
  getClient,
  setProgress,
  setRecoveryKeyDisplayer,
  setRecoveryKeyProvider,
} from './client.js';
import { setNamespace, getNamespace, ins, def, eva } from './operators.js';
import { initial, fold, foldFrom, entitiesOfType } from './fold.js';
import {
  createRoom, discoverRooms, getMembers, invite as inviteUser,
  getTimeline, onTimeline, onDecrypted, loadTimelineSince, onRoomChanges,
} from './rooms.js';
import { EventStore } from './store.js';
import {
  RoomSession, findDocEntity, replayDocAt,
  ROOM_TYPE, ENTITY, STAGES,
} from './model.js';

// ── Namespace ──
setNamespace('com.intelechia.drafteo');

// ── Bootstrap state ──

let readyPromise = null;
let currentSession = null;
let workspaceSessions = new Map();   // ws_id -> RoomSession (long-lived)
let documentSessions = new Map();    // doc_id -> RoomSession (long-lived)
const listeners = new Set();

function emit(eventName, detail = {}) {
  try { window.dispatchEvent(new CustomEvent(eventName, { detail })); }
  catch (_) { /* not in a window context */ }
  for (const cb of listeners) {
    try { cb(eventName, detail); } catch (_) { /* ignore */ }
  }
}

// ── Recovery-key UX hooks (overlay-style — minimal UI) ──

function installRecoveryHooks() {
  setRecoveryKeyDisplayer((key) => new Promise((resolve) => {
    const ok = confirm(
      'IMPORTANT: save this recovery key. It restores your message history on new browsers/devices. It cannot be shown again.\n\n' + key
    );
    void ok;
    resolve();
  }));
  setRecoveryKeyProvider(() => new Promise((resolve) => {
    const v = prompt('This device is new. Paste your recovery key from first login (or cancel to skip):', '');
    resolve(v ? v.trim() : null);
  }));
  setProgress(() => {}); // could surface this in UI later
}

// ── Session shape (matches old DraftEO) ──

function buildSession() {
  const client = getClient();
  if (!client) return null;
  const matrix_id = client.getUserId();
  const device_id = client.getDeviceId?.() || null;
  const homeserver = client.getHomeserverUrl?.() || null;
  return {
    matrix_id,
    device_id,
    homeserver,
    // Old code reads this for the user-chip display.
    access_token: null, // intentionally NOT exposed
  };
}

// ── Boot ──

async function bootstrap() {
  installRecoveryHooks();
  try {
    const client = await fRestoreSession();
    if (client) {
      currentSession = buildSession();
      emit('drafteo:session-restored', currentSession);
    }
  } catch (e) {
    // Tolerate restore failure; user can re-login.
    console.warn('[store-shim] restore failed:', e);
  }
}

readyPromise = bootstrap();

// ── Public API ──

export const Store = {
  ready() { return readyPromise; },

  session() { return currentSession; },

  /** Document lifecycle stages used by the editor's stage pill. */
  STAGES,

  normalizeMatrixId(id) {
    if (!id) return null;
    const v = String(id).trim();
    if (!v) return null;
    if (v.startsWith('@')) return v;
    if (v.includes(':')) return '@' + v;
    return v; // bare local part — caller decides
  },

  async login(user, pass, homeserver) {
    let hs = (homeserver || '').trim();
    let username = user.trim();
    const m = username.match(/^@?([^:\s]+):([a-z0-9.-]+\.[a-z]{2,})$/i);
    if (m) {
      username = m[1];
      if (!hs) hs = 'https://' + m[2];
    }
    if (!hs) hs = 'https://hyphae.social';
    const { userId } = await fLogin(hs, username, pass);
    void userId;
    currentSession = buildSession();
    emit('drafteo:logged-in', currentSession);
    return currentSession;
  },

  async logout() {
    // Close any open sessions
    for (const s of workspaceSessions.values()) { try { await s.close(); } catch {} }
    for (const s of documentSessions.values()) { try { await s.close(); } catch {} }
    workspaceSessions.clear();
    documentSessions.clear();
    try { await fLogout(); } catch (e) { console.warn(e); }
    currentSession = null;
    emit('drafteo:logged-out', {});
  },

  // ── Workspaces ──

  listWorkspaces() {
    // Discover Matrix rooms with our app's workspace marker.
    return discoverRooms(ROOM_TYPE.WORKSPACE).map(workspaceCard);
  },

  getWorkspace(ws_id) {
    if (!ws_id) return null;
    const list = discoverRooms(ROOM_TYPE.WORKSPACE);
    const r = list.find((w) => w.roomId === ws_id);
    return r ? workspaceCard(r) : null;
  },

  async createWorkspace({ title, description }) {
    const ws_id = await createRoom(
      (title || 'New workspace').trim(),
      ROOM_TYPE.WORKSPACE,
      { title: (title || 'New workspace').trim(), description: description || '' }
    );
    // Pre-open the workspace session so later calls have it warmed up.
    ensureWorkspaceSession(ws_id);
    return Store.getWorkspace(ws_id) || { id: ws_id, title, description, members: [], updated_at: Date.now(), e2ee: true };
  },

  async updateWorkspace(ws_id, patch) {
    const client = getClient();
    if (!client) throw new Error('Not connected');
    if (patch.title != null) {
      try { await client.setRoomName(ws_id, patch.title.trim()); } catch (e) { console.warn(e); }
    }
    if (patch.description != null) {
      // Stored as a room state event (description in meta). Use the
      // workspace's own room timeline via DEF on a workspace entity is
      // possible but cleanest as a room name/topic change.
      try { await client.setRoomTopic(ws_id, patch.description); } catch (e) { console.warn(e); }
    }
    return Store.getWorkspace(ws_id);
  },

  async deleteWorkspace(ws_id) {
    const client = getClient();
    if (!client) throw new Error('Not connected');
    // "Delete" in Matrix = leave the room. Other members keep their copy.
    try { await client.leave(ws_id); } catch (e) { console.warn(e); }
    const s = workspaceSessions.get(ws_id);
    if (s) { try { await s.close(); } catch {} workspaceSessions.delete(ws_id); }
  },

  // ── Members ──

  async inviteMember(ws_id, matrix_id, role = 'member') {
    void role; // role tracking comes later
    await inviteUser(ws_id, matrix_id);
    return { matrix_id, role, status: 'invited' };
  },

  async updateMember(ws_id, matrix_id, patch) {
    void ws_id; void matrix_id; void patch;
    // Roles aren't yet plumbed through state events. No-op until later phase.
    return null;
  },

  async removeMember(ws_id, matrix_id) {
    const client = getClient();
    if (!client) throw new Error('Not connected');
    try { await client.kick(ws_id, matrix_id); } catch (e) { console.warn(e); }
  },

  // ── Documents ──

  listDocuments(ws_id) {
    if (!ws_id) return [];
    const rooms = discoverRooms(ROOM_TYPE.DOCUMENT).filter((r) => r.meta?.workspace_id === ws_id);
    // Eagerly warm up sessions in the background so subsequent
    // getDocument() calls (which are sync) have the full fold available
    // by the time the user clicks into a doc.
    for (const r of rooms) {
      if (!documentSessions.has(r.roomId)) {
        ensureDocumentSession(r.roomId).catch((e) =>
          console.warn('[store-shim] doc session warm-up failed', e)
        );
      }
    }
    return rooms.map((r) => documentCard(r, getDocEntityFromSession(r.roomId)));
  },

  getDocument(doc_id) {
    const r = discoverRooms(ROOM_TYPE.DOCUMENT).find((d) => d.roomId === doc_id);
    if (!r) return null;
    return documentCard(r, getDocEntityFromSession(doc_id));
  },

  async createDocument(ws_id, { title, dek } = {}) {
    const t = (title || 'Untitled').trim();
    const doc_id = await createRoom(t, ROOM_TYPE.DOCUMENT, {
      workspace_id: ws_id, title: t,
    });
    // Open the doc room's session so the INS lands locally and can be
    // observed by other views; emit INS for the canonical doc entity.
    const session = await ensureDocumentSession(doc_id);
    await ins(doc_id, ENTITY.DOCUMENT, {
      title: t, dek: dek || '', body: '', stage: 'drafting',
    });
    void session;
    return Store.getDocument(doc_id) || { id: doc_id, title: t, dek: dek || '', body_markdown: '', version: 0, stage: 'drafting' };
  },

  async saveDocument(doc_id, patch, editEntry) {
    const session = await ensureDocumentSession(doc_id);
    const doc = findDocEntity(session.state);
    if (!doc) throw new Error('document not yet loaded');
    if (patch.title != null) {
      await def(doc_id, doc._anchor, 'title', String(patch.title).trim());
      try { await getClient().setRoomName(doc_id, String(patch.title).trim()); } catch (e) { console.warn(e); }
    }
    if (patch.dek != null) {
      await def(doc_id, doc._anchor, 'dek', String(patch.dek));
    }
    if (patch.body_markdown != null) {
      await def(doc_id, doc._anchor, 'body', String(patch.body_markdown));
    }
    if (patch.stage != null && STAGES.includes(patch.stage)) {
      await def(doc_id, doc._anchor, 'stage', patch.stage);
    }
    // Edit-log entry: the editor classifies the diff (DEF/INS/DES/SEG/CON/ROL)
    // and hands us a payload. We persist it as an EVA event keyed by the
    // 'edit' criterion so the fold lifts it onto entity._evaluations and we
    // can later derive a version log + restore points from it.
    if (editEntry && editEntry.op) {
      try {
        await eva(doc_id, doc._anchor, 'edit', String(editEntry.op),
          JSON.stringify({
            resolution: editEntry.resolution || '',
            site: editEntry.site || '',
            note: editEntry.note || '',
          })
        );
      } catch (e) {
        console.warn('[store-shim] edit-log EVA failed', e);
      }
    }
    return Store.getDocument(doc_id);
  },

  async setStage(doc_id, stage) {
    if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
    return Store.saveDocument(doc_id, { stage });
  },

  /**
   * Pinned checkpoint — stored as an EVA(criterion='checkpoint') with the
   * given name as the note. The body at the checkpoint's timestamp is
   * what restore would replay to.
   */
  async createCheckpoint(doc_id, name) {
    const session = await ensureDocumentSession(doc_id);
    const doc = findDocEntity(session.state);
    if (!doc) throw new Error('document not yet loaded');
    await eva(doc_id, doc._anchor, 'checkpoint', 'pinned',
      JSON.stringify({ name: String(name || 'Untitled').trim() })
    );
    return Store.getDocument(doc_id);
  },

  /** Append-only edit log derived from the document entity's _evaluations. */
  getEditLog(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    const doc = findDocEntity(session.state);
    if (!doc || !Array.isArray(doc._evaluations)) return [];
    const entries = doc._evaluations.filter((e) => e.criterion === 'edit');
    return entries.map((e, i) => {
      let extra = {};
      try { extra = JSON.parse(e.note || '{}'); } catch (_) {}
      return {
        version: i + 1,
        ts: e._ts,
        op: e.result,
        resolution: extra.resolution || '',
        site: extra.site || '',
        note: extra.note || '',
        sender: e._sender || null,
      };
    });
  },

  /** Body text at a given version (1-indexed). v=0 returns the initial INS body. */
  async getSnapshot(doc_id, version) {
    const log = Store.getEditLog(doc_id);
    if (!log.length) {
      const d = Store.getDocument(doc_id);
      return d ? d.body_markdown || '' : '';
    }
    const idx = Math.max(0, Math.min(log.length, Number(version) || 0));
    if (idx === 0) {
      // Initial body: replay up to just before the first edit entry.
      const session = documentSessions.get(doc_id);
      if (!session) return '';
      const body = await replayDocAt(session, log[0].ts - 1);
      return body || '';
    }
    const target = log[idx - 1];
    const session = documentSessions.get(doc_id);
    if (!session) return '';
    return (await replayDocAt(session, target.ts)) || '';
  },

  /**
   * Restore a prior version: replay the body at the target version's ts,
   * emit a new DEF(body) carrying that text + an EVA(criterion='edit',
   * op='ROL') so the history surfaces the rollback as its own entry.
   */
  async restoreToVersion(doc_id, version) {
    const body = await Store.getSnapshot(doc_id, version);
    const session = documentSessions.get(doc_id);
    if (!session) throw new Error('document session not ready');
    const doc = findDocEntity(session.state);
    if (!doc) throw new Error('document not yet loaded');
    await def(doc_id, doc._anchor, 'body', body);
    try {
      await eva(doc_id, doc._anchor, 'edit', 'ROL',
        JSON.stringify({ resolution: `Restored to version ${version}`, site: 'whole doc' })
      );
    } catch (_) {}
    return Store.getDocument(doc_id);
  },

  /**
   * URL for a citation footnote. Phase 3 wires the real archive.org URL;
   * for now we hand back whatever URL is on the source (if any) or null.
   */
  buildCitationUrl(source, footnote) {
    void footnote;
    if (!source) return null;
    return source.archive_org_url || source.url || null;
  },

  async deleteDocument(doc_id) {
    const client = getClient();
    if (!client) throw new Error('Not connected');
    try { await client.leave(doc_id); } catch (e) { console.warn(e); }
    const s = documentSessions.get(doc_id);
    if (s) { try { await s.close(); } catch {} documentSessions.delete(doc_id); }
  },

  // ── Stubs for Phase 2/3 ──
  // The UI calls these but until later phases they're either reads-of-nothing
  // or no-ops. Keep them present so workspace.js / projects.js don't crash.

  listSources(doc_id) {
    void doc_id; return [];
  },
  getSource(doc_id, source_id) {
    void doc_id; void source_id; return null;
  },
  async uploadSource() { throw new Error('Sources will be wired in Phase 3'); },
  async updateSource()  { throw new Error('Sources will be wired in Phase 3'); },
  async hideSource()    { throw new Error('Sources will be wired in Phase 3'); },
  async deleteSource()  { throw new Error('Sources will be wired in Phase 3'); },
  async importFromUrl() { throw new Error('Sources will be wired in Phase 3'); },
  async archiveSource() { throw new Error('Sources will be wired in Phase 3'); },

  listExhibits(ws_id) { void ws_id; return []; },
  async updateExhibit() { throw new Error('Exhibits will be wired in Phase 4'); },
  async deleteExhibit() { throw new Error('Exhibits will be wired in Phase 4'); },

  listEvidence(ws_id) { void ws_id; return []; },

  // Comments + suggestions (Phase 5). Editor renders empty panels with
  // these returning []; mutators announce when they're touched so we
  // surface misuse early.
  listComments(doc_id) { void doc_id; return []; },
  listSuggestions(doc_id) { void doc_id; return []; },
  async createComment()    { throw new Error('Comments arrive in Phase 5'); },
  async replyComment()     { throw new Error('Comments arrive in Phase 5'); },
  async resolveComment()   { throw new Error('Comments arrive in Phase 5'); },
  async createSuggestion() { throw new Error('Suggestions arrive in Phase 5'); },
  async updateSuggestion() { throw new Error('Suggestions arrive in Phase 5'); },

  // ── Misc ──

  async wipeAll() {
    // Clears local sessions. Server-side rooms remain.
    for (const s of workspaceSessions.values()) { try { await s.close(); } catch {} }
    for (const s of documentSessions.values()) { try { await s.close(); } catch {} }
    workspaceSessions.clear();
    documentSessions.clear();
    try { await fLogout(); } catch {}
    currentSession = null;
    try { localStorage.clear(); } catch {}
    location.reload();
  },

  // Internal: let other modules subscribe to coarse state changes.
  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

// ── Helpers ──

function ensureWorkspaceSession(ws_id) {
  let s = workspaceSessions.get(ws_id);
  if (s) return s;
  s = new RoomSession(ws_id);
  workspaceSessions.set(ws_id, s);
  s.open().catch((e) => console.warn('[store-shim] workspace session open failed', e));
  s.onUpdate(() => emit('drafteo:workspace-state', { ws_id }));
  return s;
}

async function ensureDocumentSession(doc_id) {
  let s = documentSessions.get(doc_id);
  if (s) return s;
  s = new RoomSession(doc_id);
  documentSessions.set(doc_id, s);
  await s.open();
  s.onUpdate(() => emit('drafteo:document-state', { doc_id }));
  return s;
}

function getDocEntityFromSession(doc_id) {
  const s = documentSessions.get(doc_id);
  if (!s) return null;
  return findDocEntity(s.state);
}

// ── Card builders ──

function workspaceCard(r) {
  const members = getMembers(r.roomId).map((m) => ({
    matrix_id: m.userId,
    display_name: m.displayName,
    role: 'member',
    status: 'joined',
  }));
  return {
    id: r.roomId,
    title: r.name || '(untitled)',
    description: r.meta?.description || '',
    members,
    updated_at: Date.now(),
    e2ee: true,
  };
}

function documentCard(r, docEntity) {
  const body = docEntity?.body ?? '';
  return {
    id: r.roomId,
    workspace_id: r.meta?.workspace_id || null,
    title: docEntity?.title || r.name || '(untitled)',
    dek: docEntity?.dek || '',
    body_markdown: body,
    version: 0, // Phase 2: derive from edit log length
    stage: docEntity?.stage || 'drafting',
    created_at: docEntity?._created || Date.now(),
    updated_at: docEntity?._updated || docEntity?._created || Date.now(),
  };
}

// ── Refresh on Matrix room changes ──
// When membership / state events arrive, fire a notification so the UI
// can re-render. The old projects.js listens via window dispatched events.

let unsubRoomChanges = null;
function startRoomChangeListeners() {
  if (unsubRoomChanges) unsubRoomChanges();
  if (!getClient()) return;
  unsubRoomChanges = onRoomChanges(() => emit('drafteo:rooms-changed', {}));
}

window.addEventListener('drafteo:logged-in', startRoomChangeListeners);
window.addEventListener('drafteo:session-restored', startRoomChangeListeners);

// ── Attach to window (the old UI is unchanged and uses this global) ──

if (typeof window !== 'undefined') {
  window.Store = Store;
}
