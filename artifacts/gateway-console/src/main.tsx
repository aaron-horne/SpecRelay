import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

const dataSightsSite = import.meta.env.VITE_DATASIGHTS_SITE;
const dataSightsKey = import.meta.env.VITE_DATASIGHTS_KEY;

if (dataSightsSite && dataSightsKey) {
  const script = document.createElement('script');
  script.defer = true;
  script.dataset.site = dataSightsSite;
  script.dataset.key = dataSightsKey;
  script.src = 'https://datasights.replit.app/api/script.js';
  document.head.appendChild(script);
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
