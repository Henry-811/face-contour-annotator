import assert from "node:assert/strict";
import { test } from "node:test";
import * as edit from "../src/contour-editing.js";
import { cloneContours } from "../src/geometry.js";
import { cloneProjectContours } from "../src/project.js";
import { serializeContours, normalizeImportedContours } from "../src/exporter.js";
import { validateFolderImage, FOLDER_IMAGE_KIND } from "../src/folder-workspace.js";
import { LABELS } from "../src/config.js";

const size = { width: 2048, height: 2048 };
const contour = (closed = false) => ({ id: "feature", label: closed ? "left_eye" : "nose", closed,
  points: [{ x: 250.25, y: 180.75 }, { x: 300, y: 440 }, { x: 520, y: 620 }, { x: 850, y: 440 }, { x: 1000, y: 260 }] });
const importContours = (contours) => normalizeImportedContours({ contours, labels: LABELS, imageSize: size, createId: () => "id" });
const at = (segment, t) => edit.splitSegment({ segment, t })[0].end;
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < tolerance, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

test("deleting an unchanged subdivision restores its original cubic, including stationary splits", () => {
  const original = { id: "arch", label: "nose", closed: false, points: [{ x: 100, y: 100 }, { x: 300, y: 100 }],
    segments: [{ control1: { x: 100, y: 300 }, control2: { x: 300, y: 300 } }] };
  for (const t of [0.1, 0.37, 0.5, 0.93]) {
    const inserted = edit.insertCurvePoint({ contour: original, segmentIndex: 0, segmentT: t });
    const deleted = edit.planPointDeletion(inserted);
    assert.equal(deleted.exact, true);
    const segment = edit.curveSegments(deleted.contour)[0];
    for (let p = 0; p <= 1; p += .01) near(at(segment, p), at(edit.curveSegments(original)[0], p));
    near(at(segment, .5), { x: 200, y: 250 });
  }
  const stationary = { ...original, points: [{ x: 100, y: 100 }, { x: 100, y: 100 }],
    segments: [{ control1: { x: 300, y: 100 }, control2: { x: 300, y: 100 } }] };
  assert.equal(edit.planPointDeletion(edit.insertCurvePoint({ contour: stationary, segmentIndex: 0, segmentT: .5 })).exact, true);
});

test("deletion changes only the joined arc and requires a preview for general fits and open endpoints", () => {
  for (const closed of [false, true]) {
    const original = edit.materializeContour(contour(closed));
    for (const pointIndex of [0, 2, 4]) {
      const planned = edit.planPointDeletion({ contour: original, pointIndex });
      assert.equal(planned.exact, false);
      assert.equal(planned.contour.points.length, 4);
      edit.validateCurve(planned.contour);
      const before = edit.curveSegments(original), after = edit.curveSegments(planned.contour);
      before.forEach((segment, index) => {
        if (index === pointIndex || (index + 1) % original.points.length === pointIndex) return;
        assert.ok(after.some((candidate) => JSON.stringify(candidate) === JSON.stringify(segment)), "Unrelated segment must be unchanged");
      });
    }
    const seam = edit.insertCurvePoint({ contour: original, segmentIndex: original.segments.length - 1, segmentT: .43 });
    const recovered = edit.planPointDeletion(seam);
    assert.equal(recovered.exact, true);
    recovered.contour.segments.forEach((segment, i) => {
      near(segment.control1, original.segments[i].control1);
      near(segment.control2, original.segments[i].control2);
    });
  }
});

