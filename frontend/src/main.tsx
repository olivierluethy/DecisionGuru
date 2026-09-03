import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { get, set, del } from 'idb-keyval';
import App from './App';
import { initRouter } from './lib/router';
import { initPwa } from './lib/pwa';
import './index.css';

const DAY = 24 * 60 * 60 * 1000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Recent values are reused instead of refetched on every mount; still refreshed
      // in the background once past staleTime (stale-while-revalidate).
      staleTime: 5 * 60_000,
      // Inactive data is kept long enough to be persisted and rehydrated after a reload.
      gcTime: DAY,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Persist the query cache in IndexedDB so a full page reload paints the last-known
// values instantly (no all-from-scratch spinner), then revalidates in the background.
const persister = createAsyncStoragePersister({
  storage: { getItem: get, setItem: set, removeItem: del },
  key: 'decisionguru-query-cache',
  throttleTime: 1_000,
});

// Bind the URL hash to the navigation store before the first render so a shared
// deep link (e.g. #/research/AAPL) lands on the right view immediately.
initRouter();

// Register the service worker and capture the install prompt. Must run before first paint:
// `beforeinstallprompt` fires once and early, and a missed event cannot be recovered.
initPwa();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: DAY,
        // Bump when cached shapes change so stale persisted data is discarded on deploy.
        buster: 'v1',
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => query.state.status === 'success',
        },
      }}
    >
      <App />
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
