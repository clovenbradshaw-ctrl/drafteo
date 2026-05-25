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
