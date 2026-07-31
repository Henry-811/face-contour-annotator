import argparse
import csv
import json
import re
from pathlib import Path


NUMERIC_FBX_RE = re.compile(r"^(\d+)_\d+\.fbx$", re.IGNORECASE)
TRAILING_VARIANT_RE = re.compile(r"_\d+\.fbx$", re.IGNORECASE)
BASECOLOR_RELATIVE_TEMPLATE = "motherasset/ori/{tex_id}/Basecolor.png"
STATUS_RESOLVED = "resolved"
STATUS_INFERRED_BY_CHAR_ID = "inferred_by_char_id"
STATUS_UNRESOLVED = "unresolved"
STATUS_AMBIGUOUS = "ambiguous"
STATUS_MISSING_TEXTURE = "missing_texture"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build an FBX-to-Basecolor manifest from run asset metadata."
    )
    parser.add_argument(
        "--root",
        default="run/run",
        help="Path to the extracted run/run asset root.",
    )
    parser.add_argument(
        "--output-json",
        default="run/processed/fbx_texture_manifest.json",
        help="Manifest JSON output path.",
    )
    parser.add_argument(
        "--output-csv",
        default="run/processed/fbx_texture_manifest.csv",
        help="Manifest CSV output path.",
    )
    return parser.parse_args()


def load_json(path):
    if not path.exists():
        raise FileNotFoundError(f"Required metadata file is missing: {path}")
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def build_oriname_index(mesh_info):
    index = {}
    for key, item in mesh_info.items():
        oriname = item.get("oriname")
        if oriname:
            index.setdefault(oriname, []).append((key, item))
    return index


def extract_named_oriname(fbx_name):
    return TRAILING_VARIANT_RE.sub("", fbx_name)


def basecolor_path_for(root, tex_id):
    return root / BASECOLOR_RELATIVE_TEMPLATE.format(tex_id=tex_id)


def make_empty_row(fbx_path):
    return {
        "fbx_path": str(fbx_path),
        "fbx_name": fbx_path.name,
        "match_type": "",
        "char_info_mesh_key": "",
        "char_id": "",
        "oriname": "",
        "tex_id": "",
        "inferred_tex_id": "",
        "basecolor_path": "",
        "status": "",
        "reason": "",
        "candidate_mesh_keys": "",
        "candidate_tex_ids": "",
    }


def collect_explicit_tex_ids(mesh_info):
    tex_ids = set()
    for item in mesh_info.values():
        tex_id = item.get("tex_id")
        if tex_id is not None:
            tex_ids.add(str(tex_id))
    return tex_ids


def apply_char_id_texture_inference(root, row, item, explicit_tex_ids):
    char_id = item.get("char_id")
    if char_id is None or str(char_id) == "":
        row["status"] = STATUS_UNRESOLVED
        row["reason"] = "missing_tex_id_and_char_id"
        return row

    inferred_tex_id = str(char_id)
    if inferred_tex_id in explicit_tex_ids:
        row["status"] = STATUS_UNRESOLVED
        row["reason"] = "missing_tex_id_char_id_collides_with_explicit_tex_id"
        row["inferred_tex_id"] = inferred_tex_id
        return row

    basecolor_path = basecolor_path_for(root, inferred_tex_id)
    row["inferred_tex_id"] = inferred_tex_id
    row["basecolor_path"] = str(basecolor_path)
    if not basecolor_path.exists():
        row["status"] = STATUS_UNRESOLVED
        row["reason"] = "missing_tex_id_and_char_id_texture_missing"
        return row

    row["status"] = STATUS_INFERRED_BY_CHAR_ID
    row["reason"] = "missing_tex_id_inferred_from_char_id"
    return row


def apply_texture_resolution(root, row, item, explicit_tex_ids):
    tex_id = item.get("tex_id")
    if tex_id is None:
        return apply_char_id_texture_inference(root, row, item, explicit_tex_ids)

    basecolor_path = basecolor_path_for(root, tex_id)
    row["tex_id"] = tex_id
    row["basecolor_path"] = str(basecolor_path)
    if not basecolor_path.exists():
        row["status"] = STATUS_MISSING_TEXTURE
        row["reason"] = "basecolor_missing"
        return row

    row["status"] = STATUS_RESOLVED
    row["reason"] = ""
    return row


