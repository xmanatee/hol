import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointTracker } from './anchor.tracking.js';
import { KeypointDetector } from './anchor.keypoints.js';
import { isReconstructionEligibleLandmark } from './landmarkOwnership.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const transformPoint = (point, transform) => ({
  x:
    transform.tx +
    transform.scale * Math.cos(transform.rotation) * point.x -
    transform.scale * Math.sin(transform.rotation) * point.y,
  y:
    transform.ty +
    transform.scale * Math.sin(transform.rotation) * point.x +
    transform.scale * Math.cos(transform.rotation) * point.y,
});

const projectHomographyPoint = (point, matrix) => {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
};

const createTrackedPoint = (id, original, transform) => ({
  id,
  original,
  current: transformPoint(original, transform),
  response: 1,
  status: 'active',
  objectOwnedStreak: 2,
  errorHistory: [2],
  age: 10,
  successfulTrackingStreak: 10,
  totalSuccessfulFrames: 10,
  stabilityScore: 0.5,
  isStable: false,
});

const createSyntheticLucasKanadeCv = (flowForIndex) => {
  let opticalFlowCallCount = 0;

  class SyntheticMat {
    constructor(rows = 0, cols = 0, type = null) {
      this.create(rows, cols, type);
    }

    create(rows, cols, type) {
      this.rows = rows;
      this.cols = cols;
      this.type = type;
      this.data32F = new Float32Array(rows * cols * 2);
      this.data = new Uint8Array(rows * cols);
    }

    delete() {}
  }

  return {
    Mat: SyntheticMat,
    Size: class SyntheticSize {},
    TermCriteria: class SyntheticTermCriteria {},
    TERM_CRITERIA_EPS: 1,
    TERM_CRITERIA_COUNT: 2,
    CV_32FC2: 'CV_32FC2',
    CV_8UC1: 'CV_8UC1',
    CV_32FC1: 'CV_32FC1',
    getOpticalFlowCallCount: () => opticalFlowCallCount,
    calcOpticalFlowPyrLK(previousGray, currentGray, prevPoints, nextPoints, status, flowError) {
      for (let index = 0; index < prevPoints.rows; index++) {
        const x = prevPoints.data32F[index * 2];
        const y = prevPoints.data32F[index * 2 + 1];
        const flow = flowForIndex(index, { x, y }, opticalFlowCallCount);
        nextPoints.data32F[index * 2] = x + flow.dx;
        nextPoints.data32F[index * 2 + 1] = y + flow.dy;
        status.data[index] = flow.status ?? 1;
        flowError.data32F[index] = flow.error ?? 1;
      }
      opticalFlowCallCount++;
    },
  };
};

const executeKeypointRefresh = (
  tracker,
  cv,
  currentGray,
  detector,
  region,
  objectSupportMask = null,
  options = {},
) => {
  if (!tracker.grayFrameSlots?.includes(currentGray)) {
    tracker.grayFrameSlots = [tracker.previousGray, currentGray];
  }
  const { recoveryReferenceTransform = null, ...refreshOptions } = options;
  const plan = tracker.planKeypointRefresh(cv, { recoveryReferenceTransform });
  return tracker.refreshKeypoints({
    cv,
    plan,
    currentGray,
    keypointDetector: detector,
    region,
    objectSupportMask,
    ...refreshOptions,
  });
};

test('robust similarity fitting preserves its exact consensus result', () => {
  const tracker = new KeypointTracker();
  const phase = 32;
  const points = Array.from({ length: 35 }, (_, index) => {
    const original = {
      x: 45 + (index % 7) * 31 + Math.sin(index * 0.7 + phase) * 3,
      y: 35 + Math.floor(index / 7) * 29 + Math.cos(index * 0.43 + phase) * 4,
    };
    const rotation = 0.19 + phase * 0.003;
    const scale = 1.07 + phase * 0.0007;
    const x = 17 + scale * (Math.cos(rotation) * original.x - Math.sin(rotation) * original.y);
    const y = -11 + scale * (Math.sin(rotation) * original.x + Math.cos(rotation) * original.y);
    const noise = index % 11 === 0 ? 22 + phase * 0.01 : Math.sin(index * 1.31 + phase) * 0.45;
    return {
      original,
      current: {
        x: x + noise,
        y: y - noise * 0.6,
      },
    };
  });

  assert.deepEqual(tracker._estimateReferenceTransformation(points), {
    tx: 17.01842090430921,
    ty: -10.987405412520104,
    scale: 1.092285886919616,
    rotation: 0.2859536594764067,
    confidence: 0.8669577981982188,
    inlierCount: 31,
    averageResidual: 0.3388268712579831,
  });
});

test('reference transform preserves anchor tap offset through rotation and scale', () => {
  const tracker = new KeypointTracker();
  const transform = {
    tx: 40,
    ty: -25,
    scale: 1.18,
    rotation: (28 * Math.PI) / 180,
  };
  const originals = [
    { x: 80, y: 70 },
    { x: 160, y: 70 },
    { x: 160, y: 150 },
    { x: 80, y: 150 },
    { x: 120, y: 90 },
    { x: 140, y: 130 },
  ];

  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.keypointCentroid = { x: 120, y: 110 };
  tracker.tapOffset = { x: 18, y: -12 };
  tracker.anchorOriginalPosition = {
    x: tracker.keypointCentroid.x + tracker.tapOffset.x,
    y: tracker.keypointCentroid.y + tracker.tapOffset.y,
  };

  const anchor = tracker.getAnchorPosition();
  const expected = transformPoint(tracker.anchorOriginalPosition, transform);

  assert.equal(anchor.method, 'reference_similarity_transform');
  assert.ok(Math.abs(anchor.x - expected.x) < 0.5);
  assert.ok(Math.abs(anchor.y - expected.y) < 0.5);
  assert.ok(Math.abs(anchor.rotation - transform.rotation) < 0.03);
  assert.ok(Math.abs(anchor.scale - transform.scale) < 0.03);
});

test('reference homography preserves tapped anchor through perspective tilt and reuses its workspace', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  const workspace = tracker.referenceHomographyWorkspace;
  const workspaceHandles = Object.values(workspace);
  const findHomography = cv.findHomography.bind(cv);
  const calls = [];
  const instrumentedCv = Object.create(cv);
  instrumentedCv.findHomography = (...args) => {
    calls.push({
      sourcePoints: args[0],
      destinationPoints: args[1],
      inlierMask: args[4],
      pointCount: args[0].rows,
    });
    return findHomography(...args);
  };
  const homography = [1.08, 0.18, 22, -0.05, 0.92, 18, 0.0009, -0.0007, 1];
  const originals = Array.from({ length: 24 }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    return {
      x: 80 + column * 28,
      y: 70 + row * 24,
    };
  });

  tracker.trackedPoints = originals.map((point, index) => ({
    id: index,
    original: point,
    current: projectHomographyPoint(point, homography),
    response: 1,
    status: 'active',
    objectOwnedStreak: 2,
    errorHistory: [1],
    age: 10,
    successfulTrackingStreak: 10,
    totalSuccessfulFrames: 10,
    stabilityScore: 0.7,
    isStable: true,
  }));
  tracker.keypointCentroid = { x: 150, y: 106 };
  tracker.tapOffset = { x: 21, y: -9 };
  tracker.anchorOriginalPosition = {
    x: tracker.keypointCentroid.x + tracker.tapOffset.x,
    y: tracker.keypointCentroid.y + tracker.tapOffset.y,
  };

  const evaluation = tracker.createAnchorPositionEvaluation();
  const anchor = tracker.resolveAnchorPositionEvaluation(instrumentedCv, evaluation, {
    preferObjectWideSimilarity: false,
  });
  const refreshPlan = tracker.planKeypointRefresh(instrumentedCv, {
    attachmentEvidence: evaluation.attachmentEvidence,
  });
  const expected = projectHomographyPoint(tracker.anchorOriginalPosition, homography);

  assert.equal(anchor.method, 'reference_homography');
  assert.equal(refreshPlan.kind, 'reference');
  assert.equal(refreshPlan.transform.type, 'homography');
  assert.ok(Math.hypot(anchor.x - expected.x, anchor.y - expected.y) < 0.75);
  assert.ok(anchor.inlierCount >= 16);
  assert.ok(anchor.averageResidual < 0.75);

  tracker.trackedPoints.slice(12).forEach((point) => {
    point.status = 'inactive';
  });
  tracker.getAnchorPosition(instrumentedCv);
  tracker.trackedPoints.forEach((point) => {
    point.status = 'active';
  });
  tracker.getAnchorPosition(instrumentedCv);

  assert.deepEqual(
    calls.map((call) => call.pointCount),
    [24, 12, 24],
  );
  assert.ok(calls.every((call) => call.sourcePoints === workspace.sourcePoints));
  assert.ok(calls.every((call) => call.destinationPoints === workspace.destinationPoints));
  assert.ok(calls.every((call) => call.inlierMask === workspace.inlierMask));

  tracker.dispose();
  assert.ok(workspaceHandles.every((handle) => handle.isDeleted()));
});

