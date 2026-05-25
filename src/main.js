/**
 * main.js — DraftEO entry point
 *
 * Boots the Matrix client, restores session if any, and routes between
 * three views: workspaces, single workspace, editor.
 */

import {
  login, restoreSession, logout, getClient,
  setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider,
} from './client.js';
import { setNamespace } from './operators.js';
import {
  setLogger, showView,
  renderWorkspaces, leaveWorkspacesView,
  renderWorkspace, leaveWorkspaceView,
  renderEditor, closeEditor,
} from './views.js';

// ── App namespace ──
// All custom event types and the room-meta state key live under this prefix.
setNamespace('com.intelechia.drafteo');

const $ = (id) => document.getElementById(id);

// ── Logging ──
function log(msg, cls = '') {
  const el = $('log');
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.innerHTML += `<div class="${cls}">[${t}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}
setLogger(log);
setProgress((m) => log(m));

// ── Recovery key UX ──
setRecoveryKeyDisplayer((key) => new Promise((resolve) => {
  $('recoveryKeyText').textContent = key;
  $('recoveryDisplayModal').classList.remove('hidden');
  const ack = () => {
    $('recoveryDisplayModal').classList.add('hidden');
    $('recoveryDisplayAck').removeEventListener('click', ack);
    resolve();
  };
  $('recoveryDisplayAck').addEventListener('click', ack);
}));

setRecoveryKeyProvider(() => new Promise((resolve) => {
  $('recoveryKeyInput').value = '';
  $('recoveryEntryModal').classList.remove('hidden');
  const cleanup = () => {
    $('recoveryEntryModal').classList.add('hidden');
    $('recoveryEntrySubmit').removeEventListener('click', submit);
    $('recoveryEntrySkip').removeEventListener('click', skip);
  };
  const submit = () => {
    const v = $('recoveryKeyInput').value.trim();
    cleanup();
    resolve(v || null);
  };
  const skip = () => { cleanup(); resolve(null); };
  $('recoveryEntrySubmit').addEventListener('click', submit);
  $('recoveryEntrySkip').addEventListener('click', skip);
}));

// ── Router ──

const view = { name: 'auth', workspaceId: null, docRoomId: null };

async function goAuth() {
  await leaveCurrentView();
  view.name = 'auth';
  showView('view-auth');
  $('userBar').classList.add('hidden');
}

async function goWorkspaces() {
  await leaveCurrentView();
  view.name = 'workspaces';
  view.workspaceId = null;
  view.docRoomId = null;
  $('userBar').classList.remove('hidden');
  renderWorkspaces({ onOpen: (wsId) => goWorkspace(wsId) });
}

async function goWorkspace(workspaceId) {
  await leaveCurrentView();
  view.name = 'workspace';
  view.workspaceId = workspaceId;
  view.docRoomId = null;
  $('userBar').classList.remove('hidden');
  renderWorkspace(workspaceId, {
    onBack: () => goWorkspaces(),
    onOpenDoc: (docRoomId, wsId) => goEditor(docRoomId, wsId),
  });
}

async function goEditor(docRoomId, workspaceId) {
  await leaveCurrentView();
  view.name = 'editor';
  view.docRoomId = docRoomId;
  view.workspaceId = workspaceId;
  $('userBar').classList.remove('hidden');
  await renderEditor(docRoomId, workspaceId, {
    onBack: () => goWorkspace(workspaceId),
  });
}

async function leaveCurrentView() {
  switch (view.name) {
    case 'workspaces': leaveWorkspacesView(); break;
    case 'workspace': leaveWorkspaceView(); break;
    case 'editor': await closeEditor(); break;
  }
}

// ── Auth handlers ──

async function handleLogin() {
  const rawUser = $('inUser').value.trim();
  const pass = $('inPass').value;
  let hs = $('inHS').value.trim();

  if (rawUser.includes(':')) {
    hs = 'https://' + rawUser.split(':').slice(1).join(':');
  }
  if (!hs) {
    log('Homeserver required', 'err');
    return;
  }

  log('logging in…');
  try {
    const { userId } = await login(hs, rawUser, pass);
    $('userDisplay').textContent = userId;
    log('connected as ' + userId, 'ok');
    await goWorkspaces();
  } catch (e) {
    log('login failed: ' + e.message, 'err');
  }
}

async function handleLogout() {
  try {
    await leaveCurrentView();
    await logout();
  } catch (e) {
    log('logout error: ' + e.message, 'err');
  }
  await goAuth();
  log('logged out');
}

// ── Boot ──

window.addEventListener('DOMContentLoaded', async () => {
  $('loginBtn').addEventListener('click', handleLogin);
  $('logoutBtn').addEventListener('click', handleLogout);

  // Toggle homeserver field when MXID includes the homeserver
  const userInput = $('inUser');
  userInput.addEventListener('input', () => {
    const v = userInput.value.trim();
    const hsField = $('hsField');
    hsField.classList.toggle('hidden', v.includes(':'));
    if (v.includes(':')) {
      $('inHS').value = 'https://' + v.split(':').slice(1).join(':');
    }
  });

  const client = await restoreSession();
  if (client) {
    $('userDisplay').textContent = client.getUserId();
    log('restored session ' + client.getUserId(), 'ok');
    await goWorkspaces();
  } else {
    await goAuth();
  }
});
