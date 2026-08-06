# Local project hub and focused annotation workspace

## Feature Spec

### 1. Concept Brief source

- **Target user:** one annotator who handles multiple independent face-annotation jobs in the same browser.
- **Core problem:** project lifecycle actions are mixed with high-frequency annotation tools, while only one image set can currently be retained.
- **Core concepts:** project hub, local project, annotation workspace, exit project, and delete local copy.
- **MVP:** create, list, open, refresh, exit, and delete multiple browser-local projects while preserving the existing annotation-file workflow.
- **Non-goals:** accounts, backend storage, cloud sync, collaboration, history/merge, multiple workspaces at once, deleting source files, or portable project identity.
- **Constraints:** the app remains a static GitHub Pages site. IndexedDB is the only project store and may be cleared or evicted by the browser.

### 2. Unified language

| Term | Definition | Code wording | Avoid |
|---|---|---|---|
| Project hub | The bare-URL screen used to create, open, and delete local projects | `projectHub` | Dashboard, cloud workspace |
| Local project | One browser-local image set plus annotations and workspace state | `localProject` | Remote project |
| Local project key | Browser-only key used for IndexedDB isolation and hash routing | `localProjectKey` | Portable `projectId` |
| Image set | The ordered source-image queue inside one local project | `imageSet` | Project file |
| Annotation workspace | The focused screen for annotating one open local project | `workspace` | Import screen |
| Exit project | Flush local saves and return to the hub without deleting the project | `exitProject` | Close and delete |
| Delete local copy | Remove one project's IndexedDB metadata, records, and image assets | `deleteLocalProject` | Delete source files |
| Annotation file | The existing portable `*.face-contour-annotations.json` contract | `annotationFile` | Project export |

The local project key is internal implementation data. It is not used to decide whether two imports are the same and must never be exported in an annotation file.

### 3. Business rules

| ID | Trigger | Rule | User-visible result | Acceptance |
|---|---|---|---|---|
| BR1 | The bare URL is opened | Show the project hub even when local projects exist. Only `#/project/<localProjectKey>` opens a workspace. | The user chooses what to work on; refresh inside a workspace stays there. | A1, A7, A8 |
| BR2 | A source is selected in the hub | Folder is the primary entry; ZIP and image files are secondary entries. Source-opening controls do not appear in the workspace. | Creation and annotation are separate tasks. | A2, A21 |
| BR3 | A source import succeeds | Always create a new browser-only project key. Re-importing the same files creates another independent project; the app never guesses source identity. | Both projects appear in the hub. | A3 |
| BR4 | A project is created | Validate paths, capacity, image decoding, and task constraints before one atomic metadata/record/asset transaction. Failure leaves the library unchanged. | No partial project card or orphan project is shown. | A2, A4, A20 |
| BR5 | The hub is shown | List lightweight project metadata ordered by persisted `updatedAt` descending. Show name, source type, image count, progress, and last edited time. Opening alone does not edit the timestamp. | Multiple jobs are easy to distinguish and resume. | A5 |
| BR6 | Project data is stored or read | Metadata, annotation records, image assets, save tokens, and internal image IDs are scoped to one local project. | Work in one project cannot overwrite another. | A6, A13, A16 |
| BR7 | Annotation state changes | Autosave only the current project's metadata and current image record. A missing project or mismatched write token rejects the write and never recreates data. | Cross-tab deletion or replacement cannot resurrect stale data. | A7, A19 |
| BR8 | A project route loads | Restore the named project, its current image, contours, statuses, and preferences. A missing/corrupt project returns to the hub with an error and does not synthesize empty data. | Refresh recovery is explicit and fail-closed. | A7, A9 |
| BR9 | Exit project is chosen | Flush pending saves before returning to the hub. On failure, remain in the workspace unless the user explicitly confirms abandoning unsaved in-memory changes after being told to export first. | Exit is safe and distinguishable from delete. | A10, A11 |
| BR10 | Delete local copy is chosen | Delete only from the hub after a confirmation naming the project and explaining that browser copies and unexported annotations are removed, while original files and downloaded JSON are untouched. | Cancellation changes nothing; success removes only that card. | A12, A13 |
| BR11 | A project deletion commits | Delete the target metadata, its image records, and its assets in one transaction. Failure keeps the complete project. | Other projects remain byte-for-byte unchanged. | A13, A14 |
| BR12 | Annotations are exported | Preserve the existing annotation JSON contract. Exclude `localProjectKey`, `projectId`, `localWriteToken`, internal image IDs, hashes, absolute paths, and image bytes. | The file remains portable and project-agnostic. | A15 |
| BR13 | Annotations are imported | Apply only to the open project and continue matching by normalized relative path plus image dimensions. Never match by local project key. | Same-path images in another project are unchanged. | A16 |
| BR14 | Storage capacity is checked | Use cumulative browser usage. If the estimate says the import cannot fit, reject before decoding/writing and suggest deleting a local copy or using a smaller batch. If estimates are unavailable, allow the atomic attempt and report quota failure. | Existing projects remain safe under low storage. | A4, A20 |
| BR15 | A v3 `current-project` exists | Migrate it once into a local project, preserving source assets, annotations, statuses, current image, preferences, tokens, and timestamps. | Existing users see the prior job as one hub card. | A17 |
| BR16 | Legacy migration fails | Abort the whole migration, keep the old metadata/records/assets, show a recovery error, and retry on a later load. | No partial new project or silent loss occurs. | A18 |
| BR17 | Multiple tabs are open | Different projects write independently. Tabs editing the same project retain last-completed-write-wins. If another tab deletes the project, later writes fail visibly and cannot recreate it. | The no-backend concurrency boundary is predictable. | A19 |
| BR18 | Persistent storage is unavailable | Continue operating, but keep a visible local-only/eviction warning and recommend annotation JSON exports for backup. No fixed retention time is promised. | Users understand when progress can disappear. | A22 |

