# Local folder workspace

## Quick start

1. Use current desktop Chrome/Edge, via HTTPS (GitHub Pages works) or a localhost server. Do not double-click `index.html` as a `file://` page.
2. Extract a ZIP using your computer first. Click **1. Choose image folder**. Nested image folders are included.
3. Click **2. Choose output folder** and grant write permission. Choose a separate directory, not the image directory or its parent/child. A new output directory is recommended for a new image set.
4. Annotate. After each edit, the app waits 200 ms before scheduling a file write. **Saved to output folder** means the write completed; **Save now** flushes pending changes. Wait for Saved before closing. A forcibly terminated tab, browser crash, or power loss can still lose uncommitted edits.
5. Reopen the recent shortcut, or choose the same two directories again. Folder permission may need to be granted again. Contours, status and unfinished drawing are restored from disk. Forgetting the shortcut or clearing browser site data does not delete output JSON files.
6. Back up the entire output folder plus the original images. **Download current JSON / Restore current JSON** apply only to the displayed image. An existing aggregate browser-project backup can also restore the matching current image; it has no source fingerprint, so the user must choose the correct originals.

Example output (names are illustrative):

```text
chosen-output/
  face-contour-workspace.json   # image inventory and workspace identity
  face-contour-session.json     # last image and display preferences
  annotations/
    subject-a/photo.jpg.json   # original path + source hash, contours, status, draft
    subject-b/photo.png.json
```

The source image inventory is fixed for this MVP: adding, removing or renaming originals requires restoring the original inventory or choosing a new output workspace. Changed saved originals are detected on load by SHA-256, not by filename alone. Do not edit one output directory simultaneously in another browser/origin or external editor; same-origin tabs are locked and changed output files are checked before writing. Limits: 10,000 images, 128 MiB and 64 megapixels per image, 20 MiB per annotation file. There is no whole-folder 256 MiB ZIP limit in this mode.

## Concept Brief

- Stage: implementation of the user's selected folder-direct workflow.
- User: a single annotator on desktop Chrome/Edge, using large local image sets.
- Problem: annotate continuously without importing gigabytes into browser storage, and own the saved files.
- Concepts: a source directory is read-only original images; an output directory holds one workspace and per-image JSON; a recent-project bookmark only remembers directory handles and is not the annotation authority. The user creates/reopens the workspace, edits its annotations, and may forget its bookmark without deleting files.
- MVP: choose source, choose output, load images on demand, autosave contours and unfinished drawing, restore from output files after reopening. Existing browser projects remain accessible.
- Non-goals: cloud sync, collaboration, in-browser large-ZIP extraction, changing original images, automatic conversion/deletion of existing browser projects.
- Assumptions: HTTPS (including GitHub Pages) or localhost; current desktop Chrome/Edge; one writer per output directory. ZIPs are extracted outside the app. Other browsers get an explanation, not a silent switch in storage semantics.
- Decisions: user selected folder-direct; no outstanding blocking product decisions. Existing browser import remains a separately labelled option, not an automatic fallback.

## Feature Spec

Terms/code: `FolderWorkspace`, `sourceHandle`, `outputHandle`, `image record`, `draft`, `recent bookmark`. “Saved to folder” means the file stream closed successfully, never merely an in-memory update.

| Rule | Trigger / constraint / visible outcome | Acceptance |
| --- | --- | --- |
| F1 Source safety | Directory selection; source/output must be separate non-nested directories. Enumerate image handles without reading all image contents. Never write originals. | A1, A2 |
| F2 Output identity | Open output; create a versioned manifest or validate existing manifest's path inventory. Per-image saved SHA-256 binds annotations to image bytes on load. Reject incompatible/corrupt files; do not silently overwrite. | A2, A5 |
| F3 Per-image persistence | Edit; serialize writes, save current image only, including draft label/shape/points. A failed write stays dirty, supports retry/download and prevents unconfirmed navigation loss. | A3, A4 |
| F4 Recovery | Reopen; disk JSON is authoritative. Browser bookmarks are optional. Refresh without permission returns to hub with reconnect instructions. | A3, A6 |
| F5 Bounded working set | Open/switch; only current image pixels and annotations are loaded. Retain lightweight image/status metadata; paginate queue. Inspect existing JSON one at a time. | A1 |
| F6 Isolation | Concurrent writer; Web Lock per output manifest identity, exclusive writable stream and external-change comparison. Forget bookmark never deletes source/output files. | A5, A6 |
| F7 Failed first write | Creating a manifest/session/image JSON fails; remove only a file this write created that is still the same empty entry. Preserve pre-existing or changed files. Serialize manifest initialization before an ID exists. Cleanup failure is visible and never reported as saved. | A7 |

Main flow: select source → select output → validate/scan → load current image → edit/autosave → switch/exit after writes complete → reopen and restore. Cancel either picker leaves existing data alone. Unsupported browser/permission denial gives actionable UI. Bad image does not replace current canvas. Output failure retains memory; retry rechecks permissions. Explicit exit after warning may abandon unsaved work. Editing controls are frozen during image switches; an active drag is committed into the outgoing save barrier. A newer browser navigation takes precedence over an in-flight folder opening. Starting a new drawing makes a completed image in progress again.

