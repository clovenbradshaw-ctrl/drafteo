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
import { ins, def, getNamespace } from './operators.js';
import { fold, foldFrom, initial, entitiesOfType } from './fold.js';
import { EventStore } from './store.js';

export const ENTITY = Object.freeze({
  DOCUMENT: 'document',
  SOURCE: 'source',
});

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
 * Upload a file to the Matrix media repo and return its mxc:// URL.
 *
 * NOTE: this uploads via the standard media endpoint. The mxc URL is only
 * referenced from encrypted timeline events (the INS source event), so it
 * is not publicly discoverable, but the media bytes themselves are not
 * end-to-end encrypted yet. Per-file encrypted attachments are a follow-up.
 */
export async function uploadFile(file) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const resp = await client.uploadContent(file, {
    name: file.name,
    type: file.type || 'application/octet-stream',
  });
  // SDK returns either { content_uri } or just the string depending on version.
  const mxc = typeof resp === 'string' ? resp : (resp.content_uri || resp);
  return mxc;
}

/** Resolve mxc:// to a temporary http URL via the homeserver media proxy. */
export function mxcToHttp(mxc) {
  const client = getClient();
  if (!client || !mxc) return null;
  return client.mxcUrlToHttp(mxc);
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
  let filename = null;
  let contentType = null;
  let size = null;
  if (file) {
    mxc = await uploadFile(file);
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
