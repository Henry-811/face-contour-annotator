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

## Scope Rules

- `basecolor` uses the skin Basecolor as an unlit material.
- `pbr` uses the same Basecolor plus any same-directory `Normal.png`, `Roughness.png`, `Specular.png`, and `Cavity.png` discovered by `--auto-maps`.
- `--eye-texture <path>` optionally applies a real eye diffuse texture to `eyeLeft` and `eyeRight` meshes only. This uses the FBX eye mesh UVs, so the result must be visually checked for UV alignment.
- The batch skips `ambiguous` manifest rows by default.
- Missing or failed renders are recorded in `render_manifest.json` and `render_manifest.csv`; failures are not silently swallowed.
- No procedural eye, lash, tooth, or hair material is added. Assets without one-to-one component textures are left with imported FBX materials under `skin-only`.
