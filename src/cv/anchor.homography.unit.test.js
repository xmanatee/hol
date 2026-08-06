import test from 'node:test';
import assert from 'node:assert/strict';
import { HomographyEstimator } from './anchor.homography.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const camera = {
  fx: 900,
  fy: 900,
  cx: 640,
  cy: 360,
};

const rotate3 = (point, pose) => {
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

  return {
    x: cy * pitchPoint.x + sy * pitchPoint.z,
    y: pitchPoint.y,
    z: -sy * pitchPoint.x + cy * pitchPoint.z,
  };
};

const projectPlanarPoint = ({ point, pose, cameraParams }) => {
  const rotated = rotate3(point, pose);
  const x = rotated.x + pose.tx;
  const y = rotated.y + pose.ty;
  const z = rotated.z + pose.distance;

  return {
    x: cameraParams.cx + (cameraParams.fx * x) / z,
    y: cameraParams.cy + (cameraParams.fy * y) / z,
  };
};

const normalAngle = (left, right) => {
  const dot = left.x * right.x + left.y * right.y + left.z * right.z;
  const leftLength = Math.hypot(left.x, left.y, left.z);
  const rightLength = Math.hypot(right.x, right.y, right.z);

  return Math.acos(Math.max(-1, Math.min(1, dot / (leftLength * rightLength))));
};

const createPlanarPnPCorrespondences = ({ anchorReference, pose, cameraParams }) => {
  const correspondences = [];
  for (let y = -90; y <= 90; y += 30) {
    for (let x = -70; x <= 70; x += 35) {
      correspondences.push({
        prev: { x: anchorReference.x + x, y: anchorReference.y + y },
        curr: projectPlanarPoint({
          point: { x, y, z: 0 },
          pose,
          cameraParams,
        }),
      });
    }
  }

  return correspondences;
};

test('homography estimator has one planar pose solver and no unused stability state', () => {
  assert.equal('decomposeHomography' in HomographyEstimator.prototype, false);
  assert.equal('_extractPoseFromHomography' in HomographyEstimator.prototype, false);
  assert.equal('isHomographyStable' in HomographyEstimator.prototype, false);
  assert.equal('homographyHistory' in new HomographyEstimator(), false);
});

test('homography estimator owns and reuses immutable native camera inputs for its session', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  assert.deepEqual(estimator.cameraParams, camera);
  assert.deepEqual(Array.from(estimator.cameraMatrix.data64F), [
    camera.fx,
    0,
    camera.cx,
    0,
    camera.fy,
    camera.cy,
    0,
    0,
    1,
  ]);
  assert.deepEqual(Array.from(estimator.distortionCoefficients.data64F), [0, 0, 0, 0]);
  assert.equal(estimator.initialized, true);

  const cameraMatrix = estimator.cameraMatrix;
  const distortionCoefficients = estimator.distortionCoefficients;
  const solvePnP = cv.solvePnP.bind(cv);
  const solveInputs = [];
  const instrumentedCv = Object.create(cv);
  instrumentedCv.solvePnP = (...args) => {
    solveInputs.push({ cameraMatrix: args[2], distortionCoefficients: args[3] });
    return solvePnP(...args);
  };
  const input = {
    anchorReference: { x: 640, y: 360 },
    pose: {
      yaw: (21 * Math.PI) / 180,
      pitch: (-8 * Math.PI) / 180,
      roll: (6 * Math.PI) / 180,
      tx: 7,
      ty: -5,
      distance: 730,
    },
    cameraParams: camera,
  };
  const correspondences = createPlanarPnPCorrespondences(input);

  estimator.estimatePlanarPnPPose(instrumentedCv, correspondences, input.anchorReference);
  estimator.estimatePlanarPnPPose(instrumentedCv, correspondences, input.anchorReference);

  assert.equal(solveInputs.length, 2);
  assert.ok(solveInputs.every((inputs) => inputs.cameraMatrix === cameraMatrix));
  assert.ok(solveInputs.every((inputs) => inputs.distortionCoefficients === distortionCoefficients));

  const updatedCamera = { ...camera, fx: 940, fy: 925 };
  await estimator.initialize(cv, updatedCamera);
  assert.equal(cameraMatrix.isDeleted(), true);
  assert.equal(distortionCoefficients.isDeleted(), true);
  assert.notEqual(estimator.cameraMatrix, cameraMatrix);
  assert.notEqual(estimator.distortionCoefficients, distortionCoefficients);

  const updatedCameraMatrix = estimator.cameraMatrix;
  const updatedDistortionCoefficients = estimator.distortionCoefficients;
  estimator.dispose();
  assert.equal(updatedCameraMatrix.isDeleted(), true);
  assert.equal(updatedDistortionCoefficients.isDeleted(), true);
});

