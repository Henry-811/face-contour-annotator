# FBX 2D Render Batch

## Purpose

Convert the renderable FBX assets from `run/run/fbx` into paired 2D head-crop PNGs so downstream reviewers can choose between the conservative `basecolor` view and the lit `pbr` view.

The batch uses:

- `run/processed/fbx_texture_manifest.json` as the source-of-truth FBX-to-texture mapping.
- `tools/render_fbx_blender.py` for each individual Blender render.
- `skin-only` component materials so the skin texture is applied only to head/body meshes. Eye, lash, teeth, saliva, and tearline meshes keep their original FBX materials instead of incorrectly receiving the face Basecolor.

## Output Contract

For the current manifest, the expected full output is:

| Source | Count |
| --- | ---: |
| Renderable FBX rows | 384 |
| Poses per FBX | 5 |
| Material modes per pose | 2 (`basecolor`, `pbr`) |
| Total PNGs | 3840 |

The default output layout groups comparable renders together:

```text
run/processed/fbx_2d_renders/
  0_00000/
    pose_00_front/
      basecolor.png
      pbr.png
    pose_01_yaw_left/
      basecolor.png
      pbr.png
  render_manifest.json
  render_manifest.csv
```

Each render manifest row records the source FBX, source texture, source mapping status, material mode, pose angles, output path, log path, command, status, return code, and error text.

Multiple poses for the same FBX and material mode are rendered in one Blender process. The FBX, textures, and materials are loaded once, then the render root and camera framing are updated for each output pose.

## Pose Set

The default five-view set keeps pose and camera perturbation small:

| Pose | Yaw | Pitch | Roll |
| --- | ---: | ---: | ---: |
| `front` | 0 | 0 | 0 |
| `yaw_left` | -18 | 4 | -2 |
| `yaw_right` | 16 | -3 | 2 |
| `pitch_up` | 7 | 10 | 3 |
| `pitch_down` | -9 | -8 | -3 |

## Commands

Build or refresh the FBX-to-texture manifest:

```powershell
python tools\build_fbx_texture_manifest.py `
  --root run\run `
  --output-json run\processed\fbx_texture_manifest.json `
  --output-csv run\processed\fbx_texture_manifest.csv
```

Dry-run the first asset and inspect the generated render manifest without launching Blender:

```powershell
python tools\render_fbx_batch.py `
  --manifest run\processed\fbx_texture_manifest.json `
  --output-root run\processed\fbx_2d_renders_dry_run `
  --limit-assets 1 `
  --dry-run
```

Smoke-test one asset with both material modes and all five poses:

```powershell
python tools\render_fbx_batch.py `
  --manifest run\processed\fbx_texture_manifest.json `
  --output-root run\processed\fbx_2d_renders_smoke `
  --blender F:\Blender\blender.exe `
  --limit-assets 1
```

Run the full paired batch:

```powershell
python tools\render_fbx_batch.py `
  --manifest run\processed\fbx_texture_manifest.json `
  --output-root run\processed\fbx_2d_renders `
  --blender F:\Blender\blender.exe
```

Run the adapted PBR-only dataset used for contour annotation:

```powershell
python tools\render_fbx_batch.py `
  --manifest run\processed\fbx_texture_manifest.json `
  --output-root run\processed\fbx_2d_pbr_adapted_1920 `
  --material-modes pbr `
  --eye-texture run\processed\eye_texture_inputs\eye.jpg `
  --hide-untextured-lashes `
  --add-missing-eyebrows `
  --eyebrow-mask-root run\processed\fbx_2d_pbr_adapted_aux\eyebrow_masks `
  --pose-mode uniform `
  --pose-count 5 `
  --pose-seed 42 `
  --yaw-limit 20 `
  --pitch-limit 12 `
  --roll-limit 4 `
  --axis-mode y-up-z-depth `
  --workers 2
