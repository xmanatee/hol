import test from 'node:test';
import assert from 'node:assert/strict';

class FakeScript {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.listeners = new Map();
    this.src = '';
    this.async = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  dispatch(type) {
    this.listeners.get(type)?.();
  }

  remove() {
    this.ownerDocument.removeScript(this);
  }
}

class FakeDocument {
  constructor() {
    this.scripts = [];
    this.head = {
      appendChild: script => {
        this.scripts.push(script);
      },
    };
  }

  createElement(tagName) {
    assert.equal(tagName, 'script');
    return new FakeScript(this);
  }

  querySelector(selector) {
    const src = selector.match(/^script\[src="(.+)"\]$/)?.[1];
    return this.scripts.find(script => script.src === src) || null;
  }

  removeScript(script) {
    this.scripts = this.scripts.filter(candidate => candidate !== script);
  }
}

const importRuntimeService = () => import(`./OpenCVRuntimeService.js?test=${Date.now()}-${Math.random()}`);

const installBrowserGlobals = t => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const timers = [];
  const documentRef = new FakeDocument();
  const windowRef = {
    cv: null,
    setTimeout: callback => {
      timers.push(callback);
      return timers.length;
    },
  };

  globalThis.window = windowRef;
  globalThis.document = documentRef;

  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  return {
    documentRef,
    windowRef,
    runTimers: () => {
      timers.splice(0).forEach(callback => callback());
    },
  };
};

test('OpenCV runtime loader coalesces concurrent script loads', async t => {
  const { loadOpenCVRuntime } = await importRuntimeService();
  const browser = installBrowserGlobals(t);

  const first = loadOpenCVRuntime({ scriptSrc: '/opencv-test.js' });
  const second = loadOpenCVRuntime({ scriptSrc: '/opencv-test.js' });

  assert.equal(first, second);
  assert.equal(browser.documentRef.scripts.length, 1);

  const runtime = { Mat: class Mat {} };
  browser.windowRef.cv = runtime;
  browser.runTimers();

  assert.equal(await first, runtime);
});

test('OpenCV runtime loader removes failed script nodes before retrying', async t => {
  const { loadOpenCVRuntime } = await importRuntimeService();
  const browser = installBrowserGlobals(t);

  const first = loadOpenCVRuntime({ scriptSrc: '/opencv-retry.js' });
  const firstScript = browser.documentRef.scripts[0];
  firstScript.dispatch('error');

  await assert.rejects(first, /Failed to load OpenCV script/);
  assert.equal(browser.documentRef.scripts.length, 0);

  const second = loadOpenCVRuntime({ scriptSrc: '/opencv-retry.js' });
  const secondScript = browser.documentRef.scripts[0];
  assert.notEqual(secondScript, firstScript);

  secondScript.dispatch('error');
  await assert.rejects(second, /Failed to load OpenCV script/);
});
