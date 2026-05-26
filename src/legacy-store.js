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
import { encryptAttachment, decryptAttachment } from 'matrix-encrypt-attachment';
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
  setRecoveryKeyDisplayer((key) => {
    // Prefer the styled modal once recovery-modals.js has run; fall
    // back to confirm() if it's somehow not loaded yet.
    if (typeof window !== 'undefined' && window.RecoveryUI?.display) {
      return window.RecoveryUI.display(key);
    }
    return new Promise((resolve) => {
      try {
        confirm(
          'IMPORTANT: save this recovery key. It restores your message history on new browsers/devices. It cannot be shown again.\n\n' + key
        );
      } catch (_) {}
      resolve();
    });
  });
  setRecoveryKeyProvider(() => {
    if (typeof window !== 'undefined' && window.RecoveryUI?.ask) {
      return window.RecoveryUI.ask();
    }
    return new Promise((resolve) => {
      const v = (typeof prompt === 'function')
        ? prompt('This device is new. Paste your recovery key from first login (or cancel to skip):', '')
        : null;
      resolve(v ? v.trim() : null);
    });
  });
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

  /**
   * Append-only edit log derived from the document entity's _evaluations.
   * Returned in the old DraftEO shape (version_to / eo_operator / resolution
   * / timestamp) plus newer convenience aliases (version / op / ts) so both
   * the history scrubber and any newer reader can consume it.
   */
  getEditLog(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    const doc = findDocEntity(session.state);
    if (!doc || !Array.isArray(doc._evaluations)) return [];
    const entries = doc._evaluations.filter((e) => e.criterion === 'edit');
    return entries.map((e, i) => {
      let extra = {};
      try { extra = JSON.parse(e.note || '{}'); } catch (_) {}
      const v = i + 1;
      return {
        version_to: v,
        version: v,
        eo_operator: e.result,
        op: e.result,
        resolution: extra.resolution || '',
        site: extra.site || '',
        note: extra.note || '',
        timestamp: e._ts,
        ts: e._ts,
        sender: e._sender || null,
      };
    });
  },

  /** Pinned checkpoints derived from EVA(criterion='checkpoint'). */
  listCheckpoints(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    const doc = findDocEntity(session.state);
    if (!doc || !Array.isArray(doc._evaluations)) return [];
    return doc._evaluations
      .filter((e) => e.criterion === 'checkpoint')
      .map((e) => {
        let extra = {};
        try { extra = JSON.parse(e.note || '{}'); } catch (_) {}
        return {
          name: extra.name || 'Checkpoint',
          ts: e._ts,
          sender: e._sender || null,
        };
      })
      .sort((a, b) => a.ts - b.ts);
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
   * URL for a citation footnote. Archived sources point readers at the
   * DraftEO mini-viewer (renders the archived file with the cited span
   * highlighted). Falls back to the source's original URL, then a
   * pending-archive placeholder.
   */
  buildCitationUrl(source, footnote) {
    if (!source) return '';
    if (source.archive_org_identifier) {
      const params = new URLSearchParams();
      params.set('src', source.archive_org_identifier);
      if (source.filename) params.set('file', source.filename);
      if (source.mime) params.set('type', _mimeKind(source.mime));
      if (footnote && footnote.page) params.set('page', footnote.page);
      if (footnote && footnote.supporting_quote) params.set('q', footnote.supporting_quote);
      if (footnote && footnote.note) params.set('note', footnote.note);
      return Store.VIEWER_BASE + '#' + params.toString().replace(/%20/g, '+');
    }
    if (source.archive_org_url) return source.archive_org_url;
    if (source.source_url) return source.source_url;
    return '#pending-archive';
  },

  VIEWER_BASE: 'https://clovenbradshaw-ctrl.github.io/drafteo/view.html',

  async deleteDocument(doc_id) {
    const client = getClient();
    if (!client) throw new Error('Not connected');
    try { await client.leave(doc_id); } catch (e) { console.warn(e); }
    const s = documentSessions.get(doc_id);
    if (s) { try { await s.close(); } catch {} documentSessions.delete(doc_id); }
  },

  // ── Sources (Phase 3) ──

  listSources(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    return entitiesOfType(session.state, ENTITY.SOURCE)
      .filter((e) => !e.deleted && !e.hidden)
      .map(sourceCard)
      .sort((a, b) => (a.uploaded_at || 0) - (b.uploaded_at || 0));
  },

  listHiddenSources(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    return entitiesOfType(session.state, ENTITY.SOURCE)
      .filter((e) => !e.deleted && e.hidden)
      .map(sourceCard)
      .sort((a, b) => (b.uploaded_at || 0) - (a.uploaded_at || 0));
  },

  getSource(doc_id, source_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return null;
    const e = session.state.entities[source_id];
    if (!e || e._type !== ENTITY.SOURCE) return null;
    if (e.deleted) return null;
    return sourceCard(e);
  },

  /**
   * Encrypt the file client-side, upload the ciphertext to the homeserver
   * media repo, and INS a source entity into the document room carrying
   * the mxc URL alongside the encryption descriptor. The plaintext never
   * leaves the client.
   */
  async uploadSource(doc_id, file, patch) {
    const session = await ensureDocumentSession(doc_id);
    void session;
    const client = getClient();
    if (!client) throw new Error('Not connected');

    const plaintext = await file.arrayBuffer();
    const { data: ciphertext, info } = await encryptAttachment(plaintext);
    const blob = new Blob([ciphertext], { type: 'application/octet-stream' });
    const resp = await client.uploadContent(blob, {
      name: file.name,
      type: 'application/octet-stream',
    });
    const mxc = typeof resp === 'string' ? resp : (resp.content_uri || resp);

    const payload = {
      title: (patch?.title || file.name || 'Untitled').trim(),
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      size_bytes: file.size,
      uploaded_at: Date.now(),
      mxc_uri: mxc,
      encryption_info: info,
      source_url: patch?.source_url || null,
      description: patch?.description || '',
      tags: Array.isArray(patch?.tags) ? patch.tags : [],
      hidden: false,
      deleted: false,
    };
    const anchor = await ins(doc_id, ENTITY.SOURCE, payload);
    return Store.getSource(doc_id, anchor) || { source_id: anchor, ...payload };
  },

  /**
   * Snapshot a web page: fetch via the n8n feed proxy, sanitise the HTML,
   * encrypt the cleaned snapshot, upload the ciphertext to the homeserver
   * media repo, and INS a source carrying the mxc + source_url metadata.
   * The plaintext (cleaned HTML) never leaves the client unencrypted.
   *
   * Caller can later run archiveSource() to push the snapshot to
   * archive.org via the archiveo webhook for permanent citation.
   */
  async importFromUrl(doc_id, url) {
    if (!url) throw new Error('URL required');
    const trimmed = String(url).trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('URL must start with http(s)://');
    }
    const session = await ensureDocumentSession(doc_id);
    void session;
    const client = getClient();
    if (!client) throw new Error('Not connected');

    const proxyUrl = 'https://n8n.intelechia.com/webhook/feed?url=' + encodeURIComponent(trimmed);
    let raw;
    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error('Proxy returned ' + res.status);
      raw = await res.text();
    } catch (e) {
      throw new Error('Fetch failed: ' + (e.message || e));
    }
    const snap = sanitiseHtml(raw, trimmed);

    const plaintext = new TextEncoder().encode(snap.html).buffer;
    const { data: ciphertext, info } = await encryptAttachment(plaintext);
    const blob = new Blob([ciphertext], { type: 'application/octet-stream' });
    const resp = await client.uploadContent(blob, {
      name: snap.filename,
      type: 'application/octet-stream',
    });
    const mxc = typeof resp === 'string' ? resp : (resp.content_uri || resp);

    const nowMs = Date.now();
    const payload = {
      title: snap.title,
      filename: snap.filename,
      mime: 'text/html',
      size_bytes: new Blob([snap.html]).size,
      uploaded_at: nowMs,
      snapshot_at: nowMs,
      mxc_uri: mxc,
      encryption_info: info,
      source_url: trimmed,
      description: 'Web snapshot of ' + trimmed,
      tags: ['web-snapshot'],
      plaintext: (snap.plaintext || '').slice(0, 200000),
      hidden: false,
      deleted: false,
    };
    const anchor = await ins(doc_id, ENTITY.SOURCE, payload);
    return Store.getSource(doc_id, anchor) || { source_id: anchor, ...payload };
  },

  async updateSource(doc_id, source_id, patch) {
    const allowed = ['title', 'description', 'tags', 'archive_org_url',
                     'archived_at', 'archive_org_identifier',
                     'archive_org_filename'];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      await def(doc_id, source_id, k, patch[k]);
    }
    return Store.getSource(doc_id, source_id);
  },

  async hideSource(doc_id, source_id, hidden) {
    await def(doc_id, source_id, 'hidden', !!hidden);
    return Store.getSource(doc_id, source_id);
  },

  /** Permanent delete (tombstone via DEF). Citations to it go orphaned. */
  async deleteSource(doc_id, source_id) {
    await def(doc_id, source_id, 'deleted', true);
  },

  /**
   * Append a redaction to a source. Each redaction is a region the user
   * wants destroyed from the local copy before archiving:
   *
   *   { type: 'text',     start, end, label }    // char offsets in plaintext
   *   { type: 'rect',     x, y, w, h, label }    // relative 0..1 image coords
   *   { type: 'pdf-rect', page, x, y, w, h, label } // PDF page coords (overlay only in v1)
   *
   * Pending redactions are display-only — `applyRedactions` is what actually
   * rewrites the bytes. We block adding redactions to an already-archived
   * source because the public archive.org copy is permanent: redaction has
   * to happen before archiving to mean anything.
   */
  async addRedaction(doc_id, source_id, redaction) {
    const s = Store.getSource(doc_id, source_id);
    if (!s) throw new Error('source not found');
    if (s.archive_org_url) {
      throw new Error('This source is already on archive.org. The public copy is permanent — redact before archiving.');
    }
    if (!redaction || !redaction.type) throw new Error('redaction.type required');
    const id = 'red_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const next = (Array.isArray(s.redactions) ? s.redactions.slice() : []).concat([{
      ...redaction,
      id,
      label: (redaction.label || '').toString().trim(),
      created_at: Date.now(),
      created_by: (currentSession && currentSession.matrix_id) || null,
    }]);
    await def(doc_id, source_id, 'redactions', next);
    try {
      window.dispatchEvent(new CustomEvent('drafteo:sources-updated', { detail: { doc_id, source_id } }));
    } catch (_) {}
    return Store.getSource(doc_id, source_id);
  },

  async removeRedaction(doc_id, source_id, redaction_id) {
    const s = Store.getSource(doc_id, source_id);
    if (!s) throw new Error('source not found');
    const next = (s.redactions || []).filter((r) => r.id !== redaction_id);
    await def(doc_id, source_id, 'redactions', next);
    try {
      window.dispatchEvent(new CustomEvent('drafteo:sources-updated', { detail: { doc_id, source_id } }));
    } catch (_) {}
    return Store.getSource(doc_id, source_id);
  },

  /**
   * Destructively apply pending redactions. Rewrites the source's bytes,
   * re-encrypts, uploads as a new mxc, and DEFs the new descriptor. Also
   * cascades to any exhibit that quotes a now-redacted span — the exhibit's
   * text / context fields get replaced with [REDACTED] markers and the
   * `redaction_warning` flag is set so the viewer surfaces it.
   *
   * Throws when the source is already archived, when there's nothing to
   * apply, or when the mime is unsupported (PDFs currently keep their
   * overlay-only metadata since we can't rewrite PDF bytes without a
   * dedicated lib).
   */
  async applyRedactions(doc_id, source_id, opts) {
    const s = Store.getSource(doc_id, source_id);
    if (!s) throw new Error('source not found');
    if (s.archive_org_url) {
      throw new Error('Cannot redact destructively — this source is already on archive.org.');
    }
    const all = Array.isArray(s.redactions) ? s.redactions : [];
    if (all.length === 0) throw new Error('No redactions to apply.');
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : () => {};
    const client = getClient();
    if (!client) throw new Error('Not connected');
    if (!s.mxc_uri) throw new Error('Source has no preserved binary to rewrite.');

    const mime = s.mime || '';
    const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml';
    const isPlainText = mime.startsWith('text/') || mime === 'application/json';
    const isImage = mime.startsWith('image/');
    const isPdf = mime === 'application/pdf';

    if (isPdf) {
      throw new Error('Destructive PDF redaction is not yet supported. Your overlay redactions are saved and will display in the viewer.');
    }

    const textReds = all.filter((r) => r.type === 'text');
    const rectReds = all.filter((r) => r.type === 'rect');

    if (isHtml || isPlainText) {
      if (textReds.length === 0) throw new Error('No text redactions to apply on a text source.');
    } else if (isImage) {
      if (rectReds.length === 0) throw new Error('No image redactions to apply on an image source.');
    } else {
      throw new Error('Destructive redaction is not supported for ' + mime + '.');
    }

    // ── 1. Pull and decrypt the current bytes ───────────────────────────
    onProgress({ stage: 'reading', label: 'Reading original bytes…' });
    const cipherBuf = await fetchMxcCiphertext(client, s.mxc_uri);
    if (!cipherBuf) throw new Error('Could not fetch original bytes.');
    let plainBuf = cipherBuf;
    if (s.encryption_info) {
      plainBuf = await decryptAttachment(cipherBuf, s.encryption_info);
    }

    let newBytes = null;
    let newPlaintext = s.plaintext || null;

    // ── 2. Rewrite according to mime ────────────────────────────────────
    if (isHtml) {
      onProgress({ stage: 'rewriting', label: 'Rewriting HTML…' });
      const html = new TextDecoder().decode(plainBuf);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      // Strip volatile nodes so the text-walker matches what the viewer shows.
      doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
      applyTextRedactionsToTextNodes(doc.body || doc.documentElement, textReds);
      const out = '<!doctype html>' + doc.documentElement.outerHTML;
      newBytes = new TextEncoder().encode(out).buffer;
      newPlaintext = applyTextRedactionsToString(s.plaintext || '', textReds);
    } else if (isPlainText) {
      onProgress({ stage: 'rewriting', label: 'Rewriting text…' });
      const text = new TextDecoder().decode(plainBuf);
      const out = applyTextRedactionsToString(text, textReds);
      newBytes = new TextEncoder().encode(out).buffer;
      newPlaintext = out;
    } else if (isImage) {
      onProgress({ stage: 'rendering', label: 'Burning redactions into image…' });
      const blob = new Blob([plainBuf], { type: mime });
      const url = URL.createObjectURL(blob);
      try {
        const redactedBlob = await renderImageWithRectRedactions(url, rectReds, mime);
        newBytes = await redactedBlob.arrayBuffer();
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    if (!newBytes) throw new Error('Internal: no bytes produced.');

    // ── 3. Re-encrypt and re-upload ─────────────────────────────────────
    onProgress({ stage: 'uploading', label: 'Uploading redacted bytes…' });
    const { data: ciphertext, info } = await encryptAttachment(newBytes);
    const cblob = new Blob([ciphertext], { type: 'application/octet-stream' });
    const resp = await client.uploadContent(cblob, {
      name: s.filename,
      type: 'application/octet-stream',
    });
    const mxc = typeof resp === 'string' ? resp : (resp.content_uri || resp);

    // ── 4. DEF the new descriptor ───────────────────────────────────────
    onProgress({ stage: 'finalising', label: 'Updating source…' });
    await def(doc_id, source_id, 'mxc_uri', mxc);
    await def(doc_id, source_id, 'encryption_info', info);
    await def(doc_id, source_id, 'size_bytes', newBytes.byteLength);
    if (newPlaintext != null) {
      await def(doc_id, source_id, 'plaintext', String(newPlaintext).slice(0, 200000));
    }
    // Carry pdf-rect overlay forward; clear everything we just baked in.
    const carry = all.filter((r) => r.type === 'pdf-rect');
    await def(doc_id, source_id, 'redactions', carry);
    await def(doc_id, source_id, 'redactions_applied_at', Date.now());

    // ── 5. Cascade text redactions to exhibits ──────────────────────────
    if (textReds.length > 0) {
      try { await cascadeTextRedactionsToExhibits(source_id, textReds); }
      catch (e) { console.warn('[redact] exhibit cascade failed', e); }
    }

    try {
      window.dispatchEvent(new CustomEvent('drafteo:sources-updated', { detail: { doc_id, source_id } }));
    } catch (_) {}
    onProgress({ stage: 'done', label: 'Redactions applied' });
    return Store.getSource(doc_id, source_id);
  },

  /**
   * Archive flow — uploads to the n8n archiveo webhook, which PUTs to
   * archive.org and returns the resulting identifier + URL. onProgress is
   * called with { stage, pct, sent, total, label } as the upload and
   * remote-processing phases advance. Stages: 'preparing' | 'uploading'
   * | 'processing' | 'done'. Throws on transport/HTTP/payload failure
   * so the caller can surface the real error.
   */
  async archiveSource(doc_id, source_id, onProgress) {
    const s = Store.getSource(doc_id, source_id);
    if (!s) throw new Error('source not found');
    if (Array.isArray(s.redactions) && s.redactions.length > 0) {
      throw new Error('This source has ' + s.redactions.length + ' pending redaction(s). Apply or remove them before archiving — archive.org is permanent.');
    }
    if (!s.mxc_uri) {
      throw new Error('Source has no preserved binary to archive.');
    }
    const prog = typeof onProgress === 'function' ? onProgress : () => {};

    prog({ stage: 'preparing', pct: 0, label: 'Preparing binary…' });

    // Fetch + decrypt the source binary so n8n receives the plaintext.
    const client = getClient();
    if (!client) throw new Error('Not connected');
    const cipherBuf = await fetchMxcCiphertext(client, s.mxc_uri);
    if (!cipherBuf) throw new Error('Could not resolve mxc URL.');
    let plaintextBuf = cipherBuf;
    if (s.encryption_info) {
      plaintextBuf = await decryptAttachment(cipherBuf, s.encryption_info);
    }
    const blob = new Blob([plaintextBuf], { type: s.mime || 'application/octet-stream' });

    const fd = new FormData();
    fd.append('data', blob, asciiSafe(s.filename));
    let kind = 'source';
    if (s.source_url) kind = 'document';
    else if (s.mime && (s.mime.startsWith('video/') || s.mime.startsWith('audio/') || s.mime.startsWith('image/'))) kind = 'media';
    else if (s.mime && (s.mime.includes('csv') || s.mime.includes('json') || s.mime === 'application/x-ndjson')) kind = 'dataset';
    else if (s.mime && (s.mime === 'application/pdf' || s.mime.startsWith('text/') || s.mime.includes('officedocument'))) kind = 'document';
    fd.append('kind', kind);
    fd.append('mime', s.mime || 'application/octet-stream');
    fd.append('filename', asciiSafe(s.filename));
    fd.append('title', asciiSafe(s.title || s.filename));
    fd.append('description', asciiSafe(s.description || (s.source_url ? 'Web snapshot of ' + s.source_url : '')));
    fd.append('license', 'CC-BY-4.0');
    fd.append('consent_acknowledged', 'permanence');
    fd.append('consent_acknowledged', 'privacy');
    fd.append('consent_acknowledged', 'rights');
    if (s.tags && s.tags.length) fd.append('tags', s.tags.join(';'));
    if (s.source_url) fd.append('parent_identifier', s.source_url);

    const ARCHIVE_URL = 'https://n8n.intelechia.com/webhook/archiveo';
    const { status, raw } = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ARCHIVE_URL);
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
        waitStart = Date.now();
        prog({ stage: 'processing', pct: 0, label: 'Archive.org is processing the file…' });
        // Synthetic creep — we don't know the real ETA, so plateau near 95%.
        waitTimer = setInterval(() => {
          const elapsed = (Date.now() - waitStart) / 1000;
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

    await Store.updateSource(doc_id, source_id, {
      archive_org_url: url,
      archive_org_identifier: ident,
      archive_org_filename: archive.filename || s.filename,
      archived_at: Date.now(),
    });

    prog({ stage: 'done', pct: 100, label: 'Archived ✓' });
    try {
      window.dispatchEvent(new CustomEvent('drafteo:source-archived', {
        detail: { doc_id, source_id, archive_org_url: url, archive_org_identifier: ident },
      }));
    } catch (_) {}
    return Store.getSource(doc_id, source_id);
  },

  /**
   * Legacy API: returned cached base64. The new foundation doesn't cache
   * inline — it fetches + decrypts on demand. Callers should use
   * fetchMedia() (async) instead. Keeping this sync stub so old code
   * paths that read `Store.getMedia(...)` don't crash; returns null.
   */
  getMedia(_mxc_uri) { return null; },

  /**
   * Fetch the ciphertext from the media repo, decrypt with the source's
   * encryption_info, return a blob URL. Caller is responsible for
   * URL.revokeObjectURL when done. URL-only sources return null.
   */
  async fetchMedia(source) {
    if (!source || !source.mxc_uri) return null;
    const client = getClient();
    if (!client) return null;
    const buf = await fetchMxcCiphertext(client, source.mxc_uri);
    if (!buf) return null;
    let plaintext = buf;
    if (source.encryption_info) {
      plaintext = await decryptAttachment(buf, source.encryption_info);
    }
    const blob = new Blob([plaintext], { type: source.mime || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  },

  // Exhibits (Phase 4 lists+edits; Phase 3 only creates from srcviewer)
  listExhibits(ws_id) {
    const session = workspaceSessions.get(ws_id);
    if (!session) return [];
    return entitiesOfType(session.state, ENTITY.EXHIBIT)
      .filter((e) => !e.deleted)
      .map(exhibitCard)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  },
  async createExhibit(ws_id, payload) {
    ensureWorkspaceSession(ws_id);
    return ins(ws_id, ENTITY.EXHIBIT, {
      label:    (payload?.label || '').trim(),
      text:     (payload?.text  || '').trim(),
      note:     (payload?.note  || '').trim(),
      source_id: payload?.source_id || null,
      doc_id:   payload?.doc_id   || null,
      tags:     Array.isArray(payload?.tags) ? payload.tags : [],
      char_start: payload?.char_start ?? null,
      char_end:   payload?.char_end   ?? null,
      context_before: payload?.context_before || '',
      context_after:  payload?.context_after  || '',
      provenance: payload?.provenance || null,
      created_at: Date.now(),
      author: currentSession?.matrix_id || null,
      deleted: false,
    });
  },
  async updateExhibit(ws_id, id, patch) {
    const allowed = ['label', 'text', 'note', 'tags',
                     'char_start', 'char_end',
                     'context_before', 'context_after', 'provenance'];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      await def(ws_id, id, k, patch[k]);
    }
  },
  async deleteExhibit(ws_id, id) {
    await def(ws_id, id, 'deleted', true);
  },

  // ── Corkboard: boards, evidence, strings, holons (Phase 4) ──

  listBoards(ws_id) {
    if (!ws_id) return [];
    ensureWorkspaceSession(ws_id);
    const session = workspaceSessions.get(ws_id);
    if (!session) return [];
    const boards = entitiesOfType(session.state, 'board')
      .filter((b) => !b.deleted)
      .map(boardCard)
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    // Auto-create a default board the first time we render after the
    // session is warm. Fire-and-forget; the next render picks it up.
    if (boards.length === 0 && session.store && session.store.hasData?.() !== undefined) {
      const seedKey = '__autoseed_board_' + ws_id;
      if (!autoseedFlags[seedKey]) {
        autoseedFlags[seedKey] = true;
        ins(ws_id, 'board', { name: 'Main', created_at: Date.now() })
          .then((id) => {
            try { localStorage.setItem('drafteo.board.active.' + ws_id, id); } catch (_) {}
          })
          .catch((e) => console.warn('[store-shim] default board create failed', e));
      }
    }
    return boards;
  },

  activeBoard(ws_id) {
    if (!ws_id) return null;
    let saved = null;
    try { saved = localStorage.getItem('drafteo.board.active.' + ws_id); } catch (_) {}
    const boards = Store.listBoards(ws_id);
    if (saved && boards.some((b) => b.id === saved)) return saved;
    return boards[0]?.id || null;
  },

  async setActiveBoard(ws_id, board_id) {
    try { localStorage.setItem('drafteo.board.active.' + ws_id, board_id); } catch (_) {}
  },

  async createBoard(ws_id, name) {
    ensureWorkspaceSession(ws_id);
    const id = await ins(ws_id, 'board', {
      name: (name || 'New board').trim(),
      created_at: Date.now(),
    });
    try { localStorage.setItem('drafteo.board.active.' + ws_id, id); } catch (_) {}
    return id;
  },

  async renameBoard(ws_id, board_id, name) {
    await def(ws_id, board_id, 'name', (name || '').trim());
  },

  async deleteBoard(ws_id, board_id) {
    const boards = Store.listBoards(ws_id);
    if (boards.length <= 1) throw new Error('Need at least one board.');
    await def(ws_id, board_id, 'deleted', true);
    if (Store.activeBoard(ws_id) === board_id) {
      const remaining = Store.listBoards(ws_id).find((b) => b.id !== board_id);
      if (remaining) await Store.setActiveBoard(ws_id, remaining.id);
    }
  },

  async createEvidence(ws_id, patch) {
    ensureWorkspaceSession(ws_id);
    const board_id = patch?.board_id || Store.activeBoard(ws_id);
    const payload = {
      board_id,
      source_id: patch?.source_id || null,
      doc_id: patch?.doc_id || null,
      quote: patch?.quote || '',
      note: patch?.note || '',
      tags: Array.isArray(patch?.tags) ? patch.tags : [],
      color: patch?.color || 'amber',
      x: patch?.x ?? (40 + Math.round(Math.random() * 240)),
      y: patch?.y ?? (40 + Math.round(Math.random() * 160)),
      w: patch?.w ?? 220,
      h: patch?.h ?? 160,
      created_at: Date.now(),
      author: currentSession?.matrix_id || null,
      deleted: false,
    };
    const id = await ins(ws_id, 'evidence', payload);
    return Object.assign({ id }, payload);
  },

  async updateEvidence(ws_id, id, patch) {
    const allowed = ['quote', 'note', 'tags', 'color', 'x', 'y', 'w', 'h', 'source_id', 'doc_id', 'board_id'];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      await def(ws_id, id, k, patch[k]);
    }
  },

  async deleteEvidence(ws_id, id) {
    await def(ws_id, id, 'deleted', true);
  },

  listEvidence(ws_id, board_id) {
    if (!ws_id) return [];
    ensureWorkspaceSession(ws_id);
    const session = workspaceSessions.get(ws_id);
    if (!session) return [];
    const bid = board_id || Store.activeBoard(ws_id);
    if (!bid) return [];
    return entitiesOfType(session.state, 'evidence')
      .filter((e) => !e.deleted && (e.board_id || bid) === bid)
      .map(evidenceCard)
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  },

  async createString(ws_id, from, to, label) {
    ensureWorkspaceSession(ws_id);
    const board_id = Store.activeBoard(ws_id);
    return ins(ws_id, 'string', {
      board_id, from, to,
      label: label || '',
      kind: 'connects',
      direction: 'undirected',
      created_at: Date.now(),
      deleted: false,
    });
  },

  async updateString(ws_id, id, patch) {
    const allowed = ['label', 'kind', 'direction'];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      await def(ws_id, id, k, patch[k]);
    }
  },

  async deleteString(ws_id, id) {
    await def(ws_id, id, 'deleted', true);
  },

  listStrings(ws_id, board_id) {
    if (!ws_id) return [];
    ensureWorkspaceSession(ws_id);
    const session = workspaceSessions.get(ws_id);
    if (!session) return [];
    const bid = board_id || Store.activeBoard(ws_id);
    if (!bid) return [];
    return entitiesOfType(session.state, 'string')
      .filter((s) => !s.deleted && (s.board_id || bid) === bid)
      .map((s) => ({
        id: s._anchor,
        from: s.from, to: s.to,
        board_id: s.board_id,
        label: s.label || '',
        kind: s.kind || 'connects',
        direction: s.direction || 'undirected',
        created_at: s.created_at || s._created || 0,
      }));
  },

  async createHolon(ws_id, patch) {
    ensureWorkspaceSession(ws_id);
    return ins(ws_id, 'holon', {
      board_id: patch?.board_id || Store.activeBoard(ws_id),
      name: patch?.name || 'Holon',
      cardIds: Array.isArray(patch?.cardIds) ? patch.cardIds : [],
      color: patch?.color || '',
      created_at: Date.now(),
      deleted: false,
    });
  },

  async updateHolon(ws_id, id, patch) {
    const allowed = ['name', 'cardIds', 'color'];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      await def(ws_id, id, k, patch[k]);
    }
  },

  async deleteHolon(ws_id, id) {
    await def(ws_id, id, 'deleted', true);
  },

  listHolons(ws_id, board_id) {
    if (!ws_id) return [];
    ensureWorkspaceSession(ws_id);
    const session = workspaceSessions.get(ws_id);
    if (!session) return [];
    const bid = board_id || Store.activeBoard(ws_id);
    if (!bid) return [];
    return entitiesOfType(session.state, 'holon')
      .filter((h) => !h.deleted && (h.board_id || bid) === bid)
      .map((h) => ({
        id: h._anchor,
        board_id: h.board_id,
        name: h.name || 'Holon',
        cardIds: Array.isArray(h.cardIds) ? h.cardIds : [],
        color: h.color || '',
        created_at: h.created_at || h._created || 0,
      }));
  },

  // ── Search ──

  searchSourcesInWorkspace(ws_id, query) {
    if (!ws_id || !query) return [];
    const q = String(query).toLowerCase().trim();
    if (!q) return [];
    const docs = Store.listDocuments(ws_id);
    const results = [];
    for (const d of docs) {
      const sources = Store.listSources(d.id);
      for (const s of sources) {
        const hay = (s.title + ' ' + (s.filename || '') + ' ' + (s.description || '') + ' ' + (s.tags || []).join(' ') + ' ' + (s.source_url || '')).toLowerCase();
        if (subsequenceMatch(hay, q)) {
          results.push({
            doc_id: d.id, doc_title: d.title,
            source_id: s.source_id, source: s,
          });
        }
      }
    }
    return results;
  },

  // ── Comments (Phase 5) ──
  // Each comment is INS(comment, {anchor_id, quote, body, author, ts}).
  // Replies are INS(comment_reply, {parent: comment_anchor, body, author,
  // ts}) so a thread can grow without rewriting the whole array via DEF.

  async createComment(doc_id, { anchor_id, quote, body }) {
    const session = await ensureDocumentSession(doc_id);
    void session;
    const me = currentSession?.matrix_id || null;
    return ins(doc_id, 'comment', {
      anchor_id: anchor_id || null,
      quote: quote || '',
      body: body || '',
      author: me,
      ts: Date.now(),
      resolved: false,
      deleted: false,
    });
  },
  async replyComment(doc_id, comment_id, body) {
    const session = await ensureDocumentSession(doc_id);
    void session;
    const me = currentSession?.matrix_id || null;
    return ins(doc_id, 'comment_reply', {
      parent: comment_id,
      body: body || '',
      author: me,
      ts: Date.now(),
    });
  },
  async resolveComment(doc_id, comment_id, resolved) {
    await def(doc_id, comment_id, 'resolved', !!resolved);
  },
  listComments(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    const comments = entitiesOfType(session.state, 'comment')
      .filter((c) => !c.deleted);
    const replies = entitiesOfType(session.state, 'comment_reply');
    const repliesByParent = {};
    for (const r of replies) {
      if (!r.parent) continue;
      (repliesByParent[r.parent] = repliesByParent[r.parent] || []).push({
        author: r.author || r._sender || null,
        body: r.body || '',
        ts: r.ts || r._created || 0,
      });
    }
    return comments
      .map((c) => {
        const thread = [
          { author: c.author || c._sender || null, body: c.body || '', ts: c.ts || c._created || 0 },
          ...(repliesByParent[c._anchor] || []).sort((a, b) => a.ts - b.ts),
        ];
        return {
          id: c._anchor,
          anchor_id: c.anchor_id || null,
          quote: c.quote || '',
          thread,
          resolved: !!c.resolved,
          created_at: c._created || 0,
        };
      })
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  },

  // ── Suggestions (tracked-change proposals) ──

  async createSuggestion(doc_id, { anchor_id, original, proposed, note }) {
    const session = await ensureDocumentSession(doc_id);
    void session;
    const me = currentSession?.matrix_id || null;
    return ins(doc_id, 'suggestion', {
      anchor_id: anchor_id || null,
      original: original || '',
      proposed: proposed || '',
      note: note || '',
      author: me,
      status: 'pending',
      created_at: Date.now(),
      deleted: false,
    });
  },
  async updateSuggestion(doc_id, sug_id, patch) {
    const allowed = ['status', 'note', 'proposed'];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      await def(doc_id, sug_id, k, patch[k]);
    }
  },
  listSuggestions(doc_id) {
    const session = documentSessions.get(doc_id);
    if (!session) return [];
    return entitiesOfType(session.state, 'suggestion')
      .filter((s) => !s.deleted)
      .map((s) => ({
        id: s._anchor,
        anchor_id: s.anchor_id || null,
        original: s.original || '',
        proposed: s.proposed || '',
        note: s.note || '',
        author: s.author || s._sender || null,
        status: s.status || 'pending',
        created_at: s.created_at || s._created || 0,
      }))
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  },

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
  s.onUpdate(() => {
    emit('drafteo:document-state', { doc_id });
    // The old DraftEO UI listens for drafteo:sources-updated to refresh
    // sidebar lists when a new source / comment / suggestion arrives.
    // Keep that contract working.
    emit('drafteo:sources-updated', { doc_id });
  });
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

