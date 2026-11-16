/**
 * Hearth — FileCard  ·  the TV-first media card (README §7.4 "VideoCard", §8.2, §8.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE → AFTER
 *  · click selects / double-click plays        → single click / OK plays instantly
 *  · 3-dot context menu + multi-select ring    → removed; admin Manage mode shows Delete
 *  · thumbnail URL carried the 7-day JWT       → Authorization header → blob URL (cached)
 *  · window.location.origin thumbnails (F16)   → resolved against the API origin
 *  · aspect-ratio box (breaks Chromium < 88)   → padding-top 56.25% (§7.6)
 *  · hover-only play overlay / gradient        → permanent play affordance, no hover-only UI
 *  · backdrop-blur badges                      → solid ink chips (no backdrop-filter on TV)
 *  · file_type only (F6)                       → mime + extension twin: videos sent as files play
 *  · no focus contract                         → tabIndex 0, role=button, 4px teal ring + scale 1.06
 *  · no capability feedback                    → real canPlayType probe + MKV/AVI warning chip
 *  · no resume story                           → progress bar, "Resume 23:14 · 42 min left", Watched
 *  · no remote affordances                     → long-press OK / Menu key → Manage, Delete key, TV Back safe
 *
 * Legacy props (viewMode / selected / onSelect) are accepted and intentionally ignored so
 * older callers keep compiling — the flat library has no list view and no multi-select (§4.3).
 * Emits the data attributes Home navigates with: data-hb-focus / data-hb-id / data-hb-delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { memo, useEffect, useRef, useState } from 'react';
import type {
    KeyboardEvent as ReactKeyboardEvent,
    PointerEvent as ReactPointerEvent,
} from 'react';
import {
    AlertTriangle, CheckCircle2, Clock, FileText, Film, Image as ImageIcon, Music, Play, Trash2,
} from 'lucide-react';
import { TelegramFile, formatDuration, formatFileSize, api } from '../lib/api';

/* ═══════════════════════════ Types & constants ═══════════════════════════ */

export type HubFile = TelegramFile & {
    mime_type?: string | null;
    completed?: boolean;
    width?: number | null;
    height?: number | null;
    created_at?: string;
    updated_at?: string;
};

export interface FileCardProps {
    file: HubFile;
    onPlay: (file: HubFile) => void;
    /** 'resume' emphasises the continue-watching story. */
    variant?: 'grid' | 'resume';
    /** Admin Manage mode (§8.4). */
    manage?: boolean;
    canManage?: boolean;
    onDelete?: (file: HubFile) => void;
    onLongManage?: (id: number) => void;
    /** Entrance stagger index. */
    index?: number;
    /** @deprecated flat library — ignored. */ viewMode?: 'grid' | 'list';
    /** @deprecated no multi-select — ignored. */ selected?: boolean;
    /** @deprecated no multi-select — ignored. */ onSelect?: (multi: boolean) => void;
}

const VIDEO_EXTS = ['MP4', 'MKV', 'WEBM', 'MOV', 'AVI', 'M4V', 'TS', 'WMV', 'FLV', '3GP'];
const RISKY_EXTS = ['MKV', 'AVI', 'WMV', 'FLV', 'TS'];

const CARD_CSS = `
[data-hearth-card]{-webkit-tap-highlight-color:transparent;}
.hc-card{transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
.hc-card:hover{border-color:rgba(45,212,191,.45);}
.hc-card:focus{outline:none;transform:scale(1.06);z-index:6;border-color:rgba(45,212,191,.65);
  box-shadow:0 0 0 4px #5eead4,0 18px 40px -12px rgba(20,184,166,.45);}
.hc-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hc-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
@keyframes hcIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes hcPop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
@keyframes hcShimmer{0%{opacity:.45}50%{opacity:.8}100%{opacity:.45}}
.hc-in{animation:hcIn .18s ease-out backwards}
.hc-pop{animation:hcPop .16s ease-out backwards}
.hc-shimmer{animation:hcShimmer 1.4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.hc-in,.hc-pop,.hc-shimmer{animation:none}.hc-card{transition:none}}
`;
function ensureCardStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-card-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-card-css';
    el.textContent = CARD_CSS;
    document.head.appendChild(el);
}
ensureCardStyles();

