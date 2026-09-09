# Annotation workspace layout preview

Independent, illustrative UI preview for the proposal in `docs/features/annotation-workspace-ux.md`.

Open `index.html` directly or serve this directory with a static HTTP server. There are no external network dependencies or application-module imports. The unmodified sample `portrait.png` comes from the explicitly discussed `run/processed/fbx_2d_pbr_clean_1915/0_00000/pose_00_sample_00/pbr.png`.

Working preview controls: contour selection, tool/context switching, zoom and right-button panning, advanced disclosure, file and object menus, image-queue drawer, illustrative navigation/status changes, and saved/error display. Save, geometry editing, import/export, initialization, and exit are **not production operations**; they show explanatory notices. The point counts and curves are illustrative. No annotation JSON, user folder output, IndexedDB, localStorage, or File System Access APIs are read or written.

Visual language: preserve the existing off-white `#fbfaf4`, ink `#1d2622`, green `#087e6b`, divider `#d6dcd6`, muted `#637069`, and neutral canvas `#e5e8e4`. Keep the existing serif wordmark; use Segoe UI for compact controls. Main hierarchy is canvas first, fixed tool/context bars, one compact right inspector, and fixed image navigation.

Verification scope: load the actual HTML/CSS/JS in an isolated Chromium profile, check 1920×1080 and 1366×768 for overflow and complete controls, and exercise selection → tool options → error/retry → queue/position → fit. Capture screenshots from the rendered page. This verifies the **preview only**, not fixes or production save/edit behavior.
