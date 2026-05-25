/**
 * model.js — DraftEO domain model on the bare-metal Matrix foundation.
 *
 *   Workspace → Matrix room, room_type "workspace"
 *   Document  → Matrix room, room_type "document", meta.workspace_id points home
 *   Body / title / stage → DEF events on the room's single "document" entity
 *
 * Edit history is just the operator log. Restore is a new DEF.
 */

import { getClient } from './client.js';
import {
  createRoom, discoverRooms, getMembers, invite as inviteUser,
  getTimeline, onTimeline, onDecrypted, loadTimelineSince,
} from './rooms.js';
import { ins, def, con, getNamespace } from './operators.js';
import { fold, foldFrom, initial, entitiesOfType } from './fold.js';
import { EventStore } from './store.js';
import { encryptAttachment, decryptAttachment } from 'matrix-encrypt-attachment';

export const ENTITY = Object.freeze({
  DOCUMENT: 'document',
  SOURCE: 'source',
  BOARD: 'board',
  CARD: 'card',
  EXHIBIT: 'exhibit',
});

export const RELATION = Object.freeze({
  CONNECTS:    'connects',
  SUPPORTS:    'supports',
  CONTRADICTS: 'contradicts',
  SEE_ALSO:    'see_also',
  FOLLOWS:     'follows_from',
});

export const RELATION_LABEL = {
  connects:     'connects',
  supports:     'supports',
  contradicts:  'contradicts',
  see_also:     'see also',
  follows_from: 'follows from',
};

export const ROOM_TYPE = Object.freeze({
  WORKSPACE: 'workspace',
  DOCUMENT: 'document',
});

export const STAGES = Object.freeze([
  'drafting', 'reporting', 'editing', 'ready', 'published',
]);

// ── Workspace / document discovery ──

export function listWorkspaces() {
  return discoverRooms(ROOM_TYPE.WORKSPACE);
}

export function listInvites() {
  return discoverRooms().filter((r) => r.membership === 'invite');
}

export function listDocuments(workspaceId) {
  return discoverRooms(ROOM_TYPE.DOCUMENT)
    .filter((r) => r.meta?.workspace_id === workspaceId);
}

export function getRoomName(roomId) {
  const client = getClient();
  return client?.getRoom(roomId)?.name || '';
}

export function getRoomMembers(roomId) {
  return getMembers(roomId);
}

export async function inviteToRoom(roomId, userId) {
  return inviteUser(roomId, userId);
}

// ── Creation ──

export async function createWorkspace(name) {
  const title = name?.trim() || 'Untitled workspace';
  return createRoom(title, ROOM_TYPE.WORKSPACE, { title });
}

export async function createDocument(workspaceId, title) {
  const t = title?.trim() || 'Untitled';
  const roomId = await createRoom(t, ROOM_TYPE.DOCUMENT, {
    workspace_id: workspaceId,
    title: t,
  });
  const anchor = await ins(roomId, ENTITY.DOCUMENT, {
    title: t,
    body: '',
    stage: 'drafting',
  });
  return { roomId, anchor };
}

// ── Document state derivation ──

/**
 * Pick the canonical document entity from a folded state.
 * Earliest-created wins so different clients agree.
 */
export function findDocEntity(state) {
  const docs = entitiesOfType(state, ENTITY.DOCUMENT);
  if (docs.length === 0) return null;
  return docs.reduce((a, b) => (a._created <= b._created ? a : b));
}

// ── Sources ──

/**
 * Encrypt a file and upload the ciphertext to the Matrix media repo.
 *
 * The plaintext never leaves the client. We upload AES-CTR ciphertext
 * (matrix-encrypt-attachment's "v2" format) and return both the mxc URL
 * and the encryption descriptor (key, iv, sha256 hash) that the
 * receiving client needs to decrypt. Both halves are then stored in the
 * encrypted INS source event — so an attacker who can read media but
 * not the room timeline cannot decrypt the file.
 */
export async function uploadFile(file) {
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
  return { mxc, encryption_info: info };
}

