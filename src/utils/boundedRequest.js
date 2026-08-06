const scheduleRequestTimeout = (callback, timeoutMs) => {
  const timeoutId = globalThis.setTimeout(callback, timeoutMs);
  return () => globalThis.clearTimeout(timeoutId);
};

const isAbortSignal = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.aborted === 'boolean' &&
  typeof value.addEventListener === 'function' &&
  typeof value.removeEventListener === 'function' &&
  typeof value.throwIfAborted === 'function';

export const assertAbortSignal = (value, label = 'Signal') => {
  if (!isAbortSignal(value)) {
    throw new TypeError(`${label} must be an AbortSignal.`);
  }
  return value;
};

const MAX_TIMEOUT_MS = 2_147_483_647;

class RequestTimeoutError extends Error {
  constructor(message, timeoutMs) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export const assertRequestTimeout = (timeoutMs, label = 'Request timeout') => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `${label} must be a positive finite number of whole milliseconds no greater than ${MAX_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
};

export const runBoundedRequest = ({
  signal,
  timeoutMs,
  timeoutMessage,
  execute,
  scheduleTimeout = scheduleRequestTimeout,
}) => {
  assertRequestTimeout(timeoutMs);
  if (typeof timeoutMessage !== 'string' || timeoutMessage.trim().length === 0) {
    throw new TypeError('Request timeout message must be a non-empty string.');
  }
  if (typeof execute !== 'function') {
    throw new TypeError('Bounded request execute must be a function.');
  }
  if (typeof scheduleTimeout !== 'function') {
    throw new TypeError('Bounded request scheduleTimeout must be a function.');
  }
  if (signal !== undefined) {
    assertAbortSignal(signal, 'Bounded request signal');
  }
  signal?.throwIfAborted();

  const requestController = new AbortController();
  let rejectRetirement;
  const retirement = new Promise((_, reject) => {
    rejectRetirement = reject;
  });
  const retire = (reason) => {
    if (requestController.signal.aborted) {
      return;
    }
    rejectRetirement(reason);
    requestController.abort(reason);
  };
  const handleCallerAbort = () => retire(signal.reason);
  signal?.addEventListener('abort', handleCallerAbort, { once: true });

  const timeoutError = new RequestTimeoutError(timeoutMessage, timeoutMs);
  const cancelTimeout = scheduleTimeout(() => retire(timeoutError), timeoutMs);
  if (typeof cancelTimeout !== 'function') {
    signal?.removeEventListener('abort', handleCallerAbort);
    throw new TypeError('Bounded request scheduler must return a cancellation function.');
  }

  const operation = Promise.resolve().then(() => {
    requestController.signal.throwIfAborted();
    return execute(requestController.signal);
  });

  return Promise.race([operation, retirement]).finally(() => {
    cancelTimeout();
    signal?.removeEventListener('abort', handleCallerAbort);
  });
};