for (const closed of [false, true]) {
  test(`inserting a point preserves the exact ${closed ? "closed seam" : "open"} cubic`, () => {
    const original = contour(closed), index = closed ? original.points.length - 1 : 1;
    const before = edit.curveSegments(original)[index];
    const result = edit.insertCurvePoint({ contour: original, segmentIndex: index, segmentT: 0.4 });
    assert.equal(result.contour.points.length, original.points.length + 1);
    const after = edit.curveSegments(result.contour);
    for (let t = 0; t <= 1; t += 0.02) near(at(before, t), t <= 0.4 ? at(after[index], t / 0.4) : at(after[index + 1], (t - 0.4) / 0.6));
    assert.equal(original.segments, undefined);
  });

  test(`direct and soft editing respond on sparse ${closed ? "closed" : "open"} curves`, () => {
    const original = contour(closed);
    const split = edit.insertCurvePoint({ contour: original, segmentIndex: 1, segmentT: 0.5 });
    const point = { x: split.contour.points[split.pointIndex].x + 100, y: 700 };
    for (const radius of [0, 40, 500]) {
      const moved = edit.moveCurvePoint({ ...split, point, imageSize: size, radius });
      assert.deepEqual(moved.points[split.pointIndex], point, "No old 32-pixel displacement cap");
      assert.equal(moved.points.length, split.contour.points.length);
      assert.equal(moved.segments.length, split.contour.segments.length);
      if (!radius) assert.deepEqual(moved.points[0], original.points[0]);
      assert.deepEqual(importContours(serializeContours([moved], LABELS))[0], moved);
    }
  });

  test(`delete maintains valid segment adjacency and minimum anchors (${closed})`, () => {
    for (const pointIndex of [0, 2, 4]) {
      const deleted = edit.deleteCurvePoint({ contour: contour(closed), pointIndex });
      edit.validateCurve(deleted);
      assert.equal(deleted.points.length, 4);
    }
    let current = contour(closed);
    while (current.points.length > (closed ? 3 : 2)) current = edit.deleteCurvePoint({ contour: current, pointIndex: 0 });
    assert.equal(edit.deleteCurvePoint({ contour: current, pointIndex: 0 }), null);
  });
}

test("whole contour transforms include cubic controls, retain pivot, clamp boundaries", () => {
  const original = edit.materializeContour(contour());
  const pivot = original.points[0];
  const moved = edit.transformContour({ contour: original, pivot, scaleX: 1.2, scaleY: 1.1, imageSize: size });
  near(moved.points[0], pivot);
  assert.equal(moved.segments[0].control1.x, pivot.x + (original.segments[0].control1.x - pivot.x) * 1.2);
  const rotated = edit.transformContour({ contour: original, pivot: { x: 700, y: 700 }, angle: Math.PI / 8, imageSize: size });
  near({ x: Math.hypot(rotated.points[0].x - 700, rotated.points[0].y - 700), y: 0 }, { x: Math.hypot(pivot.x - 700, pivot.y - 700), y: 0 });
  const bounded = edit.transformContour({ contour: original, pivot, dx: -10000, dy: 10000, imageSize: size });
  const bounds = edit.contourBounds(bounded);
  assert.ok(bounds.minX >= 0 && bounds.maxY <= size.height);
  assert.deepEqual(edit.transformContour({ contour: original, pivot, scaleX: 100, imageSize: size }), original);
});

test("redraw keeps untouched open segments and supports reverse endpoint order", () => {
  const original = edit.materializeContour(contour());
  const start = { segmentIndex: 1, segmentT: 0.2 }, end = { segmentIndex: 2, segmentT: 0.6 };
  const points = [{ x: 500, y: 500 }, { x: 650, y: 570 }];
  const forward = edit.redrawContour({ contour: original, start, end, points }).contour;
  const reverse = edit.redrawContour({ contour: original, start: end, end: start, points: [...points].reverse() }).contour;
  assert.deepEqual(forward, reverse);
  assert.deepEqual(edit.curveSegments(forward)[0], edit.curveSegments(original)[0]);
  assert.deepEqual(edit.curveSegments(forward).at(-1), edit.curveSegments(original).at(-1));
});

test("closed redraw supports same-segment endpoints, wraparound and both arcs", () => {
  const original = edit.materializeContour(contour(true));
  for (const [start, end] of [
    [{ segmentIndex: 1, segmentT: 0.2 }, { segmentIndex: 1, segmentT: 0.8 }],
    [{ segmentIndex: 4, segmentT: 0.7 }, { segmentIndex: 0, segmentT: 0.3 }],
  ]) {
    for (const alternate of [false, true]) {
      const result = edit.redrawContour({ contour: original, start, end, points: [{ x: 350, y: 300 }], alternate });
      edit.validateCurve(result.contour);
      assert.equal(result.contour.closed, true);
      assert.ok(result.contour.points.length >= 3);
      assert.deepEqual(importContours(serializeContours([result.contour], LABELS))[0], result.contour);
    }
  }
  assert.throws(() => edit.redrawContour({ contour: original, start: { segmentIndex: 0, segmentT: 0.5 }, end: { segmentIndex: 0, segmentT: 0.5 }, points: [] }), /different/);
});

