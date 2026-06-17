import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONSTRUCTION_MODES,
  createReconstructionEngine,
} from './anchor.reconstructionModes.js';
import {
  modelFromRegion,
  normalForSurfaceModel,
  pointForSurfaceModel,
  surfaceMeshForModel,
} from './anchor.parametricGeometry.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const referencePose = { scale: 1.2, rotation: 0, tx: 240, ty: 170 };

const transformPoint = (point, pose) => {
  const cos = Math.cos(pose.rotation);
  const sin = Math.sin(pose.rotation);
  return {
    x: pose.tx + pose.scale * (cos * point.x - sin * point.y),
    y: pose.ty + pose.scale * (sin * point.x + cos * point.y),
  };
};

const createCylinderShape = () => {
  const points = [];
  let id = 0;
  for (let row = -3; row <= 3; row++) {
    for (let column = -5; column <= 5; column++) {
      const theta = column / 5 * Math.PI * 0.42;
      const radius = 52;
      points.push({
        id: id++,
        x: Math.sin(theta) * radius,
        y: row * 18,
        z: Math.cos(theta) * radius - radius,
      });
    }
  }
  return points;
};

const trackedPointsForPose = (shape, pose, slidingIds = new Set()) => shape.map(point => {
  const original = transformPoint(point, referencePose);
  const current = transformPoint(point, pose);
  const slide = slidingIds.has(point.id) ? 34 : 0;

  return {
    id: point.id,
    original,
    current: { x: current.x, y: current.y + slide },
    response: 1,
    status: 'active',
    age: 28,
    stabilityScore: slidingIds.has(point.id) ? 0.18 : 0.9,
  };
});

const projectCameraPoint = ({ point, pose, camera }) => {
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const cr = Math.cos(pose.roll);
  const sr = Math.sin(pose.roll);
  const rollPoint = {
    x: cr * point.x - sr * point.y,
    y: sr * point.x + cr * point.y,
    z: point.z,
  };
  const pitchPoint = {
    x: rollPoint.x,
    y: cp * rollPoint.y - sp * rollPoint.z,
    z: sp * rollPoint.y + cp * rollPoint.z,
  };
  const rotated = {
    x: cy * pitchPoint.x + sy * pitchPoint.z,
    y: pitchPoint.y,
    z: -sy * pitchPoint.x + cy * pitchPoint.z,
  };
  const x = rotated.x + pose.tx;
  const y = rotated.y + pose.ty;
  const z = rotated.z + pose.distance;

  return {
    x: camera.cx + camera.fx * x / z,
    y: camera.cy + camera.fy * y / z,
  };
};

const cylinderTrackedPointsForCameraPose = ({ referencePoints, anchorReference, pose, camera, bounds }) => {
  const points = referencePoints.map(reference => {
    const modelPoint = pointForSurfaceModel(reference, bounds, 'cylinder');
    return {
      id: reference.id,
      original: { x: reference.x, y: reference.y },
      current: projectCameraPoint({ point: modelPoint, pose, camera }),
      response: 1,
      status: 'active',
      age: 30,
      stabilityScore: 0.94,
    };
  });
  const anchorModelPoint = pointForSurfaceModel(anchorReference, bounds, 'cylinder');

  return {
    trackedPoints: points,
    anchor: projectCameraPoint({ point: anchorModelPoint, pose, camera }),
  };
};

const createGrayImage = (width, height, frameIndex) => {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stripe = Math.sin(x * 0.13 + frameIndex * 0.2) * 38;
      const curve = Math.cos((x + y) * 0.045) * 24;
      data[y * width + x] = Math.max(0, Math.min(255, 126 + stripe + curve));
    }
  }
  return { cols: width, rows: height, data };
};

test('reconstruction mode registry exposes selectable engines', () => {
  assert.deepEqual(RECONSTRUCTION_MODES.map(mode => mode.id), [
    'sparse-reconstruction',
    'parametric-surface',
    'direct-photometric',
    'depth-fusion',
  ]);

  for (const mode of RECONSTRUCTION_MODES) {
    const engine = createReconstructionEngine(mode.id);
    assert.equal(typeof engine.reset, 'function');
    assert.equal(typeof engine.updateReferenceRegion, 'function');
    assert.equal(typeof engine.addFrameFromTrackedPoints, 'function');
    assert.equal(typeof engine.estimatePoseFromTrackedPoints, 'function');
    assert.equal(typeof engine.getState, 'function');
  }

  assert.equal(RECONSTRUCTION_MODES.find(mode => mode.id === 'depth-fusion').requiresDepthFrame, true);
});

