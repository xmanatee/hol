import test from 'node:test';
import assert from 'node:assert/strict';

import { DepthFusionReconstructor, DEPTH_FUSION_POSE_MODEL } from './anchor.depthFusion.js';
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

const createDepthFrame = ({ width = 96, height = 96, offset = 0, gradientScale = 1 } = {}) => {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = 0.24 + (x / width * 0.32 + y / height * 0.18) * gradientScale + offset;
    }
  }
  return {
    width,
    height,
    data,
    timestamp: 1000,
    processingTime: 8.4,
    provider: 'webgpu',
    modelUrl: '/models/depth_anything_v2_small.onnx',
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

const configureCamera = engine => {
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
    depthFrame: createDepthFrame({ offset: 0.01 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });
  const pose = engine.estimatePoseFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }));
  const coloredPoint = state.preview.points.find(point => point.color);

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
  assert.ok(state.preview.points.some(point => Number.isFinite(point.cameraZ) === false) === false);
  assert.ok(coloredPoint.color.r >= 0);
  assert.ok(coloredPoint.color.g >= 0);
  assert.equal(coloredPoint.color.b, 180);
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
    depthFrame: createDepthFrame({ offset: 0.01 }),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData,
  });

  let previewCalls = 0;
  const originalPreviewPoints = engine.surfelMap.previewPoints.bind(engine.surfelMap);
  engine.surfelMap.previewPoints = options => {
    previewCalls++;
    return originalPreviewPoints(options);
  };

  const pose = engine.estimatePoseFromTrackedPoints(createTrackedPoints({ tx: 4, ty: -3, scale: 1.04 }));

  assert.equal(pose.success, true);
  assert.equal(previewCalls, 1);
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
      data[y * 32 + x] = 0.25 + x / 32 * 0.2 + y / 32 * 0.15;
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
      modelUrl: '/models/depth_anything_v2_small.onnx',
    },
    depthState: { state: 'ready' },
    objectSupportMask: createMask(),
    imageData: createImageData(),
  });

  assert.ok(state.landmarkCount >= 40);
  assert.ok(Math.max(...state.preview.points.map(point => point.x)) > 60);
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
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });
  engine.surfels.forEach(surfel => {
    surfel.z += 40;
  });
  const state = engine.addFrameFromTrackedPoints(createTrackedPoints(), 1040, {
    depthFrame: createDepthFrame(),
    depthState: { state: 'ready' },
    objectSupportMask: mask,
    imageData: createImageData(),
  });

  assert.equal(state.ready, false);
  assert.match(state.lastFailureReason, /Depth frame rejected/);
});
