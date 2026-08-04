# Image-set import and annotation-file workflow

## Feature Spec

### 1. Concept Brief source

- **Stage:** concept exploration is closed after reviewing the official Labelme directory workflow.
- **Target user:** one local annotator processing a folder or ZIP of face images in a static browser application.
- **Core problem:** open many images at once, move through them, keep local progress across refreshes, and carry annotations between sessions without introducing a server, database, or project-identity protocol.
- **Core concepts:** image set, image, annotation state, annotation file, relative path, and local recovery.
- **MVP:** open image files, a folder, or an image ZIP; annotate from a queue; autosave locally; export one aggregate annotation JSON; import that JSON into an open image set by relative path.
- **Non-goals:** Labelme compatibility, project IDs, a project library, cloud sync, collaboration, version history, image bytes in JSON, direct cross-browser writes to the selected folder, and cryptographic image identity.
- **Key assumptions:** users retain the source images; one image set is active per tab; multiple independent jobs live as separate source folders/ZIPs plus annotation files; GitHub Pages is the deployment target.
- **Confirmed decisions:** folder is the primary batch input, ZIP is a convenience input, and the portable output is one application-native annotation JSON.

### 2. Unified language

| Term | Definition | Code/API wording | Avoid in user-facing copy |
|---|---|---|---|
| Image set | The images currently open for one annotation job | `imageSet` where new public/domain APIs are introduced | Project |
| Annotation file | One JSON containing the image-set paths, dimensions, states, and contours | `face-contour-annotations`, `schemaVersion` | Project file, manifest |
| Relative path | Image location inside the selected folder or ZIP, excluding a shared root folder | `relativePath` | Absolute path |
| Local recovery | IndexedDB copy used to survive refreshes on this browser | local save / restore | Database, cloud backup |
| Import annotations | Apply matching records from an annotation file to the currently open image set | plan, confirm overwrite, apply matches | Replace project, reconnect project |

Existing internal storage names may retain `project` temporarily to preserve the released IndexedDB layout. They are implementation compatibility names and must not appear in the new file contract or UI.

### 3. Business rules

| ID | Trigger | Rule | User-visible result | Acceptance |
|---|---|---|---|---|
| BR1 | User opens input | Accept image files, one folder, or one ZIP containing supported images; reject an empty selection or ZIP with no supported images. | A new naturally sorted image queue opens, or a specific error is shown. | A1, A2 |
| BR2 | Input paths are normalized | Use safe, root-relative paths with `/`; reject absolute/traversal paths and case-folded duplicates. Strip one shared top-level directory from folder/ZIP input. | Duplicate or unsafe entries identify the offending path. | A2, A3 |
| BR3 | A different image set is opened | Do not silently discard the current set. If it contains annotation progress, require explicit confirmation before replacing the local working set. | The user can cancel, export, then retry. | A4 |
| BR4 | An annotation or status changes | Debounce and persist the current image record plus image-set metadata in one IndexedDB transaction. A failed save remains visible and enables the unload warning. | The save indicator reaches Saved locally or shows a durable failure warning. | A5, A6 |
| BR5 | User exports | Flush pending local writes, validate every `done` image, and export one JSON containing every image record without image bytes, hashes, absolute paths, or a project ID. | One `.face-contour-annotations.json` download is produced. | A7 |
| BR6 | User imports annotations | Require an open image set; validate the JSON boundary; match each record by normalized relative path; require matching dimensions before applying it. | Valid matches can be applied while unmatched/conflicting records are listed. | A8, A9 |
| BR7 | Imported records would overwrite work | Ask once before applying if any matched target has a non-default status. Initial template contours on an untouched `unlabeled` image are not treated as user work. Cancellation changes nothing. | The confirmation states how many images would be overwritten. | A10 |
| BR8 | Import partially matches | Do not require whole-set identity and do not hash source images. Apply valid matches atomically to local storage; skip and report unmatched/conflicting records. | Summary includes applied, unmatched, and conflicts. | A9, A11 |
| BR9 | Page reloads | Restore the last locally saved image set and current image from IndexedDB. No fixed expiry is promised; cleared/evicted site data is outside the app's control. | The last saved state returns, or a visible recovery error explains what is missing. | A5, A6 |

### 4. User flows

#### Main flow