```

This profile produces 1,920 PBR PNGs from 384 renderable FBXs. Uniform samples are deterministic per FBX, so rerunning with the same seed produces the same five poses. Textures marked `false` in the project's `brows.json` receive one deterministic eyebrow mask selected from `Makeup/Features/Eyebrows`; textures already containing brows are unchanged. Keep the generated masks outside the dataset root so recursive image importers only see the final PBR images.

The adapted profile uses the asset set's explicit `Y-up / Z-depth` camera-axis preset. Bounding-box span inference is available through `--axis-mode auto`, but it is not appropriate for these heads because similarly sized width/depth spans can swap the camera axes.

## Scope Rules

- `basecolor` uses the skin Basecolor as an unlit material.
- `pbr` uses the same Basecolor plus any same-directory `Normal.png`, `Roughness.png`, `Specular.png`, and `Cavity.png` discovered by `--auto-maps`.
- `--eye-texture <path>` optionally applies a real eye diffuse texture to `eyeLeft` and `eyeRight` meshes only. This uses the FBX eye mesh UVs, so the result must be visually checked for UV alignment.
- `--add-missing-eyebrows` follows the project's brow-presence metadata and blends the selected UV-space brow mask into skin Basecolor before PBR shading. One brow selection is shared by all poses of the same texture.
- `--hide-untextured-lashes` hides only FBX meshes identified as eyelash cards. It does not modify the source FBX or hide eye, tearline, teeth, or saliva meshes.
- `--hide-mesh <exact-name>` additionally hides a named mesh while preserving the existing framing inputs. Repeat it for multiple meshes; unknown names fail explicitly. Each manifest row records `hidden_mesh_names`, and each render log records the actual `hidden_meshes`.
- The batch skips `ambiguous` manifest rows by default.
- Missing or failed renders are recorded in `render_manifest.json` and `render_manifest.csv`; failures are not silently swallowed.
- No procedural eye, lash, tooth, or hair material is added. Assets without one-to-one component textures are left with imported FBX materials under `skin-only`.

## Clean PBR Revision (2026-09-08)

The confirmed revision adds `--hide-mesh eyeEdge_lod0_mesh --hide-mesh body_lod0_mesh` to the adapted profile above. The tearline's imported opaque material caused white eye-corner patches, and the clipped body mesh left rectangular fragments below the head mesh's shoulder/chest section. Keep the same textures, sampled poses, camera axes, lights, and framing. Do not use `--head-only` as a substitute, because it changes the framing inputs.

The curated source manifest is `run/processed/fbx_2d_pbr_adapted_aux/clean_source_manifest.json`. It excludes `S_M_NChar_DaoKe02_00000.fbx` because the source geometry renders with severe distortion even with only the head visible. The clean package contains 383 assets / 1,915 PBR PNGs at `run/processed/fbx_2d_pbr_clean_1915`, with a ZIP alongside it. Previous outputs remain available for comparison.

```powershell
python tools\render_fbx_batch.py `
  --manifest run\processed\fbx_2d_pbr_adapted_aux\clean_source_manifest.json `
  --output-root run\processed\fbx_2d_pbr_clean_1915 `
  --material-modes pbr `
  --eye-texture run\processed\eye_texture_inputs\eye.jpg `
  --hide-untextured-lashes `
  --hide-mesh eyeEdge_lod0_mesh `
  --hide-mesh body_lod0_mesh `
  --add-missing-eyebrows `
  --eyebrow-mask-root run\processed\fbx_2d_pbr_adapted_aux\eyebrow_masks `
  --pose-mode uniform --pose-count 5 --pose-seed 42 `
  --yaw-limit 20 --pitch-limit 12 --roll-limit 4 `
  --axis-mode y-up-z-depth --workers 2
