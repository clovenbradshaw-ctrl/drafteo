/**
 * views.js — DraftEO view renderers
 *
 * Three views: workspaces list, single workspace (doc list + members),
 * editor (title + stage + body, autosaved via DEF).
 *
 * Each render*() wires its own event handlers. Navigation goes through
 * the router functions exposed by main.js (showWorkspaces, showWorkspace,
 * showEditor).
 */

import {
  listWorkspaces, listInvites, listDocuments,
  createWorkspace, createDocument,
  getRoomName, getRoomMembers, inviteToRoom,
  RoomSession, findDocEntity, saveDocTitle, saveDocBody, saveDocStage,
  STAGES, ROOM_TYPE,
} from './model.js';
import { discoverRooms, onRoomChanges, acceptInvite } from './rooms.js';

const $ = (id) => document.getElementById(id);

let log = () => {};
export function setLogger(fn) { log = fn; }

// ── Helper: switch which view is visible ──

const VIEW_IDS = ['view-auth', 'view-workspaces', 'view-workspace', 'view-editor'];
export function showView(id) {
  for (const v of VIEW_IDS) $(v).classList.toggle('hidden', v !== id);
}

// ── Workspaces view ──

let unsubWorkspaces = null;

export function renderWorkspaces({ onOpen }) {
  showView('view-workspaces');
  $('createWorkspaceBtn').onclick = async () => {
    const name = $('newWorkspaceName').value.trim();
    if (!name) return;
    try {
      log(`creating workspace "${name}"…`);
      const roomId = await createWorkspace(name);
      $('newWorkspaceName').value = '';
      log(`workspace created`, 'ok');
      // Wait briefly for state to sync back.
      setTimeout(() => onOpen(roomId), 800);
    } catch (e) {
      log('create failed: ' + e.message, 'err');
    }
  };

  const refresh = () => paintWorkspaceList({ onOpen });
  refresh();
  if (unsubWorkspaces) unsubWorkspaces();
  unsubWorkspaces = onRoomChanges(refresh);
}

export function leaveWorkspacesView() {
  if (unsubWorkspaces) { unsubWorkspaces(); unsubWorkspaces = null; }
}

function paintWorkspaceList({ onOpen }) {
  const list = $('workspaceList');
  list.innerHTML = '';

  const invites = listInvites();
  if (invites.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'list-heading';
    heading.textContent = 'Pending invites';
    list.appendChild(heading);
    for (const inv of invites) {
      const item = document.createElement('div');
      item.className = 'list-item list-item--invite';
      const from = inv.inviter ? ` from ${inv.inviter}` : '';
      item.innerHTML = `<span>${escapeHtml(inv.name)}</span><span class="dim">invite${escapeHtml(from)}</span>`;
      item.onclick = async () => {
        try {
          log(`accepting invite to ${inv.name}…`);
          await acceptInvite(inv.roomId);
          log('joined', 'ok');
        } catch (e) {
          log('accept failed: ' + e.message, 'err');
        }
      };
      list.appendChild(item);
    }
  }

  const workspaces = listWorkspaces();
  if (workspaces.length === 0 && invites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No workspaces yet. Create one below.';
    list.appendChild(empty);
    return;
  }

  if (workspaces.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'list-heading';
    heading.textContent = 'Workspaces';
    list.appendChild(heading);
    for (const ws of workspaces) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const docCount = listDocuments(ws.roomId).length;
      item.innerHTML = `<span>${escapeHtml(ws.name || '(untitled)')}</span><span class="dim">${docCount} doc${docCount === 1 ? '' : 's'}</span>`;
      item.onclick = () => onOpen(ws.roomId);
      list.appendChild(item);
    }
  }
}

// ── Single workspace view ──

let unsubWorkspaceRoom = null;

export function renderWorkspace(workspaceId, { onBack, onOpenDoc }) {
  showView('view-workspace');
  const ws = listWorkspaces().find((w) => w.roomId === workspaceId);
  $('wsTitle').textContent = ws?.name || getRoomName(workspaceId) || '(workspace)';
  $('wsBackBtn').onclick = onBack;

  $('wsInviteBtn').onclick = async () => {
    const userId = prompt('Invite user (full MXID, e.g. @kevin:hyphae.social):', '@');
    if (!userId || !userId.includes(':')) return;
    try {
      await inviteToRoom(workspaceId, userId);
      log(`invited ${userId} to workspace`, 'ok');
      paintMembers('wsMembers', workspaceId);
    } catch (e) {
      log('invite failed: ' + e.message, 'err');
    }
  };

  $('createDocBtn').onclick = async () => {
    const title = $('newDocName').value.trim() || 'Untitled';
    try {
      log(`creating document "${title}"…`);
      const { roomId } = await createDocument(workspaceId, title);
      $('newDocName').value = '';
      log('document created', 'ok');
      setTimeout(() => onOpenDoc(roomId, workspaceId), 800);
    } catch (e) {
      log('create failed: ' + e.message, 'err');
    }
  };

  const refresh = () => {
    paintDocumentList(workspaceId, { onOpenDoc });
    paintMembers('wsMembers', workspaceId);
  };
  refresh();
  if (unsubWorkspaceRoom) unsubWorkspaceRoom();
  unsubWorkspaceRoom = onRoomChanges(refresh);
}

