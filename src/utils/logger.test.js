import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_LOG_TAGS,
  TaggedLogger,
} from './logger.js';

const createMemoryStorage = () => {
  const values = new Map();

  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

const createConsoleCapture = () => {
  const entries = [];

  return {
    entries,
    log: (...args) => entries.push(['log', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
};

test('logger exposes known tags before code paths discover them', () => {
  const logger = new TaggedLogger({
    storage: createMemoryStorage(),
    consoleTarget: createConsoleCapture(),
  });

  assert.deepEqual(logger.getAllTags(), [...KNOWN_LOG_TAGS].sort());
});

test('logger presets replace enabled tags with focused debugging sets', () => {
  const logger = new TaggedLogger({
    storage: createMemoryStorage(),
    consoleTarget: createConsoleCapture(),
  });

  logger.applyPreset('vision');
  assert.ok(logger.getEnabledTags().includes('ImageAnchor'));
  assert.ok(logger.getEnabledTags().includes('KeypointTracker'));
  assert.equal(logger.getEnabledTags().includes('TTSClient'), false);

  logger.applyPreset('quiet');
  assert.deepEqual(logger.getEnabledTags(), []);
});

test('logger restores saved enabled tags into the visible tag list', () => {
  const storage = createMemoryStorage();
  storage.setItem('logger-enabled-tags', JSON.stringify(['FutureWorker']));

  const logger = new TaggedLogger({
    storage,
    consoleTarget: createConsoleCapture(),
  });

  assert.ok(logger.getAllTags().includes('FutureWorker'));
  assert.ok(logger.getEnabledTags().includes('FutureWorker'));
});

test('logger exposes tags enabled through setEnabledTags', () => {
  const logger = new TaggedLogger({
    storage: createMemoryStorage(),
    consoleTarget: createConsoleCapture(),
  });

  logger.setEnabledTags(['FutureWorker']);

  assert.ok(logger.getAllTags().includes('FutureWorker'));
  assert.ok(logger.getEnabledTags().includes('FutureWorker'));
});

test('logger emits errors regardless of enabled tags and gates other levels by tag', () => {
  const consoleTarget = createConsoleCapture();
  const logger = new TaggedLogger({
    storage: createMemoryStorage(),
    consoleTarget,
  });

  logger.warn('ImageAnchor', 'hidden warning');
  logger.error('ImageAnchor', 'visible error');
  assert.deepEqual(consoleTarget.entries, [
    ['error', '[ImageAnchor]', 'visible error'],
  ]);

  logger.enableTag('ImageAnchor');
  logger.info('ImageAnchor', 'visible info');

  assert.deepEqual(consoleTarget.entries.at(-1), ['log', '[ImageAnchor]', 'visible info']);
});

test('logger debugChanged emits repeated state summaries only when the signature changes', () => {
  const consoleTarget = createConsoleCapture();
  const logger = new TaggedLogger({
    storage: createMemoryStorage(),
    consoleTarget,
  });

  logger.debugChanged('Detection', 'count', 0, 'Received detections:', 0);
  logger.enableTag('Detection');
  logger.debugChanged('Detection', 'count', 0, 'Received detections:', 0);
  logger.debugChanged('Detection', 'count', 0, 'Received detections:', 0);
  logger.debugChanged('Detection', 'count', 1, 'Received detections:', 1);

  assert.deepEqual(consoleTarget.entries, [
    ['log', '[Detection]', 'Received detections:', 0],
    ['log', '[Detection]', 'Received detections:', 1],
  ]);
});

test('logger debugEvery emits at most once per interval for enabled tags', () => {
  let now = 1000;
  const consoleTarget = createConsoleCapture();
  const logger = new TaggedLogger({
    storage: createMemoryStorage(),
    consoleTarget,
    now: () => now,
  });

  logger.enableTag('KeypointTracker');
  logger.debugEvery('KeypointTracker', 'tracking-summary', 1000, 'tracking frame', 1);
  logger.debugEvery('KeypointTracker', 'tracking-summary', 1000, 'tracking frame', 2);
  now = 1999;
  logger.debugEvery('KeypointTracker', 'tracking-summary', 1000, 'tracking frame', 3);
  now = 2000;
  logger.debugEvery('KeypointTracker', 'tracking-summary', 1000, 'tracking frame', 4);

  assert.deepEqual(consoleTarget.entries, [
    ['log', '[KeypointTracker]', 'tracking frame', 1],
    ['log', '[KeypointTracker]', 'tracking frame', 4],
  ]);
});
