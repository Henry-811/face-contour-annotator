# Contour editing

## Concept and scope

For the local facial annotation workflow, keep Initialize as a geometric starting
template, then align the whole feature and refine only the parts that need work.
Initialize is not face detection. Deliver point editing, affine transforms,
local redraw, optional soft editing, and persistence together. No AI, backend,
new project system, or unrelated visual redesign.

## Interaction / acceptance scenarios

1. **Edit points (default):** drag an anchor without an influence setting.
   Ordinary clicks select only. Double-click the selected line, or arm the
   one-shot Add point button and click the line, to insert without changing its
   shape. Escape cancels insertion. Delete only removes a selected point and
   never falls back to deleting a contour; open curves retain two anchors and
   closed curves three. An unchanged subdivision merges back to its original
   curve. General deletion offers a local-fit preview with Apply/Cancel and Undo.
2. **Transform:** drag the contour/label to move; bounding-box handles resize
   about the opposite handle; Shift preserves proportions; the circular handle
   rotates about the center (shown below when too close to the image top).
   Operations stay within the image.
3. **Redraw section:** click a start on the selected curve, click the replacement
   path, then click an end on the same curve. Preview before applying. Closed
   curves offer the other arc; unrelated curve segments stay unchanged. Escape
   cancels. Each application is one undo entry. Unapplied previews are not saved;
   navigation/other edits must explicitly discard them, and refresh warns.
4. **Soft edit:** optional advanced checkbox in Points, with a visible affected
   arc and adjustable radius. Grabbed point follows the pointer without the old
   32-image-pixel movement cap. Nearby existing anchors follow with an arc-length
   falloff; dragging never inserts or removes anchors, including after repeated
   edits. Radius is in screen pixels and converted to image coordinates at
   gesture start. Sparse curves may deform beyond the highlighted radius within
   an adjacent cubic segment: use explicit Add point for finer local control,
   rather than automatically splitting the curve at the influence boundaries.
5. Every committed edit is undoable/redoable and uses the existing autosave queue,
   save barrier, conflict protection, and error UI. No source images are changed.
6. Rendering, curve hit-testing, redraw preview, and exported sampled points use
   the same curve evaluation. Saving/reopening retains editable anchors and
   exact cubic controls (fractional coordinates included).

The canvas-first workspace layout and complete point-interaction acceptance
criteria are maintained in [annotation-workspace-ux.md](annotation-workspace-ux.md).
The production module graph uses one release query (`workspace-ux-2`) consistently;
updating only the entry script does not invalidate stale imported modules.

## Fixed-anchor soft editing / acceptance update

- **Requirement source:** the user approved separating soft movement from point
  insertion for annotators refining initialized facial contours. Completion
  means soft dragging changes positions without increasing editing complexity.
- **Terms and rules:** an anchor is a selectable, saved `curve.anchors` point;
  sampled export `points` are a derived polyline, not editable anchors. Soft edit
  changes existing positions only; Add point is explicit insertion. No schema,
  migration, folder permissions or saving protocol changes.
- **Flow and recovery:** select an anchor → drag with optional soft falloff →
  one undo/autosave entry. Clicks and sub-threshold motion do not edit. Explicit
  insertion/deletion remains available; Undo/Redo restore full geometry. Existing
  save failures retain the current work and use the existing retry/backup UI.
- **Boundaries and non-goals:** preserve historical subdivisions, anchor order,
  open endpoints and closed seams. No automatic cleanup, extra controls, UI
  redesign, source-image changes or FBX changes. Existing empty/busy guards,
  pointer ownership and image-coordinate clamping remain in effect.

| Acceptance scenario | Risk / verification |
| --- | --- |
| Given sparse/dense open or closed curves, when repeatedly soft-dragging at different radii, then anchor/segment counts and grabbed index stay fixed | Geometry unit tests; real app pointer workflow test updated |
| Given neighboring anchors within the radius, when dragging, then they follow with decreasing influence, while out-of-range anchors and wholly unaffected segments stay fixed | Geometry unit tests, including the closed seam and image boundary |
| Given a soft edit, when serializing and reopening, then editable anchor positions/counts are retained | Real serializer/importer and folder-record validation tests |
| Given an existing anchor, when clicking or making sub-threshold motion, then selection/deletion targets stay correct; real drags remain undoable/redoable | Existing dual-provider browser test updated; manual execution in this code-only handoff |
| Given an explicit Add point or deletion, when applied, then only that requested operation changes anchor count | Existing geometry and browser insertion/deletion regressions |