/** Resolve mxc:// to a temporary http URL via the homeserver media proxy. */
export function mxcToHttp(mxc) {
  const client = getClient();
  if (!client || !mxc) return null;
  return client.mxcUrlToHttp(mxc);
}

/**
 * Fetch a source's file and return an object URL the caller can open.
 *
 * If the source has encryption_info, the ciphertext is downloaded and
 * decrypted client-side; the resulting blob URL has the original
 * content_type so the browser renders it correctly. Legacy sources
 * (no encryption_info) get the direct mxc → http URL.
 *
 * Caller owns the returned URL: revoke it with URL.revokeObjectURL when
 * done.
 */
export async function openSourceObjectUrl(source) {
  if (!source?.mxc_url) return null;
  const httpUrl = mxcToHttp(source.mxc_url);
  if (!httpUrl) return null;
  if (!source.encryption_info) {
    // Legacy unencrypted source — hand back the direct URL.
    return { url: httpUrl, revoke: false };
  }
  const resp = await fetch(httpUrl);
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
  const ciphertext = await resp.arrayBuffer();
  const plaintext = await decryptAttachment(ciphertext, source.encryption_info);
  const blob = new Blob([plaintext], { type: source.content_type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  return { url, revoke: true };
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB cap for now

/**
 * Create a source attached to the current document room.
 *
 * Accepts either { file } (uploads first) or { url } (no upload).
 * Optional: title, description.
 */
export async function createSource(roomId, { file, url, title, description } = {}) {
  if (!file && !url) throw new Error('source needs either a file or a url');
  if (file && file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`file too large (max ${(MAX_UPLOAD_BYTES / 1024 / 1024) | 0} MB)`);
  }
  let mxc = null;
  let encryptionInfo = null;
  let filename = null;
  let contentType = null;
  let size = null;
  if (file) {
    const upload = await uploadFile(file);
    mxc = upload.mxc;
    encryptionInfo = upload.encryption_info;
    filename = file.name;
    contentType = file.type || 'application/octet-stream';
    size = file.size;
  }
  const payload = {
    title: (title || filename || url || 'Untitled source').trim(),
    filename,
    content_type: contentType,
    size,
    mxc_url: mxc,
    encryption_info: encryptionInfo,
    url: url || null,
    description: description || null,
    deleted: false,
  };
  return ins(roomId, ENTITY.SOURCE, payload);
}

/** Soft-delete a source via DEF (tombstone). Nothing is destroyed. */
export async function deleteSource(roomId, anchor) {
  return def(roomId, anchor, 'deleted', true);
}

/** Undelete (restore from bin). */
export async function restoreSource(roomId, anchor) {
  return def(roomId, anchor, 'deleted', false);
}

/** Update a source field (title / description / archive_org_url). */
export async function updateSourceField(roomId, anchor, field, value) {
  const allowed = ['title', 'description', 'archive_org_url'];
  if (!allowed.includes(field)) throw new Error(`field not editable: ${field}`);
  return def(roomId, anchor, field, value);
}

/** Live sources for a folded state: not-deleted, ordered by creation. */
export function listSources(state) {
  return entitiesOfType(state, ENTITY.SOURCE)
    .filter((s) => !s.deleted)
    .sort((a, b) => (a._created || 0) - (b._created || 0));
}

/** Sources marked deleted — surfaced as "Trash". */
export function listDeletedSources(state) {
  return entitiesOfType(state, ENTITY.SOURCE)
    .filter((s) => s.deleted)
    .sort((a, b) => (b._updated || 0) - (a._updated || 0));
}

/** Map source-anchor → source entity, for citation resolution. */
export function sourcesByAnchor(state) {
  const map = {};
  for (const s of entitiesOfType(state, ENTITY.SOURCE)) {
    map[s._anchor] = s;
  }
  return map;
}

// ── Boards & cards ──

export async function createBoard(workspaceId, title) {
  const t = (title || 'Untitled board').trim();
  return ins(workspaceId, ENTITY.BOARD, { title: t });
}

export async function renameBoard(workspaceId, anchor, title) {
  return def(workspaceId, anchor, 'title', (title || 'Untitled board').trim());
}

export async function deleteBoard(workspaceId, anchor) {
  return def(workspaceId, anchor, 'deleted', true);
}

export function listBoards(state) {
  return entitiesOfType(state, ENTITY.BOARD)
    .filter((b) => !b.deleted)
    .sort((a, b) => (a._created || 0) - (b._created || 0));
}

export async function createCard(workspaceId, boardAnchor, { label, text, x = 80, y = 80, color = null, source_ref = null } = {}) {
  return ins(workspaceId, ENTITY.CARD, {
    board_anchor: boardAnchor,
    label: (label || '').trim(),
    text: (text || '').trim(),
    pos: { x, y },
    color,
    source_ref,  // optional cross-room ref: { doc_room_id, source_anchor }
  });
}

export async function moveCard(workspaceId, cardAnchor, x, y) {
  return def(workspaceId, cardAnchor, 'pos', { x, y });
}

export async function updateCard(workspaceId, cardAnchor, field, value) {
  const allowed = ['label', 'text', 'color', 'source_ref'];
  if (!allowed.includes(field)) throw new Error(`field not editable: ${field}`);
  return def(workspaceId, cardAnchor, field, value);
}

export async function deleteCard(workspaceId, cardAnchor) {
  return def(workspaceId, cardAnchor, 'deleted', true);
}

export function listCards(state, boardAnchor) {
  return entitiesOfType(state, ENTITY.CARD)
    .filter((c) => !c.deleted && c.board_anchor === boardAnchor)
    .sort((a, b) => (a._created || 0) - (b._created || 0));
}

export async function connectCards(workspaceId, sourceAnchor, targetAnchor, relationType = RELATION.CONNECTS) {
  return con(workspaceId, sourceAnchor, targetAnchor, relationType);
}

/** Connections on a given board: both endpoints must be live cards in this board. */
export function listStrings(state, boardAnchor) {
  const cards = new Set(listCards(state, boardAnchor).map((c) => c._anchor));
  return state.connections.filter((c) => cards.has(c.source) && cards.has(c.target));
}

// ── Exhibits ──

export async function createExhibit(workspaceId, { label, text, doc_room_id = null, source_anchor = null } = {}) {
  return ins(workspaceId, ENTITY.EXHIBIT, {
    label: (label || '').trim(),
    text: (text || '').trim(),
    doc_room_id,
    source_anchor,
  });
}

export async function deleteExhibit(workspaceId, anchor) {
  return def(workspaceId, anchor, 'deleted', true);
}

export function listExhibits(state) {
  return entitiesOfType(state, ENTITY.EXHIBIT)
    .filter((e) => !e.deleted)
    .sort((a, b) => (b._created || 0) - (a._created || 0));
}

// ── History / replay ──

/**
 * The full event list for a session, read back from the OPFS store.
 * Returns events in chronological order.
 */
export async function getAllEvents(session) {
  if (!session?.store) return [];
  return session.store.getAll();
}

/**
 * The body-edit history for a document room.
 * Returns chronologically ordered { ts, value, sender } tuples — one per
 * DEF(body) event. The first INS may also supply an initial body via the
 * payload; that's emitted as a synthetic entry at the INS timestamp.
 */
export async function getBodyHistory(session) {
  const events = await getAllEvents(session);
  const ns = getNamespace();
  const insType = `${ns}.ins`;
  const defType = `${ns}.def`;
  const history = [];

  for (const e of events) {
    if (e.type === insType && e.content?.entity_type === ENTITY.DOCUMENT) {
      history.push({
        ts: e.origin_server_ts,
        value: e.content?.payload?.body ?? '',
        sender: e.sender,
        kind: 'init',
      });
    } else if (e.type === defType && e.content?.path === 'body') {
      history.push({
        ts: e.origin_server_ts,
        value: e.content?.value ?? '',
        sender: e.sender,
        kind: 'edit',
      });
    }
  }
  history.sort((a, b) => a.ts - b.ts);
  return history;
}

/**
 * Replay the fold up to (and including) `atTs` and return the body string
 * of the canonical document entity at that point. Returns null if no doc
 * existed yet at that time.
 */
export async function replayDocAt(session, atTs) {
  const events = await getAllEvents(session);
  const subset = events.filter((e) => (e.origin_server_ts ?? 0) <= atTs);
  const state = fold(subset);
  const doc = findDocEntity(state);
  return doc ? (doc.body ?? '') : null;
}

// ── Document mutations ──

export async function saveDocTitle(roomId, anchor, title) {
  const t = title || 'Untitled';
  await def(roomId, anchor, 'title', t);
  try {
    await getClient().setRoomName(roomId, t);
  } catch (e) {
    console.warn('setRoomName failed', e);
  }
}

export async function saveDocBody(roomId, anchor, body) {
  await def(roomId, anchor, 'body', body ?? '');
}

export async function saveDocStage(roomId, anchor, stage) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
  await def(roomId, anchor, 'stage', stage);
}

// ── RoomSession ──
//
// Encapsulates the bare-metal openRoom flow: OPFS store + checkpoint/delta fold
// + live listeners. One session per open room.

export class RoomSession {
  constructor(roomId) {
    this.roomId = roomId;
    this.store = null;
    this.state = initial();
    this._unsubTimeline = null;
    this._unsubDecrypted = null;
    this._handlers = new Set();
    this._closed = false;
  }

  async open({ onProgress } = {}) {
    const progress = onProgress || (() => {});
    this.store = new EventStore(this.roomId, getNamespace());
    await this.store.open();

    const storedCount = this.store.getCount();
    const cursor = this.store.getCursor();

    if (storedCount > 0) {
      const checkpoint = await this.store.loadCheckpoint();
      if (checkpoint && checkpoint.cursor <= cursor) {
        this.state = checkpoint.state;
        if (this.state._undecryptable === undefined) this.state._undecryptable = 0;
        if (!this.state._violations) this.state._violations = [];
        const delta = await this.store.getEventsSince(checkpoint.cursor);
        if (delta.length > 0) this.state = foldFrom(this.state, delta);
        progress(`restored checkpoint + ${delta.length} delta`);
      } else {
        progress(`full replay of ${storedCount} events`);
        const all = await this.store.getAll();
        this.state = fold(all);
        await this.store.saveCheckpoint(this.state);
      }
    }

    const { newEvents } = await loadTimelineSince(this.roomId, cursor);
    if (newEvents.length > 0) {
      // Give the SDK a beat to decrypt the freshly-arrived batch.
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = getTimeline(this.roomId);
      const filtered = cursor > 0
        ? fresh.filter((e) => {
            const ts = typeof e.getTs === 'function' ? e.getTs() : e.origin_server_ts || 0;
            return ts >= cursor;
          })
        : fresh;
      const added = await this.store.append(filtered);
      if (added.length > 0) {
        this.state = foldFrom(this.state, added);
        progress(`${added.length} new events synced`);
      }
    }

    if (this._closed) return this.state;

    this._unsubTimeline = onTimeline(this.roomId, async (event) => {
      if (this._closed || !this.store) return;
      const added = await this.store.append([event]);
      if (added.length === 0) return;
      this.state = foldFrom(this.state, added);
      this._notify();
      if (this.store.shouldCheckpoint()) {
        await this.store.saveCheckpoint(this.state);
      }
    });

    this._unsubDecrypted = onDecrypted(this.roomId, async (event) => {
      if (this._closed || !this.store) return;
      const added = await this.store.append([event]);
      if (added.length === 0) return;
      this.state = foldFrom(this.state, added);
      this._notify();
    });

    return this.state;
  }

  onUpdate(handler) {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  _notify() {
    for (const h of this._handlers) {
      try { h(this.state); } catch (e) { console.error(e); }
    }
  }

  async close() {
    this._closed = true;
    if (this.store && this.store.hasData()) {
      try { await this.store.saveCheckpoint(this.state); } catch (e) { console.warn(e); }
    }
    if (this._unsubTimeline) { this._unsubTimeline(); this._unsubTimeline = null; }
    if (this._unsubDecrypted) { this._unsubDecrypted(); this._unsubDecrypted = null; }
    this._handlers.clear();
  }
}
