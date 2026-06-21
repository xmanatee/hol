import test from 'node:test';
import assert from 'node:assert/strict';
import { SparseObjectReconstructor } from './anchor.reconstruction.js';

const rotatePoint = (point, pose) => {
  const yawCos = Math.cos(pose.yaw);
  const yawSin = Math.sin(pose.yaw);
  const pitchCos = Math.cos(pose.pitch);
  const pitchSin = Math.sin(pose.pitch);
  const rollCos = Math.cos(pose.roll);
  const rollSin = Math.sin(pose.roll);

  const yawed = {
    x: yawCos * point.x + yawSin * point.z,
    y: point.y,
    z: -yawSin * point.x + yawCos * point.z,
  };
  const pitched = {
    x: yawed.x,
    y: pitchCos * yawed.y - pitchSin * yawed.z,
    z: pitchSin * yawed.y + pitchCos * yawed.z,
  };

  return {
    x: rollCos * pitched.x - rollSin * pitched.y,
    y: rollSin * pitched.x + rollCos * pitched.y,
    z: pitched.z,
  };
};

const projectPoint = (point, pose) => {
  const rotated = rotatePoint(point, pose);
  return {
    x: pose.tx + pose.scale * rotated.x,
    y: pose.ty + pose.scale * rotated.y,
  };
};

const expectedFrontNormal = pose => {
  const normal = rotatePoint({ x: 0, y: 0, z: 1 }, pose);
  const length = Math.hypot(normal.x, normal.y, normal.z);
  return {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length,
  };
};

const normalAngle = (left, right) => {
  const dot = left.x * right.x + left.y * right.y + left.z * right.z;
  return Math.acos(Math.max(-1, Math.min(1, dot)));
};

const createShape = () => {
  const points = [];
  let id = 0;

  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 8; column++) {
      const x = (column - 3.5) * 18;
      const y = (row - 2) * 16;
      const z = Math.sin(column / 7 * Math.PI) * 26 + Math.cos(row / 4 * Math.PI) * 8;
      points.push({ id: id++, x, y, z });
    }
  }

  return points;
};

const createCanShape = () => {
  const points = [];
  let id = 0;
  const radius = 58;
  const height = 180;

  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 11; column++) {
      const angle = -Math.PI * 0.46 + column / 10 * Math.PI * 0.92;
      points.push({
        id: id++,
        x: Math.sin(angle) * radius,
        y: (row / 5 - 0.5) * height,
        z: Math.cos(angle) * radius - radius,
      });
    }
  }

  return points;
};

const referencePose = {
  yaw: 0,
  pitch: 0,
  roll: 0,
  scale: 1.15,
  tx: 210,
  ty: 160,
};

const trackedPointsForPose = (shape, pose, ids = null, outlierIds = new Set()) => {
  const selected = ids ? shape.filter(point => ids.includes(point.id)) : shape;

  return selected.map(point => {
    const reference = projectPoint(point, referencePose);
    const current = projectPoint(point, pose);
    const outlierOffset = outlierIds.has(point.id) ? { x: 80, y: -55 } : { x: 0, y: 0 };

    return {
      id: point.id,
      original: reference,
      current: {
        x: current.x + outlierOffset.x,
        y: current.y + outlierOffset.y,
      },
      response: 1,
      status: 'active',
      age: 30,
      stabilityScore: 0.9,
    };
  });
};

test('surface-prior sparse targets build from shorter occlusion-tolerant tracks', () => {
  const reconstructor = new SparseObjectReconstructor();

  reconstructor.reset({
    anchorReference: { x: 200, y: 160 },
    templateRegion: { x: 140, y: 60, width: 120, height: 190 },
    targetClass: 'cup',
  });

  assert.equal(reconstructor.minFrames, 4);
  assert.equal(reconstructor.minLandmarks, 14);
  assert.equal(reconstructor.minPoseLandmarks, 8);
  assert.equal(reconstructor.maxBuildFrames, 8);
  assert.equal(reconstructor.minObservationRatio, 0.46);

  reconstructor.updateReferenceRegion(
    { x: 130, y: 100, width: 160, height: 110 },
    'book'
  );

  assert.equal(reconstructor.minFrames, 6);
  assert.equal(reconstructor.minLandmarks, 18);
  assert.equal(reconstructor.minPoseLandmarks, 10);
  assert.equal(reconstructor.maxBuildFrames, 10);
  assert.equal(reconstructor.minObservationRatio, 0.58);
});

