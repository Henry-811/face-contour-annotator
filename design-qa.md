# Annotation workspace — design QA

Date: 2026-09-09

## Visual truth and state

- Source: `docs/previews/annotation-workspace/workspace-1920.png` and `workspace-1366.png`, the HTML preview approved by the user.
- Implementation: `docs/previews/annotation-workspace/implementation-1920.png` and `implementation-1366.png`, rendered from production `index.html` + `src/app.js`, not the preview implementation.
- Same 1920×1080 / 1366×768 CSS viewports, screenshots at deviceScaleFactor 1, equal source/implementation pixel dimensions. No density resampling.
- State: same portrait and nine illustrative curve fixtures, right-eye Points editing at Fit. The fixtures are imported through the real JSON coordinator into an isolated browser project; no user output or active browser profile is accessed.
- Intentional differences: actual `portrait.png`, one image, real browser-local save state and warning, real disabled navigation, no Design preview badge or preview-only footer. Production uses the existing label colors and real editable anchors, not the prototype's sampled illustrative handles. No fake 1915-image project or fake folder-save status.
- Full-view comparisons: `comparison-1920.png`, `comparison-1366.png` in the same directory, source left and implementation right in each image. Both images opened and inspected together.
- Focused comparison: `comparison-tools.png`, browser-rendered 1:1 crops of the project/tool/context rows side by side. Also inspected full-resolution 1366 screenshot and the two mobile open-panel screenshots.

## Findings and comparison history

1. **P2, closed:** 980×850 wrapped zoom controls extended beyond a fixed 50px toolbar into the context row. Independent browser measured toolbar 58–108 and zoom 108–142. The wrapping breakpoint now sets height:auto; final toolbar is 58–151, all zoom controls end before the context row at151. Covered by child-boundary assertions and `implementation-980.png`.
2. **P2, closed:** initial implementation fit image was 459px rather than source496px at1366, and dense point markers obscured the eye. Fit now derives actual stage padding; context row is40px; final image fits the same stage as the source. Point radius2.8 with white outlines and selected4.5 retains the hit area while reducing obstruction. Only the selected label is placed and hit-tested, so invisible labels no longer displace it. Re-captured comparisons confirm the correction.
3. **P2, closed:** keyboard queue navigation lost focus when the list was rebuilt. Capture the return-focus intent before navigation and restore to Image queue summary after success. Independently reproduced and reverified; covered by the production folder workflow test.
4. **P2, closed:** at390 the open File panel measured left=-40.703/right279.297. It now positions relative to the full project bar, right12px. `implementation-390-file.png` and explicit panel-boundary assertions confirm all contents remain visible.
5. **Responsive hardening, closed:** the narrow inspector now occupies the actual editor container, not guessed fixed header/footer heights. `implementation-390-inspector.png` plus DOM assertions confirm it does not cover project/task bars. Removed narrow-screen visual reordering so keyboard and visual order agree.

Earlier screenshots were overwritten by the final captures; the measurements above record the observed initial differences. The latest comparison images are the post-fix evidence. No outstanding actionable P0/P1/P2 findings.

## Required fidelity surfaces

- **Typography:** same Georgia23px wordmark and Segoe UI/Aptos control family, compact12–14px control scale; serif is not used for inspector labels. Tool-row crops confirm consistent hierarchy, alignment and legible wrapping. Native File disclosure arrow and real focus rings are acceptable functional differences.
- **Spacing/layout:** fixed project/tool/context/task regions, desktop280px/296px inspector, compact35px/43px rows. The main canvas/frame matches the approved region proportions. Removing the preview footer exposes more genuine controls. Viewports1920×1080,1366×768,980×850,800×700,390×844 have no page overflow or clipped persistent controls.
- **Colors/tokens:** off-white#fbfaf4, stage#e5e8e4, ink#1d2622, muted#637069, green#087e6b and line#d6dcd6 preserved. Existing semantic annotation colors are authoritative; minor prototype illustrative-color differences accepted. Selection also uses outline/shape/text, not color alone.
- **Image quality:** exact original preview portrait copied without alteration. Production canvas renders it at correct aspect ratio with no stretching. Curves are actual domain geometry, not raster substitutes. Fill opacity removed to avoid masking the facial details being annotated.
- **Copy/content:** actual project/save/progress states replace demo claims. Add point, Delete point, Delete contour have distinct targets. General deletion explicitly requires Apply/Cancel. Save failures expose reason/retry/backup outside menus. Done still does not automatically advance.

## Interaction, accessibility and evidence

