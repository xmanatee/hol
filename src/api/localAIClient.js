import { assertRequestTimeout, runBoundedRequest } from '../utils/boundedRequest.js';
import { readBoundedResponseBytes, readBoundedResponseJson } from '../utils/boundedResponseBody.js';
import { readViteEnv } from './viteEnv.js';

const DEFAULT_LOCAL_AI_REQUEST_TIMEOUT_MS = 60000;
const MAX_CHAT_RESPONSE_BYTES = 1024 * 1024;
const MAX_SPEECH_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string') {
    throw new TypeError('VITE_LOCAL_AI_BASE_URL must be a string.');
  }
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('Set VITE_LOCAL_AI_BASE_URL to a local or self-hosted OpenAI-compatible /v1 endpoint.');
  }

  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('VITE_LOCAL_AI_BASE_URL must use HTTP or HTTPS.');
  }

  return parsed.href.replace(/\/$/, '');
};

const resolveRequestTimeout = (configuredValue) => {
  if (configuredValue !== undefined) {
    return assertRequestTimeout(configuredValue, 'Local AI request timeout');
  }
  const environmentValue = readViteEnv('VITE_LOCAL_AI_REQUEST_TIMEOUT_MS');
  if (environmentValue === undefined) {
    return DEFAULT_LOCAL_AI_REQUEST_TIMEOUT_MS;
  }
  if (typeof environmentValue !== 'string' || environmentValue.trim().length === 0) {
    throw new TypeError('VITE_LOCAL_AI_REQUEST_TIMEOUT_MS must be a number.');
  }
  return assertRequestTimeout(Number(environmentValue), 'VITE_LOCAL_AI_REQUEST_TIMEOUT_MS');
};

const assertPayload = (payload) => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Local AI request payload must be an object.');
  }
};

const assertFetchResponse = (response) => {
  if (
    response === null ||
    typeof response !== 'object' ||
    typeof response.ok !== 'boolean' ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.headers?.get !== 'function'
  ) {
    throw new TypeError('Local AI transport must return a valid Fetch Response.');
  }
};

const responseHasJsonBody = (response) => {
  const contentType = response.headers.get('Content-Type');
  if (typeof contentType !== 'string') {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
};

export const readChatCompletionContent = (response) => {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('Local AI response must be an object.');
  }
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new TypeError('Local AI response must contain at least one choice.');
  }
  const content = response.choices[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new TypeError('Local AI response choice must contain non-empty message content.');
  }
  return content;
};

export class LocalAIClient {
  constructor(config = {}) {
    const browserFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? readViteEnv('VITE_LOCAL_AI_BASE_URL'));
    this.fetchImpl = Object.hasOwn(config, 'fetchImpl') ? config.fetchImpl : browserFetch;
    this.requestTimeoutMs = resolveRequestTimeout(config.requestTimeoutMs);
    this.scheduleRequestTimeout = config.scheduleRequestTimeout;

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('Fetch API is required for local AI requests.');
    }
    if (this.scheduleRequestTimeout !== undefined && typeof this.scheduleRequestTimeout !== 'function') {
      throw new TypeError('Local AI scheduleRequestTimeout must be a function.');
    }
  }

  createChatCompletion(payload, { signal } = {}) {
    assertPayload(payload);
    return this._post('/chat/completions', payload, {
      signal,
      requestName: 'Local AI chat request',
      readSuccessBody: (response, requestSignal) =>
        readBoundedResponseJson(response, {
          bodyName: 'Local AI chat response',
          maxBytes: MAX_CHAT_RESPONSE_BYTES,
          signal: requestSignal,
        }),
    });
  }

  createSpeech(payload, { signal } = {}) {
    assertPayload(payload);
    return this._post('/audio/speech', payload, {
      signal,
      requestName: 'Local speech request',
      readSuccessBody: async (response, requestSignal) => {
        const buffer = await readBoundedResponseBytes(response, {
          bodyName: 'Local speech response',
          maxBytes: MAX_SPEECH_RESPONSE_BYTES,
          signal: requestSignal,
        });
        if (buffer.byteLength === 0) {
          throw new TypeError('Local speech response must not be empty.');
        }
        return buffer;
      },
    });
  }

  _post(path, payload, { signal, requestName, readSuccessBody }) {
    return runBoundedRequest({
      signal,
      timeoutMs: this.requestTimeoutMs,
      timeoutMessage: `${requestName} timed out after ${this.requestTimeoutMs}ms`,
      scheduleTimeout: this.scheduleRequestTimeout,
      execute: async (requestSignal) => {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: requestSignal,
        });
        requestSignal.throwIfAborted();
        assertFetchResponse(response);

        if (!response.ok) {
          const data = responseHasJsonBody(response)
            ? await readBoundedResponseJson(response, {
                bodyName: 'Local AI error response',
                maxBytes: MAX_ERROR_RESPONSE_BYTES,
                signal: requestSignal,
              })
            : null;
          requestSignal.throwIfAborted();
          throw new Error(data?.error?.message || `Local AI request failed with status ${response.status}`);
        }

        const bodyPromise = readSuccessBody(response, requestSignal);
        if (typeof bodyPromise?.then !== 'function') {
          throw new TypeError('Local AI response body reader must return a Promise.');
        }
        const result = await bodyPromise;
        requestSignal.throwIfAborted();
        return result;
      },
    });
  }
}
