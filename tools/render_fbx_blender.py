import argparse
import bmesh
import json
import math
import sys
import traceback
from pathlib import Path

import bpy
from mathutils import Euler, Vector


HEAD_MESH_KEYWORDS = ("head", "eye", "teeth", "saliva", "lash")
SKIN_MESH_KEYWORDS = ("head", "body")
AUTO_MAP_FILENAMES = {
    "normal": "Normal.png",
    "roughness": "Roughness.png",
    "specular": "Specular.png",
    "cavity": "Cavity.png",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Render an FBX with optional Basecolor texture.")
    parser.add_argument("--fbx", required=True, help="Path to the FBX file.")
    parser.add_argument("--texture", default="", help="Optional Basecolor texture path.")
    parser.add_argument("--eye-texture", default="", help="Optional eye texture applied to eye meshes.")
    parser.add_argument(
        "--hide-untextured-lashes",
        action="store_true",
        help="Hide eyelash card meshes when no matching transparent lash texture is available.",
    )
    parser.add_argument(
        "--hide-mesh",
        action="append",
        default=[],
        help="Exact mesh name to hide without changing camera framing; repeat as needed.",
    )
    parser.add_argument(
        "--eyebrow-mask",
        default="",
        help="Optional UV-space eyebrow mask blended over the skin Basecolor.",
    )
    parser.add_argument(
        "--eyebrow-color",
        default="0.08,0.05,0.03",
        help="Linear RGB eyebrow color as three comma-separated values in [0, 1].",
    )
    parser.add_argument("--output", default="", help="Output PNG path for a single render.")
    parser.add_argument(
        "--render-plan",
        default="",
        help="Optional JSON plan containing multiple output paths and poses for one imported FBX.",
    )
    parser.add_argument("--resolution", type=int, default=1024, help="Square output resolution.")
    parser.add_argument(
        "--stable-framing",
        action="store_true",
        help="Share framing and lights across the entire render plan using visible geometry.",
    )
    parser.add_argument(
        "--material-mode",
        choices=("basecolor", "pbr"),
        default="basecolor",
        help="Use unlit Basecolor output or PBR shading with available maps.",
    )
    parser.add_argument(
        "--auto-maps",
        action="store_true",
        help="Infer Normal/Roughness/Specular/Cavity maps from the Basecolor directory.",
    )
    parser.add_argument("--normal", default="", help="Optional Normal map path for PBR mode.")
    parser.add_argument("--roughness", default="", help="Optional Roughness map path for PBR mode.")
    parser.add_argument("--specular", default="", help="Optional Specular map path for PBR mode.")
    parser.add_argument("--cavity", default="", help="Optional Cavity map path for PBR mode.")
    parser.add_argument(
        "--component-materials",
        choices=("skin-only", "hide-unsupported", "single"),
        default="skin-only",
        help=(
            "Apply skin texture only to head/body meshes, hide meshes without matching "
            "textures, or apply one skin material to every mesh."
        ),
    )
    parser.add_argument(
        "--crop",
        choices=("full", "head"),
        default="head",
        help="Frame the full body or a heuristic head/face crop.",
    )
    parser.add_argument(
        "--depth-sign",
        choices=("-1", "1"),
        default="1",
        help="Camera side along the detected depth axis.",
    )
    parser.add_argument(
        "--axis-mode",
        choices=("y-up-z-depth", "auto"),
        default="y-up-z-depth",
        help="Use this asset set's Y-up/Z-depth axes or infer axes from mesh spans.",
    )
    parser.add_argument("--yaw", type=float, default=0.0, help="Model yaw in degrees.")
    parser.add_argument("--pitch", type=float, default=0.0, help="Model pitch in degrees.")
    parser.add_argument("--roll", type=float, default=0.0, help="Model roll in degrees.")
    parser.add_argument(
        "--head-only",
        action="store_true",
        help="Hide non-head meshes when rendering a head crop.",
    )
    parser.add_argument(
        "--clip-body",
        action="store_true",
        help="For head crops, remove body faces outside the central lower-face/neck region.",
    )
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]
    args = parser.parse_args(argv)
    if bool(args.output) == bool(args.render_plan):
        parser.error("provide exactly one of --output or --render-plan")
    return args


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def import_fbx(fbx_path):
    before = {obj.name for obj in bpy.context.scene.objects}
    bpy.ops.import_scene.fbx(filepath=str(fbx_path))
    imported = [obj for obj in bpy.context.scene.objects if obj.name not in before]
    meshes = [obj for obj in imported if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects were imported from {fbx_path}")
    return imported, meshes


def set_non_color(image):
    try:
        image.colorspace_settings.name = "Non-Color"
    except TypeError:
        print(f"Warning: could not set Non-Color colorspace for {image.filepath}")


def make_image_node(nodes, image_path, non_color=False):
    image_node = nodes.new(type="ShaderNodeTexImage")
    image_node.image = bpy.data.images.load(str(image_path))
    image_node.extension = "EXTEND"
    if non_color:
        set_non_color(image_node.image)
    return image_node


def connect_first_available(links, output_socket, node, input_names):
    for input_name in input_names:
        if input_name in node.inputs:
            links.new(output_socket, node.inputs[input_name])
            return input_name
    return None


def parse_rgb_color(value):
    try:
        channels = tuple(float(channel.strip()) for channel in value.split(","))
    except ValueError as error:
        raise ValueError(f"Invalid RGB color: {value}") from error
    if len(channels) != 3 or any(
        not math.isfinite(channel) or channel < 0 or channel > 1 for channel in channels
    ):
        raise ValueError(f"RGB color must contain three finite values in [0, 1]: {value}")
    return channels


def blend_eyebrows(*, nodes, links, basecolor_output, mask_path, color):
    if not mask_path:
        return basecolor_output

    mask_node = make_image_node(nodes, mask_path, non_color=True)
    mix_node = nodes.new(type="ShaderNodeMixRGB")
    mix_node.blend_type = "MIX"
    links.new(mask_node.outputs["Color"], mix_node.inputs[0])
    links.new(basecolor_output, mix_node.inputs[1])
    mix_node.inputs[2].default_value = (*color, 1.0)
    return mix_node.outputs["Color"]


def make_basecolor_material(
    texture_path,
    *,
    map_paths=None,
    material_mode="basecolor",
    material_name=None,
    eyebrow_mask_path=None,
    eyebrow_color=(0.08, 0.05, 0.03),
):
    map_paths = map_paths or {}
    material = bpy.data.materials.new(name=material_name or f"{material_mode}_Material")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    links = material.node_tree.links

    image_node = make_image_node(nodes, texture_path)
    basecolor_output = blend_eyebrows(
        nodes=nodes,
        links=links,
        basecolor_output=image_node.outputs["Color"],
        mask_path=eyebrow_mask_path,
        color=eyebrow_color,
    )

    if material_mode == "pbr":
        bsdf_node = nodes.new(type="ShaderNodeBsdfPrincipled")
        output_node = nodes.new(type="ShaderNodeOutputMaterial")

        cavity_path = map_paths.get("cavity")
        if cavity_path:
            try:
                cavity_node = make_image_node(nodes, cavity_path, non_color=True)
                mix_node = nodes.new(type="ShaderNodeMixRGB")
                mix_node.blend_type = "MULTIPLY"
                mix_node.inputs[0].default_value = 0.35
                links.new(basecolor_output, mix_node.inputs[1])
                links.new(cavity_node.outputs["Color"], mix_node.inputs[2])
                basecolor_output = mix_node.outputs["Color"]
            except Exception as error:
                print(f"Warning: cavity map skipped: {error}")

        connect_first_available(links, basecolor_output, bsdf_node, ("Base Color",))

        roughness_path = map_paths.get("roughness")
        if roughness_path:
            roughness_node = make_image_node(nodes, roughness_path, non_color=True)
            connect_first_available(links, roughness_node.outputs["Color"], bsdf_node, ("Roughness",))
        elif "Roughness" in bsdf_node.inputs:
            bsdf_node.inputs["Roughness"].default_value = 0.55

        specular_path = map_paths.get("specular")
        if specular_path:
            specular_node = make_image_node(nodes, specular_path, non_color=True)
            connect_first_available(
                links,
                specular_node.outputs["Color"],
                bsdf_node,
                ("Specular IOR Level", "Specular", "Specular Tint"),
            )

        normal_path = map_paths.get("normal")
        if normal_path:
            normal_texture_node = make_image_node(nodes, normal_path, non_color=True)
            normal_map_node = nodes.new(type="ShaderNodeNormalMap")
            normal_map_node.inputs["Strength"].default_value = 0.45
            links.new(normal_texture_node.outputs["Color"], normal_map_node.inputs["Color"])
            connect_first_available(links, normal_map_node.outputs["Normal"], bsdf_node, ("Normal",))

        links.new(bsdf_node.outputs["BSDF"], output_node.inputs["Surface"])
        return material

    emission_node = nodes.new(type="ShaderNodeEmission")
    emission_node.inputs["Strength"].default_value = 1.0

    output_node = nodes.new(type="ShaderNodeOutputMaterial")
    links.new(basecolor_output, emission_node.inputs["Color"])
    links.new(emission_node.outputs["Emission"], output_node.inputs["Surface"])
    return material


def mesh_role(mesh):
    name = mesh.name.lower()
    if "eyelash" in name or "lash" in name:
        return "lash"
    if "eyeedge" in name or "tear" in name:
        return "tearline"
    if "eyeleft" in name or "eyeright" in name:
        return "eye"
    if "teeth" in name or "gum" in name:
        return "teeth"
    if "saliva" in name:
        return "saliva"
    if any(keyword in name for keyword in SKIN_MESH_KEYWORDS):
        return "skin"
    return "skin"


def set_mesh_material(mesh, material):
    mesh.data.materials.clear()
    mesh.data.materials.append(material)
    for polygon in mesh.data.polygons:
        polygon.material_index = 0


def hide_unsupported_meshes(meshes):
    for mesh in meshes:
        hide = mesh_role(mesh) != "skin"
        mesh.hide_viewport = hide
        mesh.hide_render = hide


def hide_untextured_lashes(meshes):
    hidden = []
    for mesh in meshes:
        if mesh_role(mesh) != "lash":
            continue
        mesh.hide_viewport = True
        mesh.hide_render = True
        hidden.append(mesh.name)
    return hidden


def hide_named_meshes(*, meshes, names):
    by_name = {mesh.name: mesh for mesh in meshes}
    missing = sorted(set(names) - by_name.keys())
    if missing:
        raise ValueError(f"Requested hidden meshes not found: {missing}")
    for name in names:
        # Keep dependency-graph transforms current for the existing camera bounds.
        by_name[name].hide_render = True
    return sorted(set(names))


def resolve_texture_path(value):
    return Path(value).expanduser().resolve() if value else None


def auto_map_paths(texture_path):
    if not texture_path:
        return {}
    texture_dir = Path(texture_path).parent
    return {
        map_name: map_path.resolve()
        for map_name, filename in AUTO_MAP_FILENAMES.items()
        if (map_path := texture_dir / filename).exists()
    }


def validate_map_paths(map_paths):
    for map_name, map_path in map_paths.items():
        if map_path and not Path(map_path).exists():
            raise FileNotFoundError(f"{map_name} map not found: {map_path}")


def apply_material(
    meshes,
    texture_path,
    material_mode,
    map_paths,
    component_materials,
    *,
    eyebrow_mask_path=None,
    eyebrow_color=(0.08, 0.05, 0.03),
):
    if not texture_path:
        return
    texture = Path(texture_path)
    if not texture.exists():
        raise FileNotFoundError(f"Texture not found: {texture}")
    validate_map_paths(map_paths)
    skin_material = make_basecolor_material(
        texture,
        map_paths=map_paths,
        material_mode=material_mode,
        material_name=f"{material_mode}_Skin_Material",
        eyebrow_mask_path=eyebrow_mask_path,
        eyebrow_color=eyebrow_color,
    )
    if component_materials == "single":
        for mesh in meshes:
            set_mesh_material(mesh, skin_material)
        return

    if component_materials in ("skin-only", "hide-unsupported"):
        for mesh in meshes:
            if mesh_role(mesh) == "skin":
                set_mesh_material(mesh, skin_material)
        return


def apply_eye_material(*, meshes, eye_texture_path, material_mode):
    if not eye_texture_path:
        return

    texture = Path(eye_texture_path)
    if not texture.exists():
        raise FileNotFoundError(f"Eye texture not found: {texture}")

    eye_meshes = [mesh for mesh in meshes if mesh_role(mesh) == "eye"]
    if not eye_meshes:
        raise RuntimeError("Eye texture was provided, but no eye meshes were found.")

    eye_material = make_basecolor_material(
        texture,
        map_paths={},
        material_mode=material_mode,
        material_name=f"{material_mode}_Eye_Material",
    )
    for mesh in eye_meshes:
        set_mesh_material(mesh, eye_material)


def get_head_meshes(meshes):
    named_meshes = [
        obj
        for obj in meshes
        if any(keyword in obj.name.lower() for keyword in HEAD_MESH_KEYWORDS)
    ]
    return named_meshes or meshes


def hide_non_head_meshes(meshes):
    head_meshes = set(get_head_meshes(meshes))
    for obj in meshes:
        hide = obj not in head_meshes
        obj.hide_viewport = hide
        obj.hide_render = hide
    return list(head_meshes)


def clip_body_to_head_region(meshes):
    head_meshes = get_head_meshes(meshes)
    full_axis = get_axis_metadata(mesh_world_points(meshes))
    vertical_axis = full_axis["vertical_axis"]
    horizontal_axis = full_axis["horizontal_axis"]
    head_points = object_vertex_points(head_meshes)
    head_min_vertical = min(point[vertical_axis] for point in head_points)
    head_max_vertical = max(point[vertical_axis] for point in head_points)
    head_min_horizontal = min(point[horizontal_axis] for point in head_points)
    head_max_horizontal = max(point[horizontal_axis] for point in head_points)
    head_height = head_max_vertical - head_min_vertical
    head_width = head_max_horizontal - head_min_horizontal
    lower_cutoff = head_min_vertical + head_height * 0.05
    horizontal_center = (head_min_horizontal + head_max_horizontal) / 2
    central_half_width = head_width * 0.35

    for obj in meshes:
        if "body" not in obj.name.lower():
            continue
        mesh = obj.data
        bm = bmesh.new()
        bm.from_mesh(mesh)
        delete_faces = []
        for face in bm.faces:
            world_points = [obj.matrix_world @ vert.co for vert in face.verts]
            keep = all(
                point[vertical_axis] >= lower_cutoff
                and abs(point[horizontal_axis] - horizontal_center) <= central_half_width
                for point in world_points
            )
            if not keep:
                delete_faces.append(face)
        if delete_faces:
            bmesh.ops.delete(bm, geom=delete_faces, context="FACES")
            bm.to_mesh(mesh)
            mesh.update()
        bm.free()


def set_origins_and_rotation(imported, yaw, pitch, roll):
    root = bpy.data.objects.new("RenderRoot", None)
    bpy.context.collection.objects.link(root)
    for obj in imported:
        obj.parent = root
    root.rotation_euler = (
        math.radians(pitch),
        math.radians(yaw),
        math.radians(roll),
    )
    return root


def mesh_world_points(meshes):
    points = []
    for obj in meshes:
        matrix = obj.matrix_world
        points.extend(matrix @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise RuntimeError("Could not compute mesh bounds.")
    return points


def get_axis_metadata(points):
    mins = [min(point[index] for point in points) for index in range(3)]
    maxs = [max(point[index] for point in points) for index in range(3)]
    spans = [maxs[index] - mins[index] for index in range(3)]
    vertical_axis = max(range(3), key=lambda index: spans[index])
    depth_axis = min(
        (index for index in range(3) if index != vertical_axis),
        key=lambda index: spans[index],
    )
    horizontal_axis = next(
        index for index in range(3) if index not in (vertical_axis, depth_axis)
    )
    return {
        "mins": mins,
        "maxs": maxs,
        "spans": spans,
        "vertical_axis": vertical_axis,
        "horizontal_axis": horizontal_axis,
        "depth_axis": depth_axis,
    }


def camera_axis_metadata(meshes, axis_mode, *, visible_only=False):
    if visible_only:
        meshes = [mesh for mesh in meshes if not mesh.hide_render]
    axis = get_axis_metadata(mesh_world_points(meshes))
    if axis_mode == "y-up-z-depth":
        axis.update(vertical_axis=1, horizontal_axis=0, depth_axis=2)
    return axis


def object_vertex_points(meshes):
    points = []
    for obj in meshes:
        matrix = obj.matrix_world
        for vertex in obj.data.vertices:
            points.append(matrix @ vertex.co)
    return points


def frame_bounds(meshes, crop, camera_axis=None):
    bounds_meshes = get_head_meshes(meshes) if crop == "head" else meshes
    points = mesh_world_points(bounds_meshes)
    axis = get_axis_metadata(points)
    if camera_axis:
        for key in ("vertical_axis", "horizontal_axis", "depth_axis"):
            axis[key] = camera_axis[key]
    mins = axis["mins"]
    maxs = axis["maxs"]
    spans = axis["spans"]

    if crop == "full":
        center = Vector(((mins[0] + maxs[0]) / 2, (mins[1] + maxs[1]) / 2, (mins[2] + maxs[2]) / 2))
        scale = max(spans) * 1.12
        return center, scale, axis

    if bounds_meshes != meshes:
        full_axis = get_axis_metadata(mesh_world_points(meshes))
        if camera_axis:
            for key in ("vertical_axis", "horizontal_axis", "depth_axis"):
                full_axis[key] = camera_axis[key]
        head_mins = mins
        head_maxs = maxs
        head_spans = spans
        vertical_axis = axis["vertical_axis"]
        horizontal_axis = axis["horizontal_axis"]
        head_center_horizontal = (head_mins[horizontal_axis] + head_maxs[horizontal_axis]) / 2
        lower_cutoff = head_mins[vertical_axis] + head_spans[vertical_axis] * 0.05
        central_half_width = head_spans[horizontal_axis] * 0.5
        head_points = object_vertex_points(bounds_meshes)
        all_vertices = object_vertex_points(meshes)
        crop_points = head_points + [
            point
            for point in all_vertices
            if point[vertical_axis] >= lower_cutoff
            and abs(point[horizontal_axis] - head_center_horizontal) <= central_half_width
        ]
        crop_axis = get_axis_metadata(crop_points)
        crop_mins = crop_axis["mins"]
        crop_maxs = crop_axis["maxs"]
        crop_spans = crop_axis["spans"]
        center = Vector(
            (
                (crop_mins[0] + crop_maxs[0]) / 2,
                (crop_mins[1] + crop_maxs[1]) / 2,
                (crop_mins[2] + crop_maxs[2]) / 2,
            )
        )
        vertical_axis = crop_axis["vertical_axis"]
        horizontal_axis = crop_axis["horizontal_axis"]
        scale = max(crop_spans[vertical_axis], crop_spans[horizontal_axis]) * 1.05
        return center, scale, full_axis

    vertices = object_vertex_points(meshes)
    vertical_axis = axis["vertical_axis"]
    horizontal_axis = axis["horizontal_axis"]
    cutoff = mins[vertical_axis] + spans[vertical_axis] * 0.78
    horizontal_center = (mins[horizontal_axis] + maxs[horizontal_axis]) / 2
    central_half_width = spans[horizontal_axis] * 0.16
    # T-pose shoulders can sit high enough to pollute a pure top-percent crop.
    # Keep only top vertices near the body centerline to frame the head/neck.
    head_points = [
        point
        for point in vertices
        if point[vertical_axis] >= cutoff
        and abs(point[horizontal_axis] - horizontal_center) <= central_half_width
    ]
    if len(head_points) < 32:
        head_points = vertices

    crop_mins = [min(point[index] for point in head_points) for index in range(3)]
    crop_maxs = [max(point[index] for point in head_points) for index in range(3)]
    center = Vector(
        (
            (crop_mins[0] + crop_maxs[0]) / 2,
            (crop_mins[1] + crop_maxs[1]) / 2,
            (crop_mins[2] + crop_maxs[2]) / 2,
        )
    )
    crop_vertical = crop_maxs[vertical_axis] - crop_mins[vertical_axis]
    crop_horizontal = crop_maxs[horizontal_axis] - crop_mins[horizontal_axis]
    scale = max(crop_vertical, crop_horizontal) * 1.25
    return center, scale, axis


def axis_name(axis_index):
    return ("X", "Y", "Z")[axis_index]


def prepare_stable_framing(*, meshes, render_items, camera_axis):
    visible_meshes = [mesh for mesh in meshes if not mesh.hide_render]
    if not visible_meshes or not render_items:
        raise ValueError("Stable framing requires visible meshes and at least one pose.")
    points = object_vertex_points(visible_meshes)
    neutral_axis = get_axis_metadata(points)
    pivot = Vector([
        (low + high) / 2
        for low, high in zip(neutral_axis["mins"], neutral_axis["maxs"])
    ])
    horizontal = camera_axis["horizontal_axis"]
    vertical = camera_axis["vertical_axis"]
    # Lighting uses the neutral asset scale, never the pose-dependent crop scale.
    lighting_scale = max(neutral_axis["spans"][horizontal], neutral_axis["spans"][vertical]) * 1.05
    low = [math.inf] * 3
    high = [-math.inf] * 3
    for item in render_items:
        rotation = Euler(tuple(math.radians(item[key]) for key in ("pitch", "yaw", "roll")), "XYZ")
        matrix = rotation.to_matrix()
        for point in points:
            transformed = pivot + matrix @ (point - pivot)
            for index in range(3):
                low[index] = min(low[index], transformed[index])
                high[index] = max(high[index], transformed[index])
    spans = [high[index] - low[index] for index in range(3)]
    axis = dict(camera_axis, mins=low, maxs=high, spans=spans)
    center = Vector([(low[index] + high[index]) / 2 for index in range(3)])
    # Five percent margin on each side of the largest projected extent.
    scale = max(spans[horizontal], spans[vertical]) * 1.10
    if scale <= 0:
        raise ValueError("Stable framing requires non-degenerate projected geometry.")
    return pivot, center, scale, axis, lighting_scale


def apply_stable_pose(*, root, pivot, pose):
    root.rotation_euler = tuple(math.radians(pose[key]) for key in ("pitch", "yaw", "roll"))
    # Rotate around the fixed asset center without changing the FBX parenting.
    root.location = pivot - root.rotation_euler.to_matrix() @ pivot
    bpy.context.view_layer.update()


def render_rig_metadata():
    scene = bpy.context.scene
    camera = scene.camera
    return {
        "camera_location": list(camera.location),
        "camera_rotation": list(camera.rotation_euler),
        "ortho_scale": camera.data.ortho_scale,
        "exposure": scene.view_settings.exposure,
        "lights": {
            obj.name: {
                "location": list(obj.location),
                "rotation": list(obj.rotation_euler),
                "energy": obj.data.energy,
                "size": obj.data.size if obj.data.type == "AREA" else obj.data.shadow_soft_size,
            }
            for obj in scene.objects if obj.type == "LIGHT"
        },
    }


def configure_camera(center, scale, axis, depth_sign):
    camera_data = bpy.data.cameras.new("OrthographicCamera")
    camera = bpy.data.objects.new("OrthographicCamera", camera_data)
    bpy.context.collection.objects.link(camera)

    depth_axis = axis["depth_axis"]
    vertical_axis = axis["vertical_axis"]
    spans = axis["spans"]
    distance = max(spans) * 3.0 + 10.0
    location = Vector(center)
    location[depth_axis] += float(depth_sign) * distance
    camera.location = location
    direction = Vector(center) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", axis_name(vertical_axis)).to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(scale, 0.01)
    camera.data.clip_end = distance * 4.0
    bpy.context.scene.camera = camera
    return camera


def configure_render(output_path, resolution):
    scene = bpy.context.scene
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output_path)
    scene.world = scene.world or bpy.data.worlds.new("World")
    scene.world.color = (0.86, 0.88, 0.86)
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "Medium High Contrast"
        scene.view_settings.exposure = 0
        scene.view_settings.gamma = 1
    except Exception as error:
        print(f"Warning: color management setup skipped: {error}")


def clear_render_rig():
    for obj in list(bpy.context.scene.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)


def load_render_items(*, output_path, render_plan_path, default_pose):
    if output_path:
        return [{"output": str(output_path), **default_pose}]

    plan_path = Path(render_plan_path)
    if not plan_path.exists():
        raise FileNotFoundError(f"Render plan not found: {plan_path}")
    with plan_path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    items = payload.get("renders") if isinstance(payload, dict) else payload
    if not isinstance(items, list) or not items:
        raise ValueError(f"Render plan must contain a non-empty renders array: {plan_path}")

    normalized = []
    seen_outputs = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not item.get("output"):
            raise ValueError(f"Render plan item {index} must contain an output path.")
        output = str(Path(item["output"]).expanduser().resolve())
        if output in seen_outputs:
            raise ValueError(f"Render plan contains duplicate output path: {output}")
        seen_outputs.add(output)
        pose = {}
        for field in ("yaw", "pitch", "roll"):
            try:
                value = float(item.get(field, 0.0))
            except (TypeError, ValueError) as error:
                raise ValueError(f"Render plan item {index} has invalid {field}.") from error
            if not math.isfinite(value):
                raise ValueError(f"Render plan item {index} has non-finite {field}.")
            pose[field] = value
        normalized.append({"output": output, **pose})
    return normalized


def point_object_at(obj, target):
    direction = Vector(target) - obj.location
    if direction.length == 0:
        return
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_lights(center, axis, depth_sign, frame_scale):
    vertical_axis = axis["vertical_axis"]
    horizontal_axis = axis["horizontal_axis"]
    depth_axis = axis["depth_axis"]
    reach = max(frame_scale * 1.5, 8.0)
    light_size = max(frame_scale * 0.35, 5.0)

    light_data = bpy.data.lights.new("KeyLight", type="AREA")
    light_data.energy = 16000
    light_data.size = light_size
    light = bpy.data.objects.new("KeyLight", light_data)
    bpy.context.collection.objects.link(light)
    key_location = Vector(center)
    key_location[depth_axis] += float(depth_sign) * reach
    key_location[vertical_axis] += reach * 0.45
    key_location[horizontal_axis] += reach * 0.2
    light.location = key_location
    point_object_at(light, center)

    front_data = bpy.data.lights.new("FrontSoftLight", type="AREA")
    front_data.energy = 6000
    front_data.size = light_size * 1.4
    front = bpy.data.objects.new("FrontSoftLight", front_data)
    bpy.context.collection.objects.link(front)
    front_location = Vector(center)
    front_location[depth_axis] += float(depth_sign) * reach * 0.9
    front.location = front_location
    point_object_at(front, center)

    fill_data = bpy.data.lights.new("FillLight", type="POINT")
    fill_data.energy = 2500
    fill = bpy.data.objects.new("FillLight", fill_data)
    bpy.context.collection.objects.link(fill)
    fill_location = Vector(center)
    fill_location[depth_axis] += float(depth_sign) * reach * 0.75
    fill_location[vertical_axis] += reach * 0.1
    fill_location[horizontal_axis] -= reach * 0.35
    fill.location = fill_location


def main():
    args = parse_args()
    fbx_path = Path(args.fbx).expanduser()
    output_path = Path(args.output).expanduser() if args.output else None
    texture_path = Path(args.texture).expanduser() if args.texture else None
    eye_texture_path = Path(args.eye_texture).expanduser() if args.eye_texture else None
    eyebrow_mask_path = Path(args.eyebrow_mask).expanduser() if args.eyebrow_mask else None
    eyebrow_color = parse_rgb_color(args.eyebrow_color)
    if not fbx_path.exists():
        raise FileNotFoundError(f"FBX not found: {fbx_path}")
    if texture_path and not texture_path.exists():
        raise FileNotFoundError(f"Texture not found: {texture_path}")
    if eye_texture_path and not eye_texture_path.exists():
        raise FileNotFoundError(f"Eye texture not found: {eye_texture_path}")
    if eyebrow_mask_path and not eyebrow_mask_path.exists():
        raise FileNotFoundError(f"Eyebrow mask not found: {eyebrow_mask_path}")
    fbx_path = fbx_path.resolve()
    if output_path:
        output_path = output_path.resolve()
    if texture_path:
        texture_path = texture_path.resolve()
    if eye_texture_path:
        eye_texture_path = eye_texture_path.resolve()
    if eyebrow_mask_path:
        eyebrow_mask_path = eyebrow_mask_path.resolve()
    render_items = load_render_items(
        output_path=output_path,
        render_plan_path=args.render_plan,
        default_pose={"yaw": args.yaw, "pitch": args.pitch, "roll": args.roll},
    )
    map_paths = {}
    if args.auto_maps:
        map_paths.update(auto_map_paths(texture_path))
    explicit_map_paths = {
        "normal": resolve_texture_path(args.normal),
        "roughness": resolve_texture_path(args.roughness),
        "specular": resolve_texture_path(args.specular),
        "cavity": resolve_texture_path(args.cavity),
    }
    map_paths.update({map_name: map_path for map_name, map_path in explicit_map_paths.items() if map_path})
    clear_scene()
    imported, meshes = import_fbx(fbx_path)
    apply_material(
        meshes,
        texture_path,
        args.material_mode,
        map_paths,
        args.component_materials,
        eyebrow_mask_path=eyebrow_mask_path,
        eyebrow_color=eyebrow_color,
    )
    apply_eye_material(
        meshes=meshes,
        eye_texture_path=eye_texture_path,
        material_mode=args.material_mode,
    )
    render_root = set_origins_and_rotation(imported, 0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    if args.crop == "head" and args.head_only:
        meshes = hide_non_head_meshes(meshes)
    if args.crop == "head" and args.clip_body:
        clip_body_to_head_region(meshes)
    bpy.context.view_layer.update()
    camera_axis = camera_axis_metadata(meshes, args.axis_mode)
    if args.component_materials == "hide-unsupported":
        hide_unsupported_meshes(meshes)
    hidden_lashes = hide_untextured_lashes(meshes) if args.hide_untextured_lashes else []
    if args.hide_untextured_lashes:
        print("Hidden untextured lash meshes", hidden_lashes)
    hidden_explicit = hide_named_meshes(meshes=meshes, names=args.hide_mesh)
    print("Hidden explicit meshes", hidden_explicit)

    if args.stable_framing:
        camera_axis = camera_axis_metadata(meshes=meshes, axis_mode=args.axis_mode, visible_only=True)
        pivot, center, scale, axis, lighting_scale = prepare_stable_framing(
            meshes=meshes, render_items=render_items, camera_axis=camera_axis,
        )
        clear_render_rig()
        configure_camera(center=center, scale=scale, axis=axis, depth_sign=args.depth_sign)
        add_lights(center=pivot, axis=axis, depth_sign=args.depth_sign, frame_scale=lighting_scale)

    for render_item in render_items:
        if args.stable_framing:
            apply_stable_pose(root=render_root, pivot=pivot, pose=render_item)
        else:
            render_root.rotation_euler = (
                math.radians(render_item["pitch"]),
                math.radians(render_item["yaw"]),
                math.radians(render_item["roll"]),
            )
            bpy.context.view_layer.update()
            center, scale, axis = frame_bounds(meshes, args.crop, camera_axis)
            clear_render_rig()
            configure_camera(center, scale, axis, args.depth_sign)
            add_lights(center, axis, args.depth_sign, scale)
        render_output_path = Path(render_item["output"])
        render_output_path.parent.mkdir(parents=True, exist_ok=True)
        configure_render(render_output_path, args.resolution)
        bpy.ops.render.render(write_still=True)

        print(
            "Rendered",
            {
                "fbx": str(fbx_path),
                "texture": str(texture_path) if texture_path else "",
                "eye_texture": str(eye_texture_path) if eye_texture_path else "",
                "eyebrow_mask": str(eyebrow_mask_path) if eyebrow_mask_path else "",
                "material_mode": args.material_mode,
                "component_materials": args.component_materials,
                "hidden_lash_meshes": hidden_lashes,
                "hidden_meshes": sorted(mesh.name for mesh in meshes if mesh.hide_render),
                "maps": {key: str(value) for key, value in map_paths.items()},
                "output": str(render_output_path),
                "crop": args.crop,
                "stable_framing": args.stable_framing,
                "rotation_pivot": list(pivot) if args.stable_framing else [0.0, 0.0, 0.0],
                "rig": render_rig_metadata(),
                "pose": {
                    "yaw": render_item["yaw"],
                    "pitch": render_item["pitch"],
                    "roll": render_item["roll"],
                },
                "axis": axis,
            },
            flush=True,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
