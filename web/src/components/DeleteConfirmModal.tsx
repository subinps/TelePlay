/**
 * Hearth — DeleteConfirmModal  ·  the irreversible-delete gate (README §4.10, §8.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE → AFTER
 *  · "Are you sure?" + generic warning   → plain language: removes it from Telegram too,
 *                                          cannot be undone, name shown in full
 *  · Cancel was a quiet text link        → Cancel is a real button and takes DEFAULT FOCUS
 *  · no focus contract                   → focus trap, arrows/Tab cycle, OK activates,
 *                                          Back / Esc / Backspace / webOS 461 / Tizen 10009 close
 *  · backdrop-blur scrim                 → solid scrim (no backdrop-filter on TV, §7.6)
 *  · fire-and-forget onConfirm           → awaits async work: spinner, locked buttons,
 *                                          inline error with retry, success closes
 *  · background kept scrolling           → scroll locked, focus restored on unmount
 *  · z-50 (under the player)             → z-200 so it is never trapped behind the player
 *
 * Works with the existing contract (type / name / count / onConfirm / onClose) and with
 * controlled `busy` / `error` props. Sync or async onConfirm both behave correctly.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Folder as FolderIcon, Loader2, Trash2, X } from 'lucide-react';

export interface DeleteConfirmModalProps {
    type: 'file' | 'folder' | 'multiple';
    name?: string;
    count?: number;
    onConfirm: () => void | Promise<void>;
    onClose: () => void;
    /** Optional controlled pending state (parent-driven mutations). */
    busy?: boolean;
    /** Optional controlled error message. */
    error?: string | null;
}

const DIALOG_CSS = `
[data-hearth-dialog]{-webkit-tap-highlight-color:transparent;}
.hd-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
.hd-scroll{scrollbar-width:thin;scrollbar-color:#7f1d1d #0e1514;}
.hd-scroll::-webkit-scrollbar{width:10px;}
.hd-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hd-scroll::-webkit-scrollbar-thumb{background:#7f1d1d;border-radius:8px;border:2px solid #0e1514;}
.hd-scroll::-webkit-scrollbar-thumb:hover{background:#f43f5e;}
@keyframes hdFade{from{opacity:0}to{opacity:1}}
@keyframes hdPop{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
@keyframes hdSpin{to{transform:rotate(360deg)}}
.hd-fade{animation:hdFade .15s ease-out backwards}
.hd-pop{animation:hdPop .16s ease-out backwards}
.hd-spin{animation:hdSpin .9s linear infinite}
@media (prefers-reduced-motion:reduce){.hd-fade,.hd-pop{animation:none}}
`;
function ensureDialogStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-dialog-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-dialog-css';
    el.textContent = DIALOG_CSS;
    document.head.appendChild(el);
}
ensureDialogStyles();

const axStatus = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
function messageFor(e: unknown): string {
    const s = axStatus(e);
    if (s === 403) return 'Only the family account can delete from the library.';
    if (s === 404) return 'That item is already gone — the library may just need a refresh.';
    if (s === 401) return 'Your sign-in expired. Close this and sign in again.';
    return 'Delete failed. Check the connection and try again — nothing was removed.';
}

