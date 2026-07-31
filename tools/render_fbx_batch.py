import argparse
import csv
import json
import os
import re
import subprocess
import sys
import traceback
from dataclasses import asdict, dataclass, fields
from pathlib import Path


RENDERABLE_STATUSES = ("resolved", "inferred_by_char_id")
MATERIAL_MODES = ("basecolor", "pbr")
TASK_STATUS_PENDING = "pending"
TASK_STATUS_PLANNED = "planned"
TASK_STATUS_SKIPPED_EXISTING = "skipped_existing"
TASK_STATUS_RENDERED = "rendered"
TASK_STATUS_FAILED = "failed"


@dataclass(frozen=True)
class Pose:
    pose_index: int
    pose_name: str
    yaw: float
    pitch: float
    roll: float


@dataclass
class RenderTask:
    task_id: str
    source_status: str
    fbx_name: str
    fbx_path: str
    texture_path: str
    eye_texture_path: str
    material_mode: str
    component_materials: str
    pose_index: int
    pose_name: str
    yaw: float
    pitch: float
    roll: float
    output_path: str
    log_path: str
    status: str = TASK_STATUS_PENDING
    return_code: str = ""
    error: str = ""
    command: str = ""


DEFAULT_POSES = (
    Pose(pose_index=0, pose_name="front", yaw=0.0, pitch=0.0, roll=0.0),
    Pose(pose_index=1, pose_name="yaw_left", yaw=-18.0, pitch=4.0, roll=-2.0),
    Pose(pose_index=2, pose_name="yaw_right", yaw=16.0, pitch=-3.0, roll=2.0),
    Pose(pose_index=3, pose_name="pitch_up", yaw=7.0, pitch=10.0, roll=3.0),
    Pose(pose_index=4, pose_name="pitch_down", yaw=-9.0, pitch=-8.0, roll=-3.0),
)


def parse_material_modes(value):
    normalized = value.strip().lower()
    if normalized in ("both", "all"):
        return list(MATERIAL_MODES)

    modes = [part.strip().lower() for part in value.split(",") if part.strip()]
    invalid_modes = [mode for mode in modes if mode not in MATERIAL_MODES]
    if invalid_modes:
        raise ValueError(f"Unsupported material mode(s): {', '.join(invalid_modes)}")
    if not modes:
        raise ValueError("At least one material mode is required.")

    deduped = []
    for mode in modes:
        if mode not in deduped:
            deduped.append(mode)
    return deduped


