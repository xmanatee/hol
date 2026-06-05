import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONSTRUCTION_MODES,
  createReconstructionEngine,
} from './anchor.reconstructionModes.js';

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

test('reconstruction mode registry exposes the three selectable engines', () => {
  assert.deepEqual(RECONSTRUCTION_MODES.map(mode => mode.id), [
    'sparse-reconstruction',
    'parametric-surface',
    'direct-photometric',
  ]);

  for (const mode of RECONSTRUCTION_MODES) {
    const engine = createReconstructionEngine(mode.id);
    assert.equal(typeof engine.reset, 'function');
    assert.equal(typeof engine.addFrameFromTrackedPoints, 'function');
    assert.equal(typeof engine.estimatePoseFromTrackedPoints, 'function');
    assert.equal(typeof engine.getState, 'function');
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
  assert.equal(result.success, true);
  assert.equal(result.method, 'parametric-surface');
  assert.ok(result.position.x > 266 && result.position.x < 278);
  assert.ok(result.position.y > 181 && result.position.y < 193);
  assert.ok(Math.abs(result.planarTransform.scale - targetPose.scale / referencePose.scale) < 0.16);
  assert.ok(Math.abs(result.planarTransform.rotation - targetPose.rotation) < 0.16);
  assert.ok(Math.hypot(result.normal.x, result.normal.y) > 0.16);
  assert.ok(result.inlierCount >= 44);
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
  assert.ok(confidence.at(-1) > confidence[2]);
  assert.equal(result.success, true);
  assert.equal(result.method, 'direct-photometric');
  assert.ok(result.confidence >= 0.5);
  assert.ok(result.averageResidual < 12);
});
