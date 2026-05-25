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
  getBodyHistory, replayDocAt,
  createSource, deleteSource, restoreSource, updateSourceField,
  listSources, listDeletedSources, sourcesByAnchor, mxcToHttp, openSourceObjectUrl,
  createBoard, listBoards, renameBoard, deleteBoard,
  createCard, listCards, moveCard, updateCard, deleteCard,
  connectCards, listStrings, RELATION_LABEL,
  createExhibit, listExhibits, deleteExhibit,
  STAGES, ROOM_TYPE,
} from './model.js';
import { discoverRooms, onRoomChanges, acceptInvite } from './rooms.js';
import { marked } from 'marked';
import { exportMarkdown, exportHtml } from './export.js';

marked.setOptions({ gfm: true, breaks: false });

const $ = (id) => document.getElementById(id);

let log = () => {};
export function setLogger(fn) { log = fn; }

// ── Helper: switch which view is visible ──

const VIEW_IDS = ['view-auth', 'view-workspaces', 'view-workspace', 'view-editor', 'view-board'];
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
let workspaceSession = null;
let workspaceSessionUnsub = null;

export async function renderWorkspace(workspaceId, { onBack, onOpenDoc, onOpenBoard }) {
  showView('view-workspace');
  await leaveWorkspaceView();

  const ws = listWorkspaces().find((w) => w.roomId === workspaceId);
  $('wsTitle').textContent = ws?.name || getRoomName(workspaceId) || '(workspace)';
  $('wsBackBtn').onclick = async () => { await leaveWorkspaceView(); onBack(); };

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
      setTimeout(async () => { await leaveWorkspaceView(); onOpenDoc(roomId, workspaceId); }, 800);
    } catch (e) {
      log('create failed: ' + e.message, 'err');
    }
  };

  // Tabs
  document.querySelectorAll('#view-workspace .ws-tabs .tab').forEach((btn) => {
    btn.onclick = () => setWsTab(btn.dataset.wsTab);
  });
  setWsTab('docs');

  // Open the workspace room's session for board/exhibit state.
  workspaceSession = new RoomSession(workspaceId);
  try {
    await workspaceSession.open({ onProgress: (m) => log(m) });
  } catch (e) {
    log('open workspace failed: ' + e.message, 'err');
  }

  const refresh = () => {
    paintDocumentList(workspaceId, { onOpenDoc });
    paintMembers('wsMembers', workspaceId);
    if (workspaceSession) {
      paintBoardList(workspaceId, workspaceSession.state, { onOpenBoard });
      paintExhibitList(workspaceId, workspaceSession.state);
    }
  };
  refresh();
  if (unsubWorkspaceRoom) unsubWorkspaceRoom();
  unsubWorkspaceRoom = onRoomChanges(refresh);
  if (workspaceSession) {
    workspaceSessionUnsub = workspaceSession.onUpdate(refresh);
  }

  // Board / exhibit creation
  $('createBoardBtn').onclick = async () => {
    const name = $('newBoardName').value.trim() || 'Untitled board';
    try {
      const anchor = await createBoard(workspaceId, name);
      $('newBoardName').value = '';
      log('board created', 'ok');
      // Open it once it shows up in fold
      setTimeout(async () => {
        const here = workspaceSession?.state;
        if (here && here.entities[anchor]) {
          await leaveWorkspaceView();
          onOpenBoard(workspaceId, anchor);
        }
      }, 800);
    } catch (e) {
      log('create board failed: ' + e.message, 'err');
    }
  };
  $('createExhibitBtn').onclick = async () => {
    const label = $('newExhibitLabel').value.trim();
    const text = $('newExhibitText').value.trim();
    if (!label && !text) return;
    try {
      await createExhibit(workspaceId, { label, text });
      $('newExhibitLabel').value = '';
      $('newExhibitText').value = '';
      log('exhibit added', 'ok');
    } catch (e) {
      log('exhibit failed: ' + e.message, 'err');
    }
  };
}

