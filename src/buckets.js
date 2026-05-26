// ============ BUCKETS ============
//
// Workspace-scoped grouping for exhibits. Each exhibit can belong to
// 0 or 1 primary bucket; tags (already on the source entity) handle
// cross-cutting groupings.
//
// Phase 1 (this file): buckets + bucket assignments live in localStorage,
//   scoped by workspace id. Synchronous, no Matrix involvement. This is
//   enough to ship the UI feature; collaborators on the same workspace
//   won't see each other's buckets yet.
//
// Phase 2 (planned): lift to Matrix entities in legacy-store.js — INS a
//   'bucket' entity per workspace, DEF a 'bucket_id' field on each source.
//   The function signatures here are intentionally async-shaped so the
//   migration only swaps internals.
//
// Mounted as window.Buckets BEFORE exhibitsindex.js so the Exhibits tab
// can render bucket-grouped lists.

(function () {
  const KEY_BUCKETS = (ws_id) => 'drafteo.buckets.' + ws_id;
  const KEY_ASSIGN  = (ws_id) => 'drafteo.source_bucket.' + ws_id;

  function emit(ws_id) {
    try {
      window.dispatchEvent(new CustomEvent('drafteo:buckets-updated', { detail: { ws_id } }));
    } catch (_) {}
  }

  function genId() {
    return 'bkt_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function readBuckets(ws_id) {
    if (!ws_id) return [];
    try {
      const raw = localStorage.getItem(KEY_BUCKETS(ws_id));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function writeBuckets(ws_id, arr) {
    try { localStorage.setItem(KEY_BUCKETS(ws_id), JSON.stringify(arr)); } catch (_) {}
  }

  function readAssigns(ws_id) {
    if (!ws_id) return {};
    try {
      const raw = localStorage.getItem(KEY_ASSIGN(ws_id));
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  }
  function writeAssigns(ws_id, obj) {
    try { localStorage.setItem(KEY_ASSIGN(ws_id), JSON.stringify(obj)); } catch (_) {}
  }

  // ── Bucket CRUD ────────────────────────────────────────────────────
  function listBuckets(ws_id) {
    return readBuckets(ws_id)
      .filter(b => b && !b.deleted)
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  }

  function getBucket(ws_id, bucket_id) {
    if (!bucket_id) return null;
    return readBuckets(ws_id).find(b => b.id === bucket_id) || null;
  }

  async function createBucket(ws_id, patch) {
    const name = ((patch && patch.name) || '').trim() || 'New bucket';
    let prefix = ((patch && patch.prefix) || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 6);
    if (!prefix) prefix = autoPrefixFrom(name);
    const bucket = {
      id: genId(),
      name,
      prefix,
      color: (patch && patch.color) || '',
      created_at: Date.now(),
      deleted: false,
    };
    const arr = readBuckets(ws_id);
    arr.push(bucket);
    writeBuckets(ws_id, arr);
    emit(ws_id);
    return bucket;
  }

  function autoPrefixFrom(name) {
    // "Plaintiff exhibits" → "PX"  ·  "Defendant" → "DX"  ·  "Witness statements" → "WS"
    const cleaned = String(name || '').replace(/[^a-zA-Z ]/g, '').trim();
    if (!cleaned) return 'EX';
    const words = cleaned.split(/\s+/);
    if (words.length === 1) return (words[0].slice(0, 2)).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  async function updateBucket(ws_id, bucket_id, patch) {
    const arr = readBuckets(ws_id);
    const b = arr.find(x => x.id === bucket_id);
    if (!b) return null;
    if (patch && typeof patch.name === 'string') b.name = patch.name.trim();
    if (patch && typeof patch.prefix === 'string') {
      b.prefix = patch.prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 6) || autoPrefixFrom(b.name);
    }
    if (patch && typeof patch.color === 'string') b.color = patch.color;
    writeBuckets(ws_id, arr);
    emit(ws_id);
    return b;
  }

  async function deleteBucket(ws_id, bucket_id) {
    const arr = readBuckets(ws_id);
    const b = arr.find(x => x.id === bucket_id);
    if (!b) return;
    b.deleted = true;
    writeBuckets(ws_id, arr);
    // Unassign every source from this bucket
    const a = readAssigns(ws_id);
    for (const k of Object.keys(a)) if (a[k] === bucket_id) delete a[k];
    writeAssigns(ws_id, a);
    emit(ws_id);
  }

  // ── Source ↔ Bucket assignment ─────────────────────────────────────
  function getSourceBucket(ws_id, source_id) {
    if (!ws_id || !source_id) return null;
    const a = readAssigns(ws_id);
    return a[source_id] || null;
  }

  async function setSourceBucket(ws_id, source_id, bucket_id) {
    if (!ws_id || !source_id) return;
    const a = readAssigns(ws_id);
    if (bucket_id) {
      // Verify the bucket exists
      const b = getBucket(ws_id, bucket_id);
      if (!b) return;
      a[source_id] = bucket_id;
    } else {
      delete a[source_id];
    }
    writeAssigns(ws_id, a);
    emit(ws_id);
  }

  // ── Lettering ──────────────────────────────────────────────────────
  // For an exhibit at `index` within its bucket (or within the
  // unbucketed pool when no bucket given), return its label.
  //
  //   letterFor(null,  0)              → "A"        (unbucketed)
  //   letterFor({prefix:'PX'}, 0)      → "PX-A"
  //   letterFor({prefix:''},   2)      → "C"        (bucket with no prefix)
  function letterFor(bucket, index) {
    if (index < 0) return '?';
    let n = index;
    let letters = '';
    while (true) {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    if (bucket && bucket.prefix) return bucket.prefix + '-' + letters;
    return letters;
  }

  // ── Group exhibits by bucket, assign letters ──────────────────────
  //
  // Input: array of source records (`{source, doc, doc_id, source_id}`)
  // Output: { groups: [{bucket, recs:[...]}], unbucketed: [recs] }
  //
  // Each rec gets a `letter` and `bucket` set on it. Records are sorted
  // by source.uploaded_at within their bucket so lettering is stable
  // across re-renders.
  function groupExhibits(ws_id, allRecs) {
    const buckets = listBuckets(ws_id);
    const bucketsById = Object.fromEntries(buckets.map(b => [b.id, b]));
    const a = readAssigns(ws_id);

    const inBucket = new Map(); // bucket_id -> [recs]
    const loose = [];
    for (const r of allRecs) {
      const bid = a[r.source_id] || null;
      const b = bid ? bucketsById[bid] : null;
      if (b) {
        if (!inBucket.has(b.id)) inBucket.set(b.id, []);
        inBucket.get(b.id).push(r);
      } else {
        loose.push(r);
      }
    }

    // Sort + letter within each bucket
    for (const [bid, recs] of inBucket.entries()) {
      recs.sort((x, y) => (x.source.uploaded_at || 0) - (y.source.uploaded_at || 0));
      recs.forEach((r, i) => { r.letter = letterFor(bucketsById[bid], i); r.bucket = bucketsById[bid]; });
    }
    loose.sort((x, y) => (x.source.uploaded_at || 0) - (y.source.uploaded_at || 0));
    loose.forEach((r, i) => { r.letter = letterFor(null, i); r.bucket = null; });

    // Build groups in bucket-creation order
    const groups = buckets
      .filter(b => inBucket.has(b.id))
      .map(b => ({ bucket: b, recs: inBucket.get(b.id) }));

    return { groups, unbucketed: loose };
  }

  // Flat letter map { source_id -> "PX-A" } for renderers that only need
  // the label and don't care about the grouping.
  function letterMap(ws_id, allRecs) {
    const { groups, unbucketed } = groupExhibits(ws_id, allRecs);
    const out = {};
    for (const g of groups) for (const r of g.recs) out[r.source_id] = r.letter;
    for (const r of unbucketed) out[r.source_id] = r.letter;
    return out;
  }

  window.Buckets = {
    listBuckets, getBucket, createBucket, updateBucket, deleteBucket,
    getSourceBucket, setSourceBucket,
    letterFor, groupExhibits, letterMap,
  };
})();
