/**
 * Hearth — NewFolderModal  ·  "New collection" (README §4.3, §0 guardrails)
 * ─────────────────────────────────────────────────────────────────────────────
 * The flat Hearth home never surfaces folders, but the backend folder code stays intact.
 * This is the complete, admin-only creator any surface (or the move sheet) can still use;
 * pass `enabled={false}` to retire it. Nothing here was deleted from the API layer.
 *
 * BEFORE → AFTER
 *  · unstyled input + "Creating…" text, errors thrown to the console
 *      → validated field with counter, duplicate-name check against real siblings,
 *        inline error states (403 / conflict / network), pending lock, success toast
 *  · any user could create (backend now 403s guests, F11)   → role gate with a clear notice
 *  · no destination context                                → shows the parent collection name
 *  · typing required on a TV remote                        → one-OK name presets + live preview
 *  · backdrop-blur card, hover-only affordances            → solid Hearth surfaces, 4px teal
 *                                                            focus ring, focus trap, arrows/OK/
 *                                                            Back (webOS 461 / Tizen 10009),
 *                                                            focus restore, scroll lock
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
    AlertTriangle, Check, Folder as FolderIcon, Home, Loader2, ShieldAlert, Sparkles, X,
} from 'lucide-react';
import { useCreateFolder, useFolderTree, Folder, api } from '../lib/api';
import { useAppStore } from '../lib/store';

interface NewFolderModalProps {
    parentId: number | null;
    onClose: () => void;
    /** Set false to retire the feature entirely (Hearth home does not render it). */
    enabled?: boolean;
    onCreated?: (folder: Folder | undefined) => void;
}

const PRESETS = ['Movies', 'Series', 'Documentaries', 'Kids', 'Music', 'Watch later'];
const MAX_NAME = 64;

const NEW_CSS = `
[data-hearth-new]{-webkit-tap-highlight-color:transparent;}
.hn-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hn-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.hn-scroll::-webkit-scrollbar{width:10px;}
.hn-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hn-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0e1514;}
.hn-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes hnFade{from{opacity:0}to{opacity:1}}
@keyframes hnPop{from{opacity:0;transform:scale(.97) translateY(10px)}to{opacity:1;transform:none}}
@keyframes hnSpin{to{transform:rotate(360deg)}}
.hn-fade{animation:hnFade .15s ease-out backwards}
.hn-pop{animation:hnPop .18s ease-out backwards}
.hn-spin{animation:hnSpin .9s linear infinite}
@media (prefers-reduced-motion:reduce){.hn-fade,.hn-pop{animation:none}}
`;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-new-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-new-css';
    el.textContent = NEW_CSS;
    document.head.appendChild(el);
}
ensureStyles();

const axStatus = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
const isBackKey = (e: KeyboardEvent) =>
    e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack'
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
function findNode(tree: Folder[], id: number): Folder | null {
    for (const f of tree) {
        if (f.id === id) return f;
        const hit = findNode(f.children ?? [], id);
        if (hit) return hit;
    }
    return null;
}

