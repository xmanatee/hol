import { useEffect, useState } from 'react';
import { pageVisibility } from '../utils/pageVisibility.js';

const appEntry = (page) => {
  const entries = page.querySelectorAll('script[type="module"][src]:not([src="/@vite/client"])');
  if (entries.length !== 1) throw new Error('App document must contain one module entry');
  return entries[0].getAttribute('src');
};

export const useAppRelease = () => {
  const [release, setRelease] = useState(() => {
    const entry = appEntry(document);
    return {
      entry,
      build: entry.split('/').at(-1),
      status: import.meta.env.DEV ? 'development' : 'checking',
      error: null,
    };
  });

  useEffect(() => {
    if (import.meta.env.DEV) return undefined;
    let request = null;
    let disposed = false;
    const check = () => {
      if (!pageVisibility.getSnapshot() || request) return;
      const controller = new AbortController();
      request = controller;
      const deadline = setTimeout(() => controller.abort(new Error('Update check timed out')), 8000);
      fetch('/', { cache: 'no-store', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}`);
          const html = new DOMParser().parseFromString(await response.text(), 'text/html');
          const entry = appEntry(html);
          if (!disposed) {
            setRelease((current) => ({
              ...current,
              status: entry === current.entry ? 'current' : 'update',
              error: null,
            }));
          }
        })
        .catch((error) => {
          if (!disposed)
            setRelease((current) => ({
              ...current,
              status: current.status === 'update' ? 'update' : 'error',
              error: error.message,
            }));
        })
        .finally(() => {
          clearTimeout(deadline);
          request = null;
        });
    };
    check();
    const unsubscribe = pageVisibility.subscribe(check);
    window.addEventListener('pageshow', check);
    return () => {
      disposed = true;
      request?.abort();
      unsubscribe();
      window.removeEventListener('pageshow', check);
    };
  }, []);

  return release;
};
