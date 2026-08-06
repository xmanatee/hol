import test from 'node:test';
import assert from 'node:assert/strict';

import { DepthFusionReconstructor, DEPTH_FUSION_POSE_MODEL } from './anchor.depthFusion.js';
import { calculateDepthNormal, calculateDepthQuality } from './anchor.depthFusion.geometry.js';
import { createObjectSupportMask } from './objectSupportMask.js';

const createMask = ({ width = 96, height = 96, x1 = 12, y1 = 12, x2 = 84, y2 = 84 } = {}) => {
  const data = new Uint8Array(width * height);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      data[y * width + x] = 255;
    }
  }
  return createObjectSupportMask({
    width,
    height,
    data,
    source: 'unit-test',
    confidence: 0.92,
    referencePoint: { x: 48, y: 48 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
};

const createDepthFrame = ({
  width = 96,
  height = 96,
  offset = 0,
  gradientScale = 1,
  timestamp = 1000,
} = {}) => {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = 0.24 + ((x / width) * 0.32 + (y / height) * 0.18) * gradientScale + offset;
    }
  }
  return {
    width,
    height,
    data,
    timestamp,
    processingTime: 8.4,
    provider: 'webgpu',
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  };
};

const createImageData = ({ width = 96, height = 96 } = {}) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = x;
      data[offset + 1] = y;
      data[offset + 2] = 180;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

const createTrackedPoints = ({ tx = 0, ty = 0, scale = 1 } = {}) => {
  const points = [];
  let id = 0;
  for (let y = 18; y <= 78; y += 12) {
    for (let x = 18; x <= 78; x += 12) {
      points.push({
        id: id++,
        original: { x, y },
        current: {
          x: 48 + (x - 48) * scale + tx,
          y: 48 + (y - 48) * scale + ty,
        },
        response: 1,
        stabilityScore: 0.9,
        age: 24,
        status: 'active',
      });
    }
  }
  return points;
};

const configureCamera = (engine) => {
  engine.configure({
    cameraParams: {
      fx: 83,
      fy: 81,
      cx: 48,
      cy: 48,
    },
  });
};

test('depth fusion waits for a real depth frame before mapping', () => {
  const engine = new DepthFusionReconstructor({ minFrames: 2, minSurfels: 24 });
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthState: { state: 'loading' },
    objectSupportMask: createMask(),
  });

  assert.equal(state.ready, false);
  assert.equal(state.depthStatus, 'loading');
  assert.match(state.lastFailureReason, /Waiting for depth map/);
});

test('depth fusion reports missing required fusion inputs without guessing', () => {
  const engine = new DepthFusionReconstructor({ minFrames: 1, minSurfels: 24 });
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  const withoutMask = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    imageData: createImageData(),
  });
  assert.equal(withoutMask.lastFailureReason, 'Waiting for object support mask');

  const withoutIntrinsics = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1040, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
  });
  assert.equal(withoutIntrinsics.lastFailureReason, 'Waiting for camera intrinsics');
});

test('depth fusion can return hot-path state without sampling preview points', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 1,
    minSurfels: 24,
  });
  configureCamera(engine);
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  let statisticsCount = 0;
  const originalStatistics = engine._statistics.bind(engine);
  engine._statistics = () => {
    statisticsCount++;
    return originalStatistics();
  };
  let previewCalls = 0;
  const originalPreviewPoints = engine.surfelMap.previewPoints.bind(engine.surfelMap);
  engine.surfelMap.previewPoints = (options) => {
    previewCalls++;
    return originalPreviewPoints(options);
  };

  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });

  assert.equal('preview' in state, false);
  assert.equal(previewCalls, 0);
  assert.equal(statisticsCount, 1);
  assert.equal(state.ready, true);
  assert.equal(state.landmarkCount > 0, true);

  statisticsCount = 0;
  const previewState = engine.getState();

  assert.ok(previewState.preview);
  assert.equal(statisticsCount, 1);
  assert.equal(previewState.preview.statistics, previewState.statistics);
});