const buildReconstructor = () => {
  const shape = createShape();
  const reconstructor = new SparseObjectReconstructor({
    minFrames: 5,
    minLandmarks: 18,
    maxBuildFrames: 9,
  });
  reconstructor.reset({
    anchorReference: projectPoint({ x: 0, y: 0, z: 24 }, referencePose),
  });

  [
    { yaw: -0.28, pitch: -0.08, roll: -0.08, scale: 1.08, tx: 202, ty: 158 },
    { yaw: -0.16, pitch: 0.06, roll: -0.03, scale: 1.12, tx: 206, ty: 160 },
    { yaw: 0, pitch: 0, roll: 0, scale: 1.15, tx: 210, ty: 160 },
    { yaw: 0.14, pitch: 0.07, roll: 0.04, scale: 1.18, tx: 214, ty: 163 },
    { yaw: 0.26, pitch: -0.05, roll: 0.08, scale: 1.2, tx: 219, ty: 165 },
    { yaw: 0.38, pitch: 0.09, roll: 0.12, scale: 1.22, tx: 224, ty: 168 },
  ].forEach(pose => {
    reconstructor.addFrameFromTrackedPoints(trackedPointsForPose(shape, pose));
  });

  return { shape, reconstructor };
};

const buildCanReconstructor = () => {
  const shape = createCanShape();
  const reconstructor = new SparseObjectReconstructor({
    minFrames: 5,
    minLandmarks: 22,
    maxBuildFrames: 9,
  });
  const anchorPoint = { x: 0, y: 0, z: 0 };
  const anchorReference = projectPoint(anchorPoint, referencePose);

  reconstructor.reset({
    anchorReference,
    templateRegion: { x: anchorReference.x - 75, y: anchorReference.y - 110, width: 150, height: 220 },
    targetClass: 'can',
  });

  [
    { yaw: -0.36, pitch: -0.04, roll: -0.04, scale: 1.08, tx: 202, ty: 158 },
    { yaw: -0.18, pitch: 0.03, roll: -0.02, scale: 1.1, tx: 206, ty: 160 },
    { yaw: 0, pitch: 0, roll: 0, scale: 1.15, tx: 210, ty: 160 },
    { yaw: 0.18, pitch: 0.04, roll: 0.02, scale: 1.2, tx: 214, ty: 163 },
    { yaw: 0.34, pitch: -0.03, roll: 0.05, scale: 1.24, tx: 219, ty: 165 },
    { yaw: 0.48, pitch: 0.06, roll: 0.08, scale: 1.27, tx: 224, ty: 168 },
  ].forEach(pose => {
    reconstructor.addFrameFromTrackedPoints(trackedPointsForPose(shape, pose));
  });

  return { shape, reconstructor, anchorPoint };
};

test('sparse object reconstructor builds a 3D map from guided view changes', () => {
  const { reconstructor } = buildReconstructor();
  const state = reconstructor.getState();

  assert.equal(state.ready, true);
  assert.equal(state.state, 'ready');
  assert.ok(state.landmarkCount >= 18);
  assert.ok(state.depthQuality > 0.02);
  assert.equal(state.poseModel, 'sparse-reconstruction');
});

test('sparse object reconstructor estimates anchor position, scale, roll, and tilted normal', () => {
  const { shape, reconstructor } = buildReconstructor();
  const targetPose = {
    yaw: 0.48,
    pitch: 0.16,
    roll: 0.24,
    scale: 1.36,
    tx: 248,
    ty: 178,
  };
  const expectedAnchor = projectPoint({ x: 0, y: 0, z: 24 }, targetPose);

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPointsForPose(shape, targetPose));
  const expectedNormal = expectedFrontNormal(targetPose);

  assert.equal(result.success, true);
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 4);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 4);
  assert.ok(Math.abs(result.planarTransform.scale - targetPose.scale / referencePose.scale) < 0.12);
  assert.ok(Math.abs(result.planarTransform.rotation - targetPose.roll) < 0.15);
  assert.ok(Math.hypot(result.normal.x, result.normal.y) > 0.18);
  assert.ok(normalAngle(result.normal, expectedNormal) < 0.28);
  assert.ok(result.inlierCount >= 26);
});

