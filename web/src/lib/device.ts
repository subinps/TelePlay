/**
 * Hearth — device identity & capabilities  (README §4.5, §4.6, §6.3, §7.2, §7.6)
 * ─────────────────────────────────────────────────────────────────────────────
 * One job: tell the backend *which screen this is*, honestly and stably.
 *
 *  · getDeviceId()      persistent UUID in localStorage → refresh, reopen and a second tab
 *                       all reuse the same slot, so the 2-device limit never double-counts.
 *                       Falls back to a long random id when crypto.randomUUID is missing
 *                       (Chromium 53 on Tizen) and to an in-memory id in private mode.
 *  · getDeviceKind()    'tv' | 'phone' | 'tablet' | 'computer'  ← required by App.tsx + store.ts
 *  · getDeviceLabel()   human name shown in the device-limit dialog, rail and login.
 *  · isTV()             true for Tizen / webOS / Android TV / Fire TV / HbbTV.
 *  · capabilities       fullscreen, PiP, touch and a real canPlayType probe, so the UI can
 *                       warn about MKV/HEVC instead of pretending it will play.
 *  · TV media keys      Tizen needs registerKey() before MediaPlayPause etc. are delivered;
 *                       every call is wrapped so non-Tizen browsers are unaffected.
 *
 * Public surface consumed elsewhere in the app:
 *   api.ts    → getDeviceId, getDeviceLabel
 *   store.ts  → getDeviceId, getDeviceLabel, getDeviceKind, isTV, type DeviceKind
 *   App.tsx   → getDeviceKind, getDeviceLabel
 *
 * No React, no axios, no dependencies — safe to import from anywhere.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEVICE_ID_KEY = 'hearth_device_id';

export type DeviceKind = 'tv' | 'phone' | 'tablet' | 'computer';

/* ═══════════════════════════════ storage safety ═══════════════════════════════ */

function safeGet(key: string): string | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
        return null;                       // private mode / disabled storage on some TVs
    }
}

function safeSet(key: string, value: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch { /* keep the in-memory fallback */ }
}