function setWsTab(tab) {
  document.querySelectorAll('#view-workspace .ws-tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.wsTab === tab);
  });
  $('wsTabDocs').classList.toggle('hidden', tab !== 'docs');
  $('wsTabBoards').classList.toggle('hidden', tab !== 'boards');
  $('wsTabExhibits').classList.toggle('hidden', tab !== 'exhibits');
}

export async function leaveWorkspaceView() {
  if (unsubWorkspaceRoom) { unsubWorkspaceRoom(); unsubWorkspaceRoom = null; }
  if (workspaceSessionUnsub) { workspaceSessionUnsub(); workspaceSessionUnsub = null; }
  if (workspaceSession) {
    const s = workspaceSession;
    workspaceSession = null;
    await s.close();
  }
}

function paintBoardList(workspaceId, state, { onOpenBoard }) {
  const el = $('boardList');
  el.innerHTML = '';
  const boards = listBoards(state);
  if (boards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No corkboards yet.';
    el.appendChild(empty);
    return;
  }
  for (const b of boards) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const cardCount = listCards(state, b._anchor).length;
    item.innerHTML = `<span>${escapeHtml(b.title || 'Untitled')}</span><span class="dim">${cardCount} card${cardCount === 1 ? '' : 's'}</span>`;
    item.onclick = async () => { await leaveWorkspaceView(); onOpenBoard(workspaceId, b._anchor); };
    el.appendChild(item);
  }
}

function paintExhibitList(workspaceId, state) {
  const el = $('exhibitList');
  el.innerHTML = '';
  const exhibits = listExhibits(state);
  if (exhibits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No exhibits yet.';
    el.appendChild(empty);
    return;
  }
  for (const ex of exhibits) {
    const card = document.createElement('div');
    card.className = 'exhibit-card';
    card.innerHTML = `
      <div class="label">${escapeHtml(ex.label || 'Untitled')}</div>
      <div class="text">${escapeHtml(ex.text || '')}</div>
      <div class="actions"></div>
    `;
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.onclick = async () => {
      try { await deleteExhibit(workspaceId, ex._anchor); }
      catch (e) { log('delete failed: ' + e.message, 'err'); }
    };
    card.querySelector('.actions').appendChild(del);
    el.appendChild(card);
  }
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
let currentMode = 'edit';
let historyEntries = [];
let historyPreviewIdx = -1;

const SLASH_ITEMS = [
  { label: 'Heading 1',  hint: '/h1',     insert: '\n# ' },
  { label: 'Heading 2',  hint: '/h2',     insert: '\n## ' },
  { label: 'Heading 3',  hint: '/h3',     insert: '\n### ' },
  { label: 'Quote',      hint: '/quote',  insert: '\n> ' },
  { label: 'Bullet',     hint: '/list',   insert: '\n- ' },
  { label: 'Numbered',   hint: '/num',    insert: '\n1. ' },
  { label: 'Code block', hint: '/code',   insert: '\n```\n\n```\n' },
  { label: 'Citation',   hint: '/cite',   insert: '{{cite:}}' },
];

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
  const previewBody = $('previewBody');

  // Hard reset before async open so we never show stale doc state.
  titleInput.value = '';
  bodyInput.value = '';
  stageSelect.value = 'drafting';
  titleInput.disabled = true;
  bodyInput.disabled = true;
  stageSelect.disabled = true;
  status.textContent = 'opening…';
  $('docMembers').textContent = '—';
  previewBody.innerHTML = '';

  // Stage select options
  if (stageSelect.options.length === 0) {
    for (const s of STAGES) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      stageSelect.appendChild(opt);
    }
  }

  // Mode tabs
  setMode('edit');
  document.querySelectorAll('#view-editor .editor-tabs .tab').forEach((btn) => {
    btn.onclick = () => setMode(btn.dataset.mode, { roomId });
  });

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
    paintSources(roomId, state);
    if (currentMode === 'preview') renderPreviewBody(bodyInput.value, sourcesByAnchor(state));
  };

  applyState(editorSession.state);
  editorUnsub = editorSession.onUpdate(applyState);

  // Source pane controls
  $('sourceFile').onchange = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      log(`uploading ${file.name}…`);
      await createSource(roomId, { file });
      log(`source added`, 'ok');
    } catch (e) {
      log('upload failed: ' + e.message, 'err');
    }
    ev.target.value = '';
  };
  $('addUrlBtn').onclick = async () => {
    const url = $('sourceUrl').value.trim();
    if (!url) return;
    try {
      await createSource(roomId, { url, title: url });
      $('sourceUrl').value = '';
      log('url source added', 'ok');
    } catch (e) {
      log('add failed: ' + e.message, 'err');
    }
  };

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
    maybeShowSlashMenu(bodyInput);
  };
  bodyInput.onkeydown = (ev) => handleSlashKey(ev, bodyInput);
  bodyInput.onblur = () => setTimeout(() => hideSlashMenu(), 100);
  stageSelect.onchange = flush('stage');

  // Export
  $('exportBtn').onclick = () => openExportModal();

  // History UI handlers
  $('historyExitBtn').onclick = () => setMode('edit');
  $('historyRestoreBtn').onclick = async () => {
    if (historyPreviewIdx < 0 || !historyEntries[historyPreviewIdx]) return;
    const entry = historyEntries[historyPreviewIdx];
    const doc = findDocEntity(editorSession.state);
    if (!doc) return;
    if (!confirm(`Restore document to version from ${new Date(entry.ts).toLocaleString()}? This creates a new edit; nothing is destroyed.`)) return;
    try {
      status.textContent = 'restoring…';
      await saveDocBody(roomId, doc._anchor, entry.value);
      status.textContent = 'restored';
      log('restored historical version', 'ok');
      setMode('edit');
    } catch (e) {
      log('restore failed: ' + e.message, 'err');
      status.textContent = 'restore failed';
    }
  };
  $('historyScrub').oninput = (ev) => {
    const idx = parseInt(ev.target.value, 10);
    showHistoryAt(idx);
  };
}

