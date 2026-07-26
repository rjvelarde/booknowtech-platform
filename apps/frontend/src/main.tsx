import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { loadPublicEnvironment } from './config.js';
import './styles.css';

loadPublicEnvironment();

const root = document.querySelector<HTMLDivElement>('#root');

if (!root) {
  throw new Error('Application root is unavailable');
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary supportReference={crypto.randomUUID()}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
