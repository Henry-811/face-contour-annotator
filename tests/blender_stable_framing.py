"""Run with blender --background --factory-startup --python this_file."""

import sys
import unittest
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import render_fbx_blender as renderer


class StableFramingTests(unittest.TestCase):
    def setUp(self):
        renderer.clear_scene()
        bpy.ops.mesh.primitive_cube_add(location=(0, 150, 0))
        self.mesh = bpy.context.object
        self.mesh.name = "head_lod0_mesh"
        self.mesh.scale = (12, 20, 35)
        self.root = renderer.set_origins_and_rotation(
            imported=[self.mesh], yaw=0, pitch=0, roll=0,
        )
        bpy.context.view_layer.update()
        self.axis = renderer.camera_axis_metadata([self.mesh], "y-up-z-depth")
        self.poses = [
            {"yaw": -20, "pitch": -12, "roll": 4},
            {"yaw": 20, "pitch": 12, "roll": -4},
            {"yaw": 0, "pitch": 0, "roll": 0},
        ]

    def test_fixed_rig_contains_every_pose_even_when_depth_is_largest(self):
        pivot, center, scale, axis, lighting_scale = renderer.prepare_stable_framing(
            meshes=[self.mesh], render_items=self.poses, camera_axis=self.axis,
        )
        self.assertEqual(axis["vertical_axis"], 1)
        self.assertEqual(axis["depth_axis"], 2)
        renderer.configure_camera(center=center, scale=scale, axis=axis, depth_sign=1)
        renderer.add_lights(center=pivot, axis=axis, depth_sign=1, frame_scale=lighting_scale)
        bpy.context.scene.render.resolution_x = 1024
        bpy.context.scene.render.resolution_y = 1024
        bpy.context.scene.render.pixel_aspect_x = 1
        bpy.context.scene.render.pixel_aspect_y = 1
        bpy.context.view_layer.update()
        expected_rig = renderer.render_rig_metadata()
        for pose in self.poses:
            renderer.apply_stable_pose(root=self.root, pivot=pivot, pose=pose)
            self.assertLess((self.root.matrix_world @ pivot - pivot).length, 0.0001)
            self.assertEqual(renderer.render_rig_metadata(), expected_rig)
            for point in renderer.object_vertex_points([self.mesh]):
                projected = world_to_camera_view(bpy.context.scene, bpy.context.scene.camera, point)
                self.assertGreaterEqual(projected.x, 0.04)
                self.assertLessEqual(projected.x, 0.96)
                self.assertGreaterEqual(projected.y, 0.04)
                self.assertLessEqual(projected.y, 0.96)
                self.assertGreater(projected.z, 0)

    def test_hidden_outlier_and_pose_order_do_not_change_framing(self):
        expected = renderer.prepare_stable_framing(
            meshes=[self.mesh], render_items=self.poses, camera_axis=self.axis,
        )
        bpy.ops.mesh.primitive_cube_add(location=(5000, -5000, 10000))
        hidden = bpy.context.object
        hidden.hide_render = True
        bpy.context.view_layer.update()
        actual = renderer.prepare_stable_framing(
            meshes=[self.mesh, hidden], render_items=list(reversed(self.poses)), camera_axis=self.axis,
        )
        self.assertEqual(actual, expected)
        auto_axis = renderer.camera_axis_metadata(meshes=[self.mesh, hidden], axis_mode="auto", visible_only=True)
        expected_axis = renderer.camera_axis_metadata(meshes=[self.mesh], axis_mode="auto")
        self.assertEqual(auto_axis, expected_axis)

    def test_empty_input_fails_explicitly(self):
        for meshes, poses in (([], self.poses), ([self.mesh], [])):
            with self.assertRaises(ValueError):
                renderer.prepare_stable_framing(meshes=meshes, render_items=poses, camera_axis=self.axis)


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(StableFramingTests))
    if not result.wasSuccessful():
        sys.exit(1)