test('sparse object reconstructor projects the clicked local surface normal, not the camera view direction', () => {
  const reconstructor = new SparseObjectReconstructor();
  const landmarks = new Map();
  let id = 0;

  for (let row = -2; row <= 2; row++) {
    for (let column = -3; column <= 3; column++) {
      const x = column * 18;
      const y = row * 16;
      const z = x * 0.42;
      const point = { x, y, z };
      landmarks.set(id, {
        id,
        point,
        reference: { x, y },
        observations: 8,
        support: 1,
        reliability: 0.9,
        variance: 1,
      });
      id++;
    }
  }
  for (let index = 0; index < 20; index++) {
    const x = 125 + (index % 5) * 34;
    const y = -90 + Math.floor(index / 5) * 52;
    const z = ((index % 4) - 1.5) * 42;
    const point = { x, y, z };
    landmarks.set(id, {
      id,
      point,
      reference: { x, y },
      observations: 8,
      support: 1,
      reliability: 0.88,
      variance: 1,
    });
    id++;
  }

  reconstructor.map = {
    landmarks,
    anchorPoint: { x: 0, y: 0, z: 0 },
    referenceScale: 1,
    referenceRotation: 0,
    depthQuality: 0.4,
    frameCount: 8,
    statistics: {
      averageSupport: 1,
      averageReliability: 0.9,
      matureLandmarks: landmarks.size,
      mapConfidence: 0.95,
      mappedFrames: 8,
    },
  };
  reconstructor.state = 'ready';

  const trackedPoints = [...landmarks.values()].map(landmark => ({
    id: landmark.id,
    status: 'active',
    current: {
      x: 240 + landmark.point.x,
      y: 180 + landmark.point.y,
    },
  }));

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints);

  assert.equal(result.success, true);
  assert.ok(result.normal.x < -0.32, `normal x ${result.normal.x.toFixed(3)}`);
  assert.ok(Math.abs(result.normal.y) < 0.08, `normal y ${result.normal.y.toFixed(3)}`);
  assert.ok(result.normal.z > 0.88, `normal z ${result.normal.z.toFixed(3)}`);
});

test('sparse object reconstructor keeps pose stable with missing landmarks and bad matches', () => {
  const { shape, reconstructor } = buildReconstructor();
  const targetPose = {
    yaw: -0.36,
    pitch: 0.12,
    roll: -0.18,
    scale: 0.94,
    tx: 188,
    ty: 151,
  };
  const ids = shape.slice(0, 31).map(point => point.id);
  const outlierIds = new Set(ids.slice(0, 5));
  const expectedAnchor = projectPoint({ x: 0, y: 0, z: 24 }, targetPose);

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPointsForPose(shape, targetPose, ids, outlierIds));

  assert.equal(result.success, true);
  assert.ok(result.inlierCount >= 20);
  assert.ok(result.inlierRatio > 0.62);
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 7);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 7);
});

test('sparse object reconstructor exposes a debug preview of map growth and live projection', () => {
  const { shape, reconstructor } = buildReconstructor();
  const state = reconstructor.getState();

  assert.equal(state.preview.ready, true);
  assert.equal(state.preview.poseModel, 'sparse-reconstruction');
  assert.ok(state.preview.points.length >= 18);
  assert.ok(state.preview.anchor);
  assert.ok(state.preview.bounds.min.x < state.preview.bounds.max.x);
  assert.ok(state.preview.bounds.min.z < state.preview.bounds.max.z);
  assert.equal(state.preview.current, null);

  const targetPose = {
    yaw: 0.34,
    pitch: 0.11,
    roll: 0.18,
    scale: 1.24,
    tx: 231,
    ty: 174,
  };
  const expectedAnchor = projectPoint({ x: 0, y: 0, z: 24 }, targetPose);
  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPointsForPose(shape, targetPose));

  assert.equal(result.success, true);
  assert.equal(result.preview.ready, true);
  assert.ok(result.preview.current.points.length >= 18);
  assert.ok(Math.abs(result.preview.current.anchor.x - expectedAnchor.x) < 5);
  assert.ok(Math.abs(result.preview.current.anchor.y - expectedAnchor.y) < 5);
  assert.ok(result.preview.current.normal.z > 0.5);
});

