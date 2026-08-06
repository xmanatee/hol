import { assertAbortSignal } from './boundedRequest.js';

const assertReadOptions = (bodyName, maxBytes) => {
  if (typeof bodyName !== 'string' || bodyName.trim().length === 0) {
    throw new TypeError('Response bodyName must be a non-empty string.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Response maxBytes must be a positive safe integer.');
  }
};

const assertReadableResponseBody = (response) => {
  if (
    response === null ||
    typeof response !== 'object' ||
    typeof response.headers?.get !== 'function' ||
    typeof response.body?.getReader !== 'function' ||
    typeof response.body?.cancel !== 'function'
  ) {
    throw new TypeError('Response must expose a readable byte stream.');
  }
};

const readContentLength = (response, bodyName) => {
  const value = response.headers.get('Content-Length');
  if (value === null) {
    return null;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${bodyName} Content-Length must be a non-negative integer.`);
  }
  const contentLength = Number(value);
  if (!Number.isSafeInteger(contentLength)) {
    throw new RangeError(`${bodyName} Content-Length exceeds the safe integer range.`);
  }
  return contentLength;
};

const cancelAndThrow = async (cancel, error) => {
  const cancellation = await cancel(error).then(
    () => ({ succeeded: true }),
    (failure) => ({ succeeded: false, failure }),
  );
  if (!cancellation.succeeded) {
    throw new AggregateError([error, cancellation.failure], error.message);
  }
  throw error;
};

const assembleChunks = (chunks, totalBytes) => {
  if (chunks.length === 0) {
    return new ArrayBuffer(0);
  }
  if (chunks.length === 1) {
    const chunk = chunks[0];
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
      return chunk.buffer;
    }
    return chunk.slice().buffer;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
};

const createAbortWaiter = (signal) => {
  let rejectAbort;
  const promise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => {
    rejectAbort(signal.reason ?? new DOMException('Response body read was aborted.', 'AbortError'));
  };
  signal.addEventListener('abort', handleAbort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', handleAbort),
  };
};

export const readBoundedResponseBytes = async (response, { bodyName, maxBytes, signal } = {}) => {
  assertReadOptions(bodyName, maxBytes);
  assertReadableResponseBody(response);
  if (signal !== undefined) {
    assertAbortSignal(signal, 'Response signal');
    signal.throwIfAborted();
  }

  let contentLength;
  try {
    contentLength = readContentLength(response, bodyName);
  } catch (error) {
    await cancelAndThrow((reason) => response.body.cancel(reason), error);
  }
  if (contentLength !== null && contentLength > maxBytes) {
    const error = new RangeError(
      `${bodyName} Content-Length ${contentLength} exceeds the ${maxBytes}-byte limit.`,
    );
    await cancelAndThrow((reason) => response.body.cancel(reason), error);
  }

  const reader = response.body.getReader();
  const abortWaiter = signal === undefined ? null : createAbortWaiter(signal);
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const read = reader.read();
      const { done, value } = abortWaiter ? await Promise.race([read, abortWaiter.promise]) : await read;
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        const error = new TypeError(`${bodyName} stream must contain Uint8Array chunks.`);
        await cancelAndThrow((reason) => reader.cancel(reason), error);
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new RangeError(`${bodyName} exceeded the ${maxBytes}-byte limit.`);
        await cancelAndThrow((reason) => reader.cancel(reason), error);
      }
      chunks.push(value);
    }
  } finally {
    abortWaiter?.dispose();
    reader.releaseLock();
  }

  return assembleChunks(chunks, totalBytes);
};

const decodeUtf8 = (buffer, bodyName) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new TypeError(`${bodyName} must be encoded as UTF-8.`, { cause: error });
  }
};

export const readBoundedResponseJson = async (response, options) => {
  const buffer = await readBoundedResponseBytes(response, options);
  const text = decodeUtf8(buffer, options.bodyName);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`${options.bodyName} must contain valid JSON.`, { cause: error });
  }
};