test('planar PnP reuses one native workspace across correspondence sizes and releases it', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  const workspace = estimator.planarPnPWorkspace;
  const workspaceHandles = Object.values(workspace);
  const solvePnP = cv.solvePnP.bind(cv);
  const Rodrigues = cv.Rodrigues.bind(cv);
  const solveWorkspaces = [];
  const rotationWorkspaces = [];
  const instrumentedCv = Object.create(cv);
  instrumentedCv.solvePnP = (...args) => {
    solveWorkspaces.push({
      objectPoints: args[0],
      imagePoints: args[1],
      rotationVector: args[4],
      translation: args[5],
    });
    return solvePnP(...args);
  };
  instrumentedCv.Rodrigues = (...args) => {
    rotationWorkspaces.push(args[1]);
    return Rodrigues(...args);
  };
  const anchorReference = { x: 640, y: 360 };
  const correspondences = createPlanarPnPCorrespondences({
    anchorReference,
    pose: {
      yaw: (18 * Math.PI) / 180,
      pitch: (-11 * Math.PI) / 180,
      roll: (4 * Math.PI) / 180,
      tx: 6,
      ty: -3,
      distance: 715,
    },
    cameraParams: camera,
  });

  const firstPose = estimator.estimatePlanarPnPPose(instrumentedCv, correspondences, anchorReference);
  estimator.commitPlanarPnPPose({
    ...firstPose,
    normal: {
      x: -firstPose.normal.x,
      y: -firstPose.normal.y,
      z: firstPose.normal.z,
    },
  });
  estimator.estimatePlanarPnPPose(instrumentedCv, correspondences.slice(0, 20), anchorReference);
  estimator.estimatePlanarPnPPose(instrumentedCv, correspondences, anchorReference);

  assert.equal(solveWorkspaces.length, 5);
  assert.ok(solveWorkspaces.every((inputs) => inputs.objectPoints === workspace.objectPoints));
  assert.ok(solveWorkspaces.every((inputs) => inputs.imagePoints === workspace.imagePoints));
  assert.ok(solveWorkspaces.every((inputs) => inputs.rotationVector === workspace.rotationVector));
  assert.ok(solveWorkspaces.every((inputs) => inputs.translation === workspace.translation));
  assert.equal(rotationWorkspaces.length, 5);
  assert.ok(rotationWorkspaces.every((rotationMatrix) => rotationMatrix === workspace.rotationMatrix));

  await estimator.initialize(cv, { ...camera, fx: 930 });
  assert.ok(workspaceHandles.every((handle) => handle.isDeleted()));
  const replacementHandles = Object.values(estimator.planarPnPWorkspace);

  estimator.dispose();
  assert.ok(replacementHandles.every((handle) => handle.isDeleted()));
});

test('homography consensus reuses one native point workspace across correspondence sizes', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  const workspace = estimator.homographyWorkspace;
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
  const correspondences = createPlanarPnPCorrespondences({
    anchorReference: { x: 640, y: 360 },
    pose: {
      yaw: (18 * Math.PI) / 180,
      pitch: (-8 * Math.PI) / 180,
      roll: (5 * Math.PI) / 180,
      tx: 7,
      ty: -4,
      distance: 720,
    },
    cameraParams: camera,
  });

  const first = estimator.estimateHomography(instrumentedCv, correspondences);
  const second = estimator.estimateHomography(instrumentedCv, correspondences.slice(0, 20));
  const third = estimator.estimateHomography(instrumentedCv, correspondences);
  first.homography.delete();
  second.homography.delete();
  third.homography.delete();

  assert.deepEqual(
    calls.map((call) => call.pointCount),
    [35, 20, 35],
  );
  assert.ok(calls.every((call) => call.sourcePoints === workspace.sourcePoints));
  assert.ok(calls.every((call) => call.destinationPoints === workspace.destinationPoints));
  assert.ok(calls.every((call) => call.inlierMask === workspace.inlierMask));

  await estimator.initialize(cv, { ...camera, fx: 930 });
  assert.ok(workspaceHandles.every((handle) => handle.isDeleted()));
  const replacementHandles = Object.values(estimator.homographyWorkspace);

  estimator.dispose();
  assert.ok(replacementHandles.every((handle) => handle.isDeleted()));
});