test('failed real homography evidence is completed once across attachment and refresh', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  const findHomography = cv.findHomography.bind(cv);
  let homographyCalls = 0;
  const instrumentedCv = Object.create(cv);
  instrumentedCv.findHomography = (...args) => {
    homographyCalls++;
    return findHomography(...args);
  };
  tracker.trackedPoints = Array.from({ length: 12 }, (_pointEntry, index) => {
    const original = { x: 40 + index * 12, y: 90 };
    return {
      ...createTrackedPoint(index, original, {
        tx: 14,
        ty: -6,
        scale: 1.05,
        rotation: 0,
      }),
      objectOwned: true,
    };
  });
  tracker.keypointCentroid = { x: 106, y: 90 };
  tracker.anchorOriginalPosition = { x: 112, y: 84 };
  tracker.tapOffset = { x: 6, y: -6 };

  const evaluation = tracker.createAnchorPositionEvaluation();
  const attachment = tracker.resolveAnchorPositionEvaluation(instrumentedCv, evaluation, {
    preferObjectWideSimilarity: false,
  });
  const refreshPlan = tracker.planKeypointRefresh(instrumentedCv, {
    attachmentEvidence: evaluation.attachmentEvidence,
  });

  assert.equal(attachment.method, 'reference_similarity_transform');
  assert.equal(refreshPlan.kind, 'reference');
  assert.equal(refreshPlan.transform.type, undefined);
  assert.equal(homographyCalls, 1);

  tracker.dispose();
});

test('current-frame anchor evaluation reuses similarity evidence when resolving homography', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = Array.from({ length: 12 }, (_, index) => ({
    ...createTrackedPoint(
      index,
      {
        x: 70 + (index % 4) * 26,
        y: 60 + Math.floor(index / 4) * 24,
      },
      {
        tx: 10,
        ty: 5,
        scale: 1,
        rotation: 0,
      },
    ),
    objectOwned: true,
  }));
  tracker.keypointCentroid = { x: 109, y: 84 };
  tracker.anchorOriginalPosition = { x: 116, y: 80 };
  tracker.tapOffset = { x: 7, y: -4 };

  let localFitCalls = 0;
  let broadFitCalls = 0;
  let homographyCalls = 0;
  tracker._estimateLocalReferenceTransformation = () => {
    localFitCalls++;
    return {
      tx: 10,
      ty: 5,
      scale: 1,
      rotation: 0,
      confidence: 0.6,
      inlierCount: 12,
      averageResidual: 1,
      supportCount: 12,
      localAnchorTransform: true,
    };
  };
  tracker._estimateReferenceTransformation = () => {
    broadFitCalls++;
    return {
      tx: 9,
      ty: 6,
      scale: 1,
      rotation: 0,
      confidence: 0.5,
      inlierCount: 12,
      averageResidual: 1.2,
    };
  };
  tracker._estimateReferenceHomography = (receivedCv) => {
    homographyCalls++;
    assert.equal(receivedCv.runtime, 'opencv');
    return {
      type: 'homography',
      matrix: [1, 0, 25, 0, 1, -7, 0, 0, 1],
      inverseMatrix: [1, 0, -25, 0, 1, 7, 0, 0, 1],
      scale: 1,
      rotation: 0,
      confidence: 0.95,
      inlierCount: 12,
      averageResidual: 0.2,
    };
  };

  const evaluation = tracker.createAnchorPositionEvaluation();
  const resolved = tracker.resolveAnchorPositionEvaluation({ runtime: 'opencv' }, evaluation, {
    preferObjectWideSimilarity: false,
  });
  const refreshPlan = tracker.planKeypointRefresh(
    { runtime: 'opencv' },
    {
      attachmentEvidence: evaluation.attachmentEvidence,
    },
  );

  assert.equal(evaluation.position.method, 'reference_similarity_transform');
  assert.equal(resolved.method, 'reference_homography');
  assert.deepEqual({ x: resolved.x, y: resolved.y }, { x: 141, y: 73 });
  assert.equal(refreshPlan.kind, 'reference');
  assert.equal(refreshPlan.transform.type, 'homography');
  assert.equal(localFitCalls, 1);
  assert.equal(broadFitCalls, 1);
  assert.equal(homographyCalls, 1);
});

test('current-frame refresh reuses a completed failed attachment homography', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = Array.from({ length: 12 }, (_, index) => ({
    ...createTrackedPoint(
      index,
      {
        x: 70 + (index % 4) * 26,
        y: 60 + Math.floor(index / 4) * 24,
      },
      {
        tx: 10,
        ty: 5,
        scale: 1,
        rotation: 0,
      },
    ),
    objectOwned: true,
  }));
  tracker.keypointCentroid = { x: 109, y: 84 };
  tracker.anchorOriginalPosition = { x: 116, y: 80 };
  tracker.tapOffset = { x: 7, y: -4 };
  let localFitCalls = 0;
  let broadFitCalls = 0;
  let homographyCalls = 0;
  tracker._estimateLocalReferenceTransformation = () => {
    localFitCalls++;
    return null;
  };
  tracker._estimateReferenceTransformation = () => {
    broadFitCalls++;
    return {
      tx: 10,
      ty: 5,
      scale: 1,
      rotation: 0,
      confidence: 0.6,
      inlierCount: 12,
      averageResidual: 1,
    };
  };
  tracker._estimateReferenceHomography = () => {
    homographyCalls++;
    return null;
  };

  const evaluation = tracker.createAnchorPositionEvaluation();
  tracker.resolveAnchorPositionEvaluation({}, evaluation, {
    preferObjectWideSimilarity: false,
  });
  const refreshPlan = tracker.planKeypointRefresh(
    {},
    {
      attachmentEvidence: evaluation.attachmentEvidence,
    },
  );

  assert.equal(refreshPlan.kind, 'reference');
  assert.equal(refreshPlan.transform.type, undefined);
  assert.equal(localFitCalls, 1);
  assert.equal(broadFitCalls, 1);
  assert.equal(homographyCalls, 1);
});

test('attachment and refresh independently score the same current-frame evidence', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = Array.from({ length: 12 }, (_, index) => ({
    ...createTrackedPoint(
      index,
      {
        x: 70 + (index % 4) * 26,
        y: 60 + Math.floor(index / 4) * 24,
      },
      {
        tx: 10,
        ty: 5,
        scale: 1,
        rotation: 0,
      },
    ),
    objectOwned: true,
  }));
  tracker.keypointCentroid = { x: 109, y: 84 };
  tracker.anchorOriginalPosition = { x: 116, y: 80 };
  tracker.tapOffset = { x: 7, y: -4 };
  tracker._estimateLocalReferenceTransformation = () => null;
  tracker._estimateReferenceTransformation = () => ({
    tx: 10,
    ty: 5,
    scale: 1,
    rotation: 0,
    confidence: 0.3,
    inlierCount: 10,
    averageResidual: 10,
  });
  tracker._estimateReferenceHomography = () => ({
    type: 'homography',
    matrix: [1, 0, 25, 0, 1, -7, 0, 0, 1],
    inverseMatrix: [1, 0, -25, 0, 1, 7, 0, 0, 1],
    scale: 1,
    rotation: 0,
    confidence: 0.35,
    inlierCount: 10,
    averageResidual: 4.9,
  });

  const evaluation = tracker.createAnchorPositionEvaluation();
  const attachment = tracker.resolveAnchorPositionEvaluation({}, evaluation, {
    preferObjectWideSimilarity: false,
  });
  const refreshPlan = tracker.planKeypointRefresh(
    {},
    {
      attachmentEvidence: evaluation.attachmentEvidence,
    },
  );

  assert.equal(attachment.method, 'reference_similarity_transform');
  assert.equal(refreshPlan.kind, 'reference');
  assert.equal(refreshPlan.transform.type, 'homography');
});

test('object-wide similarity recovery requires explicit preference and a deformed local fit', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = Array.from({ length: 36 }, (_, index) => ({
    ...createTrackedPoint(
      index,
      {
        x: 60 + (index % 6) * 20,
        y: 50 + Math.floor(index / 6) * 18,
      },
      {
        tx: 10,
        ty: 5,
        scale: 1,
        rotation: 0,
      },
    ),
    objectOwned: true,
  }));
  tracker.keypointCentroid = { x: 110, y: 95 };
  tracker.anchorOriginalPosition = { x: 116, y: 80 };
  tracker.tapOffset = { x: 6, y: -15 };
  tracker._estimateLocalReferenceTransformation = () => ({
    tx: 10,
    ty: 5,
    scale: 1,
    rotation: 0,
    confidence: 0.6,
    inlierCount: 18,
    averageResidual: 24,
    supportCount: 18,
    localAnchorTransform: true,
  });
  tracker._estimateReferenceTransformation = () => ({
    tx: 18,
    ty: 9,
    scale: 1,
    rotation: 0,
    confidence: 0.45,
    inlierCount: 30,
    averageResidual: 30,
  });

  const evaluation = tracker.createAnchorPositionEvaluation();
  const ordinary = tracker.resolveAnchorPositionEvaluation(null, evaluation, {
    preferObjectWideSimilarity: false,
  });
  const recovered = tracker.resolveAnchorPositionEvaluation(null, evaluation, {
    preferObjectWideSimilarity: true,
  });

  assert.deepEqual({ x: ordinary.x, y: ordinary.y }, { x: 126, y: 85 });
  assert.equal(ordinary.referenceScope, 'tap-local');
  assert.deepEqual({ x: recovered.x, y: recovered.y }, { x: 134, y: 89 });
  assert.equal(recovered.referenceScope, 'object-wide');
  assert.equal(recovered.localReferenceResidual, 24);

  const localCandidate = evaluation.attachmentEvidence.similarityCandidates.find(
    (candidate) => candidate.localAnchorTransform,
  );
  localCandidate.averageResidual = 23.99;
  const healthyLocal = tracker.resolveAnchorPositionEvaluation(null, evaluation, {
    preferObjectWideSimilarity: true,
  });

  assert.deepEqual({ x: healthyLocal.x, y: healthyLocal.y }, { x: 126, y: 85 });
  assert.equal(healthyLocal.referenceScope, 'tap-local');
});