export async function closeEditor() {
  clearTimeout(titleSaveTimer); titleSaveTimer = null;
  clearTimeout(bodySaveTimer); bodySaveTimer = null;
  hideSlashMenu();
  if (editorUnsub) { editorUnsub(); editorUnsub = null; }
  if (editorSession) {
    const s = editorSession;
    editorSession = null;
    await s.close();
  }
  historyEntries = [];
  historyPreviewIdx = -1;
  currentMode = 'edit';
}

// ── Editor mode switching ──

async function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('#view-editor .editor-tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('editorEdit').classList.toggle('hidden', mode !== 'edit');
  $('editorPreview').classList.toggle('hidden', mode !== 'preview');
  $('editorHistory').classList.toggle('hidden', mode !== 'history');

  if (mode === 'preview') {
    const map = editorSession ? sourcesByAnchor(editorSession.state) : {};
    renderPreviewBody($('docBody').value, map);
  } else if (mode === 'history') {
    await loadHistory();
  }
}

function renderPreviewBody(markdown, sourcesMap = {}) {
  const html = renderMarkdownWithCitations(markdown || '', sourcesMap);
  $('previewBody').innerHTML = html;
}

// ── Source pane rendering ──

function paintSources(roomId, state) {
  const live = listSources(state);
  const dead = listDeletedSources(state);
  const liveEl = $('sourceList');
  const deadEl = $('sourceTrash');
  liveEl.innerHTML = '';
  deadEl.innerHTML = '';

  if (live.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.padding = '6px 0';
    empty.textContent = 'No sources yet.';
    liveEl.appendChild(empty);
  } else {
    for (const s of live) liveEl.appendChild(renderSourceCard(roomId, s, false));
  }
  for (const s of dead) deadEl.appendChild(renderSourceCard(roomId, s, true));
}

