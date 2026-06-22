let openCVRuntimePromise = null;

const getLoadedOpenCVRuntime = () => {
  if (typeof window === 'undefined') {
    throw new Error('OpenCV runtime requires a browser window');
  }

  return window.cv?.Mat ? window.cv : null;
};

const getDocument = () => {
  if (typeof document === 'undefined') {
    throw new Error('OpenCV script loading requires a browser document');
  }

  return document;
};

const waitForOpenCVRuntime = ({ timeoutMs, pollIntervalMs }) => new Promise((resolve, reject) => {
  const startedAt = Date.now();

  const poll = () => {
    const runtime = getLoadedOpenCVRuntime();
    if (runtime) {
      resolve(runtime);
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      reject(new Error(`OpenCV runtime did not initialize within ${timeoutMs}ms`));
      return;
    }

    window.setTimeout(poll, pollIntervalMs);
  };

  poll();
});

export const loadOpenCVRuntime = ({
  scriptSrc = '/opencv.js',
  timeoutMs = 10000,
  pollIntervalMs = 100,
} = {}) => {
  const loadedRuntime = getLoadedOpenCVRuntime();
  if (loadedRuntime) {
    return Promise.resolve(loadedRuntime);
  }

  if (openCVRuntimePromise) {
    return openCVRuntimePromise;
  }

  const documentRef = getDocument();
  const existingScript = documentRef.querySelector(`script[src="${scriptSrc}"]`);
  const script = existingScript || documentRef.createElement('script');

  openCVRuntimePromise = new Promise((resolve, reject) => {
    let settled = false;
    const removeScript = () => {
      script.remove();
    };

    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      script.removeEventListener('error', onError);
      callback(value);
    };

    const onError = () => {
      removeScript();
      finish(reject, new Error(`Failed to load OpenCV script: ${scriptSrc}`));
    };

    script.addEventListener('error', onError, { once: true });

    waitForOpenCVRuntime({ timeoutMs, pollIntervalMs }).then(
      runtime => finish(resolve, runtime),
      error => {
        removeScript();
        finish(reject, error);
      }
    );

    if (!existingScript) {
      script.src = scriptSrc;
      script.async = true;
      documentRef.head.appendChild(script);
    }
  }).catch(error => {
    openCVRuntimePromise = null;
    throw error;
  });

  return openCVRuntimePromise;
};