test('attachment positioning keeps similarity fallback when homography is unavailable', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = Array.from({ length: 6 }, (_, index) => ({
    id: index,
    original: { x: 80 + index * 12, y: 90 + (index % 2) * 18 },
    current: { x: 90 + index * 12, y: 96 + (index % 2) * 18 },
    response: 1,
    status: 'active',
    objectOwnedStreak: 2,
    errorHistory: [8],
    age: 8,
    successfulTrackingStreak: 3,
    totalSuccessfulFrames: 8,
    stabilityScore: 0.35,
    isStable: false,
  }));
  tracker.keypointCentroid = { x: 110, y: 99 };
  tracker.tapOffset = { x: 6, y: -3 };
  tracker.anchorOriginalPosition = { x: 116, y: 96 };
  tracker._estimateReferenceTransformation = () => ({
    tx: 10,
    ty: 6,
    scale: 1,
    rotation: 0,
    confidence: 0.12,
    inlierCount: 4,
    averageResidual: 13,
  });

  const anchor = tracker.getAnchorPosition({ findHomography: () => null });

  assert.equal(anchor.method, 'reference_similarity_transform');
  assert.equal(anchor.x, 126);
  assert.equal(anchor.y, 102);
});

test('centroid anchor fallback reports weighted point motion without transform scale', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = [
    {
      id: 1,
      original: { x: 90, y: 90 },
      current: { x: 112, y: 98 },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      errorHistory: [1],
      age: 10,
    },
    {
      id: 2,
      original: { x: 130, y: 90 },
      current: { x: 150, y: 102 },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      errorHistory: [20],
      age: 4,
    },
    {
      id: 3,
      original: { x: 110, y: 130 },
      current: { x: 132, y: 136 },
      response: 1,
      status: 'inactive',
      errorHistory: [1],
      age: 10,
    },
  ];
  tracker.tapOffset = { x: 7, y: -5 };

  const anchor = tracker.getCentroidAnchorPosition();

  assert.equal(anchor.method, 'weighted_centroid_with_offset');
  assert.equal(anchor.inlierCount, 2);
  assert.ok(anchor.x > 119);
  assert.ok(anchor.x < 124);
  assert.ok(anchor.y > 93);
  assert.ok(anchor.y < 96);
  assert.equal(anchor.scale, undefined);
});

test('attachment positioning prefers the local tapped patch over distant curved-object motion', () => {
  const tracker = new KeypointTracker();
  const anchor = { x: 120, y: 110 };
  const localTransform = {
    tx: 18,
    ty: -8,
    scale: 1.04,
    rotation: (4 * Math.PI) / 180,
  };
  const farTransform = {
    tx: -34,
    ty: 26,
    scale: 0.82,
    rotation: (-18 * Math.PI) / 180,
  };
  const localOriginals = Array.from({ length: 10 }, (_, index) => ({
    x: 96 + (index % 5) * 12,
    y: 96 + Math.floor(index / 5) * 16,
  }));
  const farOriginals = Array.from({ length: 32 }, (_, index) => ({
    x: 215 + (index % 8) * 14,
    y: 150 + Math.floor(index / 8) * 18,
  }));

  tracker.trackedPoints = [
    ...localOriginals.map((point, index) => createTrackedPoint(index, point, localTransform)),
    ...farOriginals.map((point, index) => createTrackedPoint(100 + index, point, farTransform)),
  ];
  tracker.keypointCentroid = { x: 195, y: 150 };
  tracker.anchorOriginalPosition = anchor;
  tracker.tapOffset = {
    x: tracker.anchorOriginalPosition.x - tracker.keypointCentroid.x,
    y: tracker.anchorOriginalPosition.y - tracker.keypointCentroid.y,
  };

  const predicted = tracker.getAnchorPosition();
  const expected = transformPoint(anchor, localTransform);

  assert.equal(predicted.method, 'reference_similarity_transform');
  assert.ok(Math.hypot(predicted.x - expected.x, predicted.y - expected.y) < 1.5);
});

test('attachment positioning accepts sparse local tap support over broad object drift', () => {
  const tracker = new KeypointTracker();
  const anchor = { x: 120, y: 110 };
  const localTransform = {
    tx: 16,
    ty: -7,
    scale: 1.03,
    rotation: (3 * Math.PI) / 180,
  };
  const farTransform = {
    tx: -28,
    ty: 31,
    scale: 0.86,
    rotation: (-16 * Math.PI) / 180,
  };
  const localOriginals = Array.from({ length: 9 }, (_, index) => ({
    x: 101 + (index % 4) * 12,
    y: 98 + Math.floor(index / 4) * 15,
  }));
  const farOriginals = Array.from({ length: 36 }, (_, index) => ({
    x: 212 + (index % 9) * 13,
    y: 142 + Math.floor(index / 9) * 17,
  }));

  tracker.trackedPoints = [
    ...localOriginals.map((point, index) => createTrackedPoint(index, point, localTransform)),
    ...farOriginals.map((point, index) => createTrackedPoint(100 + index, point, farTransform)),
  ];
  tracker.keypointCentroid = { x: 203, y: 148 };
  tracker.anchorOriginalPosition = anchor;
  tracker.tapOffset = {
    x: tracker.anchorOriginalPosition.x - tracker.keypointCentroid.x,
    y: tracker.anchorOriginalPosition.y - tracker.keypointCentroid.y,
  };

  const predicted = tracker.getAnchorPosition();
  const expected = transformPoint(anchor, localTransform);

  assert.equal(predicted.method, 'reference_similarity_transform');
  assert.ok(Math.hypot(predicted.x - expected.x, predicted.y - expected.y) < 2);
});

test('outlier filtering keeps coherent rotational motion instead of assuming pure translation', () => {
  const tracker = new KeypointTracker();
  const transform = {
    tx: 12,
    ty: 9,
    scale: 1,
    rotation: (18 * Math.PI) / 180,
  };

  tracker.trackedPoints = Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    const original = {
      x: 140 + Math.cos(angle) * 60,
      y: 120 + Math.sin(angle) * 36,
    };
    return createTrackedPoint(index, original, transform);
  });

  tracker._filterOutliers();

  assert.equal(tracker.trackedPoints.filter((point) => point.status === 'active').length, 24);
});

test('initial LK tracking rejects low-error points that violate reference motion consensus', async () => {
  const tracker = new KeypointTracker();
  const cv = createSyntheticLucasKanadeCv((index) =>
    index < 9 ? { dx: 5, dy: 3, error: 1 } : { dx: 84 + index * 3, dy: -58, error: 1 },
  );
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackingAttempts = 0;
  tracker.trackedPoints = Array.from({ length: 12 }, (_, index) => {
    const point = {
      x: 80 + (index % 4) * 24,
      y: 70 + Math.floor(index / 4) * 22,
    };
    return createTrackedPoint(index, point, {
      tx: 0,
      ty: 0,
      scale: 1,
      rotation: 0,
    });
  });
  tracker.keypointCentroid = { x: 116, y: 92 };
  tracker.anchorOriginalPosition = { x: 116, y: 92 };
  tracker.tapOffset = { x: 0, y: 0 };
  const result = tracker.trackFrame(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, true);
  assert.equal(result.successRate, 0.75);
  assert.equal(tracker.trackedPoints.filter((point) => point.status === 'active').length, 9);
  assert.deepEqual(
    tracker.trackedPoints.filter((point) => point.status === 'lost').map((point) => point.id),
    [9, 10, 11],
  );
  assert.ok(tracker.trackedPoints.slice(0, 9).every((point) => point.current.x === point.original.x + 5));
});

test('Lucas-Kanade failure reports the retained landmark quorum', async () => {
  const cv = createSyntheticLucasKanadeCv(() => ({ status: 0, dx: 0, dy: 0, error: 0 }));
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackedPoints = Array.from({ length: 8 }, (_, index) =>
    createTrackedPoint(
      index,
      { x: 60 + (index % 4) * 24, y: 70 + Math.floor(index / 4) * 22 },
      { tx: 0, ty: 0, scale: 1, rotation: 0 },
    ),
  );

  const result = tracker.trackFrame(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, false);
  assert.equal(result.reason, 'Lucas-Kanade retained 0/8 points');
});

test('Lucas-Kanade exposes spatially coherent partial-occlusion flow without weakening failure', async () => {
  const cv = createSyntheticLucasKanadeCv((index) =>
    index < 10
      ? { dx: 4 + (index % 2) * 0.2, dy: -3 + (index % 3) * 0.15, error: 4 }
      : { status: 0, dx: 0, dy: 0, error: 0 },
  );
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackingAttempts = tracker.initialLeniencyFrames;
  tracker.trackedPoints = Array.from({ length: 30 }, (_, index) =>
    createTrackedPoint(
      index,
      {
        x: 50 + (index % 6) * 28,
        y: 55 + Math.floor(index / 6) * 26,
      },
      { tx: 0, ty: 0, scale: 1, rotation: 0 },
    ),
  );

  const result = tracker.trackFrame(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, false);
  assert.equal(result.successRate, 1 / 3);
  assert.equal(result.partialFlow.inlierCount, 10);
  assert.ok(result.partialFlow.averageResidual < 0.2);
});

test('Lucas-Kanade rejects an incoherent low-retention flow set', async () => {
  const cv = createSyntheticLucasKanadeCv((index) =>
    index < 10
      ? {
          dx: index % 2 === 0 ? 8 + index * 7 : -12 - index * 5,
          dy: index % 3 === 0 ? 18 + index * 4 : -16 - index * 3,
          error: 4,
        }
      : { status: 0, dx: 0, dy: 0, error: 0 },
  );
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackingAttempts = tracker.initialLeniencyFrames;
  tracker.trackedPoints = Array.from({ length: 30 }, (_, index) =>
    createTrackedPoint(
      index,
      {
        x: 50 + (index % 6) * 28,
        y: 55 + Math.floor(index / 6) * 26,
      },
      { tx: 0, ty: 0, scale: 1, rotation: 0 },
    ),
  );

  const result = tracker.trackFrame(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, false);
  assert.equal(result.partialFlow, null);
});

