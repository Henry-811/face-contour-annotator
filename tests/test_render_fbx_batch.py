import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.render_fbx_batch import (
    Pose,
    build_render_command,
    build_render_tasks,
    build_uniform_poses,
    group_render_tasks,
    parse_material_modes,
    parse_args,
    run_tasks,
    write_render_plan,
    write_render_manifests,
)


def make_manifest():
    return {
        "summary": {},
        "rows": [
            {
                "fbx_name": "0_00000.fbx",
                "fbx_path": "run/run/fbx/0_00000.fbx",
                "basecolor_path": "run/run/motherasset/ori/0/Basecolor.png",
                "tex_id": 0,
                "inferred_tex_id": "",
                "status": "resolved",
            },
            {
                "fbx_name": "S_F_NChar_Test_00000.fbx",
                "fbx_path": "run/run/fbx/S_F_NChar_Test_00000.fbx",
                "basecolor_path": "run/run/motherasset/ori/300/Basecolor.png",
                "tex_id": "",
                "inferred_tex_id": 300,
                "status": "inferred_by_char_id",
            },
            {
                "fbx_name": "S_M_MChar_Dupe_00000.fbx",
                "fbx_path": "run/run/fbx/S_M_MChar_Dupe_00000.fbx",
                "basecolor_path": "",
                "tex_id": "",
                "inferred_tex_id": "",
                "status": "ambiguous",
            },
        ],
    }


