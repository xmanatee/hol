import test from 'node:test';
import assert from 'node:assert/strict';

import { COCO_CLASSES, TARGET_CLASS_IDS, TARGET_CLASS_NAMES } from './cocoClasses.js';

test('COCO detector metadata includes every YOLO class used by target filtering', () => {
  assert.equal(COCO_CLASSES.length, 80);
  assert.deepEqual(TARGET_CLASS_NAMES, [
    'person',
    'sports ball',
    'bottle',
    'wine glass',
    'cup',
    'bowl',
    'tv',
    'laptop',
    'mouse',
    'remote',
    'keyboard',
    'cell phone',
    'book',
    'clock',
    'vase',
  ]);

  TARGET_CLASS_IDS.forEach(classId => {
    assert.equal(typeof COCO_CLASSES[classId], 'string', `missing class name for ${classId}`);
  });
});

test('target class ids are derived from selectable class names', () => {
  const targetNamesById = [...TARGET_CLASS_IDS].map(classId => COCO_CLASSES[classId]);

  assert.deepEqual(targetNamesById, TARGET_CLASS_NAMES);
});
