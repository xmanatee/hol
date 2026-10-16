import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import CameraView from './views/CameraView.jsx';
import { registerCapabilityCache } from './runtime/registerServiceWorker.js';

registerCapabilityCache();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CameraView />
  </StrictMode>,
);