function renderSourceCard(roomId, s, deleted) {
  const card = document.createElement('div');
  card.className = 'source-card';
  const meta = [];
  if (s.filename) meta.push(escapeHtml(s.filename));
  if (s.size) meta.push(formatBytes(s.size));
  if (s.url) meta.push(`<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">link</a>`);
  if (s.archive_org_url) meta.push(`<a href="${escapeHtml(s.archive_org_url)}" target="_blank" rel="noopener">archive</a>`);
  card.innerHTML = `
    <div class="title">${escapeHtml(s.title || 'Untitled')}</div>
    <div class="meta">${meta.join(' · ') || '—'}</div>
    <div class="actions"></div>
  `;
  const actions = card.querySelector('.actions');

  const citeBtn = document.createElement('button');
  citeBtn.textContent = 'Insert cite';
  citeBtn.title = 'Insert citation token at cursor';
  citeBtn.onclick = () => insertCiteAtCursor(s._anchor);
  actions.appendChild(citeBtn);

  if (s.mxc_url) {
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.onclick = async () => {
      openBtn.disabled = true;
      const oldLabel = openBtn.textContent;
      openBtn.textContent = 'opening…';
      try {
        const res = await openSourceObjectUrl(s);
        if (!res) throw new Error('no media URL');
        const win = window.open(res.url, '_blank', 'noopener');
        if (res.revoke) {
          // Keep the blob URL alive long enough for the new tab to load it,
          // then free the memory.
          setTimeout(() => URL.revokeObjectURL(res.url), 60_000);
        }
        if (!win) log('popup blocked — allow popups to open sources', 'err');
      } catch (e) {
        log('open failed: ' + e.message, 'err');
      } finally {
        openBtn.disabled = false;
        openBtn.textContent = oldLabel;
      }
    };
    actions.appendChild(openBtn);
  }

  if (s.url && !s.archive_org_url) {
    const archBtn = document.createElement('button');
    archBtn.textContent = 'Archive';
    archBtn.title = 'Open web.archive.org/save in a new tab, then paste the result back here';
    archBtn.onclick = async () => {
      const saveUrl = `https://web.archive.org/save/${encodeURI(s.url)}`;
      window.open(saveUrl, '_blank', 'noopener');
      const archived = prompt(
        'After the Wayback Machine finishes saving, copy the resulting URL\n' +
        '(it starts with https://web.archive.org/web/) and paste it here:',
        ''
      );
      if (!archived) return;
      try {
        await updateSourceField(roomId, s._anchor, 'archive_org_url', archived.trim());
        log('archive URL saved', 'ok');
      } catch (e) {
        log('save failed: ' + e.message, 'err');
      }
    };
    actions.appendChild(archBtn);
  }

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.onclick = async () => {
    const t = prompt('Title:', s.title || '');
    if (t == null) return;
    try { await updateSourceField(roomId, s._anchor, 'title', t.trim()); }
    catch (e) { log('rename failed: ' + e.message, 'err'); }
  };
  actions.appendChild(renameBtn);

  if (deleted) {
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = 'Restore';
    restoreBtn.onclick = async () => {
      try { await restoreSource(roomId, s._anchor); }
      catch (e) { log('restore failed: ' + e.message, 'err'); }
    };
    actions.appendChild(restoreBtn);
  } else {
    const trashBtn = document.createElement('button');
    trashBtn.textContent = 'Trash';
    trashBtn.onclick = async () => {
      try { await deleteSource(roomId, s._anchor); }
      catch (e) { log('trash failed: ' + e.message, 'err'); }
    };
    actions.appendChild(trashBtn);
  }
  return card;
}