test('homography estimation uses the bounded deterministic RANSAC budget', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  const findHomography = cv.findHomography.bind(cv);
  let robustOptions = null;
  const instrumentedCv = Object.create(cv);
  instrumentedCv.findHomography = (...args) => {
    robustOptions = {
      method: args[2],
      threshold: args[3],
      maxIterations: args[5],
      confidence: args[6],
    };
    return findHomography(...args);
  };
  await estimator.initialize(instrumentedCv, camera);
  const correspondences = Array.from({ length: 20 }, (_, index) => {
    const x = 80 + (index % 5) * 42;
    const y = 60 + Math.floor(index / 5) * 38;
    return {
      prev: { x, y },
      curr: {
        x: x * 1.04 + y * 0.02 + 11,
        y: y * 0.98 - x * 0.01 - 7,
      },
    };
  });

  const result = estimator.estimateHomography(instrumentedCv, correspondences);

  assert.equal(result.success, true);
  assert.deepEqual(robustOptions, {
    method: cv.RANSAC,
    threshold: 2.5,
    maxIterations: 1250,
    confidence: 0.99,
  });

  result.homography.delete();
  estimator.dispose();
});

test('homography residual summary contains only ordered RANSAC inliers', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  const correspondences = Array.from({ length: 30 }, (_, index) => {
    const x = 90 + (index % 6) * 46;
    const y = 75 + Math.floor(index / 6) * 41;
    const outlier = index % 8 === 0;
    return {
      prev: { x, y },
      curr: {
        x: x * 1.03 + y * 0.04 + 13 + (outlier ? 48 : 0),
        y: y * 0.97 - x * 0.02 - 9 - (outlier ? 37 : 0),
      },
    };
  });

  const result = estimator.estimateHomography(cv, correspondences);
  assert.equal(result.success, true);
  assert.ok(result.inlierCount < correspondences.length);
  assert.equal(result.inlierCorrespondences.length, result.inlierCount);
  assert.deepEqual(
    result.inlierCorrespondences,
    correspondences.filter((correspondence) => result.inlierCorrespondences.includes(correspondence)),
  );
  const residuals = result.inlierCorrespondences.map((correspondence) => {
    const matrix = result.matrix;
    const denominator = matrix[6] * correspondence.prev.x + matrix[7] * correspondence.prev.y + matrix[8];
    const projectedX =
      (matrix[0] * correspondence.prev.x + matrix[1] * correspondence.prev.y + matrix[2]) / denominator;
    const projectedY =
      (matrix[3] * correspondence.prev.x + matrix[4] * correspondence.prev.y + matrix[5]) / denominator;
    return Math.hypot(projectedX - correspondence.curr.x, projectedY - correspondence.curr.y);
  });
  assert.equal(
    result.averageResidual,
    residuals.reduce((sum, residual) => sum + residual, 0) / residuals.length,
  );
  assert.equal(result.maxResidual, Math.max(...residuals));
  assert.equal(Object.hasOwn(result, 'conditionNumber'), false);

  result.homography.delete();
  estimator.dispose();
});

test('planar PnP pose estimation recovers book-like yaw pitch and depth from tracked patch points', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  const anchorReference = { x: 640, y: 360 };
  const pose = {
    yaw: (35 * Math.PI) / 180,
    pitch: (-14 * Math.PI) / 180,
    roll: (11 * Math.PI) / 180,
    tx: 12,
    ty: -8,
    distance: 720,
  };
  const expectedNormal = rotate3({ x: 0, y: 0, z: 1 }, pose);
  const correspondences = createPlanarPnPCorrespondences({
    anchorReference,
    pose,
    cameraParams: camera,
  });

  const result = estimator.estimatePlanarPnPPose(cv, correspondences, anchorReference);

  assert.equal(result.success, true);
  assert.equal(result.method, 'planar-pnp');
  assert.ok(normalAngle(result.normal, expectedNormal) < 0.05);
  assert.ok(result.averageResidual < 0.5);
  assert.ok(Math.abs(result.translation[2] - pose.distance) < 2);
  estimator.dispose();
});

test('planar PnP candidates update temporal state only after an explicit commit', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  const anchorReference = { x: 640, y: 360 };
  const correspondences = createPlanarPnPCorrespondences({
    anchorReference,
    pose: {
      yaw: (24 * Math.PI) / 180,
      pitch: (-9 * Math.PI) / 180,
      roll: (5 * Math.PI) / 180,
      tx: 8,
      ty: -4,
      distance: 740,
    },
    cameraParams: camera,
  });

  const candidate = estimator.estimatePlanarPnPPose(cv, correspondences, anchorReference);

  assert.equal(candidate.success, true);
  assert.equal(candidate.branchSelection, 'fresh');
  assert.equal(estimator.previousPlanarPnPPose, null);

  estimator.commitPlanarPnPPose(candidate);
  assert.deepEqual(estimator.previousPlanarPnPPose.normal, candidate.normal);

  estimator.resetTracking();
  assert.equal(estimator.previousPlanarPnPPose, null);
  estimator.dispose();
});