1. Choose **Open folder** (primary), **Open ZIP**, or **Open images**.
2. The app filters supported images, normalizes relative paths, checks storage capacity, decodes images, and builds a naturally sorted queue.
3. The annotator moves through the queue, draws contours, and assigns image states.
4. Changes autosave to IndexedDB.
5. **Export annotations** downloads one aggregate JSON.

#### Continue on the same browser

1. Reopen or refresh the page.
2. The last locally saved image set and current position restore automatically.

#### Continue from a portable file

1. Open the original folder/ZIP.
2. Choose **Import annotations** and select the aggregate JSON.
3. Review the import summary and confirm only if existing work would be overwritten.
4. Matching records are applied; missing or dimension-conflicting records remain unchanged and are reported.

#### Switch independent work

1. Export the current annotation file when a portable copy is needed.
2. Open another folder/ZIP.
3. Confirm replacement only after reading the warning. The previous source folder and downloaded annotation file remain independent.

#### Error and recovery flows

- Invalid JSON/schema: reject before changing in-memory or stored annotations.
- Invalid/unsupported or encrypted ZIP, unsafe path, or decompression limit: reject before replacing the current image set.
- Image decode/storage failure while opening a new set: keep the previous local image set.
- IndexedDB failure during annotation import: keep the pre-import records and show the failure.
- Missing local annotation records: fail closed, retain the stored bytes, and never rewrite missing records as empty contours.
- Partial annotation match: apply valid records and keep all other target images unchanged.

### 5. Domain model impact

- **Image set:** one active aggregate containing ordered image records, current image, preferences, source type, and timestamps. Its internal storage key is not portable identity.
- **Image record:** relative path, display name, dimensions, status, contours, selection, timestamps, and locally stored image data.
- **Annotation file DTO:** versioned external contract with image-set name, current relative path, task schema, image records, progress, and export time. It contains no top-level or image project IDs.
- **Annotation import plan:** matched records, unmatched annotation paths, dimension conflicts, overwrite count, and summary. Planning is pure; UI confirmation and IndexedDB commit are orchestration concerns.
- **Storage:** no backend schema. The existing IndexedDB stores remain the authority for refresh recovery. Annotation import and legacy local-data migration use multi-store transactions so partial writes cannot leak. A local-only write token rejects stale writes after another tab replaces the active set; it is never portable identity.
- **Events:** open image set, local save completed/failed, annotation export completed/failed, annotation import planned/applied/failed.

### 6. Boundary scenarios

- Empty selection; directories with no supported images; corrupt, encrypted, or otherwise unsupported ZIP variants.
- ZIP path traversal, duplicate relative paths, unsupported compression, excessive entry count or expanded size.
- Same filename in different subdirectories (allowed because paths differ).
- Same relative path differing only by case (rejected to remain portable to case-insensitive filesystems).
- Annotation file with no images, duplicate/unsafe paths, duplicate contour IDs, unknown status/label, malformed points, newer schema, or oversized JSON.
- Correct path but different dimensions (conflict; do not apply).
- Some annotation paths absent from the selected source (unmatched; do not block valid matches).
- Repeated annotation import is idempotent at the business-state level.
- Two tabs editing the same local image set remain last-completed-write-wins. After one tab replaces the active source set, stale writes from older tabs are rejected so they cannot tear metadata, records, and assets across sets; cross-tab merge/locking is not in MVP.
- No roles/authentication or time-zone business rules exist.

### 7. Acceptance Scenarios

