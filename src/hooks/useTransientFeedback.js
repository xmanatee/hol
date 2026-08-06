import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const FEEDBACK_SEVERITIES = new Set(['info', 'good', 'warn', 'bad']);

export const createTransientFeedbackStore = ({
  durationMs = 3500,
  schedule = globalThis.setTimeout.bind(globalThis),
  cancel = globalThis.clearTimeout.bind(globalThis),
} = {}) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new TypeError('Feedback duration must be a positive finite number');
  }
  if (typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('Feedback scheduling requires callable schedule and cancel functions');
  }

  let feedback = null;
  let timeoutId = null;
  const listeners = new Set();

  const publish = (nextFeedback) => {
    feedback = nextFeedback;
    listeners.forEach((listener) => {
      listener();
    });
  };

  const clearTimer = () => {
    if (timeoutId === null) {
      return;
    }
    cancel(timeoutId);
    timeoutId = null;
  };

  return {
    getSnapshot: () => feedback,
    subscribe: (listener) => {
      if (typeof listener !== 'function') {
        throw new TypeError('Feedback subscriber must be a function');
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show: (message, severity = 'info') => {
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new TypeError('Feedback message must be a non-empty string');
      }
      if (!FEEDBACK_SEVERITIES.has(severity)) {
        throw new TypeError(`Unsupported feedback severity: ${severity}`);
      }

      clearTimer();
      publish({ message, severity });
      timeoutId = schedule(() => {
        timeoutId = null;
        publish(null);
      }, durationMs);
    },
    dispose: () => {
      clearTimer();
      listeners.clear();
      feedback = null;
    },
  };
};

export const useTransientFeedback = () => {
  const [store] = useState(createTransientFeedbackStore);
  const feedback = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => () => store.dispose(), [store]);

  const showFeedback = useCallback(
    (message, severity = 'info') => {
      store.show(message, severity);
    },
    [store],
  );

  return { feedback, showFeedback };
};
