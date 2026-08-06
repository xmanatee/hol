import { createSerialExecutor } from '../utils/serialExecutor.js';

const processXFeatWorkerMessage = ({ event, handlers, postMessage }) => {
  const { id, command, payload } = event.data;
  const handler = handlers[command];
  if (!handler) {
    postMessage({ id, error: `Unknown XFeat worker command: ${command}` });
    return Promise.resolve();
  }

  return Promise.resolve(handler(payload)).then(
    (result) => postMessage({ id, result }),
    (error) => postMessage({ id, error: error.message }),
  );
};

export const createXFeatWorkerMessageHandler = ({ handlers, postMessage }) => {
  const executeSerially = createSerialExecutor();
  return (event) =>
    executeSerially(() =>
      processXFeatWorkerMessage({
        event,
        handlers,
        postMessage,
      }),
    );
};
