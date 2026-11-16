/**
 * Hearth — MediaPlayer (TV-first, remote-first)
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS REVISION
 *  · INSTANT START (P1): exports prewarmPlayback() so a card can start the session
 *    on focus/hover; the player consumes that warm session and mounts <video>
 *    immediately. The old "wait for /files/{id} AND /playback/start" gate is gone —
 *    resume position comes from the grid data we already have.
 *  · SETTINGS RELAYOUT: Speed → Quality → Audio → Subtitles → Info (bottom).
 *    Aspect is OUT of the panel.
 *  · CROP BUTTON left of the gear, cycles fit → fill → stretch → fit (key: c).
 *  · QUALITY 480p / 720p / 1080p(Original). Enabled only when the server reports a
 *    prepared rendition; otherwise disabled with the reason + admin Prepare action.
 *    Switching preserves the exact timestamp.
 *  · AUDIO uses native audioTracks when the browser exposes them (Safari), else the
 *    server-probed track list. Chrome has not implemented track switching, so
 *    non-native selection is gated on the server remux capability — never a dead control.
 *  · ERROR HONESTY: on a media error we probe the stream URL for the real HTTP status,
 *    so a 500 is reported as a server problem, not a codec problem.
 *
 * Kept: Back button always exits · controls stay while buffering · deduped progress ·
 *       pointer-events passthrough so clicking the picture toggles play/pause ·
 *       signed per-file/per-device tokens · 409 device-limit dialog · 410 takeover card ·
 *       full remote key map · minimize bar.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    FocusEvent as ReactFocusEvent,
    MouseEvent as ReactMouseEvent,
    PointerEvent as ReactPointerEvent,
    ReactNode,
    Ref,
} from 'react';
import {
    ArrowLeft, AlertTriangle, Check, ChevronDown, ChevronUp, Crop, FastForward,
    Film, Gauge, Info, Layers, Loader2, Maximize, Minimize, Minus, Monitor, Music,
    Pause, PictureInPicture2, Play, Plus, RectangleHorizontal, Rewind, RotateCcw,
    Settings, Smartphone, Sparkles, StretchHorizontal, Subtitles, Tablet, Tv, Users,
    Volume1, Volume2, VolumeX, X,
} from 'lucide-react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';

/* ═══════════════════════════ Types & constants ═══════════════════════════ */

interface Rendition { label?: string; height: number; file_id: number }
interface AudioTrackMeta { index: number; label?: string; language?: string; codec?: string; default?: boolean }
interface SubtitleTrack { lang: string; label: string; url: string }

type PlayerFile = TelegramFile & {
    mime_type?: string | null;
    completed?: boolean;
    file_size?: number;
    width?: number | null;
    height?: number | null;
    subtitles?: SubtitleTrack[];
    renditions?: Rendition[];
    audio_tracks?: AudioTrackMeta[];
    audio_remux?: boolean;
};
interface ActiveDevice { device_id: string; label: string; file_id: number; role: string }
interface AudioTrackInfo { index: number; label: string; enabled: boolean }
type Aspect = 'fit' | 'fill' | 'stretch';
type SessionPhase = 'starting' | 'ready' | 'limited' | 'ended' | 'error';
type ToastKind = 'info' | 'success' | 'error';
interface Prefs { volume: number; muted: boolean; rate: number; aspect: Aspect; subtitleLang: string }
type MutableRef<T> = { current: T | null };

const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const ASPECT_ORDER: Aspect[] = ['fit', 'fill', 'stretch'];
const ASPECT_META: Record<Aspect, { label: string; hint: string; icon: typeof Crop }> = {
    fit: { label: 'Fit', hint: 'Whole picture', icon: RectangleHorizontal },
    fill: { label: 'Fill', hint: 'Crop to screen', icon: Crop },
    stretch: { label: 'Stretch', hint: 'Distort to fill', icon: StretchHorizontal },
};
const ASPECT_FIT: Record<Aspect, 'contain' | 'cover' | 'fill'> = { fit: 'contain', fill: 'cover', stretch: 'fill' };
const QUALITIES: { label: string; height: number }[] = [
    { label: '480p', height: 480 },
    { label: '720p', height: 720 },
    { label: '1080p', height: 1080 },
];
const PREFS_KEY = 'hearth_player_prefs';
const DEVICE_KEY = 'hearth_device_id';
const DEFAULT_PREFS: Prefs = { volume: 1, muted: false, rate: 1, aspect: 'fit', subtitleLang: 'off' };

const BTN_PRIMARY =
    'hp-focus inline-flex items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] ' +
    'shadow-[0_8px_30px_-6px_rgba(45,212,191,0.55)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.98]';
const BTN_GHOST =
    'hp-focus inline-flex items-center justify-center gap-2 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 ' +
    'text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.98]';

const PLAYER_CSS = `
[data-hp-root]{-webkit-tap-highlight-color:transparent;}
[data-hp-root] .hp-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hp-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.hp-scroll::-webkit-scrollbar{width:10px;}
.hp-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hp-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0e1514;}
.hp-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes hpSpin{to{transform:rotate(360deg)}}
@keyframes hpFadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes hpScaleIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@keyframes hpSlideIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes hpGlow{0%,100%{box-shadow:0 0 0 0 rgba(45,212,191,.30)}50%{box-shadow:0 0 36px 6px rgba(45,212,191,.22)}}
.hp-fade-up{animation:hpFadeUp .2s ease-out backwards}
.hp-scale-in{animation:hpScaleIn .16s ease-out backwards}
.hp-slide-in{animation:hpSlideIn .2s ease-out backwards}
.hp-spin{animation:hpSpin .9s linear infinite}
.hp-glow{animation:hpGlow 2.4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.hp-fade-up,.hp-scale-in,.hp-slide-in,.hp-glow{animation:none}}
`;

/* ═══════════════════════════════ Utilities ═══════════════════════════════ */

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const fmtTime = (s: number) => formatDuration(Number.isFinite(s) && s > 0 ? Math.floor(s) : 0);
const fmtBytes = (b?: number) => {
    if (!b || b <= 0) return '';
    if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
    if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
    return `${Math.round(b / 1024)} KB`;
};
const containerOf = (name: string, mime?: string | null) => {
    const m = /\.([a-z0-9]{2,4})$/i.exec(name || '');
    if (m) return m[1].toUpperCase();
    if (mime?.includes('matroska')) return 'MKV';
    if (mime?.startsWith('video/')) return mime.slice(6).toUpperCase();
    return 'MEDIA';
};
const axStatus = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
const axDetail = (e: unknown) =>
    (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;

const resolveApiUrl = (path: string): string => {
    if (/^https?:\/\//i.test(path)) return path;
    const base = api.defaults.baseURL ?? '/api';
    const origin = /^https?:\/\//i.test(base) ? new URL(base).origin : window.location.origin;
    return new URL(path, origin).href;
};

function getDeviceId(): string {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id) {
            id = (crypto as { randomUUID?: () => string })?.randomUUID?.()
                ?? `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch {
        return `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    }
}
function getDeviceLabel(): string {
    const ua = navigator.userAgent;
    if (/Tizen/i.test(ua)) return 'Samsung TV';
    if (/Web0S|webOS/i.test(ua)) return 'LG TV';
    if (/Android.*TV|AFT|BRAVIA|SMART-TV/i.test(ua)) return 'TV';
    if (/iPhone|Android.*Mobile/i.test(ua)) return 'Phone';
    if (/iPad|Tablet/i.test(ua)) return 'Tablet';
    return 'Computer';
}
const isTV = () => /SMART-TV|Tizen|Web0S|HbbTV|BRAVIA|AFT|Android.*TV/i.test(navigator.userAgent);
const deviceIcon = (label: string) =>
    /tv|tizen|lg|bravia|fire/i.test(label) ? Tv
        : /phone|iphone|android/i.test(label) ? Smartphone
            : /tablet|ipad/i.test(label) ? Tablet : Monitor;

function loadPrefs(): Prefs {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) {
            const p = JSON.parse(raw) as Partial<Prefs>;
            return {
                volume: clamp(Number(p.volume ?? 1), 0, 1),
                muted: !!p.muted,
                rate: SPEEDS.includes(Number(p.rate)) ? Number(p.rate) : 1,
                aspect: ASPECT_ORDER.includes(p.aspect as Aspect) ? (p.aspect as Aspect) : 'fit',
                subtitleLang: typeof p.subtitleLang === 'string' ? p.subtitleLang : 'off',
            };
        }
    } catch { /* private mode / old TV */ }
    return { ...DEFAULT_PREFS };
}

let roleCache: string | null = null;
let rolePromise: Promise<string> | null = null;
function fetchRole(): Promise<string> {
    if (roleCache) return Promise.resolve(roleCache);
    if (!rolePromise) {
        rolePromise = api.get('/auth/me')
            .then(({ data }) => {
                const r = (data as { role?: string; user?: { role?: string } })?.role
                    ?? (data as { user?: { role?: string } })?.user?.role ?? 'admin';
                roleCache = r === 'guest' ? 'guest' : 'admin';
                return roleCache;
            })
            .catch(() => { roleCache = 'admin'; return roleCache; });
    }
    return rolePromise;
}

const thumbCache = new Map<number, string>();
const thumbOrder: number[] = [];
function useThumbnail(fileId: number, url?: string | null): string | null {
    const [src, setSrc] = useState<string | null>(() => thumbCache.get(fileId) ?? null);
    useEffect(() => {
        let live = true;
        const cached = thumbCache.get(fileId);
        if (cached) { setSrc(cached); return; }
        if (!url) { setSrc(null); return; }
        api.get(resolveApiUrl(url), { responseType: 'blob' })
            .then(({ data }) => {
                if (!live) return;
                const u = URL.createObjectURL(data as Blob);
                thumbCache.set(fileId, u);
                thumbOrder.push(fileId);
                if (thumbOrder.length > 24) {
                    const old = thumbOrder.shift();
                    if (old !== undefined) {
                        const ou = thumbCache.get(old);
                        if (ou) URL.revokeObjectURL(ou);
                        thumbCache.delete(old);
                    }
                }
                setSrc(u);
            })
            .catch(() => { if (live) setSrc(null); });
        return () => { live = false; };
    }, [fileId, url]);
    return src;
}

function stopPlaybackRequest(deviceId: string) {
    try {
        const token = localStorage.getItem('access_token');
        void fetch(resolveApiUrl('/api/playback/stop'), {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ device_id: deviceId }),
        }).catch(() => { /* best effort */ });
    } catch { /* best effort */ }
}

/* ═══════════════════ P1 · Pre-warm (import from the grid) ═══════════════════
 * Focus/hover a card → the session, the Telegram message and the cross-DC media
 * session are all warmed before OK is pressed. Re-starting the SAME device never
 * consumes a second slot, so the 2-screen limit is unaffected.
 * ═══════════════════════════════════════════════════════════════════════════ */

interface PrewarmEntry { src: string; mode: 'signed' | 'legacy'; beatSec: number; at: number }
const PREWARM_TTL = 4 * 60 * 1000;
const prewarmCache = new Map<number, PrewarmEntry>();
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let prewarmTarget: number | null = null;

function freshPrewarm(fileId: number): PrewarmEntry | null {
    const hit = prewarmCache.get(fileId);
    if (!hit) return null;
    if (Date.now() - hit.at > PREWARM_TTL) { prewarmCache.delete(fileId); return null; }
    return hit;
}

