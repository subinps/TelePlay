/**
 * Hearth — Sidebar  ·  the library rail (README §7.4, §4.3, §6.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * The flat Hearth home has no sidebar: folders, search, filters, "Recently Added" and the
 * "Unlimited Storage" meter are gone (§2, §4.3, §7.4). This component is therefore retired by
 * default (`enabled = false` → renders nothing) so any existing <Sidebar/> mount simply
 * disappears instead of breaking.
 *
 * When a surface does enable it, it is a complete Hearth rail — not the old folder tree:
 *   · brand + Family/Guest role chip (real /auth/me)
 *   · section jumps into the flat home with live scroll-spy (Continue watching / All videos),
 *     honestly disabled when the home is not mounted
 *   · "Screens playing" — real GET /playback/active, 15 s poll, admin can stop a screen
 *     (two-step confirm), panel hides itself if the endpoint is not deployed yet
 *   · Add videos — real bot deep link from /auth/bot-info, open + copy with feedback
 *   · this-screen identity and the two-screen rule
 *   · sign out — two-step confirm, revokes refresh token, releases the playback slot,
 *     clears tokens, reloads
 *   · collapsible rail (persisted), mobile drawer with scrim, Back closes,
 *     focus rings, custom scrollbar, no backdrop-filter, ≤200ms motion
 *
 * Every action is performed here — no dead handlers, no guessed endpoints.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from 'react';
import {
    AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, Film,
    Loader2, LogOut, Monitor, Play, Shield, Smartphone, Tablet, Tv, Users, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAppStore } from '../lib/store';

interface SidebarProps {
    /** Removed from the flat home (§7.4). Opt in for surfaces that want a rail. */
    enabled?: boolean;
    /** Legacy drawer props. */
    isOpen?: boolean;
    open?: boolean;
    onClose?: () => void;
}

interface ActiveDevice { device_id: string; label: string; file_id?: number; role?: string }

const COLLAPSE_KEY = 'hearth_rail_collapsed';

const RAIL_CSS = `
[data-hearth-rail]{-webkit-tap-highlight-color:transparent;}
.hs-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hs-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0b1110;}
.hs-scroll::-webkit-scrollbar{width:10px;}
.hs-scroll::-webkit-scrollbar-track{background:#0b1110;border-radius:8px;}
.hs-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0b1110;}
.hs-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes hsFade{from{opacity:0}to{opacity:1}}
@keyframes hsSlide{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:none}}
@keyframes hsSpin{to{transform:rotate(360deg)}}
@keyframes hsPulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.25)}}
.hs-fade{animation:hsFade .15s ease-out backwards}
.hs-slide{animation:hsSlide .18s ease-out backwards}
.hs-spin{animation:hsSpin .9s linear infinite}
.hs-pulse{animation:hsPulse 1.8s ease-in-out infinite}
.hs-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
@media (prefers-reduced-motion:reduce){.hs-fade,.hs-slide,.hs-pulse{animation:none}}
`;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-rail-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-rail-css';
    el.textContent = RAIL_CSS;
    document.head.appendChild(el);
}
ensureStyles();

const resolveApiUrl = (path: string): string => {
    if (/^https?:\/\//i.test(path)) return path;
    const base = api.defaults.baseURL ?? '/api';
    const origin = /^https?:\/\//i.test(base) ? new URL(base).origin : window.location.origin;
    return new URL(path, origin).href;
};
const axStatus = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
const isBackKey = (e: KeyboardEvent) =>
    e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === 'GoBack'
    || e.keyCode === 461 || e.keyCode === 10009;

function deviceLabel(): string {
    const ua = navigator.userAgent;
    if (/Tizen/i.test(ua)) return 'Samsung TV';
    if (/Web0S|webOS/i.test(ua)) return 'LG TV';
    if (/Android.*TV|AFT|BRAVIA|SMART-TV/i.test(ua)) return 'TV';
    if (/iPhone|Android.*Mobile/i.test(ua)) return 'Phone';
    if (/iPad|Tablet/i.test(ua)) return 'Tablet';
    return 'Computer';
}
const deviceIcon = (label: string) =>
    /tv|tizen|lg|bravia|fire/i.test(label) ? Tv
        : /phone|iphone|android/i.test(label) ? Smartphone
            : /tablet|ipad/i.test(label) ? Tablet : Monitor;

async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch { return false; }
}