test('Lucas-Kanade rejects a point set below the geometric continuity quorum', async () => {
  const cv = createSyntheticLucasKanadeCv(() => ({ dx: 3, dy: -2, error: 1 }));
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackedPoints = Array.from({ length: 7 }, (_, index) =>
    createTrackedPoint(
      index,
      { x: 60 + (index % 4) * 24, y: 70 + Math.floor(index / 4) * 22 },
      { tx: 0, ty: 0, scale: 1, rotation: 0 },
    ),
  );

  const result = tracker.trackFrame(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, false);
  assert.equal(result.reason, 'Too few active points: 7 (need at least 8)');
  assert.equal(result.activePointCount, 7);
});

test('candidate Lucas-Kanade preserves temporal motion below the pose geometry quorum', async () => {
  const cv = createSyntheticLucasKanadeCv(() => ({ dx: 3, dy: -2, error: 1 }));
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackedPoints = Array.from({ length: 6 }, (_, index) =>
    createTrackedPoint(
      index,
      { x: 60 + (index % 4) * 24, y: 70 + Math.floor(index / 4) * 22 },
      { tx: 0, ty: 0, scale: 1, rotation: 0 },
    ),
  );

  const result = tracker.trackCandidate(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, true);
  assert.equal(result.activePointCount, 6);
  assert.ok(tracker.trackedPoints.every((point) => point.current.x === point.original.x + 3));
  assert.ok(tracker.trackedPoints.every((point) => point.current.y === point.original.y - 2));
});

test('Lucas-Kanade tracking reuses one native workspace across point counts and releases it', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  const workspace = tracker.lkWorkspace;
  const workspaceHandles = Object.values(workspace);

  tracker._prepareLucasKanadeWorkspace(cv, 80);
  assert.deepEqual(
    Object.values(workspace).map((mat) => [mat.rows, mat.cols]),
    [
      [80, 1],
      [80, 1],
      [80, 1],
      [80, 1],
    ],
  );

  tracker._prepareLucasKanadeWorkspace(cv, 32);
  assert.equal(tracker.lkWorkspace, workspace);
  assert.ok(Object.values(tracker.lkWorkspace).every((mat, index) => mat === workspaceHandles[index]));
  assert.deepEqual(
    Object.values(workspace).map((mat) => [mat.rows, mat.cols]),
    [
      [32, 1],
      [32, 1],
      [32, 1],
      [32, 1],
    ],
  );

  await tracker.initialize(cv);
  assert.ok(workspaceHandles.every((handle) => handle.isDeleted()));
  const replacementHandles = Object.values(tracker.lkWorkspace);

  tracker.dispose();
  assert.ok(replacementHandles.every((handle) => handle.isDeleted()));
});

test('tracker retains grayscale history by alternating two owned native frames', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  const ownedFrames = [...tracker.grayFrameSlots];

  const firstFrame = tracker.acquireGrayFrame(cv);
  firstFrame.create(120, 160, cv.CV_8UC1);
  firstFrame.data.fill(31);
  tracker._replacePreviousGray(firstFrame);
  const firstGeneration = tracker.grayFrameGeneration;

  const secondFrame = tracker.acquireGrayFrame(cv);
  secondFrame.create(120, 160, cv.CV_8UC1);
  secondFrame.data.fill(97);
  tracker._replacePreviousGray(secondFrame);

  assert.notEqual(firstFrame, secondFrame);
  assert.equal(tracker.previousGray, secondFrame);
  assert.equal(tracker.acquireGrayFrame(cv), firstFrame);
  assert.equal(tracker.grayFrameGeneration, firstGeneration + 1);
  assert.deepEqual([...firstFrame.data], new Array(firstFrame.data.length).fill(31));
  assert.ok(ownedFrames.every((frame, index) => frame === tracker.grayFrameSlots[index]));

  tracker.dispose();
  assert.ok(ownedFrames.every((frame) => frame.isDeleted()));
});

test('same-frame grayscale retention advances refresh-plan generation without another copy', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  const frame = tracker.acquireGrayFrame(cv);
  frame.create(40, 40, cv.CV_8UC1);
  tracker._replacePreviousGray(frame);
  const plan = tracker.planKeypointRefresh({});
  const generation = tracker.grayFrameGeneration;

  tracker._replacePreviousGray(frame);

  assert.equal(tracker.previousGray, frame);
  assert.equal(tracker.grayFrameGeneration, generation + 1);
  assert.throws(
    () =>
      tracker.refreshKeypoints({
        cv: {},
        plan,
        currentGray: frame,
        keypointDetector: {},
        region: {
          x: 0,
          y: 0,
          width: 40,
          height: 40,
        },
      }),
    /stale or already consumed/,
  );
  tracker.dispose();
});

test('real OpenCV Lucas-Kanade writes translated flow into the session workspace', async () => {
  const cv = await loadOpenCvForNode();
  const width = 320;
  const height = 240;
  const shift = { x: 3, y: 2 };
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  const workspaceHandles = Object.values(tracker.lkWorkspace);
  const firstFrame = tracker.acquireGrayFrame(cv);
  firstFrame.create(height, width, cv.CV_8UC1);
  let randomState = 0x5f3759df;
  for (let index = 0; index < firstFrame.data.length; index++) {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    firstFrame.data[index] = randomState >>> 24;
  }
  const keypoints = Array.from({ length: 24 }, (_, index) => ({
    pt: {
      x: 55 + (index % 6) * 38,
      y: 55 + Math.floor(index / 6) * 38,
    },
    response: 1 - index / 100,
  }));
  tracker.initializeTracking(cv, keypoints, firstFrame, {
    tapPosition: { x: 150, y: 110 },
  });
  const nextFrame = tracker.acquireGrayFrame(cv);
  nextFrame.create(height, width, cv.CV_8UC1);
  for (let y = shift.y; y < height; y++) {
    for (let x = shift.x; x < width; x++) {
      nextFrame.data[y * width + x] = firstFrame.data[(y - shift.y) * width + x - shift.x];
    }
  }

  const result = tracker.trackFrame(cv, nextFrame);

  assert.equal(result.success, true);
  assert.ok(result.successRate > 0.9);
  assert.ok(Object.values(tracker.lkWorkspace).every((mat, index) => mat === workspaceHandles[index]));
  const activePoints = tracker.trackedPoints.filter((point) => point.status === 'active');
  assert.ok(
    activePoints.every(
      (point) =>
        Math.hypot(
          point.current.x - point.original.x - shift.x,
          point.current.y - point.original.y - shift.y,
        ) < 0.5,
    ),
  );

  tracker.dispose();
  assert.ok(workspaceHandles.every((handle) => handle.isDeleted()));
});

test('steady-state Lucas-Kanade tracking skips unconsumed anchor diagnostics', async () => {
  const cv = createSyntheticLucasKanadeCv(() => ({ dx: 3, dy: -2, error: 1 }));
  const tracker = new KeypointTracker();
  await tracker.initialize(cv);
  tracker.previousGray = tracker.acquireGrayFrame(cv);
  tracker.trackingAttempts = tracker.initialLeniencyFrames;
  tracker.trackedPoints = Array.from({ length: 12 }, (_, index) => {
    const original = {
      x: 70 + (index % 4) * 28,
      y: 65 + Math.floor(index / 4) * 26,
    };
    return {
      ...createTrackedPoint(index, original, {
        tx: 0,
        ty: 0,
        scale: 1,
        rotation: 0,
      }),
      errorHistory: Array.from({ length: 10 }, (_errorEntry, errorIndex) => errorIndex + 1),
    };
  });
  tracker.keypointCentroid = { x: 112, y: 91 };
  tracker.anchorOriginalPosition = { x: 112, y: 91 };
  tracker.tapOffset = { x: 0, y: 0 };
  const errorHistories = tracker.trackedPoints.map((point) => point.errorHistory);
  let anchorPositionCalls = 0;
  tracker.getAnchorPosition = () => {
    anchorPositionCalls++;
    return { x: 112, y: 91 };
  };

  const result = tracker.trackFrame(cv, tracker.acquireGrayFrame(cv));

  assert.equal(result.success, true);
  assert.equal(anchorPositionCalls, 0);
  assert.equal('statistics' in result, false);
  assert.ok(tracker.trackedPoints.every((point, index) => point.errorHistory === errorHistories[index]));
  assert.ok(tracker.trackedPoints.every((point) => point.errorHistory.length === 10));
  assert.deepEqual(tracker.trackedPoints[0].errorHistory, [2, 3, 4, 5, 6, 7, 8, 9, 10, 1]);
});

test('keypoint refresh preserves the original reference frame for homography pose', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: 18,
    ty: -11,
    scale: 1.1,
    rotation: (22 * Math.PI) / 180,
  };
  const originals = Array.from({ length: 16 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return {
      x: 80 + column * 24,
      y: 70 + row * 22,
    };
  });
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.keypointCentroid = { x: 120, y: 110 };
  tracker.tapOffset = { x: 10, y: -8 };
  tracker.anchorOriginalPosition = { x: 130, y: 102 };

  const currentGray = {
    cols: 320,
    rows: 240,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: originals.map((point) => ({ pt: transformPoint(point, transform), response: 1 })),
    }),
  };

  const refreshed = executeKeypointRefresh(tracker, {}, currentGray, detector, {
    x: 0,
    y: 0,
    width: 220,
    height: 180,
  });

  assert.equal(refreshed.success, true);
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 130, y: 102 });
  assert.ok(Math.abs(tracker.trackedPoints[0].original.x - originals[0].x) < 0.5);
  assert.ok(Math.abs(tracker.trackedPoints[0].original.y - originals[0].y) < 0.5);
});