export function takePrewarm(fileId: number): PrewarmEntry | null {
    const hit = freshPrewarm(fileId);
    if (hit) prewarmCache.delete(fileId);
    return hit;
}

export function clearPrewarm(): void {
    prewarmCache.clear();
    prewarmTarget = null;
    if (prewarmTimer) { clearTimeout(prewarmTimer); prewarmTimer = null; }
}

/** Debounced: only the card the user settles on is warmed. */
export function prewarmPlayback(file: TelegramFile): void {
    if (!file?.id || freshPrewarm(file.id)) return;
    prewarmTarget = file.id;
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
        prewarmTimer = null;
        void doPrewarm(file);
    }, 220);
}

async function doPrewarm(file: TelegramFile): Promise<void> {
    if (prewarmTarget !== file.id || freshPrewarm(file.id)) return;
    try {
        const { data } = await api.post('/playback/start', {
            file_id: file.id, device_id: getDeviceId(), device_label: getDeviceLabel(),
        });
        const d = data as { stream_url?: string; heartbeat_seconds?: number };
        if (!d?.stream_url || prewarmTarget !== file.id) return;
        const entry: PrewarmEntry = {
            src: resolveApiUrl(d.stream_url),
            mode: 'signed',
            beatSec: clamp(Number(d.heartbeat_seconds) || 20, 5, 60),
            at: Date.now(),
        };
        prewarmCache.set(file.id, entry);
        while (prewarmCache.size > 4) {
            const oldest = prewarmCache.keys().next().value as number | undefined;
            if (oldest === undefined) break;
            prewarmCache.delete(oldest);
        }
        // Two bytes: warms the Telegram message, the DC media session and the head cache.
        void fetch(entry.src, { headers: { Range: 'bytes=0-1' } }).catch(() => { /* best effort */ });
    } catch {
        /* pre-warm is opportunistic — never surface an error for it */
    }
}

/* ═════════════════ Playback session (start / heartbeat / limit) ═════════════════ */

interface PlaybackSession {
    phase: SessionPhase;
    src: string | null;
    mode: 'signed' | 'legacy';
    active: ActiveDevice[];
    error: string | null;
    deviceId: string;
    retry: () => void;
}

function usePlaybackSession(fileId: number, legacyUrl: string | null | undefined, audioIndex: number | null): PlaybackSession {
    const [attempt, setAttempt] = useState(0);
    const [phase, setPhase] = useState<SessionPhase>('starting');
    const [src, setSrc] = useState<string | null>(null);
    const [mode, setMode] = useState<'signed' | 'legacy'>('signed');
    const [active, setActive] = useState<ActiveDevice[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [beatSec, setBeatSec] = useState(20);
    const deviceId = useRef(getDeviceId()).current;
    const modeRef = useRef(mode);
    modeRef.current = mode;

    useEffect(() => {
        let cancelled = false;
        setError(null);

        const withAudio = (url: string) =>
            audioIndex && audioIndex > 0 ? `${url}${url.includes('?') ? '&' : '?'}audio=${audioIndex}` : url;

        // A pre-warmed session means zero network wait before <video> mounts.
        const warm = audioIndex ? null : takePrewarm(fileId);
        if (warm) {
            setMode(warm.mode);
            setBeatSec(warm.beatSec);
            setSrc(warm.src);
            setPhase('ready');
            return () => { cancelled = true; };
        }

        setPhase('starting'); setSrc(null);
        (async () => {
            try {
                const { data } = await api.post('/playback/start', {
                    file_id: fileId, device_id: deviceId, device_label: getDeviceLabel(),
                });
                if (cancelled) return;
                const d = data as { stream_url?: string; heartbeat_seconds?: number };
                if (!d?.stream_url) throw new Error('missing stream_url');
                setMode('signed');
                setBeatSec(clamp(Number(d.heartbeat_seconds) || 20, 5, 60));
                setSrc(withAudio(resolveApiUrl(d.stream_url)));
                setPhase('ready');
            } catch (err) {
                if (cancelled) return;
                const status = axStatus(err);
                const detail = axDetail(err);
                if (status === 409 && typeof detail === 'object' && detail
                    && (detail as { code?: string }).code === 'DEVICE_LIMIT') {
                    setActive(((detail as { active?: ActiveDevice[] }).active) ?? []);
                    setPhase('limited');
                    return;
                }
                const routeMissing = status === 405
                    || (status === 404 && (typeof detail !== 'string' || detail === 'Not Found'));
                if (routeMissing && legacyUrl) {
                    const token = localStorage.getItem('access_token') ?? '';
                    const sep = legacyUrl.includes('?') ? '&' : '?';
                    setMode('legacy');
                    setSrc(withAudio(resolveApiUrl(`${legacyUrl}${sep}token=${encodeURIComponent(token)}`)));
                    setPhase('ready');
                    return;
                }
                if (status === 404) setError('This file is no longer in the library. It may have been deleted from Telegram.');
                else if (status === 401) setError('Your sign-in expired. Close the player and sign in again.');
                else if (status === 503) setError('Telegram is not reachable right now. Nothing was lost — try again in a moment.');
                else setError('Could not start playback. Check your connection and try again.');
                setPhase('error');
            }
        })();
        return () => { cancelled = true; };
    }, [fileId, attempt, deviceId, legacyUrl, audioIndex]);

    useEffect(() => () => {
        if (modeRef.current === 'signed') stopPlaybackRequest(deviceId);
    }, [deviceId]);

    useEffect(() => {
        if (mode !== 'signed' || phase !== 'ready') return;
        const iv = setInterval(async () => {
            try {
                await api.post('/playback/heartbeat', { device_id: deviceId, file_id: fileId });
            } catch (err) {
                if (axStatus(err) === 410) setPhase('ended');
            }
        }, beatSec * 1000);
        return () => clearInterval(iv);
    }, [mode, phase, beatSec, fileId, deviceId]);

    const retry = useCallback(() => setAttempt(a => a + 1), []);
    return { phase, src, mode, active, error, deviceId, retry };
}

/* ═══════════════════════════════ UI atoms ═══════════════════════════════ */

function HearthMark() {
    return (
        <div className="flex items-center gap-2.5">
            <span className="hp-glow relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#2dd4bf] to-[#0d9488]">
                <span className="h-3.5 w-3.5 rounded-full bg-[#04110f]" />
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#5eead4]" />
            </span>
            <span className="text-2xl font-black tracking-tight text-[#e8f1ef]">Hearth</span>
        </div>
    );
}

function IconBtn({ label, onClick, children, refEl, active = false, className = '' }: {
    label: string;
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
    children: ReactNode;
    refEl?: Ref<HTMLButtonElement>;
    active?: boolean;
    className?: string;
}) {
    return (
        <button
            type="button" ref={refEl} aria-label={label} title={label} onClick={onClick}
            className={`hp-focus relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-150 active:scale-90 ${
                active ? 'bg-[#2dd4bf]/20 text-[#5eead4]' : 'text-[#e8f1ef]/85 hover:bg-white/10 hover:text-white'
            } ${className}`}
        >
            {children}
        </button>
    );
}

function Chip({ selected, onClick, children, autofocus = false, disabled = false, title }: {
    selected: boolean; onClick: () => void; children: ReactNode;
    autofocus?: boolean; disabled?: boolean; title?: string;
}) {
    return (
        <button
            type="button" onClick={onClick} aria-pressed={selected} disabled={disabled} title={title}
            data-hp-autofocus={autofocus || undefined}
            className={`hp-focus inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all duration-150 ${
                disabled
                    ? 'cursor-not-allowed border-[#1a2524] bg-[#101918] text-[#3f524f]'
                    : selected
                        ? 'border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#5eead4]'
                        : 'border-[#2b3a38] bg-[#141d1c] text-[#c3d6d2] hover:border-[#2dd4bf]/50 hover:text-white'
            }`}
        >
            {children}
        </button>
    );
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Gauge; children: ReactNode }) {
    return (
        <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[#9db6b1]">
            <Icon className="h-4 w-4 text-[#2dd4bf]" /> {children}
        </h3>
    );
}

function InfoRow({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
            <dt className="shrink-0 text-[#9db6b1]">{k}</dt>
            <dd className="truncate text-right font-semibold text-[#e8f1ef]">{v}</dd>
        </div>
    );
}

function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
    return (
        <p className={`mt-2 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed ${
            tone === 'warn'
                ? 'border-[#fbbf24]/25 bg-[#fbbf24]/10 text-[#fbbf24]/90'
                : 'border-[#1a2524] bg-[#141d1c] text-[#9db6b1]'
        }`}>
            {children}
        </p>
    );
}

/* ═══════════════════════════ Scrubber ═══════════════════════════ */

function Scrubber({ duration, sec, disabled, fillRef, bufRef, thumbRef, scrubberRef, onSeek, onDragState }: {
    duration: number; sec: number; disabled?: boolean;
    fillRef: MutableRef<HTMLDivElement>; bufRef: MutableRef<HTMLDivElement>; thumbRef: MutableRef<HTMLDivElement>;
    scrubberRef: MutableRef<HTMLDivElement>;
    onSeek: (t: number) => void; onDragState: (dragging: boolean) => void;
}) {
    const trackRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);
    const [preview, setPreview] = useState<number | null>(null);

    const ratioAt = (clientX: number) => {
        const r = trackRef.current?.getBoundingClientRect();
        if (!r || r.width === 0) return 0;
        return clamp((clientX - r.left) / r.width, 0, 1);
    };
    const paint = (t: number) => {
        const r = duration > 0 ? clamp(t / duration, 0, 1) : 0;
        if (fillRef.current) fillRef.current.style.transform = `scaleX(${r})`;
        if (thumbRef.current) thumbRef.current.style.left = `${r * 100}%`;
    };
    const down = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (disabled || duration <= 0) return;
        e.preventDefault();
        scrubberRef.current?.focus();
        draggingRef.current = true;
        onDragState(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older WebViews */ }
        const t = ratioAt(e.clientX) * duration;
        setPreview(t); paint(t);
    };
    const move = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!draggingRef.current) return;
        const t = ratioAt(e.clientX) * duration;
        setPreview(t); paint(t);
    };
    const up = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        onDragState(false);
        const t = ratioAt(e.clientX) * duration;
        setPreview(null);
        onSeek(t);
    };
    const cancel = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        onDragState(false);
        setPreview(null);
    };

    const shown = preview ?? sec;
    const pct = duration > 0 ? clamp(shown / duration, 0, 1) : 0;

    return (
        <div
            ref={scrubberRef} data-hp-scrubber data-hp-controls
            role="slider" tabIndex={disabled ? -1 : 0} aria-label="Seek"
            aria-valuemin={0} aria-valuemax={Math.max(0, Math.floor(duration))}
            aria-valuenow={Math.floor(shown)}
            aria-valuetext={`${fmtTime(shown)} of ${fmtTime(duration)}`}
            className="hp-focus group relative flex-1 cursor-pointer select-none py-3"
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
        >
            <div ref={trackRef} className="relative h-1.5 rounded-full bg-white/15 transition-all duration-150 group-hover:h-2.5 group-focus:h-2.5">
                <div ref={bufRef} className="absolute inset-0 origin-left rounded-full bg-white/25" style={{ transform: 'scaleX(0)' }} />
                <div ref={fillRef} className="absolute inset-0 origin-left rounded-full bg-gradient-to-r from-[#0d9488] via-[#2dd4bf] to-[#5eead4]" style={{ transform: 'scaleX(0)' }} />
                <div ref={thumbRef} className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: '0%' }}>
                    <div className="h-4 w-4 rounded-full bg-white shadow-[0_0_0_4px_rgba(45,212,191,0.35),0_2px_10px_rgba(0,0,0,0.6)] transition-transform duration-150 group-hover:scale-125 group-focus:scale-125" />
                </div>
                {preview !== null && (
                    <div
                        className="absolute -top-9 z-20 -translate-x-1/2 rounded-lg border border-[#2b3a38] bg-[#0e1514] px-2.5 py-1 font-mono text-xs font-bold text-[#5eead4] shadow-xl"
                        style={{ left: `${clamp(pct * 100, 4, 96)}%` }}
                    >
                        {fmtTime(preview)}
                    </div>
                )}
            </div>
        </div>
    );
}

