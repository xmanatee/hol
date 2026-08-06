export const createSerialExecutor = () => {
  let tail = Promise.resolve();
  const settleQueue = () => undefined;

  return (operation) => {
    if (typeof operation !== 'function') {
      throw new TypeError('Serial executor operation must be a function');
    }

    const result = tail.then(operation);
    tail = result.then(settleQueue, settleQueue);
    return result;
  };
};