// One-time flags so listBoards() doesn't fire the default-board INS
// over and over when the corkboard re-renders during init.
const autoseedFlags = Object.create(null);

function boardCard(e) {
  return {
    id: e._anchor,
    name: e.name || 'Board',
    created_at: e.created_at || e._created || 0,
  };
}

function evidenceCard(e) {
  return {
    id: e._anchor,
    ws_id: null,                // corkboard doesn't read this back
    board_id: e.board_id || null,
    source_id: e.source_id || null,
    doc_id: e.doc_id || null,
    quote: e.quote || '',
    note: e.note || '',
    tags: Array.isArray(e.tags) ? e.tags : [],
    color: e.color || 'amber',
    x: e.x ?? 40, y: e.y ?? 40,
    w: e.w ?? 220, h: e.h ?? 160,
    created_at: e.created_at || e._created || 0,
    author: e.author || null,
  };
}

// Citation viewer's mime kind classification (matches the old shape).
function _mimeKind(mime) {
  if (!mime) return 'other';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'text/html') return 'html';
  if (mime.startsWith('text/') || mime.includes('csv')) return 'text';
  return 'other';
}

// Subsequence match used by the workspace-wide source search.
function subsequenceMatch(hay, needle) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// Fetch a ciphertext blob from the homeserver media repo. Tries the
// authenticated endpoint (Synapse 1.100+ default) with a Bearer token,
// falls back to the legacy unauthenticated URL if the SDK or server
// can't resolve it. Returns ArrayBuffer or null.
async function fetchMxcCiphertext(client, mxc) {
  if (!mxc) return null;
  const token = client.getAccessToken ? client.getAccessToken() : null;

  let authedUrl = null;
  try {
    authedUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, undefined, undefined, true);
  } catch { authedUrl = null; }
  const legacyUrl = client.mxcUrlToHttp(mxc);

  const tryFetch = async (url, withAuth) => {
    if (!url) return null;
    const headers = withAuth && token ? { Authorization: 'Bearer ' + token } : undefined;
    const r = await fetch(url, headers ? { headers } : undefined);
    if (!r.ok) return { error: r.status };
    return { buf: await r.arrayBuffer() };
  };

  if (authedUrl && token) {
    const a = await tryFetch(authedUrl, true);
    if (a && a.buf) return a.buf;
  }
  const l = await tryFetch(legacyUrl, false);
  if (l && l.buf) return l.buf;

  const status = (l && l.error) || 'unknown';
  throw new Error('media fetch failed: HTTP ' + status);
}

