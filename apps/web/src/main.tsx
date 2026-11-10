import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './style.css';

const query = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><App /></QueryClientProvider>);
