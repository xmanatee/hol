import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { createPlanarSurfaceAttachment, writePlanarSurfaceMatrices } from './planarSurfaceAttachment.js';

const cameraParams = { fx: 550, fy: 570, cx: 310, cy: 235 };
const referenceBounds = { width: 240, height: 180 };

test('planar attachment projects independent 3D points into the same camera pixels, including cover crop', () => {
  for (const angles of [
    [0, 0, 0],
    [0.3, -0.6, 0.2],
    [-0.5, 0.4, -0.7],
  ]) {
    const rotation = new Matrix4().makeRotationFromEuler(new Euler(...angles));
    const e = rotation.elements;
    const r = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
    for (const tz of [300, 750, 1500]) {
      const t = [35, -20, tz];
      const attachment = createPlanarSurfaceAttachment({
        pose: { rotation: r, translation: t },
        cameraParams,
        referenceBounds,
      });
      for (const [renderWidth, renderHeight] of [
        [640, 480],
        [390, 844],
        [844, 390],
      ]) {
        for (const mirrored of [false, true]) {
          const camera = new PerspectiveCamera();
          camera.position.z = 3;
          camera.updateMatrixWorld(true);
          const modelMatrix = new Matrix4();
          writePlanarSurfaceMatrices({
            attachment,
            modelMatrix,
            projectionMatrix: camera.projectionMatrix,
            width: 640,
            height: 480,
            renderWidth,
            renderHeight,
            cameraDistance: 3,
            mirrored,
          });
          const scale = Math.max(renderWidth / 640, renderHeight / 480);
          for (const point of [
            [0, 0, 0],
            [-0.3, 0.2, 0],
            [0.2, -0.2, 0.4],
          ]) {
            // Independent oracle: OpenCV pinhole equation K * (R * X + t).
            const local = [
              point[0] * attachment.faceSize,
              -point[1] * attachment.faceSize,
              -point[2] * attachment.faceSize,
            ];
            const cv = r
              .slice(0, 3)
              .map(
                (_, row) =>
                  t[row] + local.reduce((sum, value, column) => sum + r[row * 3 + column] * value, 0),
              );
            const sourceX = (cameraParams.fx * cv[0]) / cv[2] + cameraParams.cx;
            const sourceY = (cameraParams.fy * cv[1]) / cv[2] + cameraParams.cy;
            const expectedX = (mirrored ? 640 - sourceX : sourceX) * scale + (renderWidth - 640 * scale) / 2;
            const expectedY = sourceY * scale + (renderHeight - 480 * scale) / 2;
            const projected = new Vector3(...point).applyMatrix4(modelMatrix).project(camera);
            assert.ok(Math.abs(((projected.x + 1) * renderWidth) / 2 - expectedX) < 1e-8);
            assert.ok(Math.abs(((1 - projected.y) * renderHeight) / 2 - expectedY) < 1e-8);
          }
        }
      }
    }
  }
});

test('only full, finite, front-of-camera PnP geometry creates a physical attachment', () => {
  const args = { pose: {}, cameraParams, referenceBounds };
  assert.equal(createPlanarSurfaceAttachment(args), null);
  const pose = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 500] };
  const attachment = createPlanarSurfaceAttachment({ ...args, pose });
  assert.equal(attachment.units, 'reference-pixels');
  assert.equal(attachment.faceSize, 99.00000000000001);
  assert.throws(
    () => createPlanarSurfaceAttachment({ ...args, pose: { rotation: pose.rotation } }),
    /Invalid/,
  );
  for (const rotation of [
    [2, 0, 0, 0, 1, 0, 0, 0, 1],
    [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  ]) {
    assert.throws(() => createPlanarSurfaceAttachment({ ...args, pose: { ...pose, rotation } }), /rotation/);
  }
  for (const translation of [
    [0, 0, -1],
    [0, NaN, 500],
    [0, 0],
  ]) {
    assert.throws(
      () => createPlanarSurfaceAttachment({ ...args, pose: { ...pose, translation } }),
      /Invalid/,
    );
  }
  assert.throws(
    () => createPlanarSurfaceAttachment({ ...args, pose, cameraParams: { ...cameraParams, fx: 0 } }),
    /Invalid/,
  );
});