function insertCiteAtCursor(anchor) {
  const ta = $('docBody');
  const token = `{{cite:${anchor}}}`;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  const caret = start + token.length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

// ── Board (corkboard) view ──

let boardSession = null;
let boardUnsub = null;
let currentBoardAnchor = null;
let boardConnectMode = false;
let boardConnectFrom = null;

export async function renderBoard(workspaceId, boardAnchor, { onBack }) {
  showView('view-board');
  await closeBoard();

  currentBoardAnchor = boardAnchor;
  boardConnectMode = false;
  boardConnectFrom = null;

  $('boardBackBtn').onclick = async () => { await closeBoard(); onBack(); };
  $('boardStatus').textContent = 'opening…';
  $('boardTitle').value = '';
  $('boardCanvas').classList.remove('connect-mode');

  boardSession = new RoomSession(workspaceId);
  try {
    await boardSession.open({ onProgress: (m) => log(m) });
  } catch (e) {
    log('open board failed: ' + e.message, 'err');
    $('boardStatus').textContent = 'error';
    return;
  }
  if (!boardSession) return;

  const board = boardSession.state.entities[boardAnchor];
  $('boardTitle').value = board?.title || 'Untitled board';
  $('boardStatus').textContent = 'ready';

  let titleTimer = null;
  $('boardTitle').oninput = () => {
    $('boardStatus').textContent = 'editing…';
    clearTimeout(titleTimer);
    titleTimer = setTimeout(async () => {
      try {
        $('boardStatus').textContent = 'saving…';
        await renameBoard(workspaceId, boardAnchor, $('boardTitle').value);
        $('boardStatus').textContent = 'saved';
      } catch (e) {
        log('save failed: ' + e.message, 'err');
        $('boardStatus').textContent = 'failed';
      }
    }, 1000);
  };

  $('boardAddCardBtn').onclick = async () => {
    const label = prompt('Card label:', '');
    if (label == null) return;
    const text = prompt('Card text / quote:', '') || '';
    const canvas = $('boardCanvas');
    const x = Math.random() * (canvas.clientWidth - 200) + 20;
    const y = Math.random() * (canvas.clientHeight - 120) + 20;
    try {
      await createCard(workspaceId, boardAnchor, { label, text, x, y });
    } catch (e) {
      log('add card failed: ' + e.message, 'err');
    }
  };

  $('boardConnectModeBtn').onclick = () => {
    boardConnectMode = !boardConnectMode;
    boardConnectFrom = null;
    $('boardCanvas').classList.toggle('connect-mode', boardConnectMode);
    $('boardConnectModeBtn').classList.toggle('primary', boardConnectMode);
    $('boardHint').textContent = boardConnectMode
      ? 'Click source card, then target card'
      : 'Click a card to drag · Connect mode then click two cards';
  };

  const refresh = () => paintBoard(workspaceId, boardAnchor, boardSession.state);
  refresh();
  boardUnsub = boardSession.onUpdate(refresh);
}

export async function closeBoard() {
  if (boardUnsub) { boardUnsub(); boardUnsub = null; }
  if (boardSession) {
    const s = boardSession;
    boardSession = null;
    await s.close();
  }
  currentBoardAnchor = null;
  boardConnectMode = false;
  boardConnectFrom = null;
}

function paintBoard(workspaceId, boardAnchor, state) {
  const canvas = $('boardCanvas');
  const svg = $('boardStrings');
  // Wipe everything except the SVG
  Array.from(canvas.querySelectorAll('.board-card')).forEach((el) => el.remove());
  svg.innerHTML = '';

  const cards = listCards(state, boardAnchor);
  const cardMap = {};
  for (const c of cards) cardMap[c._anchor] = c;

  // Cards
  for (const c of cards) {
    const el = document.createElement('div');
    el.className = 'board-card';
    if (c.color) el.style.borderLeft = `4px solid ${c.color}`;
    const pos = c.pos || { x: 40, y: 40 };
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    el.innerHTML = `
      <div class="card-label">${escapeHtml(c.label || '(no label)')}</div>
      <div class="card-text">${escapeHtml((c.text || '').slice(0, 200))}</div>
      <div class="card-actions"></div>
    `;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const label = prompt('Card label:', c.label || '');
      if (label != null) await updateCard(workspaceId, c._anchor, 'label', label.trim());
      const text = prompt('Card text:', c.text || '');
      if (text != null) await updateCard(workspaceId, c._anchor, 'text', text.trim());
    };
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Delete card';
    delBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this card?')) return;
      try { await deleteCard(workspaceId, c._anchor); }
      catch (e) { log('delete failed: ' + e.message, 'err'); }
    };
    el.querySelector('.card-actions').append(editBtn, delBtn);
    wireCardDrag(el, c, workspaceId);
    if (boardConnectFrom === c._anchor) el.classList.add('selected');
    canvas.appendChild(el);
  }

  // Strings (CON connections that link two cards in this board)
  const strings = listStrings(state, boardAnchor);
  const ns = 'http://www.w3.org/2000/svg';
  for (const s of strings) {
    const a = cardMap[s.source]; const b = cardMap[s.target];
    if (!a || !b) continue;
    const ax = (a.pos?.x ?? 40) + 90;
    const ay = (a.pos?.y ?? 40) + 35;
    const bx = (b.pos?.x ?? 40) + 90;
    const by = (b.pos?.y ?? 40) + 35;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', ax); line.setAttribute('y1', ay);
    line.setAttribute('x2', bx); line.setAttribute('y2', by);
    line.setAttribute('class', s.type || 'connects');
    svg.appendChild(line);
    // Label at midpoint
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', mx); text.setAttribute('y', my);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'label-text');
    text.textContent = RELATION_LABEL[s.type] || s.type || '';
    svg.appendChild(text);
  }
}

