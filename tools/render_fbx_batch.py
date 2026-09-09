import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import csv
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
import tempfile
import traceback
from dataclasses import asdict, dataclass, fields
from pathlib import Path

if __package__:
    from .eyebrow_augmentation import (
        build_eyebrow_plan,
        discover_eyebrow_assets,
        load_brow_presence,
        texture_id_for_row,
        write_eyebrow_mask,
    )
else:
    from eyebrow_augmentation import (
        build_eyebrow_plan,
        discover_eyebrow_assets,
        load_brow_presence,
        texture_id_for_row,
        write_eyebrow_mask,
    )


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
    texture_id: int
    eyebrow_status: str
    eyebrow_mask_path: str
    eyebrow_asset_path: str
    eyebrow_color: str
    eyebrow_seed: int
    material_mode: str
    component_materials: str
    hide_untextured_lashes: bool
    hidden_mesh_names: list[str]
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
    stable_framing: bool = False


DEFAULT_POSES = (
    Pose(pose_index=0, pose_name="front", yaw=0.0, pitch=0.0, roll=0.0),
    Pose(pose_index=1, pose_name="yaw_left", yaw=-18.0, pitch=4.0, roll=-2.0),
    Pose(pose_index=2, pose_name="yaw_right", yaw=16.0, pitch=-3.0, roll=2.0),
    Pose(pose_index=3, pose_name="pitch_up", yaw=7.0, pitch=10.0, roll=3.0),
    Pose(pose_index=4, pose_name="pitch_down", yaw=-9.0, pitch=-8.0, roll=-3.0),
)


def stable_asset_seed(*, base_seed, asset_key):
    digest = hashlib.sha256(f"{base_seed}:{asset_key}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=False)


def build_uniform_poses(
    *,
    asset_key,
    count,
    base_seed,
    yaw_limit,
    pitch_limit,
    roll_limit,
):
    if count <= 0:
        raise ValueError("Uniform pose count must be positive.")
    limits = {"yaw": yaw_limit, "pitch": pitch_limit, "roll": roll_limit}
    if any(not math.isfinite(limit) or limit < 0 for limit in limits.values()):
        raise ValueError("Uniform pose limits must be finite and non-negative.")

    rng = random.Random(stable_asset_seed(base_seed=base_seed, asset_key=asset_key))
    return [
        Pose(
            pose_index=index,
            pose_name=f"sample_{index:02d}",
            yaw=rng.uniform(-yaw_limit, yaw_limit),
            pitch=rng.uniform(-pitch_limit, pitch_limit),
            roll=rng.uniform(-roll_limit, roll_limit),
        )
        for index in range(count)
    ]


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
        "--axis-mode",
        choices=("y-up-z-depth", "auto"),
        default="y-up-z-depth",
        help="Camera-axis strategy passed to the single-FBX renderer.",
    )
    parser.add_argument(
        "--eye-texture",
        default="",
        help="Optional eye texture applied to eye meshes by the single-FBX renderer.",
    )
    parser.add_argument(
        "--hide-untextured-lashes",
        action="store_true",
        help="Hide eyelash card meshes that lack their matching transparent texture.",
    )
    parser.add_argument(
        "--hide-mesh",
        action="append",
        default=[],
        help="Exact mesh name to hide without changing camera framing; repeat as needed.",
    )
    parser.add_argument(
        "--add-missing-eyebrows",
        action="store_true",
        help="Add one deterministic project eyebrow asset when brows.json marks a texture false.",
    )
    parser.add_argument(
        "--brow-presence",
        default="run/run/Makeup/Features/brows.json",
        help="Project brows.json used by --add-missing-eyebrows.",
    )
    parser.add_argument(
        "--eyebrow-assets",
        default="run/run/Makeup/Features/Eyebrows",
        help="Project eyebrow PNG directory used by --add-missing-eyebrows.",
    )
    parser.add_argument(
        "--eyebrow-mask-root",
        default="",
        help="Generated eyebrow mask directory. Defaults to <output-root>/_eyebrow_masks.",
    )
    parser.add_argument("--eyebrow-seed", type=int, default=42)
    parser.add_argument(
        "--pose-mode",
        choices=("fixed", "uniform"),
        default="fixed",
        help="Use the five fixed reference poses or deterministic per-asset uniform samples.",
    )
    parser.add_argument("--pose-count", type=int, default=5, help="Pose count in uniform mode.")
    parser.add_argument("--pose-seed", type=int, default=42, help="Base seed in uniform mode.")
    parser.add_argument("--yaw-limit", type=float, default=20.0)
    parser.add_argument("--pitch-limit", type=float, default=12.0)
    parser.add_argument("--roll-limit", type=float, default=4.0)
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Number of FBX assets rendered concurrently.",
    )
    parser.add_argument("--resolution", type=int, default=1024, help="Square output resolution.")
    parser.add_argument(
        "--stable-framing", action="store_true",
        help="Share camera and lights across every pose of an asset; resume regenerates partial groups.",
    )
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
    if args.pose_count <= 0:
        parser.error("--pose-count must be positive.")
    if args.workers <= 0:
        parser.error("--workers must be positive.")
    if any(
        not math.isfinite(limit) or limit < 0
        for limit in (args.yaw_limit, args.pitch_limit, args.roll_limit)
    ):
        parser.error("pose limits must be finite and non-negative.")
    if args.eye_texture and not Path(args.eye_texture).expanduser().exists():
        parser.error(f"--eye-texture does not exist: {args.eye_texture}")
    if args.add_missing_eyebrows:
        if not Path(args.brow_presence).expanduser().exists():
            parser.error(f"--brow-presence does not exist: {args.brow_presence}")
        if not Path(args.eyebrow_assets).expanduser().is_dir():
            parser.error(f"--eyebrow-assets is not a directory: {args.eyebrow_assets}")

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


