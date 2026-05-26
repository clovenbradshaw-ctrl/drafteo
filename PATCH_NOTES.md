# DraftEO — Exhibits / Sources / Buckets patch

A drop-in patch for `clovenbradshaw-ctrl/drafteo` that fixes the
disclosure-of-exhibits UX, retires the Source Explorer modal, adds
PDF.js inline citation, workspace-wide full-text search, and an exhibit
**bucket** model with bucket-scoped lettering.

---

## Naming model

| Term | What it is | Where it lives |
|---|---|---|
| **Exhibit** | An ingested document — PDF, web snapshot, file. Lettered. | Source entity (per-document room) |
| **Source** | The citation URL behind an exhibit (archive.org if preserved, else the original web URL). | Already part of the source entity |
| **Cited text** | A saved verbatim span from an exhibit, tagged with its exhibit letter and (for PDFs) the page. | Exhibit entity (per-workspace room) |
| **Bucket** | User-typed primary grouping for exhibits, with an optional prefix. Each exhibit lives in 0 or 1 bucket. | `localStorage`, scoped by workspace id (Phase 1 — see below) |
| **Tag** | Cross-cutting label on a source. Each exhibit can have many. | Already part of the source entity (`tags: []`) |

**Bucket lettering** restarts per bucket. With a prefix, exhibits read
`PX-A`, `PX-B`, `DX-A`. Without a prefix, the bucket's exhibits get
plain `A`, `B`, `C` and the bucket name disambiguates. Unbucketed
("loose") exhibits get their own workspace-wide letter pool.

---

## Files in this patch

Drop these into the repo as listed.

| File | Status | What changed |
|---|---|---|
| `src/exhibitsindex.js` | **Rewritten** | 3-pane inline explorer: workspace-wide full-text search (top), bucket-grouped exhibit list (left), PDF.js / text reader (right). Sticky capture bar with **Save as cited text** / **Stage for editor** / **Copy**. Bucket sections are collapsible; right-click a row to reassign or remove its bucket. |
| `src/sourcesindex.js` | **Rewritten** | Trimmed to a citation-URL-only table — exhibit letter, name, canonical URL, draft, archive button. No reading UI. Links into the Exhibits tab for everything else. |
| `src/explorer.js` | **Replaced** | Modal retired. `SourceExplorer.open(ws, opts)` now forwards to the Exhibits tab. Cmd-K still works via `search.js`. |
| `src/buckets.js` | **NEW** | Bucket data layer + lettering helpers. See note below on Phase 1 vs Phase 2. |
| `src/workspace.js` | **Edited** | Sidebar redesign — dropped the redundant bottom "EXHIBITS" list, added a compact lettered preview, lettered Cited-text rows, bucket-aware labels. Cmd-K opens Exhibits with search focused. Exposes `window.__openExhibitsTab(opts)`. |
| `src/main.js` | **Edited** | Adds `./buckets.js` to the boot order (before `exhibitsindex.js`). |
| `index.html` | **Edited** | Adds PDF.js 3.11.174 (UMD) + worker config and links `exhibits.css`. |
| `exhibits.css` | **NEW** | All styling for the new Exhibits tab, Sources tab, buckets, capture bar, PDF text-layer. |
| `Exhibits Mockup.html` | **Mockup only** | Visual proof of the new design. **Do not ship.** |

---

## What changed, in plain language

### 1. Naming is locked

Three terms, three concepts, no overlap.

- **Exhibits** are documents.
- **Sources** are the URLs (archive.org / original).
- **Cited text** is the quoted spans.

The old "Explore sources" modal and the duplicate sidebar lists are
gone. The Exhibits tab _is_ the explorer.

### 2. Buckets group exhibits primarily; tags do it cross-cuttingly

A bucket has a `name` (e.g. "Plaintiff", "Witness statements") and an
optional `prefix` (e.g. "PX", "WS"). Each exhibit lives in 0 or 1
bucket.

Lettering:

- Bucketed: prefix + letter, restarting per bucket → `PX-A`, `PX-B`, `DX-A`.
- Unbucketed: workspace-wide pool → `A`, `B`, `C`.
- Letters are stable across re-renders because they sort by
  `source.uploaded_at`.

Tags are already on the source entity; they ride as a multi-value
filter chip row above the bucket list.

### 3. PDFs cite cleanly now

PDF.js renders each page as a canvas with an invisible-but-selectable
text layer. When you highlight text:

- The capture bar shows the quote + page number automatically.
- The saved cited-text record gets
  `provenance.page` and `provenance.exhibit_letter` so footnotes can
  render "Exhibit PX-A, p. 3" deterministically.
- If the CDN is blocked, the tab falls back to the existing paste-cite
  flow in the full-source viewer.

### 4. Search across every exhibit at once