test("hit-testing and serialization use the displayed curve, not anchor chords", () => {
  const original = contour();
  const point = at(edit.curveSegments(original)[1], 0.5);
  const hit = edit.nearestCurvePoint({ contour: original, point });
  assert.ok(hit.distance < edit.CURVE_TOLERANCE);
  assert.deepEqual(serializeContours([original], LABELS)[0].points, edit.contourPolyline(original));
});

test("malformed or divergent v2 curve data is rejected instead of losing editability", () => {
  const serialized = serializeContours([contour()], LABELS);
  for (const mutate of [
    (c) => { c.curve.version = 99; }, (c) => { c.curve.segments.pop(); },
    (c) => { c.curve.segments[0].control1.x = Infinity; },
    (c) => { c.curve.anchors[0].y = -10; }, (c) => { c.points[0].x += 1; },
    (c) => { c.points[0] = [1, 2]; },
  ]) {
    const bad = structuredClone(serialized); mutate(bad[0]);
    assert.throws(() => importContours(bad));
  }
});

test("native folder v2 roundtrip and clones preserve fractional anchors and controls", () => {
  const original = edit.materializeContour(contour());
  const record = { kind: FOLDER_IMAGE_KIND, version: 2, relativePath: "a.jpg", ...size, source: { size: 100, sha256: "a".repeat(64) }, revision: "test", status: "in_progress", contours: serializeContours([original], LABELS) };
  assert.deepEqual(validateFolderImage({ data: record, path: "a.jpg" }).contours, [original]);
  for (const clone of [cloneContours, cloneProjectContours]) {
    const result = clone([original]); result[0].segments[0].control1.x = -1;
    assert.notEqual(original.segments[0].control1.x, -1);
  }
});

test("editing an endpoint does not clamp unrelated historical cubic controls", () => {
  const original = edit.materializeContour({ id: "edge", label: "nose", closed: false, points: [{x:0,y:0},{x:0,y:100},{x:100,y:100},{x:100,y:200}] });
  assert.ok(original.segments[0].control2.x < 0);
  const moved = edit.moveCurvePoint({ contour: original, pointIndex: 3, point: { x: 110, y: 200 }, imageSize: size });
  assert.deepEqual(moved.segments[0], original.segments[0]);
});

test("repeated soft edits preserve sparse and dense anchor counts, order and saved geometry", () => {
  for (const closed of [false, true]) {
    const original = edit.materializeContour(contour(closed));
    let dense = original;
    for (let segmentIndex = original.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      dense = edit.insertCurvePoint({ contour: dense, segmentIndex, segmentT: 0.5 }).contour;
    }
    for (const source of [original, dense]) {
      for (const pointIndex of [0, Math.floor(source.points.length / 2), source.points.length - 1]) {
        let current = source;
        for (const radius of [40, 400, 2000, 0, 40]) {
          const before = structuredClone(current);
          const target = { x: current.points[pointIndex].x + 7.25, y: current.points[pointIndex].y + 4.5 };
          const moved = edit.moveCurvePoint({ contour: current, pointIndex, point: target, imageSize: size, radius });
          assert.deepEqual(current, before, "The previous undo snapshot must remain untouched");
          assert.deepEqual(moved.points[pointIndex], target, "The grabbed anchor keeps its index, including endpoints");
          assert.equal(moved.points.length, source.points.length, "Dragging must neither insert nor simplify anchors");
          assert.equal(moved.segments.length, source.segments.length);
          assert.equal(moved.closed, source.closed);
          before.segments.forEach((segment, i) => {
            const next = (i + 1) % moved.points.length;
            if (JSON.stringify(moved.points[i]) === JSON.stringify(before.points[i]) && JSON.stringify(moved.points[next]) === JSON.stringify(before.points[next])) {
              assert.deepEqual(moved.segments[i], segment, "Wholly unaffected segments must remain exact");
            }
          });
          assert.deepEqual(importContours(serializeContours([moved], LABELS))[0], moved);
          current = moved;
        }
      }
    }
  }
});

test("soft editing moves existing neighbors with falloff while keeping boundary anchors fixed", () => {
  const original = edit.materializeContour({ id: "line", label: "nose", closed: false,
    points: Array.from({ length: 7 }, (_, i) => ({ x: 100 + i * 50, y: 100 })) });
  const moved = edit.moveCurvePoint({ contour: original, pointIndex: 3, point: { x: 250, y: 140 }, imageSize: size, radius: 150 });
  [100, 110, 130, 140, 130, 110, 100].forEach((y, i) => near(moved.points[i], { x: original.points[i].x, y }));
  assert.equal(moved.points.length, original.points.length);
  assert.equal(moved.segments.length, original.segments.length);
});