Model: new independent bookmark IndexedDB database; no image blobs or annotation authority in it. Output uses `face-contour-workspace.json`, `face-contour-session.json`, and `annotations/<source-relative-path>.json`. Manifest contains version, ID and sorted image paths. Session contains current path/preferences; a missing session defaults to the first image without losing per-image annotations. A corrupt session fails closed and currently requires restoring a backup; automatic repair is outside this MVP. Each image file contains exact floating-point contours, source fingerprint, dimensions, status, unfinished draft and a revision.

Boundaries: empty/case-colliding/unsafe paths; conflicting output layout; corrupt JSON; unavailable image; changed original; cancelled picker; revoked permission; full disk; repeated save; external modification; two tabs; refresh mid-write. Single-image limits still apply; a 2 GB aggregate is not a promise for arbitrarily large individual images.

## Acceptance / Test Plan

| Scenario (Given / When / Then) | Risk / validation |
| --- | --- |
| A1 Large directory / open and switch / list all paths but only read selected image; queue remains bounded | Integration with lazy file handles, real browser workflow; real multi-GB directory test where feasible |
| A2 Empty, unsafe, nested or mismatched roots / open / reject without touching source or overwriting saved output | Unit/integration boundary tests |
| A3 Contours plus unfinished draft / autosave, switch, reload / exact saved state restored from JSON | Real app coordinator in Chromium, real filesystem handles; only picker boundary substituted |
| A4 Writable failure / edit again then switch / stay on current image, retain latest data; retry writes it | Browser failure injection at filesystem boundary |
| A5 Changed source/output, corrupt record or another writer / open/save / reject clearly without overwriting | Integration and browser locks tests |
| A6 Bookmark lost/forgotten or permission denied / reconnect same directories / disk work remains recoverable | Browser storage/permission boundary tests |
| A7 First manifest, sidecar or session creation / writable-open, write or close failure / retry or reopen works without an empty-file blocker; previously saved annotations remain exact | Native Chromium filesystem/module tests plus app first-sidecar failure/reload; existing empty/nonempty files, conflict, cleanup denial and competing initializers are negative controls |

## Design and invariants

App UI → `folder-workspace.js` → File System Access / separate recent-bookmark storage. Existing renderer and contour validation remain shared; filesystem logic does not depend on DOM/app state. No backend/API. Alternative (bulk Blob import into IndexedDB) was rejected for the default flow because it copies all images and leaves results browser-managed.

| Invariant | Authority / transaction | Boundary projection | UI state / regression |
| --- | --- | --- | --- |
| Originals immutable | source handles read-only, roots checked before output creation | `openFolderWorkspace`, `loadImage` | two-step picker / A1,A2 |
| Saved means file committed | per-image JSON, exclusive stream close, serial write queue | `saveImage` rejects on permission/conflict/disk error | dirty revision/retry / A3,A4,A5 |
| Disk wins on reopen | manifest, image JSON and source SHA-256 | `openFolderWorkspace`, `loadImage` | reconnect and current-image restoration / A2,A3,A6 |
| No full image-set copy | handles plus one current image; paginated list | `loadImage`, metadata scan | previous/next and queue pages / A1 |
| Other work preserved | separate bookmark DB; no deletion of external files | forget removes bookmark only | labelled browser vs directory projects / A6 + existing browser test |
| Failed creations do not poison recovery | temporary in-call ownership of newly created entry; workspace lease, plus short same-origin manifest-initialization lock | `writeJson` abort/check/remove only its still-empty new file; existing empty JSON remains an error | failed/retry or actionable cleanup warning / A7 |

### First-write recovery fix

This bugfix uses the Concept Brief and F1–F7 above; it does not add a new storage mode. A **new empty entry** means the target was absent before this write created it, not simply that an arbitrary file has zero bytes. Existing files remain disk authority. No JSON schema, bookmark DB version or migration changes are required.

Design: retain the native per-file commit path, but move writable-stream acquisition into its error boundary and track entry ownership. Abort failed streams; only after successful abort (or a failure before a stream existed), recheck entry identity/size and remove the new empty leaf, non-recursively. Never remove an existing entry, a conflicting/locked entry, or nonempty content. Use a short origin-wide lock for manifest read/create/cleanup because a new output has no workspace ID yet; normal annotation saves keep the existing workspace lease. Even when an earlier save failed and the user wishes to abandon unsaved work, exit drains already-queued writes before confirmation/lease release. Browser file APIs cannot transact with unrelated external programs, so the existing single-writer restriction remains.

Failure flow: preserve the original error when cleanup succeeds; keep the app dirty and allow normal retry. If permissions or another filesystem error prevent cleanup, report the exact relative path and a safe manual recovery instruction. Previously left or externally emptied files remain rejected, with an explicit empty-file explanation rather than silently becoming new annotations. Abrupt process termination cannot run cleanup; backup and explicit recovery remain required.

Rejected alternative: treating every empty JSON as missing would erase evidence of a truncated existing file and could silently reset its annotation. Automatic bulk repair/deletion, source changes, new cloud/database dependencies and cross-program concurrent writers remain non-goals.