function sourceCard(e) {
  // Tolerate legacy field names from earlier slices (content_type, size,
  // url, mxc_url) alongside the old DraftEO names. Old UI consumes the
  // latter, so map them.
  return {
    source_id: e._anchor,
    title: e.title || e.filename || e.source_url || e.url || 'Untitled',
    filename: e.filename || null,
    mime: e.mime || e.content_type || 'application/octet-stream',
    size_bytes: e.size_bytes ?? e.size ?? 0,
    uploaded_at: e.uploaded_at || e._created || Date.now(),
    mxc_uri: e.mxc_uri || e.mxc_url || null,
    encryption_info: e.encryption_info || null,
    archive_org_url: e.archive_org_url || null,
    archived_at: e.archived_at || null,
    archive_org_identifier: e.archive_org_identifier || null,
    archive_org_filename: e.archive_org_filename || null,
    source_url: e.source_url || e.url || null,
    description: e.description || '',
    tags: Array.isArray(e.tags) ? e.tags : [],
    hidden: !!e.hidden,
    plaintext: e.plaintext || null,
    snapshot_at: e.snapshot_at || null,
    redactions: Array.isArray(e.redactions) ? e.redactions : [],
    redactions_applied_at: e.redactions_applied_at || null,
  };
}

function exhibitCard(e) {
  return {
    id: e._anchor,
    label: e.label || '',
    text: e.text || '',
    note: e.note || '',
    source_id: e.source_id || null,
    doc_id: e.doc_id || null,
    tags: Array.isArray(e.tags) ? e.tags : [],
    char_start: e.char_start ?? null,
    char_end:   e.char_end   ?? null,
    context_before: e.context_before || '',
    context_after:  e.context_after  || '',
    provenance: e.provenance || null,
    author: e.author || e._sender || null,
    created_at: e.created_at || e._created || Date.now(),
    redaction_warning: !!e.redaction_warning,
  };
}