export function leaveWorkspaceView() {
  if (unsubWorkspaceRoom) { unsubWorkspaceRoom(); unsubWorkspaceRoom = null; }
}

function paintDocumentList(workspaceId, { onOpenDoc }) {
  const list = $('documentList');
  list.innerHTML = '';
  const docs = listDocuments(workspaceId);
  if (docs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No documents yet.';
    list.appendChild(empty);
    return;
  }
  for (const d of docs) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<span>${escapeHtml(d.name || '(untitled)')}</span><span class="dim">${escapeHtml(d.meta?.stage || '')}</span>`;
    item.onclick = () => onOpenDoc(d.roomId, workspaceId);
    list.appendChild(item);
  }
}

function paintMembers(elId, roomId) {
  const members = getRoomMembers(roomId);
  const txt = members.map((m) => m.displayName).join(', ') || 'just you';
  $(elId).textContent = txt;
}

// ── Editor view ──

let editorSession = null;
let editorUnsub = null;
let titleSaveTimer = null;
let bodySaveTimer = null;

export async function renderEditor(roomId, workspaceId, { onBack }) {
  showView('view-editor');

  // Clean up any prior session before starting a new one.
  await closeEditor();

  $('docBackBtn').onclick = async () => {
    await closeEditor();
    onBack();
  };

  const titleInput = $('docTitle');
  const bodyInput = $('docBody');
  const stageSelect = $('docStage');
  const status = $('saveStatus');

  // Hard reset before async open so we never show stale doc state.
  titleInput.value = '';
  bodyInput.value = '';
  stageSelect.value = 'drafting';
  titleInput.disabled = true;
  bodyInput.disabled = true;
  stageSelect.disabled = true;
  status.textContent = 'opening…';
  $('docMembers').textContent = '—';

  // Stage select options
  if (stageSelect.options.length === 0) {
    for (const s of STAGES) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      stageSelect.appendChild(opt);
    }
  }

  editorSession = new RoomSession(roomId);
  try {
    await editorSession.open({ onProgress: (m) => log(m) });
  } catch (e) {
    log('failed to open document: ' + e.message, 'err');
    status.textContent = 'error';
    return;
  }
  if (!editorSession) return; // closed mid-open

  paintMembers('docMembers', roomId);

  $('docInviteBtn').onclick = async () => {
    const userId = prompt('Invite user (full MXID, e.g. @kevin:hyphae.social):', '@');
    if (!userId || !userId.includes(':')) return;
    try {
      await inviteToRoom(roomId, userId);
      log(`invited ${userId} to document`, 'ok');
      paintMembers('docMembers', roomId);
    } catch (e) {
      log('invite failed: ' + e.message, 'err');
    }
  };

  const applyState = (state) => {
    const doc = findDocEntity(state);
    if (!doc) {
      status.textContent = 'preparing…';
      return;
    }
    if (titleInput.disabled) {
      titleInput.value = doc.title || '';
      titleInput.disabled = false;
    } else if (document.activeElement !== titleInput) {
      titleInput.value = doc.title || '';
    }
    if (bodyInput.disabled) {
      bodyInput.value = doc.body || '';
      bodyInput.disabled = false;
    } else if (document.activeElement !== bodyInput) {
      bodyInput.value = doc.body || '';
    }
    if (stageSelect.disabled) {
      stageSelect.value = doc.stage || 'drafting';
      stageSelect.disabled = false;
    } else if (document.activeElement !== stageSelect) {
      stageSelect.value = doc.stage || 'drafting';
    }
    status.textContent = 'saved';
    paintMembers('docMembers', roomId);
  };

  applyState(editorSession.state);
  editorUnsub = editorSession.onUpdate(applyState);

  // ── Save handlers (debounced) ──
  const flush = (kind) => async () => {
    const doc = findDocEntity(editorSession.state);
    if (!doc) return;
    status.textContent = 'saving…';
    try {
      if (kind === 'title') {
        await saveDocTitle(roomId, doc._anchor, titleInput.value);
      } else if (kind === 'body') {
        await saveDocBody(roomId, doc._anchor, bodyInput.value);
      } else if (kind === 'stage') {
        await saveDocStage(roomId, doc._anchor, stageSelect.value);
      }
      status.textContent = 'saved';
    } catch (e) {
      log('save failed: ' + e.message, 'err');
      status.textContent = 'save failed';
    }
  };

  titleInput.oninput = () => {
    status.textContent = 'editing…';
    clearTimeout(titleSaveTimer);
    titleSaveTimer = setTimeout(flush('title'), 1200);
  };
  bodyInput.oninput = () => {
    status.textContent = 'editing…';
    clearTimeout(bodySaveTimer);
    bodySaveTimer = setTimeout(flush('body'), 1200);
  };
  stageSelect.onchange = flush('stage');
}

export async function closeEditor() {
  clearTimeout(titleSaveTimer); titleSaveTimer = null;
  clearTimeout(bodySaveTimer); bodySaveTimer = null;
  if (editorUnsub) { editorUnsub(); editorUnsub = null; }
  if (editorSession) {
    const s = editorSession;
    editorSession = null;
    await s.close();
  }
}

// ── util ──

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
