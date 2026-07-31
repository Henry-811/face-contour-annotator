import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.render_fbx_batch import (
    Pose,
    build_render_command,
    build_render_tasks,
    parse_material_modes,
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
                "status": "resolved",
            },
            {
                "fbx_name": "S_F_NChar_Test_00000.fbx",
                "fbx_path": "run/run/fbx/S_F_NChar_Test_00000.fbx",
                "basecolor_path": "run/run/motherasset/ori/300/Basecolor.png",
                "status": "inferred_by_char_id",
            },
            {
                "fbx_name": "S_M_MChar_Dupe_00000.fbx",
                "fbx_path": "run/run/fbx/S_M_MChar_Dupe_00000.fbx",
                "basecolor_path": "",
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
            self.assertTrue(str(root / "out" / "0_00000" / "pose_00_front" / "basecolor.png") in {task.output_path for task in tasks})

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
            self.assertIn("--eye-texture", pbr_command)
            self.assertIn(str(root / "assets" / "eye.jpg"), pbr_command)

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
            self.assertIn("task_id,source_status,fbx_name", csv_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