function randomId(): string {
    try {
        const c = typeof crypto !== 'undefined' ? crypto : undefined;
        if (c?.randomUUID) return c.randomUUID();
        if (c?.getRandomValues) {
            const bytes = new Uint8Array(16);
            c.getRandomValues(bytes);
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch { /* fall through */ }
    return `d-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/* ═══════════════════════════════ identity ═══════════════════════════════ */

let memoryId: string | null = null;

/** Stable per-browser id (≥ 8 chars, which the backend requires). */
export function getDeviceId(): string {
    const stored = safeGet(DEVICE_ID_KEY);
    if (stored && stored.length >= 8) {
        memoryId = stored;
        return stored;
    }
    if (memoryId) return memoryId;
    const id = randomId();
    memoryId = id;
    safeSet(DEVICE_ID_KEY, id);
    return id;
}

/** Forget this screen's identity (sign-out gives the next user a clean slot). */
export function resetDeviceId(): string {
    memoryId = null;
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(DEVICE_ID_KEY);
    } catch { /* noop */ }
    return getDeviceId();
}

function ua(): string {
    try {
        return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    } catch {
        return '';
    }
}

export function isTizen(): boolean { return /Tizen/i.test(ua()); }
export function isWebOS(): boolean { return /Web0S|webOS/i.test(ua()); }
export function isAndroidTV(): boolean { return /Android.*TV|AFT|BRAVIA|SMART-TV/i.test(ua()); }

export function isTV(): boolean {
    return /SMART-TV|SmartTV|Tizen|Web0S|webOS|HbbTV|BRAVIA|AFT|Android.*TV|GoogleTV|AppleTV|CrKey/i.test(ua());
}

/** Coarse class used for layout decisions and the "this screen" chip. */
export function getDeviceKind(): DeviceKind {
    const u = ua();
    if (isTV()) return 'tv';
    if (/iPad|Tablet|PlayBook|Silk/i.test(u)) return 'tablet';
    if (/iPhone|iPod|Android.*Mobile|Windows Phone/i.test(u)) return 'phone';
    return 'computer';
}

/** Name a human recognises in "Two devices are already playing". */
export function getDeviceLabel(): string {
    const u = ua();
    if (/Tizen/i.test(u)) return 'Samsung TV';
    if (/Web0S|webOS/i.test(u)) return 'LG TV';
    if (/AFT/i.test(u)) return 'Fire TV';
    if (/BRAVIA/i.test(u)) return 'Sony TV';
    if (/Android.*TV|SMART-TV|GoogleTV/i.test(u)) return 'Android TV';
    if (/CrKey/i.test(u)) return 'Chromecast';
    if (/AppleTV/i.test(u)) return 'Apple TV';
    if (/HbbTV/i.test(u)) return 'TV';
    if (/iPhone|iPod/i.test(u)) return 'iPhone';
    if (/iPad/i.test(u)) return 'iPad';
    if (/Android.*Mobile/i.test(u)) return 'Android phone';
    if (/Android/i.test(u)) return 'Android tablet';
    if (/Macintosh|Mac OS X/i.test(u)) return 'Mac';
    if (/Windows/i.test(u)) return 'Windows PC';
    if (/Linux/i.test(u)) return 'Linux PC';
    return 'Computer';
}

export function isTouchDevice(): boolean {
    try {
        return (typeof window !== 'undefined' && 'ontouchstart' in window)
            || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
    } catch {
        return false;
    }
}

/** Coarse pointer ⇒ remote/finger, not a mouse. */
export function isCoarsePointer(): boolean {
    try {
        return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    } catch {
        return isTouchDevice();
    }
}

/* ═══════════════════════════════ capabilities ═══════════════════════════════ */

export interface DeviceCapabilities {
    fullscreen: boolean;
    pictureInPicture: boolean;
    touch: boolean;
    tv: boolean;
    reducedMotion: boolean;
    /** 'probably' | 'maybe' | '' — empty means this device refuses the type. */
    canPlay: (mime: string) => string;
    /** Container/extension heuristic used for the amber card warning. */
    likelyUnsupported: (fileName: string, mime?: string | null) => boolean;
}

const probeCache = new Map<string, string>();
let probeEl: HTMLVideoElement | HTMLAudioElement | null = null;

function canPlay(mime: string): string {
    if (!mime) return 'maybe';
    const hit = probeCache.get(mime);
    if (hit !== undefined) return hit;
    let result = 'maybe';
    try {
        if (typeof document !== 'undefined') {
            const wantAudio = mime.startsWith('audio/');
            if (!probeEl || (wantAudio && probeEl.tagName !== 'AUDIO') || (!wantAudio && probeEl.tagName !== 'VIDEO')) {
                probeEl = document.createElement(wantAudio ? 'audio' : 'video');
            }
            result = probeEl.canPlayType(mime) || '';
        }
    } catch { /* very old WebView */ }
    probeCache.set(mime, result);
    return result;
}

const RISKY_EXTENSIONS = ['MKV', 'AVI', 'WMV', 'FLV', 'TS', 'MPG', 'M2TS', 'VOB'];

export function fileExtension(fileName: string): string {
    const m = /\.([a-z0-9]{2,4})$/i.exec(fileName || '');
    return m ? m[1].toUpperCase() : '';
}

export function likelyUnsupported(fileName: string, mime?: string | null): boolean {
    const ext = fileExtension(fileName);
    if (RISKY_EXTENSIONS.includes(ext)) return true;
    const type = mime ?? '';
    if (type.includes('matroska') || type.includes('x-msvideo') || type.includes('x-ms-wmv')) return true;
    if (type && canPlay(type) === '') return true;
    return false;
}

export function getDeviceCapabilities(): DeviceCapabilities {
    const doc = typeof document !== 'undefined' ? document : undefined;
    let reduced = false;
    try {
        reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { /* noop */ }
    return {
        fullscreen: !!doc?.fullscreenEnabled,
        pictureInPicture: !!doc?.pictureInPictureEnabled,
        touch: isTouchDevice(),
        tv: isTV(),
        reducedMotion: reduced,
        canPlay,
        likelyUnsupported,
    };
}

/* ═══════════════════════════════ TV media keys ═══════════════════════════════ */

export const TV_MEDIA_KEYS = [
    'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
    'MediaRewind', 'MediaFastForward', 'MediaTrackNext', 'MediaTrackPrevious',
] as const;

interface TizenInputDevice {
    registerKey?: (key: string) => void;
    unregisterKey?: (key: string) => void;
}

function tizenInput(): TizenInputDevice | null {
    try {
        const t = (window as unknown as { tizen?: { tvinputdevice?: TizenInputDevice } }).tizen;
        return t?.tvinputdevice ?? null;
    } catch {
        return null;
    }
}

/** Tizen only delivers registered keys. Returns an unregister function; never throws. */
export function registerTvMediaKeys(keys: readonly string[] = TV_MEDIA_KEYS): () => void {
    const input = tizenInput();
    if (!input?.registerKey) return () => { /* not Tizen */ };
    const done: string[] = [];
    for (const k of keys) {
        try { input.registerKey(k); done.push(k); } catch { /* key unsupported on this model */ }
    }
    return () => {
        for (const k of done) {
            try { input.unregisterKey?.(k); } catch { /* noop */ }
        }
    };
}

/** Back keys across desktop, webOS (461) and Tizen (10009). */
export function isBackKey(key: string, keyCode?: number): boolean {
    return key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || key === 'GoBack'
        || key === 'Back' || keyCode === 461 || keyCode === 10009;
}

export type RemoteAction =
    | 'play-pause' | 'play' | 'pause' | 'stop' | 'fast-forward' | 'rewind'
    | 'next' | 'previous' | null;

/**
 * Browser keyCodes: 176 next, 177 previous, 178 stop, 179 play/pause.
 * Tizen sends its own set: 415 play, 19 pause, 413 stop, 417 FF, 412 RW.
 */
export function remoteMediaAction(key: string, keyCode?: number): RemoteAction {
    if (key === 'MediaPlayPause' || key === 'MediaTogglePlayPause' || keyCode === 179) return 'play-pause';
    if (key === 'MediaPlay' || keyCode === 415) return 'play';
    if (key === 'MediaPause' || keyCode === 19) return 'pause';
    if (key === 'MediaStop' || keyCode === 413 || keyCode === 178) return 'stop';
    if (key === 'MediaFastForward' || keyCode === 417) return 'fast-forward';
    if (key === 'MediaRewind' || keyCode === 412) return 'rewind';
    if (key === 'MediaTrackNext' || keyCode === 176) return 'next';
    if (key === 'MediaTrackPrevious' || keyCode === 177) return 'previous';
    return null;
}

/** Snapshot for logs / the rail's "this screen" panel. */
export function getDeviceInfo() {
    return {
        device_id: getDeviceId(),
        device_label: getDeviceLabel(),
        kind: getDeviceKind(),
        is_tv: isTV(),
        capabilities: getDeviceCapabilities(),
    };
}