test('reconstruction engines update object reference region without resetting mapped observations', () => {
  for (const mode of RECONSTRUCTION_MODES) {
    const engine = createReconstructionEngine(mode.id);
    engine.reset({
      anchorReference: { x: 120, y: 160 },
      templateRegion: { x: 98, y: 138, width: 44, height: 44 },
      targetClass: null,
    });
    engine.frames.push({ observations: [] });

    engine.updateReferenceRegion({ x: 64, y: 52, width: 94, height: 180 }, null);

    assert.deepEqual(engine.templateRegion, { x: 64, y: 52, width: 94, height: 180 });
    assert.equal(engine.frames.length, 1);
    assert.equal(engine.targetSurfaceModel || engine.model || engine.surfaceModel, 'cylinder');
  }
});

test('reconstruction engines reset cleanly during anchor disposal', () => {
  for (const mode of RECONSTRUCTION_MODES) {
    const engine = createReconstructionEngine(mode.id);
    engine.reset({ anchorReference: { x: 0, y: 0 } });
    assert.equal(engine.getState().poseModel, mode.id);
  }
});

test('parametric surface engine uses target class before crop aspect fallback', () => {
  const engine = createReconstructionEngine('parametric-surface');

  engine.reset({
    anchorReference: { x: 0, y: 0 },
    templateRegion: { x: 0, y: 0, width: 170, height: 245 },
    targetClass: 'book',
  });
  assert.equal(engine.getState().preview.surface.model, 'plane');

  engine.reset({
    anchorReference: { x: 0, y: 0 },
    templateRegion: { x: 0, y: 0, width: 180, height: 250 },
    targetClass: 'can',
  });
  assert.equal(engine.getState().preview.surface.model, 'cylinder');

  engine.reset({
    anchorReference: { x: 0, y: 0 },
    templateRegion: { x: 0, y: 0, width: 230, height: 245 },
    targetClass: 'cup',
  });
  assert.equal(engine.getState().preview.surface.model, 'tapered-cylinder');

  engine.reset({
    anchorReference: { x: 0, y: 0 },
    templateRegion: { x: 0, y: 0, width: 190, height: 185 },
    targetClass: 'ball',
  });
  assert.equal(engine.getState().preview.surface.model, 'ellipsoid');
});

test('ellipsoid surface prior exposes curved 3D points and closed preview faces', () => {
  const bounds = {
    min: { x: 100, y: 80, z: 0 },
    max: { x: 300, y: 280, z: 0 },
  };
  const center = { x: 200, y: 180 };
  const side = { x: 270, y: 180 };
  const top = { x: 200, y: 110 };
  const centerPoint = pointForSurfaceModel(center, bounds, 'ellipsoid');
  const sidePoint = pointForSurfaceModel(side, bounds, 'ellipsoid');
  const topPoint = pointForSurfaceModel(top, bounds, 'ellipsoid');
  const mesh = surfaceMeshForModel(bounds, 'ellipsoid');

  assert.ok(Math.abs(centerPoint.z) < 1e-6);
  assert.ok(sidePoint.z < -18);
  assert.ok(topPoint.z < -18);
  assert.ok(mesh.points.some(point => point.z < -40));
  assert.ok(mesh.faces.length >= 96);
});

test('surface model priors cover common mobile reconstruction targets', () => {
  assert.equal(modelFromRegion({ width: 180, height: 220 }, 'human face'), 'ellipsoid');
  assert.equal(modelFromRegion({ width: 120, height: 150 }, 'head'), 'ellipsoid');
  assert.equal(modelFromRegion({ width: 260, height: 160 }, 'poster'), 'plane');
  assert.equal(modelFromRegion({ width: 120, height: 220 }, 'phone'), 'plane');
  assert.equal(modelFromRegion({ width: 260, height: 150 }, 'laminated card'), 'plane');
  assert.equal(modelFromRegion({ width: 240, height: 220 }, 'shelves'), 'box');
  assert.equal(modelFromRegion({ width: 180, height: 240 }, 'bookcase'), 'box');

  const bounds = {
    min: { x: 100, y: 80, z: 0 },
    max: { x: 300, y: 280, z: 0 },
  };
  const center = pointForSurfaceModel({ x: 200, y: 180 }, bounds, 'box');
  const leftEdge = pointForSurfaceModel({ x: 104, y: 180 }, bounds, 'box');
  const leftNormal = normalForSurfaceModel({ x: 104, y: 180 }, bounds, 'box');

  assert.ok(Math.abs(center.z) < 1e-6);
  assert.ok(leftEdge.z < -30);
  assert.ok(leftNormal.x < -0.45);
  assert.ok(leftNormal.z > 0.65);
});