This handoff runs non-browser regression and syntax checks only, per the user's
request. The browser workflow is kept current but not executed; interaction feel,
reload and actual folder-save acceptance remain for the user's manual review.
The 31 non-browser regression results, JavaScript syntax checks and
`git diff --check` passed. This update supersedes the automatic soft-boundary
preparation described in the historical verification record below.

## Design decision / data evolution

Internal contours keep `points` as anchors and optionally `segments` containing
one pair of cubic controls per segment. Existing anchor-only data is converted
from the existing interpolating spline on first edit. Point insertion uses
de Casteljau splitting, preserving the original curve; redraw splices explicit
segments, so retained regions do not shift when neighboring anchors change.
This avoids exposing a second tangent-handle editing workflow.

Portable contour records expose sampled polygon/linestrip `points` and a
`curve` record (`version: 1`, `anchors`, `segments`) for lossless editing.
New annotation envelopes and folder image records use version 2. Version 1 is
read as a historical input migration, never written by this release. Folder
manifest/session and IndexedDB store layout do not change. Only edited/saved
images get new records; no background or bulk rewrite.

Evidence: exporter, annotation-transfer, folder-workspace, project/storage and
app save/load/undo paths are the consumers. The user has existing saved local
work and has manually exercised this application. Local files are independently
owned and cannot all be atomically migrated. External consumer counts are
unknown; no new external compatibility is promised. Owner: project maintainer.
Keep the historical-input migration through this release; before a future
format removal, inventory owned backups and require an explicit migration
release. Old builds cannot edit v2 files: back up the output folder before
upgrading; rollback means restoring that backup, not opening v2 in an old build.

## Invariants / verification plan

| Invariant | Authority / readers and writers | Lock / transaction | Projection | UI state and recovery | Regression |
| --- | --- | --- | --- | --- | --- |
| One exact editable curve | `contour-editing.js`: anchors + cubic controls; renderer, hit tests, exporter read it | Pure geometry, no lock | Sampled `points` + `curve` | Point insertion and redraw preserve retained segments; undo restores full contour snapshot | `contour-editing.test.mjs`: split, redraw, direct/soft, edge controls |
| Lossless persisted edits | `project.js` / `geometry.js` clones; `storage.js` image record; folder sidecars | Existing IndexedDB transaction or folder lease + expected text + exclusive writable | v2 envelope; v1 parsed once as historical input | `app.js` sync → queued save → barrier → load; failures retain memory | Both browser workflow suites and `browser-contour-editing.test.mjs` |
| Invalid input never replaces work | exporter normalization; annotation-transfer and folder-workspace ingress | Validate before existing atomic replacement / sidecar save | Finite bounded anchors, valid controls, sampled projection agreement; unknown version rejected | Import failure status preserves current work; no raw model re-normalization after validation | Curve malformed projection tests; existing import/conflict suites |
| Preview is not a committed edit | `app.js` redraw draft, separate from contours | No preview writes; navigation passes save/discard barrier | Only Apply changes geometry; normal save remains last committed work | Start → path → preview/other arc → Apply or Cancel; pending preview blocks status edits and warns on unload | Browser preview/Done/exit cancellation; undo/redo/reopen |
| Gesture ends in one saved undo entry | `app.js` pointer interaction and snapshot | Busy/navigation finalizes drag; existing serial save queue | Coordinates stay in image space; pan changes viewport only | Pointerup/cancel/lost capture/blur finalize, then clear; another pointer cannot end the gesture | Browser real CDP pointer workflow; unit boundary transforms |

`editTool`, `selectedPoint`, and `redraw` are transient editor state, cleared on
image load/exit; undo clears point selection. `editorVersion: 2` preferences
enable the new Points defaults on historical projects once, then preserve the
user's soft/handle choices. No backend/API or database migration is needed.