def prepare_eyebrow_plans(
    *,
    rows,
    brow_presence_path,
    eyebrow_assets_path,
    mask_root,
    base_seed,
):
    brow_presence = load_brow_presence(brow_presence_path)
    eyebrow_assets = discover_eyebrow_assets(eyebrow_assets_path)
    plans = {}
    for row in rows:
        texture_id = texture_id_for_row(row)
        if texture_id in plans:
            continue
        plan = build_eyebrow_plan(
            row=row,
            brow_presence=brow_presence,
            eyebrow_assets=eyebrow_assets,
            mask_root=mask_root,
            base_seed=base_seed,
        )
        write_eyebrow_mask(plan)
        plans[texture_id] = plan
    return plans


def build_render_tasks(
    manifest,
    output_root,
    material_modes=None,
    poses=None,
    include_statuses=RENDERABLE_STATUSES,
    limit_assets=0,
    cwd=None,
    component_materials="skin-only",
    hide_untextured_lashes=False,
    hidden_mesh_names=None,
    eye_texture_path="",
    eyebrow_plans=None,
    pose_mode="fixed",
    pose_count=5,
    pose_seed=42,
    yaw_limit=20.0,
    pitch_limit=12.0,
    roll_limit=4.0,
    stable_framing=False,
):
    material_modes = list(material_modes or MATERIAL_MODES)
    fixed_poses = list(poses) if poses is not None else list(DEFAULT_POSES)
    eyebrow_plans = eyebrow_plans or {}
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
        texture_id = texture_id_for_row(row)
        eyebrow_plan = eyebrow_plans.get(texture_id)
        if pose_mode == "uniform" and poses is None:
            row_poses = build_uniform_poses(
                asset_key=fbx_name,
                count=pose_count,
                base_seed=pose_seed,
                yaw_limit=yaw_limit,
                pitch_limit=pitch_limit,
                roll_limit=roll_limit,
            )
        else:
            row_poses = fixed_poses
        for pose in row_poses:
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
                        texture_id=texture_id,
                        eyebrow_status=eyebrow_plan.status if eyebrow_plan else "disabled",
                        eyebrow_mask_path=eyebrow_plan.mask_path if eyebrow_plan else "",
                        eyebrow_asset_path=eyebrow_plan.asset_path if eyebrow_plan else "",
                        eyebrow_color=eyebrow_plan.color_arg if eyebrow_plan else "",
                        eyebrow_seed=eyebrow_plan.seed if eyebrow_plan else 0,
                        material_mode=material_mode,
                        component_materials=component_materials,
                        hide_untextured_lashes=hide_untextured_lashes,
                        hidden_mesh_names=list(hidden_mesh_names or []),
                        stable_framing=stable_framing,
                        pose_index=pose.pose_index,
                        pose_name=pose.pose_name,
                        yaw=pose.yaw,
                        pitch=pose.pitch,
                        roll=pose.roll,
                        output_path=str(output_path),
                        log_path=str(output_root / asset_id / f"{material_mode}.log"),
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
    axis_mode="y-up-z-depth",
    auto_maps=True,
    clip_body=True,
    head_only=False,
    render_plan_path=None,
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
        "--resolution",
        str(resolution),
        "--crop",
        crop,
        "--depth-sign",
        str(depth_sign),
        "--axis-mode",
        axis_mode,
        "--material-mode",
        task.material_mode,
        "--component-materials",
        task.component_materials,
    ]
    if render_plan_path:
        command.extend(["--render-plan", str(render_plan_path)])
    else:
        command.extend(
            [
                "--output",
                task.output_path,
                "--yaw",
                str(task.yaw),
                "--pitch",
                str(task.pitch),
                "--roll",
                str(task.roll),
            ]
        )
    if task.eye_texture_path:
        command.extend(["--eye-texture", task.eye_texture_path])
    if task.hide_untextured_lashes:
        command.append("--hide-untextured-lashes")
    if task.stable_framing:
        command.append("--stable-framing")
    for mesh_name in task.hidden_mesh_names:
        command.extend(["--hide-mesh", mesh_name])
    if task.eyebrow_mask_path:
        command.extend(
            [
                "--eyebrow-mask",
                task.eyebrow_mask_path,
                "--eyebrow-color",
                task.eyebrow_color,
            ]
        )
    if task.material_mode == "pbr" and auto_maps:
        command.append("--auto-maps")
    if crop == "head" and clip_body:
        command.append("--clip-body")
    if head_only:
        command.append("--head-only")
    return command