// ── Redaction helpers ──

// Find the [start, end) char range of `text` inside `haystack`, using
// context_before/context_after to disambiguate when the same text
// appears multiple times. Whitespace is normalised so casual paste
// drift doesn't sink the lookup. Returns null when no match.
function locateTextRedaction(haystack, text, ctxBefore, ctxAfter) {
  if (!haystack || !text) return null;
  const norm = (s) => (s || '').replace(/\s+/g, ' ');
  const flat = norm(haystack);
  const target = norm(text);
  if (!target) return null;

  // Build a flat→haystack index map so we can return real offsets.
  const flatToHay = [];
  {
    let j = 0;
    for (let i = 0; i < haystack.length; i++) {
      const isWs = /\s/.test(haystack[i]);
      if (isWs && j > 0 && flat[j - 1] === ' ') continue;
      flatToHay[j++] = i;
    }
    flatToHay[j] = haystack.length;
  }

  const before = norm(ctxBefore || '').slice(-40);
  const after  = norm(ctxAfter  || '').slice(0, 40);
  const candidates = [];
  if (before && after) candidates.push(before + target + after);
  if (before) candidates.push(before + target);
  if (after)  candidates.push(target + after);
  candidates.push(target);

  for (const cand of candidates) {
    const idx = flat.indexOf(cand);
    if (idx < 0) continue;
    const targetIdxInFlat = flat.indexOf(target, idx);
    if (targetIdxInFlat < 0 || targetIdxInFlat >= idx + cand.length) continue;
    const start = flatToHay[targetIdxInFlat];
    const end   = flatToHay[targetIdxInFlat + target.length];
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return [start, end];
  }
  return null;
}

