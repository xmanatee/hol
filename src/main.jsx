import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import HomePage from './pages/HomePage.jsx';
import { installPreloadErrorRecovery } from './utils/preloadRecovery.js';
import { registerCapabilityCache } from './runtime/registerServiceWorker.js';

installPreloadErrorRecovery();
registerCapabilityCache();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HomePage />
  </StrictMode>,
);