function wireCardDrag(el, card, workspaceId) {
  el.onmousedown = (ev) => {
    if (ev.target.tagName === 'BUTTON') return;
    if (boardConnectMode) {
      handleConnectClick(card, workspaceId);
      return;
    }
    const startX = ev.clientX;
    const startY = ev.clientY;
    const originX = card.pos?.x ?? 0;
    const originY = card.pos?.y ?? 0;
    el.classList.add('dragging');
    ev.preventDefault();

    const onMove = (e) => {
      const nx = Math.max(0, originX + (e.clientX - startX));
      const ny = Math.max(0, originY + (e.clientY - startY));
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
    };
    const onUp = async (e) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.classList.remove('dragging');
      const nx = Math.max(0, originX + (e.clientX - startX));
      const ny = Math.max(0, originY + (e.clientY - startY));
      if (Math.abs(nx - originX) > 2 || Math.abs(ny - originY) > 2) {
        try { await moveCard(workspaceId, card._anchor, nx, ny); }
        catch (err) { log('move failed: ' + err.message, 'err'); }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}

async function handleConnectClick(card, workspaceId) {
  if (!boardConnectFrom) {
    boardConnectFrom = card._anchor;
    $('boardHint').textContent = `From ${card.label || card._anchor.slice(-6)} — pick target card`;
    paintBoard(workspaceId, currentBoardAnchor, boardSession.state);
    return;
  }
  if (boardConnectFrom === card._anchor) {
    boardConnectFrom = null;
    $('boardHint').textContent = 'Click source card, then target card';
    paintBoard(workspaceId, currentBoardAnchor, boardSession.state);
    return;
  }
  try {
    const rel = $('boardRelation').value || 'connects';
    await connectCards(workspaceId, boardConnectFrom, card._anchor, rel);
    log(`string ${rel}: ${boardConnectFrom.slice(-6)} → ${card._anchor.slice(-6)}`, 'ok');
  } catch (e) {
    log('connect failed: ' + e.message, 'err');
  }
  boardConnectFrom = null;
  boardConnectMode = false;
  $('boardCanvas').classList.remove('connect-mode');
  $('boardConnectModeBtn').classList.remove('primary');
  $('boardHint').textContent = 'Click a card to drag · Connect mode then click two cards';
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ── Export modal ──

let exportFormat = 'markdown';

function openExportModal() {
  if (!editorSession) return;
  exportFormat = 'markdown';
  renderExport();
  $('exportModal').classList.remove('hidden');

  document.querySelectorAll('#exportModal .editor-tabs .tab').forEach((btn) => {
    btn.onclick = () => {
      exportFormat = btn.dataset.exportFormat;
      document.querySelectorAll('#exportModal .editor-tabs .tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.exportFormat === exportFormat);
      });
      renderExport();
    };
  });

  $('exportCloseBtn').onclick = () => $('exportModal').classList.add('hidden');
  $('exportCopyBtn').onclick = async () => {
    const text = $('exportOutput').value;
    try {
      await navigator.clipboard.writeText(text);
      log('copied to clipboard', 'ok');
    } catch (e) {
      log('clipboard not available; select+copy from the textarea', 'err');
    }
  };
  $('exportDownloadBtn').onclick = () => downloadExport();
}

function renderExport() {
  const doc = findDocEntity(editorSession.state);
  const body = doc?.body || '';
  const meta = { title: doc?.title || 'Untitled', dek: doc?.dek || '' };
  const sources = sourcesByAnchor(editorSession.state);
  const out = exportFormat === 'markdown'
    ? exportMarkdown(body, sources, meta)
    : exportHtml(body, sources, meta);
  $('exportOutput').value = out;
}

function downloadExport() {
  const doc = findDocEntity(editorSession.state);
  const title = (doc?.title || 'document').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'document';
  const ext = exportFormat === 'markdown' ? 'md' : 'html';
  const mime = exportFormat === 'markdown' ? 'text/markdown' : 'text/html';
  const blob = new Blob([$('exportOutput').value], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Render markdown to HTML, swapping {{cite:ID}} tokens for footnote refs.
// Returns HTML string. (Sources/footnote bodies arrive in a later slice.)
export function renderMarkdownWithCitations(md, sourcesByAnchor = null) {
  const cites = [];
  const replaced = md.replace(/\{\{cite:([^}]+)\}\}/g, (_, id) => {
    const idx = cites.indexOf(id);
    const n = idx === -1 ? cites.push(id) : idx + 1;
    return `[^${n}]`;
  });
  let html = marked.parse(replaced);
  // marked doesn't render `[^n]` outside `^[n]:` footnote definitions, so we
  // surface them as visible refs.
  html = html.replace(/\[\^(\d+)\]/g, (_, n) => `<sup class="cite-ref" title="citation">${n}</sup>`);
  if (cites.length > 0) {
    const items = cites.map((id, i) => {
      const src = sourcesByAnchor?.[id];
      const label = src?.title ? `${escapeHtml(src.title)}` : `<code>${escapeHtml(id)}</code>`;
      const url = src?.archive_org_url || src?.url || '';
      const link = url ? ` — <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>` : '';
      return `<li>${label}${link}</li>`;
    }).join('');
    html += `<div class="footnotes"><h3>Citations</h3><ol>${items}</ol></div>`;
  }
  return html;
}

// ── Slash menu ──

let slashAnchor = -1; // index of `/` in textarea, or -1 if no menu open
let slashSelectedIdx = 0;
let slashFiltered = [];

function maybeShowSlashMenu(textarea) {
  const v = textarea.value;
  const pos = textarea.selectionStart;
  // Find the most recent `/` since the previous whitespace.
  let i = pos - 1;
  let token = '';
  while (i >= 0 && !/[\s]/.test(v[i])) {
    token = v[i] + token;
    if (v[i] === '/') {
      slashAnchor = i;
      const filter = token.slice(1).toLowerCase();
      slashFiltered = SLASH_ITEMS.filter((it) =>
        it.label.toLowerCase().includes(filter) || it.hint.includes(filter)
      );
      if (slashFiltered.length === 0) { hideSlashMenu(); return; }
      slashSelectedIdx = 0;
      paintSlashMenu(textarea);
      return;
    }
    i--;
  }
  hideSlashMenu();
}

function paintSlashMenu(textarea) {
  const menu = $('slashMenu');
  menu.innerHTML = slashFiltered.map((it, i) =>
    `<div class="item${i === slashSelectedIdx ? ' selected' : ''}" data-i="${i}"><span>${escapeHtml(it.label)}</span><span class="hint">${escapeHtml(it.hint)}</span></div>`
  ).join('');
  // Position roughly under the textarea start; good enough for an MVP.
  menu.style.left = '8px';
  menu.style.top = (textarea.offsetTop + 32) + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.item').forEach((el) => {
    el.onmousedown = (ev) => {
      ev.preventDefault();
      slashSelectedIdx = parseInt(el.dataset.i, 10);
      commitSlash(textarea);
    };
  });
}

function hideSlashMenu() {
  slashAnchor = -1;
  slashFiltered = [];
  $('slashMenu')?.classList.add('hidden');
}

function handleSlashKey(ev, textarea) {
  if (slashAnchor < 0) return;
  if (ev.key === 'Escape') { hideSlashMenu(); return; }
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    slashSelectedIdx = (slashSelectedIdx + 1) % slashFiltered.length;
    paintSlashMenu(textarea);
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    slashSelectedIdx = (slashSelectedIdx - 1 + slashFiltered.length) % slashFiltered.length;
    paintSlashMenu(textarea);
  } else if (ev.key === 'Enter' || ev.key === 'Tab') {
    ev.preventDefault();
    commitSlash(textarea);
  }
}