test('depth fusion builds a dense masked surfel map and estimates pose', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 2,
    minSurfels: 40,
    sampleStride: 4,
    voxelSize: 5,
  });
  configureCamera(engine);
  const mask = createMask();
  const imageData = createImageData();
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });
  const state = engine.addFrameFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }), 1040, {
    depthFrame: createDepthFrame({ offset: 0.01, timestamp: 1040 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });
  let statisticsCount = 0;
  const originalStatistics = engine._statistics.bind(engine);
  engine._statistics = () => {
    statisticsCount++;
    return originalStatistics();
  };
  const pose = engine.estimatePoseFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }));
  const coloredPoint = state.preview.points.find((point) => point.color);

  assert.equal(state.ready, true);
  assert.equal(state.poseModel, DEPTH_FUSION_POSE_MODEL);
  assert.ok(state.landmarkCount >= 40);
  assert.equal(state.preview.surface.model, 'depth-fusion-surfels');
  assert.equal(state.depthProvider, 'webgpu');
  assert.ok(state.depthInferenceTime > 0);
  assert.equal(pose.success, true);
  assert.equal(pose.method, DEPTH_FUSION_POSE_MODEL);
  assert.ok(pose.depthQuality > 0.01);
  assert.ok(pose.normal.z > 0.95);
  assert.equal(statisticsCount, 1);
  assert.ok(state.preview.points.some((point) => Number.isFinite(point.cameraZ) === false) === false);
  assert.ok(coloredPoint.color.r >= 0);
  assert.ok(coloredPoint.color.g >= 0);
  assert.equal(coloredPoint.color.b, 180);
});

test('depth fusion reuses one completed pose fit for the immediate same-snapshot pose', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 1,
    minSurfels: 24,
    sampleStride: 4,
    voxelSize: 5,
  });
  configureCamera(engine);
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });
  const trackedPoints = createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 });
  let preparationCount = 0;
  let fitCount = 0;
  const createPoseEvidence = engine._createPoseEvidence.bind(engine);
  engine._createPoseEvidence = (points) => {
    preparationCount++;
    return createPoseEvidence(points);
  };
  const fitPoseObservations = engine._fitPoseObservations.bind(engine);
  engine._fitPoseObservations = (observations) => {
    fitCount++;
    return fitPoseObservations(observations);
  };

  const state = engine.addFrameFromTrackedPoints(trackedPoints, 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  const pose = engine.estimatePoseFromTrackedPoints(trackedPoints, { includePreview: false });

  assert.equal(state.ready, true);
  assert.equal(pose.success, true, pose.reason);
  assert.equal(preparationCount, 1);
  assert.equal(fitCount, 1);

  const secondPose = engine.estimatePoseFromTrackedPoints(trackedPoints, { includePreview: false });
  assert.deepEqual(secondPose, pose);
  assert.equal(preparationCount, 2);
  assert.equal(fitCount, 2);
});