Validation/observability: A7 covers native `createWritable`, `write`, `close` and cleanup failures for new files, exact preservation of existing data, and serialized initialization. The real app test verifies visible failure → exit/reload → preserved earlier image. Only filesystem failure points/picker are substituted; coordinators are production code. Cleanup logs include relative path, result/error code, never annotation payloads; unrecoverable cleanup is surfaced through existing failed-state UI. OS permission dialogs, disk power-loss behavior and external concurrent editors are not automated.

## Evolution / Migration Plan

Schema + code: create an independent version-1 bookmark DB. Existing v4 browser DB/readers/writers remain unchanged; published project hub and user screenshots establish actual existing browser work. No backfill, dual-write or automatic conversion. New directory projects write only output JSON; bookmarks can be rebuilt. Application rollback ignores the new bookmark DB and leaves output files intact. No destructive downgrade promised. Existing browser mode is an explicit supported alternative, not a schema compatibility shim. Removing it requires a separate user-approved migration with verified exported backups.

## Contract / Observability

Async commands take named options; source/output handles require read/readwrite permission respectively. Scan returns lightweight records; load returns the current file/record and the app creates its Blob URL; save resolves after file commit. Errors carry a stable folder error code and recovery message. Natural path ordering and fixed queue page size. Native API failures propagate to visible status plus console event; no raw images/contours logged. Browser-only app has no remote telemetry or server trace; operation/path and error code identify failures locally. Save indicator/retry are user-facing alerts. Test injected errors and verify no unhandled rejection or false saved indicator.

## Verification log

Verified 2026-09-09 with Node 22.18.0 and desktop Chromium:

- All eight `tests/*.test.mjs` suites passed together: logic, routes, annotation transfer, ZIP import, vendor integrity, existing browser-project workflow, folder boundary validation, and the new folder browser workflow. No skipped tests. Both modified production JS modules pass `node --check`; `git diff --check` passes.
- Native Chromium OPFS fixture: 103 JPEG files, 20 MiB each (2,160,066,560 bytes in total). Files use a valid 512×512 sample with padding. This verifies aggregate-size/lazy-reading behavior, not high-resolution image diversity or ZIP extraction performance. Opening reads one image's bytes; the queue renders 50 items. Test profile/files are disposable.
- Browser test exercises the real app coordinator, native directory/file handles, write streams and Web Locks. Only the OS picker is replaced with disposable directory handles. Verified contour/draft persistence through switching and refresh, exact fractional coordinates, restored current-image JSON, failed writes plus subsequent edits/retry, source/output conflicts, corruption, same-origin duplicate writer, forgotten bookmark recovery, and navigation/editing gates while native image reads are paused.
- The existing browser workflow's project-card test helper now waits for enabled actions, matching real-user interaction. Folder reload checks wait for a new document rather than accidentally accepting the pre-reload DOM. Assertions about saved data were retained.
- Visual inspection at 1440×1000 covers the real populated hub and annotation workspace. Impeccable audit's only advisory was the pre-existing decorative grid background, intentionally preserved. Its guidance kept the new default as a two-step folder flow and the old browser-copy workflow secondary and explicit.
- Earlier independent read-only review covered entry/route/save coordination, folder storage, existing storage/project/import/export/renderer paths, HTML and relevant new/old tests. R1/R3/R6/R7 readers, writers, UI gates and recovery paths were checked. It found and independently reproduced a P1 outgoing-sidebar edit race and a P2 first-load navigation race; both were fixed and independently retested with small native Chromium/OPFS fixtures.
- First-write recovery regression was added before the fix and failed because manifest creation left an empty file. After the fix, all 17 native filesystem scenarios passed: manifest/sidecar/session writable-open, write and close failures; exact preservation of existing annotations; existing empty and changed nonempty entries; cleanup denial; unconfirmed abort; and competing manifest initializers. The real app also verifies a third image's failed first save can be followed by exit/reopen without losing the first image's saved contours or draft.
- Re-review identified a related queued-write/exit race. A new real-app regression first failed because the exit confirmation appeared while a later write was still paused. Exit now drains the write queue before confirmation and releasing the lease; the regression passes. An independent native fixture also confirmed the workspace lock remains held (`FOLDER_BUSY` for a competing open), then releases only after the queued write settles; reopening restores the latest committed annotations.
- Final independent read-only re-review reran the 17 failure scenarios and the small app/lock fixture, checked other close/clear paths, and found no remaining P0/P1/P2 findings in this change's risk surface. The main run then repeated all eight JavaScript suites after the exit-barrier fix: eight passed, zero failed or skipped. Syntax and whitespace checks passed. The first-write recovery invariant and the existing source/persistence/isolation invariants were reviewed together.

Not verified automatically: real OS permission dialogs, network/removable drives, abrupt power loss, or cross-browser/origin concurrent editing. Filesystem writes are per-file commits, not a multi-file transaction or a substitute for backups. No test used the user's source image folders, large archives or unrelated FBX/Python changes. No commit, push or deployment was performed.