export default function NewFolderModal({ parentId, onClose, enabled = true, onCreated }: NewFolderModalProps) {
    const { addToast } = useAppStore();
    const createFolder = useCreateFolder();
    const { data: tree } = useFolderTree();

    const dialogRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const restoreRef = useRef<HTMLElement | null>(null);
    const [name, setName] = useState('');
    const [role, setRole] = useState('admin');
    const [error, setError] = useState<string | null>(null);

    const pending = createFolder.isPending;
    const canManage = role === 'admin';
    const folders = useMemo(() => tree ?? [], [tree]);
    const parentName = parentId === null ? 'Top level' : (findNode(folders, parentId)?.name ?? 'collection');
    const siblings = parentId === null ? folders : (findNode(folders, parentId)?.children ?? []);
    const trimmed = name.trim();
    const duplicate = trimmed.length > 0
        && siblings.some(f => f.name.trim().toLowerCase() === trimmed.toLowerCase());
    const tooLong = trimmed.length > MAX_NAME;
    const valid = trimmed.length > 0 && !duplicate && !tooLong;

    useEffect(() => {
        let live = true;
        void fetchRole().then(r => { if (live) setRole(r); });
        return () => { live = false; };
    }, []);

    useEffect(() => { if (!enabled) onClose(); }, [enabled, onClose]);

    useEffect(() => {
        if (!enabled) return;
        restoreRef.current = document.activeElement as HTMLElement | null;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const raf = requestAnimationFrame(() => {
            const el = canManage
                ? (inputRef.current ?? dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])'))
                : dialogRef.current?.querySelector<HTMLElement>('[data-hn-autofocus]');
            el?.focus();
        });
        return () => {
            cancelAnimationFrame(raf);
            document.body.style.overflow = prev;
            const back = restoreRef.current;
            if (back && back.isConnected) back.focus();
        };
    }, [enabled, canManage]);

    useEffect(() => {
        if (!enabled) return;
        const nav = (dir: 1 | -1) => {
            const list = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled])',
            ) ?? []).filter(el => el.getClientRects().length > 0);
            if (!list.length) return;
            const i = list.indexOf(document.activeElement as HTMLElement);
            (list[(i + dir + list.length) % list.length] ?? list[0]).focus();
        };
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
            if (isBackKey(e)) {
                e.preventDefault(); e.stopPropagation();
                if (!pending) onClose();
                return;
            }
            if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); nav(e.shiftKey ? -1 : 1); return; }
            if (k === 'ArrowDown' || (k === 'ArrowRight' && !typing)) { e.preventDefault(); e.stopPropagation(); nav(1); return; }
            if (k === 'ArrowUp' || (k === 'ArrowLeft' && !typing)) { e.preventDefault(); e.stopPropagation(); nav(-1); return; }
            if ((k === 'Enter' || k === ' ') && (e.target as HTMLElement | null)?.closest?.('button, input')) return;
            if (k === ' ') { e.preventDefault(); e.stopPropagation(); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [enabled, pending, onClose]);

    if (!enabled) return null;

    const submit = async (e?: FormEvent) => {
        e?.preventDefault();
        if (!valid || pending || !canManage) return;
        setError(null);
        try {
            const created = await createFolder.mutateAsync({ name: trimmed, parent_id: parentId }) as Folder | undefined;
            addToast(`Collection “${trimmed}” created`, 'success');
            onCreated?.(created);
            onClose();
        } catch (err) {
            const s = axStatus(err);
            setError(
                s === 403 ? 'Only the family account can create collections.'
                    : s === 409 ? 'A collection with that name already exists here.'
                        : s === 422 ? 'That name was rejected. Try a shorter, simpler name.'
                            : 'Could not create the collection. Check the connection and try again.',
            );
        }
    };

    const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    };

    return (
        <div data-hearth-new className="fixed inset-0 z-[190] flex items-end justify-center p-0 sm:items-center sm:p-6" role="presentation">
            <div className="hn-fade absolute inset-0 bg-black/75" onClick={pending ? undefined : onClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="New collection"
                aria-busy={pending}
                className="hn-pop relative flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-[#1a2524] bg-[#0e1514] shadow-[0_-20px_70px_rgba(0,0,0,0.8)] sm:rounded-2xl sm:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_60px_-24px_rgba(45,212,191,0.35)] min-[1600px]:max-w-xl"
            >
                <div className="h-1 w-full bg-gradient-to-r from-[#2dd4bf] via-[#38bdf8] to-[#fbbf24]" />

                <div className="flex items-start justify-between gap-3 px-5 pt-5 min-[1600px]:px-8 min-[1600px]:pt-7">
                    <div className="flex items-center gap-3">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#2dd4bf]/30 bg-gradient-to-br from-[#2dd4bf]/20 to-[#0d9488]/5 min-[1600px]:h-16 min-[1600px]:w-16">
                            <FolderIcon className="h-6 w-6 text-[#2dd4bf] min-[1600px]:h-8 min-[1600px]:w-8" />
                        </span>
                        <div>
                            <h2 className="text-lg font-bold text-[#e8f1ef] min-[1600px]:text-3xl">New collection</h2>
                            <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-[#9db6b1] min-[1600px]:text-base">
                                <Home className="h-3.5 w-3.5" /> inside <span className="font-semibold text-[#5eead4]">{parentName}</span>
                            </p>
                        </div>
                    </div>
                    <button
                        type="button" aria-label="Close" disabled={pending} onClick={onClose}
                        className="hn-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#9db6b1] transition-all duration-150 hover:bg-white/10 hover:text-white disabled:opacity-40 min-[1600px]:h-14 min-[1600px]:w-14"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {!canManage ? (
                    <div className="px-5 py-6 min-[1600px]:px-8">
                        <div className="flex items-start gap-3 rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10 px-4 py-4">
                            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#7dd3fc]" />
                            <p className="text-sm leading-relaxed text-[#7dd3fc] min-[1600px]:text-lg">
                                Only the family account can change the library. Guest access is play-only.
                            </p>
                        </div>
                        <button
                            type="button" data-hn-autofocus onClick={onClose}
                            className="hn-focus mt-5 w-full rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] min-[1600px]:py-4 min-[1600px]:text-lg"
                        >
                            Close
                        </button>
                    </div>
                ) : (
                    <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
                        <div className="hn-scroll flex-1 space-y-4 overflow-y-auto px-5 py-5 min-[1600px]:px-8">
                            <div>
                                <div className="mb-1.5 flex items-baseline justify-between">
                                    <label htmlFor="hn-name" className="text-xs font-bold uppercase tracking-[0.14em] text-[#9db6b1] min-[1600px]:text-base">
                                        Name
                                    </label>
                                    <span className={`font-mono text-xs min-[1600px]:text-base ${tooLong ? 'text-[#f43f5e]' : 'text-[#566e6a]'}`}>
                                        {trimmed.length}/{MAX_NAME}
                                    </span>
                                </div>
                                <input
                                    id="hn-name"
                                    ref={inputRef}
                                    value={name}
                                    onChange={(e) => { setName(e.target.value); setError(null); }}
                                    onKeyDown={onInputKey}
                                    maxLength={MAX_NAME + 8}
                                    autoComplete="off"
                                    placeholder="Movies"
                                    aria-invalid={duplicate || tooLong}
                                    className={`hn-focus w-full rounded-xl border bg-[#141d1c] px-4 py-3.5 text-base font-semibold text-[#e8f1ef] placeholder:font-normal placeholder:text-[#566e6a] focus:outline-none min-[1600px]:text-2xl ${
                                        duplicate || tooLong ? 'border-[#f43f5e]/60' : 'border-[#2b3a38] focus:border-[#2dd4bf]/60'
                                    }`}
                                />
                                {duplicate && (
                                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#fda4af] min-[1600px]:text-base">
                                        <AlertTriangle className="h-3.5 w-3.5" /> “{trimmed}” already exists inside {parentName}.
                                    </p>
                                )}
                                {tooLong && (
                                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#fda4af] min-[1600px]:text-base">
                                        <AlertTriangle className="h-3.5 w-3.5" /> Keep it under {MAX_NAME} characters.
                                    </p>
                                )}
                            </div>

                            <div>
                                <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.14em] text-[#9db6b1] min-[1600px]:text-base">
                                    <Sparkles className="h-3.5 w-3.5 text-[#fbbf24]" /> Quick names — one OK on a remote
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {PRESETS.map(p => {
                                        const taken = siblings.some(f => f.name.trim().toLowerCase() === p.toLowerCase());
                                        const active = trimmed === p;
                                        return (
                                            <button
                                                key={p}
                                                type="button"
                                                disabled={taken || pending}
                                                onClick={() => { setName(p); setError(null); }}
                                                aria-pressed={active}
                                                className={`hn-focus inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all duration-150 min-[1600px]:text-lg ${
                                                    taken
                                                        ? 'cursor-not-allowed border-[#1a2524] bg-[#101918] text-[#3f524f]'
                                                        : active
                                                            ? 'border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#5eead4]'
                                                            : 'border-[#2b3a38] bg-[#141d1c] text-[#c3d6d2] hover:border-[#2dd4bf]/50 hover:text-white'
                                                }`}
                                            >
                                                {active && <Check className="h-3.5 w-3.5" />}
                                                {p}{taken ? ' · taken' : ''}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Live preview of the collection tile */}
                            <div className="rounded-xl border border-[#1a2524] bg-[#141d1c] p-3">
                                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#758f8a] min-[1600px]:text-sm">Preview</p>
                                <div className="flex items-center gap-3">
                                    <span
                                        className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg border border-[#2dd4bf]/25 min-[1600px]:h-20 min-[1600px]:w-28"
                                        style={{
                                            background:
                                                'radial-gradient(70% 80% at 20% 15%, rgba(20,184,166,0.25), transparent 65%),' +
                                                'radial-gradient(60% 70% at 90% 90%, rgba(245,158,11,0.16), transparent 65%),' +
                                                'linear-gradient(140deg, #0b1413 0%, #101c1b 60%, #141d1c 100%)',
                                        }}
                                    >
                                        <FolderIcon className="h-6 w-6 text-[#2dd4bf] min-[1600px]:h-8 min-[1600px]:w-8" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-bold text-[#e8f1ef] min-[1600px]:text-xl">
                                            {trimmed || 'Untitled collection'}
                                        </p>
                                        <p className="text-xs text-[#9db6b1] min-[1600px]:text-base">0 videos · {parentName}</p>
                                    </div>
                                </div>
                            </div>

                            {error && (
                                <div role="alert" className="hn-pop flex items-start gap-2.5 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-4 py-3">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#fbbf24]" />
                                    <p className="text-xs font-semibold leading-relaxed text-[#fbbf24] min-[1600px]:text-base">{error}</p>
                                </div>
                            )}

                            <p className="text-xs leading-relaxed text-[#566e6a] min-[1600px]:text-base">
                                Collections are hidden on the Hearth home — the library stays one flat grid. They still work
                                for organising through the bot and the API.
                            </p>
                        </div>

                        <div className="flex gap-3 border-t border-[#1a2524] px-5 py-5 min-[1600px]:px-8 min-[1600px]:py-7">
                            <button
                                type="button" onClick={onClose} disabled={pending}
                                className="hn-focus flex-1 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit" disabled={!valid || pending}
                                className="hn-focus inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] shadow-[0_8px_30px_-6px_rgba(45,212,191,0.6)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                            >
                                {pending ? <Loader2 className="hn-spin h-4 w-4" /> : <FolderIcon className="h-4 w-4" />}
                                {pending ? 'Creating…' : 'Create'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
