import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageAnchorService } from './ImageAnchorService.js';

test('template region follows the selected detection instead of a full-frame generic crop', () => {
  const service = new ImageAnchorService();
  const region = service._calculateTemplateRegion(
    { x: 500, y: 320 },
    { x1: 440, y1: 260, x2: 560, y2: 380 },
    1280,
    720
  );

  assert.ok(region.x >= 400);
  assert.ok(region.y >= 220);
  assert.ok(region.width < 220);
  assert.ok(region.height < 220);
  assert.ok(region.x <= 500 && region.x + region.width >= 500);
  assert.ok(region.y <= 320 && region.y + region.height >= 320);
});

test('large detections create a tap-local template instead of seeding the whole box', () => {
  const service = new ImageAnchorService();
  const tap = { x: 240, y: 180 };
  const region = service._calculateTemplateRegion(
    tap,
    { x1: 100, y1: 80, x2: 900, y2: 680 },
    1280,
    720
  );

  const center = {
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
  };

  assert.ok(region.width <= 180);
  assert.ok(region.height <= 180);
  assert.ok(Math.abs(center.x - tap.x) <= 2);
  assert.ok(Math.abs(center.y - tap.y) <= 2);
  assert.ok(center.x < 360);
  assert.ok(center.y < 300);
});

test('moderate template quality is usable but starts degraded', () => {
  const service = new ImageAnchorService();

  assert.equal(service._isUsableTemplateQuality(0.17), true);
  assert.equal(service._getInitialAnchorState(0.17), 'degraded');
  assert.equal(service._getInitialAnchorState(0.31), 'tracking');
});

test('records usable weak-anchor diagnostics after creation', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 18 }, (_, index) => ({ x: 20 + index, y: 30 + index })),
      descriptors: {},
      method: 'fake-orb'
    }),
    assessTemplateQuality: () => ({ overall: 0.17 })
  };
  service.keypointTracker = {
    initializeTracking: () => {}
  };
  service.persistenceSystem = {
    storeTemplate: () => {}
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160 }
  );
  const state = service.getState();

  assert.equal(result.state, 'degraded');
  assert.equal(state.metrics.qualityState, 'weak');
  assert.equal(state.metrics.templateQuality, 0.17);
  assert.equal(state.metrics.templateKeypoints, 18);
  assert.deepEqual(state.metrics.templateRegion, service.templateRegion);
});

test('records failed anchor creation diagnostics before returning to inactive', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 20 }, (_, index) => ({ x: 50 + index, y: 60 + index })),
      descriptors: {},
      method: 'fake-orb'
    }),
    assessTemplateQuality: () => ({ overall: 0.08 })
  };

  await assert.rejects(
    () => service.createAnchor(
      { width: 320, height: 240 },
      { x: 110, y: 120 },
      { x1: 70, y1: 80, x2: 150, y2: 160 }
    ),
    /Poor template quality/
  );

  const state = service.getState();
  assert.equal(state.state, 'inactive');
  assert.equal(state.metrics.lastFailureStage, 'template-quality');
  assert.match(state.metrics.lastFailureReason, /Poor template quality/);
  assert.equal(state.metrics.templateQuality, 0.08);
  assert.equal(state.metrics.templateKeypoints, 20);
});

test('keeps tracking state during the keypoint retry budget', () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service._updateWithKeypoints = () => ({
    success: false,
    reason: 'Optical flow rejected points',
    state: 'tracking'
  });
  service.persistenceSystem = {
    fullFrameSearch: () => ({ success: false, reason: 'Should not search while retrying' })
  };

  const result = service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal(result.success, false);
  assert.equal(state.state, 'tracking');
  assert.equal(state.metrics.keypointFailureCount, 1);
  assert.equal(state.metrics.lostFrameCount, 0);
  assert.match(state.metrics.lastFailureReason, /Optical flow/);
});