def group_render_tasks(tasks):
    groups = {}
    for task in tasks:
        key = (
            task.fbx_path,
            task.texture_path,
            task.eye_texture_path,
            task.eyebrow_mask_path,
            task.eyebrow_color,
            task.material_mode,
            task.component_materials,
            task.hide_untextured_lashes,
            tuple(sorted(task.hidden_mesh_names)),
            task.stable_framing,
        )
        groups.setdefault(key, []).append(task)
    return list(groups.values())


def render_plan_path_for_group(tasks):
    first = tasks[0]
    asset_root = Path(first.output_path).parent.parent
    return asset_root / f"{first.material_mode}_render_plan.json"


def write_render_plan(*, path, tasks):
    plan_path = Path(path)
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "renders": [
            {
                "task_id": task.task_id,
                "output": task.output_path,
                "yaw": task.yaw,
                "pitch": task.pitch,
                "roll": task.roll,
            }
            for task in tasks
        ]
    }
    with plan_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


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


@contextmanager
def atomic_manifest_file(path, *, newline=None):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline=newline, dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as file:
            temporary = Path(file.name)
            yield file
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_render_manifests(*, json_path, csv_path, tasks):
    rows = task_rows(tasks)
    json_path = Path(json_path)
    csv_path = Path(csv_path)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_manifest_file(json_path) as file:
        json.dump({"summary": summarize_tasks(tasks), "tasks": rows}, file, ensure_ascii=False, indent=2)
        file.write("\n")
    with atomic_manifest_file(csv_path, newline="") as file:
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
    axis_mode,
    render_manifest_json,
    render_manifest_csv,
    auto_maps=True,
    clip_body=True,
    head_only=False,
    dry_run=False,
    overwrite=False,
    fail_fast=False,
    workers=1,
):
    groups = group_render_tasks(tasks)
    claimed_paths = set()
    for group in groups:
        owned_paths = {render_plan_path_for_group(group).resolve()}
        owned_paths.update(Path(task.log_path).resolve() for task in group)
        owned_paths.update(Path(task.output_path).resolve() for task in group)
        if claimed_paths.intersection(owned_paths):
            raise ValueError("Render configurations share output/plan/log paths; use separate output roots.")
        claimed_paths.update(owned_paths)
    jobs = []
    for group_index, group in enumerate(groups, start=1):
        active_tasks = []
        for task in group:
            if Path(task.output_path).exists() and not overwrite:
                task.status = TASK_STATUS_SKIPPED_EXISTING
            else:
                active_tasks.append(task)

        if not active_tasks:
            print(f"[{group_index}/{len(groups)}] skipped existing {group[0].fbx_name}")
            continue

        if group[0].stable_framing:
            # The complete pose set determines the shared camera, including on resume.
            active_tasks = list(group)
            for task in active_tasks:
                task.status = TASK_STATUS_PENDING

        if dry_run:
            for task in active_tasks:
                task.status = TASK_STATUS_PLANNED
            print(f"[{group_index}/{len(groups)}] planned {group[0].fbx_name} ({len(active_tasks)} poses)")
            continue

        plan_path = render_plan_path_for_group(group)
        write_render_plan(path=plan_path, tasks=active_tasks)
        command = build_render_command(
            blender_path=blender_path,
            renderer_path=renderer_path,
            task=active_tasks[0],
            resolution=resolution,
            crop=crop,
            depth_sign=depth_sign,
            axis_mode=axis_mode,
            auto_maps=auto_maps,
            clip_body=clip_body,
            head_only=head_only,
            render_plan_path=plan_path,
        )
        command_text = subprocess.list2cmdline(command)
        for task in active_tasks:
            task.command = command_text
        jobs.append({"group_index": group_index, "tasks": active_tasks, "command": command})

    write_render_manifests(
        json_path=render_manifest_json,
        csv_path=render_manifest_csv,
        tasks=tasks,
    )
    if dry_run or not jobs:
        return summarize_tasks(tasks)

    def finish_job(job, result):
        active_tasks = job["tasks"]
        first = active_tasks[0]
        for task in active_tasks:
            task.return_code = str(result.returncode)
        write_log(task=first, stdout=result.stdout, stderr=result.stderr)

        missing_outputs = [task.output_path for task in active_tasks if not Path(task.output_path).exists()]
        if result.returncode == 0 and not missing_outputs:
            for task in active_tasks:
                task.status = TASK_STATUS_RENDERED
            print(
                f"[{job['group_index']}/{len(groups)}] rendered "
                f"{first.fbx_name} ({len(active_tasks)} poses)"
            )
            return False

        error = short_error(stdout=result.stdout, stderr=result.stderr)
        if missing_outputs:
            missing_summary = ", ".join(missing_outputs[:3])
            error = f"{error}\nMissing output(s): {missing_summary}".strip()
        for task in active_tasks:
            task.status = TASK_STATUS_FAILED
            task.error = error
        print(f"Render failed for {first.fbx_name}: {error}", file=sys.stderr)
        return True

    failure_detected = False
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_jobs = {
            executor.submit(
                subprocess.run,
                job["command"],
                text=True,
                capture_output=True,
            ): job
            for job in jobs
        }
        for future in as_completed(future_jobs):
            job = future_jobs[future]
            try:
                result = future.result()
            except Exception as error:
                first = job["tasks"][0]
                result = subprocess.CompletedProcess(job["command"], 1, "", traceback.format_exc())
                print(f"Blender launch failed for {first.fbx_name}: {error}", file=sys.stderr)
            failure_detected = finish_job(job, result) or failure_detected
            write_render_manifests(
                json_path=render_manifest_json,
                csv_path=render_manifest_csv,
                tasks=tasks,
            )

    if failure_detected and fail_fast:
        raise RuntimeError("At least one render group failed.")

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
    selected_rows = select_renderable_rows(
        manifest=manifest,
        include_statuses=args.include_statuses,
        limit_assets=args.limit_assets,
    )
    eyebrow_plans = {}
    if args.add_missing_eyebrows:
        mask_root = Path(args.eyebrow_mask_root) if args.eyebrow_mask_root else output_root / "_eyebrow_masks"
        eyebrow_plans = prepare_eyebrow_plans(
            rows=selected_rows,
            brow_presence_path=args.brow_presence,
            eyebrow_assets_path=args.eyebrow_assets,
            mask_root=mask_root,
            base_seed=args.eyebrow_seed,
        )
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
        hide_untextured_lashes=args.hide_untextured_lashes,
        hidden_mesh_names=args.hide_mesh,
        eye_texture_path=args.eye_texture,
        eyebrow_plans=eyebrow_plans,
        pose_mode=args.pose_mode,
        pose_count=args.pose_count,
        pose_seed=args.pose_seed,
        yaw_limit=args.yaw_limit,
        pitch_limit=args.pitch_limit,
        roll_limit=args.roll_limit,
        stable_framing=args.stable_framing,
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
        axis_mode=args.axis_mode,
        render_manifest_json=render_manifest_json,
        render_manifest_csv=render_manifest_csv,
        auto_maps=not args.no_auto_maps,
        clip_body=not args.no_clip_body,
        head_only=args.head_only,
        dry_run=args.dry_run,
        overwrite=args.overwrite,
        fail_fast=args.fail_fast,
        workers=args.workers,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
