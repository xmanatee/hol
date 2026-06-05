import test from 'node:test';
import assert from 'node:assert/strict';

import { COCO_CLASSES, TARGET_CLASS_IDS } from './cocoClasses.js';

test('COCO detector metadata includes every YOLO class used by target filtering', () => {
  assert.equal(COCO_CLASSES.length, 80);
  assert.equal(COCO_CLASSES[0], 'person');
  assert.equal(COCO_CLASSES[39], 'bottle');
  assert.equal(COCO_CLASSES[41], 'cup');
  assert.equal(COCO_CLASSES[73], 'book');

  TARGET_CLASS_IDS.forEach(classId => {
    assert.equal(typeof COCO_CLASSES[classId], 'string', `missing class name for ${classId}`);
  });
});
