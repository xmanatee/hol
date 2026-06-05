export const PRELOAD_RECOVERY_FLAG = 'hol:preload-error-reloaded';

export const installPreloadErrorRecovery = (windowObject = window) => {
  windowObject.addEventListener('vite:preloadError', (event) => {
    if (windowObject.sessionStorage.getItem(PRELOAD_RECOVERY_FLAG) === '1') {
      windowObject.sessionStorage.removeItem(PRELOAD_RECOVERY_FLAG);
      return;
    }

    event.preventDefault();
    windowObject.sessionStorage.setItem(PRELOAD_RECOVERY_FLAG, '1');
    windowObject.location.reload();
  });

  windowObject.addEventListener('load', () => {
    windowObject.sessionStorage.removeItem(PRELOAD_RECOVERY_FLAG);
  });
};