def parse_include_statuses(value):
    statuses = [part.strip() for part in value.split(",") if part.strip()]
    if not statuses:
        raise ValueError("At least one manifest source status is required.")
    return statuses


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Render FBX assets from fbx_texture_manifest.json into paired "
            "basecolor/PBR 2D image sets."
        )
    )
    parser.add_argument(
        "--manifest",
        default="run/processed/fbx_texture_manifest.json",
        help="Input manifest from tools/build_fbx_texture_manifest.py.",
    )
    parser.add_argument(
        "--output-root",
        default="run/processed/fbx_2d_renders",
        help="Directory where rendered PNGs and render manifests are written.",
    )
    parser.add_argument(
        "--blender",
        default=os.environ.get("BLENDER", "blender"),
        help="Blender executable path. Can also be provided with BLENDER env var.",
    )
    parser.add_argument(
        "--renderer",
        default=str(Path(__file__).with_name("render_fbx_blender.py")),
        help="Single-FBX Blender render script.",
    )
    parser.add_argument(
        "--material-modes",
        default="both",
        help="Material modes to render: both, basecolor, pbr, or comma-separated values.",
    )
    parser.add_argument(
        "--include-statuses",
        default=",".join(RENDERABLE_STATUSES),
        help="Comma-separated source manifest statuses to render.",
    )
    parser.add_argument(
        "--component-materials",
        choices=("skin-only", "hide-unsupported", "single"),
        default="skin-only",
        help="Component material strategy passed to the single-FBX renderer.",
    )
    parser.add_argument(
        "--eye-texture",
        default="",
        help="Optional eye texture applied to eye meshes by the single-FBX renderer.",
    )
    parser.add_argument("--resolution", type=int, default=1024, help="Square output resolution.")
    parser.add_argument(
        "--crop",
        choices=("full", "head"),
        default="head",
        help="Camera crop passed to the single-FBX renderer.",
    )
    parser.add_argument(
        "--depth-sign",
        choices=("-1", "1"),
        default="1",
        help="Camera side passed to the single-FBX renderer.",
    )
    parser.add_argument(
        "--limit-assets",
        type=int,
        default=0,
        help="Render only the first N source FBX rows. Zero means no limit.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Write the render manifest without launching Blender.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Render even if an output PNG already exists.",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Stop the batch on the first render failure.",
    )
    parser.add_argument(
        "--no-auto-maps",
        action="store_true",
        help="Do not auto-load Normal/Roughness/Specular/Cavity maps for PBR mode.",
    )
    parser.add_argument(
        "--no-clip-body",
        action="store_true",
        help="Do not pass --clip-body for head crops.",
    )
    parser.add_argument(
        "--head-only",
        action="store_true",
        help="Pass --head-only to the single-FBX renderer.",
    )
    parser.add_argument(
        "--render-manifest-json",
        default="",
        help="Optional render manifest JSON path. Defaults under --output-root.",
    )
    parser.add_argument(
        "--render-manifest-csv",
        default="",
        help="Optional render manifest CSV path. Defaults under --output-root.",
    )
    args = parser.parse_args(argv)

    try:
        args.material_modes = parse_material_modes(args.material_modes)
        args.include_statuses = parse_include_statuses(args.include_statuses)
    except ValueError as error:
        parser.error(str(error))

    if args.resolution <= 0:
        parser.error("--resolution must be positive.")
    if args.limit_assets < 0:
        parser.error("--limit-assets cannot be negative.")
    if args.eye_texture and not Path(args.eye_texture).expanduser().exists():
        parser.error(f"--eye-texture does not exist: {args.eye_texture}")

    return args


def load_manifest(path):
    manifest_path = Path(path)
    if not manifest_path.exists():
        raise FileNotFoundError(f"Source manifest is missing: {manifest_path}")
    with manifest_path.open("r", encoding="utf-8") as file:
        manifest = json.load(file)
    if "rows" not in manifest or not isinstance(manifest["rows"], list):
        raise ValueError(f"Manifest does not contain a rows array: {manifest_path}")
    return manifest


def resolve_manifest_path(*, value, cwd):
    path = Path(value)
    if path.is_absolute():
        return path
    return (cwd / path).resolve()


def safe_path_segment(value):
    segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._")
    return segment[:160] or "asset"


def select_renderable_rows(*, manifest, include_statuses, limit_assets=0):
    selected = []
    allowed_statuses = set(include_statuses)
    for row in manifest["rows"]:
        if row.get("status") not in allowed_statuses:
            continue
        selected.append(row)
        if limit_assets and len(selected) >= limit_assets:
            break
    return selected


def output_path_for(*, output_root, asset_id, pose, material_mode):
    pose_dir = f"pose_{pose.pose_index:02d}_{safe_path_segment(pose.pose_name)}"
    return output_root / asset_id / pose_dir / f"{material_mode}.png"


