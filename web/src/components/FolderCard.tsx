/**
 * Hearth — FolderCard  ·  collection card (README §4.3: folders hidden from Home,
 *                          backend folder code deliberately untouched)
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE → AFTER
 *  · drag-and-drop move target            → removed from the UI (move stays in the backend)
 *  · 3-dot context menu + selection dot   → removed; no multi-select, no hover-only controls
 *  · grid + list variants                 → one TV-first card, OK / click opens
 *  · name + count only                    → real preview strip (first frames of the collection),
 *                                           live total from useFiles, honest empty state
 *  · glass-card / backdrop blur           → solid Hearth surfaces, no backdrop-filter (§7.6)
 *  · no focus contract                    → tabIndex 0, role=button, 4px teal ring + scale 1.06,
 *                                           data-hb-focus so Home's spatial nav can reach it
 *
 * Legacy props (viewMode / selected / onSelect / onFileDrop) are accepted and ignored so
 * older callers keep compiling. Home does not render folders — this card is ready for any
 * future collection view and keeps the folder feature intact rather than deleting it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronRight, Film, Folder as FolderIcon, Layers } from 'lucide-react';
import { Folder, TelegramFile, useFiles, api } from '../lib/api';

export interface FolderCardProps {
    folder: Folder;
    onOpen: () => void;
    index?: number;
    /** @deprecated flat library — ignored. */ viewMode?: 'grid' | 'list';
    /** @deprecated no multi-select — ignored. */ selected?: boolean;
    /** @deprecated no multi-select — ignored. */ onSelect?: (multi: boolean) => void;
    /** @deprecated drag-to-move removed from the UI — ignored. */
    onFileDrop?: (fileId: number, folderId: number) => void;
}

const FOLDER_CSS = `
[data-hearth-folder]{-webkit-tap-highlight-color:transparent;}
.hf-card{transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
.hf-card:hover{border-color:rgba(45,212,191,.45);}
.hf-card:focus{outline:none;transform:scale(1.06);z-index:6;border-color:rgba(45,212,191,.65);
  box-shadow:0 0 0 4px #5eead4,0 18px 40px -12px rgba(20,184,166,.45);}
.hf-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hf-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
@keyframes hfIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes hfShimmer{0%{opacity:.45}50%{opacity:.85}100%{opacity:.45}}
.hf-in{animation:hfIn .18s ease-out backwards}
.hf-shimmer{animation:hfShimmer 1.4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.hf-in,.hf-shimmer{animation:none}.hf-card{transition:none}}
`;
function ensureFolderStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-folder-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-folder-css';
    el.textContent = FOLDER_CSS;
    document.head.appendChild(el);
}
ensureFolderStyles();