| Rule / risk | Verification |
| --- | --- |
| Sparse and dense, open and closed geometry | Unit: split shape invariance, anchor movement, deletion minimum, seam insertion |
| Whole-feature alignment | Unit: move/resize/rotate, opposite pivot, bounds, degenerate size |
| Local redraw | Unit: open direction, closed alternate arc, same-segment cut, retained controls, invalid endpoint |
| Data integrity | Integration: v1 migration; v2 serialize/parse/save/reopen; malformed controls and projection rejected; deep clones |
| Undo and autosave | Browser: real app point edit → transform → redraw → undo/redo → save → exit/reopen, both local provider paths |
| Navigation and concurrency | Browser: busy guards, redraw discard/cancel, pointer termination, existing folder conflict regression suite |
| Visual usability | Isolated-browser screenshot: handles, preview, advanced influence, controls at desktop/narrow widths |

Browser tests execute production app handlers and save coordinators, wait for
observable saved state, and isolate test profiles/files. Picker/CDP input is the
external boundary. Existing folder recovery and image-set workflow suites stay
in the regression run. No claims about arbitrary OS crashes or durable backup:
the existing save-status and output-folder backup guidance still applies.

## Verification record (2026-09-09)

- `node --test tests/logic.test.mjs tests/routes.test.mjs tests/annotation-transfer.test.mjs tests/zip-import.test.mjs tests/vendor-integrity.test.mjs tests/folder-workspace.test.mjs tests/contour-editing.test.mjs`: 25 passing results (19 new geometry cases plus six existing test files).
- `node tests/browser-contour-editing.test.mjs`: both IndexedDB projects and
  native Chromium folder writes passed point drag/add/delete, keyboard Delete,
  scale/rotation, closed redraw/other arc, undo/redo, pending-preview status gate,
  cancelled exit, soft edit, actual reload, persistent reopen, complex historical
  import rejection and right-button panning without annotation changes.
- `node tests/browser-image-set-workflow.test.mjs`: passed existing hub/import,
  migration, saving and conflict/recovery workflows.
- `node tests/browser-folder-workflow.test.mjs`: passed 103 images, 2,160,066,560
  source bytes, 17 first-write recovery scenarios, folder restore and precision.
- Syntax checks and scoped `git diff --check`: passed. Isolated screenshots at
  1440px and 980px inspected. Tools moved above the long label list so preview
  actions remain reachable. The design detector's sole advisory is the existing
  home-page grid background, unchanged and outside this editor refinement.

Independent review uses a separate read-only reviewer, scanning the application
entry, geometry, renderer, exports/imports, project/storage/folder authorities,
navigation, pointer termination, tests and this spec. Excluded: third-party
vendor/generated assets, large source datasets, and unrelated user-owned
FBX/Python changes. Findings repaired and regression-tested:

1. Unchanged legacy control points must not be clipped by an unrelated point edit.
2. Pending redraw must not mark old committed geometry Done/Skip/Review.
3. Splitting a historical off-image spline must not introduce unsavable anchors;
   direct insertion rejects that location, and soft preparation retains the old
   segment instead of introducing a boundary anchor outside the image.
4. Historical and internal inputs must pass the sampling budget before a
   persistent annotation replacement, not fail afterward during rendering.

Additional checks cover nearest-handle selection for dense anchors and thin
feature boxes, relocating a top-edge rotation handle inside the image, and
refining Bezier parameters so point insertion and soft boundaries match the
clicked location even on a straight segment with nonlinear parameterization.

Final independent re-review: all four findings closed; no remaining blocking
finding. The reviewer independently reran the 19 geometry cases plus transfer
and folder boundary tests, the two-provider browser editing workflow, and diff
whitespace checks. OS permission prompts and abrupt power loss are not claimed
as automated coverage.

For manual acceptance, open an existing project, choose Refine → Transform to
align a feature, then Points to refine. Redraw section uses start → replacement
clicks → end → Apply; the preview itself is intentionally not autosaved. Before
testing against valuable output, make an output-folder backup. OS picker dialogs
and browser permission prompts remain manual boundaries; automated folder tests
use native OPFS handles with only the picker substituted.
