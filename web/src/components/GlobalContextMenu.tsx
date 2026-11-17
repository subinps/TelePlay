/**
 * Hearth — GlobalContextMenu  ·  simplified item actions sheet
 * ─────────────────────────────────────────────────────────────────────────────
 * Simplified to keep only:
 *  · File name & visual header (thumbnail, format, progress)
 *  · Play / Resume button
 *  · Delete button (admin-only, opens ConfirmDelete)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from 'react';
import {
    CheckCircle2, Clock, Film, Folder as FolderIcon,
    Loader2, Music, Play, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { TelegramFile, Folder, api, formatDuration, formatFileSize } from '../lib/api';
import { useAppStore } from '../lib/store';

type HubFile = TelegramFile & {
    mime_type?: string | null;
    completed?: boolean;
};

const ACTIONS_CSS = `
[data-hearth-actions]{-webkit-tap-highlight-color:transparent;}
.ha-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.ha-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.ha-scroll::-webkit-scrollbar{width:10px;}
.ha-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.ha-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0e1514;}
.ha-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes haFade{from{opacity:0}to{opacity:1}}
@keyframes haPop{from{opacity:0;transform:scale(.97) translateY(10px)}to{opacity:1;transform:none}}
@keyframes haSpin{to{transform:rotate(360deg)}}
.ha-fade{animation:haFade .15s ease-out backwards}
.ha-pop{animation:haPop .18s ease-out backwards}
.ha-spin{animation:haSpin .9s linear infinite}
.ha-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
@media (prefers-reduced-motion:reduce){.ha-fade,.ha-pop{animation:none}}
`;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-actions-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-actions-css';
    el.textContent = ACTIONS_CSS;
    document.head.appendChild(el);
}
ensureStyles();

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const fmtTime = (s: number) => formatDuration(Number.isFinite(s) && s > 0 ? Math.floor(s) : 0);
const resolveApiUrl = (path: string): string => {
    if (/^https?:\/\//i.test(path)) return path;
    const base = api.defaults.baseURL ?? '/api';
    const origin = /^https?:\/\//i.test(base) ? new URL(base).origin : window.location.origin;
    return new URL(path, origin).href;
};
const isBackKey = (e: KeyboardEvent) =>
    e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === 'GoBack'
    || e.keyCode === 461 || e.keyCode === 10009;

const containerOf = (f: HubFile) => {
    const m = /\.([a-z0-9]{2,4})$/i.exec(f.file_name || '');
    if (m) return m[1].toUpperCase();
    const mime = f.mime_type ?? '';
    if (mime.includes('matroska')) return 'MKV';
    if (mime.startsWith('video/')) return mime.slice(6).toUpperCase();
    if (mime.startsWith('audio/')) return mime.slice(6).toUpperCase();
    return 'FILE';
};
const isPlayable = (f: HubFile) =>
    f.file_type === 'video' || f.file_type === 'audio'
    || (f.mime_type ?? '').startsWith('video/') || (f.mime_type ?? '').startsWith('audio/');
const isRisky = (f: HubFile) => {
    const c = containerOf(f);
    return ['MKV', 'AVI', 'WMV', 'FLV', 'TS'].includes(c) || (f.mime_type ?? '').includes('matroska');
};

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
function useThumbnail(fileId: number, url?: string | null): string | null {
    const [src, setSrc] = useState<string | null>(() => thumbCache.get(fileId) ?? null);
    useEffect(() => {
        let live = true;
        const hit = thumbCache.get(fileId);
        if (hit) { setSrc(hit); return; }
        if (!url) { setSrc(null); return; }
        api.get(resolveApiUrl(url), { responseType: 'blob' })
            .then(({ data }) => {
                if (!live) return;
                const obj = URL.createObjectURL(data as Blob);
                thumbCache.set(fileId, obj);
                setSrc(obj);
            })
            .catch(() => { if (live) setSrc(null); });
        return () => { live = false; };
    }, [fileId, url]);
    return src;
}

function SheetThumb({ file }: { file: HubFile }) {
    const thumb = useThumbnail(file.id, file.thumbnail_url);
    const [failed, setFailed] = useState(false);
    const Icon = file.file_type === 'audio' || (file.mime_type ?? '').startsWith('audio/') ? Music : Film;
    return (
        <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-xl border border-[#1a2524] bg-[#141d1c] min-[1600px]:h-28 min-[1600px]:w-44">
            {thumb && !failed ? (
                <img src={thumb} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
            ) : (
                <div
                    className="flex h-full w-full items-center justify-center"
                    style={{
                        background:
                            'radial-gradient(80% 90% at 20% 15%, rgba(45,212,191,0.28), transparent 60%),' +
                            'linear-gradient(135deg, #0f766e 0%, #134e4a 45%, #1e3a5f 100%)',
                    }}
                >
                    <Icon className="h-7 w-7 text-white/35" />
                </div>
            )}
        </div>
    );
}

export default function GlobalContextMenu() {
    const {
        activeContextMenu, setActiveContextMenu, setPreviewFile, setDeleteConfirm,
        previewFile, deleteConfirm, addToast,
    } = useAppStore();

    const sheetRef = useRef<HTMLDivElement>(null);
    const restoreRef = useRef<HTMLElement | null>(null);
    const [role, setRole] = useState('admin');
    const [opening, setOpening] = useState(false);

    const open = !!activeContextMenu;
    const item = activeContextMenu?.item as HubFile | Folder | undefined;
    const isFolder = !!item && !('file_name' in item);
    const file = !isFolder ? (item as HubFile | undefined) : undefined;
    const folder = isFolder ? (item as Folder) : undefined;
    const canManage = role === 'admin';

    useEffect(() => {
        let live = true;
        void fetchRole().then(r => { if (live) setRole(r); });
        return () => { live = false; };
    }, []);

    /* The player owns the screen — never leave a stale sheet behind it. */
    useEffect(() => {
        if (previewFile && activeContextMenu) setActiveContextMenu(null);
    }, [previewFile, activeContextMenu, setActiveContextMenu]);

    /* Remote Menu / ContextMenu key → actions for the focused card.
       Stands down when Home is mounted (Home toggles Manage mode itself). */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (open || previewFile || deleteConfirm) return;
            if (!(e.key === 'ContextMenu' || e.key === 'Menu' || e.keyCode === 93)) return;
            if (document.querySelector('[data-hb-root]')) return;
            const host = (document.activeElement as HTMLElement | null)?.closest?.('[data-file-id]') as HTMLElement | null;
            if (!host) return;
            const id = Number(host.dataset.fileId);
            if (!Number.isFinite(id)) return;
            e.preventDefault();
            e.stopPropagation();
            const r = host.getBoundingClientRect();
            setOpening(true);
            api.get(`/files/${id}`)
                .then(({ data }) => {
                    setActiveContextMenu({
                        type: 'file',
                        item: data as TelegramFile,
                        x: r.left + r.width / 2,
                        y: r.top + r.height / 2,
                    });
                })
                .catch(() => addToast('Could not open actions for that item', 'error'))
                .finally(() => setOpening(false));
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, previewFile, deleteConfirm, setActiveContextMenu, addToast]);

    /* Focus, scroll lock and focus restore while the sheet is open. */
    useEffect(() => {
        if (!open) return;
        restoreRef.current = document.activeElement as HTMLElement | null;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const raf = requestAnimationFrame(() => {
            const el = sheetRef.current?.querySelector<HTMLElement>('[data-ha-autofocus]')
                ?? sheetRef.current?.querySelector<HTMLElement>('button:not([disabled])');
            el?.focus();
        });
        return () => {
            cancelAnimationFrame(raf);
            document.body.style.overflow = prevOverflow;
            const back = restoreRef.current;
            if (back && back.isConnected) back.focus();
        };
    }, [open]);

    /* The sheet owns the keyboard (capture phase beats other window listeners). */
    useEffect(() => {
        if (!open) return;
        const nav = (dir: 1 | -1) => {
            const items = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
                .filter(el => el.getClientRects().length > 0);
            if (!items.length) return;
            const i = items.indexOf(document.activeElement as HTMLElement);
            (items[(i + dir + items.length) % items.length] ?? items[0]).focus();
        };
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            if (isBackKey(e)) {
                e.preventDefault(); e.stopPropagation();
                setActiveContextMenu(null);
                return;
            }
            if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); nav(e.shiftKey ? -1 : 1); return; }
            if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); nav(1); return; }
            if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); nav(-1); return; }
            if (k === 'Enter' || k === ' ') {
                if ((e.target as HTMLElement | null)?.closest?.('button')) return;
                e.preventDefault(); e.stopPropagation();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, setActiveContextMenu]);

    if (!open || !item) {
        return opening ? (
            <div data-hearth-actions className="pointer-events-none fixed bottom-8 left-1/2 z-[190] -translate-x-1/2">
                <div className="ha-pop flex items-center gap-2 rounded-xl border border-[#2dd4bf]/35 bg-[#0e1514]/95 px-4 py-2 text-sm font-semibold text-[#5eead4] shadow-xl">
                    <Loader2 className="ha-spin h-4 w-4" /> Opening actions…
                </div>
            </div>
        ) : null;
    }

    const playable = !!file && isPlayable(file);
    const risky = !!file && isRisky(file);
    const pos = file?.last_pos ?? 0;
    const dur = file?.duration ?? 0;
    const pct = dur > 0 ? clamp(pos / dur, 0, 1) : 0;
    const watched = !!file?.completed || (dur > 0 && pos >= dur * 0.95);
    const title = file?.file_name ?? folder?.name ?? 'Item';

    const doPlay = () => {
        if (!file) return;
        setPreviewFile(file);
        setActiveContextMenu(null);
    };
    const doDelete = () => {
        setDeleteConfirm({ type: isFolder ? 'folder' : 'file', items: [item] });
        setActiveContextMenu(null);
    };

    const actions = [
        ...(playable ? [{
            id: 'play',
            label: watched ? 'Watch again' : pos > 0 ? `Resume from ${fmtTime(pos)}` : 'Play',
            sublabel: 'Original quality · signed for this device',
            icon: Play,
            onClick: doPlay,
            danger: false,
            autofocus: true,
        }] : []),
        ...(canManage ? [{
            id: 'delete',
            label: isFolder ? 'Delete collection…' : 'Delete…',
            sublabel: isFolder
                ? 'Videos inside stay in the library'
                : 'Removes it from Telegram too — you confirm next',
            icon: Trash2,
            onClick: doDelete,
            danger: true,
            autofocus: !playable,
        }] : []),
    ];

    return (
        <div
            data-hearth-actions
            className="fixed inset-0 z-[190] flex items-end justify-center p-0 sm:items-center sm:p-6"
            role="presentation"
        >
            <div className="ha-fade absolute inset-0 bg-black/75" onClick={() => setActiveContextMenu(null)} aria-hidden="true" />

            <div
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                aria-label={`Actions for ${title}`}
                className="ha-pop relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-[#1a2524] bg-[#0e1514] shadow-[0_-20px_70px_rgba(0,0,0,0.8)] sm:rounded-2xl sm:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_60px_-24px_rgba(45,212,191,0.4)] min-[1600px]:max-w-2xl"
            >
                <div className="h-1 w-full bg-gradient-to-r from-[#2dd4bf] via-[#38bdf8] to-[#fbbf24]" />

                {/* File Name & Visual Header */}
                <div className="flex items-start gap-4 px-5 pt-5 min-[1600px]:px-8 min-[1600px]:pt-7">
                    {file ? <SheetThumb file={file} /> : (
                        <span className="flex h-20 w-32 shrink-0 items-center justify-center rounded-xl border border-[#2dd4bf]/25 bg-gradient-to-br from-[#2dd4bf]/15 to-[#0d9488]/5 min-[1600px]:h-28 min-[1600px]:w-44">
                            <FolderIcon className="h-8 w-8 text-[#2dd4bf]" />
                        </span>
                    )}
                    <div className="min-w-0 flex-1">
                        <p className="ha-clamp2 text-base font-bold leading-snug text-[#e8f1ef] min-[1600px]:text-2xl">{title}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#9db6b1] min-[1600px]:text-base">
                            {file ? (
                                <>
                                    <span className={`rounded-md px-1.5 py-0.5 font-mono font-bold ${
                                        risky ? 'bg-[#fbbf24]/15 text-[#fbbf24]' : 'bg-[#2dd4bf]/15 text-[#5eead4]'
                                    }`}>{containerOf(file)}</span>
                                    <span>{formatFileSize(file.file_size)}</span>
                                    {dur > 0 && <span className="font-mono">{fmtTime(dur)}</span>}
                                    {watched && (
                                        <span className="inline-flex items-center gap-1 font-semibold text-[#4ade80]">
                                            <CheckCircle2 className="h-3.5 w-3.5" /> Watched
                                        </span>
                                    )}
                                </>
                            ) : (
                                <span>{folder?.file_count ?? 0} {(folder?.file_count ?? 0) === 1 ? 'video' : 'videos'}</span>
                            )}
                        </p>
                        {file && pct > 0 && !watched && (
                            <div className="mt-2">
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/12">
                                    <div className="h-full rounded-full bg-gradient-to-r from-[#0d9488] via-[#2dd4bf] to-[#38bdf8]" style={{ width: `${pct * 100}%` }} />
                                </div>
                                <p className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-[#5eead4] min-[1600px]:text-sm">
                                    <Clock className="h-3 w-3" /> {fmtTime(pos)} · {Math.round(pct * 100)}%
                                </p>
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        aria-label="Close actions"
                        onClick={() => setActiveContextMenu(null)}
                        className="ha-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#9db6b1] transition-all duration-150 hover:bg-white/10 hover:text-white min-[1600px]:h-14 min-[1600px]:w-14"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Simplified Actions: Play/Resume and Delete only */}
                <div className="ha-scroll flex-1 space-y-3 overflow-y-auto px-5 py-5 min-[1600px]:px-8">
                    {actions.map((action) => {
                        const Icon = action.icon;
                        return (
                            <button
                                key={action.id}
                                type="button"
                                {...(action.autofocus ? { 'data-ha-autofocus': true } : {})}
                                onClick={action.onClick}
                                className={
                                    action.danger
                                        ? 'ha-focus flex w-full items-center gap-3 rounded-xl border border-[#f43f5e]/40 bg-[#f43f5e]/10 px-5 py-4 text-left transition-all duration-150 hover:bg-[#f43f5e]/20 active:scale-[0.99] min-[1600px]:py-5'
                                        : 'ha-focus flex w-full items-center gap-3 rounded-xl bg-[#2dd4bf] px-5 py-4 text-left text-[#04110f] shadow-[0_10px_34px_-10px_rgba(45,212,191,0.7)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.99] min-[1600px]:py-5'
                                }
                            >
                                <Icon className={`h-6 w-6 shrink-0 ${action.danger ? 'text-[#fda4af]' : ''}`} />
                                <span className="min-w-0 flex-1">
                                    <span className={`block text-sm min-[1600px]:text-xl ${action.danger ? 'font-bold text-[#fda4af]' : 'font-black'}`}>
                                        {action.label}
                                    </span>
                                    <span className={`block text-xs font-semibold min-[1600px]:text-base ${action.danger ? 'text-[#fda4af]/70' : 'text-[#04110f]/70'}`}>
                                        {action.sublabel}
                                    </span>
                                </span>
                            </button>
                        );
                    })}

                    {!canManage && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10 px-4 py-3">
                            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#7dd3fc]" />
                            <p className="text-xs font-semibold leading-relaxed text-[#7dd3fc] min-[1600px]:text-base">
                                Guest access can play only. Ask the family account to change the library.
                            </p>
                        </div>
                    )}

                    <button
                        type="button"
                        {...(actions.length === 0 ? { 'data-ha-autofocus': true } : {})}
                        onClick={() => setActiveContextMenu(null)}
                        className="ha-focus flex w-full items-center justify-center gap-2 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.99] min-[1600px]:py-4 min-[1600px]:text-lg"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
