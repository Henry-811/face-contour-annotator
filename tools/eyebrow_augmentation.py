import colorsys
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageOps


EYEBROW_STATUS_ORIGINAL = "original"
EYEBROW_STATUS_SYNTHESIZED = "synthesized"
DEFAULT_MASK_SIZE = 1024


@dataclass(frozen=True)
class EyebrowPlan:
    source_key: str
    status: str
    mask_path: str
    asset_path: str
    seed: int
    color: tuple[float, float, float]
    scale_x: float
    scale_y: float
    rotation: float
    offset_x: float
    offset_y: float
    intensity: float

    @property
    def color_arg(self):
        return ",".join(f"{channel:.6f}" for channel in self.color)


def load_brow_presence(path):
    presence_path = Path(path)
    if not presence_path.exists():
        raise FileNotFoundError(f"Brow presence metadata is missing: {presence_path}")
    with presence_path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise ValueError(f"Brow presence metadata must be a JSON object: {presence_path}")
    invalid = [key for key, value in payload.items() if not isinstance(value, bool)]
    if invalid:
        raise ValueError(
            f"Brow presence metadata contains non-boolean values: {', '.join(invalid[:5])}"
        )
    return payload


def discover_eyebrow_assets(directory):
    asset_dir = Path(directory)
    if not asset_dir.is_dir():
        raise FileNotFoundError(f"Eyebrow asset directory is missing: {asset_dir}")
    assets = sorted(
        path.resolve()
        for path in asset_dir.iterdir()
        if path.is_file() and path.suffix.lower() == ".png"
    )
    if not assets:
        raise ValueError(f"Eyebrow asset directory contains no PNG files: {asset_dir}")
    return assets


def texture_id_for_row(row):
    for field_name in ("tex_id", "inferred_tex_id"):
        value = row.get(field_name)
        if value not in (None, ""):
            try:
                return int(value)
            except (TypeError, ValueError) as error:
                raise ValueError(
                    f"Invalid {field_name} for {row.get('fbx_name', '<unknown>')}: {value}"
                ) from error
    raise ValueError(f"Renderable row has no texture id: {row.get('fbx_name', '<unknown>')}")


def basecolor_key(texture_id):
    return f"Basecolor{texture_id:05d}"


def sample_brow_color(rng):
    if rng.random() < 0.9:
        hue = float(rng.uniform(0.0, 1.0))
        saturation = float(rng.uniform(0.0, 0.08))
        value = float(rng.uniform(0.0, 64.0 / 255.0))
    else:
        presets = (
            (15.0, 0.6, 0.20),
            (25.0, 0.7, 0.25),
            (10.0, 0.5, 0.15),
            (220.0, 0.4, 0.10),
            (30.0, 0.8, 0.30),
        )
        base_hue, base_saturation, base_value = presets[int(rng.integers(0, len(presets)))]
        hue = float(rng.uniform(base_hue - 10.0, base_hue + 10.0)) % 360.0 / 360.0
        saturation = float(np.clip(rng.uniform(base_saturation - 0.1, base_saturation + 0.1), 0, 1))
        value = float(np.clip(rng.uniform(base_value - 0.05, base_value + 0.05), 0, 1))
    return tuple(float(channel) for channel in colorsys.hsv_to_rgb(hue, saturation, value))


def build_eyebrow_plan(
    *,
    row,
    brow_presence,
    eyebrow_assets,
    mask_root,
    base_seed,
):
    texture_id = texture_id_for_row(row)
    source_key = basecolor_key(texture_id)
    if source_key not in brow_presence:
        raise KeyError(
            f"Brow presence metadata has no entry for texture {texture_id}: {source_key}"
        )

    seed = int(base_seed) + texture_id
    if brow_presence[source_key]:
        return EyebrowPlan(
            source_key=source_key,
            status=EYEBROW_STATUS_ORIGINAL,
            mask_path="",
            asset_path="",
            seed=seed,
            color=(0.0, 0.0, 0.0),
            scale_x=0.0,
            scale_y=0.0,
            rotation=0.0,
            offset_x=0.0,
            offset_y=0.0,
            intensity=0.0,
        )

    if not eyebrow_assets:
        raise ValueError("No eyebrow assets are available for a texture without eyebrows.")

    rng = np.random.default_rng(seed)
    asset_path = Path(eyebrow_assets[int(rng.integers(0, len(eyebrow_assets)))])
    return EyebrowPlan(
        source_key=source_key,
        status=EYEBROW_STATUS_SYNTHESIZED,
        mask_path=str((Path(mask_root) / f"{texture_id:05d}.png").resolve()),
        asset_path=str(asset_path.resolve()),
        seed=seed,
        color=sample_brow_color(rng),
        scale_x=float(rng.uniform(0.18, 0.28)),
        scale_y=float(rng.uniform(0.225, 0.275)),
        rotation=float(rng.uniform(-5.0, 10.0)),
        offset_x=float(rng.uniform(-0.025, 0.025)),
        offset_y=float(rng.uniform(-0.005, 0.003)),
        intensity=float(rng.uniform(0.8, 1.1)),
    )


def _load_alpha(path):
    with Image.open(path) as image:
        if "A" in image.getbands():
            return image.getchannel("A").copy()
        return image.convert("L")


def _apply_intensity(mask, intensity):
    lookup = [min(255, round(value * intensity)) for value in range(256)]
    return mask.point(lookup)


def write_eyebrow_mask(plan, *, overwrite=False, output_size=DEFAULT_MASK_SIZE):
    if plan.status != EYEBROW_STATUS_SYNTHESIZED:
        return False
    if output_size <= 0:
        raise ValueError("Eyebrow mask size must be positive.")

    output_path = Path(plan.mask_path)
    if output_path.exists() and not overwrite:
        with Image.open(output_path) as existing:
            if existing.size == (output_size, output_size) and existing.mode == "L":
                return False

    alpha = _load_alpha(plan.asset_path)
    target_size = (
        max(1, round(output_size * plan.scale_x)),
        max(1, round(output_size * plan.scale_y)),
    )
    transformed = alpha.resize(target_size, Image.Resampling.LANCZOS)
    transformed = transformed.rotate(
        plan.rotation,
        resample=Image.Resampling.BICUBIC,
        expand=True,
        fillcolor=0,
    )

    left_mask = Image.new("L", (output_size, output_size), 0)
    center_x = round((0.375 + plan.offset_x) * (output_size - 1))
    center_y = round((0.300 + plan.offset_y) * (output_size - 1))
    origin = (
        round(center_x - transformed.width / 2),
        round(center_y - transformed.height / 2),
    )
    left_mask.paste(transformed, origin)
    paired_mask = ImageChops.lighter(left_mask, ImageOps.mirror(left_mask))
    paired_mask = _apply_intensity(paired_mask, plan.intensity)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    paired_mask.save(output_path, format="PNG", compress_level=3)
    return True