test("soft influence crosses the closed seam without adding or reordering anchors", () => {
  const original = edit.materializeContour({ id: "closed", label: "left_eye", closed: true,
    points: [{x:100,y:100},{x:200,y:100},{x:200,y:200},{x:100,y:200}] });
  const moved = edit.moveCurvePoint({ contour: original, pointIndex: 0, point: { x: 110, y: 110 }, imageSize: size, radius: 150 });
  assert.deepEqual(moved.points[0], { x: 110, y: 110 });
  const shift = moved.points[1].x - original.points[1].x;
  assert.ok(shift > 0 && shift < 10);
  near(moved.points[3], { x: original.points[3].x + shift, y: original.points[3].y + shift });
  assert.deepEqual(moved.points[2], original.points[2]);
  assert.equal(moved.points.length, 4);
  assert.equal(moved.segments.length, 4);
});

test("a rotation handle remains visible for a contour touching the top edge", () => {
  const original = { ...contour(), points: [{ x: 10, y: 0 }, { x: 100, y: 0 }] };
  const handles = edit.transformHandles({ contour: original, scale: 1, imageSize: size });
  assert.ok(handles.handles.at(-1).point.y > 0);
});

test("off-image spline segments cannot introduce unsavable anchors", () => {
  const original = edit.materializeContour({ id: "edge", label: "nose", closed: false, points: [{x:0,y:0},{x:0,y:100},{x:100,y:100},{x:100,y:200}] });
  const hit = edit.nearestCurvePoint({ contour: original, point: { x: 0, y: 40 } });
  assert.ok(hit.distance < 8);
  assert.throws(() => edit.insertCurvePoint({ contour: original, segmentIndex: hit.segmentIndex, segmentT: hit.segmentT, imageSize: size }), /outside/);
  const moved = edit.moveCurvePoint({ contour: original, pointIndex: 0, point: { x: -10, y: 10 }, radius: 140, imageSize: size });
  assert.deepEqual(moved.points[0], { x: 0, y: 10 });
  assert.equal(moved.points.length, original.points.length);
  assert.equal(moved.segments.length, original.segments.length);
  assert.deepEqual(importContours(serializeContours([moved], LABELS))[0], moved);
});

test("complex historical input is rejected before it can replace saved annotations", () => {
  const large = { id: "large", label: "nose", closed: false, points: Array.from({length: 20000}, (_, i) => ({ x: 50 + (i * 197) % 400, y: 50 + (i * 89) % 400 })) };
  assert.throws(() => importContours([large]), /too complex/);
  assert.throws(() => importContours([edit.materializeContour(large)]), /too complex/);
});

test("dense anchors and thin transform boxes choose the nearest handle, not the first", () => {
  const thin = { id: "thin", label: "nose", closed: false, points: [{x:10,y:10},{x:15,y:10},{x:20,y:12}] };
  const hit = edit.hitContours({ contours: [thin], selectedId: thin.id, point: thin.points[1], tolerance: 10 });
  assert.equal(hit.pointIndex, 1);
  const corner = edit.transformHandles({ contour: thin, scale: 1, imageSize: size }).handles.find((h) => h.name === "se");
  assert.equal(edit.hitTransformHandle({ contour: thin, scale: 1, imageSize: size, point: corner.point }).name, "se");
});

test("straight Bezier segments insert at the clicked location despite nonlinear parameterization", () => {
  const line = { id: "line", label: "nose", closed: false, points: [{x:10,y:20},{x:210,y:20}] };
  const point = { x: 60, y: 20 };
  const hit = edit.nearestCurvePoint({ contour: line, point });
  const inserted = edit.insertCurvePoint({ contour: line, segmentIndex: hit.segmentIndex, segmentT: hit.segmentT, imageSize: size });
  near(inserted.contour.points[inserted.pointIndex], point, 0.001);
  const moved = edit.moveCurvePoint({ contour: line, pointIndex: 0, point: {x:20,y:30}, radius: 40, imageSize: size });
  assert.deepEqual(moved.points, [{x:20,y:30}, line.points[1]], "A sparse soft edit moves the existing anchor, not a new boundary point");
});