function VolumeBar({ value, muted, onChange }: { value: number; muted: boolean; onChange: (v: number) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const drag = useRef(false);
    const eff = muted ? 0 : value;
    const setAt = (clientX: number) => {
        const r = ref.current?.getBoundingClientRect();
        if (!r || r.width === 0) return;
        onChange(clamp((clientX - r.left) / r.width, 0, 1));
    };
    return (
        <div
            ref={ref} data-hp-vol data-hp-controls role="slider" tabIndex={0} aria-label="Volume"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(eff * 100)}
            aria-valuetext={`${Math.round(eff * 100)} percent`}
            className="hp-focus relative hidden h-9 w-24 cursor-pointer items-center sm:flex"
            onPointerDown={(e) => { drag.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ } setAt(e.clientX); }}
            onPointerMove={(e) => { if (drag.current) setAt(e.clientX); }}
            onPointerUp={() => { drag.current = false; }}
            onPointerCancel={() => { drag.current = false; }}
        >
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-[#2dd4bf] transition-[width] duration-100" style={{ width: `${eff * 100}%` }} />
            </div>
        </div>
    );
}

/* ═══════════════════ Settings: Speed → Quality → Audio → Subs → Info ═══════════════════ */

function SettingsPanel({
    panelRef, onClose, prefs, onRate,
    qualities, currentQuality, onQuality, canPrepare, onPrepare, preparing,
    nativeAudio, serverAudio, audioRemux, currentAudio, onNativeAudio, onServerAudio,
    subs, onSubtitle, info,
}: {
    panelRef: MutableRef<HTMLDivElement>;
    onClose: () => void;
    prefs: Prefs;
    onRate: (r: number) => void;
    qualities: { label: string; height: number; fileId: number | null }[];
    currentQuality: number;
    onQuality: (height: number, fileId: number | null) => void;
    canPrepare: boolean;
    onPrepare: () => void;
    preparing: boolean;
    nativeAudio: AudioTrackInfo[];
    serverAudio: AudioTrackMeta[];
    audioRemux: boolean;
    currentAudio: number;
    onNativeAudio: (index: number) => void;
    onServerAudio: (index: number) => void;
    subs: SubtitleTrack[];
    onSubtitle: (lang: string) => void;
    info: { k: string; v: string }[];
}) {
    const anyLower = qualities.some(q => q.height < 1080 && q.fileId !== null);
    return (
        <div className="absolute inset-0 z-[120]">
            <div className="pointer-events-auto absolute inset-0 bg-black/55" onClick={onClose} aria-hidden="true" />
            <div
                ref={panelRef} role="dialog" aria-modal="true" aria-label="Player settings"
                className="hp-slide-in pointer-events-auto absolute inset-y-0 right-0 flex w-[min(400px,94vw)] flex-col border-l border-[#1a2524] bg-[#0e1514] shadow-[-30px_0_60px_rgba(0,0,0,0.55)]"
            >
                <div className="flex items-center justify-between border-b border-[#1a2524] px-5 py-4">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-[#e8f1ef]">
                        <Settings className="h-5 w-5 text-[#2dd4bf]" /> Settings
                    </h2>
                    <IconBtn label="Close settings" onClick={onClose}><X className="h-5 w-5" /></IconBtn>
                </div>

                <div className="hp-scroll flex-1 space-y-7 overflow-y-auto px-5 py-5">
                    {/* 1 · SPEED */}
                    <section>
                        <SectionTitle icon={Gauge}>Speed</SectionTitle>
                        <div className="flex flex-wrap gap-2">
                            {SPEEDS.map(s => (
                                <Chip key={s} selected={prefs.rate === s} autofocus={prefs.rate === s} onClick={() => onRate(s)}>
                                    {prefs.rate === s && <Check className="h-3.5 w-3.5" />}{s}×
                                </Chip>
                            ))}
                        </div>
                    </section>

                    {/* 2 · QUALITY */}
                    <section>
                        <SectionTitle icon={Layers}>Quality</SectionTitle>
                        <div className="grid grid-cols-3 gap-2">
                            {qualities.map(q => {
                                const available = q.fileId !== null;
                                const sel = currentQuality === q.height;
                                return (
                                    <button
                                        key={q.height} type="button" disabled={!available}
                                        aria-pressed={sel}
                                        title={available ? `${q.label}${q.height === 1080 ? ' — original' : ''}` : `${q.label} has not been prepared for this video`}
                                        onClick={() => onQuality(q.height, q.fileId)}
                                        className={`hp-focus flex flex-col items-center gap-1 rounded-xl border px-2 py-3 transition-all duration-150 ${
                                            !available
                                                ? 'cursor-not-allowed border-[#1a2524] bg-[#101918] text-[#3f524f]'
                                                : sel
                                                    ? 'border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#5eead4]'
                                                    : 'border-[#2b3a38] bg-[#141d1c] text-[#c3d6d2] hover:border-[#2dd4bf]/50 hover:text-white'
                                        }`}
                                    >
                                        <span className="text-sm font-bold">{q.label}</span>
                                        <span className="text-[10px] text-[#9db6b1]">
                                            {q.height === 1080 ? 'Original' : available ? 'Ready' : 'Not prepared'}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        {!anyLower && (
                            <>
                                <Note>
                                    Only the original is stored on Telegram. Lower qualities must be prepared once on the
                                    server — they are never re-encoded on the fly.
                                </Note>
                                {canPrepare && (
                                    <button
                                        type="button" onClick={onPrepare} disabled={preparing}
                                        className="hp-focus mt-2 inline-flex items-center gap-2 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-3.5 py-2 text-xs font-bold text-[#5eead4] transition-all duration-150 hover:bg-[#2dd4bf]/20 disabled:opacity-50"
                                    >
                                        {preparing ? <Loader2 className="hp-spin h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                                        {preparing ? 'Requesting…' : 'Prepare 480p / 720p'}
                                    </button>
                                )}
                            </>
                        )}
                    </section>

                    {/* 3 · AUDIO */}
                    <section>
                        <SectionTitle icon={Music}>Audio</SectionTitle>
                        {nativeAudio.length > 1 ? (
                            <div className="flex flex-wrap gap-2">
                                {nativeAudio.map(t => (
                                    <Chip key={t.index} selected={t.enabled} onClick={() => onNativeAudio(t.index)}>
                                        {t.enabled && <Check className="h-3.5 w-3.5" />}{t.label}
                                    </Chip>
                                ))}
                            </div>
                        ) : serverAudio.length > 1 ? (
                            <>
                                <div className="flex flex-wrap gap-2">
                                    {serverAudio.map(t => {
                                        const label = t.label || t.language || `Track ${t.index + 1}`;
                                        const sel = currentAudio === t.index;
                                        return (
                                            <Chip
                                                key={t.index} selected={sel} disabled={!audioRemux}
                                                title={audioRemux ? label : 'This browser cannot switch tracks; server remux is not enabled yet'}
                                                onClick={() => onServerAudio(t.index)}
                                            >
                                                {sel && <Check className="h-3.5 w-3.5" />}
                                                {label}{t.codec ? ` · ${t.codec}` : ''}
                                            </Chip>
                                        );
                                    })}
                                </div>
                                {!audioRemux && (
                                    <Note tone="warn">
                                        This browser can’t switch embedded audio tracks itself. Choosing another track needs
                                        the server to remux it (video untouched, audio converted) — that pipeline isn’t enabled yet.
                                    </Note>
                                )}
                            </>
                        ) : (
                            <Note>This file has a single audio track.</Note>
                        )}
                    </section>

                    {/* 4 · SUBTITLES */}
                    <section>
                        <SectionTitle icon={Subtitles}>Subtitles</SectionTitle>
                        {subs.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                                <Chip selected={prefs.subtitleLang === 'off'} onClick={() => onSubtitle('off')}>Off</Chip>
                                {subs.map(s => (
                                    <Chip key={s.lang} selected={prefs.subtitleLang === s.lang} onClick={() => onSubtitle(s.lang)}>
                                        {prefs.subtitleLang === s.lang && <Check className="h-3.5 w-3.5" />}{s.label || s.lang}
                                    </Chip>
                                ))}
                            </div>
                        ) : (
                            <Note>
                                No subtitles for this file. Send a sidecar <span className="font-mono text-[#c3d6d2]">.srt</span> to the bot to add them.
                            </Note>
                        )}
                    </section>

                    {/* 5 · INFO (bottom) */}
                    <section>
                        <SectionTitle icon={Info}>Info</SectionTitle>
                        <dl className="rounded-xl border border-[#1a2524] bg-[#141d1c] px-4 py-2">
                            {info.map(r => <InfoRow key={r.k} k={r.k} v={r.v} />)}
                        </dl>
                        <p className="mt-2 text-xs leading-relaxed text-[#758f8a]">
                            Original quality — Hearth relays the file untouched from Telegram. Stuttering usually means the
                            network is slower than the video bitrate, or the codec is heavy for this device.
                        </p>
                    </section>
                </div>
            </div>
        </div>
    );
}

/* ═══════════════════════ Dialogs ═══════════════════════ */

function CardShell({ dialogRef, children }: { dialogRef: MutableRef<HTMLDivElement>; children: ReactNode }) {
    return (
        <div className="pointer-events-auto absolute inset-0 z-[110] flex items-center justify-center bg-black/70 p-6">
            <div
                ref={dialogRef} role="dialog" aria-modal="true"
                className="hp-scale-in w-full max-w-md rounded-2xl border border-[#1a2524] bg-[#0e1514] p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_50px_-18px_rgba(45,212,191,0.35)]"
            >
                {children}
            </div>
        </div>
    );
}

function DeviceLimitDialog({ dialogRef, active, role, busy, onKick, onRetry, onClose }: {
    dialogRef: MutableRef<HTMLDivElement>; active: ActiveDevice[]; role: string; busy: string | null;
    onKick: (d: ActiveDevice) => void; onRetry: () => void; onClose: () => void;
}) {
    return (
        <CardShell dialogRef={dialogRef}>
            <div className="mb-4 flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10">
                    <Users className="h-6 w-6 text-[#38bdf8]" />
                </span>
                <div>
                    <h2 className="text-lg font-bold text-[#e8f1ef]">Two devices are already playing</h2>
                    <p className="text-sm text-[#9db6b1]">Hearth allows 2 screens at once.</p>
                </div>
            </div>
            <ul className="mb-5 space-y-2">
                {active.map(d => {
                    const Icon = deviceIcon(d.label);
                    return (
                        <li key={d.device_id} className="flex items-center gap-3 rounded-xl border border-[#1a2524] bg-[#141d1c] px-3.5 py-2.5">
                            <Icon className="h-5 w-5 shrink-0 text-[#2dd4bf]" />
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#e8f1ef]">{d.label || 'Device'}</span>
                            <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                                d.role === 'admin' ? 'bg-[#2dd4bf]/15 text-[#5eead4]' : 'bg-[#38bdf8]/15 text-[#7dd3fc]'
                            }`}>
                                {d.role === 'admin' ? 'Family' : 'Guest'}
                            </span>
                            {role === 'admin' && (
                                <button
                                    type="button" disabled={busy !== null} onClick={() => onKick(d)}
                                    className="hp-focus inline-flex items-center gap-1.5 rounded-lg border border-[#f43f5e]/40 bg-[#f43f5e]/10 px-3 py-1.5 text-xs font-bold text-[#fda4af] transition-all duration-150 hover:bg-[#f43f5e]/20 disabled:opacity-50"
                                >
                                    {busy === d.device_id ? <Loader2 className="hp-spin h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                                    Stop
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {role !== 'admin' && (
                <p className="mb-4 text-sm text-[#9db6b1]">Ask the family account to stop one of them, or try again in a moment.</p>
            )}
            <div className="flex gap-3">
                <button type="button" onClick={onRetry} className={`${BTN_PRIMARY} flex-1`}>
                    <RotateCcw className="h-4 w-4" /> Try again
                </button>
                <button type="button" onClick={onClose} className={BTN_GHOST}>Close</button>
            </div>
        </CardShell>
    );
}

function EndedCard({ dialogRef, onRetry, onClose }: { dialogRef: MutableRef<HTMLDivElement>; onRetry: () => void; onClose: () => void }) {
    return (
        <CardShell dialogRef={dialogRef}>
            <div className="mb-4 flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10">
                    <Tv className="h-6 w-6 text-[#38bdf8]" />
                </span>
                <div>
                    <h2 className="text-lg font-bold text-[#e8f1ef]">Playback stopped</h2>
                    <p className="text-sm text-[#9db6b1]">Another device took over this session.</p>
                </div>
            </div>
            <p className="mb-5 text-sm leading-relaxed text-[#c3d6d2]">
                Your progress was saved. You can take the session back here, or close the player.
            </p>
            <div className="flex gap-3">
                <button type="button" onClick={onRetry} className={`${BTN_PRIMARY} flex-1`}>
                    <Play className="h-4 w-4" /> Watch here again
                </button>
                <button type="button" onClick={onClose} className={BTN_GHOST}>Close</button>
            </div>
        </CardShell>
    );
}

function ErrorCard({ dialogRef, message, onRetry, onClose }: {
    dialogRef: MutableRef<HTMLDivElement>; message: string; onRetry: () => void; onClose: () => void;
}) {
    return (
        <CardShell dialogRef={dialogRef}>
            <div className="mb-4 flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#fbbf24]/30 bg-[#fbbf24]/10">
                    <AlertTriangle className="h-6 w-6 text-[#fbbf24]" />
                </span>
                <div>
                    <h2 className="text-lg font-bold text-[#e8f1ef]">Playback problem</h2>
                    <p className="text-sm text-[#9db6b1]">Nothing was lost — your progress is saved.</p>
                </div>
            </div>
            <p className="mb-5 text-sm leading-relaxed text-[#c3d6d2]">{message}</p>
            <div className="flex gap-3">
                <button type="button" onClick={onRetry} className={`${BTN_PRIMARY} flex-1`}>
                    <RotateCcw className="h-4 w-4" /> Try again
                </button>
                <button type="button" onClick={onClose} className={BTN_GHOST}>Close</button>
            </div>
        </CardShell>
    );
}

/* ═══════════════════════════════ Root wrapper ═══════════════════════════════ */

export default function MediaPlayer() {
    const { previewFile, setPreviewFile, isPlayerMinimized, setPlayerMinimized } = useAppStore();
    if (!previewFile) return null;
    return (
        <MediaPlayerContent
            key={previewFile.id}
            file={previewFile as PlayerFile}
            onClose={() => setPreviewFile(null)}
            isMinimized={isPlayerMinimized}
            setMinimized={setPlayerMinimized}
        />
    );
}

interface MediaPlayerContentProps {
    file: PlayerFile;
    onClose: () => void;
    isMinimized: boolean;
    setMinimized: (minimized: boolean) => void;
}

/* ═══════════════════════════════ The player ═══════════════════════════════ */

function MediaPlayerContent({ file, onClose, isMinimized, setMinimized }: MediaPlayerContentProps) {
    /* Quality / audio switching keeps the player mounted and preserves the timestamp. */
    const [activeId, setActiveId] = useState(file.id);
    const [audioIndex, setAudioIndex] = useState<number | null>(null);

    const { data: extendedFile } = useFile(activeId);
    const { mutate: updateProgress } = useUpdateProgress();
    const details: PlayerFile = (extendedFile as PlayerFile | undefined) ?? file;

    const isVideo = details.file_type === 'video' || (details.mime_type ?? '').startsWith('video/');
    const container = containerOf(details.file_name, details.mime_type);
    const riskyContainer = ['MKV', 'AVI', 'WMV', 'FLV', 'TS'].includes(container)
        || (details.mime_type ?? '').includes('matroska');
    const subs: SubtitleTrack[] = Array.isArray(details.subtitles) ? details.subtitles.filter(s => s?.url && s?.lang) : [];
    const renditions: Rendition[] = Array.isArray(details.renditions) ? details.renditions.filter(r => r?.file_id && r?.height) : [];
    const serverAudio: AudioTrackMeta[] = Array.isArray(details.audio_tracks) ? details.audio_tracks : [];
    const audioRemux = details.audio_remux === true;
    const thumbSrc = useThumbnail(file.id, details.thumbnail_url);
    const deviceLabel = getDeviceLabel();

    const { phase, src, mode, active, error: sessionError, deviceId, retry } =
        usePlaybackSession(activeId, file.stream_url, audioIndex);

    /* INSTANT START: no waiting on /files/{id} — the grid already gave us the basics. */
    const videoMounted = !!src && (phase === 'ready' || phase === 'ended');

    /* ── State ── */
    const [playing, setPlaying] = useState(false);
    const [sec, setSec] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffering, setBuffering] = useState(true);
    const [bufferedAhead, setBufferedAhead] = useState(0);
    const [mediaError, setMediaError] = useState<string | null>(null);
    const [finished, setFinished] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPiP, setIsPiP] = useState(false);
    const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
    const [resumeToast, setResumeToast] = useState(false);
    const [seekFlash, setSeekFlash] = useState<{ dir: 1 | -1; total: number } | null>(null);
    const [toasts, setToasts] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
    const [role, setRole] = useState<string>('admin');
    const [nativeAudio, setNativeAudio] = useState<AudioTrackInfo[]>([]);
    const [kickBusy, setKickBusy] = useState<string | null>(null);
    const [preparing, setPreparing] = useState(false);
    const [fsSupported] = useState(() => typeof document !== 'undefined' && !!document.fullscreenEnabled);
    const [pipSupported] = useState(() => typeof document !== 'undefined' && !!document.pictureInPictureEnabled);

    /* ── Refs ── */
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const ctlWrapRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const scrubberRef = useRef<HTMLDivElement>(null);
    const playBtnRef = useRef<HTMLButtonElement>(null);
    const settingsBtnRef = useRef<HTMLButtonElement>(null);
    const cropBtnRef = useRef<HTMLButtonElement>(null);
    const backBtnRef = useRef<HTMLButtonElement>(null);
    const replayBtnRef = useRef<HTMLButtonElement>(null);
    const fillRef = useRef<HTMLDivElement>(null);
    const bufRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const miniFillRef = useRef<HTMLDivElement>(null);

    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bufTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
    const toastId = useRef(0);
    const holdRef = useRef<{ dir: number; start: number; total: number; last: number } | null>(null);
    const dragRef = useRef(false);
    const durationRef = useRef(0);
    const lastPosRef = useRef(0);
    const lastSavedRef = useRef<{ pos: number; dur: number }>({ pos: -1, dur: -1 });
    const resumePointRef = useRef<number | null>(null);
    const resumeAppliedRef = useRef(false);
    const metaLoadedRef = useRef(false);
    const pendingSeekRef = useRef<number | null>(null);
    const seenSrcRef = useRef<string | null>(null);
    const playingRef = useRef(false);
    const bufferingRef = useRef(true);
    const settingsOpenRef = useRef(false);
    const focusInCtlRef = useRef(false);
    const dialogOpenRef = useRef(false);
    const prefsRef = useRef(prefs);
    const mediaErrorRef = useRef<string | null>(null);

    const dialogOpen = phase === 'limited' || phase === 'ended' || !!sessionError || !!mediaError;
    const effectiveShow = showControls || !playing || buffering || settingsOpen || dialogOpen;
    playingRef.current = playing;
    bufferingRef.current = buffering;
    settingsOpenRef.current = settingsOpen;
    dialogOpenRef.current = dialogOpen;
    prefsRef.current = prefs;
    mediaErrorRef.current = mediaError;
    durationRef.current = duration || details.duration || 0;

    /* Resume point from the grid data we already have — refined when details land. */
    const computeResume = (f: PlayerFile) => {
        const pos = f.last_pos ?? 0;
        const dur = f.duration ?? 0;
        return !f.completed && pos > 5 && (dur <= 0 || pos < dur * 0.95) ? pos : 0;
    };
    if (resumePointRef.current === null) resumePointRef.current = computeResume(file);
    useEffect(() => {
        if (!resumeAppliedRef.current && extendedFile && pendingSeekRef.current === null) {
            resumePointRef.current = computeResume(extendedFile as PlayerFile);
        }
    }, [extendedFile]);

    /* ── Toasts ── */
    const pushToast = useCallback((msg: string, kind: ToastKind = 'info') => {
        const id = ++toastId.current;
        setToasts(t => [...t.slice(-2), { id, msg, kind }]);
        const tm = setTimeout(() => {
            setToasts(t => t.filter(x => x.id !== id));
            toastTimers.current.delete(id);
        }, 3200);
        toastTimers.current.set(id, tm);
    }, []);

    /* ── Progress (deduped) ── */
    const saveProgress = useCallback((force = false) => {
        const v = videoRef.current;
        if (!v || mediaErrorRef.current) return;
        const pos = Math.floor(v.currentTime || 0);
        if (pos <= 0) return;
        const d = Number.isFinite(v.duration) && v.duration > 0 ? Math.floor(v.duration) : 0;
        const last = lastSavedRef.current;
        if (!force && Math.abs(pos - last.pos) < 1 && d === last.dur) return;
        lastSavedRef.current = { pos, dur: d };
        lastPosRef.current = pos;
        updateProgress({ fileId: file.id, position: pos, duration: d });
    }, [file.id, updateProgress]);
    const saveRef = useRef(saveProgress);
    saveRef.current = saveProgress;

    useEffect(() => {
        const iv = setInterval(() => {
            if (playingRef.current && !mediaErrorRef.current) saveProgress();
        }, 10000);
        return () => clearInterval(iv);
    }, [saveProgress]);

    useEffect(() => () => saveRef.current(true), []);

    useEffect(() => {
        const flush = () => saveRef.current(true);
        const vis = () => { if (document.visibilityState === 'hidden') flush(); };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', vis);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', vis);
        };
    }, []);

    /* ── Bars via refs ── */
    const syncBars = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        const d = v.duration;
        if (!Number.isFinite(d) || d <= 0) return;
        const r = clamp(v.currentTime / d, 0, 1);
        if (!dragRef.current) {
            if (fillRef.current) fillRef.current.style.transform = `scaleX(${r})`;
            if (thumbRef.current) thumbRef.current.style.left = `${(r * 100).toFixed(3)}%`;
        }
        let end = 0;
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) {
            if (b.start(i) <= v.currentTime + 0.05 && b.end(i) >= v.currentTime) { end = b.end(i); break; }
        }
        if (bufRef.current) bufRef.current.style.transform = `scaleX(${clamp(end / d, 0, 1)})`;
        if (miniFillRef.current) miniFillRef.current.style.transform = `scaleX(${r})`;
        const ahead = Math.max(0, Math.floor(end - v.currentTime));
        setBufferedAhead(p => (p === ahead ? p : ahead));
    }, []);

    const onTimeUpdate = () => {
        const v = videoRef.current;
        if (!v) return;
        lastPosRef.current = v.currentTime;
        syncBars();
        const s = Math.floor(v.currentTime);
        setSec(p => (p === s ? p : s));
    };

    /* ── Transport ── */
    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused || v.ended) v.play().catch(() => { /* autoplay policy */ });
        else v.pause();
    }, []);
    const playMedia = () => { videoRef.current?.play().catch(() => { /* noop */ }); };
    const pauseMedia = () => { videoRef.current?.pause(); };

    const seekTo = useCallback((t: number) => {
        const v = videoRef.current;
        if (!v) return;
        const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : durationRef.current;
        if (!Number.isFinite(d) || d <= 0) return;
        v.currentTime = clamp(t, 0, Math.max(0, d - 0.25));
        setFinished(false);
        setSec(Math.floor(v.currentTime));
        syncBars();
    }, [syncBars]);

    const seekBy = (delta: number, flashTotal?: number) => {
        const v = videoRef.current;
        if (!v) return;
        seekTo(v.currentTime + delta);
        setSeekFlash({ dir: delta < 0 ? -1 : 1, total: flashTotal ?? Math.abs(delta) });
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setSeekFlash(null), 800);
    };

    const holdSeek = (dir: 1 | -1, repeat: boolean) => {
        const now = performance.now();
        let h = holdRef.current;
        if (!repeat || !h || h.dir !== dir || now - h.last > 900) {
            h = { dir, start: now, total: 0, last: now };
            holdRef.current = h;
        }
        const held = now - h.start;
        const step = held > 1400 ? 60 : held > 600 ? 30 : 10;
        h.total += step;
        h.last = now;
        seekBy(dir * step, h.total);
    };

    /* ── Controls ── */
    const revealControls = useCallback(() => {
        setShowControls(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
            if (playingRef.current && !bufferingRef.current && !settingsOpenRef.current
                && !focusInCtlRef.current && !dragRef.current && !dialogOpenRef.current) {
                setShowControls(false);
            }
        }, 4000);
    }, []);

    const hideControlsNow = useCallback(() => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        const wrap = ctlWrapRef.current;
        if (wrap && document.activeElement && wrap.contains(document.activeElement)) {
            containerRef.current?.focus();
        }
        setShowControls(false);
    }, []);

    useEffect(() => {
        if (playing && !buffering) revealControls();
        else {
            if (hideTimer.current) clearTimeout(hideTimer.current);
            setShowControls(true);
        }
    }, [playing, buffering, revealControls]);

    /* ── Prefs ── */
    const patchPrefs = useCallback((p: Partial<Prefs>) => setPrefs(prev => ({ ...prev, ...p })), []);

    const applySubtitleMode = () => {
        const v = videoRef.current;
        if (!v) return;
        const want = prefsRef.current.subtitleLang;
        const tt = v.textTracks;
        for (let i = 0; i < tt.length; i++) {
            const tr = tt[i];
            if (tr.kind === 'subtitles' || tr.kind === 'captions') {
                tr.mode = want !== 'off' && (tr.language || String(i)) === want ? 'showing' : 'disabled';
            }
        }
    };

    useEffect(() => {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* noop */ }
        const v = videoRef.current;
        if (v) {
            v.volume = prefs.volume;
            v.muted = prefs.muted;
            v.playbackRate = prefs.rate;
            v.defaultPlaybackRate = prefs.rate;
        }
        applySubtitleMode();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefs]);

    const setVolumeLevel = (val: number) => {
        const nv = clamp(val, 0, 1);
        patchPrefs({ volume: nv, muted: nv === 0 });
    };
    const stepVolume = (d: number) => {
        const cur = prefsRef.current.muted ? 0 : prefsRef.current.volume;
        setVolumeLevel(Math.round((cur + d) * 10) / 10);
    };
    const toggleMute = () => patchPrefs({ muted: !prefsRef.current.muted });
    const setRate = (r: number) => patchPrefs({ rate: r });
    const stepRate = (d: number) => {
        const i = SPEEDS.indexOf(prefsRef.current.rate);
        const ni = clamp((i < 0 ? 2 : i) + d, 0, SPEEDS.length - 1);
        setRate(SPEEDS[ni]);
        pushToast(`Speed ${SPEEDS[ni]}×`, 'info');
    };

    /* Crop cycler: fit → fill → stretch → fit */
    const cycleAspect = () => {
        const i = ASPECT_ORDER.indexOf(prefsRef.current.aspect);
        const next = ASPECT_ORDER[(i + 1) % ASPECT_ORDER.length];
        patchPrefs({ aspect: next });
        pushToast(`${ASPECT_META[next].label} — ${ASPECT_META[next].hint}`, 'success');
    };

    /* ── Native audio tracks (Safari exposes them; Chrome does not) ── */
    const collectNativeAudio = () => {
        const v = videoRef.current as (HTMLVideoElement & { audioTracks?: { length: number;[i: number]: { label?: string; language?: string; enabled: boolean } } }) | null;
        const at = v?.audioTracks;
        if (at && at.length) {
            const list: AudioTrackInfo[] = [];
            for (let i = 0; i < at.length; i++) {
                list.push({ index: i, label: at[i].label || at[i].language || `Track ${i + 1}`, enabled: !!at[i].enabled });
            }
            setNativeAudio(list);
        } else setNativeAudio([]);
    };
    const selectNativeAudio = (index: number) => {
        const v = videoRef.current as (HTMLVideoElement & { audioTracks?: { length: number;[i: number]: { enabled: boolean } } }) | null;
        const at = v?.audioTracks;
        if (!at) return;
        for (let i = 0; i < at.length; i++) at[i].enabled = i === index;
        collectNativeAudio();
    };

    /* ── Restart helpers that preserve the timestamp ── */
    const restartAt = (pos: number) => {
        pendingSeekRef.current = pos;
        resumeAppliedRef.current = false;
        metaLoadedRef.current = false;
        setBuffering(true);
        setMediaError(null);
        setFinished(false);
    };

    const currentQuality = (() => {
        if (activeId === file.id) return 1080;
        return renditions.find(r => r.file_id === activeId)?.height ?? 1080;
    })();

    const qualities = QUALITIES.map(q => ({
        ...q,
        fileId: q.height === 1080 ? file.id : (renditions.find(r => r.height === q.height)?.file_id ?? null),
    }));

    const switchQuality = (height: number, fileId: number | null) => {
        if (fileId === null) return;
        if (fileId === activeId) { closeSettings(); return; }
        const pos = videoRef.current?.currentTime ?? lastPosRef.current;
        saveRef.current(true);
        restartAt(pos);
        setActiveId(fileId);
        pushToast(`Quality: ${height === 1080 ? '1080p (Original)' : `${height}p`}`, 'success');
        closeSettings();
    };

    const switchServerAudio = (index: number) => {
        if (!audioRemux) return;
        const pos = videoRef.current?.currentTime ?? lastPosRef.current;
        saveRef.current(true);
        restartAt(pos);
        setAudioIndex(index);
        const t = serverAudio.find(x => x.index === index);
        pushToast(`Audio: ${t?.label || t?.language || `Track ${index + 1}`}`, 'success');
        closeSettings();
    };

    const prepareRenditions = async () => {
        setPreparing(true);
        try {
            await api.post(`/files/${file.id}/prepare`, { heights: [480, 720] });
            pushToast('Preparation started — qualities appear when ready', 'success');
            closeSettings();
        } catch (err) {
            pushToast(
                axStatus(err) === 404 || axStatus(err) === 405
                    ? 'Server-side preparation isn’t enabled yet.'
                    : axStatus(err) === 403
                        ? 'Only the family account can prepare qualities.'
                        : 'Could not start preparation. Try again.',
                'error',
            );
        } finally {
            setPreparing(false);
        }
    };

    /* ── Fullscreen / PiP ── */
    const toggleFullscreen = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        try {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* noop */ });
            else if (el.requestFullscreen) void el.requestFullscreen().catch(() => { /* noop */ });
        } catch { /* TV browsers without the API */ }
    }, []);

    useEffect(() => {
        const h = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', h);
        return () => document.removeEventListener('fullscreenchange', h);
    }, []);

    const togglePiP = async () => {
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await videoRef.current?.requestPictureInPicture();
        } catch { /* unsupported */ }
    };

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const on = () => setIsPiP(true);
        const off = () => setIsPiP(false);
        v.addEventListener('enterpictureinpicture', on);
        v.addEventListener('leavepictureinpicture', off);
        return () => {
            v.removeEventListener('enterpictureinpicture', on);
            v.removeEventListener('leavepictureinpicture', off);
        };
    }, [videoMounted]);

    /* ── Close / minimize / settings ── */
    const closePlayer = useCallback(() => {
        saveRef.current(true);
        try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* noop */ }); } catch { /* noop */ }
        try { if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => { /* noop */ }); } catch { /* noop */ }
        onClose();
    }, [onClose]);

    const minimize = () => {
        setSettingsOpen(false);
        try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* noop */ }); } catch { /* noop */ }
        setMinimized(true);
    };

    const openSettings = () => setSettingsOpen(true);
    const closeSettings = useCallback(() => {
        setSettingsOpen(false);
        settingsBtnRef.current?.focus();
    }, []);

    const chooseRate = (r: number) => { setRate(r); pushToast(`Speed ${r}×`, 'success'); closeSettings(); };
    const chooseSubtitle = (lang: string) => {
        patchPrefs({ subtitleLang: lang });
        pushToast(lang === 'off' ? 'Subtitles off' : `Subtitles: ${subs.find(s => s.lang === lang)?.label || lang}`, 'success');
        closeSettings();
    };
    const chooseNativeAudio = (index: number) => {
        selectNativeAudio(index);
        pushToast(`Audio: ${nativeAudio.find(t => t.index === index)?.label ?? `Track ${index + 1}`}`, 'success');
        closeSettings();
    };

    const handleBack = () => {
        if (settingsOpen) { closeSettings(); return; }
        if (dialogOpen) { closePlayer(); return; }
        if (playing && !buffering && effectiveShow) {
            hideControlsNow();
            containerRef.current?.focus();
            return;
        }
        closePlayer();
    };

    /* ── Session reactions ── */
    useEffect(() => {
        if (phase === 'ended') {
            videoRef.current?.pause();
            saveRef.current(true);
            setMinimized(false);
        }
    }, [phase, setMinimized]);

    useEffect(() => { if (dialogOpen) setSettingsOpen(false); }, [dialogOpen]);

    useEffect(() => {
        if (!src) return;
        if (seenSrcRef.current && seenSrcRef.current !== src) {
            if (pendingSeekRef.current === null) {
                resumePointRef.current = lastPosRef.current > 1 ? lastPosRef.current : resumePointRef.current;
            }
            resumeAppliedRef.current = false;
            metaLoadedRef.current = false;
        }
        seenSrcRef.current = src;
    }, [src]);

    const retryAll = () => {
        setFinished(false);
        if (phase !== 'ready') { setMediaError(null); retry(); return; }
        const v = videoRef.current;
        setMediaError(null);
        if (v) {
            restartAt(lastPosRef.current > 1 ? lastPosRef.current : (resumePointRef.current ?? 0));
            v.load();
            v.play().catch(() => { /* noop */ });
        }
    };

    const kickDevice = async (d: ActiveDevice) => {
        setKickBusy(d.device_id);
        try {
            await api.delete(`/playback/${encodeURIComponent(d.device_id)}`);
            pushToast(`Stopped ${d.label || 'device'}`, 'success');
            retry();
        } catch (err) {
            pushToast(axStatus(err) === 403 ? 'Only the family account can stop devices.' : 'Could not stop that device.', 'error');
        } finally {
            setKickBusy(null);
        }
    };

    useEffect(() => {
        let live = true;
        void fetchRole().then(r => { if (live) setRole(r); });
        return () => { live = false; };
    }, []);

    /* ── Buffering debounce ── */
    const startBuf = () => {
        if (bufTimer.current) clearTimeout(bufTimer.current);
        bufTimer.current = setTimeout(() => setBuffering(true), 300);
    };
    const endBuf = () => {
        if (bufTimer.current) clearTimeout(bufTimer.current);
        setBuffering(false);
    };

    /* ── Resume applied once metadata AND a position are known ── */
    const applyResumeOnce = () => {
        const v = videoRef.current;
        if (!v || resumeAppliedRef.current || !metaLoadedRef.current) return;
        resumeAppliedRef.current = true;
        const forced = pendingSeekRef.current;
        pendingSeekRef.current = null;
        const at = forced ?? resumePointRef.current ?? 0;
        const d = v.duration;
        if (at > 0 && Number.isFinite(d) && at < d - 2) {
            v.currentTime = at;
            setSec(Math.floor(at));
            if (forced === null) {
                setResumeToast(true);
                if (resumeTimer.current) clearTimeout(resumeTimer.current);
                resumeTimer.current = setTimeout(() => setResumeToast(false), 6500);
            }
        }
    };

    useEffect(() => { applyResumeOnce(); });

    const onLoadedMetadata = () => {
        const v = videoRef.current;
        if (!v) return;
        metaLoadedRef.current = true;
        if (Number.isFinite(v.duration) && v.duration > 0) {
            setDuration(v.duration);
            durationRef.current = v.duration;
        }
        v.volume = prefsRef.current.volume;
        v.muted = prefsRef.current.muted;
        v.playbackRate = prefsRef.current.rate;
        v.defaultPlaybackRate = prefsRef.current.rate;
        applyResumeOnce();
        applySubtitleMode();
        collectNativeAudio();
        syncBars();
        v.play().catch(() => { /* gesture policy — the big play button shows */ });
    };

    /* Honest errors: ask the server what actually happened before blaming the codec. */
    const onMediaError = async () => {
        const code = videoRef.current?.error?.code ?? 0;
        let serverMsg: string | null = null;
        if (src && (code === 4 || code === 2)) {
            try {
                const r = await fetch(src, { headers: { Range: 'bytes=0-1' } });
                if (!r.ok) {
                    if (r.status >= 500) serverMsg = `The server could not read this file from Telegram (HTTP ${r.status}). Your device is fine — try again in a moment.`;
                    else if (r.status === 404) serverMsg = 'This file is no longer available on the server. It may have been deleted from Telegram.';
                    else if (r.status === 401 || r.status === 403) serverMsg = 'The stream token expired or another screen took the slot. Try again.';
                    else if (r.status === 416) serverMsg = 'The server could not serve that part of the file. Try again.';
                    else serverMsg = `The server refused the stream (HTTP ${r.status}).`;
                }
            } catch { /* offline — fall through to the network message */ }
        }
        if (!videoRef.current) return;

        let msg: string;
        if (serverMsg) msg = serverMsg;
        else if (code === 4 && riskyContainer) {
            msg = `This device can't decode ${container} (often HEVC video or AC3 audio inside). Try a phone or PC, or ask for an MP4 (H.264 + AAC) version.`;
        } else if (code === 4) {
            msg = 'This device can\u2019t decode this file\u2019s format.';
        } else if (code === 3) {
            msg = 'Playback failed while decoding. The file may be corrupted or use a codec this device can\u2019t handle.';
        } else if (code === 2) {
            msg = 'The network dropped while streaming. Check the connection and try again.';
        } else {
            msg = 'Something went wrong while playing this file.';
        }
        setMediaError(msg);
        setBuffering(false);
        setPlaying(false);
    };

    const onEnded = () => {
        setPlaying(false);
        setFinished(true);
        const v = videoRef.current;
        if (v && Number.isFinite(v.duration)) {
            lastSavedRef.current = { pos: Math.floor(v.duration), dur: Math.floor(v.duration) };
            updateProgress({ fileId: file.id, position: Math.floor(v.duration), duration: Math.floor(v.duration) });
        }
    };

    const onVolumeChange = () => {
        const v = videoRef.current;
        if (!v) return;
        const p = prefsRef.current;
        if (Math.abs(v.volume - p.volume) > 0.001 || v.muted !== p.muted) {
            setPrefs(prev => ({ ...prev, volume: v.volume, muted: v.muted }));
        }
    };
    const onRateChange = () => {
        const v = videoRef.current;
        if (v && v.playbackRate !== prefsRef.current.rate) patchPrefs({ rate: v.playbackRate });
    };

    /* ── Focus ── */
    useEffect(() => {
        if (!isMinimized) containerRef.current?.focus({ preventScroll: true });
    }, [isMinimized, videoMounted]);

    useEffect(() => {
        if (!settingsOpen) return;
        const id = requestAnimationFrame(() => {
            const el = panelRef.current?.querySelector<HTMLElement>('[data-hp-autofocus]')
                ?? panelRef.current?.querySelector<HTMLElement>('button:not([disabled])');
            el?.focus();
        });
        return () => cancelAnimationFrame(id);
    }, [settingsOpen]);

    useEffect(() => {
        if (!dialogOpen) return;
        const id = requestAnimationFrame(() => {
            dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
        });
        return () => cancelAnimationFrame(id);
    }, [dialogOpen, phase, mediaError, sessionError]);

    useEffect(() => {
        if (!finished) return;
        const id = requestAnimationFrame(() => replayBtnRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, [finished]);

    const onFocusCapture = (e: ReactFocusEvent<HTMLDivElement>) => {
        const t = e.target as HTMLElement;
        focusInCtlRef.current = !!t.closest?.('[data-hp-controls]');
        revealControls();
    };
    const onBlurCapture = (e: ReactFocusEvent<HTMLDivElement>) => {
        const to = e.relatedTarget as HTMLElement | null;
        focusInCtlRef.current = !!(to && to.closest?.('[data-hp-controls]'));
    };

    useEffect(() => {
        const tz = (window as unknown as { tizen?: { tvinputdevice?: { registerKey?: (k: string) => void; unregisterKey?: (k: string) => void } } }).tizen;
        const keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward'];
        try { keys.forEach(k => tz?.tvinputdevice?.registerKey?.(k)); } catch { /* not Tizen */ }
        return () => { try { keys.forEach(k => tz?.tvinputdevice?.unregisterKey?.(k)); } catch { /* noop */ } };
    }, []);

    /* ── Remote / keyboard ── */
    useEffect(() => {
        const nav = (el: HTMLElement | null, dir: 1 | -1) => {
            if (!el) return;
            const items = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [role="slider"][tabindex="0"], a[href]'))
                .filter(x => x.getClientRects().length > 0);
            if (!items.length) return;
            const i = items.indexOf(document.activeElement as HTMLElement);
            const next = items[(i + dir + items.length) % items.length] ?? items[0];
            next.focus();
        };

        const onKeyDown = (e: KeyboardEvent) => {
            const k = e.key;
            const code = e.keyCode;

            if (k === 'MediaPlayPause' || k === 'MediaTogglePlayPause' || code === 179) { e.preventDefault(); togglePlay(); return; }
            if (k === 'MediaPlay' || code === 415) { e.preventDefault(); playMedia(); return; }
            if (k === 'MediaPause' || code === 19) { e.preventDefault(); pauseMedia(); return; }
            if (k === 'MediaStop' || code === 413) { e.preventDefault(); closePlayer(); return; }
            if (k === 'MediaFastForward' || code === 417) { e.preventDefault(); seekBy(30); return; }
            if (k === 'MediaRewind' || code === 412) { e.preventDefault(); seekBy(-30); return; }

            if (isMinimized) return;
            revealControls();

            const t = e.target as HTMLElement | null;
            const interactive = !!t?.closest?.('button, a, input, select, textarea, [role="slider"]');

            if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack' || code === 461 || code === 10009) {
                e.preventDefault();
                handleBack();
                return;
            }

            if (dialogOpen) {
                if (k === 'Tab') { e.preventDefault(); nav(dialogRef.current, e.shiftKey ? -1 : 1); return; }
                if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); nav(dialogRef.current, 1); return; }
                if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); nav(dialogRef.current, -1); return; }
                if ((k === 'Enter' || k === ' ') && interactive) return;
                if (k === ' ') e.preventDefault();
                return;
            }

            if (settingsOpen) {
                if (k === 'Tab') { e.preventDefault(); nav(panelRef.current, e.shiftKey ? -1 : 1); return; }
                if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); nav(panelRef.current, 1); return; }
                if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); nav(panelRef.current, -1); return; }
                if ((k === 'Enter' || k === ' ') && interactive) return;
                if (k === ' ') e.preventDefault();
                return;
            }

            if (interactive && (k === 'Enter' || k === ' ')) return;

            const inBar = !!t?.closest?.('[data-hp-bar]');
            const onScrub = !!t?.closest?.('[data-hp-scrubber]');
            const onVol = !!t?.closest?.('[data-hp-vol]');
            const inTop = !!t?.closest?.('[data-hp-top]');

            switch (k) {
                case ' ': case 'k': case 'Enter':
                    e.preventDefault();
                    if (!effectiveShow) { revealControls(); break; }
                    togglePlay();
                    break;
                case 'ArrowLeft': case 'j':
                    e.preventDefault();
                    if (onVol) { stepVolume(-0.1); break; }
                    if (inBar && !onScrub) { nav(barRef.current, -1); break; }
                    holdSeek(-1, e.repeat);
                    break;
                case 'ArrowRight': case 'l':
                    e.preventDefault();
                    if (onVol) { stepVolume(0.1); break; }
                    if (inBar && !onScrub) { nav(barRef.current, 1); break; }
                    holdSeek(1, e.repeat);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (onVol) { stepVolume(0.1); break; }
                    if (inTop) { scrubberRef.current?.focus(); break; }
                    if (inBar && !onScrub) { scrubberRef.current?.focus(); break; }
                    if (onScrub) { backBtnRef.current?.focus(); break; }
                    revealControls();
                    playBtnRef.current?.focus();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (onVol) { stepVolume(-0.1); break; }
                    if (inTop) { scrubberRef.current?.focus(); break; }
                    if (onScrub) { playBtnRef.current?.focus(); break; }
                    if (inBar) { containerRef.current?.focus(); if (playingRef.current && !bufferingRef.current) hideControlsNow(); break; }
                    if (playingRef.current && !bufferingRef.current) hideControlsNow();
                    break;
                case 'Home': if (onScrub) { e.preventDefault(); seekTo(0); } break;
                case 'End': if (onScrub) { e.preventDefault(); seekTo(durationRef.current); } break;
                case 'm': case 'M': toggleMute(); break;
                case 'f': case 'F': toggleFullscreen(); break;
                case 'c': case 'C': cycleAspect(); break;
                case '<': case ',': if (k === '<' || e.shiftKey) stepRate(-1); break;
                case '>': case '.': if (k === '>' || e.shiftKey) stepRate(1); break;
                default:
                    if (/^[0-9]$/.test(k) && !interactive && durationRef.current > 0) {
                        e.preventDefault();
                        seekTo(durationRef.current * Number(k) / 10);
                    }
            }
        };

        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'j' || e.key === 'l') holdRef.current = null;
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    });

    useEffect(() => () => {
        [hideTimer, bufTimer, flashTimer, resumeTimer].forEach(r => { if (r.current) clearTimeout(r.current); });
        toastTimers.current.forEach(t => clearTimeout(t));
        toastTimers.current.clear();
    }, []);

    /* ── Derived ── */
    const volEff = prefs.muted ? 0 : prefs.volume;
    const VolIcon = prefs.muted || volEff === 0 ? VolumeX : volEff < 0.5 ? Volume1 : Volume2;
    const AspectIcon = ASPECT_META[prefs.aspect].icon;
    const preparingStream = phase === 'starting' || (phase === 'ready' && !src);
    const errorMessage = mediaError ?? sessionError;
    const streamToken = src ? new URL(src).searchParams.get('t') : null;
    const legacyToken = typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : null;
    const audioLabel = nativeAudio.length > 1
        ? (nativeAudio.find(t => t.enabled)?.label ?? 'Default')
        : serverAudio.length > 1
            ? (serverAudio.find(t => t.index === (audioIndex ?? 0))?.label
                ?? serverAudio.find(t => t.default)?.label ?? 'Default')
            : 'Single track';

    const infoRows = [
        { k: 'Container', v: container },
        { k: 'MIME', v: details.mime_type || 'unknown' },
        { k: 'Size', v: fmtBytes(details.file_size) || '—' },
        { k: 'Resolution', v: details.width && details.height ? `${details.width}×${details.height}` : '—' },
        { k: 'Quality', v: currentQuality === 1080 ? '1080p (Original)' : `${currentQuality}p` },
        { k: 'Audio', v: audioLabel },
        { k: 'Buffered ahead', v: `${bufferedAhead}s` },
        { k: 'Speed', v: `${prefs.rate}×` },
        { k: 'Aspect', v: ASPECT_META[prefs.aspect].label },
        { k: 'Device', v: deviceLabel },
        { k: 'Stream', v: mode === 'signed' ? 'Signed (per-file, per-device)' : 'Legacy' },
    ];

    /* ═══════════════════════════════ Render ═══════════════════════════════ */

    return (
        <div
            ref={containerRef}
            data-hp-root
            role="region"
            aria-label={`Playing ${file.file_name}`}
            tabIndex={-1}
            className={`fixed z-[100] font-sans outline-none transition-all duration-200 ${
                isMinimized
                    ? 'inset-x-0 bottom-0 border-t border-[#1a2524] bg-[#0e1514] shadow-[0_-12px_40px_rgba(0,0,0,0.6)]'
                    : `inset-0 bg-black ${playing && !effectiveShow ? 'cursor-none' : ''}`
            }`}
            style={isMinimized
                ? { height: 'calc(5rem + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }
                : undefined}
            onPointerMove={!isMinimized ? revealControls : undefined}
            onTouchStart={!isMinimized ? revealControls : undefined}
            onFocusCapture={onFocusCapture}
            onBlurCapture={onBlurCapture}
            onContextMenu={(e) => e.preventDefault()}
        >
            <style>{PLAYER_CSS}</style>

            {!isMinimized && (
                <div className="absolute inset-0">
                    {videoMounted && (
                        <video
                            ref={videoRef}
                            src={src ?? undefined}
                            className="h-full w-full"
                            style={{ objectFit: ASPECT_FIT[prefs.aspect] }}
                            playsInline
                            preload="auto"
                            crossOrigin={subs.length > 0 ? 'anonymous' : undefined}
                            controls={false}
                            onClick={togglePlay}
                            onDoubleClick={fsSupported ? toggleFullscreen : undefined}
                            onPlay={() => { setPlaying(true); setFinished(false); }}
                            onPause={() => { setPlaying(false); saveProgress(); }}
                            onTimeUpdate={onTimeUpdate}
                            onProgress={syncBars}
                            onLoadedMetadata={onLoadedMetadata}
                            onDurationChange={() => {
                                const v = videoRef.current;
                                if (v && Number.isFinite(v.duration) && v.duration > 0) {
                                    setDuration(v.duration); durationRef.current = v.duration; syncBars();
                                }
                            }}
                            onWaiting={startBuf}
                            onStalled={startBuf}
                            onSeeking={startBuf}
                            onSeeked={endBuf}
                            onPlaying={() => { endBuf(); setPlaying(true); }}
                            onCanPlay={endBuf}
                            onError={() => { void onMediaError(); }}
                            onEnded={onEnded}
                            onVolumeChange={onVolumeChange}
                            onRateChange={onRateChange}
                        >
                            {subs.map(s => (
                                <track
                                    key={s.lang}
                                    kind="subtitles"
                                    src={resolveApiUrl(`${s.url}${s.url.includes('?') ? '&' : '?'}${
                                        mode === 'signed' ? `t=${encodeURIComponent(streamToken ?? '')}` : `token=${encodeURIComponent(legacyToken ?? '')}`
                                    }`)}
                                    srcLang={s.lang}
                                    label={s.label || s.lang}
                                />
                            ))}
                        </video>
                    )}

                    {videoMounted && !isVideo && (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                            <div
                                className="absolute inset-0"
                                style={{
                                    background:
                                        'radial-gradient(60% 50% at 30% 20%, rgba(20,184,166,0.16), transparent 70%),' +
                                        'radial-gradient(50% 40% at 75% 75%, rgba(56,189,248,0.10), transparent 70%)',
                                }}
                            />
                            <div className="hp-scale-in relative flex flex-col items-center px-8 text-center">
                                <div className="mb-6 flex h-52 w-52 items-center justify-center overflow-hidden rounded-3xl border border-[#2dd4bf]/25 bg-[#0e1514] shadow-[0_25px_70px_-20px_rgba(20,184,166,0.45)] sm:h-64 sm:w-64">
                                    {thumbSrc
                                        ? <img src={thumbSrc} alt="" className="h-full w-full object-cover" />
                                        : <Music className="h-20 w-20 text-[#2dd4bf]" />}
                                </div>
                                <p className="max-w-xl truncate text-xl font-bold text-[#e8f1ef] sm:text-2xl">{file.file_name}</p>
                                <p className="mt-1 font-mono text-sm font-semibold text-[#5eead4]">{fmtTime(sec)} / {fmtTime(duration)}</p>
                            </div>
                        </div>
                    )}

                    {preparingStream && !errorMessage && phase !== 'limited' && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5">
                            <HearthMark />
                            <div className="flex items-center gap-3 text-[#9db6b1]">
                                <Loader2 className="hp-spin h-5 w-5 text-[#2dd4bf]" />
                                <span className="text-sm font-semibold">Preparing your stream…</span>
                            </div>
                            <span className="text-xs text-[#758f8a]">{deviceLabel} · signed for this device only</span>
                        </div>
                    )}

                    {videoMounted && buffering && !errorMessage && !finished && phase === 'ready' && (
                        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
                            <div className="hp-scale-in flex flex-col items-center gap-3 rounded-2xl bg-black/60 px-7 py-5">
                                <Loader2 className="hp-spin h-12 w-12 text-[#2dd4bf]" />
                                <p className="text-sm font-bold text-[#e8f1ef]" aria-live="polite">Buffering…</p>
                                {bufferedAhead > 0 && <p className="font-mono text-xs text-[#9db6b1]">+{bufferedAhead}s ahead</p>}
                            </div>
                        </div>
                    )}

                    {seekFlash && (
                        <div className={`pointer-events-none absolute top-1/2 z-30 -translate-y-1/2 ${seekFlash.dir < 0 ? 'left-[10%]' : 'right-[10%]'}`}>
                            <div className="hp-scale-in flex flex-col items-center gap-1 rounded-2xl bg-black/65 px-5 py-3">
                                {seekFlash.dir < 0 ? <Rewind className="h-9 w-9 text-[#5eead4]" /> : <FastForward className="h-9 w-9 text-[#5eead4]" />}
                                <span className="font-mono text-sm font-bold text-[#e8f1ef]">
                                    {seekFlash.dir < 0 ? '−' : '+'}{seekFlash.total}s
                                </span>
                            </div>
                        </div>
                    )}

                    {videoMounted && phase === 'ready' && !playing && !buffering && !finished && !errorMessage && (
                        <div className="absolute left-1/2 top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 items-center gap-6 sm:gap-8">
                            <button
                                type="button" aria-label="Back 10 seconds" onClick={() => seekBy(-10)}
                                className="hp-focus hidden h-14 w-14 items-center justify-center rounded-full bg-white/10 text-white/80 transition-all duration-150 hover:bg-white/20 hover:text-white [@media(pointer:coarse)]:flex"
                            >
                                <Rewind className="h-7 w-7" />
                            </button>
                            <button
                                type="button" aria-label="Play" onClick={togglePlay}
                                className="hp-focus hp-glow flex h-20 w-20 items-center justify-center rounded-full bg-[#2dd4bf] text-[#04110f] transition-transform duration-150 hover:scale-105 hover:bg-[#5eead4] active:scale-95"
                            >
                                <Play className="ml-1 h-10 w-10" />
                            </button>
                            <button
                                type="button" aria-label="Forward 10 seconds" onClick={() => seekBy(10)}
                                className="hp-focus hidden h-14 w-14 items-center justify-center rounded-full bg-white/10 text-white/80 transition-all duration-150 hover:bg-white/20 hover:text-white [@media(pointer:coarse)]:flex"
                            >
                                <FastForward className="h-7 w-7" />
                            </button>
                        </div>
                    )}

                    {finished && !errorMessage && (
                        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-6">
                            <div className="hp-scale-in w-full max-w-sm rounded-2xl border border-[#1a2524] bg-[#0e1514] p-6 text-center shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]">
                                <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#2dd4bf]/40 bg-[#2dd4bf]/15">
                                    <Check className="h-7 w-7 text-[#2dd4bf]" />
                                </span>
                                <h2 className="text-lg font-bold text-[#e8f1ef]">Finished</h2>
                                <p className="mb-5 mt-1 text-sm text-[#9db6b1]">Marked as watched — it won’t linger in Continue Watching.</p>
                                <div className="flex gap-3">
                                    <button
                                        type="button" ref={replayBtnRef}
                                        onClick={() => { setFinished(false); seekTo(0); playMedia(); }}
                                        className={`${BTN_PRIMARY} flex-1`}
                                    >
                                        <RotateCcw className="h-4 w-4" /> Watch again
                                    </button>
                                    <button type="button" onClick={closePlayer} className={BTN_GHOST}>Close</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {resumeToast && !settingsOpen && !dialogOpen && phase === 'ready' && (
                        <div
                            data-hp-controls
                            className="hp-fade-up absolute bottom-32 left-[3.5%] z-40 flex items-center gap-3 rounded-xl border border-[#2dd4bf]/35 bg-[#0e1514]/95 px-4 py-2.5 shadow-xl"
                        >
                            <RotateCcw className="h-4 w-4 shrink-0 text-[#2dd4bf]" />
                            <span className="text-sm font-semibold text-[#e8f1ef]">
                                Resumed from <span className="font-mono text-[#5eead4]">{fmtTime(resumePointRef.current ?? 0)}</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => { seekTo(0); setResumeToast(false); playMedia(); }}
                                className="hp-focus rounded-lg border border-[#2b3a38] bg-[#1a2524] px-3 py-1.5 text-xs font-bold text-[#5eead4] transition-all duration-150 hover:border-[#2dd4bf]/60"
                            >
                                Start over
                            </button>
                        </div>
                    )}

                    {/* Controls overlay — clicks pass through to the picture */}
                    {videoMounted && phase === 'ready' && !dialogOpen && !finished && (
                        <div
                            ref={ctlWrapRef}
                            data-hp-controls
                            className={`pointer-events-none absolute inset-0 z-30 transition-opacity duration-200 ${
                                effectiveShow ? 'visible opacity-100' : 'invisible opacity-0'
                            }`}
                        >
                            <div
                                data-hp-top
                                className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-black/85 via-black/40 to-transparent px-[3.5%] pb-12"
                                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <IconBtn label="Back to library" refEl={backBtnRef} onClick={closePlayer}>
                                        <ArrowLeft className="h-6 w-6" />
                                    </IconBtn>
                                    <div className="min-w-0">
                                        <h1 className="truncate text-lg font-bold text-white md:text-xl">{file.file_name}</h1>
                                        <p className="truncate text-xs font-medium text-[#9db6b1]">
                                            {deviceLabel} · {container}{details.file_size ? ` · ${fmtBytes(details.file_size)}` : ''}
                                            {currentQuality !== 1080 && ` · ${currentQuality}p`}
                                            
                                        </p>
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    <IconBtn label={prefs.muted ? 'Unmute' : 'Mute'} onClick={toggleMute} active={prefs.muted}>
                                        <VolIcon className="h-5 w-5" />
                                    </IconBtn>
                                    <IconBtn label="Minimize" onClick={minimize}>
                                        <ChevronDown className="h-6 w-6" />
                                    </IconBtn>
                                    <IconBtn label="Close player" onClick={closePlayer}>
                                        <X className="h-6 w-6" />
                                    </IconBtn>
                                </div>
                            </div>

                            <div
                                className="pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-[3.5%] pt-12"
                                style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
                            >
                                <div className="flex items-center gap-3 sm:gap-4">
                                    <span className="min-w-[52px] font-mono text-sm font-semibold text-white/90">{fmtTime(sec)}</span>
                                    <Scrubber
                                        duration={duration} sec={sec}
                                        fillRef={fillRef} bufRef={bufRef} thumbRef={thumbRef} scrubberRef={scrubberRef}
                                        onSeek={seekTo}
                                        onDragState={(d) => { dragRef.current = d; }}
                                    />
                                    <span className="min-w-[52px] text-right font-mono text-sm font-semibold text-white/90">{fmtTime(duration)}</span>
                                </div>

                                <div ref={barRef} data-hp-bar className="mt-1 flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1 sm:gap-1.5">
                                        <IconBtn label={playing ? 'Pause' : 'Play'} refEl={playBtnRef} onClick={togglePlay}>
                                            {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                                        </IconBtn>
                                        <IconBtn label="Back 10 seconds" onClick={() => seekBy(-10)}><Rewind className="h-5 w-5" /></IconBtn>
                                        <IconBtn label="Forward 10 seconds" onClick={() => seekBy(10)}><FastForward className="h-5 w-5" /></IconBtn>
                                        <span className="mx-1 hidden h-6 w-px bg-white/15 sm:block" />
                                        <IconBtn label={prefs.muted ? 'Unmute' : 'Mute'} onClick={toggleMute} active={prefs.muted}>
                                            <VolIcon className="h-5 w-5" />
                                        </IconBtn>
                                        <IconBtn label="Volume down" onClick={() => stepVolume(-0.1)}><Minus className="h-4 w-4" /></IconBtn>
                                        <VolumeBar value={prefs.volume} muted={prefs.muted} onChange={setVolumeLevel} />
                                        <IconBtn label="Volume up" onClick={() => stepVolume(0.1)}><Plus className="h-4 w-4" /></IconBtn>
                                    </div>

                                    <div className="flex items-center gap-1 sm:gap-1.5">
                                        {playing && bufferedAhead > 0 && (
                                            <span className="mr-1 hidden items-center rounded-lg border border-[#1a2524] bg-[#0e1514]/80 px-2.5 py-1 font-mono text-xs font-semibold text-[#9db6b1] md:inline-flex">
                                                +{bufferedAhead}s
                                            </span>
                                        )}
                                        {/* CROP — cycles fit → fill → stretch, sits left of the gear */}
                                        <IconBtn
                                            label={`Crop / aspect: ${ASPECT_META[prefs.aspect].label} — click to change`}
                                            refEl={cropBtnRef} onClick={cycleAspect} active={prefs.aspect !== 'fit'}
                                        >
                                            <AspectIcon className="h-5 w-5" />
                                        </IconBtn>
                                        <IconBtn
                                            label="Settings" refEl={settingsBtnRef} onClick={openSettings}
                                            active={settingsOpen || prefs.rate !== 1}
                                        >
                                            <Settings className="h-5 w-5" />
                                            {prefs.rate !== 1 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#2dd4bf]" />}
                                        </IconBtn>
                                        {pipSupported && isVideo && !isTV() && (
                                            <IconBtn label="Picture in picture" onClick={() => { void togglePiP(); }} active={isPiP}>
                                                <PictureInPicture2 className="h-5 w-5" />
                                            </IconBtn>
                                        )}
                                        {fsSupported && (
                                            <IconBtn label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
                                                {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
                                            </IconBtn>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {settingsOpen && !dialogOpen && (
                        <SettingsPanel
                            panelRef={panelRef}
                            onClose={closeSettings}
                            prefs={prefs}
                            onRate={chooseRate}
                            qualities={qualities}
                            currentQuality={currentQuality}
                            onQuality={switchQuality}
                            canPrepare={role === 'admin'}
                            onPrepare={() => { void prepareRenditions(); }}
                            preparing={preparing}
                            nativeAudio={nativeAudio}
                            serverAudio={serverAudio}
                            audioRemux={audioRemux}
                            currentAudio={audioIndex ?? (serverAudio.find(t => t.default)?.index ?? 0)}
                            onNativeAudio={chooseNativeAudio}
                            onServerAudio={switchServerAudio}
                            subs={subs}
                            onSubtitle={chooseSubtitle}
                            info={infoRows}
                        />
                    )}

                    {phase === 'limited' && (
                        <DeviceLimitDialog
                            dialogRef={dialogRef} active={active} role={role} busy={kickBusy}
                            onKick={(d) => { void kickDevice(d); }} onRetry={retryAll} onClose={closePlayer}
                        />
                    )}
                    {phase === 'ended' && !mediaError && (
                        <EndedCard dialogRef={dialogRef} onRetry={retryAll} onClose={closePlayer} />
                    )}
                    {errorMessage && phase !== 'limited' && (
                        <ErrorCard dialogRef={dialogRef} message={errorMessage} onRetry={retryAll} onClose={closePlayer} />
                    )}
                </div>
            )}

            {isMinimized && (
                <div className="relative flex h-full items-center gap-2 px-3 sm:gap-3 sm:px-6">
                    <div className="absolute inset-x-0 top-0 h-0.5 bg-white/10">
                        <div ref={miniFillRef} className="h-full origin-left bg-gradient-to-r from-[#0d9488] to-[#5eead4]" style={{ transform: 'scaleX(0)' }} />
                    </div>
                    <button
                        type="button" onClick={() => setMinimized(false)} aria-label="Expand player"
                        className="hp-focus flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1.5 text-left"
                    >
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#1a2524] bg-[#141d1c]">
                            {thumbSrc
                                ? <img src={thumbSrc} alt="" className="h-full w-full object-cover" />
                                : isVideo ? <Film className="h-5 w-5 text-[#2dd4bf]" /> : <Music className="h-5 w-5 text-[#2dd4bf]" />}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold text-[#e8f1ef]">{file.file_name}</span>
                            <span className="block font-mono text-xs text-[#9db6b1]">{fmtTime(sec)} / {fmtTime(duration)}</span>
                        </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                        <IconBtn label="Back 10 seconds" onClick={() => seekBy(-10)}><Rewind className="h-5 w-5" /></IconBtn>
                        <button
                            type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}
                            className="hp-focus flex h-11 w-11 items-center justify-center rounded-full bg-[#2dd4bf] text-[#04110f] shadow-[0_6px_20px_-4px_rgba(45,212,191,0.6)] transition-all duration-150 hover:bg-[#5eead4] active:scale-90"
                        >
                            {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
                        </button>
                        <IconBtn label="Forward 10 seconds" onClick={() => seekBy(10)}><FastForward className="h-5 w-5" /></IconBtn>
                        <span className="mx-1 h-6 w-px bg-white/10" />
                        <IconBtn label="Crop / aspect" onClick={cycleAspect} active={prefs.aspect !== 'fit'}><AspectIcon className="h-5 w-5" /></IconBtn>
                        <IconBtn label="Expand" onClick={() => setMinimized(false)}><ChevronUp className="h-5 w-5" /></IconBtn>
                        <IconBtn label="Close player" onClick={closePlayer}><X className="h-5 w-5" /></IconBtn>
                    </div>
                </div>
            )}

            <div className="pointer-events-none absolute left-1/2 top-16 z-[140] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
                {toasts.map(t => (
                    <div
                        key={t.id}
                        className={`hp-fade-up rounded-xl border px-4 py-2 text-sm font-semibold shadow-xl ${
                            t.kind === 'success' ? 'border-[#2dd4bf]/50 bg-[#0e1514]/95 text-[#5eead4]'
                                : t.kind === 'error' ? 'border-[#f43f5e]/50 bg-[#0e1514]/95 text-[#fda4af]'
                                    : 'border-[#38bdf8]/40 bg-[#0e1514]/95 text-[#bae6fd]'
                        }`}
                    >
                        {t.msg}
                    </div>
                ))}
            </div>
        </div>
    );
}