```

Validation: run command/manifest and grouping tests, compare CiKe's production render against the approved diagnostic image, inspect other representative heads, then verify all PNGs, per-asset pose counts, exact pose/texture correspondence to the previous manifest, logged hidden meshes, and ZIP checksums. Contact sheets support visual review but do not prove that every pixel is artifact-free.

## Stable Framing Sample (2026-09-09)

Both renderer and batch entrypoints support opt-in `--stable-framing`. The existing default profile and delivered ZIP are unchanged.

- Reuse all five recorded poses, material inputs, and component visibility rules.
- Rotate around a fixed neutral visible-asset bounding-box center (including the neck/shoulder section, not an anatomical neck joint). Keep the original imported transforms and hierarchy behavior.
- Use the union of visible vertices across all planned poses to fit one square orthographic frame, with 10% added total extent. Preserve the selected camera axes; never infer screen axes again from rotated spans. Hidden components do not affect this new frame.
- Keep camera location, orientation and orthographic scale unchanged within the plan. Natural projected face-width changes remain.
- Create lights once, using the neutral visible-asset scale and center, independent of the combined pose bounds. Keep light positions, sizes, powers and exposure unchanged. Shading is not equalized per image.
- This mode fits all visible geometry; `--crop` only retains its existing role in preprocessing (`--clip-body` / `--head-only`). Use the approved visibility profile to obtain a bust crop.
- Record the actual render rig and pivot with each `Rendered` log entry.

Test plan: real Blender integration checks cover pose-union containment, fixed pivot, hidden outlier exclusion, dominant depth spans, pose-order independence and rejection of empty input. Render `0_00000` at 1024 pixels for all original five poses; compare logs for identical rigs/poses/maps/visibility and inspect before/after contact sheets. No UI, database, permission or concurrency behavior is changed. Sample outputs must be outside the delivered dataset and must not overwrite it.

### Approved Full Batch

Concept source: the user approved the five-image sample for contour annotation. The task is to apply that same framing/lighting correction to the existing 383 identities, not create new assets or new pose samples. Deliver 1,915 PBR images plus an importable archive in `run/processed/fbx_2d_pbr_stable_1915`. Keep the old dataset and archive untouched. Fixing material realism, equalizing skin tones, and changing the annotation UI are non-goals.

Terminology: an asset group is one FBX/material configuration and its five poses; stable framing means a shared camera/light rig within that group, not identical projected silhouettes or brightness across different identities.

| Rule / source | Batch boundary and observable result | Acceptance / verification |
| --- | --- | --- |
| Preserve inputs from the clean render manifest | Replay task IDs, identities, poses, maps, eyes, eyebrows and visibility; only output paths and stable-framing setting change | Given the old manifest, when creating the new tasks, then all preserved fields match exactly; verify again against actual Blender logs |
| One rig per complete asset group | `RenderTask.stable_framing` passes through command construction and grouping to the Blender renderer | Given five poses, when rendered, then all five log the same camera, pivot, lights and exposure; real Blender geometry tests and full log audit |
| Resume cannot change pose-union bounds | If any image is missing in a stable group, regenerate the whole group, even when some files already exist | Given one existing image, when resuming, then the plan still contains all five poses; batch orchestration regression test |
| Preserve output integrity | One local coordinator writes manifests after group completion; workers own separate asset directories | Given failures, mark groups failed and retry the entire failed groups before packaging; no silent omission |
| Archive is ready for image import | Exactly 383 groups / 1,915 images, relative `image_path`, metadata and checksums; no auxiliary masks in archive | Decode every PNG, check dimensions/borders, review contact sheets, verify archive member checksums and unchanged old package |

Design: retain the existing batch -> Blender subprocess direction; extend the task configuration and reuse `run_tasks`, rather than duplicate its scheduling in a separate renderer. A local replay driver reconstructs existing task configuration from the already delivered manifest and writes only the new output root. This avoids resampling or rewriting eyebrow assets. There is no server API, database or frontend state involved; the manifest/CLI is the internal contract. No shared writer or multi-process lock is needed because a single coordinator owns the run. The added field defaults false for existing task constructors; command and grouping tests cover both settings.

Main flow: replay -> validate inputs -> render all groups -> retry failed groups -> image/log review -> package/hash verification. Repeated runs may skip fully existing groups, but new settings must use a new root or explicit overwrite; mere file existence does not prove configuration equality. Empty input or missing source assets fail before rendering. Failed or incomplete batches must not be packaged. Timezones and remote permissions do not affect this local export; no remote upload is included.

Test plan: batch unit tests cover flag/manifest propagation, group separation and complete-plan partial recovery; real Blender tests cover fixed projection and pivot. Full batch verification covers actual material/pose equality, fixed rigs, PNG decoding and foreground margins, sample pixel comparison and archive checksums. Visual review checks all-asset contact sheets and enlarged flagged examples. Existing batch/eyebrow tests remain required.

Review safeguards: JSON and CSV checkpoints are each written via an atomic replacement, with JSON authoritative for retry. Different configurations must own distinct output, log and render-plan paths; collisions fail before launching any job rather than silently overwriting plans. In stable mode, automatic axis detection runs after visibility filters and uses only visible meshes. Regression tests cover interrupted checkpoint writes, path conflicts and hidden outliers. The approved batch uses explicit Y-up/Z-depth axes throughout.

Delivery validation: all 383 groups / 1,915 PNGs rendered with zero failed groups. Input fields and actual texture/visibility logs match the clean package; every group has identical logged rigs across its five poses. Full image decoding and boundary checks pass. The approved five-image sample matches exactly for three poses; the other two differ at eight pixels total by one 8-bit channel level, with identical logged configuration. Exact counts are retained rather than claiming bitwise equality. Fourteen Python tests and three real Blender integration tests pass; an independent code review's three findings were fixed and rechecked. Old dataset and ZIP hashes remain unchanged. QA artifacts are in `run/processed/fbx_2d_pbr_stable_qa`.

For future stable exports, add `--stable-framing` to the clean batch command and choose a separate output root. Reusing an existing root after changing configuration requires explicit overwrite. The delivered revision replays the old render manifest through `run/processed/run_stable_batch.py` to avoid regenerating pose or eyebrow inputs.