Top-bar input in the Exhibits tab extracts plaintext from every exhibit
(PDF.js for PDFs, DOM scraping for HTML, raw for text), caches per
source, and shows grouped hits with ~80 chars of context plus the page
number for PDFs. Click a hit → that exhibit opens, scrolls to the
right page, and runs the in-exhibit find to mark the span.

### 5. Visual hierarchy

Old layout had three competing lists (sidebar exhibits preview, sidebar
cited-text, middle exhibit list) and a giant page header that pushed
the PDF to a slit.

New layout:

- Single-row toolbar at the top: title + workspace search.
- Workspace-hits panel is a **floating dropdown** — it overlays content
  instead of shoving the reader down.
- PDF / reader gets the dominant pane.
- Sidebar holds compact lettered chips for cited-text, no duplicate
  exhibit list.

---

## Bucket storage — Phase 1 vs Phase 2

`src/buckets.js` is the bucket data layer. **Phase 1 (this patch)**
keeps buckets and bucket-assignments in `localStorage`, scoped by
workspace id:

```
drafteo.buckets.<ws_id> = [{id, name, prefix, color, created_at}]
drafteo.source_bucket.<ws_id>.<source_id> = bucket_id
```

This ships the feature today without touching `legacy-store.js`. The
trade-off is that **bucket structure isn't replicated to collaborators
yet** — every user in a workspace sees their own bucket layout.

**Phase 2 (recommended next step)** lifts buckets to Matrix entities so
they round-trip through the same E2EE log as everything else:

1. In `legacy-store.js`:
   - Add `bucket_id` to the `allowed` list in `updateSource()`.
   - Add `bucket_id: e.bucket_id || null` to `sourceCard()`.
   - Add four methods: `listBuckets`, `createBucket`, `updateBucket`,
     `deleteBucket` — mirroring `listBoards` et al. (the corkboard's
     board CRUD is the right template; buckets are workspace-room
     INS/DEF just like boards).
   - Add `setSourceBucket(doc_id, source_id, bucket_id)` →
     `def(doc_id, source_id, 'bucket_id', bucket_id)`.
2. In `src/buckets.js`, swap the localStorage reads/writes for the new
   `Store.*` calls. The function signatures are already async-shaped
   for exactly this swap.
3. Drop the `drafteo:buckets-updated` event listeners — the existing
   `drafteo:sources-updated` fires once Matrix delivers the DEF.

`src/buckets.js` keeps the lettering and grouping helpers regardless of
where the data lives, so Phase 2 is purely a backend swap.

---

## API surface (`window.Buckets`)

```ts
listBuckets(ws_id): Bucket[]
getBucket(ws_id, bucket_id): Bucket | null
createBucket(ws_id, { name, prefix?, color? }): Promise<Bucket>
updateBucket(ws_id, bucket_id, patch): Promise<Bucket>
deleteBucket(ws_id, bucket_id): Promise<void>
// Exhibits in that bucket return to the loose pool.

getSourceBucket(ws_id, source_id): bucket_id | null
setSourceBucket(ws_id, source_id, bucket_id | null): Promise<void>

letterFor(bucket, indexInBucket): string  // "PX-A" or "A"
groupExhibits(ws_id, recs): { groups: [{bucket, recs}], unbucketed: recs[] }
letterMap(ws_id, recs): { [source_id]: letter }  // flat lookup
```

Every mutation fires a `drafteo:buckets-updated` custom event so the
Exhibits / Sources tabs and the workspace sidebar re-render
automatically.

---

## Events

| Event | Fires when | Who listens |
|---|---|---|
| `drafteo:sources-updated` | A source is created / updated / deleted via Matrix. | Existing surfaces + Exhibits tab + Sources tab |
| `drafteo:buckets-updated` | Any bucket created / renamed / deleted, or any source's bucket reassigned. | Exhibits tab, Sources tab, workspace sidebar |

---

## Things I didn't touch (intentionally)

- **Editor citation footnotes** still render as the old `Source — URL`
  format. The `provenance.exhibit_letter` and `provenance.page` are
  saved on every new cited-text record, so a one-line change in
  `markdown.js` / `exporter.js` will let footnotes read
  "Exhibit PX-A, p. 3" once you want it.
- **AI citation manifest** (the old `EXHIBITS JSON` export button) got
  dropped in the rewrite. Worth porting back as an Exhibits-tab header
  button if you still need the manifest flow for the agent.
- **`legacy-store.js`** — untouched per the localStorage Phase-1
  approach. See the Phase 2 notes above for the 6 small edits when
  you're ready to replicate buckets through Matrix.

---

## Verification

- Open the **Exhibits Mockup.html** file in the project to see the
  redesigned layout statically — no Matrix login required.
- Once dropped into the repo, every JS file has been syntax-validated
  in this project (`new Function(src)` on each one).
- The Exhibits tab degrades gracefully if PDF.js fails to load (falls
  back to "Open in new tab" + the existing paste-cite flow).