// Replace each redacted region (located by content) in the string with
// a block of FULL BLOCK characters (█) of the same visual length.
function applyTextRedactionsToString(text, reds) {
  if (!text || !reds || reds.length === 0) return text;
  const ranges = [];
  for (const r of reds) {
    if (r.type !== 'text') continue;
    const range = locateTextRedaction(text, r.text, r.context_before, r.context_after);
    if (range) ranges.push(range);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s < cursor) continue;
    if (s > cursor) out += text.slice(cursor, s);
    if (e > s) out += '█'.repeat(e - s);
    cursor = e;
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

// Walk text nodes in `root`, locate each redaction by content (with
// context-aware matching), and replace the matched chars in-place with
// FULL BLOCK characters. Text nodes are mutated, surrounding HTML
// structure is preserved.
function applyTextRedactionsToTextNodes(root, reds) {
  if (!root || !reds || reds.length === 0) return;
  const doc = root.ownerDocument || document;

  // Build flat text + (node, start) index from text nodes.
  function buildIndex() {
    const segs = [];
    let full = '';
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue || '';
      segs.push({ node, start: full.length, end: full.length + v.length });
      full += v;
    }
    return { full, segs };
  }

  for (const r of reds) {
    if (r.type !== 'text') continue;
    const { full, segs } = buildIndex();
    const range = locateTextRedaction(full, r.text, r.context_before, r.context_after);
    if (!range) continue;
    const [matchStart, matchEnd] = range;

    // Mutate the text nodes covering [matchStart, matchEnd).
    for (const seg of segs) {
      if (seg.end <= matchStart || seg.start >= matchEnd) continue;
      const localS = Math.max(0, matchStart - seg.start);
      const localE = Math.min(seg.node.nodeValue.length, matchEnd - seg.start);
      if (localE > localS) {
        const v = seg.node.nodeValue;
        seg.node.nodeValue = v.slice(0, localS) + '█'.repeat(localE - localS) + v.slice(localE);
      }
    }
  }
}

