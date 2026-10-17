export const pageVisibility = {
  getSnapshot: () => document.visibilityState === 'visible',
  subscribe: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};
