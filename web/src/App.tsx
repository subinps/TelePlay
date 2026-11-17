/**
 * Hearth — App shell  (README §8.1, §7.4, §4.4, §6.3, §7.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Composition root: boot → sign-in → library, plus every overlay the store can open.
 *
 *  · Boot        verifies the session with /auth/me, hydrates Family/Guest role, and never
 *                dead-ends: a slow or offline server offers "Continue anyway".
 *  · Sign-in     §8.1 rebuilt for a remote — six-digit code with an on-screen keypad
 *                (arrows/OK, no typing required), physical keyboard support, auto-submit,
 *                real QR of the bot deep link, Family code vs Guest PIN, readable errors,
 *                attempt cooldown, and the identity of this screen.
 *  · Library     FileBrowser (Home) owns the grid, Manage mode and its own toasts.
 *  · Overlays    MediaPlayer, item actions sheet, ConfirmDelete (Cancel default focus),
 *                Move / New collection (kept capabilities, admin-gated), and the retired
 *                Rename notice — all driven by the existing store contract.
 *  · Safety      a real error boundary with recovery actions, session-expiry handling,
 *                and a single Toasts mount at a time so nothing is ever announced twice.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
    AlertTriangle, Check, Copy, Delete, ExternalLink, Film, KeyRound, Loader2,
    Monitor, Play, QrCode, RefreshCw, Shield, Smartphone, Sparkles, Tablet, Tv, Users, X,
} from 'lucide-react';
import {
    AUTH_EXPIRED_EVENT, errorMessage, errorStatus, fetchBotInfo, fetchMe, getAccessToken,
    loginWithCode, isAuthenticated, loginWithPin, useDeleteFiles, useDeleteFolders,
} from './lib/api';
import type { Folder, TelegramFile } from './lib/api';
import { getDeviceKind, getDeviceLabel } from './lib/device';
import { useAppStore } from './lib/store';
import FileBrowser from './components/FileBrowser';
import MediaPlayer from './components/MediaPlayer';
import GlobalContextMenu from './components/GlobalContextMenu';
import DeleteConfirmModal from './components/DeleteConfirmModal';
// import MoveFileModal from './components/MoveFileModal';
// import NewFolderModal from './components/NewFolderModal';
// import RenameModal from './components/RenameModal';
import Toasts from './components/Toasts';

/* ═══════════════════════════════ Brand ═══════════════════════════════ */

function HearthDefs() {
    return (
        <svg className="absolute h-0 w-0" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id="app-logo-teal" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#2dd4bf" /><stop offset="1" stopColor="#0d9488" />
                </linearGradient>
                <radialGradient id="app-logo-ember" cx="0.5" cy="0.3" r="0.9">
                    <stop offset="0" stopColor="#fde68a" /><stop offset="0.55" stopColor="#f59e0b" />
                    <stop offset="1" stopColor="#e11d48" />
                </radialGradient>
                <linearGradient id="app-arch" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#134e4a" /><stop offset="1" stopColor="#0b1413" />
                </linearGradient>
                <radialGradient id="app-firelight" cx="0.5" cy="0.85" r="0.7">
                    <stop offset="0" stopColor="#f59e0b" stopOpacity="0.85" />
                    <stop offset="0.5" stopColor="#e11d48" stopOpacity="0.35" />
                    <stop offset="1" stopColor="#0b1413" stopOpacity="0" />
                </radialGradient>
            </defs>
        </svg>
    );
}

function HearthLogo({ size = 40 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="hearth-ember shrink-0">
            <rect x="3" y="3" width="42" height="42" rx="14" fill="url(#app-logo-teal)" />
            <path d="M24 11.5c5.2 5.2 9.2 8.8 9.2 14.4a9.2 9.2 0 0 1-18.4 0c0-3.1 1.2-5.6 3.3-8 .6 2.1 1.8 3.3 3.4 3.9-.6-3.6.9-7 2.5-10.3z" fill="url(#app-logo-ember)" />
            <circle cx="24" cy="27.6" r="3.1" fill="#04110f" opacity="0.85" />
        </svg>
    );
}