const resolveApiUrl = (path: string): string => {
    if (/^https?:\/\//i.test(path)) return path;
    const base = api.defaults.baseURL ?? '/api';
    const origin = /^https?:\/\//i.test(base) ? new URL(base).origin : window.location.origin;
    return new URL(path, origin).href;
};

/* Shared blob-thumbnail cache (Authorization header, never a token in a URL). */
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

function PreviewTile({ file, tilt }: { file: TelegramFile; tilt: number }) {
    const thumb = useThumbnail(file.id, file.thumbnail_url);
    const [failed, setFailed] = useState(false);
    return (
        <div
            className="relative h-full flex-1 overflow-hidden rounded-lg border border-[#1a2524] bg-[#141d1c]"
            style={{ transform: `rotate(${tilt}deg)` }}
        >
            {thumb && !failed ? (
                <img src={thumb} alt="" draggable={false} className="h-full w-full object-cover" onError={() => setFailed(true)} />
            ) : (
                <div
                    className="flex h-full w-full items-center justify-center"
                    style={{
                        background:
                            'radial-gradient(80% 90% at 25% 15%, rgba(45,212,191,0.28), transparent 60%),' +
                            'linear-gradient(135deg, #0f766e 0%, #134e4a 45%, #1e3a5f 100%)',
                    }}
                >
                    <Film className="h-5 w-5 text-white/30" />
                </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 to-transparent" />
        </div>
    );
}

export default function FolderCard({ folder, onOpen, index = 0 }: FolderCardProps) {
    /* Real peek at the collection — cached by React Query, only fetched where folders render. */
    const { data, isLoading } = useFiles(folder.id, undefined, undefined, 1);
    const previews = ((data?.files as TelegramFile[] | undefined) ?? []).slice(0, 3);
    const total = data?.total ?? folder.file_count ?? 0;
    const declared = folder.file_count ?? 0;
    const empty = !isLoading && total === 0 && declared === 0;

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!e.repeat) onOpen();
        }
    };

    return (
        <div
            data-hearth-folder
            data-hb-focus
            data-folder-id={folder.id}
            role="button"
            tabIndex={0}
            aria-label={`Open collection ${folder.name}, ${total} ${total === 1 ? 'video' : 'videos'}`}
            className="tv-card hf-card hf-in group relative cursor-pointer select-none rounded-2xl border border-[#1a2524] bg-[#0e1514] p-3 min-[1600px]:p-4"
            style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            onClick={onOpen}
            onKeyDown={onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
            onFocus={(e) => {
                if (e.currentTarget !== e.target) return;
                const r = e.currentTarget.getBoundingClientRect();
                const vh = window.innerHeight || document.documentElement.clientHeight;
                if (r.top < 90 || r.bottom > vh - 90) {
                    e.currentTarget.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
                }
            }}
        >
            <div
                className="relative w-full overflow-hidden rounded-xl border border-[#1a2524] pt-[56.25%]"
                style={{
                    background:
                        'radial-gradient(70% 80% at 15% 10%, rgba(20,184,166,0.22), transparent 65%),' +
                        'radial-gradient(60% 70% at 90% 90%, rgba(245,158,11,0.16), transparent 65%),' +
                        'linear-gradient(140deg, #0b1413 0%, #101c1b 55%, #141d1c 100%)',
                }}
            >
                <div className="absolute inset-0 flex items-center justify-center px-4">
                    {isLoading && previews.length === 0 ? (
                        <div className="flex h-[62%] w-full gap-2">
                            {[0, 1, 2].map(i => (
                                <div key={i} className="hf-shimmer h-full flex-1 rounded-lg bg-[#1a2524]" />
                            ))}
                        </div>
                    ) : previews.length > 0 ? (
                        <div className="flex h-[62%] w-full gap-2">
                            {previews.map((f, i) => (
                                <PreviewTile key={f.id} file={f} tilt={(i - (previews.length - 1) / 2) * 2.5} />
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2 text-[#566e6a]">
                            <Layers className="h-9 w-9 min-[1600px]:h-12 min-[1600px]:w-12" />
                            <span className="text-xs font-semibold min-[1600px]:text-base">
                                {empty ? 'Empty collection' : 'Collection'}
                            </span>
                        </div>
                    )}
                </div>

                <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-lg border border-[#2dd4bf]/35 bg-[#042f2e]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#5eead4] min-[1600px]:text-sm">
                    <FolderIcon className="h-3 w-3" /> Collection
                </span>

                <span className="absolute bottom-2 right-2 rounded-lg bg-black/80 px-2 py-0.5 font-mono text-[11px] font-bold text-white min-[1600px]:text-sm">
                    {total} {total === 1 ? 'video' : 'videos'}
                </span>
            </div>

            <div className="flex items-center gap-2 px-1 pt-3 min-[1600px]:pt-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#2dd4bf]/25 bg-gradient-to-br from-[#2dd4bf]/20 to-[#0d9488]/10 min-[1600px]:h-12 min-[1600px]:w-12">
                    <FolderIcon className="h-4 w-4 text-[#2dd4bf] min-[1600px]:h-6 min-[1600px]:w-6" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="hf-clamp2 text-sm font-bold leading-snug text-[#e8f1ef] min-[1600px]:text-2xl">
                        {folder.name}
                    </p>
                    <p className="mt-0.5 text-xs text-[#9db6b1] min-[1600px]:text-base">
                        {empty ? 'Nothing here yet' : 'Press OK to open'}
                    </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-[#566e6a] transition-colors duration-150 group-focus:text-[#5eead4] group-hover:text-[#5eead4] min-[1600px]:h-7 min-[1600px]:w-7" />
            </div>
        </div>
    );
}