### 4. User flows

#### Create and annotate

1. Open the bare URL and land on the project hub.
2. Choose a folder, ZIP, or image files.
3. The app validates paths and capacity, decodes the images, and atomically creates one local project.
4. The URL changes to the project's hash route and the annotation workspace opens.
5. Annotation changes autosave to that project only.
6. Refreshing keeps the same hash and restores the same project and position.

#### Resume or switch work

1. Open the hub and select a project card.
2. Annotate, then choose **Exit project**.
3. The app flushes pending writes and returns to the hub.
4. Open another project. Only one workspace is active in the tab at a time.

#### Delete a local project

1. From the hub, choose **Delete local copy** on a project card.
2. Confirm the named project and local-only effect.
3. The app atomically removes that project's metadata, annotations, and cached images.
4. Original source files and downloaded annotation files are unchanged.

#### Error and recovery flows

- Creation validation/decode/quota/transaction failure: stay in the hub; keep every existing project unchanged.
- Missing/corrupt project route: return to the hub, retain stored data, and show a recovery error.
- Exit save failure: stay in the workspace; retry, export annotations, or explicitly abandon unsaved memory state.
- Delete transaction failure: keep the card and complete stored project.
- Legacy migration failure: retain the v3 layout and retry on a future startup.
- Browser data eviction: the project cannot be recovered locally; the portable recovery path is reopening the source and importing an exported annotation file.

### 5. Domain model impact

- **LocalProject aggregate:** browser-only key, write token, image-set metadata, preferences, current image, and timestamps.
- **Image record:** globally unique internal image ID, relative path, dimensions, status, contours, selection, and timestamps.
- **Image asset:** source data URL keyed by the globally unique internal image ID.
- **Project hub read model:** project metadata only; it does not decode or load every cached image.
- **Annotation DTO:** unchanged external contract, constructed explicitly from relative paths and annotation state.
- **Routing:** hash route carries the local project key because GitHub Pages has no SPA path fallback.
- **Events:** local project created/opened/exited/deleted; local save completed/failed; migration completed/failed; annotation import/export completed/failed.

The local project is the transaction aggregate for create/delete. A normal autosave commits its metadata plus one image record together. Annotation import commits its metadata plus all affected records together while preserving every other project's records and assets.

### 6. Boundary scenarios

- Empty library; one project; many projects; same project name; repeated source import.
- Same relative paths across projects; internal image-key collision must be rejected atomically.
- Invalid/unknown/encoded project hash; missing metadata; missing record; missing/corrupt image asset.
- Save in flight during exit or browser history navigation; failed save followed by cancel or explicit abandon.
- Delete cancellation; delete transaction failure; stale tab saving after deletion.
- Storage estimate unavailable, known insufficient capacity, and actual `QuotaExceededError` despite a positive estimate.
- v3 project with split records/assets; older embedded contours/data; forced migration failure.
- No roles, authentication, server clock, expiration, or time-zone business rules exist.

### 7. Acceptance Scenarios

