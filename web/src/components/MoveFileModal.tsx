/**
 * Hearth — MoveFileModal  ·  "Move to collection" (README §4.3, §7.4, §0 guardrails)
 * ─────────────────────────────────────────────────────────────────────────────
 * Hearth home is flat: it never renders this sheet. The capability is kept — not deleted —
 * because the backend move endpoints and folder relations stay intact (§0: "hide folders in
 * UI, do not delete backend code"). Any surface that still wants it gets a complete,
 * admin-only, remote-first implementation; pass `enabled={false}` to retire it outright.
 *
 * BEFORE → AFTER
 *  · pointer-only tree, hover highlights, no focus contract
 *      → focus trap, ↑/↓ through rows, ←/→ collapse/expand, OK selects, Back closes,
 *        webOS 461 / Tizen 10009, focus restore, scroll lock, custom scrollbar
 *  · any user could move (backend now 403s guests, F11)
 *      → role gate with a plain-language notice; Move is admin-only
 *  · self-move check only ("cannot move a folder into itself")
 *      → full descendant lock: a folder cannot move into itself or any of its children
 *  · failure = a toast, dialog closed, work lost
 *      → inline error, dialog stays open, retry keeps the selection
 *  · backdrop-blur card, generic dark palette
 *      → solid Hearth surfaces, teal/amber/sky/rose system, ≤200ms transform/opacity motion
 *  · no way to create a destination
 *      → inline "New collection" creator at the selected target, auto-selects the result
 *  · no item context
 *      → real thumbnails (Authorization blob, no token in URLs) and names of what is moving
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
    AlertTriangle, Check, ChevronRight, Film, Folder as FolderIcon, Home,
    Loader2, Lock, Plus, ShieldAlert, X,
} from 'lucide-react';
import {
    useFolderTree, TelegramFile, Folder, useMoveFiles, useMoveFolders, useCreateFolder, api,
} from '../lib/api';
import { useAppStore } from '../lib/store';

interface MoveFileModalProps {
    items: { files: TelegramFile[]; folders: Folder[] };
    onClose: () => void;
    /** Set false to retire the feature entirely (Hearth home does not render it at all). */
    enabled?: boolean;
}

const MOVE_CSS = `
[data-hearth-move]{-webkit-tap-highlight-color:transparent;}
.hm-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hm-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.hm-scroll::-webkit-scrollbar{width:10px;}
.hm-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hm-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0e1514;}
.hm-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes hmFade{from{opacity:0}to{opacity:1}}
@keyframes hmPop{from{opacity:0;transform:scale(.97) translateY(10px)}to{opacity:1;transform:none}}
@keyframes hmSpin{to{transform:rotate(360deg)}}
.hm-fade{animation:hmFade .15s ease-out backwards}
.hm-pop{animation:hmPop .18s ease-out backwards}
.hm-spin{animation:hmSpin .9s linear infinite}
@media (prefers-reduced-motion:reduce){.hm-fade,.hm-pop{animation:none}}
`;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-move-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-move-css';
    el.textContent = MOVE_CSS;
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

