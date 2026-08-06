import test from 'node:test';
import assert from 'node:assert/strict';

import { ownsObjectVoiceRequest } from './objectVoiceOwnership.js';

test('object voice completion belongs to both its request and anchor identity', () => {
  const request = {
    requestId: 7,
    currentRequestId: 7,
    anchorCreatedAt: 100,
    activeAnchor: { createdAt: 100 },
  };

  assert.equal(ownsObjectVoiceRequest(request), true);
  assert.equal(ownsObjectVoiceRequest({ ...request, currentRequestId: 8 }), false);
  assert.equal(ownsObjectVoiceRequest({ ...request, activeAnchor: null }), false);
  assert.equal(
    ownsObjectVoiceRequest({
      ...request,
      activeAnchor: { createdAt: 101 },
    }),
    false,
  );
});