- **A1 — folder happy path:** Given a folder with nested supported images, when it is opened, then the queue contains every image once in natural path order and paths exclude the selected root directory.
- **A2 — empty/unsupported input:** Given input with no supported images, when it is opened, then the current image set remains and a useful error is shown.
- **A3 — path integrity:** Given unsafe or case-folded duplicate ZIP paths, when the ZIP is opened, then it is rejected before any current data changes.
- **A4 — safe switch:** Given the current image set contains progress, when another source is opened and replacement is cancelled, then the current set and IndexedDB state remain unchanged.
- **A5 — refresh recovery:** Given edits have reached `Saved locally`, when the page reloads, then images, contours, statuses, preferences, and current position restore.
- **A6 — save failure:** Given IndexedDB rejects a write, when an edit occurs, then the UI reports failure and unload protection remains active.
- **A7 — aggregate export:** Given an image set containing done, in-progress, skipped, review, and unlabeled images, when annotations are exported, then one valid JSON contains every image's relative path, dimensions, status, and contours and contains no image bytes, hashes, absolute paths, or project ID.
- **A8 — import happy path:** Given a valid annotation file and matching open image set, when import is confirmed, then all records match by relative path and their states/contours restore.
- **A9 — partial import:** Given valid, missing, and dimension-conflicting annotation records, when imported, then valid matches apply and the other records are reported without changing their targets.
- **A10 — overwrite cancellation:** Given a match would overwrite existing work, when the user cancels, then memory and IndexedDB remain unchanged.
- **A11 — atomic apply:** Given a valid plan but IndexedDB commit fails, when import is applied, then the pre-import image-set state remains active and refreshable.
- **A12 — ZIP happy path:** Given a normal ZIP with nested JPEG/PNG files, when opened, then it produces the same normalized image-source model as folder input.

### 8. Non-goals confirmed

No Labelme JSON, sidecar JSON files, project IDs, project library, cloud/database/account system, collaboration, history/merge, embedded images in exports, SHA-256 matching, automatic writes to arbitrary local directories, or guaranteed persistence after browser site-data deletion.

## Design Plan

1. **Goal:** replace the user-facing project-file/reconnect protocol with a single annotation-file boundary while retaining the working multi-image queue and reliable local autosave.
2. **Affected areas:** annotation transfer domain, input adapters, app orchestration/UI, IndexedDB transaction use, tests, and feature documentation. Geometry/rendering and FBX tooling must not change.
3. **Placement:** pure annotation parsing/export/matching lives in `src/annotation-transfer.js`; ZIP boundary parsing lives in `src/zip-import.js`; DOM coordination remains in `src/app.js`; local transactions remain in `src/storage.js`.
4. **Dependency direction:** UI -> annotation transfer / ZIP adapter / image-set domain -> storage. Pure transfer logic imports contour validation/serialization but never imports DOM or IndexedDB.
5. **Model boundary:** the external annotation DTO is parsed into normalized records, then planned against internal image records by relative path. Image bytes remain storage-only.
6. **Rejected alternative:** a project manifest plus project ID, file hashes, and all-or-nothing reconnect was rejected because the user task only needs per-image annotation matching. Labelme-compatible sidecar JSON was rejected because interoperability is not required and many browser downloads are poor UX.
7. **Verification:** pure unit tests cover paths/schema/planning; ZIP tests cover a real archive; a real headless browser covers open -> edit/save -> export/import -> refresh using production UI orchestration.

ZIP support uses the locally vendored fflate 0.8.3 UMD build and its MIT license, so GitHub Pages has no CDN/runtime dependency. Provenance is recorded in `THIRD_PARTY_NOTICES.md`. The adapter cross-checks central/local headers, rejects encryption/AES, overlapping ranges, invalid CRCs, and inconsistent declared/actual sizes. It inflates raw DEFLATE data in 16 KiB chunks with at most three workers. Limits are 256 MB per archive, 50 MB per image, 512 MB total expanded image data, a 200:1 ratio, and 10,000 entries; larger jobs use the folder input.

## Annotation-file contract

- **Caller/consumer:** this static application and downstream user scripts.
- **Command:** browser download/upload of `*.face-contour-annotations.json`.
- **Request boundary:** UTF-8 JSON up to 20 MB; exact `kind` and supported `schemaVersion`; at most 10,000 records; safe case-folded-unique relative paths; valid dimensions/statuses/contours; non-empty contour IDs unique inside each image.
- **Success:** normalized annotation records and an import plan, or a downloaded Blob.
- **Errors:** stable internal codes for malformed JSON, unsupported schema, invalid path, duplicate path, invalid image record, and no matches; UI maps them to actionable messages and logs the original exception.
- **Idempotency:** repeated import of the same file produces the same annotation state.
- **Evolution:** `schemaVersion` gates future formats. The previously shipped application-owned `face-contour-project-v1` aggregate and `face-contour-annotator-v1` single-image file are parser-only, one-way migrations because both had downloadable emitters; IDs and image data are ignored and the app never emits them now. The repository maintainer owns this bridge; reassess removal with schema v2 after a documented migration window. This is unrelated to Labelme compatibility.
- **Observability:** no network metrics/traces exist. Successful console events record operation name, counts, and duration. Validation errors may name the normalized relative path needed to fix the file, but never log contours, source bytes, data URLs, or absolute paths; the status region reports user-facing outcomes.

