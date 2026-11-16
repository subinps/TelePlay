/**
 * Hearth — RenameModal  ·  "Names come from Telegram" (README §2, §4.3, §7.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Web rename is removed from the product (§2). The filename is the one artefact that ties a
 * library row back to the original message in the Telegram storage channel, so editing it in
 * the browser silently desyncs the library. This component is therefore retired by default —
 * but it is retired *honestly*: instead of a dead dialog it explains where names come from,
 * shows the real name, copies it to the clipboard (so you can find it in Telegram), and gives
 * the three steps that actually work.
 *
 * BEFORE → AFTER
 *  · silent rename form, errors to console      → retired notice with real, working actions
 *  · any user could rename (backend now 403s)   → opt-in form is admin-gated with a clear notice
 *  · free-text name (extension could be lost)   → opt-in form locks the extension chip and
 *                                                 validates illegal characters + length
 *  · backdrop-blur card, hover-only affordances → solid Hearth surfaces, 4px teal focus ring,
 *                                                 focus trap, arrows/OK/Back (webOS 461,
 *                                                 Tizen 10009), focus restore, scroll lock
 *
 * Escape hatch: a surface that still wants rename passes `enabled` plus its own `onRename`
 * mutation — no endpoint is guessed here, so nothing can break against the API layer.
 * Accepts the legacy prop shapes (`file` / `folder` / `item` / `name`).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
    AlertTriangle, Check, Copy, Info, Loader2, ShieldAlert, Tag, X,
} from 'lucide-react';
import { TelegramFile, Folder, api } from '../lib/api';
import { useAppStore } from '../lib/store';

interface RenameModalProps {
    onClose: () => void;
    /** Legacy shapes — whichever the caller has. */
    file?: TelegramFile | null;
    folder?: Folder | null;
    item?: TelegramFile | Folder | null;
    name?: string;
    /** Rename is removed from Hearth (§2). Opt in only with your own mutation. */
    enabled?: boolean;
    onRename?: (fullName: string) => Promise<void> | void;
}