def build_render_tasks(
    manifest,
    output_root,
    material_modes=None,
    poses=None,
    include_statuses=RENDERABLE_STATUSES,
    limit_assets=0,
    cwd=None,
    component_materials="skin-only",
    eye_texture_path="",
):
    material_modes = list(material_modes or MATERIAL_MODES)
    poses = list(poses or DEFAULT_POSES)
    output_root = Path(output_root)
    cwd = Path(cwd or Path.cwd())
    rows = select_renderable_rows(
        manifest=manifest,
        include_statuses=include_statuses,
        limit_assets=limit_assets,
    )

    tasks = []
    for row in rows:
        fbx_name = row.get("fbx_name") or Path(row["fbx_path"]).name
        asset_id = safe_path_segment(Path(fbx_name).stem)
        fbx_path = resolve_manifest_path(value=row["fbx_path"], cwd=cwd)
        texture_path = resolve_manifest_path(value=row["basecolor_path"], cwd=cwd)
        for pose in poses:
            for material_mode in material_modes:
                output_path = output_path_for(
                    output_root=output_root,
                    asset_id=asset_id,
                    pose=pose,
                    material_mode=material_mode,
                )
                task_id = f"{asset_id}:{pose.pose_index:02d}:{material_mode}"
                tasks.append(
                    RenderTask(
                        task_id=task_id,
                        source_status=row["status"],
                        fbx_name=fbx_name,
                        fbx_path=str(fbx_path),
                        texture_path=str(texture_path),
                        eye_texture_path=str(resolve_manifest_path(value=eye_texture_path, cwd=cwd))
                        if eye_texture_path
                        else "",
                        material_mode=material_mode,
                        component_materials=component_materials,
                        pose_index=pose.pose_index,
                        pose_name=pose.pose_name,
                        yaw=pose.yaw,
                        pitch=pose.pitch,
                        roll=pose.roll,
                        output_path=str(output_path),
                        log_path=str(output_path.with_suffix(".log")),
                    )
                )
    return tasks


def build_render_command(
    *,
    blender_path,
    renderer_path,
    task,
    resolution,
    crop,
    depth_sign,
    auto_maps=True,
    clip_body=True,
    head_only=False,
):
    command = [
        str(blender_path),
        "--background",
        "--python",
        str(renderer_path),
        "--",
        "--fbx",
        task.fbx_path,
        "--texture",
        task.texture_path,
        "--output",
        task.output_path,
        "--resolution",
        str(resolution),
        "--crop",
        crop,
        "--depth-sign",
        str(depth_sign),
        "--yaw",
        str(task.yaw),
        "--pitch",
        str(task.pitch),
        "--roll",
        str(task.roll),
        "--material-mode",
        task.material_mode,
        "--component-materials",
        task.component_materials,
    ]
    if task.eye_texture_path:
        command.extend(["--eye-texture", task.eye_texture_path])
    if task.material_mode == "pbr" and auto_maps:
        command.append("--auto-maps")
    if crop == "head" and clip_body:
        command.append("--clip-body")
    if head_only:
        command.append("--head-only")
    return command


def task_rows(tasks):
    return [asdict(task) for task in tasks]


def summarize_tasks(tasks):
    summary = {"total_tasks": len(tasks)}
    for status in (
        TASK_STATUS_PENDING,
        TASK_STATUS_PLANNED,
        TASK_STATUS_SKIPPED_EXISTING,
        TASK_STATUS_RENDERED,
        TASK_STATUS_FAILED,
    ):
        summary[status] = sum(1 for task in tasks if task.status == status)
    summary["basecolor_tasks"] = sum(1 for task in tasks if task.material_mode == "basecolor")
    summary["pbr_tasks"] = sum(1 for task in tasks if task.material_mode == "pbr")
    summary["source_assets"] = len({task.fbx_name for task in tasks})
    return summary


def write_render_manifests(*, json_path, csv_path, tasks):
    rows = task_rows(tasks)
    json_path = Path(json_path)
    csv_path = Path(csv_path)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with json_path.open("w", encoding="utf-8") as file:
        json.dump({"summary": summarize_tasks(tasks), "tasks": rows}, file, ensure_ascii=False, indent=2)
        file.write("\n")
    with csv_path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=[field.name for field in fields(RenderTask)])
        writer.writeheader()
        writer.writerows(rows)


def write_log(*, task, stdout, stderr):
    log_path = Path(task.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        "\n".join(
            [
                f"task_id={task.task_id}",
                f"command={task.command}",
                "",
                "[stdout]",
                stdout,
                "",
                "[stderr]",
                stderr,
            ]
        ),
        encoding="utf-8",
    )