- **A1 — empty hub:** Given IndexedDB has no projects, when the bare URL opens, then the hub empty state is visible and the annotation workspace is hidden.
- **A2 — create project:** Given a valid folder or ZIP, when it is imported from the hub, then one project is atomically added and its workspace route opens.
- **A3 — repeated source:** Given a project already came from a source, when the source is imported again, then two independent cards exist and the first project is unchanged.
- **A4 — failed creation:** Given existing projects, when validation, decoding, or the create transaction fails, then project count and existing data are unchanged.
- **A5 — project list:** Given several projects, when the hub opens, then cards show correct progress and are ordered by persisted last-edit time.
- **A6 — strong isolation:** Given two projects use the same relative paths, when each is edited, then their records/assets/statuses never cross.
- **A7 — workspace refresh:** Given changes reached `Saved locally`, when the project hash is refreshed, then the same project, current image, preferences, statuses, and contours restore.
- **A8 — bare URL:** Given a project was previously open, when the bare URL is opened, then the hub appears instead of auto-opening it.
- **A9 — invalid route:** Given a route names a missing or corrupt project, when it loads, then the app returns to the hub with an error and writes no replacement data.
- **A10 — normal exit:** Given pending changes, when Exit project is chosen, then saves finish before the hub appears and reopening shows the changes.
- **A11 — failed exit:** Given local saving fails, when Exit project is chosen, then the workspace remains unless the user explicitly confirms abandoning unsaved changes.
- **A12 — delete cancellation:** Given deletion is cancelled, then cards and all stored data remain unchanged.
- **A13 — scoped delete:** Given projects A and B, when A is deleted, then only A's metadata, records, and assets disappear and B remains fully usable.
- **A14 — delete rollback:** Given deletion aborts mid-transaction, when the hub recovers, then the entire target project remains.
- **A15 — export contract:** Given an open project, when annotations are exported, then the JSON contains that image set but no browser-local key, write token, internal ID, hash, or image asset.
- **A16 — import isolation:** Given projects A and B have same-path images, when annotations are imported in A, then only A changes.
- **A17 — legacy migration success:** Given a complete v3 `current-project`, when v4 starts, then one equivalent hub project appears and a second startup does not duplicate it.
- **A18 — legacy migration rollback:** Given migration is forced to fail, when storage is inspected, then the old metadata/records/assets remain and no partial local project exists.
- **A19 — stale tab after delete:** Given one tab has A open and another deletes A, when the first tab saves, then the write is rejected and A is not recreated.
- **A20 — cumulative capacity:** Given existing projects use most of the quota, when another project cannot fit, then creation is rejected before mutation; after a deletion the user can retry.
- **A21 — focused workspace:** Given a project is open, then source-opening and project-deletion controls are absent while annotation tools, queue, annotation import/export, and Exit project remain.
- **A22 — retention warning:** Given persistent storage is denied, then work remains usable but the UI explains that browser-local projects may be cleared and JSON export is the backup path.

### 8. Non-goals confirmed

No backend/database service, accounts, cloud sync, collaboration, merge/history, simultaneous multi-project editing in one tab, project archive export, source-file deletion, Labelme compatibility, annotation-sidecar files, portable project IDs, source hashing, or guaranteed retention after site-data deletion.

## Design Plan

1. **Goal:** separate project lifecycle from annotation work and replace the single global storage slot with isolated local-project aggregates.
2. **Affected areas:** local-project domain helpers, IndexedDB access, application routing/orchestration, page structure, browser tests, and feature docs. Geometry, rendering, annotation DTO parsing, ZIP validation, and FBX tools remain unchanged.
3. **Placement:** project/image domain helpers remain in `src/project.js`; persistence and migration remain in `src/storage.js`; small pure hash helpers live in `src/routes.js`; DOM/view orchestration remains in `src/app.js`.
4. **Dependency direction:** UI/router -> project and annotation domains -> storage. Storage receives validated domain objects and never imports DOM behavior. The annotation DTO never imports local storage identity.
5. **Model boundary:** internal local-project metadata may contain `localProjectKey` and `localWriteToken`; explicit annotation-file mappers exclude them. Image data remains asset-store-only.
6. **Rejected alternatives:** a server/database conflicts with GitHub Pages and the stated deployment constraint. A single “continue last project” splash does not solve multiple independent jobs. Path routing would fail on GitHub Pages refresh. Guessing source identity or exporting project IDs would recreate the unnecessary matching protocol already rejected.
7. **Verification:** unit tests cover route and domain contracts; real-browser tests cover production IndexedDB transactions, migration, routing, creation, autosave, import/export, exit, deletion, and responsive UI.

## Migration Plan

