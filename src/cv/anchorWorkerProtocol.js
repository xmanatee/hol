import { createSerialExecutor } from '../utils/serialExecutor.js';

const createMaskMetadata = (mask) => {
  const metadata = { ...mask };
  delete metadata.data;
  return metadata;
};

const createActiveAnchorSnapshot = (activeAnchor) => {
  const objectSupportMask = activeAnchor?.selectionRegion?.objectSupportMask;
  if (!objectSupportMask) {
    return activeAnchor;
  }

  return {
    ...activeAnchor,
    selectionRegion: {
      ...activeAnchor.selectionRegion,
      objectSupportMask: createMaskMetadata(objectSupportMask),
    },
  };
};

export const createAnchorWorkerSnapshot = (state) =>
  state
    ? {
        ...state,
        activeAnchor: createActiveAnchorSnapshot(state.activeAnchor),
      }
    : null;

const createSuccessResponse = ({ id, result, state }) => ({
  type: 'response',
  id,
  result,
  state: createAnchorWorkerSnapshot(state),
});

const createErrorResponse = ({ id, error, state }) => ({
  type: 'response',
  id,
  error,
  state: createAnchorWorkerSnapshot(state),
});

const processAnchorWorkerMessage = ({ event, handlers, getState, postMessage }) => {
  const { id, command, payload } = event.data;
  const handler = handlers[command];

  if (!handler) {
    postMessage(
      createErrorResponse({
        id,
        error: `Unsupported anchor worker command: ${command}`,
        state: getState(),
      }),
    );
    return Promise.resolve();
  }

  return Promise.resolve()
    .then(() => handler(payload ?? {}))
    .then((result) => {
      postMessage(createSuccessResponse({ id, result, state: getState() }));
    })
    .catch((error) => {
      postMessage(createErrorResponse({ id, error: error.message, state: getState() }));
    });
};

export const createAnchorWorkerMessageHandler = ({ handlers, getState, postMessage }) => {
  const executeSerially = createSerialExecutor();

  return (event) =>
    executeSerially(() =>
      processAnchorWorkerMessage({
        event,
        handlers,
        getState,
        postMessage,
      }),
    );
};
