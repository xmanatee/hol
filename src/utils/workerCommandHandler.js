import { createSerialExecutor } from './serialExecutor.js';

export const createWorkerCommandHandler = ({ handlers, postMessage, getState }) => {
  const executeSerially = createSerialExecutor();
  return ({ data: { id, command, payload } }) =>
    executeSerially(async () => {
      let response;
      try {
        if (!Object.hasOwn(handlers, command)) {
          throw new Error(`Unsupported worker command: ${command}`);
        }
        response = { result: await handlers[command](payload) };
      } catch (error) {
        response = { error: error instanceof Error ? error.message : String(error) };
      }
      postMessage({
        type: 'response',
        id,
        ...response,
        ...(getState ? { state: getState() } : {}),
      });
    });
};