/* ═══════════════════════════════ Helpers ═══════════════════════════════ */

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const fmtTime = (s: number) => formatDuration(Number.isFinite(s) && s > 0 ? Math.floor(s) : 0);

/** F16: never resolve API paths against the Pages origin. */
const resolveApiUrl = (path: string): string => {
    if (/^https?:\/\//i.test(path)) return path;
    const base = api.defaults.baseURL ?? '/api';
    const origin = /^https?:\/\//i.test(base) ? new URL(base).origin : window.location.origin;
    return new URL(path, origin).href;
};

const containerOf = (f: HubFile) => {
    const m = /\.([a-z0-9]{2,4})$/i.exec(f.file_name || '');
    if (m) return m[1].toUpperCase();
    const mime = f.mime_type ?? '';
    if (mime.includes('matroska')) return 'MKV';
    if (mime.startsWith('video/')) return mime.slice(6).toUpperCase();
    if (mime.startsWith('audio/')) return mime.slice(6).toUpperCase();
    if (mime.startsWith('image/')) return mime.slice(6).toUpperCase();
    return 'FILE';
};
const isVideoFile = (f: HubFile) =>
    f.file_type === 'video' || (f.mime_type ?? '').startsWith('video/') || VIDEO_EXTS.includes(containerOf(f));
const isAudioFile = (f: HubFile) => f.file_type === 'audio' || (f.mime_type ?? '').startsWith('audio/');
const isImageFile = (f: HubFile) => f.file_type === 'image' || (f.mime_type ?? '').startsWith('image/');
const isPlayable = (f: HubFile) => isVideoFile(f) || isAudioFile(f);

/** Real device capability probe (§8.2) — cached, never throws on old WebViews. */
const probeCache = new Map<string, string>();
function supportFor(mime: string): string {
    if (!mime) return 'maybe';
    const hit = probeCache.get(mime);
    if (hit !== undefined) return hit;
    let result = 'maybe';
    try {
        const el = document.createElement(isAudioMime(mime) ? 'audio' : 'video');
        result = el.canPlayType(mime) || '';
    } catch { /* very old WebView */ }
    probeCache.set(mime, result);
    return result;
}
const isAudioMime = (m: string) => m.startsWith('audio/');
const isRisky = (f: HubFile) => {
    const mime = f.mime_type ?? '';
    return RISKY_EXTS.includes(containerOf(f))
        || mime.includes('matroska')
        || (!!mime && supportFor(mime) === '');
};

const isWatched = (f: HubFile) => {
    const pos = f.last_pos ?? 0, dur = f.duration ?? 0;
    return !!f.completed || (dur > 0 && pos >= dur * 0.95);
};
const remainingLabel = (f: HubFile) => {
    const pos = f.last_pos ?? 0, dur = f.duration ?? 0;
    if (dur <= 0 || pos <= 0) return '';
    const left = Math.max(0, dur - pos);
    if (left >= 3600) return `${Math.floor(left / 3600)}h ${Math.round((left % 3600) / 60)}m left`;
    if (left >= 60) return `${Math.round(left / 60)} min left`;
    return `${Math.floor(left)}s left`;
};

/* Thumbnails: Authorization header → blob URL, LRU-cached (§4.6). */
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
                const objUrl = URL.createObjectURL(data as Blob);
                thumbCache.set(fileId, objUrl);
                thumbOrder.push(fileId);
                if (thumbOrder.length > 64) {
                    const old = thumbOrder.shift();
                    if (old !== undefined) {
                        const ou = thumbCache.get(old);
                        if (ou) URL.revokeObjectURL(ou);
                        thumbCache.delete(old);
                    }
                }
                setSrc(objUrl);
            })
            .catch(() => { if (live) setSrc(null); });
        return () => { live = false; };
    }, [fileId, url]);
    return src;
}

/** Keep a focused card on screen for remote users (no smooth scroll on TV). */
function ensureVisible(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < 90 || r.bottom > vh - 90) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    }
}

/* ═══════════════════════════════ Fallback art ═══════════════════════════════ */