test('parametric surface engine fits a stable cylinder despite sliding stripe outliers', () => {
  const shape = createCylinderShape();
  const engine = createReconstructionEngine('parametric-surface');
  const anchorReference = transformPoint({ x: 0, y: 0, z: 0 }, referencePose);
  engine.reset({
    anchorReference,
    templateRegion: { x: 180, y: 90, width: 125, height: 230 },
  });

  for (let frame = 0; frame < 9; frame++) {
    const pose = {
      scale: 1.18 + frame * 0.018,
      rotation: -0.08 + frame * 0.025,
      tx: 240 + frame * 3,
      ty: 170 + frame * 1.2,
    };
    const slidingIds = new Set(shape.filter(point => point.id % 7 === frame % 7).map(point => point.id));
    engine.addFrameFromTrackedPoints(trackedPointsForPose(shape, pose, slidingIds), 1000 + frame * 33);
  }

  const targetPose = { scale: 1.42, rotation: 0.22, tx: 272, ty: 187 };
  const result = engine.estimatePoseFromTrackedPoints(
    trackedPointsForPose(shape, targetPose, new Set(shape.filter(point => point.id % 6 === 0).map(point => point.id)))
  );
  const state = engine.getState();

  assert.equal(state.ready, true);
  assert.equal(state.preview.surface.model, 'cylinder');
  assert.ok(state.preview.surface.mesh.length >= 24);
  assert.ok(state.preview.surface.faces.length >= 24);
  assert.equal(result.success, true);
  assert.equal(result.method, 'parametric-surface');
  assert.ok(result.position.x > 266 && result.position.x < 278);
  assert.ok(result.position.y > 181 && result.position.y < 193);
  assert.ok(Math.abs(result.planarTransform.scale - targetPose.scale / referencePose.scale) < 0.16);
  assert.ok(Math.abs(result.planarTransform.rotation - targetPose.rotation) < 0.16);
  assert.ok(Math.hypot(result.normal.x, result.normal.y) > 0.16);
  assert.ok(result.inlierCount >= 44);
});

test('parametric surface engine projects off-center curved anchors from the PnP pose', async () => {
  const cv = await loadOpenCvForNode();
  const camera = { fx: 690, fy: 690, cx: 320, cy: 240 };
  const bounds = {
    min: { x: 172, y: 88, z: 0 },
    max: { x: 304, y: 320, z: 0 },
  };
  const referencePoints = [];
  let id = 0;
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 10; column++) {
      referencePoints.push({
        id: id++,
        x: bounds.min.x + column * (bounds.max.x - bounds.min.x) / 9,
        y: bounds.min.y + row * (bounds.max.y - bounds.min.y) / 7,
      });
    }
  }
  const anchorReference = { x: 276, y: 204 };
  const engine = createReconstructionEngine('parametric-surface');
  engine.configure({ cv, cameraParams: camera });
  engine.reset({
    anchorReference,
    templateRegion: {
      x: bounds.min.x,
      y: bounds.min.y,
      width: bounds.max.x - bounds.min.x,
      height: bounds.max.y - bounds.min.y,
    },
    targetClass: 'can',
  });

  for (let frame = 0; frame < 7; frame++) {
    const pose = {
      yaw: (-0.12 + frame * 0.055),
      pitch: 0.02 + frame * 0.01,
      roll: -0.03 + frame * 0.01,
      tx: 6 + frame * 1.4,
      ty: -5 + frame * 0.8,
      distance: 705 - frame * 7,
    };
    const { trackedPoints } = cylinderTrackedPointsForCameraPose({
      referencePoints,
      anchorReference,
      pose,
      camera,
      bounds,
    });
    engine.addFrameFromTrackedPoints(trackedPoints, 1000 + frame * 33);
  }

  const targetPose = {
    yaw: 0.48,
    pitch: 0.09,
    roll: 0.04,
    tx: 18,
    ty: 2,
    distance: 650,
  };
  const targetFrame = cylinderTrackedPointsForCameraPose({
    referencePoints,
    anchorReference,
    pose: targetPose,
    camera,
    bounds,
  });
  const result = engine.estimatePoseFromTrackedPoints(targetFrame.trackedPoints);

  assert.equal(result.success, true);
  assert.ok(result.pnpInlierCount >= 36);
  assert.ok(result.pnpAverageResidual < 3.5);
  assert.ok(Math.hypot(result.position.x - targetFrame.anchor.x, result.position.y - targetFrame.anchor.y) < 3.5);
});