test('keypoint refresh expands the landmark map instead of replacing tracked points', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };
  tracker.trackingAttempts = 9;

  const transform = {
    tx: -9,
    ty: 14,
    scale: 1.04,
    rotation: (-16 * Math.PI) / 180,
  };
  const originals = Array.from({ length: 16 }, (_, index) => ({
    x: 80 + (index % 4) * 24,
    y: 72 + Math.floor(index / 4) * 22,
  }));
  const newOriginals = Array.from({ length: 12 }, (_, index) => ({
    x: 190 + (index % 4) * 18,
    y: 74 + Math.floor(index / 4) * 20,
  }));
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.nextPointId = originals.length;
  tracker.keypointCentroid = { x: 116, y: 105 };
  tracker.anchorOriginalPosition = { x: 124, y: 101 };
  tracker.tapOffset = { x: 8, y: -4 };

  const currentGray = {
    cols: 360,
    rows: 260,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [
        ...originals.map((point) => ({ pt: transformPoint(point, transform), response: 0.8 })),
        ...newOriginals.map((point) => ({ pt: transformPoint(point, transform), response: 1.0 })),
      ],
    }),
  };

  const refreshed = executeKeypointRefresh(tracker, {}, currentGray, detector, {
    x: 0,
    y: 0,
    width: 260,
    height: 180,
  });

  assert.equal(refreshed.success, true);
  assert.equal(tracker.trackedPoints.filter((point) => point.id < originals.length).length, originals.length);
  assert.ok(
    Math.abs(tracker.trackedPoints.find((point) => point.id === 0).original.x - originals[0].x) < 0.5,
  );
  assert.ok(
    Math.abs(tracker.trackedPoints.find((point) => point.id === 0).original.y - originals[0].y) < 0.5,
  );
  assert.ok(tracker.trackedPoints.length > originals.length);
  assert.ok(tracker.trackedPoints.some((point) => point.original.x > 175));
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 124, y: 101 });
  assert.equal(tracker.trackingAttempts, 0);
});

test('keypoint refresh spends limited map capacity on under-covered mask cells', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const activeOriginals = Array.from({ length: 12 }, (_, index) => ({
    x: 5 + (index % 4) * 10,
    y: 5 + Math.floor(index / 4) * 10,
  }));
  tracker.trackedPoints = [
    ...activeOriginals.map((point, index) =>
      createTrackedPoint(index, point, {
        tx: 0,
        ty: 0,
        scale: 1,
        rotation: 0,
      }),
    ),
    ...Array.from({ length: 80 }, (_, index) => ({
      ...createTrackedPoint(
        100 + index,
        {
          x: 220 + (index % 8) * 9,
          y: 120 + Math.floor(index / 8) * 9,
        },
        {
          tx: 0,
          ty: 0,
          scale: 1,
          rotation: 0,
        },
      ),
      status: 'lost',
    })),
  ];
  tracker.nextPointId = 200;
  tracker.keypointCentroid = { x: 20, y: 15 };
  tracker.anchorOriginalPosition = { x: 20, y: 15 };
  tracker.tapOffset = { x: 0, y: 0 };

  const maskData = new Uint8Array(180 * 120);
  for (let y = 0; y < 42; y++) {
    for (let x = 0; x < 126; x++) {
      maskData[y * 180 + x] = 255;
    }
  }
  const objectSupportMask = {
    width: 180,
    height: 120,
    data: maskData,
    bbox: { x: 0, y: 0, width: 126, height: 42 },
  };
  const denseCandidates = Array.from({ length: 12 }, (_, index) => ({
    x: 6 + (index % 6) * 6,
    y: 35 + Math.floor(index / 6) * 4,
  }));
  const uncoveredCandidates = [
    { x: 50, y: 8 },
    { x: 92, y: 8 },
    { x: 58, y: 22 },
    { x: 100, y: 22 },
    { x: 68, y: 34 },
    { x: 110, y: 34 },
  ];
  const currentGray = {
    cols: 180,
    rows: 120,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [...denseCandidates, ...uncoveredCandidates].map((point) => ({ pt: point, response: 1 })),
    }),
  };

  const refreshed = executeKeypointRefresh(
    tracker,
    {},
    currentGray,
    detector,
    {
      x: 0,
      y: 0,
      width: 126,
      height: 42,
    },
    objectSupportMask,
    { candidateOrder: 'mask-coverage' },
  );
  const added = tracker.trackedPoints.filter((point) => point.id >= 200);

  assert.equal(refreshed.success, true);
  assert.equal(added.length, 4);
  assert.ok(added.every((point) => point.current.x >= 42));
  assert.equal(refreshed.coverageOccupiedBefore, 1);
  assert.equal(refreshed.coverageOccupiedAfter, 3);
  assert.equal(refreshed.coverageCellCount, 3);
});

test('keypoint refresh rejects a weak homography when similarity keeps the reference frame coherent', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: -7,
    ty: 11,
    scale: 1.07,
    rotation: (14 * Math.PI) / 180,
  };
  const originals = Array.from({ length: 16 }, (_, index) => ({
    x: 78 + (index % 4) * 24,
    y: 68 + Math.floor(index / 4) * 22,
  }));
  const newOriginals = Array.from({ length: 8 }, (_, index) => ({
    x: 194 + (index % 4) * 18,
    y: 80 + Math.floor(index / 4) * 20,
  }));
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.nextPointId = originals.length;
  tracker.keypointCentroid = { x: 114, y: 101 };
  tracker.anchorOriginalPosition = { x: 122, y: 98 };
  tracker.tapOffset = { x: 8, y: -3 };
  tracker._estimateReferenceHomography = () => ({
    type: 'homography',
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    inverseMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: 1,
    rotation: 0,
    confidence: 0.08,
    inlierCount: 9,
    averageResidual: 8.4,
  });

  const currentGray = {
    cols: 360,
    rows: 260,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [
        ...originals.map((point) => ({ pt: transformPoint(point, transform), response: 0.8 })),
        ...newOriginals.map((point) => ({ pt: transformPoint(point, transform), response: 1.0 })),
      ],
    }),
  };

  const refreshed = executeKeypointRefresh(tracker, {}, currentGray, detector, {
    x: 0,
    y: 0,
    width: 300,
    height: 200,
  });

  const added = tracker.trackedPoints.filter((point) => point.id >= originals.length);

  assert.equal(refreshed.success, true);
  assert.ok(added.length > 0);
  assert.ok(
    added.some(
      (point) =>
        Math.abs(point.original.x - newOriginals[0].x) < 0.6 &&
        Math.abs(point.original.y - newOriginals[0].y) < 0.6,
    ),
  );
});

test('keypoint refresh keeps viable broad reference transform over local support', () => {
  const tracker = new KeypointTracker();
  const activePoints = Array.from({ length: 17 }, (_, index) => ({
    original: { x: 80 + index * 7, y: 90 + (index % 5) * 11 },
    current: { x: 82 + index * 7, y: 92 + (index % 5) * 11 },
  }));
  const broadTransform = {
    tx: -4,
    ty: 9,
    scale: 0.97,
    rotation: 0.04,
    confidence: 0.38,
    inlierCount: 11,
    averageResidual: 8.8,
  };

  tracker._estimateReferenceHomography = () => null;
  tracker._estimateLocalReferenceTransformation = () => ({
    tx: 7,
    ty: -5,
    scale: 1.06,
    rotation: 0.03,
    confidence: 0.74,
    inlierCount: 8,
    supportCount: 10,
    averageResidual: 1.2,
    localAnchorTransform: true,
  });
  tracker._estimateReferenceTransformation = () => broadTransform;

  const evidence = tracker._createReferenceTransformationEvidence(activePoints);
  const selected = tracker._selectRefreshReferenceTransformation({}, evidence);

  assert.equal(selected, broadTransform);
});

test('keypoint refresh uses local anchor support when global curved geometry collapses', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const localTransform = {
    tx: 12,
    ty: -6,
    scale: 1.03,
    rotation: (9 * Math.PI) / 180,
  };
  const localOriginals = Array.from({ length: 12 }, (_, index) => ({
    x: 112 + (index % 4) * 10,
    y: 96 + Math.floor(index / 4) * 10,
  }));
  const farOriginals = Array.from({ length: 22 }, (_, index) => ({
    x: 230 + (index % 6) * 12,
    y: 34 + Math.floor(index / 6) * 17,
  }));
  const newOriginals = Array.from({ length: 10 }, (_, index) => ({
    x: 118 + (index % 5) * 9,
    y: 134 + Math.floor(index / 5) * 10,
  }));
  tracker.trackedPoints = [
    ...localOriginals.map((point, index) => createTrackedPoint(index, point, localTransform)),
    ...farOriginals.map((point, index) => ({
      ...createTrackedPoint(100 + index, point, localTransform),
      current: {
        x: 40 + (index % 5) * 15,
        y: 170 + Math.floor(index / 5) * 13,
      },
      errorHistory: [24],
    })),
  ];
  tracker.nextPointId = 200;
  tracker.keypointCentroid = { x: 127, y: 106 };
  tracker.anchorOriginalPosition = { x: 128, y: 108 };
  tracker.tapOffset = { x: 1, y: 2 };

  const currentGray = {
    cols: 360,
    rows: 260,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [
        ...localOriginals.map((point) => ({ pt: transformPoint(point, localTransform), response: 0.8 })),
        ...newOriginals.map((point) => ({ pt: transformPoint(point, localTransform), response: 1.0 })),
      ],
    }),
  };

  const refreshed = executeKeypointRefresh(
    tracker,
    {},
    currentGray,
    detector,
    {
      x: 80,
      y: 60,
      width: 120,
      height: 130,
    },
    null,
    {
      minNewKeypoints: 10,
    },
  );

  const added = tracker.trackedPoints.filter((point) => point.id >= 200);

  assert.equal(refreshed.success, true);
  assert.ok(added.length > 0);
  assert.ok(
    added.some(
      (point) =>
        Math.abs(point.original.x - newOriginals[0].x) < 0.8 &&
        Math.abs(point.original.y - newOriginals[0].y) < 0.8,
    ),
  );
});

