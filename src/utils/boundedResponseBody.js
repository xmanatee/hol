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
  if (!(response instanceof Response) || response.body === null) {
    throw new TypeError('Response must expose a readable byte stream.');
  }
  if (response.bodyUsed || response.body.locked) {
    throw new TypeError('Response body must be unread and unlocked.');
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

export const readBoundedResponseBytes = async (response, { bodyName, maxBytes, signal } = {}) => {
  assertReadOptions(bodyName, maxBytes);
  assertReadableResponseBody(response);
  if (signal !== undefined) {
    assertAbortSignal(signal, 'Response signal');
  }

  const chunks = [];
  let totalBytes = 0;
  const sink = new WritableStream({
    start(controller) {
      try {
        const contentLength = readContentLength(response, bodyName);
        if (contentLength !== null && contentLength > maxBytes) {
          throw new RangeError(
            `${bodyName} Content-Length ${contentLength} exceeds the ${maxBytes}-byte limit.`,
          );
        }
      } catch (error) {
        // Error the sink so pipeTo cancels the source even when headers fail.
        controller.error(error);
      }
    },
    write(value) {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${bodyName} stream must contain Uint8Array chunks.`);
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new RangeError(`${bodyName} exceeded the ${maxBytes}-byte limit.`);
      }
      if (value.byteLength > 0) chunks.push(value);
    },
  });
  await response.body.pipeTo(sink, { signal });

  return new Blob(chunks).arrayBuffer();
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