function HearthScene() {
    return (
        <svg viewBox="0 0 320 220" className="h-auto w-full max-w-[380px]" role="img" aria-label="A glowing hearth">
            <ellipse cx="160" cy="196" rx="120" ry="14" fill="#04110f" opacity="0.7" />
            <path d="M40 196V104a120 120 0 0 1 240 0v92z" fill="url(#app-arch)" stroke="#1a2524" strokeWidth="2" />
            <path d="M74 196v-88a86 86 0 0 1 172 0v88z" fill="#070b0b" stroke="#115e59" strokeWidth="2" />
            <ellipse cx="160" cy="182" rx="86" ry="46" fill="url(#app-firelight)" />
            <path d="M160 118c14 15 25 25 25 40a25 25 0 0 1-50 0c0-9 3.5-16 9-22 1.6 5.6 4.8 9 9.2 10.6-1.6-10 2.4-19.4 6.8-28.6z" fill="url(#app-logo-ember)" className="hearth-ember" />
            <rect x="112" y="176" width="96" height="9" rx="4.5" fill="#134e4a" />
            <rect x="126" y="168" width="68" height="8" rx="4" fill="#0f766e" opacity="0.8" />
            <circle className="hearth-spark" cx="132" cy="120" r="2.6" fill="#fbbf24" />
            <circle className="hearth-spark hearth-spark-b" cx="186" cy="132" r="2" fill="#5eead4" />
            <circle className="hearth-spark hearth-spark-c" cx="160" cy="104" r="1.8" fill="#fda4af" />
            <rect x="40" y="188" width="240" height="8" rx="4" fill="#1a2524" />
        </svg>
    );
}

function DeviceChip() {
    const kind = getDeviceKind();
    const Icon = kind === 'tv' ? Tv : kind === 'phone' ? Smartphone : kind === 'tablet' ? Tablet : Monitor;
    return (
        <span className="inline-flex items-center gap-2 rounded-full border border-[#1a2524] bg-[#0e1514] px-3 py-1.5 text-xs font-semibold text-[#9db6b1] min-[1600px]:text-base">
            <Icon className="h-3.5 w-3.5 text-[#38bdf8]" />
            This screen: {getDeviceLabel()}
        </span>
    );
}

/* ═══════════════════════ QR (byte mode, ECC L, v1–5, no dependencies) ═══════════════════════ */

interface QRGrid { size: number; mod: boolean[][] }
const qrCache = new Map<string, QRGrid | null>();
const QR_DATA_CW = [0, 19, 34, 55, 80, 108];
const QR_ECC_LEN = [0, 7, 10, 15, 20, 26];

function gfMul(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}
function rsDivisor(degree: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMul(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ (result.shift() as number);
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
}
function makeQR(text: string): QRGrid | null {
    if (qrCache.has(text)) return qrCache.get(text) ?? null;
    const bytes = Array.from(new TextEncoder().encode(text));
    let version = 0;
    for (let v = 1; v <= 5; v++) if (bytes.length <= QR_DATA_CW[v] - 2) { version = v; break; }
    if (!version) { qrCache.set(text, null); return null; }

    const dataCW = QR_DATA_CW[version];
    const bits: number[] = [];
    const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4); push(bytes.length, 8);
    bytes.forEach(b => push(b, 8));
    push(0, Math.min(4, dataCW * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        data.push(b);
    }
    const pads = [0xec, 0x11];
    let pi = 0;
    while (data.length < dataCW) data.push(pads[pi++ % 2]);
    const codewords = data.concat(rsRemainder(data, rsDivisor(QR_ECC_LEN[version])));

    const size = 17 + version * 4;
    const mod: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    const fn: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    const set = (x: number, y: number, dark: boolean) => { mod[y][x] = dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx: number, cy: number) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && x < size && y >= 0 && y < size) {
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, d !== 2 && d !== 4);
            }
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (version >= 2) {
        const p = size - 7;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            set(p + dx, p + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
    const drawFormat = (mask: number) => {
        const d = (1 << 3) | mask;
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const fbits = ((d << 10) | rem) ^ 0x5412;
        const bit = (i: number) => ((fbits >>> i) & 1) === 1;
        for (let i = 0; i <= 5; i++) set(8, i, bit(i));
        set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
        set(8, size - 8, true);
    };
    drawFormat(0);

    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const up = ((right + 1) & 2) === 0;
                const y = up ? size - 1 - vert : vert;
                if (!fn[y][x] && i < codewords.length * 8) {
                    mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
                    i++;
                }
            }
        }
    }
    const maskFn = (m: number, x: number, y: number): boolean => {
        switch (m) {
            case 0: return (x + y) % 2 === 0;
            case 1: return y % 2 === 0;
            case 2: return x % 3 === 0;
            case 3: return (x + y) % 3 === 0;
            case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            case 5: return (x * y) % 2 + (x * y) % 3 === 0;
            case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
            default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
        }
    };
    const applyMask = (m: number) => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (!fn[y][x] && maskFn(m, x, y)) mod[y][x] = !mod[y][x];
        }
    };
    const penalty = (): number => {
        let score = 0;
        const line = (arr: boolean[]) => {
            let s = 0, run = 1;
            for (let k = 1; k <= arr.length; k++) {
                if (k < arr.length && arr[k] === arr[k - 1]) run++;
                else { if (run >= 5) s += run - 2; run = 1; }
            }
            const str = arr.map(b => (b ? '1' : '0')).join('');
            for (const pat of ['10111010000', '00001011101']) {
                let idx = str.indexOf(pat);
                while (idx !== -1) { s += 40; idx = str.indexOf(pat, idx + 1); }
            }
            return s;
        };
        for (let y = 0; y < size; y++) score += line(mod[y]);
        for (let x = 0; x < size; x++) score += line(mod.map(r => r[x]));
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
            const c = mod[y][x];
            if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
        }
        let dark = 0;
        for (const row of mod) for (const c of row) if (c) dark++;
        const total = size * size;
        score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return score;
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormat(m);
        const s = penalty();
        if (s < bestScore) { bestScore = s; best = m; }
        applyMask(m);
    }
    applyMask(best); drawFormat(best);
    const grid: QRGrid = { size, mod };
    qrCache.set(text, grid);
    return grid;
}

