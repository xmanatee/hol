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
  const response = responseFromChunks([Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)]);

  const buffer = await readBoundedResponseBytes(response, {
    bodyName: 'Test response',
    maxBytes: 5,
  });

  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5]);
  assert.equal(response.body.locked, false);
});

test('bounded response reader rejects an oversized Content-Length before reading and cancels the body', async () => {
  let cancellationReason = null;
  const response = responseFromChunks([Uint8Array.of(1)], {
    contentLength: '6',
    onCancel: (reason) => {
      cancellationReason = reason;
    },
  });

  await assert.rejects(
    () =>
      readBoundedResponseBytes(response, {
        bodyName: 'Test response',
        maxBytes: 5,
      }),
    /Test response Content-Length 6 exceeds the 5-byte limit/,
  );
  assert.match(cancellationReason.message, /exceeds the 5-byte limit/);
  assert.equal(response.body.locked, false);
});

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

test('bounded response reader cancels a body with an ambiguous Content-Length', async () => {
  let cancellationReason = null;
  const response = responseFromChunks([Uint8Array.of(1)], {
    contentLength: '1.5',
    onCancel: (reason) => {
      cancellationReason = reason;
    },
  });

  await assert.rejects(
    () =>
      readBoundedResponseBytes(response, {
        bodyName: 'Invalid response',
        maxBytes: 5,
      }),
    /Content-Length must be a non-negative integer/,
  );
  assert.match(cancellationReason.message, /Content-Length must be a non-negative integer/);
  assert.equal(response.body.locked, false);
});

test('bounded JSON reader rejects malformed UTF-8 and malformed JSON', async () => {
  const malformedUtf8 = responseFromChunks([Uint8Array.of(0xc3, 0x28)]);
  await assert.rejects(
    () =>
      readBoundedResponseJson(malformedUtf8, {
        bodyName: 'JSON response',
        maxBytes: 32,
      }),
    /encoded as UTF-8/,
  );

  const malformedJson = responseFromChunks([new TextEncoder().encode('{"missing":')]);
  await assert.rejects(
    () =>
      readBoundedResponseJson(malformedJson, {
        bodyName: 'JSON response',
        maxBytes: 32,
      }),
    /valid JSON/,
  );
});

test('bounded response reader releases a stalled stream when its request is aborted', async () => {
  const controller = new AbortController();
  const reason = new DOMException('request retired', 'AbortError');
  const response = new Response(new ReadableStream());
  const read = readBoundedResponseBytes(response, {
    bodyName: 'Stalled response',
    maxBytes: 32,
    signal: controller.signal,
  });
  await Promise.resolve();

  assert.equal(response.body.locked, true);
  controller.abort(reason);

  await assert.rejects(read, (error) => error === reason);
  assert.equal(response.body.locked, false);
});

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
