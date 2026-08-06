import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCriticalFeatures, getRequiredFeatures } from './opencv.features.js';

test('OpenCV critical feature check reports missing runtime explicitly', () => {
  const result = checkCriticalFeatures(null);

  assert.equal(result.allAvailable, false);
  assert.deepEqual(result.available, []);
  assert.deepEqual(result.missing, getRequiredFeatures());
  assert.equal(result.error, 'OpenCV.js not available');
});

test('OpenCV critical feature check validates the required image-anchor symbols', () => {
  const cv = Object.fromEntries(getRequiredFeatures().map((feature) => [feature, () => {}]));
  const result = checkCriticalFeatures(cv);

  assert.equal(result.allAvailable, true);
  assert.deepEqual(result.available, getRequiredFeatures());
  assert.deepEqual(result.missing, []);
});

test('OpenCV critical feature check reports missing symbols without probing optional APIs', () => {
  const cv = Object.fromEntries(
    getRequiredFeatures()
      .filter((feature) => feature !== 'findHomography')
      .map((feature) => [feature, () => {}]),
  );
  const result = checkCriticalFeatures(cv);

  assert.equal(result.allAvailable, false);
  assert.deepEqual(result.missing, ['findHomography']);
});
