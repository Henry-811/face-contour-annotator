import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.build_fbx_texture_manifest import build_manifest


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")


class BuildFbxTextureManifestTest(unittest.TestCase):
    def test_should_resolve_numeric_and_named_fbx_when_metadata_points_to_basecolor(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            touch(root / "fbx" / "0_00000.fbx")
            touch(root / "fbx" / "S_F_MChar_Test_00000.fbx")
            touch(root / "motherasset" / "ori" / "0" / "Basecolor.png")
            touch(root / "motherasset" / "ori" / "223" / "Basecolor.png")
            write_json(
                root / "assets" / "char_info_mesh.json",
                {
                    "0": {"char_id": 0, "tex_id": 0, "oriname": "numeric_zero"},
                    "244": {"char_id": 244, "tex_id": 223, "oriname": "S_F_MChar_Test"},
                },
            )
            write_json(root / "assets" / "char_info.json", {"0": {}, "223": {}})

            manifest = build_manifest(root)

            self.assertEqual(manifest["summary"]["resolved"], 2)
            self.assertEqual(manifest["summary"]["inferred_by_char_id"], 0)
            rows_by_name = {row["fbx_name"]: row for row in manifest["rows"]}
            self.assertEqual(rows_by_name["0_00000.fbx"]["basecolor_path"], str(root / "motherasset" / "ori" / "0" / "Basecolor.png"))
            self.assertEqual(rows_by_name["S_F_MChar_Test_00000.fbx"]["basecolor_path"], str(root / "motherasset" / "ori" / "223" / "Basecolor.png"))

    def test_should_mark_named_fbx_ambiguous_when_oriname_has_multiple_metadata_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            touch(root / "fbx" / "S_M_MChar_Dupe_00000.fbx")
            touch(root / "motherasset" / "ori" / "243" / "Basecolor.png")
            write_json(
                root / "assets" / "char_info_mesh.json",
                {
                    "227": {"char_id": 227, "tex_id": None, "oriname": "S_M_MChar_Dupe"},
                    "394": {"char_id": 394, "tex_id": 243, "oriname": "S_M_MChar_Dupe"},
                },
            )
            write_json(root / "assets" / "char_info.json", {"243": {}})

            manifest = build_manifest(root)

            self.assertEqual(manifest["summary"]["ambiguous"], 1)
            row = manifest["rows"][0]
            self.assertEqual(row["status"], "ambiguous")
            self.assertEqual(row["reason"], "multiple_oriname_matches")
            self.assertEqual(json.loads(row["candidate_mesh_keys"]), ["227", "394"])
            self.assertEqual(json.loads(row["candidate_tex_ids"]), [None, 243])

    def test_should_infer_named_fbx_texture_from_char_id_when_tex_id_is_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            touch(root / "fbx" / "S_F_NChar_NoTexture_00000.fbx")
            touch(root / "motherasset" / "ori" / "300" / "Basecolor.png")
            write_json(
                root / "assets" / "char_info_mesh.json",
                {
                    "300": {"char_id": 300, "tex_id": None, "oriname": "S_F_NChar_NoTexture"},
                },
            )
            write_json(root / "assets" / "char_info.json", {"300": {}})

            manifest = build_manifest(root)

            row = manifest["rows"][0]
            self.assertEqual(row["status"], "inferred_by_char_id")
            self.assertEqual(row["reason"], "missing_tex_id_inferred_from_char_id")
            self.assertEqual(row["tex_id"], "")
            self.assertEqual(row["inferred_tex_id"], "300")
            self.assertEqual(row["basecolor_path"], str(root / "motherasset" / "ori" / "300" / "Basecolor.png"))
            self.assertEqual(manifest["summary"]["renderable"], 1)

    def test_should_not_infer_when_char_id_texture_is_missing_or_collides_with_explicit_tex_id(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            touch(root / "fbx" / "S_F_NChar_Missing_00000.fbx")
            touch(root / "fbx" / "S_F_NChar_Collides_00000.fbx")
            touch(root / "fbx" / "1_00000.fbx")
            touch(root / "motherasset" / "ori" / "400" / "Basecolor.png")
            write_json(
                root / "assets" / "char_info_mesh.json",
                {
                    "1": {"char_id": 1, "tex_id": 1, "oriname": "numeric_one"},
                    "300": {"char_id": 300, "tex_id": None, "oriname": "S_F_NChar_Missing"},
                    "400": {"char_id": 400, "tex_id": None, "oriname": "S_F_NChar_Collides"},
                    "401": {"char_id": 401, "tex_id": 400, "oriname": "uses_400_texture"},
                },
            )
            write_json(root / "assets" / "char_info.json", {"1": {}, "400": {}})

            manifest = build_manifest(root)

            rows_by_name = {row["fbx_name"]: row for row in manifest["rows"]}
            self.assertEqual(rows_by_name["S_F_NChar_Missing_00000.fbx"]["status"], "unresolved")
            self.assertEqual(
                rows_by_name["S_F_NChar_Missing_00000.fbx"]["reason"],
                "missing_tex_id_and_char_id_texture_missing",
            )
            self.assertEqual(rows_by_name["S_F_NChar_Collides_00000.fbx"]["status"], "unresolved")
            self.assertEqual(
                rows_by_name["S_F_NChar_Collides_00000.fbx"]["reason"],
                "missing_tex_id_char_id_collides_with_explicit_tex_id",
            )
            self.assertEqual(rows_by_name["1_00000.fbx"]["status"], "missing_texture")
            self.assertEqual(rows_by_name["1_00000.fbx"]["reason"], "basecolor_missing")


if __name__ == "__main__":
    unittest.main()