function FallbackArt({ file }: { file: HubFile }) {
    const Icon = isVideoFile(file) ? Film : isAudioFile(file) ? Music : isImageFile(file) ? ImageIcon : FileText;
    const bg = isAudioFile(file)
        ? 'radial-gradient(80% 90% at 20% 15%, rgba(56,189,248,0.30), transparent 60%),' +
          'radial-gradient(70% 80% at 85% 85%, rgba(45,212,191,0.22), transparent 60%),' +
          'linear-gradient(135deg, #0f766e 0%, #134e4a 40%, #1e3a5f 100%)'
        : 'radial-gradient(80% 90% at 20% 15%, rgba(45,212,191,0.28), transparent 60%),' +
          'radial-gradient(70% 80% at 85% 85%, rgba(245,158,11,0.20), transparent 60%),' +
          'linear-gradient(135deg, #0f766e 0%, #134e4a 38%, #1e3a5f 72%, #7c2d12 100%)';
    return (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: bg }}>
            <Icon className="h-12 w-12 text-white/30 min-[1600px]:h-20 min-[1600px]:w-20" />
        </div>
    );
}

/* ═══════════════════════════════ The card ═══════════════════════════════ */

function FileCardBase({
    file, onPlay, variant = 'grid', manage = false, canManage = false,
    onDelete, onLongManage, index = 0,
}: FileCardProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longFired = useRef(false);
    const [imgFailed, setImgFailed] = useState(false);
    const thumb = useThumbnail(file.id, file.thumbnail_url);

    const cont = containerOf(file);
    const risky = isRisky(file);
    const playable = isPlayable(file);
    const watched = isWatched(file);
    const showDelete = manage && canManage && !!onDelete;
    const pos = file.last_pos ?? 0;
    const dur = file.duration ?? 0;
    const pct = dur > 0 ? clamp(pos / dur, 0, 1) : 0;
    const leftLabel = remainingLabel(file);
    const sizeLabel = (() => { try { return formatFileSize(file.file_size); } catch { return ''; } })();

    useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);
    useEffect(() => { setImgFailed(false); }, [file.id]);

    const focusDelete = () => {
        cardRef.current?.querySelector<HTMLButtonElement>('[data-hb-delete]')?.focus();
    };
    const activate = () => {
        if (showDelete) focusDelete();
        else onPlay(file);
    };
    const startPress = () => {
        if (!canManage || !onLongManage) return;
        longFired.current = false;
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = setTimeout(() => {
            longFired.current = true;
            onLongManage(file.id);
        }, 550);
    };
    const endPress = () => {
        if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (e.repeat) return;
            if (showDelete) { focusDelete(); return; }
            if (canManage && onLongManage) startPress();
            else activate();
            return;
        }
        if (e.key === 'Delete' && canManage && onDelete) {
            e.preventDefault();
            onDelete(file);
            return;
        }
        if (e.key === 'ContextMenu' || e.keyCode === 93) {
            if (canManage && onLongManage) { e.preventDefault(); onLongManage(file.id); }
        }
    };
    const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const wasLong = longFired.current;
        endPress();
        longFired.current = false;
        if (!wasLong && !showDelete) activate();
    };
    const onClick = () => {
        if (longFired.current) { longFired.current = false; return; }
        activate();
    };
    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.pointerType !== 'mouse') startPress();
    };

    const ariaLabel = showDelete
        ? `Manage ${file.file_name} — press OK to focus Delete`
        : playable
            ? `${watched ? 'Watched' : pos > 0 ? `Resume ${fmtTime(pos)} of ${fmtTime(dur)}` : 'Play'} ${file.file_name}`
            : `${file.file_name} — not playable in the browser`;

    return (
        <div
            ref={cardRef}
            data-hearth-card
            data-hb-focus
            data-hb-id={file.id}
            data-file-id={file.id}
            role="button"
            tabIndex={0}
            aria-label={ariaLabel}
            className={`tv-card hc-card hc-in group relative cursor-pointer select-none rounded-2xl border bg-[#0e1514] p-2.5 min-[1600px]:p-3.5 ${
                variant === 'resume' ? 'border-[#2dd4bf]/30' : 'border-[#1a2524]'
            }`}
            style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onPointerDown={onPointerDown}
            onPointerUp={endPress}
            onPointerLeave={endPress}
            onPointerCancel={endPress}
            onFocus={(e) => { if (e.currentTarget === e.target) ensureVisible(e.currentTarget); }}
            onContextMenu={(e) => { e.preventDefault(); if (canManage && onLongManage) onLongManage(file.id); }}
        >
            {/* 16:9 with padding-top — old-TV safe (§7.6) */}
            <div className="relative w-full overflow-hidden rounded-xl bg-[#141d1c] pt-[56.25%]">
                <div className="absolute inset-0">
                    {thumb && !imgFailed ? (
                        <img
                            src={thumb}
                            alt=""
                            draggable={false}
                            className="h-full w-full object-cover"
                            onError={() => setImgFailed(true)}
                        />
                    ) : (
                        <FallbackArt file={file} />
                    )}
                    <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

                    {/* Container / compatibility badge */}
                    <span className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide min-[1600px]:text-sm ${
                        risky
                            ? 'border border-[#fbbf24]/45 bg-[#3a2a06]/90 text-[#fbbf24]'
                            : 'border border-[#2dd4bf]/35 bg-[#042f2e]/85 text-[#5eead4]'
                    }`}>
                        {risky && <AlertTriangle className="h-3 w-3" />}
                        {cont}
                    </span>

                    {watched && !showDelete && (
                        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg border border-[#4ade80]/40 bg-[#052e16]/90 px-2 py-0.5 text-[10px] font-bold text-[#4ade80] min-[1600px]:text-sm">
                            <CheckCircle2 className="h-3 w-3" /> Watched
                        </span>
                    )}

                    {/* Permanent play affordance — never hover-only */}
                    {playable && (
                        <span className="absolute bottom-2.5 left-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-[#2dd4bf] text-[#04110f] shadow-[0_4px_16px_-2px_rgba(45,212,191,0.7)] transition-transform duration-150 group-focus:scale-110 min-[1600px]:h-11 min-[1600px]:w-11">
                            <Play className="ml-0.5 h-4 w-4 min-[1600px]:h-5 min-[1600px]:w-5" />
                        </span>
                    )}

                    {dur > 0 && (
                        <span className="absolute bottom-2.5 right-2.5 rounded-lg bg-black/80 px-2 py-0.5 font-mono text-[11px] font-bold text-white min-[1600px]:text-sm">
                            {fmtTime(dur)}
                        </span>
                    )}

                    {pct > 0 && !watched && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20 min-[1600px]:h-1.5">
                            <div
                                className="h-full bg-gradient-to-r from-[#0d9488] via-[#2dd4bf] to-[#38bdf8]"
                                style={{ width: `${pct * 100}%` }}
                            />
                        </div>
                    )}
                </div>
            </div>

            <div className="px-1 pt-2.5 min-[1600px]:pt-3.5">
                <p className="hc-clamp2 text-sm font-bold leading-snug text-[#e8f1ef] min-[1600px]:text-2xl">
                    {file.file_name}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#9db6b1] min-[1600px]:text-base">
                    {variant === 'resume' && pos > 0 && !watched ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-[#5eead4]">
                            <Clock className="h-3.5 w-3.5" />
                            {fmtTime(pos)}{leftLabel ? ` · ${leftLabel}` : ''}
                        </span>
                    ) : (
                        <span>{sizeLabel || (playable ? cont : isImageFile(file) ? 'Photo' : 'Document')}</span>
                    )}
                    {variant !== 'resume' && pos > 0 && !watched && dur > 0 && (
                        <span className="font-mono text-[#5eead4]/80">{Math.round(pct * 100)}%</span>
                    )}
                    {risky && <span className="text-[#fbbf24]/90">may not play here</span>}
                    {!playable && <span className="text-[#758f8a]">not playable in browser</span>}
                </p>
            </div>

            {showDelete && (
                <button
                    type="button"
                    data-hb-delete
                    data-hb-focus
                    aria-label={`Delete ${file.file_name}`}
                    title="Delete — removes it from Telegram too"
                    onClick={(e) => { e.stopPropagation(); onDelete?.(file); }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                        if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); onDelete?.(file); }
                    }}
                    onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
                    className="hc-focus hc-pop absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#f43f5e]/50 bg-[#2a1215]/95 text-[#fda4af] shadow-lg transition-all duration-150 hover:bg-[#f43f5e] hover:text-white active:scale-90 min-[1600px]:h-14 min-[1600px]:w-14"
                >
                    <Trash2 className="h-5 w-5 min-[1600px]:h-6 min-[1600px]:w-6" />
                </button>
            )}
        </div>
    );
}

const FileCard = memo(FileCardBase);
export { FileCard as VideoCard };
export default FileCard;