test('sparse object reconstructor can return hot-path state without rebuilding preview geometry', () => {
  const { shape, reconstructor } = buildReconstructor();
  let previewCount = 0;
  reconstructor._createPreview = () => {
    previewCount++;
    return { points: [] };
  };

  const state = reconstructor.addFrameFromTrackedPoints(
    trackedPointsForPose(shape, {
      yaw: 0.34,
      pitch: 0.11,
      roll: 0.18,
      scale: 1.24,
      tx: 231,
      ty: 174,
    }),
    1200,
    { includePreview: false }
  );

  assert.equal('preview' in state, false);
  assert.equal(previewCount, 0);
});

test('sparse object reconstructor can estimate hot-path pose without live preview', () => {
  const { shape, reconstructor } = buildReconstructor();
  const targetPose = {
    yaw: 0.34,
    pitch: 0.11,
    roll: 0.18,
    scale: 1.24,
    tx: 231,
    ty: 174,
  };
  let previewCount = 0;
  reconstructor._createPreview = () => {
    previewCount++;
    return { points: [] };
  };

  const result = reconstructor.estimatePoseFromTrackedPoints(
    trackedPointsForPose(shape, targetPose),
    { includePreview: false }
  );

  assert.equal(result.success, true);
  assert.equal('preview' in result, false);
  assert.equal(previewCount, 0);
});

test('sparse object reconstructor grows from statistically supported partial landmark tracks', () => {
  const shape = createShape();
  const reconstructor = new SparseObjectReconstructor({
    minFrames: 5,
    minLandmarks: 18,
    maxBuildFrames: 9,
  });
  reconstructor.reset({
    anchorReference: projectPoint({ x: 0, y: 0, z: 24 }, referencePose),
  });

  [
    { yaw: -0.32, pitch: -0.08, roll: -0.08, scale: 1.08, tx: 202, ty: 158 },
    { yaw: -0.22, pitch: 0.04, roll: -0.05, scale: 1.11, tx: 205, ty: 160 },
    { yaw: -0.08, pitch: 0.09, roll: -0.02, scale: 1.14, tx: 209, ty: 161 },
    { yaw: 0.08, pitch: 0.02, roll: 0.03, scale: 1.17, tx: 213, ty: 163 },
    { yaw: 0.2, pitch: -0.06, roll: 0.06, scale: 1.19, tx: 217, ty: 165 },
    { yaw: 0.34, pitch: 0.1, roll: 0.1, scale: 1.22, tx: 223, ty: 168 },
    { yaw: 0.44, pitch: 0.05, roll: 0.12, scale: 1.24, tx: 228, ty: 170 },
  ].forEach((pose, frameIndex) => {
    const visibleIds = shape
      .filter(point => (point.id + frameIndex) % 5 !== 0)
      .map(point => point.id);
    reconstructor.addFrameFromTrackedPoints(trackedPointsForPose(shape, pose, visibleIds));
  });

  const state = reconstructor.getState();

  assert.equal(state.ready, true);
  assert.ok(state.landmarkCount >= 30);
  assert.ok(state.statistics.mapConfidence > 0.55);
  assert.ok(state.statistics.averageSupport >= 0.7);

  const targetPose = {
    yaw: 0.5,
    pitch: 0.12,
    roll: 0.16,
    scale: 1.3,
    tx: 240,
    ty: 176,
  };
  const visibleIds = shape
    .filter(point => point.id % 4 !== 0)
    .map(point => point.id);
  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPointsForPose(shape, targetPose, visibleIds));

  assert.equal(result.success, true);
  assert.ok(result.inlierCount >= 22);
  assert.ok(result.confidence > 0.55);
});