function commitSlash(textarea) {
  if (slashAnchor < 0) { hideSlashMenu(); return; }
  const item = slashFiltered[slashSelectedIdx];
  if (!item) { hideSlashMenu(); return; }
  const before = textarea.value.slice(0, slashAnchor);
  const after = textarea.value.slice(textarea.selectionStart);
  textarea.value = before + item.insert + after;
  const caret = (before + item.insert).length;
  textarea.setSelectionRange(caret, caret);
  hideSlashMenu();
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
}

// ── History view ──

async function loadHistory() {
  $('historyLabel').textContent = 'loading history…';
  $('historyPreview').innerHTML = '';
  $('historyRestoreBtn').disabled = true;
  historyEntries = await getBodyHistory(editorSession);

  const scrub = $('historyScrub');
  scrub.min = 0;
  scrub.max = Math.max(0, historyEntries.length - 1);

  // Default to current (last) version
  const last = historyEntries.length - 1;
  scrub.value = String(Math.max(0, last));
  paintHistoryTicks();
  if (last >= 0) {
    showHistoryAt(last);
  } else {
    $('historyLabel').textContent = 'no history yet';
  }
}

function paintHistoryTicks() {
  const el = $('historyTicks');
  el.innerHTML = '';
  if (historyEntries.length === 0) return;
  const first = historyEntries[0].ts;
  const last = historyEntries[historyEntries.length - 1].ts;
  const span = Math.max(1, last - first);
  for (const e of historyEntries) {
    const pct = ((e.ts - first) / span) * 100;
    const tick = document.createElement('div');
    tick.className = 'tick' + (e.kind === 'init' ? ' init' : '');
    tick.style.left = pct + '%';
    tick.title = new Date(e.ts).toLocaleString();
    el.appendChild(tick);
  }
}

async function showHistoryAt(idx) {
  if (idx < 0 || idx >= historyEntries.length) return;
  historyPreviewIdx = idx;
  const entry = historyEntries[idx];
  const isLatest = idx === historyEntries.length - 1;
  $('historyLabel').textContent =
    `${idx + 1} / ${historyEntries.length} · ${new Date(entry.ts).toLocaleString()} · ${entry.sender || 'unknown'}${isLatest ? ' (current)' : ''}`;
  // Replay fold up to this entry's ts so the preview matches what fold would
  // have produced (handles deletes, body restores, etc.).
  const body = await replayDocAt(editorSession, entry.ts);
  const map = sourcesByAnchor(editorSession.state);
  $('historyPreview').innerHTML = renderMarkdownWithCitations(body || '', map);
  $('historyRestoreBtn').disabled = isLatest;
}

// ── util ──

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
