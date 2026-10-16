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

test('smoothing is independent of the clock origin, including a first capture at zero', () => {
  const fromZero = new OneEuroFilter(60, 2.4, 0.075);
  const fromOffset = new OneEuroFilter(60, 2.4, 0.075);
  for (const [value, timestamp] of [
    [0, 0],
    [12, 67],
    [24, 133],
    [36, 215],
  ]) {
    assert.equal(fromZero.filter(value, timestamp), fromOffset.filter(value, timestamp + 1000));
  }
});

test('sub-ten-millisecond captures remain milliseconds instead of snapping to the measurement', () => {
  const filter = new OneEuroFilter(120);
  assert.equal(filter.filter(0, 1000), 0);
  const smoothed = filter.filter(100, 1000 + 1000 / 120);
  assert.ok(smoothed > 0 && smoothed < 10);
});

test('a stationary sample remains stationary across pauses and repeated timestamps', () => {
  const filter = new OneEuroFilter(60, 2.4, 0.075);
  for (const timestamp of [0, 0, 8, 75, 5000, 5000, 5067]) {
    assert.equal(filter.filter(42, timestamp), 42);
  }
});

test('invalid filter parameters fail before consuming samples', () => {
  for (const parameters of [
    [0],
    [Infinity],
    [60, 0],
    [60, NaN],
    [60, 1, -1],
    [60, 1, Infinity],
    [60, 1, 0, 0],
  ]) {
    assert.throws(() => new OneEuroFilter(...parameters), RangeError);
  }
});

test('invalid or backwards captures fail without poisoning the next valid sample', () => {
  const filter = new OneEuroFilter(60);
  const uninterrupted = new OneEuroFilter(60);
  assert.equal(filter.filter(0, 0), uninterrupted.filter(0, 0));
  assert.equal(filter.filter(10, 67), uninterrupted.filter(10, 67));
  for (const [value, timestamp] of [
    [NaN, 133],
    [Infinity, 133],
    [10, undefined],
    [10, NaN],
    [10, Infinity],
    [10, -1],
    [10, 66],
  ]) {
    assert.throws(() => filter.filter(value, timestamp), RangeError);
  }
  assert.equal(filter.filter(20, 133), uninterrupted.filter(20, 133));
});