test('inactive cleanup preserves stable hidden landmarks and retires weak stale points', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = [
    {
      id: 1,
      original: { x: 10, y: 10 },
      current: { x: 12, y: 11 },
      status: 'active',
      inactiveAge: 0,
      isStable: false,
      stabilityScore: 0.3,
      totalSuccessfulFrames: 5,
    },
    {
      id: 2,
      original: { x: 40, y: 10 },
      current: { x: 42, y: 11 },
      status: 'lost',
      inactiveAge: 60,
      isStable: true,
      stabilityScore: 0.85,
      totalSuccessfulFrames: 90,
    },
    {
      id: 3,
      original: { x: 70, y: 10 },
      current: { x: 72, y: 11 },
      status: 'lost',
      inactiveAge: 60,
      isStable: false,
      stabilityScore: 0.1,
      totalSuccessfulFrames: 2,
    },
  ];

  tracker._cleanupInactiveKeypoints();

  assert.deepEqual(
    tracker.trackedPoints.map((point) => point.id),
    [1, 2],
  );
  assert.equal(tracker.trackedPoints.find((point) => point.id === 2).inactiveAge, 61);
});

test('pose correspondences prefer the local planar patch around the tapped anchor', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = [
    ...Array.from({ length: 16 }, (_, index) => ({
      id: index,
      original: {
        x: 82 + (index % 4) * 12,
        y: 82 + Math.floor(index / 4) * 12,
      },
      current: {
        x: 92 + (index % 4) * 12,
        y: 88 + Math.floor(index / 4) * 12,
      },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
    })),
    ...Array.from({ length: 16 }, (_, index) => ({
      id: 100 + index,
      original: {
        x: 220 + (index % 4) * 18,
        y: 190 + Math.floor(index / 4) * 18,
      },
      current: {
        x: 210 + (index % 4) * 8,
        y: 194 + Math.floor(index / 4) * 22,
      },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
    })),
  ];

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: 36,
    minCount: 8,
    maxCount: 12,
  });

  assert.equal(correspondences.length, 12);
  assert.ok(correspondences.every((correspondence) => correspondence.prev.x < 140));
  assert.ok(correspondences.every((correspondence) => correspondence.prev.y < 140));
});

test('uncapped local pose support preserves radial order for deterministic robust sampling', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = Array.from({ length: 10 }, (_, index) => ({
    id: index,
    original: { x: 104 + index * 4, y: 100 },
    current: { x: 114 + index * 4, y: 106 },
    response: 0.5 + index * 0.05,
    status: 'active',
    objectOwnedStreak: 2,
    age: 3 + index * 5,
    totalSuccessfulFrames: 3 + index * 6,
    observations: 3 + index * 6,
    errorHistory: [20 - index * 2],
    stabilityScore: 0.05 + index * 0.09,
    objectOwned: true,
  }));

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: 70,
    minCount: 8,
    maxCount: 12,
  });

  assert.deepEqual(
    correspondences.map((correspondence) => correspondence.id),
    Array.from({ length: 10 }, (_, index) => index),
  );
});

test('local pose correspondences prefer durable support over closer weak landmarks', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = [
    ...Array.from({ length: 18 }, (_, index) => ({
      id: index,
      original: {
        x: 92 + (index % 6) * 3,
        y: 94 + Math.floor(index / 6) * 3,
      },
      current: {
        x: 118 + (index % 6) * 3,
        y: 89 + Math.floor(index / 6) * 3,
      },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 3,
      totalSuccessfulFrames: 3,
      observations: 3,
      errorHistory: [19, 21, 20],
      stabilityScore: 0.05,
      objectOwned: true,
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      id: 100 + index,
      original: {
        x: 55 + (index % 4) * 30,
        y: 70 + Math.floor(index / 4) * 30,
      },
      current: {
        x: 65 + (index % 4) * 30,
        y: 76 + Math.floor(index / 4) * 30,
      },
      response: 0.7,
      status: 'active',
      objectOwnedStreak: 2,
      age: 45,
      totalSuccessfulFrames: 60,
      observations: 60,
      errorHistory: [1, 1.2, 0.9],
      stabilityScore: 0.9,
      objectOwned: true,
    })),
  ];

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: 70,
    minCount: 8,
    maxCount: 12,
  });

  assert.deepEqual(
    correspondences.map((correspondence) => correspondence.id).sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, index) => 100 + index),
  );
  assert.ok(
    Math.max(...correspondences.map((correspondence) => correspondence.prev.x)) -
      Math.min(...correspondences.map((correspondence) => correspondence.prev.x)) >=
      80,
  );
  assert.ok(
    Math.max(...correspondences.map((correspondence) => correspondence.prev.y)) -
      Math.min(...correspondences.map((correspondence) => correspondence.prev.y)) >=
      50,
  );
  const radialDistances = correspondences.map((correspondence) =>
    Math.hypot(
      correspondence.prev.x - tracker.anchorOriginalPosition.x,
      correspondence.prev.y - tracker.anchorOriginalPosition.y,
    ),
  );
  assert.deepEqual(
    radialDistances,
    [...radialDistances].sort((left, right) => left - right),
  );
});

test('capped pose support preserves radial geometry when quality has no distinct tier', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.getLandmarkQuality = (point) => point.quality;
  tracker.trackedPoints = Array.from({ length: 24 }, (_, index) => ({
    id: index,
    original: { x: 104 + index * 2, y: 100 },
    current: { x: 114 + index * 2, y: 106 },
    response: 0.7,
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 2,
    quality: index < 20 ? 0.7 : 0.48,
  }));

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: 70,
    minCount: 8,
    maxCount: 18,
  });

  assert.deepEqual(
    correspondences.map((correspondence) => correspondence.id),
    Array.from({ length: 18 }, (_, index) => index),
  );
});

test('local reference transform caps support with durable landmarks across the anchor patch', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  const weakPoints = Array.from({ length: 18 }, (_, index) => ({
    id: index,
    original: {
      x: 92 + (index % 6) * 3,
      y: 94 + Math.floor(index / 6) * 3,
    },
    current: {
      x: 118 + (index % 6) * 3,
      y: 89 + Math.floor(index / 6) * 3,
    },
    response: 1,
    status: 'active',
    objectOwnedStreak: 2,
    age: 3,
    totalSuccessfulFrames: 3,
    observations: 3,
    errorHistory: [19, 21, 20],
    stabilityScore: 0.05,
    objectOwned: true,
  }));
  const durablePoints = Array.from({ length: 12 }, (_, index) => ({
    id: 100 + index,
    original: {
      x: 55 + (index % 4) * 30,
      y: 70 + Math.floor(index / 4) * 30,
    },
    current: {
      x: 65 + (index % 4) * 30,
      y: 76 + Math.floor(index / 4) * 30,
    },
    response: 0.7,
    status: 'active',
    objectOwnedStreak: 2,
    age: 45,
    totalSuccessfulFrames: 60,
    observations: 60,
    errorHistory: [1, 1.2, 0.9],
    stabilityScore: 0.9,
    objectOwned: true,
  }));
  let selectedIds = [];
  const fitSimilarityTransform = tracker._fitSimilarityTransform.bind(tracker);
  tracker._fitSimilarityTransform = (selected) => {
    selectedIds = selected.map((point) => point.id);
    return fitSimilarityTransform(selected);
  };

  const transform = tracker._estimateLocalReferenceTransformation([...weakPoints, ...durablePoints]);

  assert.equal(transform.supportCount, 12);
  assert.deepEqual(
    selectedIds.sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, index) => 100 + index),
  );
});

test('pose correspondences exclude active landmarks already classified as background', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: index,
      original: {
        x: 82 + (index % 4) * 12,
        y: 82 + Math.floor(index / 4) * 12,
      },
      current: {
        x: 92 + (index % 4) * 12,
        y: 88 + Math.floor(index / 4) * 12,
      },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
      objectOwned: true,
    })),
    ...Array.from({ length: 18 }, (_, index) => ({
      id: 100 + index,
      original: {
        x: 160 + (index % 6) * 18,
        y: 150 + Math.floor(index / 6) * 18,
      },
      current: {
        x: 168 + (index % 6) * 18,
        y: 156 + Math.floor(index / 6) * 18,
      },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
      objectOwned: false,
    })),
  ];

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: Infinity,
    minCount: 8,
    maxCount: 30,
  });

  assert.equal(correspondences.length, 12);
  assert.ok(correspondences.every((correspondence) => correspondence.prev.x < 140));
});

test('broad pose correspondences prefer durable object-owned landmarks over fresh weak points', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = [
    ...Array.from({ length: 18 }, (_, index) => ({
      id: index,
      original: {
        x: 88 + (index % 6) * 6,
        y: 88 + Math.floor(index / 6) * 6,
      },
      current: {
        x: 91 + (index % 6) * 6,
        y: 91 + Math.floor(index / 6) * 6,
      },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 1,
      totalSuccessfulFrames: 1,
      observations: 1,
      errorHistory: [18],
      stabilityScore: 0.08,
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      id: 100 + index,
      original: {
        x: 172 + (index % 4) * 12,
        y: 154 + Math.floor(index / 4) * 12,
      },
      current: {
        x: 180 + (index % 4) * 12,
        y: 159 + Math.floor(index / 4) * 12,
      },
      response: 0.7,
      status: 'active',
      objectOwnedStreak: 2,
      age: 34,
      totalSuccessfulFrames: 52,
      observations: 52,
      errorHistory: [1.2, 1.4, 1.1],
      stabilityScore: 0.82,
      objectOwned: true,
    })),
  ];

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: Infinity,
    minCount: 8,
    maxCount: 12,
  });

  assert.equal(correspondences.length, 12);
  assert.ok(correspondences.every((correspondence) => correspondence.id >= 100));
  assert.ok(correspondences.every((correspondence) => correspondence.landmarkQuality >= 0.7));
});

