import { logger } from '../utils/logger.js';

export const registerCapabilityCache = () => {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
        logger.warn('Runtime', `Capability cache registration failed: ${error.message}`);
      });
    },
    { once: true },
  );
};