test('depth fusion reuses a completed failed fit but rejects stale snapshot evidence', () => {
  const engine = new DepthFusionReconstructor({ minFrames: 1, minSurfels: 24 });
  configureCamera(engine);
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });
  const collapsedPoints = createTrackedPoints().map((point) => ({
    ...point,
    current: { x: 48, y: 48 },
  }));
  let fitCount = 0;
  const fitPoseObservations = engine._fitPoseObservations.bind(engine);
  engine._fitPoseObservations = (observations) => {
    fitCount++;
    return fitPoseObservations(observations);
  };

  const state = engine.addFrameFromTrackedPoints(collapsedPoints, 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  const failedPose = engine.estimatePoseFromTrackedPoints(collapsedPoints, { includePreview: false });

  assert.match(state.lastFailureReason, /No robust similarity consensus/);
  assert.equal(failedPose.success, false);
  assert.equal(failedPose.reason, state.lastFailureReason);
  assert.equal(fitCount, 1);

  engine.addFrameFromTrackedPoints(createTrackedPoints(), 1040, {
    depthFrame: createDepthFrame({ timestamp: 1040 }),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  engine.estimatePoseFromTrackedPoints(createTrackedPoints(), { includePreview: false });
  assert.equal(fitCount, 3);
});

test('depth fusion clears pending pose evidence on skipped depth and reference changes', () => {
  const engine = new DepthFusionReconstructor({ minFrames: 1, minSurfels: 24 });
  configureCamera(engine);
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });
  const trackedPoints = createTrackedPoints();
  const depthFrame = createDepthFrame();
  let fitCount = 0;
  const fitPoseObservations = engine._fitPoseObservations.bind(engine);
  engine._fitPoseObservations = (observations) => {
    fitCount++;
    return fitPoseObservations(observations);
  };

  engine.addFrameFromTrackedPoints(trackedPoints, 1000, {
    depthFrame,
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  fitCount = 0;
  engine.addFrameFromTrackedPoints(trackedPoints, 1040, {
    depthFrame,
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  engine.estimatePoseFromTrackedPoints(trackedPoints, { includePreview: false });
  assert.equal(fitCount, 1);

  engine.addFrameFromTrackedPoints(trackedPoints, 1080, {
    depthFrame: createDepthFrame({ timestamp: 1080 }),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  engine.updateReferenceRegion({ x: 14, y: 14, width: 68, height: 68 }, 'cup');
  engine.estimatePoseFromTrackedPoints(trackedPoints, { includePreview: false });
  assert.equal(fitCount, 3);
});

test('depth fusion pose reuses ranked surfel points during pose estimation', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 2,
    minSurfels: 40,
    sampleStride: 4,
    voxelSize: 5,
  });
  configureCamera(engine);
  const mask = createMask();
  const imageData = createImageData();
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });
  engine.addFrameFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }), 1040, {
    depthFrame: createDepthFrame({ offset: 0.01, timestamp: 1040 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });

  let previewCalls = 0;
  const originalPreviewPoints = engine.surfelMap.previewPoints.bind(engine.surfelMap);
  engine.surfelMap.previewPoints = (options) => {
    previewCalls++;
    return originalPreviewPoints(options);
  };

  const pose = engine.estimatePoseFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }));

  assert.equal(pose.success, true);
  assert.equal(previewCalls, 1);
});

test('depth fusion raw geometry exactly matches the complete ranked surfel projection', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 1,
    minSurfels: 80,
    maxSurfels: 160,
    sampleStride: 1,
    voxelSize: 1,
  });
  configureCamera(engine);
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
    includePreview: false,
  });
  const rankedPoints = engine.surfelMap.previewPoints({
    limit: engine.maxSurfels,
    frameCount: engine.frames.length,
  });

  assert.equal(engine.surfelMap.size, engine.maxSurfels);
  assert.deepEqual(engine.surfelMap.measureGeometry(), {
    normal: calculateDepthNormal(rankedPoints),
    depthQuality: calculateDepthQuality(rankedPoints),
  });
});

test('depth fusion can estimate hot-path pose without live preview geometry', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 2,
    minSurfels: 40,
    sampleStride: 4,
    voxelSize: 5,
  });
  configureCamera(engine);
  const mask = createMask();
  const imageData = createImageData();
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });
  engine.addFrameFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }), 1040, {
    depthFrame: createDepthFrame({ offset: 0.01, timestamp: 1040 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });

  let previewCount = 0;
  engine._createPreview = () => {
    previewCount++;
    return { points: [] };
  };
  let previewPointCount = 0;
  const originalPreviewPoints = engine.surfelMap.previewPoints.bind(engine.surfelMap);
  engine.surfelMap.previewPoints = (options) => {
    previewPointCount++;
    return originalPreviewPoints(options);
  };

  const pose = engine.estimatePoseFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }), {
    includePreview: false,
  });

  assert.equal(pose.success, true);
  assert.equal('preview' in pose, false);
  assert.equal(previewCount, 0);
  assert.equal(previewPointCount, 0);
});