class RenderFbxBatchTest(unittest.TestCase):
    def test_should_parse_material_modes_with_both_and_dedupe_comma_values(self):
        self.assertEqual(parse_material_modes("both"), ["basecolor", "pbr"])
        self.assertEqual(parse_material_modes("pbr,basecolor,pbr"), ["pbr", "basecolor"])

        with self.assertRaises(ValueError):
            parse_material_modes("basecolor,unknown")

    def test_should_build_paired_tasks_for_renderable_rows_only(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            poses = [
                Pose(pose_index=0, pose_name="front", yaw=0.0, pitch=0.0, roll=0.0),
                Pose(pose_index=1, pose_name="yaw_left", yaw=-18.0, pitch=4.0, roll=-2.0),
            ]

            tasks = build_render_tasks(
                make_manifest(),
                output_root=root / "out",
                material_modes=["basecolor", "pbr"],
                poses=poses,
                cwd=root,
            )

            self.assertEqual(len(tasks), 8)
            self.assertEqual({task.fbx_name for task in tasks}, {"0_00000.fbx", "S_F_NChar_Test_00000.fbx"})
            self.assertEqual({task.material_mode for task in tasks}, {"basecolor", "pbr"})
            self.assertEqual({task.pose_index for task in tasks}, {0, 1})
            expected = root / "out" / "0_00000" / "pose_00_front" / "basecolor.png"
            self.assertIn(str(expected), {task.output_path for task in tasks})

    def test_should_build_deterministic_uniform_poses_per_asset_within_limits(self):
        first = build_uniform_poses(
            asset_key="0_00000.fbx",
            count=5,
            base_seed=42,
            yaw_limit=20.0,
            pitch_limit=12.0,
            roll_limit=4.0,
        )
        repeated = build_uniform_poses(
            asset_key="0_00000.fbx",
            count=5,
            base_seed=42,
            yaw_limit=20.0,
            pitch_limit=12.0,
            roll_limit=4.0,
        )
        other = build_uniform_poses(
            asset_key="1_00000.fbx",
            count=5,
            base_seed=42,
            yaw_limit=20.0,
            pitch_limit=12.0,
            roll_limit=4.0,
        )

        self.assertEqual(first, repeated)
        self.assertNotEqual(first, other)
        self.assertTrue(all(abs(pose.yaw) <= 20.0 for pose in first))
        self.assertTrue(all(abs(pose.pitch) <= 12.0 for pose in first))
        self.assertTrue(all(abs(pose.roll) <= 4.0 for pose in first))

    def test_should_build_blender_command_with_auto_maps_only_for_pbr(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tasks = build_render_tasks(
                make_manifest(),
                output_root=root / "out",
                material_modes=["basecolor", "pbr"],
                poses=[Pose(pose_index=0, pose_name="front", yaw=0.0, pitch=0.0, roll=0.0)],
                cwd=root,
                limit_assets=1,
                eye_texture_path="assets/eye.jpg",
            )
            basecolor_task = next(task for task in tasks if task.material_mode == "basecolor")
            pbr_task = next(task for task in tasks if task.material_mode == "pbr")

            basecolor_command = build_render_command(
                blender_path=Path("blender"),
                renderer_path=Path("tools/render_fbx_blender.py"),
                task=basecolor_task,
                resolution=1024,
                crop="head",
                depth_sign="1",
                auto_maps=True,
                clip_body=True,
            )
            pbr_command = build_render_command(
                blender_path=Path("blender"),
                renderer_path=Path("tools/render_fbx_blender.py"),
                task=pbr_task,
                resolution=1024,
                crop="head",
                depth_sign="1",
                auto_maps=True,
                clip_body=True,
            )

            self.assertNotIn("--auto-maps", basecolor_command)
            self.assertIn("--auto-maps", pbr_command)
            self.assertIn("--clip-body", pbr_command)
            self.assertIn("--component-materials", pbr_command)
            self.assertIn("skin-only", pbr_command)
            self.assertIn("--axis-mode", pbr_command)
            self.assertIn("y-up-z-depth", pbr_command)
            self.assertIn("--eye-texture", pbr_command)
            self.assertIn(str(root / "assets" / "eye.jpg"), pbr_command)
            self.assertNotIn("--hide-untextured-lashes", pbr_command)

    def test_should_pass_explicit_untextured_lash_filter_to_blender(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            task = build_render_tasks(
                make_manifest(),
                output_root=root / "out",
                material_modes=["pbr"],
                poses=[Pose(pose_index=0, pose_name="front", yaw=0.0, pitch=0.0, roll=0.0)],
                cwd=root,
                limit_assets=1,
                hide_untextured_lashes=True,
                hidden_mesh_names=["eyeEdge_lod0_mesh", "body_lod0_mesh"],
            )[0]

            command = build_render_command(
                blender_path=Path("blender"),
                renderer_path=Path("tools/render_fbx_blender.py"),
                task=task,
                resolution=1024,
                crop="head",
                depth_sign="1",
            )

            self.assertTrue(task.hide_untextured_lashes)
            self.assertIn("--hide-untextured-lashes", command)
            hidden_args = [command[i + 1] for i, arg in enumerate(command) if arg == "--hide-mesh"]
            self.assertEqual(hidden_args, ["eyeEdge_lod0_mesh", "body_lod0_mesh"])
            json_path = root / "render_manifest.json"
            write_render_manifests(json_path=json_path, csv_path=root / "manifest.csv", tasks=[task])
            saved = json.loads(json_path.read_text(encoding="utf-8"))["tasks"][0]
            self.assertEqual(saved["hidden_mesh_names"], hidden_args)

    def test_should_separate_groups_with_different_hidden_meshes(self):
        tasks = build_render_tasks(make_manifest(), output_root="out", material_modes=["pbr"], limit_assets=1)
        tasks[0].hidden_mesh_names = ["eyeEdge_lod0_mesh"]
        self.assertEqual(sorted(len(group) for group in group_render_tasks(tasks)), [1, 4])

    def test_should_propagate_stable_framing_and_separate_group_settings(self):
        args = parse_args(["--stable-framing"])
        self.assertTrue(args.stable_framing)
        tasks = build_render_tasks(
            make_manifest(), output_root="out", material_modes=["pbr"],
            limit_assets=1, stable_framing=args.stable_framing,
        )
        command = build_render_command(
            blender_path="blender", renderer_path="renderer.py", task=tasks[0],
            resolution=1024, crop="head", depth_sign="1",
        )
        self.assertIn("--stable-framing", command)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_render_manifests(json_path=root / "manifest.json", csv_path=root / "manifest.csv", tasks=tasks)
            saved = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(all(task["stable_framing"] for task in saved["tasks"]))
        tasks[0].stable_framing = False
        self.assertEqual(sorted(len(group) for group in group_render_tasks(tasks)), [1, 4])

    def test_should_render_complete_stable_plan_when_resuming_partial_group(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tasks = build_render_tasks(
                make_manifest(), output_root=root / "out", material_modes=["pbr"],
                limit_assets=1, stable_framing=True,
            )
            existing = Path(tasks[0].output_path)
            existing.parent.mkdir(parents=True)
            existing.write_bytes(b"previous output")

            def run_blender(command, **kwargs):
                self.assertIn("--stable-framing", command)
                plan = json.loads(Path(command[command.index("--render-plan") + 1]).read_text(encoding="utf-8"))
                self.assertEqual(len(plan["renders"]), 5)
                self.assertEqual({item["task_id"] for item in plan["renders"]}, {task.task_id for task in tasks})
                for item in plan["renders"]:
                    path = Path(item["output"])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"new output")
                return subprocess.CompletedProcess(command, 0, "rendered", "")

            with patch("tools.render_fbx_batch.subprocess.run", side_effect=run_blender) as external:
                summary = run_tasks(
                    tasks=tasks, blender_path="blender", renderer_path="renderer.py",
                    resolution=1024, crop="head", depth_sign="1", axis_mode="y-up-z-depth",
                    render_manifest_json=root / "manifest.json", render_manifest_csv=root / "manifest.csv",
                )
                self.assertEqual(external.call_count, 1)
            self.assertEqual(summary["rendered"], 5)
            self.assertEqual(summary["skipped_existing"], 0)
            self.assertEqual(existing.read_bytes(), b"new output")

    def test_should_preserve_previous_manifest_on_interrupted_write(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            json_path, csv_path = root / "manifest.json", root / "manifest.csv"
            tasks = build_render_tasks(make_manifest(), output_root=root / "out", limit_assets=1)
            write_render_manifests(json_path=json_path, csv_path=csv_path, tasks=tasks)
            previous = json_path.read_bytes()

            def fail_during_write(payload, file, **kwargs):
                file.write('{"summary":')
                raise OSError("simulated interrupted write")

            with patch("tools.render_fbx_batch.json.dump", side_effect=fail_during_write):
                with self.assertRaisesRegex(OSError, "interrupted write"):
                    write_render_manifests(json_path=json_path, csv_path=csv_path, tasks=tasks)
            self.assertEqual(json_path.read_bytes(), previous)
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_should_reject_colliding_group_paths_before_launch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tasks = build_render_tasks(make_manifest(), output_root=root / "out", material_modes=["pbr"], limit_assets=1)
            tasks[0].stable_framing = True
            with patch("tools.render_fbx_batch.subprocess.run") as external:
                with self.assertRaisesRegex(ValueError, "separate output roots"):
                    run_tasks(
                        tasks=tasks, blender_path="blender", renderer_path="renderer.py",
                        resolution=1024, crop="head", depth_sign="1", axis_mode="y-up-z-depth",
                        render_manifest_json=root / "manifest.json", render_manifest_csv=root / "manifest.csv",
                    )
                external.assert_not_called()
            self.assertFalse((root / "out").exists())

    def test_should_write_render_manifest_summary_and_csv(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tasks = build_render_tasks(
                make_manifest(),
                output_root=root / "out",
                material_modes=["basecolor", "pbr"],
                poses=[Pose(pose_index=0, pose_name="front", yaw=0.0, pitch=0.0, roll=0.0)],
                cwd=root,
                limit_assets=1,
                eye_texture_path="assets/eye.jpg",
            )
            tasks[0].status = "rendered"
            tasks[1].status = "planned"

            json_path = root / "render_manifest.json"
            csv_path = root / "render_manifest.csv"
            write_render_manifests(json_path=json_path, csv_path=csv_path, tasks=tasks)

            payload = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["summary"]["total_tasks"], 2)
            self.assertEqual(payload["summary"]["rendered"], 1)
            self.assertEqual(payload["summary"]["planned"], 1)
            self.assertEqual(payload["summary"]["source_assets"], 1)
            self.assertEqual(payload["tasks"][0]["eye_texture_path"], str(root / "assets" / "eye.jpg"))
            self.assertFalse(payload["tasks"][0]["hide_untextured_lashes"])
            self.assertIn("task_id,source_status,fbx_name", csv_path.read_text(encoding="utf-8"))

    def test_should_group_pose_tasks_and_write_one_blender_render_plan(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tasks = build_render_tasks(
                make_manifest(),
                output_root=root / "out",
                material_modes=["pbr"],
                poses=[
                    Pose(pose_index=0, pose_name="sample_00", yaw=-5.0, pitch=1.0, roll=0.0),
                    Pose(pose_index=1, pose_name="sample_01", yaw=7.0, pitch=-2.0, roll=1.0),
                ],
                cwd=root,
                limit_assets=1,
            )

            groups = group_render_tasks(tasks)
            self.assertEqual(len(groups), 1)
            plan_path = root / "plan.json"
            write_render_plan(path=plan_path, tasks=groups[0])
            payload = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(len(payload["renders"]), 2)

            command = build_render_command(
                blender_path=Path("blender"),
                renderer_path=Path("tools/render_fbx_blender.py"),
                task=tasks[0],
                resolution=1024,
                crop="head",
                depth_sign="1",
                render_plan_path=plan_path,
            )
            self.assertIn("--render-plan", command)
            self.assertIn(str(plan_path), command)
            self.assertNotIn("--output", command)


if __name__ == "__main__":
    unittest.main()