def row_from_numeric_fbx(root, fbx_path, mesh_info, numeric_id, explicit_tex_ids):
    row = make_empty_row(fbx_path)
    row["match_type"] = "numeric"
    item = mesh_info.get(numeric_id)
    if item is None:
        row["status"] = STATUS_UNRESOLVED
        row["reason"] = "mesh_metadata_missing"
        return row

    row["char_info_mesh_key"] = numeric_id
    row["char_id"] = item.get("char_id", "")
    row["oriname"] = item.get("oriname", "")
    if str(item.get("char_id")) != numeric_id:
        row["status"] = STATUS_UNRESOLVED
        row["reason"] = "char_id_mismatch"
        return row

    return apply_texture_resolution(root, row, item, explicit_tex_ids)


def row_from_named_fbx(root, fbx_path, oriname_index, explicit_tex_ids):
    row = make_empty_row(fbx_path)
    row["match_type"] = "oriname"
    oriname = extract_named_oriname(fbx_path.name)
    row["oriname"] = oriname
    candidates = oriname_index.get(oriname, [])
    if not candidates:
        row["status"] = STATUS_UNRESOLVED
        row["reason"] = "oriname_not_found"
        return row

    if len(candidates) > 1:
        row["status"] = STATUS_AMBIGUOUS
        row["reason"] = "multiple_oriname_matches"
        row["candidate_mesh_keys"] = json.dumps([key for key, _ in candidates], ensure_ascii=False)
        row["candidate_tex_ids"] = json.dumps(
            [item.get("tex_id") for _, item in candidates], ensure_ascii=False
        )
        return row

    key, item = candidates[0]
    row["char_info_mesh_key"] = key
    row["char_id"] = item.get("char_id", "")
    row["oriname"] = item.get("oriname", "")
    return apply_texture_resolution(root, row, item, explicit_tex_ids)


def build_manifest(root):
    fbx_dir = root / "fbx"
    if not fbx_dir.exists():
        raise FileNotFoundError(f"FBX directory is missing: {fbx_dir}")

    mesh_info = load_json(root / "assets" / "char_info_mesh.json")
    tex_info = load_json(root / "assets" / "char_info.json")
    oriname_index = build_oriname_index(mesh_info)
    explicit_tex_ids = collect_explicit_tex_ids(mesh_info)

    rows = []
    for fbx_path in sorted(fbx_dir.glob("*.fbx")):
        numeric_match = NUMERIC_FBX_RE.match(fbx_path.name)
        if numeric_match:
            row = row_from_numeric_fbx(
                root, fbx_path, mesh_info, numeric_match.group(1), explicit_tex_ids
            )
        else:
            row = row_from_named_fbx(root, fbx_path, oriname_index, explicit_tex_ids)
        rows.append(row)

    summary = {
        "fbx_total": len(rows),
        "numeric_fbx": sum(1 for row in rows if row["match_type"] == "numeric"),
        "named_fbx": sum(1 for row in rows if row["match_type"] == "oriname"),
        "char_info_mesh_entries": len(mesh_info),
        "char_info_entries": len(tex_info),
        "resolved": sum(1 for row in rows if row["status"] == STATUS_RESOLVED),
        "inferred_by_char_id": sum(
            1 for row in rows if row["status"] == STATUS_INFERRED_BY_CHAR_ID
        ),
        "renderable": sum(
            1
            for row in rows
            if row["status"] in (STATUS_RESOLVED, STATUS_INFERRED_BY_CHAR_ID)
        ),
        "unresolved": sum(1 for row in rows if row["status"] == STATUS_UNRESOLVED),
        "ambiguous": sum(1 for row in rows if row["status"] == STATUS_AMBIGUOUS),
        "missing_texture": sum(1 for row in rows if row["status"] == STATUS_MISSING_TEXTURE),
    }
    return {"summary": summary, "rows": rows}


def write_json(path, manifest):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(manifest, file, ensure_ascii=False, indent=2)
        file.write("\n")


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(make_empty_row(Path("")).keys())
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    args = parse_args()
    root = Path(args.root)
    manifest = build_manifest(root)
    write_json(Path(args.output_json), manifest)
    write_csv(Path(args.output_csv), manifest["rows"])
    print(json.dumps(manifest["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
