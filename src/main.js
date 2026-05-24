// ============ ENTRY ============
// Boots Olm (WASM) and the Matrix client wrapper before any module that
// touches state. After this, the existing IIFE modules attach to window
// exactly as they did under plain <script> tags, but Store now talks to
// a real MatrixClient with crypto initialized instead of localStorage.

import './matrix-bootstrap.js';
import './matrix.js';
import './store.js';
import './eo.js';
import './markdown.js';
import './dom.js';
import './login.js';
import './projects.js';
import './sources.js';
import './history.js';
import './exporter.js';
import './corkboard.js';
import './search.js';
import './srcviewer.js';
import './editor.js';
import './workspace.js';
import './app.js';
