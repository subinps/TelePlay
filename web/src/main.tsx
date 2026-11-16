/**
 * Hearth — entry point  (README §7.1, §7.2, §7.6)
 * ─────────────────────────────────────────────────────────────────────────────
 * One React root, one React Query client, one global stylesheet.
 *
 *  · Query client is shared with lib/api so hooks and manual invalidation never speak to
 *    two different caches. If that export is not a real QueryClient (older build), a
 *    correctly configured one is created here instead of crashing the provider.
 *  · TV defaults: no refetch on focus (a remote moving focus must not trigger network),
 *    one retry for reads, zero retries for mutations (a delete must never repeat).
 *  · StrictMode is deliberately off: its development double-invoke would fire a second
 *    playback start/stop pair and consume a device slot on every mount.
 *  · Removes any static boot loader from index.html once React has painted.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { queryClient as sharedQueryClient } from './lib/api';
import './index.css';

function resolveQueryClient(): QueryClient {
    if (sharedQueryClient instanceof QueryClient) return sharedQueryClient;
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                retry: 1,
                refetchOnWindowFocus: false,
                refetchOnReconnect: true,
            },
            mutations: { retry: 0 },
        },
    });
}

const queryClient = resolveQueryClient();

function mountNode(): HTMLElement {
    const existing = document.getElementById('root');
    if (existing) return existing;
    const created = document.createElement('div');
    created.id = 'root';
    document.body.appendChild(created);
    return created;
}

/** Fade out the static splash shipped in index.html, if there is one. */
function dismissBootLoader() {
    const loader = document.getElementById('boot-loader')
        ?? document.querySelector<HTMLElement>('[data-boot-loader]');
    if (!loader) return;
    loader.style.transition = 'opacity 180ms ease';
    loader.style.opacity = '0';
    window.setTimeout(() => loader.remove(), 220);
}

/* TV browsers report odd viewport metrics; keep the theme colour in sync with the shell. */
function applyDocumentTheme() {
    document.documentElement.classList.add('hearth-root');
    document.documentElement.style.colorScheme = 'dark';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
    }
    meta.content = '#070b0b';
}

applyDocumentTheme();

const root = createRoot(mountNode());
root.render(
    <QueryClientProvider client={queryClient}>
        <App />
    </QueryClientProvider>,
);

requestAnimationFrame(() => requestAnimationFrame(dismissBootLoader));
