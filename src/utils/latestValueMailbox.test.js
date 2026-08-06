import test from 'node:test';
import assert from 'node:assert/strict';

import { LatestValueMailbox } from './latestValueMailbox.js';

test('latest-value mailbox delivers the newest publication exactly once', () => {
  const mailbox = new LatestValueMailbox();
  const generation = mailbox.captureGeneration();

  assert.equal(mailbox.publish('first', generation), true);
  assert.equal(mailbox.publish('newest', generation), true);
  assert.equal(mailbox.take(), 'newest');
  assert.equal(mailbox.take(), null);
});

test('latest-value mailbox rejects publications from a retired generation', () => {
  const mailbox = new LatestValueMailbox();
  const retiredGeneration = mailbox.captureGeneration();

  mailbox.reset();

  assert.equal(mailbox.publish('stale', retiredGeneration), false);
  assert.equal(mailbox.take(), null);
  const currentGeneration = mailbox.captureGeneration();
  assert.equal(mailbox.publish('current', currentGeneration), true);
  assert.equal(mailbox.take(), 'current');
});