test('landmark pruning preserves mature object-owned landmarks over fresh active points', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = [
    ...Array.from({ length: 14 }, (_, index) => ({
      id: index,
      original: { x: 30 + index * 5, y: 40 },
      current: { x: 32 + index * 5, y: 42 },
      response: 1,
      status: 'active',
      objectOwnedStreak: 2,
      age: 1,
      totalSuccessfulFrames: 1,
      observations: 1,
      errorHistory: [16],
      stabilityScore: 0.08,
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: 100 + index,
      original: { x: 120 + index * 6, y: 110 },
      current: { x: 126 + index * 6, y: 113 },
      response: 0.65,
      status: 'lost',
      objectOwnedStreak: 2,
      inactiveAge: 12,
      age: 60,
      totalSuccessfulFrames: 70,
      observations: 70,
      errorHistory: [1.4, 1.2, 1.5],
      stabilityScore: 0.86,
      isStable: true,
      objectOwned: true,
    })),
  ];

  tracker._pruneLandmarkMap(10);

  assert.deepEqual(
    tracker.trackedPoints.map((point) => point.id),
    Array.from({ length: 10 }, (_, index) => 100 + index),
  );
});

test('keypoint refresh rejects textured background candidates outside the object mask', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: 10,
    ty: 8,
    scale: 1,
    rotation: 0,
  };
  const originals = Array.from({ length: 12 }, (_, index) => ({
    x: 84 + (index % 4) * 12,
    y: 86 + Math.floor(index / 4) * 12,
  }));
  const objectCandidates = Array.from({ length: 10 }, (_, index) => ({
    x: 90 + (index % 5) * 9,
    y: 92 + Math.floor(index / 5) * 12,
  }));
  const backgroundCandidates = Array.from({ length: 24 }, (_, index) => ({
    x: 190 + (index % 6) * 12,
    y: 42 + Math.floor(index / 6) * 14,
  }));
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.trackedPoints.forEach((point) => {
    point.objectOwned = true;
  });
  tracker.nextPointId = originals.length;
  tracker.keypointCentroid = { x: 102, y: 98 };
  tracker.anchorOriginalPosition = { x: 102, y: 98 };
  tracker.tapOffset = { x: 0, y: 0 };

  const maskData = new Uint8Array(320 * 240);
  for (let y = 78; y <= 136; y++) {
    for (let x = 78; x <= 156; x++) {
      maskData[y * 320 + x] = 255;
    }
  }
  const objectSupportMask = {
    width: 320,
    height: 240,
    data: maskData,
  };
  const currentGray = {
    cols: 320,
    rows: 240,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [
        ...backgroundCandidates.map((point) => ({ pt: point, response: 1.0 })),
        ...objectCandidates.map((point) => ({ pt: transformPoint(point, transform), response: 0.8 })),
      ],
    }),
  };

  const refreshed = executeKeypointRefresh(
    tracker,
    {},
    currentGray,
    detector,
    {
      x: 30,
      y: 20,
      width: 260,
      height: 180,
    },
    objectSupportMask,
    {
      admission: 'recovery-probation',
    },
  );

  assert.equal(refreshed.success, true);
  assert.ok(tracker.trackedPoints.length > originals.length);
  assert.equal(refreshed.rejectedByMask, backgroundCandidates.length);
  assert.ok(tracker.trackedPoints.every((point) => point.objectOwned !== false));
  assert.ok(tracker.trackedPoints.every((point) => point.current.x < 170));

  const refreshedPoints = tracker.trackedPoints.filter((point) => point.id >= originals.length);
  assert.ok(refreshedPoints.length > 0);
  assert.ok(refreshedPoints.every((point) => point.objectOwnedStreak === 0));
  assert.ok(tracker.getCorrespondences().every((point) => point.id < originals.length));

  const firstObservation = tracker.updateObjectOwnership(objectSupportMask);
  assert.equal(firstObservation.promoted, 0);
  assert.ok(tracker.getCorrespondences().every((point) => point.id < originals.length));

  const secondObservation = tracker.updateObjectOwnership(objectSupportMask);
  assert.equal(secondObservation.promoted, refreshedPoints.length);
  assert.ok(tracker.getCorrespondences().some((point) => point.id >= originals.length));
});

test('recovery landmarks join tracking after two support observations and mapping after four', () => {
  const tracker = new KeypointTracker();
  const mask = {
    width: 80,
    height: 60,
    data: new Uint8Array(80 * 60).fill(255),
  };
  tracker.trackedPoints = [
    {
      id: 1,
      original: { x: 30, y: 24 },
      current: { x: 32, y: 26 },
      response: 1,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 0,
      recoveryOwnershipProbation: true,
      outsideObjectFrames: 0,
      age: 2,
      totalSuccessfulFrames: 2,
      errorHistory: [1],
      stabilityScore: 0.5,
    },
  ];

  const firstObservation = tracker.updateObjectOwnership(mask);
  assert.equal(firstObservation.promoted, 0);
  assert.equal(isReconstructionEligibleLandmark(tracker.trackedPoints[0]), false);
  const secondObservation = tracker.updateObjectOwnership(mask);
  assert.equal(secondObservation.promoted, 1);
  assert.equal(isReconstructionEligibleLandmark(tracker.trackedPoints[0]), false);
  const thirdObservation = tracker.updateObjectOwnership(mask);
  assert.equal(thirdObservation.promoted, 0);
  assert.equal(isReconstructionEligibleLandmark(tracker.trackedPoints[0]), false);
  const fourthObservation = tracker.updateObjectOwnership(mask);
  assert.equal(fourthObservation.promoted, 0);
  assert.equal(isReconstructionEligibleLandmark(tracker.trackedPoints[0]), true);
});

test('keypoint refresh execution requires a frame-local reference plan', () => {
  const tracker = new KeypointTracker();
  const currentGray = {
    cols: 40,
    rows: 40,
    empty: () => false,
  };

  assert.throws(
    () =>
      tracker.refreshKeypoints({
        cv: {},
        plan: null,
        currentGray,
        keypointDetector: {},
        region: {
          x: 0,
          y: 0,
          width: 40,
          height: 40,
        },
      }),
    /frame-local reference plan/,
  );
});

test('object pose rejects zero and non-finite support limits instead of defaulting them', () => {
  const tracker = new KeypointTracker();

  assert.throws(() => tracker.getObjectPose({ minCount: 0 }), /minCount must be a positive integer/);
  assert.throws(() => tracker.getObjectPose({ maxCount: 0 }), /maxCount must be an integer/);
  assert.throws(
    () => tracker.getObjectPose({ maxReferenceDistance: Number.NaN }),
    /maxReferenceDistance must be positive/,
  );
});

test('keypoint refresh plans are owned by one tracker frame and consumed once', () => {
  const tracker = new KeypointTracker();
  const previousGray = { delete() {} };
  const currentGray = {
    cols: 40,
    rows: 40,
    empty: () => false,
    delete() {},
  };
  tracker.grayFrameSlots = [previousGray, currentGray];
  tracker.previousGray = previousGray;
  tracker.grayFrameGeneration = 1;
  const detector = {
    extractKeypoints: () => ({
      keypoints: [],
      gfttCallCount: 1,
      gfttPixelCount: 1600,
      gfttPreparationCount: 1,
    }),
  };
  const region = { x: 0, y: 0, width: 40, height: 40 };
  const plan = tracker.planKeypointRefresh({});

  const refreshRequest = { cv: {}, plan, currentGray, keypointDetector: detector, region };
  tracker.refreshKeypoints(refreshRequest);

  assert.throws(() => tracker.refreshKeypoints(refreshRequest), /stale or already consumed/);

  const stalePlan = tracker.planKeypointRefresh({});
  tracker._replacePreviousGray(currentGray);
  assert.throws(
    () =>
      tracker.refreshKeypoints({
        cv: {},
        plan: stalePlan,
        currentGray,
        keypointDetector: detector,
        region,
      }),
    /stale or already consumed/,
  );
});