const MAX_BASE = 120;
const ILLEGAL = /[\\/:*?"<>|]/;

const RENAME_CSS = `
[data-hearth-rename]{-webkit-tap-highlight-color:transparent;}
.hr-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hr-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.hr-scroll::-webkit-scrollbar{width:10px;}
.hr-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hr-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0e1514;}
.hr-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes hrFade{from{opacity:0}to{opacity:1}}
@keyframes hrPop{from{opacity:0;transform:scale(.97) translateY(10px)}to{opacity:1;transform:none}}
@keyframes hrSpin{to{transform:rotate(360deg)}}
.hr-fade{animation:hrFade .15s ease-out backwards}
.hr-pop{animation:hrPop .18s ease-out backwards}
.hr-spin{animation:hrSpin .9s linear infinite}
.hr-break{word-break:break-all;}
@media (prefers-reduced-motion:reduce){.hr-fade,.hr-pop{animation:none}}
`;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-rename-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-rename-css';
    el.textContent = RENAME_CSS;
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

/** Clipboard that also works on old TV WebViews without navigator.clipboard. */
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

function splitName(full: string): { base: string; ext: string } {
    const m = /^(.*?)(\.[a-z0-9]{2,4})$/i.exec(full);
    if (m && m[1].length > 0) return { base: m[1], ext: m[2] };
    return { base: full, ext: '' };
}

export default function RenameModal({
    onClose, file, folder, item, name, enabled = false, onRename,
}: RenameModalProps) {
    const { addToast } = useAppStore();
    const target = item ?? file ?? folder ?? null;
    const currentName = name
        ?? (target && 'file_name' in target ? target.file_name : target?.name)
        ?? '';
    const isFolder = !!target && !('file_name' in target);

    const dialogRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const restoreRef = useRef<HTMLElement | null>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [role, setRole] = useState('admin');
    const [copied, setCopied] = useState(false);
    const [base, setBase] = useState(() => splitName(currentName).base);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { ext } = splitName(currentName);
    const canManage = role === 'admin';
    const formMode = enabled && !!onRename && canManage;
    const trimmed = base.trim();
    const illegal = ILLEGAL.test(trimmed);
    const tooLong = trimmed.length > MAX_BASE;
    const unchanged = trimmed === splitName(currentName).base;
    const valid = trimmed.length > 0 && !illegal && !tooLong && !unchanged;

    useEffect(() => {
        let live = true;
        void fetchRole().then(r => { if (live) setRole(r); });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        setBase(splitName(currentName).base);
        setError(null);
        setCopied(false);
    }, [currentName]);

    /* Focus, scroll lock, focus restore. */
    useEffect(() => {
        restoreRef.current = document.activeElement as HTMLElement | null;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const raf = requestAnimationFrame(() => {
            const el = formMode
                ? inputRef.current
                : dialogRef.current?.querySelector<HTMLElement>('[data-hr-autofocus]');
            (el ?? dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
        });
        return () => {
            cancelAnimationFrame(raf);
            document.body.style.overflow = prev;
            const back = restoreRef.current;
            if (back && back.isConnected) back.focus();
            if (copyTimer.current) clearTimeout(copyTimer.current);
        };
    }, [formMode]);

    /* The dialog owns the keyboard while open (capture beats other window listeners). */
    useEffect(() => {
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
    }, [pending, onClose]);

    const doCopy = async () => {
        const ok = await copyText(currentName);
        if (ok) {
            setCopied(true);
            if (copyTimer.current) clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 2200);
            addToast('Filename copied — paste it in Telegram search', 'success');
        } else {
            addToast('Copy is blocked on this device — select the name manually', 'warning');
        }
    };

    const submit = async (e?: FormEvent) => {
        e?.preventDefault();
        if (!formMode || !valid || pending || !onRename) return;
        setPending(true);
        setError(null);
        try {
            await onRename(`${trimmed}${ext}`);
            addToast('Name updated', 'success');
            onClose();
        } catch (err) {
            const s = axStatus(err);
            setError(
                s === 403 ? 'Only the family account can rename items.'
                    : s === 404 ? 'That item is gone — the library may need a refresh.'
                        : s === 422 ? 'That name was rejected. Try a shorter, simpler name.'
                            : 'Rename failed. Nothing was changed — try again.',
            );
        } finally {
            setPending(false);
        }
    };

    const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    };

    return (
        <div data-hearth-rename className="fixed inset-0 z-[190] flex items-end justify-center p-0 sm:items-center sm:p-6" role="presentation">
            <div className="hr-fade absolute inset-0 bg-black/75" onClick={pending ? undefined : onClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={formMode ? 'Rename item' : 'About filenames'}
                aria-busy={pending}
                className="hr-pop relative flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-[#1a2524] bg-[#0e1514] shadow-[0_-20px_70px_rgba(0,0,0,0.8)] sm:rounded-2xl sm:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_60px_-24px_rgba(45,212,191,0.35)] min-[1600px]:max-w-xl"
            >
                <div className="h-1 w-full bg-gradient-to-r from-[#2dd4bf] via-[#38bdf8] to-[#fbbf24]" />

                <div className="flex items-start justify-between gap-3 px-5 pt-5 min-[1600px]:px-8 min-[1600px]:pt-7">
                    <div className="flex items-center gap-3">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10 min-[1600px]:h-16 min-[1600px]:w-16">
                            <Tag className="h-6 w-6 text-[#7dd3fc] min-[1600px]:h-8 min-[1600px]:w-8" />
                        </span>
                        <div>
                            <h2 className="text-lg font-bold text-[#e8f1ef] min-[1600px]:text-3xl">
                                {formMode ? 'Rename' : 'Names come from Telegram'}
                            </h2>
                            <p className="mt-0.5 text-xs text-[#9db6b1] min-[1600px]:text-base">
                                {formMode ? 'The extension stays locked' : 'Renaming in the browser was removed on purpose'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button" aria-label="Close" disabled={pending} onClick={onClose}
                        className="hr-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#9db6b1] transition-all duration-150 hover:bg-white/10 hover:text-white disabled:opacity-40 min-[1600px]:h-14 min-[1600px]:w-14"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="hr-scroll flex-1 space-y-4 overflow-y-auto px-5 py-5 min-[1600px]:px-8">
                    {/* The real name, always visible and copyable */}
                    <div className="rounded-xl border border-[#1a2524] bg-[#141d1c] p-3.5">
                        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#758f8a] min-[1600px]:text-sm">
                            {isFolder ? 'Collection name' : 'Original filename'}
                        </p>
                        <p className="hr-break font-mono text-sm font-semibold leading-relaxed text-[#e8f1ef] min-[1600px]:text-xl">
                            {currentName || 'Unnamed item'}
                        </p>
                        {!formMode && (
                            <button
                                type="button" onClick={() => void doCopy()} disabled={!currentName}
                                className={`hr-focus mt-3 inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-bold transition-all duration-150 disabled:opacity-40 min-[1600px]:text-base ${
                                    copied
                                        ? 'border-[#4ade80]/50 bg-[#4ade80]/10 text-[#4ade80]'
                                        : 'border-[#2dd4bf]/40 bg-[#2dd4bf]/10 text-[#5eead4] hover:bg-[#2dd4bf]/20'
                                }`}
                            >
                                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                {copied ? 'Copied' : 'Copy name'}
                            </button>
                        )}
                    </div>

                    {formMode ? (
                        <form onSubmit={(e) => void submit(e)} className="space-y-4">
                            <div>
                                <div className="mb-1.5 flex items-baseline justify-between">
                                    <label htmlFor="hr-base" className="text-xs font-bold uppercase tracking-[0.14em] text-[#9db6b1] min-[1600px]:text-base">
                                        Name
                                    </label>
                                    <span className={`font-mono text-xs min-[1600px]:text-base ${tooLong ? 'text-[#f43f5e]' : 'text-[#566e6a]'}`}>
                                        {trimmed.length}/{MAX_BASE}
                                    </span>
                                </div>
                                <div className="flex items-stretch gap-2">
                                    <input
                                        id="hr-base"
                                        ref={inputRef}
                                        value={base}
                                        onChange={(e) => { setBase(e.target.value); setError(null); }}
                                        onKeyDown={onInputKey}
                                        maxLength={MAX_BASE + 12}
                                        autoComplete="off"
                                        aria-invalid={illegal || tooLong}
                                        className={`hr-focus min-w-0 flex-1 rounded-xl border bg-[#141d1c] px-4 py-3.5 text-base font-semibold text-[#e8f1ef] focus:outline-none min-[1600px]:text-2xl ${
                                            illegal || tooLong ? 'border-[#f43f5e]/60' : 'border-[#2b3a38] focus:border-[#2dd4bf]/60'
                                        }`}
                                    />
                                    {ext && (
                                        <span className="inline-flex shrink-0 items-center rounded-xl border border-[#2dd4bf]/35 bg-[#042f2e]/70 px-3 font-mono text-sm font-bold text-[#5eead4] min-[1600px]:text-xl">
                                            {ext}
                                        </span>
                                    )}
                                </div>
                                {illegal && (
                                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#fda4af] min-[1600px]:text-base">
                                        <AlertTriangle className="h-3.5 w-3.5" /> A name can’t contain \ / : * ? &quot; &lt; &gt; |
                                    </p>
                                )}
                                {tooLong && (
                                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#fda4af] min-[1600px]:text-base">
                                        <AlertTriangle className="h-3.5 w-3.5" /> Keep it under {MAX_BASE} characters.
                                    </p>
                                )}
                                {unchanged && trimmed.length > 0 && !illegal && !tooLong && (
                                    <p className="mt-1.5 text-xs text-[#758f8a] min-[1600px]:text-base">That’s already the name.</p>
                                )}
                            </div>

                            {ext && (
                                <p className="flex items-start gap-2 text-xs leading-relaxed text-[#fbbf24] min-[1600px]:text-base">
                                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    The extension is locked on purpose — changing it breaks playback detection on TVs.
                                </p>
                            )}

                            {error && (
                                <div role="alert" className="hr-pop flex items-start gap-2.5 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-4 py-3">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#fbbf24]" />
                                    <p className="text-xs font-semibold leading-relaxed text-[#fbbf24] min-[1600px]:text-base">{error}</p>
                                </div>
                            )}

                            <div className="flex gap-3 pt-1">
                                <button
                                    type="button" onClick={onClose} disabled={pending}
                                    className="hr-focus flex-1 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit" disabled={!valid || pending}
                                    className="hr-focus inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] shadow-[0_8px_30px_-6px_rgba(45,212,191,0.6)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                                >
                                    {pending ? <Loader2 className="hr-spin h-4 w-4" /> : <Check className="h-4 w-4" />}
                                    {pending ? 'Saving…' : 'Save name'}
                                </button>
                            </div>
                        </form>
                    ) : (
                        <>
                            {enabled && !canManage && (
                                <div className="flex items-start gap-2.5 rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/10 px-4 py-3">
                                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#7dd3fc]" />
                                    <p className="text-xs font-semibold leading-relaxed text-[#7dd3fc] min-[1600px]:text-base">
                                        Guest access is play-only — the family account manages the library.
                                    </p>
                                </div>
                            )}

                            <div className="rounded-xl border border-[#1a2524] bg-[#141d1c] px-4 py-3.5">
                                <p className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#758f8a] min-[1600px]:text-sm">
                                    <Info className="h-3.5 w-3.5 text-[#2dd4bf]" /> Why
                                </p>
                                <p className="text-sm leading-relaxed text-[#c3d6d2] min-[1600px]:text-lg">
                                    Hearth relays the original file from your Telegram storage channel. The filename is what
                                    keeps a card matched to its message — editing it here would leave the library pointing at
                                    a name Telegram has never heard of.
                                </p>
                            </div>

                            <ol className="space-y-3">
                                {[
                                    <>Copy the name above and search for it in your Telegram storage channel.</>,
                                    <>Re-send the file to the bot with the caption or filename you want — it lands here as a new card.</>,
                                    <>Send <span className="font-mono font-bold text-[#c3d6d2]">/sync</span> to the bot to clear out the old message.</>,
                                ].map((step, i) => (
                                    <li key={i} className="flex items-start gap-3">
                                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#2dd4bf] to-[#0d9488] font-mono text-sm font-black text-[#04110f]">
                                            {i + 1}
                                        </span>
                                        <p className="text-sm leading-relaxed text-[#c3d6d2] min-[1600px]:text-lg">{step}</p>
                                    </li>
                                ))}
                            </ol>

                            <button
                                type="button" data-hr-autofocus onClick={onClose}
                                className="hr-focus w-full rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] shadow-[0_8px_30px_-6px_rgba(45,212,191,0.6)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.98] min-[1600px]:py-4 min-[1600px]:text-xl"
                            >
                                Got it
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
