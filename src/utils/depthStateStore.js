const hasSameFields = (previous, next) => {
  if (previous === next) {
    return true;
  }
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key) => Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
  );
};

export const createDepthStateStore = (initialState) => {
  let snapshot = initialState;
  const listeners = new Set();

  const publish = (nextState) => {
    if (hasSameFields(snapshot, nextState)) {
      return;
    }
    snapshot = nextState;
    listeners.forEach((listener) => {
      listener();
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: publish,
    reset: publish,
    dispose: () => {
      listeners.clear();
      snapshot = initialState;
    },
  };
};
