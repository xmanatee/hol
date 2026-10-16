import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedResponseBytes, readBoundedResponseJson } from './boundedResponseBody.js';

const responseFromChunks = (chunks, { contentLength, keepOpen = false, onCancel } = {}) => {
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => {
        controller.enqueue(chunk);
      });
      if (!keepOpen) {
        controller.close();
      }
    },
    cancel: onCancel,
  });
  const headers = contentLength === undefined ? undefined : { 'Content-Length': contentLength };
  return new Response(stream, { headers });
};

test('bounded response reader assembles streamed bytes and releases its reader lock', async () => {
  const response = responseFromChunks([Uint8Array.of(9, 1, 2, 9).subarray(1, 3), Uint8Array.of(3, 4, 5)]);

  const buffer = await readBoundedResponseBytes(response, {
    bodyName: 'Test response',
    maxBytes: 5,
  });

  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5]);
  assert.equal(response.body.locked, false);
  await assert.rejects(
    readBoundedResponseBytes(response, { bodyName: 'Used response', maxBytes: 5 }),
    /unread and unlocked/,
  );
});

test('a failing source releases its lock and preserves the original stream error', async () => {
  const failure = new Error('connection lost');
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(failure);
      },
    }),
  );
  await assert.rejects(
    readBoundedResponseBytes(response, { bodyName: 'Broken response', maxBytes: 5 }),
    (error) => error === failure,
  );
  assert.equal(response.body.locked, false);
});

test('invalid byte chunks cancel the source and propagate cancellation failures', async () => {
  const failure = new Error('source cancellation failed');
  const response = responseFromChunks(['not bytes'], {
    keepOpen: true,
    onCancel: (reason) => {
      assert.match(reason.message, /Uint8Array chunks/);
      throw failure;
    },
  });
  await assert.rejects(
    readBoundedResponseBytes(response, { bodyName: 'Invalid response', maxBytes: 5 }),
    (error) => error === failure,
  );
  assert.equal(response.body.locked, false);
});

for (const [contentLength, expected] of [
  ['6', /Content-Length 6 exceeds the 5-byte limit/],
  ['1.5', /Content-Length must be a non-negative integer/],
  ['-1', /Content-Length must be a non-negative integer/],
  ['9007199254740992', /Content-Length exceeds the safe integer range/],
]) {
  test(`bounded response reader cancels an invalid Content-Length of ${contentLength}`, async () => {
    let cancellationReason = null;
    const response = responseFromChunks([Uint8Array.of(1)], {
      contentLength,
      onCancel: (reason) => {
        cancellationReason = reason;
      },
    });
    await assert.rejects(
      readBoundedResponseBytes(response, { bodyName: 'Test response', maxBytes: 5 }),
      expected,
    );
    assert.match(cancellationReason.message, expected);
    assert.equal(response.body.locked, false);
  });
}

test('bounded response reader enforces the actual streamed byte count without Content-Length', async () => {
  let cancellationReason = null;
  const response = responseFromChunks([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)], {
    keepOpen: true,
    onCancel: (reason) => {
      cancellationReason = reason;
    },
  });

  await assert.rejects(
    () =>
      readBoundedResponseBytes(response, {
        bodyName: 'Chunked response',
        maxBytes: 5,
      }),
    /Chunked response exceeded the 5-byte limit/,
  );
  assert.match(cancellationReason.message, /exceeded the 5-byte limit/);
  assert.equal(response.body.locked, false);
});

for (const [bytes, expected] of [
  [Uint8Array.of(0xc3, 0x28), /encoded as UTF-8/],
  [new TextEncoder().encode('{"missing":'), /valid JSON/],
]) {
  test(`bounded JSON reader rejects a body not ${expected.source}`, async () => {
    await assert.rejects(
      readBoundedResponseJson(responseFromChunks([bytes]), {
        bodyName: 'JSON response',
        maxBytes: 32,
      }),
      expected,
    );
  });
}

for (const preAborted of [false, true]) {
  test(`bounded response reader cancels and unlocks its source when aborted ${preAborted ? 'before' : 'during'} reading`, async () => {
    const controller = new AbortController();
    const reason = new DOMException('request retired', 'AbortError');
    let cancellationReason = null;
    const response = responseFromChunks([Uint8Array.of(1)], {
      keepOpen: true,
      onCancel: (cancelledReason) => {
        cancellationReason = cancelledReason;
      },
    });
    if (preAborted) controller.abort(reason);
    const read = readBoundedResponseBytes(response, {
      bodyName: 'Retired response',
      maxBytes: 5,
      signal: controller.signal,
    });
    if (!preAborted) {
      await Promise.resolve();
      assert.equal(response.body.locked, true);
      controller.abort(reason);
    }
    await assert.rejects(read, (error) => error === reason);
    assert.equal(cancellationReason, reason);
    assert.equal(response.body.locked, false);
  });
}

test('bounded response reader rejects ambiguous limits and response bodies before reading', async () => {
  const response = responseFromChunks([Uint8Array.of(1)]);

  await assert.rejects(
    () => readBoundedResponseBytes(response, { bodyName: '', maxBytes: 1 }),
    /bodyName must be a non-empty string/,
  );
  await assert.rejects(
    () => readBoundedResponseBytes(response, { bodyName: 'Test response', maxBytes: 0 }),
    /maxBytes must be a positive safe integer/,
  );
  await assert.rejects(
    () =>
      readBoundedResponseBytes(
        { headers: new Headers(), body: null },
        { bodyName: 'Test response', maxBytes: 1 },
      ),
    /must expose a readable byte stream/,
  );
});