test('sparse object reconstructor completes hidden mapped landmarks from coherent live object tracks', () => {
  const { shape, reconstructor } = buildReconstructor();
  const targetPose = {
    yaw: -0.42,
    pitch: 0.08,
    roll: -0.14,
    scale: 1.04,
    tx: 196,
    ty: 154,
  };
  const mappedVisible = trackedPointsForPose(
    shape,
    targetPose,
    shape.slice(0, 7).map(point => point.id)
  );
  const unmappedLiveTracks = shape.slice(7, 34).map(point => {
    const reference = projectPoint(point, referencePose);
    const current = projectPoint(point, targetPose);

    return {
      id: point.id + 1000,
      original: reference,
      current,
      response: 1,
      status: 'active',
      age: 30,
      stabilityScore: 0.9,
    };
  });
  const expectedAnchor = projectPoint({ x: 0, y: 0, z: 24 }, targetPose);

  const result = reconstructor.estimatePoseFromTrackedPoints([
    ...mappedVisible,
    ...unmappedLiveTracks,
  ]);

  assert.equal(result.success, true);
  assert.ok(result.completedLandmarkCount >= 12);
  assert.ok(result.inlierCount >= 16);
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 8);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 8);
});

test('sparse object reconstructor preview exposes a surface model instead of only points', () => {
  const { reconstructor } = buildReconstructor();
  const state = reconstructor.getState();

  assert.ok(state.preview.surface.edges.length >= state.preview.points.length);
  assert.ok(state.preview.surface.hull.length >= 3);
  assert.ok(state.preview.surface.faces.length >= 12);
  assert.ok(state.preview.points.every(point => point.reliability > 0 && point.reliability <= 1));
  assert.ok(state.preview.statistics.matureLandmarks >= 18);
  assert.ok(state.preview.statistics.mapConfidence > 0.5);
});

test('sparse object reconstructor uses a curved target surface for can normals and preview faces', () => {
  const { shape, reconstructor, anchorPoint } = buildCanReconstructor();
  const state = reconstructor.getState();
  const targetPose = {
    yaw: 0.62,
    pitch: 0.05,
    roll: 0.08,
    scale: 1.3,
    tx: 238,
    ty: 174,
  };
  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPointsForPose(shape, targetPose));
  const expectedNormal = expectedFrontNormal(targetPose);
  const expectedAnchor = projectPoint(anchorPoint, targetPose);

  assert.equal(state.ready, true);
  assert.equal(state.preview.surface.model, 'cylinder');
  assert.ok(state.preview.surface.mesh.length >= 24);
  assert.ok(state.preview.surface.faces.length >= 24);
  assert.equal(result.success, true);
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 7);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 7);
  assert.ok(normalAngle(result.normal, expectedNormal) < 0.34);
  assert.ok(result.depthQuality >= 0.12);
});

test('sparse curved target pose uses refreshed live tracks even when mapped ids are hidden', () => {
  const { shape, reconstructor, anchorPoint } = buildCanReconstructor();
  const targetPose = {
    yaw: -0.58,
    pitch: 0.08,
    roll: -0.06,
    scale: 1.18,
    tx: 190,
    ty: 153,
  };
  const refreshedTracks = shape.map(point => {
    const reference = projectPoint(point, referencePose);
    const current = projectPoint(point, targetPose);

    return {
      id: point.id + 5000,
      original: reference,
      current,
      response: 1,
      status: 'active',
      age: 30,
      stabilityScore: 0.9,
    };
  });
  const result = reconstructor.estimatePoseFromTrackedPoints(refreshedTracks);
  const expectedNormal = expectedFrontNormal(targetPose);
  const expectedAnchor = projectPoint(anchorPoint, targetPose);

  assert.equal(result.success, true);
  assert.ok(result.inlierCount >= 28);
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 8);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 8);
  assert.ok(normalAngle(result.normal, expectedNormal) < 0.38);
});

test('sparse curved target pose keeps the 3D anchor when 2D references are stale', () => {
  const { shape, reconstructor, anchorPoint } = buildCanReconstructor();
  const targetPose = {
    yaw: 0.68,
    pitch: 0.07,
    roll: 0.04,
    scale: 1.24,
    tx: 232,
    ty: 170,
  };
  const staleReferenceTracks = trackedPointsForPose(shape, targetPose).map(point => ({
    ...point,
    original: {
      x: point.original.x + 42,
      y: point.original.y - 18,
    },
  }));
  const expectedAnchor = projectPoint(anchorPoint, targetPose);

  const result = reconstructor.estimatePoseFromTrackedPoints(staleReferenceTracks);

  assert.equal(result.success, true);
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 8);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 8);
});