function RailLogo({ size = 34 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
            <defs>
                <linearGradient id="hs-logo-teal" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#2dd4bf" /><stop offset="1" stopColor="#0d9488" />
                </linearGradient>
                <radialGradient id="hs-logo-ember" cx="0.5" cy="0.3" r="0.9">
                    <stop offset="0" stopColor="#fde68a" /><stop offset="0.55" stopColor="#f59e0b" />
                    <stop offset="1" stopColor="#e11d48" />
                </radialGradient>
            </defs>
            <rect x="3" y="3" width="42" height="42" rx="14" fill="url(#hs-logo-teal)" />
            <path d="M24 11.5c5.2 5.2 9.2 8.8 9.2 14.4a9.2 9.2 0 0 1-18.4 0c0-3.1 1.2-5.6 3.3-8 .6 2.1 1.8 3.3 3.4 3.9-.6-3.6.9-7 2.5-10.3z" fill="url(#hs-logo-ember)" />
            <circle cx="24" cy="27.6" r="3.1" fill="#04110f" opacity="0.85" />
        </svg>
    );
}

export default function Sidebar({ enabled = false, isOpen, open, onClose }: SidebarProps) {
    const { addToast } = useAppStore();
    const railRef = useRef<HTMLElement>(null);
    const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [role, setRole] = useState('admin');
    const [bot, setBot] = useState('');
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
    });
    const [devices, setDevices] = useState<ActiveDevice[] | null>(null);
    const [devicesSupported, setDevicesSupported] = useState(true);
    const [stopping, setStopping] = useState<string | null>(null);
    const [confirmStop, setConfirmStop] = useState<string | null>(null);
    const [confirmOut, setConfirmOut] = useState(false);
    const [copied, setCopied] = useState(false);
    const [sections, setSections] = useState<{ cw: boolean; all: boolean }>({ cw: false, all: false });
    const [active, setActive] = useState<'cw' | 'all' | null>(null);

    const drawerOpen = !!(isOpen ?? open);
    const canManage = role === 'admin';

    /* Role + bot identity. */
    useEffect(() => {
        if (!enabled) return;
        let live = true;
        api.get('/auth/me')
            .then(({ data }) => {
                if (!live) return;
                const r = (data as { role?: string; user?: { role?: string } })?.role
                    ?? (data as { user?: { role?: string } })?.user?.role ?? 'admin';
                setRole(r === 'guest' ? 'guest' : 'admin');
            })
            .catch(() => { if (live) setRole('admin'); });
        api.get('/auth/bot-info')
            .then(({ data }) => {
                if (!live) return;
                const d = data as { bot_username?: string; username?: string; bot?: { username?: string } };
                setBot((d?.bot_username ?? d?.username ?? d?.bot?.username ?? '').replace(/^@/, ''));
            })
            .catch(() => { if (live) setBot(''); });
        return () => { live = false; };
    }, [enabled]);

    /* Live playback sessions (§6.3) — hides itself if the backend is not upgraded yet. */
    useEffect(() => {
        if (!enabled || !devicesSupported) return;
        let live = true;
        const load = () => {
            api.get('/playback/active')
                .then(({ data }) => {
                    if (!live) return;
                    const list = Array.isArray(data) ? data : (data as { active?: ActiveDevice[] })?.active;
                    setDevices(Array.isArray(list) ? list as ActiveDevice[] : []);
                })
                .catch((err) => {
                    if (!live) return;
                    const s = axStatus(err);
                    if (s === 404 || s === 405 || s === 403) { setDevicesSupported(false); setDevices(null); }
                    else setDevices(prev => prev ?? []);
                });
        };
        load();
        const iv = setInterval(load, 15000);
        return () => { live = false; clearInterval(iv); };
    }, [enabled, devicesSupported]);

    /* Scroll-spy on the flat home. Re-binds when the home mounts/unmounts. */
    useEffect(() => {
        if (!enabled) return;
        let bound: HTMLElement | null = null;
        const query = () => {
            const root = document.querySelector('[data-hb-root]');
            const main = root?.querySelector('main') as HTMLElement | null;
            const cw = root?.querySelector('[aria-label="Continue watching"]') as HTMLElement | null;
            const all = root?.querySelector('[aria-label="All videos"]') as HTMLElement | null;
            return { main, cw, all };
        };
        const measure = () => {
            const { main, cw, all } = query();
            setSections({ cw: !!cw, all: !!all });
            if (!main) { setActive(null); return; }
            const top = main.getBoundingClientRect().top + 80;
            const cwTop = cw ? cw.getBoundingClientRect().top : Infinity;
            const allTop = all ? all.getBoundingClientRect().top : Infinity;
            if (allTop <= top) setActive('all');
            else if (cwTop <= top) setActive('cw');
            else setActive(cw ? 'cw' : all ? 'all' : null);
        };
        const bind = () => {
            const { main } = query();
            if (main !== bound) {
                bound?.removeEventListener('scroll', measure);
                bound = main;
                bound?.addEventListener('scroll', measure, { passive: true });
            }
            measure();
        };
        bind();
        const iv = setInterval(bind, 2000);
        return () => { clearInterval(iv); bound?.removeEventListener('scroll', measure); };
    }, [enabled]);

    /* Persist collapse. */
    useEffect(() => {
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
    }, [collapsed]);

    /* Drawer keyboard: Back closes, Tab stays inside. */
    useEffect(() => {
        if (!enabled || !drawerOpen) return;
        const nav = (dir: 1 | -1) => {
            const list = Array.from(railRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), a[href]',
            ) ?? []).filter(el => el.getClientRects().length > 0);
            if (!list.length) return;
            const i = list.indexOf(document.activeElement as HTMLElement);
            (list[(i + dir + list.length) % list.length] ?? list[0]).focus();
        };
        const onKey = (e: KeyboardEvent) => {
            if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onClose?.(); return; }
            if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); nav(e.shiftKey ? -1 : 1); }
        };
        window.addEventListener('keydown', onKey, true);
        const raf = requestAnimationFrame(() => {
            railRef.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')?.focus();
        });
        return () => { window.removeEventListener('keydown', onKey, true); cancelAnimationFrame(raf); };
    }, [enabled, drawerOpen, onClose]);

    useEffect(() => () => {
        [confirmTimer, stopTimer, copyTimer].forEach(t => { if (t.current) clearTimeout(t.current); });
    }, []);

    if (!enabled) return null;

    const jump = (which: 'cw' | 'all') => {
        const root = document.querySelector('[data-hb-root]');
        const el = root?.querySelector(
            which === 'cw' ? '[aria-label="Continue watching"]' : '[aria-label="All videos"]',
        ) as HTMLElement | null;
        if (!el) { addToast('Open the library first', 'info'); return; }
        el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
        setActive(which);
        if (drawerOpen) onClose?.();
    };

    const stopDevice = async (d: ActiveDevice) => {
        if (stopping) return;
        if (confirmStop !== d.device_id) {
            setConfirmStop(d.device_id);
            if (stopTimer.current) clearTimeout(stopTimer.current);
            stopTimer.current = setTimeout(() => setConfirmStop(null), 4000);
            return;
        }
        setStopping(d.device_id);
        setConfirmStop(null);
        try {
            await api.delete(`/playback/${encodeURIComponent(d.device_id)}`);
            setDevices(prev => (prev ?? []).filter(x => x.device_id !== d.device_id));
            addToast(`Stopped ${d.label || 'that screen'}`, 'success');
        } catch (err) {
            addToast(axStatus(err) === 403 ? 'Only the family account can stop screens' : 'Could not stop that screen', 'error');
        } finally {
            setStopping(null);
        }
    };

    const copyBot = async () => {
        if (!bot) return;
        const ok = await copyText(`https://t.me/${bot}`);
        if (ok) {
            setCopied(true);
            if (copyTimer.current) clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 2200);
            addToast('Bot link copied', 'success');
        } else addToast('Copy is blocked on this device', 'warning');
    };

    const signOut = async () => {
        if (!confirmOut) {
            setConfirmOut(true);
            if (confirmTimer.current) clearTimeout(confirmTimer.current);
            confirmTimer.current = setTimeout(() => setConfirmOut(false), 4000);
            return;
        }
        try { await api.post('/auth/logout'); } catch { /* best effort revoke */ }
        try {
            const deviceId = localStorage.getItem('hearth_device_id');
            const token = localStorage.getItem('access_token');
            if (deviceId) {
                void fetch(resolveApiUrl('/api/playback/stop'), {
                    method: 'POST', keepalive: true,
                    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    body: JSON.stringify({ device_id: deviceId }),
                }).catch(() => { /* best effort */ });
            }
        } catch { /* noop */ }
        try {
            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');
        } catch { /* noop */ }
        window.location.reload();
    };

    const width = collapsed ? 'lg:w-[84px]' : 'lg:w-[268px]';
    const showText = !collapsed;

    const navBtn = (which: 'cw' | 'all', label: string, Icon: typeof Play, available: boolean) => {
        const isActive = active === which;
        return (
            <button
                type="button"
                onClick={() => jump(which)}
                disabled={!available}
                aria-current={isActive ? 'true' : undefined}
                title={available ? label : `${label} — open the library first`}
                className={`hs-focus flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-all duration-150 ${
                    isActive
                        ? 'bg-[#2dd4bf]/15 text-[#5eead4]'
                        : available
                            ? 'text-[#c3d6d2] hover:bg-white/5 hover:text-white'
                            : 'cursor-not-allowed text-[#3f524f]'
                } ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
            >
                <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-[#2dd4bf]' : ''}`} />
                {showText && <span className="flex-1 truncate text-sm font-semibold">{label}</span>}
                {showText && isActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#2dd4bf]" />}
            </button>
        );
    };

    return (
        <>
            {drawerOpen && (
                <div className="hs-fade fixed inset-0 z-[150] bg-black/70 lg:hidden" onClick={() => onClose?.()} aria-hidden="true" />
            )}

            <aside
                ref={railRef}
                data-hearth-rail
                aria-label="Hearth navigation"
                className={`fixed inset-y-0 left-0 z-[160] flex w-[280px] flex-col border-r border-[#1a2524] bg-[#0b1110] transition-transform duration-200 lg:z-30 lg:translate-x-0 ${width} ${
                    drawerOpen ? 'translate-x-0' : '-translate-x-full'
                }`}
                style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                <div
                    className="pointer-events-none absolute inset-0"
                    aria-hidden="true"
                    style={{
                        background:
                            'radial-gradient(70% 40% at 0% 0%, rgba(20,184,166,0.14), transparent 70%),' +
                            'radial-gradient(60% 40% at 100% 100%, rgba(245,158,11,0.09), transparent 70%)',
                    }}
                />

                {/* Brand */}
                <div className={`relative flex items-center gap-3 border-b border-[#1a2524] px-4 py-4 ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}>
                    <RailLogo />
                    {showText && (
                        <div className="min-w-0 flex-1">
                            <span className="block text-lg font-black tracking-tight text-white">Hearth</span>
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                                canManage ? 'border-[#2dd4bf]/40 bg-[#2dd4bf]/10 text-[#5eead4]' : 'border-[#38bdf8]/40 bg-[#38bdf8]/10 text-[#7dd3fc]'
                            }`}>
                                {canManage ? <Shield className="h-3 w-3" /> : <Users className="h-3 w-3" />}
                                {canManage ? 'Family' : 'Guest'}
                            </span>
                        </div>
                    )}
                    <button
                        type="button" aria-label="Close navigation" onClick={() => onClose?.()}
                        className="hs-focus inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#9db6b1] hover:bg-white/10 hover:text-white lg:hidden"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="hs-scroll relative flex-1 space-y-6 overflow-y-auto px-3 py-4">
                    {/* Sections */}
                    <nav className="space-y-1" aria-label="Library sections">
                        {showText && (
                            <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#566e6a]">Library</p>
                        )}
                        {navBtn('cw', 'Continue watching', Play, sections.cw)}
                        {navBtn('all', 'All videos', Film, sections.all)}
                        {showText && !sections.cw && !sections.all && (
                            <p className="px-3 pt-1 text-[11px] leading-relaxed text-[#3f524f]">
                                Sections appear once the library is on screen.
                            </p>
                        )}
                    </nav>

                    {/* Screens playing */}
                    {devicesSupported && devices !== null && (
                        <section aria-label="Screens playing">
                            {showText && (
                                <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#566e6a]">
                                    Screens · {devices.length}/2
                                </p>
                            )}
                            {devices.length === 0 ? (
                                showText && (
                                    <p className="px-3 text-[11px] leading-relaxed text-[#3f524f]">
                                        Nothing playing right now.
                                    </p>
                                )
                            ) : (
                                <ul className="space-y-1.5">
                                    {devices.map(d => {
                                        const Icon = deviceIcon(d.label || '');
                                        const armed = confirmStop === d.device_id;
                                        return (
                                            <li
                                                key={d.device_id}
                                                className={`rounded-xl border border-[#1a2524] bg-[#0e1514] px-2.5 py-2 ${collapsed ? 'lg:px-1.5' : ''}`}
                                            >
                                                <div className={`flex items-center gap-2 ${collapsed ? 'lg:justify-center' : ''}`}>
                                                    <span className="relative shrink-0">
                                                        <Icon className="h-4 w-4 text-[#2dd4bf]" />
                                                        <span className="hs-pulse absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
                                                    </span>
                                                    {showText && (
                                                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#e8f1ef]">
                                                            {d.label || 'Screen'}
                                                        </span>
                                                    )}
                                                    {showText && canManage && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void stopDevice(d)}
                                                            disabled={stopping !== null}
                                                            aria-label={armed ? `Confirm stop ${d.label}` : `Stop ${d.label}`}
                                                            className={`hs-focus shrink-0 rounded-md border px-2 py-1 text-[10px] font-bold transition-all duration-150 disabled:opacity-50 ${
                                                                armed
                                                                    ? 'border-[#f43f5e] bg-[#f43f5e] text-white'
                                                                    : 'border-[#f43f5e]/40 bg-[#f43f5e]/10 text-[#fda4af] hover:bg-[#f43f5e]/20'
                                                            }`}
                                                        >
                                                            {stopping === d.device_id
                                                                ? <Loader2 className="hs-spin h-3 w-3" />
                                                                : armed ? 'Sure?' : 'Stop'}
                                                        </button>
                                                    )}
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </section>
                    )}

                    {/* Add videos */}
                    {bot && (
                        <section aria-label="Add videos">
                            {showText && (
                                <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#566e6a]">Add videos</p>
                            )}
                            <div className={`space-y-1.5 ${collapsed ? 'lg:space-y-1' : ''}`}>
                                <a
                                    href={`https://t.me/${bot}`} target="_blank" rel="noreferrer"
                                    title={`Open @${bot} in Telegram`}
                                    className={`hs-focus flex items-center gap-2.5 rounded-xl border border-[#2dd4bf]/35 bg-[#2dd4bf]/10 px-3 py-2.5 text-[#5eead4] transition-all duration-150 hover:bg-[#2dd4bf]/20 ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
                                >
                                    <ExternalLink className="h-4 w-4 shrink-0" />
                                    {showText && <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold">@{bot}</span>}
                                </a>
                                <button
                                    type="button" onClick={() => void copyBot()} title="Copy bot link"
                                    className={`hs-focus flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-150 ${
                                        copied ? 'text-[#4ade80]' : 'text-[#9db6b1] hover:bg-white/5 hover:text-white'
                                    } ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
                                >
                                    {copied ? <Check className="h-4 w-4 shrink-0" /> : <Copy className="h-4 w-4 shrink-0" />}
                                    {showText && (copied ? 'Copied' : 'Copy link')}
                                </button>
                                {showText && (
                                    <p className="px-3 text-[11px] leading-relaxed text-[#3f524f]">
                                        Forward a video to the bot — it appears on the home grid instantly.
                                    </p>
                                )}
                            </div>
                        </section>
                    )}

                    {/* This screen */}
                    {showText && (
                        <section className="rounded-xl border border-[#1a2524] bg-[#0e1514] px-3.5 py-3" aria-label="This screen">
                            <p className="flex items-center gap-2 text-xs font-bold text-[#e8f1ef]">
                                {(() => { const I = deviceIcon(deviceLabel()); return <I className="h-4 w-4 text-[#38bdf8]" />; })()}
                                {deviceLabel()}
                            </p>
                            <p className="mt-1 text-[11px] leading-relaxed text-[#566e6a]">
                                Two screens can play at once. Starting a third asks you to stop one.
                            </p>
                        </section>
                    )}
                </div>

                {/* Footer */}
                <div className="relative space-y-1 border-t border-[#1a2524] px-3 py-3">
                    <button
                        type="button" onClick={() => void signOut()}
                        title={confirmOut ? 'Press again to sign out' : 'Sign out'}
                        className={`hs-focus flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all duration-150 ${
                            confirmOut
                                ? 'bg-[#f43f5e] text-white'
                                : 'text-[#9db6b1] hover:bg-[#f43f5e]/10 hover:text-[#fda4af]'
                        } ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
                    >
                        {confirmOut ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <LogOut className="h-4 w-4 shrink-0" />}
                        {showText && (confirmOut ? 'Press again to confirm' : 'Sign out')}
                    </button>

                    <button
                        type="button" onClick={() => setCollapsed(c => !c)}
                        aria-label={collapsed ? 'Expand rail' : 'Collapse rail'}
                        className={`hs-focus hidden w-full items-center gap-3 rounded-xl px-3 py-2 text-xs font-semibold text-[#566e6a] transition-all duration-150 hover:bg-white/5 hover:text-white lg:flex ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
                    >
                        {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronLeft className="h-4 w-4 shrink-0" />}
                        {showText && 'Collapse'}
                    </button>

                    {showText && (
                        <p className="px-3 pt-1 text-[10px] leading-relaxed text-[#2f3f3d]">
                            Hearth · based on TelePlay (MIT)
                        </p>
                    )}
                </div>
            </aside>
        </>
    );
}