test('direct photometric engine grows a surfel map from stable gradient samples', () => {
  const shape = createCylinderShape();
  const engine = createReconstructionEngine('direct-photometric');
  const anchorReference = transformPoint({ x: 0, y: 0, z: 0 }, referencePose);
  engine.reset({
    anchorReference,
    templateRegion: { x: 176, y: 86, width: 132, height: 236 },
  });

  const confidence = [];
  for (let frame = 0; frame < 10; frame++) {
    const pose = {
      scale: 1.16 + frame * 0.014,
      rotation: -0.04 + frame * 0.018,
      tx: 238 + frame * 2.5,
      ty: 169 + frame,
    };
    const trackedPoints = trackedPointsForPose(shape, pose, new Set(shape.filter(point => point.id % 9 === 0).map(point => point.id)));
    const state = engine.addFrameFromTrackedPoints(trackedPoints, 1000 + frame * 33, createGrayImage(420, 320, frame));
    confidence.push(state.statistics.mapConfidence);
  }

  const result = engine.estimatePoseFromTrackedPoints(
    trackedPointsForPose(shape, { scale: 1.36, rotation: 0.16, tx: 270, ty: 184 }),
    createGrayImage(420, 320, 11)
  );
  const state = engine.getState();

  assert.equal(state.ready, true);
  assert.equal(state.preview.surface.model, 'photometric-surfels');
  assert.ok(state.preview.points.length >= 34);
  assert.ok(state.preview.surface.faces.length >= 18);
  assert.ok(confidence.at(-1) > confidence[2]);
  assert.equal(result.success, true);
  assert.equal(result.method, 'direct-photometric');
  assert.ok(result.confidence >= 0.5);
  assert.ok(result.averageResidual < 12);
});

test('surface reconstruction engines reject cup-like sliding tracks instead of growing confident maps', () => {
  const shape = createCylinderShape();

  for (const mode of ['parametric-surface', 'direct-photometric']) {
    const engine = createReconstructionEngine(mode);
    const anchorReference = transformPoint({ x: 0, y: 0, z: 0 }, referencePose);
    engine.reset({
      anchorReference,
      templateRegion: { x: 176, y: 86, width: 132, height: 236 },
      targetClass: 'cup',
    });

    for (let frame = 0; frame < 9; frame++) {
      const trackedPoints = shape.map(point => {
        const original = transformPoint(point, referencePose);
        const stripe = Math.round(original.x / 12);
        return {
          id: point.id,
          original,
          current: {
            x: original.x + frame * 2.1 + Math.sin(stripe * 1.6 + frame * 0.4) * 15,
            y: original.y + frame * 1.3 + Math.sin(stripe * 2.4 + frame * 0.85) * 36,
          },
          response: 1,
          status: 'active',
          age: 30,
          stabilityScore: 0.9,
        };
      });
      engine.addFrameFromTrackedPoints(trackedPoints, 1000 + frame * 33, createGrayImage(420, 320, frame));
    }

    const state = engine.getState();
    const result = engine.estimatePoseFromTrackedPoints(shape.map(point => {
      const original = transformPoint(point, referencePose);
      const stripe = Math.round(original.x / 12);
      return {
        id: point.id,
        original,
        current: {
          x: original.x + 22 + Math.sin(stripe * 1.6) * 18,
          y: original.y + 12 + Math.sin(stripe * 2.4) * 42,
        },
        response: 1,
        status: 'active',
        age: 30,
        stabilityScore: 0.9,
      };
    }), createGrayImage(420, 320, 12));

    assert.equal(state.ready, false, mode);
    assert.ok(state.statistics.mapConfidence < 0.4, `${mode} confidence ${state.statistics.mapConfidence.toFixed(3)}`);
    assert.equal(result.success, false, mode);
  }
});