def short_error(*, stdout, stderr):
    combined = "\n".join(part for part in (stderr.strip(), stdout.strip()) if part)
    lines = combined.splitlines()
    return "\n".join(lines[-12:])


def run_tasks(
    *,
    tasks,
    blender_path,
    renderer_path,
    resolution,
    crop,
    depth_sign,
    render_manifest_json,
    render_manifest_csv,
    auto_maps=True,
    clip_body=True,
    head_only=False,
    dry_run=False,
    overwrite=False,
    fail_fast=False,
):
    for index, task in enumerate(tasks, start=1):
        command = build_render_command(
            blender_path=blender_path,
            renderer_path=renderer_path,
            task=task,
            resolution=resolution,
            crop=crop,
            depth_sign=depth_sign,
            auto_maps=auto_maps,
            clip_body=clip_body,
            head_only=head_only,
        )
        task.command = subprocess.list2cmdline(command)
        output_path = Path(task.output_path)

        if dry_run:
            task.status = TASK_STATUS_PLANNED
            print(f"[{index}/{len(tasks)}] planned {task.task_id}")
            write_render_manifests(
                json_path=render_manifest_json,
                csv_path=render_manifest_csv,
                tasks=tasks,
            )
            continue

        if output_path.exists() and not overwrite:
            task.status = TASK_STATUS_SKIPPED_EXISTING
            print(f"[{index}/{len(tasks)}] skipped existing {output_path}")
            write_render_manifests(
                json_path=render_manifest_json,
                csv_path=render_manifest_csv,
                tasks=tasks,
            )
            continue

        output_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"[{index}/{len(tasks)}] rendering {task.task_id}")
        result = subprocess.run(command, text=True, capture_output=True)
        task.return_code = str(result.returncode)
        write_log(task=task, stdout=result.stdout, stderr=result.stderr)

        if result.returncode == 0:
            task.status = TASK_STATUS_RENDERED
        else:
            task.status = TASK_STATUS_FAILED
            task.error = short_error(stdout=result.stdout, stderr=result.stderr)
            print(f"Render failed for {task.task_id}: {task.error}", file=sys.stderr)
            write_render_manifests(
                json_path=render_manifest_json,
                csv_path=render_manifest_csv,
                tasks=tasks,
            )
            if fail_fast:
                raise RuntimeError(f"Render failed for {task.task_id}")

        write_render_manifests(
            json_path=render_manifest_json,
            csv_path=render_manifest_csv,
            tasks=tasks,
        )

    return summarize_tasks(tasks)


def default_manifest_paths(*, output_root, json_path, csv_path):
    output_root = Path(output_root)
    return (
        Path(json_path) if json_path else output_root / "render_manifest.json",
        Path(csv_path) if csv_path else output_root / "render_manifest.csv",
    )


def main(argv=None):
    args = parse_args(argv)
    manifest = load_manifest(args.manifest)
    output_root = Path(args.output_root)
    render_manifest_json, render_manifest_csv = default_manifest_paths(
        output_root=output_root,
        json_path=args.render_manifest_json,
        csv_path=args.render_manifest_csv,
    )
    tasks = build_render_tasks(
        manifest,
        output_root=output_root,
        material_modes=args.material_modes,
        include_statuses=args.include_statuses,
        limit_assets=args.limit_assets,
        component_materials=args.component_materials,
        eye_texture_path=args.eye_texture,
    )
    if not tasks:
        raise RuntimeError("No render tasks were generated from the input manifest.")

    summary = run_tasks(
        tasks=tasks,
        blender_path=Path(args.blender),
        renderer_path=Path(args.renderer),
        resolution=args.resolution,
        crop=args.crop,
        depth_sign=args.depth_sign,
        render_manifest_json=render_manifest_json,
        render_manifest_csv=render_manifest_csv,
        auto_maps=not args.no_auto_maps,
        clip_body=not args.no_clip_body,
        head_only=args.head_only,
        dry_run=args.dry_run,
        overwrite=args.overwrite,
        fail_fast=args.fail_fast,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