test('keypoint refresh planning exposes blocked reference feasibility without tracker mutation', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  const previousGray = { delete() {} };
  tracker.previousGray = previousGray;
  tracker.trackedPoints = [
    createTrackedPoint(0, { x: 80, y: 80 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
    createTrackedPoint(1, { x: 92, y: 82 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
  ];
  const trackedPointsBefore = structuredClone(tracker.trackedPoints);

  const plan = tracker.planKeypointRefresh({});

  assert.deepEqual(plan, {
    kind: 'no-reference',
    activeCount: 2,
    total: 2,
  });
  assert.equal(tracker.previousGray, previousGray);
  assert.deepEqual(tracker.trackedPoints, trackedPointsBefore);
});

test('blocked refresh preserves candidate failure precedence after real adaptive GFTT', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  const previousGray = { delete() {} };
  tracker.previousGray = previousGray;
  tracker.trackedPoints = [
    createTrackedPoint(0, { x: 80, y: 80 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
    createTrackedPoint(1, { x: 92, y: 82 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
  ];
  const trackedPointsBefore = structuredClone(tracker.trackedPoints);
  const currentGray = cv.Mat.zeros(180, 220, cv.CV_8UC1);
  cv.rectangle(currentGray, new cv.Point(70, 60), new cv.Point(130, 120), new cv.Scalar(255), -1);
  const detector = new KeypointDetector();
  await detector.initialize(cv);
  const plan = tracker.planKeypointRefresh(cv);

  try {
    const outcome = tracker.refreshKeypoints({
      cv,
      plan,
      currentGray,
      keypointDetector: detector,
      region: {
        x: 0,
        y: 0,
        width: 180,
        height: 140,
      },
      adaptive: true,
      minNewKeypoints: 8,
    });

    assert.equal(plan.kind, 'no-reference');
    assert.equal(outcome.success, false);
    assert.equal(outcome.reason, 'insufficient-candidates');
    assert.equal(outcome.gfttCallCount, 3);
    assert.equal(outcome.gfttPixelCount, 3 * 180 * 140);
    assert.equal(outcome.gfttPreparationCount, 1);
    assert.ok(outcome.candidateCount > 0 && outcome.candidateCount < 8);
    assert.equal(outcome.active, 2);
    assert.equal(tracker.previousGray, previousGray);
    assert.deepEqual(tracker.trackedPoints, trackedPointsBefore);
  } finally {
    currentGray.delete();
  }
});

test('recovery prior cannot create unverified landmarks when tracked reference geometry collapses', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };
  tracker.trackedPoints = [
    createTrackedPoint(0, { x: 80, y: 80 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
    createTrackedPoint(1, { x: 92, y: 82 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
  ];
  tracker.nextPointId = 2;
  tracker.keypointCentroid = { x: 86, y: 81 };
  tracker.anchorOriginalPosition = { x: 86, y: 81 };
  tracker.tapOffset = { x: 0, y: 0 };

  const recoveryReferenceTransform = {
    tx: 24,
    ty: -13,
    scale: 1.08,
    rotation: 0.14,
  };
  const referenceCandidates = Array.from({ length: 10 }, (_, index) => ({
    x: 70 + (index % 5) * 16,
    y: 68 + Math.floor(index / 5) * 22,
  }));
  const currentGray = {
    cols: 260,
    rows: 200,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: referenceCandidates.map((point) => ({
        pt: transformPoint(point, recoveryReferenceTransform),
        response: 1,
      })),
    }),
  };

  const refreshed = executeKeypointRefresh(
    tracker,
    {},
    currentGray,
    detector,
    {
      x: 0,
      y: 0,
      width: 220,
      height: 170,
    },
    null,
    {
      minNewKeypoints: 8,
      recoveryReferenceTransform,
    },
  );

  assert.equal(refreshed.success, false);
  assert.equal(refreshed.referenceTransformSource, 'recovery-prior');
  assert.equal(refreshed.reason, 'no-recoverable-landmarks');
  assert.equal(tracker.trackedPoints.length, 2);
  assert.equal(refreshed.recovered, 0);
});

test('recovery-prior refresh reactivates matching map landmarks instead of discarding duplicates', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };
  const recoveryReferenceTransform = {
    tx: 18,
    ty: -9,
    scale: 1.04,
    rotation: 0.1,
  };
  const referenceCandidates = Array.from({ length: 12 }, (_, index) => ({
    x: 72 + (index % 4) * 19,
    y: 66 + Math.floor(index / 4) * 20,
  }));
  tracker.trackedPoints = referenceCandidates.map((point, index) => ({
    ...createTrackedPoint(index, point, recoveryReferenceTransform),
    status: index < 2 ? 'active' : 'lost',
    inactiveAge: index < 2 ? 0 : 8,
    recentDropout: index >= 2,
  }));
  tracker.nextPointId = tracker.trackedPoints.length;
  tracker.keypointCentroid = { x: 100, y: 86 };
  tracker.anchorOriginalPosition = { x: 100, y: 86 };
  tracker.tapOffset = { x: 0, y: 0 };

  const currentGray = {
    cols: 260,
    rows: 200,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: referenceCandidates.map((point) => ({
        pt: transformPoint(point, recoveryReferenceTransform),
        response: 1,
      })),
    }),
  };

  const refreshed = executeKeypointRefresh(
    tracker,
    {},
    currentGray,
    detector,
    {
      x: 0,
      y: 0,
      width: 220,
      height: 170,
    },
    null,
    {
      minNewKeypoints: 8,
      recoveryReferenceTransform,
    },
  );

  assert.equal(refreshed.success, true);
  assert.equal(refreshed.referenceTransformSource, 'recovery-prior');
  assert.equal(refreshed.recovered, 10);
  assert.equal(refreshed.recoveryCandidateMatches, 10);
  assert.ok(refreshed.recoveryMedianReferenceResidual < 1e-9);
  assert.equal(tracker.trackedPoints.length, referenceCandidates.length);
  assert.ok(tracker.trackedPoints.every((point) => point.status === 'active'));
  assert.ok(tracker.trackedPoints.every((point) => point.recentDropout === false));
});

test('recovery prior rejects an isolated cluster of matching map landmarks', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };
  const recoveryReferenceTransform = {
    tx: 12,
    ty: -7,
    scale: 1.03,
    rotation: 0.08,
  };
  const references = Array.from({ length: 7 }, (_, index) => ({
    x: 90 + (index % 3) * 4,
    y: 82 + Math.floor(index / 3) * 4,
  }));
  tracker.trackedPoints = references.map((point, index) => ({
    ...createTrackedPoint(index, point, recoveryReferenceTransform),
    status: 'lost',
    recentDropout: true,
  }));
  tracker.keypointCentroid = { x: 94, y: 86 };
  tracker.anchorOriginalPosition = { x: 94, y: 86 };

  const currentGray = {
    cols: 220,
    rows: 180,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: references.map((point) => ({
        pt: transformPoint(point, recoveryReferenceTransform),
        response: 1,
      })),
    }),
  };

  const refreshed = executeKeypointRefresh(
    tracker,
    {},
    currentGray,
    detector,
    {
      x: 0,
      y: 0,
      width: 180,
      height: 150,
    },
    null,
    {
      minNewKeypoints: 7,
      recoveryReferenceTransform,
    },
  );

  assert.equal(refreshed.success, false);
  assert.equal(refreshed.recoveryCandidateMatches, 7);
  assert.equal(refreshed.recovered, 0);
  assert.ok(tracker.trackedPoints.every((point) => point.status === 'lost'));
});

test('tracker restores descriptor-matched landmarks at their observed coordinates', () => {
  const tracker = new KeypointTracker();
  const originals = Array.from({ length: 12 }, (_, index) => ({
    x: 90 + (index % 4) * 20,
    y: 80 + Math.floor(index / 4) * 18,
  }));
  tracker.trackedPoints = originals.map((point, index) => ({
    ...createTrackedPoint(index, point, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
    status: 'lost',
    inactiveAge: 12,
    successfulTrackingStreak: 0,
  }));
  tracker.trackedPoints.push({
    ...createTrackedPoint(99, { x: 230, y: 190 }, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
    status: 'active',
  });
  tracker.keypointCentroid = { x: 120, y: 100 };
  tracker.anchorOriginalPosition = { x: 126, y: 96 };
  tracker.tapOffset = { x: 6, y: -4 };
  const previousGray = { delete() {} };
  tracker.previousGray = previousGray;

  const currentGray = {
    delete() {},
  };
  tracker.grayFrameSlots = [previousGray, currentGray];
  const matches = originals.map((reference, index) => ({
    id: index,
    reference,
    point: {
      x: reference.x + 33 + (index % 3) * 0.7,
      y: reference.y - 17 + Math.floor(index / 3) * 0.4,
    },
  }));

  const restored = tracker.restoreFromRelocalizationMatches(currentGray, matches, {
    confidence: 0.86,
    averageResidual: 1.4,
    anchorPoint: { x: 156, y: 79 },
  });

  assert.equal(restored.restored, 12);
  assert.equal(tracker.trackedPoints.filter((point) => point.status === 'active').length, 12);
  assert.equal(tracker.trackedPoints.find((point) => point.id === 99).status, 'lost');
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 126, y: 96 });
  const recoveryAnchor = tracker.getAnchorPosition();
  assert.equal(recoveryAnchor.referenceFrame, 'orb-keyframe');
  assert.ok(Math.abs(recoveryAnchor.x - 156) < 1e-6);
  assert.ok(Math.abs(recoveryAnchor.y - 79) < 1e-6);
  tracker.trackedPoints.slice(0, 12).forEach((point, index) => {
    assert.deepEqual(point.current, matches[index].point);
    assert.equal(point.inactiveAge, 0);
    assert.equal(point.objectOwnedStreak, 2);
  });
  assert.equal(tracker.getCorrespondences().length, 12);
});

test('tracker revives a pruned landmark carried by an ORB keyframe', () => {
  const tracker = new KeypointTracker();
  const previousGray = { delete() {} };
  tracker.previousGray = previousGray;
  const currentGray = { delete() {} };
  tracker.grayFrameSlots = [previousGray, currentGray];

  const restored = tracker.restoreFromRelocalizationMatches(
    currentGray,
    [
      {
        id: 42,
        reference: { x: 72, y: 84 },
        point: { x: 128, y: 106 },
        response: 0.7,
      },
    ],
    {
      confidence: 0.82,
      averageResidual: 1.8,
      anchorPoint: { x: 128, y: 106 },
    },
  );

  assert.equal(restored.restored, 1);
  assert.equal(restored.active, 1);
  assert.equal(tracker.nextPointId, 43);
  assert.deepEqual(tracker.trackedPoints[0].original, { x: 72, y: 84 });
  assert.deepEqual(tracker.trackedPoints[0].current, { x: 128, y: 106 });
  assert.equal(tracker.trackedPoints[0].objectOwned, true);
});