export default function DeleteConfirmModal({
    type, name, count = 1, onConfirm, onClose, busy = false, error = null,
}: DeleteConfirmModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const alive = useRef(true);
    const [selfBusy, setSelfBusy] = useState(false);
    const [selfError, setSelfError] = useState<string | null>(null);

    const pending = busy || selfBusy;
    const message = error ?? selfError;
    const many = count > 1;
    const isFolder = type === 'folder' && !many;

    const title = many
        ? `Delete ${count} items?`
        : isFolder
            ? 'Delete this folder?'
            : 'Delete this video?';

    useEffect(() => {
        alive.current = true;
        const previous = document.activeElement as HTMLElement | null;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const raf = requestAnimationFrame(() => cancelRef.current?.focus());
        return () => {
            alive.current = false;
            cancelAnimationFrame(raf);
            document.body.style.overflow = prevOverflow;
            if (previous && previous.isConnected) previous.focus();
        };
    }, []);

    /* The dialog owns the keyboard while it is open (capture beats other window listeners). */
    useEffect(() => {
        const focusables = () =>
            Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
                .filter(el => el.getClientRects().length > 0);
        const move = (dir: 1 | -1) => {
            const items = focusables();
            if (!items.length) return;
            const i = items.indexOf(document.activeElement as HTMLElement);
            (items[(i + dir + items.length) % items.length] ?? items[0]).focus();
        };
        const onKey = (e: KeyboardEvent) => {
            const k = e.key, code = e.keyCode;
            const back = k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack'
                || code === 461 || code === 10009;
            if (back) {
                e.preventDefault(); e.stopPropagation();
                if (!pending) onClose();
                return;
            }
            if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); move(e.shiftKey ? -1 : 1); return; }
            if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); move(1); return; }
            if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); move(-1); return; }
            if (k === ' ' || k === 'Enter') {
                const t = e.target as HTMLElement | null;
                if (t?.closest?.('button')) return;         // native activation
                e.preventDefault(); e.stopPropagation();
                return;
            }
            if (k.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [pending, onClose]);

    const run = async () => {
        if (pending) return;
        setSelfError(null);
        try {
            const result = onConfirm();
            if (result && typeof (result as Promise<void>).then === 'function') {
                setSelfBusy(true);
                await result;
            }
            if (alive.current) onClose();
        } catch (e) {
            if (alive.current) setSelfError(messageFor(e));
        } finally {
            if (alive.current) setSelfBusy(false);
        }
    };

    const body: ReactNode = many ? (
        <>
            These <span className="font-bold text-[#e8f1ef]">{count} items</span> will be removed from your
            library and <span className="font-bold text-[#fda4af]">from Telegram too</span>.
        </>
    ) : isFolder ? (
        <>
            <span className="font-bold text-[#e8f1ef]">“{name || 'This folder'}”</span> will be removed.
            The videos inside it stay in your library and move to the top level.
        </>
    ) : (
        <>
            <span className="font-bold text-[#e8f1ef]">“{name || 'This file'}”</span> will be removed from your
            library and <span className="font-bold text-[#fda4af]">from Telegram too</span>.
        </>
    );

    return (
        <div
            data-hearth-dialog
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
            role="presentation"
        >
            <div className="hd-fade absolute inset-0 bg-black/75" onClick={pending ? undefined : onClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="hd-title"
                aria-describedby="hd-body"
                aria-busy={pending}
                className="hd-pop relative flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[#1a2524] bg-[#0e1514] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_60px_-22px_rgba(244,63,94,0.45)] min-[1600px]:max-w-xl"
            >
                <div className="h-1 w-full bg-gradient-to-r from-[#f43f5e] via-[#fbbf24] to-[#2dd4bf]" />

                <div className="flex items-start justify-between gap-3 px-6 pt-5 min-[1600px]:px-8 min-[1600px]:pt-7">
                    <div className="flex items-center gap-3">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#f43f5e]/35 bg-[#f43f5e]/10 min-[1600px]:h-16 min-[1600px]:w-16">
                            {isFolder
                                ? <FolderIcon className="h-6 w-6 text-[#fbbf24] min-[1600px]:h-8 min-[1600px]:w-8" />
                                : <Trash2 className="h-6 w-6 text-[#f43f5e] min-[1600px]:h-8 min-[1600px]:w-8" />}
                        </span>
                        <h2 id="hd-title" className="text-lg font-bold text-[#e8f1ef] min-[1600px]:text-3xl">{title}</h2>
                    </div>
                    <button
                        type="button"
                        aria-label="Close"
                        disabled={pending}
                        onClick={onClose}
                        className="hd-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#9db6b1] transition-all duration-150 hover:bg-white/10 hover:text-white disabled:opacity-40 min-[1600px]:h-14 min-[1600px]:w-14"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="hd-scroll max-h-[45vh] overflow-y-auto px-6 py-4 min-[1600px]:px-8">
                    <p id="hd-body" className="text-sm leading-relaxed text-[#c3d6d2] min-[1600px]:text-xl">
                        {body}
                    </p>

                    {!isFolder && (
                        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-[#f43f5e]/30 bg-[#f43f5e]/10 px-4 py-3">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#fda4af] min-[1600px]:h-5 min-[1600px]:w-5" />
                            <p className="text-xs font-semibold leading-relaxed text-[#fda4af] min-[1600px]:text-lg">
                                This cannot be undone. The original message is deleted from your storage channel —
                                you would have to send the file to the bot again.
                            </p>
                        </div>
                    )}

                    {message && (
                        <div
                            role="alert"
                            className="hd-pop mt-4 flex items-start gap-2.5 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-4 py-3"
                        >
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#fbbf24]" />
                            <p className="text-xs font-semibold leading-relaxed text-[#fbbf24] min-[1600px]:text-lg">{message}</p>
                        </div>
                    )}
                </div>

                <div className="flex gap-3 border-t border-[#1a2524] px-6 py-5 min-[1600px]:px-8 min-[1600px]:py-7">
                    <button
                        ref={cancelRef}
                        type="button"
                        data-hb-autofocus
                        disabled={pending}
                        onClick={onClose}
                        className="hd-focus inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.98] disabled:opacity-50 min-[1600px]:py-4 min-[1600px]:text-xl"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => { void run(); }}
                        className="hd-focus inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#f43f5e] px-5 py-3 text-sm font-bold text-white shadow-[0_8px_30px_-6px_rgba(244,63,94,0.6)] transition-all duration-150 hover:bg-[#fb7185] active:scale-[0.98] disabled:opacity-60 min-[1600px]:py-4 min-[1600px]:text-xl"
                    >
                        {pending ? <Loader2 className="hd-spin h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                        {pending ? 'Deleting…' : message ? 'Try again' : many ? `Delete ${count}` : 'Delete'}
                    </button>
                </div>
            </div>
        </div>
    );
}