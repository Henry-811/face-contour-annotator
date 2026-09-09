import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.eyebrow_augmentation import (
    EYEBROW_STATUS_ORIGINAL,
    EYEBROW_STATUS_SYNTHESIZED,
    build_eyebrow_plan,
    discover_eyebrow_assets,
    load_brow_presence,
    write_eyebrow_mask,
)


class EyebrowAugmentationTest(unittest.TestCase):
    def test_should_keep_original_texture_when_brow_metadata_is_true(self):
        plan = build_eyebrow_plan(
            row={"fbx_name": "0_00000.fbx", "tex_id": 0, "inferred_tex_id": ""},
            brow_presence={"Basecolor00000": True},
            eyebrow_assets=[],
            mask_root="unused",
            base_seed=42,
        )

        self.assertEqual(plan.status, EYEBROW_STATUS_ORIGINAL)
        self.assertEqual(plan.mask_path, "")

    def test_should_create_deterministic_paired_mask_when_brows_are_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            assets_dir = root / "eyebrows"
            assets_dir.mkdir()
            asset = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
            draw = ImageDraw.Draw(asset)
            draw.ellipse((12, 48, 116, 82), fill=(255, 255, 255, 220))
            asset.save(assets_dir / "brow.png")
            presence_path = root / "brows.json"
            presence_path.write_text(json.dumps({"Basecolor00007": False}), encoding="utf-8")

            presence = load_brow_presence(presence_path)
            assets = discover_eyebrow_assets(assets_dir)
            first = build_eyebrow_plan(
                row={"fbx_name": "7_00000.fbx", "tex_id": 7, "inferred_tex_id": ""},
                brow_presence=presence,
                eyebrow_assets=assets,
                mask_root=root / "masks",
                base_seed=42,
            )
            repeated = build_eyebrow_plan(
                row={"fbx_name": "7_00000.fbx", "tex_id": 7, "inferred_tex_id": ""},
                brow_presence=presence,
                eyebrow_assets=assets,
                mask_root=root / "masks",
                base_seed=42,
            )

            self.assertEqual(first, repeated)
            self.assertEqual(first.status, EYEBROW_STATUS_SYNTHESIZED)
            self.assertTrue(write_eyebrow_mask(first, output_size=256))
            with Image.open(first.mask_path) as mask:
                self.assertEqual(mask.mode, "L")
                self.assertEqual(mask.size, (256, 256))
                left = mask.crop((0, 0, 128, 256))
                right = mask.crop((128, 0, 256, 256)).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                self.assertEqual(left.tobytes(), right.tobytes())
                self.assertGreater(mask.getbbox()[2] - mask.getbbox()[0], 0)


if __name__ == "__main__":
    unittest.main()