test('sparse curved target pose falls back to tracked attachment when the 3D fit is loose', () => {
  const { shape, reconstructor } = buildCanReconstructor();
  const targetPose = {
    yaw: 0.44,
    pitch: 0.04,
    roll: 0.02,
    scale: 1.22,
    tx: 220,
    ty: 166,
  };
  const noisyTracks = trackedPointsForPose(shape, targetPose).map(point => ({
    ...point,
    current: {
      x: point.current.x + Math.sin(point.id * 2.13) * 18,
      y: point.current.y + Math.cos(point.id * 1.71) * 14,
    },
  }));
  const expectedTrackedAnchor = projectPoint({ x: 0, y: 0, z: 0 }, targetPose);

  const result = reconstructor.estimatePoseFromTrackedPoints(noisyTracks);

  assert.equal(result.success, true);
  assert.equal(result.planarTransform.method, 'reference_similarity_transform');
  assert.ok(Math.hypot(result.position.x - expectedTrackedAnchor.x, result.position.y - expectedTrackedAnchor.y) < 18);
});

test('curved surface anchor replaces weak tracked fit when the map pose is coherent', () => {
  const reconstructor = new SparseObjectReconstructor();
  reconstructor.reset({
    anchorReference: { x: 210, y: 160 },
    templateRegion: { x: 140, y: 60, width: 140, height: 210 },
    targetClass: 'bottle',
  });
  reconstructor.map = {
    statistics: { mapConfidence: 0.79 },
  };
  const pose = {
    inlierCount: 15,
    averageResidual: 3.4,
  };
  const trackedFit = {
    success: true,
    inlierCount: 11,
    averageResidual: 6.4,
  };

  assert.equal(reconstructor._shouldUseProjectedSurfaceAnchor({
    pose,
    trackedFit,
    projectedAnchor: { x: 318, y: 230 },
    trackedAnchor: { x: 303, y: 226 },
  }), true);

  assert.equal(reconstructor._shouldUseProjectedSurfaceAnchor({
    pose,
    trackedFit: {
      ...trackedFit,
      inlierCount: 18,
    },
    projectedAnchor: { x: 318, y: 230 },
    trackedAnchor: { x: 303, y: 226 },
  }), false);
});

test('sparse object reconstructor rejects cup-like sliding tracks that do not preserve object geometry', () => {
  const shape = createShape();
  const reconstructor = new SparseObjectReconstructor({
    minFrames: 5,
    minLandmarks: 18,
    maxBuildFrames: 9,
  });
  reconstructor.reset({
    anchorReference: projectPoint({ x: 0, y: 0, z: 24 }, referencePose),
  });

  for (let frame = 0; frame < 8; frame++) {
    const points = shape.map(point => {
      const reference = projectPoint(point, referencePose);
      const stripe = Math.round(reference.x / 18);
      return {
        id: point.id,
        original: reference,
        current: {
          x: reference.x + frame * 2.4 + Math.sin(stripe * 1.7 + frame * 0.4) * 14,
          y: reference.y + frame * 1.2 + Math.sin(stripe * 2.1 + frame * 0.9) * 38,
        },
        response: 1,
        status: 'active',
        age: 30,
        stabilityScore: 0.9,
      };
    });
    reconstructor.addFrameFromTrackedPoints(points, 1000 + frame * 33);
  }

  const state = reconstructor.getState();
  const result = reconstructor.estimatePoseFromTrackedPoints(shape.map(point => {
    const reference = projectPoint(point, referencePose);
    const stripe = Math.round(reference.x / 18);
    return {
      id: point.id,
      original: reference,
      current: {
        x: reference.x + 24 + Math.sin(stripe * 1.7) * 16,
        y: reference.y + 12 + Math.sin(stripe * 2.1) * 42,
      },
      response: 1,
      status: 'active',
      age: 30,
      stabilityScore: 0.9,
    };
  }));

  assert.equal(state.ready, false);
  assert.ok(state.statistics.mapConfidence < 0.4, `map confidence ${state.statistics.mapConfidence.toFixed(3)}`);
  assert.equal(result.success, false);
});
