import test from 'node:test';
import assert from 'node:assert/strict';
import { installPreloadErrorRecovery, PRELOAD_RECOVERY_FLAG } from './preloadRecovery.js';

const createWindow = () => {
  const listeners = new Map();
  const storage = new Map();

  return {
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    sessionStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      }
    },
    location: {
      reloads: 0,
      reload() {
        this.reloads++;
      }
    }
  };
};

test('preload recovery reloads once for stale dynamic import chunks', () => {
  const windowLike = createWindow();
  let prevented = false;

  installPreloadErrorRecovery(windowLike);
  windowLike.listeners.get('vite:preloadError')({
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(windowLike.sessionStorage.getItem(PRELOAD_RECOVERY_FLAG), '1');
  assert.equal(windowLike.location.reloads, 1);
});

test('preload recovery does not loop if the reload also hits a stale chunk', () => {
  const windowLike = createWindow();
  let prevented = false;
  windowLike.sessionStorage.setItem(PRELOAD_RECOVERY_FLAG, '1');

  installPreloadErrorRecovery(windowLike);
  windowLike.listeners.get('vite:preloadError')({
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, false);
  assert.equal(windowLike.sessionStorage.getItem(PRELOAD_RECOVERY_FLAG), null);
  assert.equal(windowLike.location.reloads, 0);
});

test('preload recovery clears the reload guard after a successful page load', () => {
  const windowLike = createWindow();
  windowLike.sessionStorage.setItem(PRELOAD_RECOVERY_FLAG, '1');

  installPreloadErrorRecovery(windowLike);
  windowLike.listeners.get('load')();

  assert.equal(windowLike.sessionStorage.getItem(PRELOAD_RECOVERY_FLAG), null);
});
