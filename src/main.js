// ============ ENTRY ============
//
// Boot order:
//
//   1. legacy-store.js — namespaces operators, installs recovery-key
//      hooks, kicks off restoreSession(), and publishes window.Store
//      with the API the old UI modules expect.
//   2. stubs.js        — placeholder window-globals for editor / corkboard
//      / sources / etc. so the unchanged old UI modules don't crash
//      before later phases restore the real implementations.
//   3. dom.js          — small DOM helper IIFE (window.DOM).
//   4. login.js        — login view IIFE (window.LoginView).
//   5. projects.js     — workspace list IIFE (window.WorkspaceView).
//   6. workspace.js    — workspace shell IIFE (window.WorkspaceShell).
//   7. app.js          — the router; reads window.Store and dispatches
//      between LoginView and WorkspaceView.
//
// The old modules are unchanged. Everything that used to be backed by
// localStorage + a custom Matrix wrapper is now backed by the bare-metal
// foundation (operators, fold, RoomSession, encrypted attachments)
// through the Store shim.

import './legacy-store.js';
import './stubs.js';

import './dom.js';
import './eo.js';
import './markdown.js';
import './login.js';
import './history.js';
import './editor.js';
import './projects.js';
import './workspace.js';
import './app.js';
