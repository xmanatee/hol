import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter } from './oneEuroFilter.js';

test('one euro filter dampens one-frame position jumps with millisecond timestamps', () => {
  const filter = new OneEuroFilter(30);

  const first = filter.filter(0, 1000);
  const second = filter.filter(100, 1016.67);
  const third = filter.filter(100, 1033.34);

  assert.equal(first, 0);
  assert.ok(second > 0);
  assert.ok(second < 25);
  assert.ok(third > second);
  assert.ok(third < 45);
});
