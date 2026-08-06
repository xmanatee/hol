const scheduleWorkerRequestTimeout = (callback, timeoutMs) => {
  const timeoutId = globalThis.setTimeout(callback, timeoutMs);
  return () => globalThis.clearTimeout(timeoutId);
};

export const assertWorkerRequestTimeout = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
};

export class WorkerRequestRegistry extends Map {
  constructor({ scheduleTimeout = scheduleWorkerRequestTimeout } = {}) {
    super();
    if (typeof scheduleTimeout !== 'function') {
      throw new TypeError('scheduleTimeout must be a function');
    }
    this.schedule = scheduleTimeout;
  }

  start({ id, timeoutMs, timeoutMessage, send, onTimeout }) {
    if (this.has(id)) {
      throw new Error(`Duplicate worker request ${id}`);
    }

    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });

    try {
      send();
    } catch (error) {
      rejectRequest(error);
      return promise;
    }

    const request = [resolveRequest, rejectRequest, () => {}];
    this.set(id, request);
    try {
      request[2] = this.schedule(() => {
        const expired = this._take(id);
        if (!expired) {
          return;
        }
        const error = new Error(timeoutMessage);
        error.name = 'TimeoutError';
        expired[1](error);
        onTimeout(error);
      }, timeoutMs);
    } catch (error) {
      this.delete(id);
      rejectRequest(error);
    }

    return promise;
  }

  resolve(id, value) {
    const request = this._take(id);
    if (!request) {
      return false;
    }
    request[0](value);
    return true;
  }

  reject(id, error) {
    const request = this._take(id);
    if (!request) {
      return false;
    }
    request[1](error);
    return true;
  }

  rejectAll(reason) {
    for (const request of this.values()) {
      request[2]();
      request[1](new Error(reason));
    }
    this.clear();
  }

  _take(id) {
    const request = this.get(id);
    if (!request) {
      return null;
    }
    this.delete(id);
    request[2]();
    return request;
  }
}