function QRCode({ value, className }: { value: string; className?: string }) {
    const qr = useMemo(() => makeQR(value), [value]);
    if (!qr) return null;
    const quiet = 4, n = qr.size + quiet * 2;
    let d = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
        if (qr.mod[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
    return (
        <svg viewBox={`0 0 ${n} ${n}`} className={className} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${value}`}>
            <rect width={n} height={n} fill="#f2f7f6" />
            <path d={d} fill="#04110f" />
        </svg>
    );
}

/* ═══════════════════════════════ Error boundary ═══════════════════════════════ */

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    state = { error: null as Error | null };

    static getDerivedStateFromError(error: Error) { return { error }; }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Kept local: a crash screen must not depend on anything that just crashed.
        if (typeof console !== 'undefined') console.error('Hearth crashed:', error, info.componentStack);
    }

    private hardReset = () => {
        try {
            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');
        } catch { /* noop */ }
        window.location.reload();
    };

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="flex min-h-screen items-center justify-center bg-[#070b0b] p-6">
                <div className="hearth-scale-in w-full max-w-md rounded-2xl border border-[#1a2524] bg-[#0e1514] p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10">
                        <AlertTriangle className="h-6 w-6 text-[#fbbf24]" />
                    </span>
                    <h1 className="text-lg font-bold text-[#e8f1ef]">This screen hit a problem</h1>
                    <p className="mt-2 text-sm leading-relaxed text-[#9db6b1]">
                        Your library is safe on Telegram — nothing was deleted. Reloading usually clears it.
                    </p>
                    <p className="mt-3 break-words rounded-lg border border-[#1a2524] bg-[#141d1c] px-3 py-2 font-mono text-xs text-[#758f8a]">
                        {this.state.error.message || 'Unknown error'}
                    </p>
                    <div className="mt-5 flex gap-3">
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="hearth-focus inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] transition-all duration-150 hover:bg-[#5eead4]"
                        >
                            <RefreshCw className="h-4 w-4" /> Reload
                        </button>
                        <button
                            type="button"
                            onClick={this.hardReset}
                            className="hearth-focus inline-flex items-center justify-center gap-2 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60"
                        >
                            Sign out
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}

/* ═══════════════════════════════ Boot ═══════════════════════════════ */

function BootScreen({ slow, onContinue }: { slow: boolean; onContinue: () => void }) {
    return (
        <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
            <HearthLogo size={72} />
            <div>
                <h1 className="text-3xl font-black tracking-tight text-white min-[1600px]:text-5xl">Hearth</h1>
                <p className="mt-1 text-sm text-[#9db6b1] min-[1600px]:text-xl">Your family’s films, on every screen</p>
            </div>
            <div className="flex items-center gap-3 text-[#9db6b1]">
                <Loader2 className="hearth-spin h-5 w-5 text-[#2dd4bf]" />
                <span className="text-sm font-semibold min-[1600px]:text-lg">
                    {slow ? 'The server is still waking up…' : 'Warming the hearth…'}
                </span>
            </div>
            {slow && (
                <button
                    type="button"
                    onClick={onContinue}
                    className="hearth-focus hearth-fade-up rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 min-[1600px]:text-lg"
                >
                    Continue anyway
                </button>
            )}
            <DeviceChip />
        </div>
    );
}

/* ═══════════════════════════════ Sign in ═══════════════════════════════ */

type AuthMode = 'code' | 'pin';
const CODE_LEN = 6;
const MAX_ATTEMPTS = 5;
const COOLDOWN_S = 30;

function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
    const addToast = useAppStore(s => s.addToast);
    const [mode, setMode] = useState<AuthMode>('code');
    const [digits, setDigits] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [bot, setBot] = useState('');
    const [copied, setCopied] = useState(false);
    const [attempts, setAttempts] = useState(0);
    const [cooldown, setCooldown] = useState(0);
    const [showQr, setShowQr] = useState(true);

    const keyRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const submitRef = useRef<HTMLButtonElement>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const digitsRef = useRef('');
    const pendingRef = useRef(false);
    digitsRef.current = digits;
    pendingRef.current = pending;

    useEffect(() => {
        let live = true;
        void fetchBotInfo().then(info => { if (live) setBot(info.bot_username); });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        const raf = requestAnimationFrame(() => keyRefs.current[0]?.focus());
        return () => cancelAnimationFrame(raf);
    }, []);

    useEffect(() => {
        if (cooldown <= 0) return;
        const iv = setInterval(() => setCooldown(c => Math.max(0, c - 1)), 1000);
        return () => clearInterval(iv);
    }, [cooldown]);

    useEffect(() => () => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
        if (autoTimer.current) clearTimeout(autoTimer.current);
    }, []);

    const submit = useCallback(async (value: string) => {
        if (pendingRef.current || value.length !== CODE_LEN) return;
        setPending(true);
        setError(null);
        try {
            if (mode === 'code') await loginWithCode(value);
            else await loginWithPin(value);
            const me = await fetchMe().catch(() => null);
            useAppStore.getState().setIsAuthenticated(true);
            if (me) useAppStore.getState().setMe(me);
            addToast(me?.role === 'guest' ? 'Signed in as Guest' : 'Welcome back', 'success');
            onSignedIn();
        } catch (err) {
            const status = errorStatus(err);
            const next = attempts + 1;
            setAttempts(next);
            setDigits('');
            setError(
                status === 429 ? 'Too many attempts. Wait a moment before trying again.'
                    : status === 401 || status === 400
                        ? mode === 'code'
                            ? 'That code is wrong or expired. Send /login to the bot for a fresh one.'
                            : 'That PIN is wrong or expired. Ask for a new one with /guest.'
                        : errorMessage(err),
            );
            if (next >= MAX_ATTEMPTS) { setCooldown(COOLDOWN_S); setAttempts(0); }
            requestAnimationFrame(() => keyRefs.current[0]?.focus());
        } finally {
            setPending(false);
        }
    }, [mode, attempts, addToast, onSignedIn]);

    const append = useCallback((d: string) => {
        if (pendingRef.current || cooldown > 0) return;
        setError(null);
        setDigits(prev => {
            if (prev.length >= CODE_LEN) return prev;
            const next = prev + d;
            if (next.length === CODE_LEN) {
                if (autoTimer.current) clearTimeout(autoTimer.current);
                autoTimer.current = setTimeout(() => { void submit(next); }, 260);
            }
            return next;
        });
    }, [cooldown, submit]);

    const backspace = useCallback(() => {
        if (pendingRef.current) return;
        if (autoTimer.current) clearTimeout(autoTimer.current);
        setError(null);
        setDigits(prev => prev.slice(0, -1));
    }, []);

    const clearAll = useCallback(() => {
        if (pendingRef.current) return;
        if (autoTimer.current) clearTimeout(autoTimer.current);
        setError(null);
        setDigits('');
        keyRefs.current[0]?.focus();
    }, []);

    /* Physical keyboard + remote: digits, Backspace, Enter, Escape. */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t?.closest?.('button') && (e.key === 'Enter' || e.key === ' ')) return;   // native OK
            if (/^[0-9]$/.test(e.key)) { e.preventDefault(); append(e.key); return; }
            if (e.key === 'Backspace' || e.keyCode === 461 || e.keyCode === 10009) { e.preventDefault(); backspace(); return; }
            if (e.key === 'Escape') { e.preventDefault(); clearAll(); return; }
            if (e.key === 'Enter') { e.preventDefault(); void submit(digitsRef.current); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [append, backspace, clearAll, submit]);

    const moveKeyFocus = (index: number, dir: 'up' | 'down' | 'left' | 'right') => {
        const cols = 3;
        let next = index;
        if (dir === 'left') next = index - 1;
        if (dir === 'right') next = index + 1;
        if (dir === 'up') next = index - cols;
        if (dir === 'down') next = index + cols;
        if (next < 0 || next > 11) {
            if (dir === 'down') { submitRef.current?.focus(); return; }
            return;
        }
        keyRefs.current[next]?.focus();
    };

    const copyLink = async () => {
        const link = `https://t.me/${bot}`;
        let ok = false;
        try {
            if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(link); ok = true; }
        } catch { /* fall through */ }
        if (!ok) {
            try {
                const ta = document.createElement('textarea');
                ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                ok = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch { ok = false; }
        }
        if (ok) {
            setCopied(true);
            if (copyTimer.current) clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 2200);
        } else addToast('Copy is blocked on this device', 'warning');
    };

    const keys: { label: string; value: string; kind: 'digit' | 'clear' | 'back' }[] = [
        ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => ({ label: d, value: d, kind: 'digit' as const })),
        { label: 'Clear', value: 'clear', kind: 'clear' },
        { label: '0', value: '0', kind: 'digit' },
        { label: 'Delete', value: 'back', kind: 'back' },
    ];

    const locked = cooldown > 0;
    const botLink = bot ? `https://t.me/${bot}` : '';

    return (
        <div className="relative min-h-screen">
            <div className="mx-auto grid min-h-screen w-full max-w-[1500px] items-center gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-16 min-[1600px]:px-[5%]">
                {/* Story panel */}
                <section className="hearth-fade-up hidden flex-col items-start lg:flex">
                    <div className="flex items-center gap-3">
                        <HearthLogo size={46} />
                        <span className="text-3xl font-black tracking-tight text-white min-[1600px]:text-5xl">Hearth</span>
                    </div>
                    <h1 className="mt-7 max-w-lg text-4xl font-black leading-[1.08] tracking-tight text-[#e8f1ef] min-[1600px]:text-6xl">
                        Your family’s films,<br />
                        <span className="bg-gradient-to-r from-[#5eead4] via-[#38bdf8] to-[#fbbf24] bg-clip-text text-transparent">
                            on every screen.
                        </span>
                    </h1>
                    <p className="mt-4 max-w-md text-base leading-relaxed text-[#9db6b1] min-[1600px]:text-2xl">
                        Send a video to your Telegram bot. It appears here instantly — original quality,
                        no re-encoding, no accounts to manage.
                    </p>

                    <div className="mt-8"><HearthScene /></div>

                    <ul className="mt-8 space-y-3">
                        {[
                            { icon: Film, text: 'Original quality straight from Telegram — nothing is transcoded.' },
                            { icon: Users, text: 'Two screens can watch at once. A third asks politely.' },
                            { icon: Shield, text: 'Family manages the library. Guests get a PIN and can play.' },
                        ].map(({ icon: Icon, text }) => (
                            <li key={text} className="flex items-start gap-3">
                                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#1a2524] bg-[#0e1514]">
                                    <Icon className="h-4 w-4 text-[#2dd4bf]" />
                                </span>
                                <span className="max-w-sm text-sm leading-relaxed text-[#c3d6d2] min-[1600px]:text-xl">{text}</span>
                            </li>
                        ))}
                    </ul>

                    <div className="mt-8"><DeviceChip /></div>
                </section>

                {/* Auth card */}
                <section className="hearth-scale-in mx-auto w-full max-w-[460px] min-[1600px]:max-w-[560px]">
                    <div className="mb-6 flex items-center gap-3 lg:hidden">
                        <HearthLogo size={38} />
                        <div>
                            <span className="block text-2xl font-black tracking-tight text-white">Hearth</span>
                            <span className="block text-xs text-[#9db6b1]">Your family’s films, on every screen</span>
                        </div>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-[#1a2524] bg-[#0e1514] shadow-[0_30px_80px_-24px_rgba(0,0,0,0.9),0_0_70px_-30px_rgba(45,212,191,0.4)]">
                        <div className="h-1 w-full bg-gradient-to-r from-[#2dd4bf] via-[#38bdf8] to-[#fbbf24]" />

                        <div className="p-5 sm:p-6 min-[1600px]:p-8">
                            {/* Mode switch */}
                            <div className="mb-5 grid grid-cols-2 gap-1.5 rounded-xl border border-[#1a2524] bg-[#141d1c] p-1.5">
                                {([
                                    { id: 'code' as const, label: 'Family code', icon: KeyRound },
                                    { id: 'pin' as const, label: 'Guest PIN', icon: Users },
                                ]).map(({ id, label, icon: Icon }) => (
                                    <button
                                        key={id}
                                        type="button"
                                        onClick={() => { setMode(id); setDigits(''); setError(null); }}
                                        aria-pressed={mode === id}
                                        className={`hearth-focus inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-bold transition-all duration-150 min-[1600px]:text-xl ${
                                            mode === id
                                                ? 'bg-[#2dd4bf] text-[#04110f] shadow-[0_6px_20px_-6px_rgba(45,212,191,0.7)]'
                                                : 'text-[#9db6b1] hover:bg-white/5 hover:text-white'
                                        }`}
                                    >
                                        <Icon className="h-4 w-4" /> {label}
                                    </button>
                                ))}
                            </div>

                            <p className="mb-4 text-sm leading-relaxed text-[#9db6b1] min-[1600px]:text-xl">
                                {mode === 'code' ? (
                                    <>Send <span className="font-mono font-bold text-[#5eead4]">/login</span> to your bot in Telegram, then enter the 6-digit code it replies with.</>
                                ) : (
                                    <>Ask the family account for a guest PIN — they get one by sending <span className="font-mono font-bold text-[#5eead4]">/guest</span> to the bot.</>
                                )}
                            </p>

                            {/* Code display */}
                            <div
                                className="mb-4 flex justify-center gap-2 min-[1600px]:gap-3"
                                role="status"
                                aria-label={`${digits.length} of ${CODE_LEN} digits entered`}
                            >
                                {Array.from({ length: CODE_LEN }).map((_, i) => {
                                    const filled = i < digits.length;
                                    const isNext = i === digits.length && !locked && !pending;
                                    return (
                                        <span
                                            key={i}
                                            className={`flex h-14 flex-1 items-center justify-center rounded-xl border font-mono text-2xl font-black transition-all duration-150 min-[1600px]:h-20 min-[1600px]:text-4xl ${
                                                error
                                                    ? 'border-[#f43f5e]/50 bg-[#f43f5e]/5 text-[#fda4af]'
                                                    : filled
                                                        ? 'border-[#2dd4bf]/60 bg-[#2dd4bf]/10 text-[#5eead4]'
                                                        : isNext
                                                            ? 'border-[#2dd4bf]/45 bg-[#141d1c] text-[#566e6a]'
                                                            : 'border-[#1a2524] bg-[#141d1c] text-[#566e6a]'
                                            }`}
                                        >
                                            {filled ? '•' : isNext ? <span className="hearth-caret">▍</span> : '·'}
                                        </span>
                                    );
                                })}
                            </div>

                            {/* Status */}
                            {error && (
                                <div role="alert" className="hearth-fade-up mb-4 flex items-start gap-2.5 rounded-xl border border-[#f43f5e]/35 bg-[#f43f5e]/10 px-3.5 py-3">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#fda4af]" />
                                    <p className="text-xs font-semibold leading-relaxed text-[#fda4af] min-[1600px]:text-lg">{error}</p>
                                </div>
                            )}
                            {locked && (
                                <div className="hearth-fade-up mb-4 flex items-center gap-2.5 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-3.5 py-3">
                                    <Loader2 className="hearth-spin h-4 w-4 shrink-0 text-[#fbbf24]" />
                                    <p className="text-xs font-semibold text-[#fbbf24] min-[1600px]:text-lg">
                                        Too many tries — wait {cooldown}s
                                    </p>
                                </div>
                            )}

                            {/* Keypad */}
                            <div className="grid grid-cols-3 gap-2 min-[1600px]:gap-3">
                                {keys.map((k, i) => (
                                    <button
                                        key={k.value + i}
                                        type="button"
                                        ref={el => { keyRefs.current[i] = el; }}
                                        disabled={pending || locked}
                                        aria-label={k.kind === 'back' ? 'Delete last digit' : k.kind === 'clear' ? 'Clear all digits' : `Digit ${k.label}`}
                                        onClick={() => {
                                            if (k.kind === 'digit') append(k.value);
                                            else if (k.kind === 'back') backspace();
                                            else clearAll();
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'ArrowLeft') { e.preventDefault(); moveKeyFocus(i, 'left'); }
                                            if (e.key === 'ArrowRight') { e.preventDefault(); moveKeyFocus(i, 'right'); }
                                            if (e.key === 'ArrowUp') { e.preventDefault(); moveKeyFocus(i, 'up'); }
                                            if (e.key === 'ArrowDown') { e.preventDefault(); moveKeyFocus(i, 'down'); }
                                        }}
                                        className={`hearth-focus flex h-14 items-center justify-center rounded-xl border text-xl font-bold transition-all duration-150 active:scale-95 disabled:opacity-40 min-[1600px]:h-20 min-[1600px]:text-3xl ${
                                            k.kind === 'digit'
                                                ? 'border-[#2b3a38] bg-[#141d1c] text-[#e8f1ef] hover:border-[#2dd4bf]/55 hover:bg-[#1b2726]'
                                                : 'border-[#1a2524] bg-[#101918] text-[#9db6b1] hover:border-[#f43f5e]/40 hover:text-[#fda4af]'
                                        }`}
                                    >
                                        {k.kind === 'back' ? <Delete className="h-5 w-5 min-[1600px]:h-7 min-[1600px]:w-7" />
                                            : k.kind === 'clear' ? <X className="h-5 w-5 min-[1600px]:h-7 min-[1600px]:w-7" />
                                                : k.label}
                                    </button>
                                ))}
                            </div>

                            <button
                                type="button"
                                ref={submitRef}
                                disabled={digits.length !== CODE_LEN || pending || locked}
                                onClick={() => void submit(digits)}
                                className="hearth-focus mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3.5 text-sm font-black text-[#04110f] shadow-[0_10px_34px_-10px_rgba(45,212,191,0.75)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.99] disabled:opacity-40 min-[1600px]:py-5 min-[1600px]:text-2xl"
                            >
                                {pending ? <Loader2 className="hearth-spin h-5 w-5" /> : <Play className="h-4 w-4" />}
                                {pending ? 'Checking…' : mode === 'code' ? 'Sign in' : 'Enter as guest'}
                            </button>

                            <p className="mt-3 text-center text-[11px] text-[#566e6a] min-[1600px]:text-base">
                                Arrow keys move · OK presses · Back deletes a digit
                            </p>
                        </div>

                        {/* Bot / QR */}
                        <div className="border-t border-[#1a2524] bg-[#0b1110] px-5 py-5 sm:px-6 min-[1600px]:px-8">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#758f8a] min-[1600px]:text-base">
                                    <QrCode className="h-3.5 w-3.5 text-[#2dd4bf]" /> Get a code from Telegram
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setShowQr(v => !v)}
                                    className="hearth-focus rounded-lg px-2 py-1 text-xs font-bold text-[#5eead4] transition-colors duration-150 hover:text-white min-[1600px]:text-base"
                                >
                                    {showQr ? 'Hide QR' : 'Show QR'}
                                </button>
                            </div>

                            {bot ? (
                                <div className={`flex ${showQr ? 'flex-col items-center gap-4 sm:flex-row sm:items-center' : 'flex-col gap-3'}`}>
                                    {showQr && (
                                        <div className="w-36 shrink-0 rounded-xl border border-[#2dd4bf]/30 bg-[#f2f7f6] p-2.5 shadow-[0_14px_40px_-16px_rgba(45,212,191,0.5)] min-[1600px]:w-48">
                                            <QRCode value={botLink} className="h-auto w-full" />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <p className="text-xs leading-relaxed text-[#9db6b1] min-[1600px]:text-lg">
                                            Scan with your phone camera, send <span className="font-mono font-bold text-[#c3d6d2]">/login</span>,
                                            then type the code here.
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                            <a
                                                href={botLink} target="_blank" rel="noreferrer"
                                                className="hearth-focus inline-flex items-center gap-1.5 rounded-lg border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-3 py-2 font-mono text-xs font-bold text-[#5eead4] transition-all duration-150 hover:bg-[#2dd4bf]/20 min-[1600px]:text-lg"
                                            >
                                                <ExternalLink className="h-3.5 w-3.5" /> @{bot}
                                            </a>
                                            <button
                                                type="button" onClick={() => void copyLink()}
                                                className={`hearth-focus inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition-all duration-150 min-[1600px]:text-lg ${
                                                    copied
                                                        ? 'border-[#4ade80]/50 bg-[#4ade80]/10 text-[#4ade80]'
                                                        : 'border-[#2b3a38] bg-[#141d1c] text-[#9db6b1] hover:text-white'
                                                }`}
                                            >
                                                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                                {copied ? 'Copied' : 'Copy link'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <p className="flex items-start gap-2 text-xs leading-relaxed text-[#9db6b1] min-[1600px]:text-lg">
                                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fbbf24]" />
                                    Open the Telegram bot you set up with this server and send
                                    <span className="font-mono font-bold text-[#c3d6d2]">/login</span> to get a code.
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="mt-5 flex justify-center lg:hidden"><DeviceChip /></div>
                    <p className="mt-4 text-center text-[11px] text-[#3f524f] min-[1600px]:text-base">
                        Hearth · based on TelePlay by subinps (MIT)
                    </p>
                </section>
            </div>
        </div>
    );
}

/* ═══════════════════════════════ App ═══════════════════════════════ */

type Boot = 'checking' | 'login' | 'ready';

function HearthApp() {
    const qc = useQueryClient();
    const {
        setIsAuthenticated, setMe, setRole, addToast, clearSelection,
        deleteConfirm, setDeleteConfirm, moveItems, setMoveItems,
        renameFile, renameFolder, setRenameFile, setRenameFolder,
        newFolderParentId, setNewFolderParentId,
    } = useAppStore();

    const [boot, setBoot] = useState<Boot>(() => (getAccessToken() ? 'checking' : 'login'));
    const [slow, setSlow] = useState(false);

    const deleteFilesMutation = useDeleteFiles();
    const deleteFoldersMutation = useDeleteFolders();
    const [deleting, setDeleting] = useState(false);

    // Inside your main App component function:
    useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
  
    // If we have a code and aren't already logged in, exchange it
    if (code && !isAuthenticated()) {
        loginWithCode(code)
        .then(() => {
            // Success! Scrub the code from the URL history so it can't be reused
            window.history.replaceState({}, document.title, window.location.pathname);
        })
        .catch((err) => {
            console.error("Auto-login failed:", err);
            // Scrub it anyway so they don't get stuck in an error loop
            window.history.replaceState({}, document.title, window.location.pathname);
        });
  }
    }, []);

    /* Verify the session once, hydrate role, never dead-end. */
    useEffect(() => {
        if (!getAccessToken()) { setBoot('login'); return; }
        let live = true;
        const slowTimer = setTimeout(() => { if (live) setSlow(true); }, 9000);
        fetchMe()
            .then(me => {
                if (!live) return;
                setMe(me);
                setRole(me.role);
                setIsAuthenticated(true);
                setBoot('ready');
            })
            .catch(err => {
                if (!live) return;
                if (errorStatus(err) === 401 || !getAccessToken()) setBoot('login');
                else setBoot('ready');       // offline / waking server: Home shows its own retry
            })
            .finally(() => { clearTimeout(slowTimer); if (live) setSlow(false); });
        return () => { live = false; clearTimeout(slowTimer); };
    }, [setMe, setRole, setIsAuthenticated]);

    useEffect(() => {
        const onExpired = () => setBoot('login');
        window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
        return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
    }, []);

    const onSignedIn = useCallback(() => {
        void qc.invalidateQueries();
        setBoot('ready');
    }, [qc]);

    /* Store-driven delete (item actions sheet). Optimistic, with rollback. */
    const confirmItems = deleteConfirm?.items ?? [];
    const fileItems = confirmItems.filter(i => 'file_name' in i) as TelegramFile[];
    const folderItems = confirmItems.filter(i => !('file_name' in i)) as Folder[];
    const confirmType: 'file' | 'folder' | 'multiple' =
        confirmItems.length > 1 ? 'multiple' : folderItems.length ? 'folder' : 'file';
    const confirmName = fileItems[0]?.file_name ?? folderItems[0]?.name ?? '';

    const removeIdsFromCaches = useCallback((ids: number[]) => {
        const set = new Set(ids);
        const entries = qc.getQueryCache().findAll({
            predicate: q => q.queryKey[0] === 'files' || q.queryKey[0] === 'continue-watching' || q.queryKey[0] === 'recent',
        });
        for (const entry of entries) {
            const data = entry.state.data as { files?: TelegramFile[]; total?: number } | undefined;
            if (!data?.files?.length) continue;
            const files = data.files.filter(f => !set.has(f.id));
            if (files.length === data.files.length) continue;
            qc.setQueryData(entry.queryKey, {
                ...data,
                files,
                total: typeof data.total === 'number' ? Math.max(0, data.total - (data.files.length - files.length)) : undefined,
            });
        }
    }, [qc]);

    const runDelete = useCallback(async () => {
        if (deleting) return;
        setDeleting(true);
        const fileIds = fileItems.map(f => f.id);
        const folderIds = folderItems.map(f => f.id);
        if (fileIds.length) removeIdsFromCaches(fileIds);
        try {
            if (fileIds.length) await deleteFilesMutation.mutateAsync(fileIds);
            if (folderIds.length) await deleteFoldersMutation.mutateAsync(folderIds);
            const count = fileIds.length + folderIds.length;
            addToast(
                count > 1 ? `Deleted ${count} items — removed from Telegram too` : 'Deleted — removed from Telegram too',
                'success',
            );
            clearSelection();
            setDeleteConfirm(null);
        } catch (err) {
            void qc.invalidateQueries();      // roll the optimistic removal back
            throw err;                        // ConfirmDelete shows it inline and stays open
        } finally {
            setDeleting(false);
        }
    }, [deleting, fileItems, folderItems, removeIdsFromCaches, deleteFilesMutation, deleteFoldersMutation, addToast, clearSelection, setDeleteConfirm, qc]);

    return (
        <div data-hearth-app className="relative min-h-screen bg-[#070b0b] text-[#e8f1ef]">
            <HearthDefs />

            {/* Ember-aurora backdrop: teal hearth glow, warm ember, cool sky, fine grain */}
            <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
                <div
                    className="absolute inset-0"
                    style={{
                        background:
                            'radial-gradient(58% 46% at 10% 0%, rgba(20,184,166,0.16), transparent 70%),' +
                            'radial-gradient(48% 42% at 96% 100%, rgba(245,158,11,0.11), transparent 70%),' +
                            'radial-gradient(38% 32% at 82% 8%, rgba(56,189,248,0.08), transparent 70%)',
                    }}
                />
                <div
                    className="hearth-drift absolute -inset-[12%]"
                    style={{
                        background:
                            'radial-gradient(42% 36% at 32% 62%, rgba(45,212,191,0.09), transparent 70%),' +
                            'radial-gradient(32% 30% at 70% 28%, rgba(225,29,72,0.06), transparent 70%)',
                    }}
                />
                <div className="hearth-grain absolute inset-0" />
            </div>

            <div className="relative z-10">
                {boot === 'checking' && <BootScreen slow={slow} onContinue={() => setBoot('ready')} />}
                {boot === 'login' && <LoginScreen onSignedIn={onSignedIn} />}
                {boot === 'ready' && <FileBrowser />}
            </div>

            {/* Overlays */}
            {boot === 'ready' && (
                <>
                    <MediaPlayer />
                    <GlobalContextMenu />

                    {deleteConfirm && (
                        <DeleteConfirmModal
                            type={confirmType}
                            name={confirmName}
                            count={confirmItems.length}
                            busy={deleting}
                            onConfirm={runDelete}
                            onClose={() => setDeleteConfirm(null)}
                        />
                    )}

                    {/* {moveItems && <MoveFileModal items={moveItems} onClose={() => setMoveItems(null)} />} */}

                </>
            )}

            {/* Home mounts its own <Toasts/>; App covers boot and sign-in so nothing doubles. */}
            {boot !== 'ready' && <Toasts />}
        </div>
    );
}

export default function App() {
    return (
        <ErrorBoundary>
            <HearthApp />
        </ErrorBoundary>
    );
}
