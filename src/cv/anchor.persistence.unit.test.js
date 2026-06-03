import test from 'node:test';
import assert from 'node:assert/strict';
import { AnchorPersistenceSystem } from './anchor.persistence.js';

test('template recovery preserves the tapped anchor offset from the matched template center', () => {
  const persistence = new AnchorPersistenceSystem();
  persistence.templateRegion = { x: 100, y: 100, width: 80, height: 80 };
  persistence.anchorOffset = { x: -20, y: -10 };

  const position = persistence._matchLocationToAnchorPosition(
    { x: 30, y: 40 },
    { x: 50, y: 60 },
    1
  );

  assert.deepEqual(position, { x: 100, y: 130 });
});