1. **Change type:** IndexedDB schema + application code + one-project backfill.
2. **Impact evidence and decision:** v3 is already deployed and all static readers/writers are in `src/storage.js` and `src/app.js`. Bump the database version to v4 so cached v3 clients cannot reopen a newer database and execute their old global-clear path. Use a one-way, atomic startup migration rather than permanent dual read/write.
3. **Stages:** v4 upgrade prepares the required storage layout; startup reads `projects["current-project"]`; a single three-store transaction validates/normalizes legacy records and assets, writes metadata under a fresh local key, then deletes only the legacy metadata key. Success is absence of the legacy key plus a readable equivalent project; failure aborts everything.
4. **Read/write strategy:** new code reads and writes only keyed local projects. The legacy key is parser/migration input only. No dual writes and no runtime fallback to the global slot.
5. **Backfill:** at most one legacy project; bounded by its existing image list; idempotency comes from deleting the legacy key only in the successful transaction. Existing split assets keep their image keys; embedded legacy values are split only when needed.
6. **Rollback:** no database downgrade is promised. Before commit, transaction abort leaves v3 data intact. After commit, recovery is forward-fix with v4+ code or portable annotation JSON; old v3 code is intentionally blocked by the higher IndexedDB version.
7. **Validation:** seed an actual v3 layout, upgrade, verify metadata/records/assets/current image/preferences, reload for idempotency, and inject a write failure to prove full rollback.
8. **Observability:** log migration result, image count, duration, and the error object without source bytes/contours. Surface failure in the hub. There is no backend metric or alert channel.

## Invariant ledger

| Invariant | Authoritative source | Transaction boundary | External projection | Frontend state | Regression coverage |
|---|---|---|---|---|---|
| Bare URL is hub; project hash is workspace | `window.location.hash` parsed by `src/routes.js` | No storage lock | Hash only; no server route | View epoch prevents stale async route loads | route unit + browser bare/refresh/invalid route |
| A local project owns all of its records/assets | Project metadata image IDs and storage keys | Create/delete span metadata, records, assets | Local key absent from annotation DTO | One `state.project` per tab | create/delete/isolation browser scenarios |
| A failed create/delete cannot expose a partial project | IndexedDB stores | One three-store transaction | No API | Hub rerenders only after commit | forced transaction abort browser scenarios |
| Autosave cannot recreate a deleted project | Metadata local key + write token | Guard read and metadata/record writes share one transaction | Token absent from annotation DTO | Save failure blocks further local writes and preserves memory | stale-tab-after-delete browser scenario |
| Annotation import changes one project only | Open local project and relative-path plan | Target metadata + target records transaction | Existing annotation schema | Prepared state replaces memory only after commit | partial import + cross-project isolation |
| Export is portable and identity-free | Explicit annotation-file builder | Flush writes, then read-only serialization | Prohibited local/internal fields absent | Download mirrors preview | annotation-transfer unit + browser payload assertion |
| Refresh restores the last completed write for the routed project | IndexedDB metadata/records/assets | Per-save metadata + record transaction | No server API | Hash selects project; current image selects asset | edit -> saved -> route refresh browser flow |
| Legacy migration never loses v3 data | Legacy metadata/records/assets | One migration transaction | No external projection | Hub appears only after migration attempt | success/idempotency/forced rollback browser tests |

## Test Plan

| Source | Risk | Level | Coverage |
|---|---|---|---|
| A1, A8, A9 | empty / routing / recovery | unit + real browser | Parse/build hashes; navigate bare, valid, and missing routes through production startup orchestration. |
| A2-A6 | happy / integrity / duplicate | real browser | Create two projects through real file inputs and IndexedDB; assert card summaries/order and scoped data. |
| A4, A14 | transaction integrity | real browser | Force production asset put/delete failure and assert no partial create/delete. |
| A7, A10, A11 | async save / recovery | real browser | Execute production debounced save, flush on exit, refresh current hash; inject save failure and assert explicit abandon gate. |
| A12, A13, A19 | destructive / concurrency | real browser | Confirm/cancel delete; compare untouched project; save stale open snapshot after deletion and assert rejection/no resurrection. |
| A15, A16 | contract / isolation | unit + real browser | Assert forbidden keys; import same-path annotations in one project only; retain current atomic-failure coverage. |
| A17, A18 | migration / compatibility | real browser | Seed v3 stores before startup, run production migration, reload, and force transaction abort. |
| A20, A22 | capacity / retention | unit + manual browser QA | Cover fitting, insufficient, and unknown estimates through `planImportStorage`; manually verify the visible local-only warning when persistent storage is denied. |
| A21 | UX / responsive / accessibility | real browser + visual QA | Verify desktop and narrow widths, focused workspace controls, sticky Exit, focus recovery, and no horizontal overflow. |
| Permissions/time | not applicable | documented | There are no accounts, roles, server clocks, expiry jobs, or time-zone rules. |

The real-browser cases execute the production routing, IndexedDB, debounced-save, import, and delete coordinators. Browser APIs and failure points may be instrumented, but the coordinators themselves remain real.