function MiniThumb({ file }: { file: TelegramFile }) {
    const thumb = useThumbnail(file.id, file.thumbnail_url);
    const [failed, setFailed] = useState(false);
    return (
        <span className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[#1a2524] bg-[#141d1c]">
            {thumb && !failed
                ? <img src={thumb} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
                : <Film className="h-4 w-4 text-[#2dd4bf]/60" />}
        </span>
    );
}

interface FlatRow { folder: Folder; depth: number; hasChildren: boolean }
function flatten(tree: Folder[], expanded: Set<number>, depth = 0, out: FlatRow[] = []): FlatRow[] {
    for (const f of tree) {
        const kids = f.children ?? [];
        out.push({ folder: f, depth, hasChildren: kids.length > 0 });
        if (kids.length && expanded.has(f.id)) flatten(kids, expanded, depth + 1, out);
    }
    return out;
}
function collectIds(tree: Folder[], out: Set<number> = new Set()): Set<number> {
    for (const f of tree) { out.add(f.id); collectIds(f.children ?? [], out); }
    return out;
}
function findNode(tree: Folder[], id: number): Folder | null {
    for (const f of tree) {
        if (f.id === id) return f;
        const hit = findNode(f.children ?? [], id);
        if (hit) return hit;
    }
    return null;
}

export default function MoveFileModal({ items, onClose, enabled = true }: MoveFileModalProps) {
    const { addToast, clearSelection } = useAppStore();
    const { data: tree, isLoading, isError, refetch } = useFolderTree();
    const { mutateAsync: moveFiles, isPending: filesPending } = useMoveFiles();
    const { mutateAsync: moveFolders, isPending: foldersPending } = useMoveFolders();
    const createFolder = useCreateFolder();

    const dialogRef = useRef<HTMLDivElement>(null);
    const restoreRef = useRef<HTMLElement | null>(null);
    const [role, setRole] = useState('admin');
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');

    const pending = filesPending || foldersPending;
    const folders = tree ?? [];
    const total = items.files.length + items.folders.length;
    const canManage = role === 'admin';

    useEffect(() => {
        let live = true;
        void fetchRole().then(r => { if (live) setRole(r); });
        return () => { live = false; };
    }, []);

    useEffect(() => { if (!enabled) onClose(); }, [enabled, onClose]);

    useEffect(() => {
        if (!folders.length) return;
        setExpanded(prev => (prev.size ? prev : collectIds(folders)));
    }, [folders]);

    /* A folder can never land inside itself or its own subtree. */
    const forbidden = useMemo(() => {
        const bad = new Set<number>();
        if (!items.folders.length) return bad;
        const moving = new Set(items.folders.map(f => f.id));
        const walk = (list: Folder[], inside: boolean) => {
            for (const f of list) {
                const hit = inside || moving.has(f.id);
                if (hit) bad.add(f.id);
                walk(f.children ?? [], hit);
            }
        };
        walk(folders, false);
        return bad;
    }, [folders, items.folders]);

    const rows = useMemo(() => flatten(folders, expanded), [folders, expanded]);
    const targetName = selectedId === null ? 'Top level' : (findNode(folders, selectedId)?.name ?? 'collection');

    /* Focus, scroll lock, focus restore. */
    useEffect(() => {
        if (!enabled) return;
        restoreRef.current = document.activeElement as HTMLElement | null;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const raf = requestAnimationFrame(() => {
            const el = dialogRef.current?.querySelector<HTMLElement>('[data-hm-autofocus]')
                ?? dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])');
            el?.focus();
        });
        return () => {
            cancelAnimationFrame(raf);
            document.body.style.overflow = prev;
            const back = restoreRef.current;
            if (back && back.isConnected) back.focus();
        };
    }, [enabled]);

    /* Dialog owns the keyboard while open. */
    useEffect(() => {
        if (!enabled) return;
        const nav = (dir: 1 | -1) => {
            const list = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), a[href]',
            ) ?? []).filter(el => el.getClientRects().length > 0);
            if (!list.length) return;
            const i = list.indexOf(document.activeElement as HTMLElement);
            (list[(i + dir + list.length) % list.length] ?? list[0]).focus();
        };
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
            if (isBackKey(e) && !(typing && k === 'Backspace')) {
                e.preventDefault(); e.stopPropagation();
                if (!pending) onClose();
                return;
            }
            const row = (e.target as HTMLElement | null)?.closest?.('[data-hm-row]') as HTMLElement | null;
            if (row && (k === 'ArrowRight' || k === 'ArrowLeft')) {
                e.preventDefault(); e.stopPropagation();
                const id = Number(row.dataset.hmId);
                if (row.dataset.hmKids === '1') {
                    setExpanded(prevSet => {
                        const next = new Set(prevSet);
                        if (k === 'ArrowRight') next.add(id); else next.delete(id);
                        return next;
                    });
                }
                return;
            }
            if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); nav(e.shiftKey ? -1 : 1); return; }
            if (k === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); nav(1); return; }
            if (k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); nav(-1); return; }
            if ((k === 'Enter' || k === ' ') && (e.target as HTMLElement | null)?.closest?.('button, input')) return;
            if (k === ' ') { e.preventDefault(); e.stopPropagation(); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [enabled, pending, onClose]);

    if (!enabled) return null;

    const doMove = async () => {
        if (pending || !canManage) return;
        if (selectedId !== null && forbidden.has(selectedId)) {
            setError('A collection cannot be moved inside itself.');
            return;
        }
        setError(null);
        try {
            const jobs: Promise<unknown>[] = [];
            if (items.files.length) jobs.push(moveFiles({ ids: items.files.map(f => f.id), folderId: selectedId }));
            if (items.folders.length) jobs.push(moveFolders({ ids: items.folders.map(f => f.id), folderId: selectedId }));
            await Promise.all(jobs);
            addToast(`Moved ${total} item${total === 1 ? '' : 's'} to ${targetName}`, 'success');
            clearSelection();
            onClose();
        } catch (e) {
            setError(axStatus(e) === 403
                ? 'Only the family account can move items.'
                : 'Move failed. Nothing was changed — check the connection and try again.');
        }
    };

    const doCreate = async () => {
        const name = newName.trim();
        if (!name || createFolder.isPending) return;
        setError(null);
        try {
            const created = await createFolder.mutateAsync({ name, parent_id: selectedId }) as Folder | undefined;
            await refetch();
            if (created?.id !== undefined) {
                setSelectedId(created.id);
                setExpanded(prev => new Set(prev).add(selectedId ?? created.id));
            }
            setNewName('');
            setCreating(false);
            addToast(`Collection “${name}” created`, 'success');
        } catch (e) {
            setError(axStatus(e) === 403 ? 'Only the family account can create collections.' : 'Could not create that collection.');
        }
    };

    const onNameKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); void doCreate(); }
    };

    return (
        <div data-hearth-move className="fixed inset-0 z-[190] flex items-end justify-center p-0 sm:items-center sm:p-6" role="presentation">
            <div className="hm-fade absolute inset-0 bg-black/75" onClick={pending ? undefined : onClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Move to collection"
                aria-busy={pending}
                className="hm-pop relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-[#1a2524] bg-[#0e1514] shadow-[0_-20px_70px_rgba(0,0,0,0.8)] sm:rounded-2xl sm:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_60px_-24px_rgba(45,212,191,0.35)] min-[1600px]:max-w-2xl"
            >
                <div className="h-1 w-full bg-gradient-to-r from-[#2dd4bf] via-[#38bdf8] to-[#fbbf24]" />

                <div className="flex items-start justify-between gap-3 px-5 pt-5 min-[1600px]:px-8 min-[1600px]:pt-7">
                    <div className="min-w-0">
                        <h2 className="text-lg font-bold text-[#e8f1ef] min-[1600px]:text-3xl">Move to collection</h2>
                        <p className="mt-0.5 text-sm text-[#9db6b1] min-[1600px]:text-lg">
                            {total} item{total === 1 ? '' : 's'} · destination <span className="font-semibold text-[#5eead4]">{targetName}</span>
                        </p>
                    </div>
                    <button
                        type="button" aria-label="Close" disabled={pending} onClick={onClose}
                        className="hm-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#9db6b1] transition-all duration-150 hover:bg-white/10 hover:text-white disabled:opacity-40 min-[1600px]:h-14 min-[1600px]:w-14"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {!canManage ? (
                    <div className="px-5 py-6 min-[1600px]:px-8">
                        <div className="flex items-start gap-3 rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10 px-4 py-4">
                            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#7dd3fc]" />
                            <p className="text-sm leading-relaxed text-[#7dd3fc] min-[1600px]:text-lg">
                                Only the family account can move items. Guest access is play-only.
                            </p>
                        </div>
                        <button
                            type="button" data-hm-autofocus onClick={onClose}
                            className="hm-focus mt-5 w-full rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] min-[1600px]:py-4 min-[1600px]:text-lg"
                        >
                            Close
                        </button>
                    </div>
                ) : (
                    <>
                        {/* What is moving */}
                        <div className="flex items-center gap-2 overflow-hidden px-5 pt-4 min-[1600px]:px-8">
                            {items.files.slice(0, 3).map(f => <MiniThumb key={f.id} file={f} />)}
                            {items.folders.slice(0, 3).map(f => (
                                <span key={f.id} className="flex h-9 w-14 shrink-0 items-center justify-center rounded-md border border-[#2dd4bf]/25 bg-[#2dd4bf]/10">
                                    <FolderIcon className="h-4 w-4 text-[#2dd4bf]" />
                                </span>
                            ))}
                            <span className="truncate text-xs text-[#9db6b1] min-[1600px]:text-base">
                                {items.files[0]?.file_name ?? items.folders[0]?.name ?? ''}
                                {total > 1 ? ` +${total - 1} more` : ''}
                            </span>
                        </div>

                        {/* Destination tree */}
                        <div className="hm-scroll mx-5 mt-4 max-h-[42vh] flex-1 overflow-y-auto rounded-xl border border-[#1a2524] bg-[#141d1c] p-1.5 min-[1600px]:mx-8">
                            <button
                                type="button"
                                data-hm-autofocus
                                data-hm-row
                                data-hm-id="root"
                                data-hm-kids="0"
                                onClick={() => setSelectedId(null)}
                                aria-pressed={selectedId === null}
                                className={`hm-focus flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left transition-all duration-150 min-[1600px]:py-4 ${
                                    selectedId === null ? 'bg-[#2dd4bf]/15 text-[#5eead4]' : 'text-[#c3d6d2] hover:bg-white/5 hover:text-white'
                                }`}
                            >
                                <Home className="h-4 w-4 shrink-0" />
                                <span className="flex-1 text-sm font-semibold min-[1600px]:text-xl">Top level (no collection)</span>
                                {selectedId === null && <Check className="h-4 w-4 shrink-0" />}
                            </button>

                            {isLoading ? (
                                <div className="space-y-1.5 p-1.5">
                                    {[0, 1, 2].map(i => (
                                        <div key={i} className="h-11 animate-pulse rounded-lg bg-[#1a2524]" />
                                    ))}
                                </div>
                            ) : isError ? (
                                <div className="p-4 text-center">
                                    <p className="text-sm text-[#fbbf24] min-[1600px]:text-lg">Could not load collections.</p>
                                    <button
                                        type="button" onClick={() => void refetch()}
                                        className="hm-focus mt-3 rounded-lg border border-[#2b3a38] bg-[#1a2524] px-4 py-2 text-sm font-semibold text-[#e8f1ef] hover:border-[#2dd4bf]/60 min-[1600px]:text-lg"
                                    >
                                        Try again
                                    </button>
                                </div>
                            ) : rows.length === 0 ? (
                                <p className="px-3 py-4 text-sm text-[#758f8a] min-[1600px]:text-lg">
                                    No collections yet — everything lives at the top level. You can create one below.
                                </p>
                            ) : (
                                rows.map(({ folder: f, depth, hasChildren }) => {
                                    const locked = forbidden.has(f.id);
                                    const active = selectedId === f.id;
                                    const isOpen = expanded.has(f.id);
                                    return (
                                        <button
                                            key={f.id}
                                            type="button"
                                            data-hm-row
                                            data-hm-id={f.id}
                                            data-hm-kids={hasChildren ? '1' : '0'}
                                            disabled={locked}
                                            aria-pressed={active}
                                            onClick={() => setSelectedId(f.id)}
                                            style={{ paddingLeft: `${12 + depth * 18}px` }}
                                            className={`hm-focus flex w-full items-center gap-2 rounded-lg py-3 pr-3 text-left transition-all duration-150 min-[1600px]:py-4 ${
                                                locked
                                                    ? 'cursor-not-allowed text-[#566e6a]'
                                                    : active
                                                        ? 'bg-[#2dd4bf]/15 text-[#5eead4]'
                                                        : 'text-[#c3d6d2] hover:bg-white/5 hover:text-white'
                                            }`}
                                        >
                                            {hasChildren ? (
                                                <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`} />
                                            ) : <span className="w-3.5 shrink-0" />}
                                            {locked
                                                ? <Lock className="h-4 w-4 shrink-0 text-[#f43f5e]/70" />
                                                : <FolderIcon className="h-4 w-4 shrink-0 text-[#2dd4bf]" />}
                                            <span className="min-w-0 flex-1 truncate text-sm font-semibold min-[1600px]:text-xl">{f.name}</span>
                                            {locked ? (
                                                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-[#f43f5e]/70 min-[1600px]:text-sm">inside itself</span>
                                            ) : (
                                                <span className="shrink-0 font-mono text-xs text-[#758f8a] min-[1600px]:text-base">{f.file_count}</span>
                                            )}
                                            {active && !locked && <Check className="h-4 w-4 shrink-0" />}
                                        </button>
                                    );
                                })
                            )}
                        </div>

                        {/* Inline destination creator */}
                        <div className="px-5 pt-3 min-[1600px]:px-8">
                            {creating ? (
                                <div className="flex items-center gap-2">
                                    <input
                                        autoFocus
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        onKeyDown={onNameKey}
                                        maxLength={64}
                                        placeholder={`New collection inside ${targetName}`}
                                        className="hm-focus min-w-0 flex-1 rounded-xl border border-[#2b3a38] bg-[#141d1c] px-4 py-2.5 text-sm text-[#e8f1ef] placeholder:text-[#566e6a] focus:border-[#2dd4bf]/60 focus:outline-none min-[1600px]:text-lg"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void doCreate()}
                                        disabled={!newName.trim() || createFolder.isPending}
                                        className="hm-focus inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#2dd4bf] px-4 py-2.5 text-sm font-bold text-[#04110f] transition-all duration-150 hover:bg-[#5eead4] disabled:opacity-50 min-[1600px]:text-lg"
                                    >
                                        {createFolder.isPending ? <Loader2 className="hm-spin h-4 w-4" /> : <Check className="h-4 w-4" />}
                                        Create
                                    </button>
                                </div>
                            ) : (
                                <button
                                    type="button" onClick={() => setCreating(true)}
                                    className="hm-focus inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-bold text-[#5eead4] transition-colors duration-150 hover:text-white min-[1600px]:text-base"
                                >
                                    <Plus className="h-4 w-4" /> New collection inside {targetName}
                                </button>
                            )}
                        </div>

                        {error && (
                            <div role="alert" className="hm-pop mx-5 mt-3 flex items-start gap-2.5 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-4 py-3 min-[1600px]:mx-8">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#fbbf24]" />
                                <p className="text-xs font-semibold leading-relaxed text-[#fbbf24] min-[1600px]:text-base">{error}</p>
                            </div>
                        )}

                        <div className="mt-4 flex gap-3 border-t border-[#1a2524] px-5 py-5 min-[1600px]:px-8 min-[1600px]:py-7">
                            <button
                                type="button" onClick={onClose} disabled={pending}
                                className="hm-focus flex-1 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                            >
                                Cancel
                            </button>
                            <button
                                type="button" onClick={() => void doMove()}
                                disabled={pending || total === 0 || (selectedId !== null && forbidden.has(selectedId))}
                                className="hm-focus inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] shadow-[0_8px_30px_-6px_rgba(45,212,191,0.6)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                            >
                                {pending ? <Loader2 className="hm-spin h-4 w-4" /> : <FolderIcon className="h-4 w-4" />}
                                {pending ? 'Moving…' : 'Move here'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
