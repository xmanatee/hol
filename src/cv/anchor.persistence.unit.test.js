import test from 'node:test';
import assert from 'node:assert/strict';
import { AnchorPersistenceSystem } from './anchor.persistence.js';

test('template recovery preserves the tapped anchor offset from the matched template center', () => {
  const persistence = new AnchorPersistenceSystem();
  persistence.templateRegion = { x: 100, y: 100, width: 80, height: 80 };
  persistence.anchorOffset = { x: -20, y: -10 };

  const position = persistence._matchLocationToAnchorPosition({ x: 30, y: 40 }, { x: 50, y: 60 }, 1);

  assert.deepEqual(position, { x: 100, y: 130 });
});

test('template recovery searches whenever a template is available', () => {
  const persistence = new AnchorPersistenceSystem();
  let searches = 0;

  persistence.initialized = true;
  persistence.template = {};
  persistence.templateRegion = { x: 0, y: 0, width: 80, height: 80 };
  persistence.lastKnownPosition = { x: 120, y: 140 };
  persistence.anchorOffset = { x: 0, y: 0 };
  persistence._extractSearchROI = () => ({
    roi: { delete() {} },
    offset: { x: 80, y: 100 },
  });
  persistence._multiScaleTemplateMatch = () => {
    searches++;
    return {
      success: false,
      confidence: 0,
      location: null,
      scale: 1,
    };
  };

  const result = persistence.attemptRecovery({}, {});

  assert.equal(result.success, false);
  assert.equal(result.reason, 'Template match below threshold');
  assert.equal(searches, 1);
});