// Render an image to a canvas, burn opaque black rectangles where the
// redactions sit (coordinates are 0..1 relative to the natural image
// size), then export as a blob. We export as PNG for lossless masking;
// the original format is forgotten in favour of "the redaction is
// guaranteed opaque".
async function renderImageWithRectRedactions(blobUrl, rects, _mime) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Image failed to load for redaction.'));
    i.src = blobUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#000';
  for (const r of rects) {
    const x = Math.round(Math.max(0, Math.min(1, r.x)) * canvas.width);
    const y = Math.round(Math.max(0, Math.min(1, r.y)) * canvas.height);
    const w = Math.round(Math.max(0, Math.min(1, r.w)) * canvas.width);
    const h = Math.round(Math.max(0, Math.min(1, r.h)) * canvas.height);
    if (w > 0 && h > 0) ctx.fillRect(x, y, w, h);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Could not export redacted image.')), 'image/png');
  });
}

// Walk every open workspace's exhibits. For exhibits that cite the
// source and quote (or context-quote) any redacted text, replace the
// overlapping characters with █████ and flag `redaction_warning` so the
// detail modal can surface it. Matching is content-based — we search
// inside the exhibit's own (context_before + text + context_after)
// blob, so it works regardless of the offset spaces the redactions
// were captured in.
async function cascadeTextRedactionsToExhibits(source_id, textReds) {
  if (!source_id || !textReds || textReds.length === 0) return;
  const reds = textReds.filter((r) => r.type === 'text' && r.text);
  if (reds.length === 0) return;

  for (const [ws_id, session] of workspaceSessions.entries()) {
    if (!session || !session.state) continue;
    const exhibits = entitiesOfType(session.state, ENTITY.EXHIBIT) || [];
    for (const ex of exhibits) {
      if (ex.deleted) continue;
      if (ex.source_id !== source_id) continue;

      const ctxB = (ex.context_before || '').length;
      const exTextLen = (ex.text || '').length;
      const fullText = (ex.context_before || '') + (ex.text || '') + (ex.context_after || '');
      const masked = applyTextRedactionsToString(fullText, reds);
      if (masked === fullText) continue;

      const newContextBefore = masked.slice(0, ctxB);
      const newText          = masked.slice(ctxB, ctxB + exTextLen);
      const newContextAfter  = masked.slice(ctxB + exTextLen);

      try {
        await def(ws_id, ex._anchor, 'text', newText);
        await def(ws_id, ex._anchor, 'context_before', newContextBefore);
        await def(ws_id, ex._anchor, 'context_after', newContextAfter);
        await def(ws_id, ex._anchor, 'redaction_warning', true);
      } catch (e) {
        console.warn('[redact] failed to update exhibit', ex._anchor, e);
      }
    }
  }
}

