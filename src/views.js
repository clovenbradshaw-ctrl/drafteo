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
  STAGES, ROOM_TYPE,
} from './model.js';
import { discoverRooms, onRoomChanges, acceptInvite } from './rooms.js';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

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
    if (currentMode === 'preview') renderPreviewBody(bodyInput.value);
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
    maybeShowSlashMenu(bodyInput);
  };
  bodyInput.onkeydown = (ev) => handleSlashKey(ev, bodyInput);
  bodyInput.onblur = () => setTimeout(() => hideSlashMenu(), 100);
  stageSelect.onchange = flush('stage');

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
    renderPreviewBody($('docBody').value);
  } else if (mode === 'history') {
    await loadHistory();
  }
}

function renderPreviewBody(markdown) {
  const html = renderMarkdownWithCitations(markdown || '');
  $('previewBody').innerHTML = html;
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
  $('historyPreview').innerHTML = renderMarkdownWithCitations(body || '');
  $('historyRestoreBtn').disabled = isLatest;
}

// ── util ──

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
