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

test('moderate template quality is usable but starts degraded', () => {
  const service = new ImageAnchorService();

  assert.equal(service._isUsableTemplateQuality(0.17), true);
  assert.equal(service._getInitialAnchorState(0.17), 'degraded');
  assert.equal(service._getInitialAnchorState(0.31), 'tracking');
});