// ── Source-snapshot helpers ──

// n8n writes title/description/filename into archive.org S3 headers, which
// reject any non-ASCII byte. Replace common Unicode punctuation, then drop
// the rest.
function asciiSafe(s) {
  if (!s) return '';
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[ --￿]/g, '')
    .trim();
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const slug = (u.hostname + u.pathname)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 80) || 'webpage';
    return slug + '.html';
  } catch (_) {
    return 'webpage.html';
  }
}

// Strip scripts/iframes/event handlers, resolve relative URLs against the
// source page, and extract a readable plaintext from <article>/<main>/<body>.
function sanitiseHtml(rawHtml, sourceUrl) {
  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(rawHtml, 'text/html');
  } catch (_) {
    return {
      html: '<html><body><pre>' + rawHtml.replace(/</g, '&lt;') + '</pre></body></html>',
      title: sourceUrl,
      filename: filenameFromUrl(sourceUrl),
      plaintext: rawHtml,
    };
  }

  doc.querySelectorAll('script, iframe, noscript, object, embed, link[rel="preload"][as="script"]').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((node) => {
    for (const a of [...node.attributes]) {
      if (a.name.startsWith('on')) node.removeAttribute(a.name);
      if (a.name === 'srcset') node.removeAttribute(a.name);
    }
  });

  let base;
  try { base = new URL(sourceUrl); } catch (_) { base = null; }
  if (base) {
    doc.querySelectorAll('[href]').forEach((n) => {
      try { n.setAttribute('href', new URL(n.getAttribute('href'), base).href); } catch (_) {}
    });
    doc.querySelectorAll('[src]').forEach((n) => {
      try { n.setAttribute('src', new URL(n.getAttribute('src'), base).href); } catch (_) {}
    });
    const baseTag = doc.createElement('base');
    baseTag.href = base.origin + '/';
    doc.head && doc.head.prepend(baseTag);
  }

  const title = (doc.querySelector('title') && doc.querySelector('title').textContent.trim()) || sourceUrl;
  const html = '<!doctype html>\n<!-- Snapshot captured ' + new Date().toISOString()
    + ' from ' + sourceUrl + ' by DraftEO -->\n' + doc.documentElement.outerHTML;

  let plaintextRoot = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  if (plaintextRoot && plaintextRoot !== doc.body) {
    // good — already a clean subtree
  } else if (doc.body) {
    const clone = doc.body.cloneNode(true);
    clone.querySelectorAll('nav, header, footer, aside, form, button, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]').forEach((n) => n.remove());
    plaintextRoot = clone;
  }
  const rawText = (plaintextRoot && (plaintextRoot.innerText || plaintextRoot.textContent) || '').trim();
  const plaintext = rawText
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      if (acc.length && acc[acc.length - 1] === line) return acc;
      acc.push(line);
      return acc;
    }, [])
    .join('\n');

  return { html, title, plaintext, filename: filenameFromUrl(sourceUrl) };
}

function documentCard(r, docEntity) {
  const body = docEntity?.body ?? '';
  // Version = count of edit-log entries. The history scrubber uses this
  // to label HEAD and to drive restoreToVersion(N).
  const editCount = Array.isArray(docEntity?._evaluations)
    ? docEntity._evaluations.filter((e) => e.criterion === 'edit').length
    : 0;
  return {
    id: r.roomId,
    workspace_id: r.meta?.workspace_id || null,
    title: docEntity?.title || r.name || '(untitled)',
    dek: docEntity?.dek || '',
    body_markdown: body,
    version: editCount + 1, // INS is v1; first edit moves us to v2
    stage: docEntity?.stage || 'drafting',
    footnotes: docEntity?.footnotes || {},
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