- `node docs/previews/annotation-workspace/capture-implementation.mjs`: production import, Points selection, Fit, five viewport checks, drawer open/close and focus, File open/Escape/focus, no Runtime.exceptionThrown; screenshots and combined comparisons generated. System picker and device feel are not tested here.
- `node tests/browser-contour-editing.test.mjs`: real IndexedDB and OPFS folder flows; single click vs double click, point dragging, one-shot insertion/cancel, repeat Delete, existing-point double click, input-key isolation, fitted deletion preview/cancel/apply/undo, refusal to discard on object change/exit, transforms, redraw, autosave/reload and right-button pan.
- `node tests/browser-folder-workflow.test.mjs`:103 images,2,160,066,560 source bytes,17 first-write recovery cases; actual folder coordinator, source laziness, write-conflict protection, fixed save-error actions, queue-focus return and deletion-preview navigation leaves disk unchanged. OS picker substituted with native Chromium OPFS handles.
- `node tests/browser-image-set-workflow.test.mjs`: project hub/import/save/reopen/delete isolation, current mobile toolbar/drawer contract.
- Unit/boundary/static suite:29 passing test results across logic, routes, annotation transfer, zip import, vendor integrity, folder workspace, contour editing and runtime-assets. Static runtime test traverses the production import graph and rejects mixed cache release tokens or missing element IDs.
- Independent code reviewer rebuilt the cross-layer rules from the final source/spec and confirmed fixes; independent layout reviewer checked comparisons and mobile open states. Excluded unrelated FBX/Python/run assets/vendor internals. No remaining blocking findings.
- Impeccable layout detector: no findings. `git diff --check`: passed (repository line-ending warnings only).

## Checklist and limits

- [x] Approved layout integrated, no persistent schema change in this layout work.
- [x] Explicit insertion and safe point-only deletion, preview and undo.
- [x] Existing folder/browser persistence and recovery paths exercised.
- [x] Desktop and narrow-screen visual comparison repeated after fixes.
- [x] No user output modified; no commit, push or deployment.
- [ ] User verifies mouse/trackpad comfort and native OS folder-permission prompts on their device. Abrupt power loss is not simulated.

final result: passed

## Follow-up review — 2026-09-09 (commit held)

The result above describes the previous acceptance run, not approval of this follow-up review. The existing 29-result unit/boundary suite and all three browser workflows passed again, but a targeted production-browser probe found an uncovered point-selection defect. No implementation changes or commit were made in this review.

- **P2 — Soft edit click-only selection uses a prepared, not committed, anchor index.** In `src/app.js:2932`, `prepareSoftEdit` can insert boundary anchors and shift the selected index. Line2942 publishes that index immediately, although the prepared contour is only applied after movement passes the threshold at lines3022–3025. A click without movement leaves the original contour intact but its selected index shifted; `deleteSelectedPoint` at line1224 then deletes the wrong original anchor.
- **Reproduction:** isolated Chromium, real production app, `samples/face-lena.jpg`, initialized first eyebrow, Edit points, Soft edit enabled, radius20 screen pixels. Click the original zero-based anchor2 `(292,184)` without dragging. Prepared index becomes3 while committed geometry remains unchanged. Delete point → Apply deletion removes original anchor3 `(311,187)` instead of the clicked point. Original five anchors: `(261,192), (273,187), (292,184), (311,187), (323,192)`; saved result retains `(292,184)` and omits `(311,187)`.
- **Risk boundary:** opt-in Soft edit; the default point-edit path does not prepare boundary anchors. Undo can recover the deletion. The user’s original image/output directories were not accessed.
- **Required fix/test:** keep selection indices tied to committed geometry until a drag actually applies its prepared contour, then switch to the prepared index. Add real click-without-drag and sub-threshold movement → delete/cancel/apply/undo regression coverage, including both persistence backends. Existing browser tests cover a moved soft drag but not this click-only path (`tests/browser-contour-editing.test.mjs:195`).

follow-up result: changes requested; await user approval to fix, then re-review before separately confirming commit.

## Soft edit fix verification — 2026-09-09

The user approved fixing the follow-up defect. Production change is limited to point-selection synchronization: pointerdown selects `hit.pointIndex` in the current contour; a real drag publishes `interaction.pointIndex` only after replacing the contour with the prepared edit. No geometry algorithm, persistence format, colors, point sizes or unrelated work was changed.

- **Red → green:** new production-browser regression failed on the old implementation with `soft click must delete anchor 2, not its prepared index`. With the fix it passes for both IndexedDB and OPFS-folder providers.
- **Coverage:** open interior point, open last point (prepared index can exceed the current anchor count), closed point, pure click and1 CSS px motion below the2px threshold; deletion preview/cancel, keyboard deletion, Apply, Undo; genuine soft drag followed by deletion without reselecting. Each committed/undone result is checked against the actual provider record, not just the JSON preview. Preview and cancel leave persisted contours unchanged.
- **Existing workflows:**29 unit/boundary/static results passed; complete contour-editing, folder-workflow (103 images/about2GiB/17 first-write recovery cases), and image-set workflow passed; existing exit/reopen/reload and failure recovery remain covered. `git diff --check` passed.
- **Focused code re-review:** checked selection-index readers/writers, render projection, minimum-point deletion gate, pointerup/cancel/blur completion and undo/object-switch clearing. No additional blocking finding in this fix. This is a focused implementation-agent review, not a new independent full-repository review.
- **Preserved scope:** no user output/source directories touched, no git commit/push/deploy. Previously proposed semantic colors, point/line weight, queue alignment and zoom-label changes are deferred.

fix result: passed; await separate confirmation of the annotation-feature commit scope.