## Invariant ledger

| Invariant | Authoritative source | Lock / transaction | API projection | Frontend state | Regression test |
|---|---|---|---|---|---|
| Relative path uniquely identifies an image inside one set | Normalized internal image records | No lock; checked before replacement/import | `images[].relativePath`, case-folded unique | Queue keys and import plan use the same normalizer | annotation-transfer path tests; folder/ZIP browser flow |
| Imported data never applies to a different-sized image | Current decoded width/height | Import plan built before one multi-store commit | DTO width/height required | Conflicts remain unchanged and are reported | partial-import unit + browser scenario |
| Contour identity is unambiguous inside one image | Parsed/exported contour list | Validated before import planning or download | Non-empty, bounded, per-image-unique contour IDs | Selection/edit/delete address exactly one contour | duplicate-ID annotation-transfer unit test |
| Export contains all annotation progress but no source images/identity hashes | Current image-set records after save flush | Wait for write tail; serialization is read-only | All image records; prohibited fields absent | Download preview mirrors payload | aggregate-export unit + browser download assertion |
| Failed source replacement keeps the prior set | Current IndexedDB stores | One transaction clears/writes all relevant stores | No network API | UI changes active set only after transaction completes | browser forced-abort replacement test |
| Failed annotation apply keeps prior annotations | Current IndexedDB stores | One transaction writes image-set metadata and affected records | Import plan is immutable input | Memory switches only after commit | browser forced-abort import test |
| A stale tab cannot overwrite a newly opened image set | IndexedDB metadata write token | Snapshot/import transactions compare the local-only token before writes | Token is absent from annotation JSON | Save failure tells the stale tab to export | browser stale-snapshot CAS test |
| Refresh restores the last completed local write | IndexedDB metadata, records, and assets | Per-save metadata+record transaction; assets written at source import | No external API | Save revisions gate Saved/failed state | real browser edit -> refresh test |

## Test Plan

| Source | Risk | Level | Coverage |
|---|---|---|---|
| A1, A2, A3 | happy / empty / integrity | unit + browser | Normalize real folder-style paths; reject duplicates/unsafe paths; production file-input flow keeps prior state on failure. |
| A4 | data integrity | browser | Production open coordinator receives a second set; cancel confirmation; assert current queue and refresh state remain. |
| A5, A6 | recovery / error | real browser | Execute production debounced save, wait for Saved locally, refresh; separately force the production IndexedDB transaction to abort and assert visible failure. |
| A7 | contract / integrity | unit + browser | Serialize all statuses and contours; assert prohibited keys absent; trigger real download and inspect payload. |
| A8, A9, A10 | happy / partial / idempotency | unit + browser | Parse/plan pure cases; production file input applies valid matches, reports issues, and respects overwrite cancellation. |
| A11 | transaction integrity | real browser | Inject an IndexedDB abort into the production commit and verify memory plus refreshed storage still contain pre-import annotations. |
| A12 | external file boundary | unit + browser | Read real ZIPs through the production adapter; reject corrupt, encrypted, forged-size, CRC-invalid, overlapping, or unsupported archives; assert real Worker peak never exceeds three. |
| Permissions | not applicable | documented | No accounts or roles exist; browser file consent is the only permission boundary. |
| Cross-tab concurrency | data-integrity boundary | browser | Simulate a stale snapshot after source replacement; assert compare-and-swap rejects it and preserves the new set. Same-set semantic merging remains out of scope. |

## Observability Plan

- **Critical paths:** image-source open, local save, annotation export, annotation import plan/apply, and restore.
- **Console events:** operation, source type, image/match/conflict counts, duration, result, and error object. Validation failures may include the offending normalized relative path; never log contour payloads, data URLs, source bytes, or absolute paths.
- **User signal:** persistent save-state indicator plus status/alert region for every failure and partial result.
- **Metrics/trace/alerts:** not applicable to a no-backend static app.
- **Verification:** browser tests assert the user-visible status; manual DevTools inspection confirms failures retain useful exception context without payload data.