test('depth fusion caps live preview density while retaining the dense surfel map', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 1,
    minSurfels: 80,
    sampleStride: 1,
    voxelSize: 1,
  });
  configureCamera(engine);
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
  });

  assert.ok(state.landmarkCount > 120);
  assert.ok(state.preview.points.length <= 48);
});

test('depth fusion only fuses interior object-support pixels', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 1,
    minSurfels: 4,
    sampleStride: 3,
    voxelSize: 3,
  });
  configureCamera(engine);
  const tightMask = createMask({ x1: 40, y1: 40, x2: 56, y2: 56 });
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'book',
  });

  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: tightMask,
    imageData: createImageData(),
  });

  assert.ok(state.landmarkCount > 0);
  assert.ok(state.landmarkCount < 40);
});

test('depth fusion maps compact depth frames across the full source image', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 1,
    minSurfels: 40,
    sampleStride: 2,
    voxelSize: 4,
  });
  configureCamera(engine);
  const data = new Float32Array(32 * 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      data[y * 32 + x] = 0.25 + (x / 32) * 0.2 + (y / 32) * 0.15;
    }
  }
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: {
      width: 32,
      height: 32,
      sourceWidth: 96,
      sourceHeight: 96,
      data,
      timestamp: 1000,
      processingTime: 4,
      provider: 'webgpu',
      modelUrl: '/models/depth-anything-v2-small-q4.onnx',
    },
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
  });

  assert.ok(state.landmarkCount >= 40);
  assert.ok(Math.max(...state.preview.points.map((point) => point.x)) > 60);
});

test('depth fusion rejects temporally inconsistent depth buckets', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 2,
    minSurfels: 24,
    sampleStride: 6,
    voxelSize: 200,
    maxTemporalDepthJump: 3,
  });
  configureCamera(engine);
  const mask = createMask();
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: createDepthFrame({ timestamp: 1000 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });
  engine.surfels.forEach((surfel) => {
    surfel.z += 40;
  });
  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1040, {
    depthFrame: createDepthFrame({ timestamp: 1040 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });

  assert.equal(state.ready, false);
  assert.match(state.lastFailureReason, /Depth frame rejected/);
});

test('depth fusion counts each inferred depth frame as evidence exactly once', () => {
  const engine = new DepthFusionReconstructor({
    minFrames: 2,
    minSurfels: 24,
    sampleStride: 4,
    voxelSize: 5,
  });
  configureCamera(engine);
  const mask = createMask();
  const firstDepthFrame = createDepthFrame({ timestamp: 1000 });
  engine.reset({
    anchorReference: { x: 48, y: 48 },
    templateRegion: { x: 12, y: 12, width: 72, height: 72 },
    targetClass: 'cup',
  });

  const first = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1000, {
    depthFrame: firstDepthFrame,
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });
  const observationsAfterFirstFrame = [...engine.surfels.values()].reduce(
    (total, surfel) => total + surfel.observations,
    0,
  );
  const duplicate = engine.addFrameFromTrackedPoints(createTrackedPoints({ tx: 3, ty: -2 }), 1040, {
    depthFrame: firstDepthFrame,
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });
  const observationsAfterDuplicate = [...engine.surfels.values()].reduce(
    (total, surfel) => total + surfel.observations,
    0,
  );

  assert.equal(first.frameCount, 1);
  assert.equal(duplicate.frameCount, 1);
  assert.equal(duplicate.ready, false);
  assert.equal(observationsAfterDuplicate, observationsAfterFirstFrame);

  const stale = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1060, {
    depthFrame: createDepthFrame({ timestamp: 900 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });
  assert.equal(stale.frameCount, 1);
  assert.equal(
    [...engine.surfels.values()].reduce((total, surfel) => total + surfel.observations, 0),
    observationsAfterFirstFrame,
  );

  const unique = engine.addFrameFromTrackedPoints(createTrackedPoints({ tx: 3, ty: -2 }), 1080, {
    depthFrame: createDepthFrame({ offset: 0.01, timestamp: 1080 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });

  assert.equal(unique.frameCount, 2);
  assert.equal(unique.ready, true);
});
