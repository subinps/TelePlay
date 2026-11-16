/**
 * Hearth — Toasts  ·  live status layer (README §7.1, §8.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * The store contract is unchanged: `toasts` + `removeToast`, fed by `addToast(message, type)`.
 * This is the same infrastructure, rebuilt to the Hearth language and made genuinely robust.
 *
 * BEFORE → AFTER
 *  · flat gray cards, one generic look      → four semantic tones drawn from the Hearth palette
 *                                             (teal success, rose danger, amber warning, sky info)
 *                                             with icon badge, title, message and accent rail
 *  · fixed timeout, no feedback about it    → visible drain bar (pure CSS, zero JS per frame),
 *                                             pause on hover/focus and while the tab is hidden,
 *                                             resumes with the exact remaining time
 *  · dismissal popped instantly             → 170ms exit transition, then store removal
 *  · timers leaked on unmount               → every timer tracked and cleared
 *  · sat under the player / dialogs         → z-210, and it lifts above the minimised player bar
 *  · backdrop-blur, hover-only dismissal    → solid surfaces, always-visible dismiss + optional
 *                                             action button (Undo etc.), keyboard reachable
 *  · unbounded stack could fill the screen  → scrollable stack with a Hearth-styled scrollbar
 *
 * Tolerates store shape drift (`message` / `text` / `msg`, `type` / `kind`) and supports
 * optional `title`, `duration` (0 = sticky) and `action: { label, onClick }`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useAppStore } from '../lib/store';

type ToastTone = 'success' | 'error' | 'warning' | 'info';

interface StoreToast {
    id: string | number;
    message?: string;
    text?: string;
    msg?: string;
    type?: string;
    kind?: string;
    title?: string;
    duration?: number;
    action?: { label: string; onClick: () => void };
}

const TOAST_CSS = `
[data-hearth-toasts]{-webkit-tap-highlight-color:transparent;}
.ht-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:12px;}
.ht-scroll{scrollbar-width:thin;scrollbar-color:#115e59 rgba(14,21,20,.6);}
.ht-scroll::-webkit-scrollbar{width:8px;}
.ht-scroll::-webkit-scrollbar-track{background:rgba(14,21,20,.6);border-radius:8px;}
.ht-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;}
.ht-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes htIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
@keyframes htOut{from{opacity:1;transform:none}to{opacity:0;transform:translateX(16px) scale(.97)}}
@keyframes htDrain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.ht-in{animation:htIn .18s cubic-bezier(.2,.8,.3,1) backwards}
.ht-out{animation:htOut .17s ease-in forwards}
.ht-drain{transform-origin:left center;animation-name:htDrain;animation-timing-function:linear;animation-fill-mode:forwards}
.ht-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
@media (prefers-reduced-motion:reduce){.ht-in,.ht-out{animation:none}.ht-drain{animation:none}}
`;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('hearth-toast-css')) return;
    const el = document.createElement('style');
    el.id = 'hearth-toast-css';
    el.textContent = TOAST_CSS;
    document.head.appendChild(el);
}
ensureStyles();

const TONES: Record<ToastTone, {
    icon: typeof Info; rail: string; badge: string; iconColor: string;
    border: string; title: string; bar: string; role: 'status' | 'alert'; life: number;
}> = {
    success: {
        icon: CheckCircle2, rail: 'from-[#2dd4bf] to-[#4ade80]', badge: 'bg-[#2dd4bf]/15 border-[#2dd4bf]/40',
        iconColor: 'text-[#2dd4bf]', border: 'border-[#2dd4bf]/35', title: 'text-[#5eead4]',
        bar: 'bg-gradient-to-r from-[#2dd4bf] to-[#4ade80]', role: 'status', life: 3800,
    },
    error: {
        icon: XCircle, rail: 'from-[#f43f5e] to-[#fb7185]', badge: 'bg-[#f43f5e]/15 border-[#f43f5e]/40',
        iconColor: 'text-[#f43f5e]', border: 'border-[#f43f5e]/40', title: 'text-[#fda4af]',
        bar: 'bg-gradient-to-r from-[#f43f5e] to-[#fb7185]', role: 'alert', life: 6500,
    },
    warning: {
        icon: AlertTriangle, rail: 'from-[#fbbf24] to-[#f59e0b]', badge: 'bg-[#fbbf24]/15 border-[#fbbf24]/40',
        iconColor: 'text-[#fbbf24]', border: 'border-[#fbbf24]/35', title: 'text-[#fbbf24]',
        bar: 'bg-gradient-to-r from-[#fbbf24] to-[#f59e0b]', role: 'status', life: 5500,
    },
    info: {
        icon: Info, rail: 'from-[#38bdf8] to-[#2dd4bf]', badge: 'bg-[#38bdf8]/15 border-[#38bdf8]/40',
        iconColor: 'text-[#38bdf8]', border: 'border-[#38bdf8]/35', title: 'text-[#7dd3fc]',
        bar: 'bg-gradient-to-r from-[#38bdf8] to-[#2dd4bf]', role: 'status', life: 4200,
    },
};

const toneOf = (t: StoreToast): ToastTone => {
    const raw = String(t.type ?? t.kind ?? 'info').toLowerCase();
    if (raw === 'success' || raw === 'ok') return 'success';
    if (raw === 'error' || raw === 'danger' || raw === 'fail') return 'error';
    if (raw === 'warning' || raw === 'warn') return 'warning';
    return 'info';
};
const messageOf = (t: StoreToast) => t.message ?? t.text ?? t.msg ?? '';
const EXIT_MS = 170;

export default function Toasts() {
    const { toasts, removeToast, isPlayerMinimized } = useAppStore();
    const list = (toasts ?? []) as StoreToast[];

    const [leaving, setLeaving] = useState<Set<string | number>>(new Set());
    const [paused, setPaused] = useState(false);
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');

    const timers = useRef<Map<string | number, ReturnType<typeof setTimeout>>>(new Map());
    const exitTimers = useRef<Map<string | number, ReturnType<typeof setTimeout>>>(new Map());
    const remaining = useRef<Map<string | number, number>>(new Map());
    const endAt = useRef<Map<string | number, number>>(new Map());
    const lifeOf = useRef<Map<string | number, number>>(new Map());
    const known = useRef<Set<string | number>>(new Set());

    const remove = (id: string | number) => {
        (removeToast as ((i: unknown) => void) | undefined)?.(id);
    };

    const beginExit = (id: string | number) => {
        if (exitTimers.current.has(id)) return;
        const t = timers.current.get(id);
        if (t) { clearTimeout(t); timers.current.delete(id); }
        setLeaving(prev => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
        });
        const et = setTimeout(() => {
            exitTimers.current.delete(id);
            remaining.current.delete(id);
            endAt.current.delete(id);
            lifeOf.current.delete(id);
            known.current.delete(id);
            setLeaving(prev => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            remove(id);
        }, EXIT_MS);
        exitTimers.current.set(id, et);
    };

    /* Tab visibility pauses the countdown so nothing expires unseen. */
    useEffect(() => {
        const onVis = () => setHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    const stopped = paused || hidden;

    /* One timeout per toast, restarted with the exact remaining time on pause/resume. */
    useEffect(() => {
        const ids = new Set(list.map(t => t.id));

        // Forget anything the store dropped on its own.
        for (const id of Array.from(known.current)) {
            if (!ids.has(id)) {
                const t = timers.current.get(id);
                if (t) { clearTimeout(t); timers.current.delete(id); }
                const e = exitTimers.current.get(id);
                if (e) { clearTimeout(e); exitTimers.current.delete(id); }
                remaining.current.delete(id);
                endAt.current.delete(id);
                lifeOf.current.delete(id);
                known.current.delete(id);
            }
        }

        for (const t of list) {
            const tone = toneOf(t);
            const life = typeof t.duration === 'number' ? t.duration : TONES[tone].life;
            if (!known.current.has(t.id)) {
                known.current.add(t.id);
                lifeOf.current.set(t.id, life);
                remaining.current.set(t.id, life);
            }
            if (life <= 0) continue;                       // sticky
            if (leaving.has(t.id) || exitTimers.current.has(t.id)) continue;

            const existing = timers.current.get(t.id);
            if (stopped) {
                if (existing) {
                    clearTimeout(existing);
                    timers.current.delete(t.id);
                    const left = (endAt.current.get(t.id) ?? Date.now()) - Date.now();
                    remaining.current.set(t.id, Math.max(400, left));
                }
                continue;
            }
            if (!existing) {
                const left = remaining.current.get(t.id) ?? life;
                endAt.current.set(t.id, Date.now() + left);
                const handle = setTimeout(() => {
                    timers.current.delete(t.id);
                    beginExit(t.id);
                }, left);
                timers.current.set(t.id, handle);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [list, stopped, leaving]);

    /* Nothing survives unmount. */
    useEffect(() => () => {
        timers.current.forEach(t => clearTimeout(t));
        timers.current.clear();
        exitTimers.current.forEach(t => clearTimeout(t));
        exitTimers.current.clear();
    }, []);

    if (list.length === 0) return null;

    const ordered = [...list].reverse();          // newest first
    const bottom = isPlayerMinimized
        ? 'calc(6.5rem + env(safe-area-inset-bottom))'
        : 'calc(1rem + env(safe-area-inset-bottom))';

    return (
        <div
            data-hearth-toasts
            className="ht-scroll pointer-events-none fixed left-4 right-4 z-[210] flex max-h-[46vh] flex-col gap-2.5 overflow-y-auto sm:left-auto sm:w-[380px] min-[1600px]:w-[460px]"
            style={{ bottom, paddingRight: '2px' }}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocusCapture={() => setPaused(true)}
            onBlurCapture={(e) => {
                const to = e.relatedTarget as Node | null;
                if (!to || !(e.currentTarget as HTMLElement).contains(to)) setPaused(false);
            }}
        >
            {ordered.map(t => {
                const tone = toneOf(t);
                const cfg = TONES[tone];
                const Icon = cfg.icon;
                const life = lifeOf.current.get(t.id) ?? (typeof t.duration === 'number' ? t.duration : cfg.life);
                const isLeaving = leaving.has(t.id);
                const text = messageOf(t);
                return (
                    <div
                        key={t.id}
                        role={cfg.role}
                        aria-live={cfg.role === 'alert' ? 'assertive' : 'polite'}
                        className={`${isLeaving ? 'ht-out' : 'ht-in'} pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border ${cfg.border} bg-[#0e1514] px-3.5 py-3 shadow-[0_18px_45px_-14px_rgba(0,0,0,0.9)] min-[1600px]:gap-4 min-[1600px]:px-5 min-[1600px]:py-4`}
                    >
                        <span className={`absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${cfg.rail}`} aria-hidden="true" />

                        <span className={`ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${cfg.badge} min-[1600px]:h-11 min-[1600px]:w-11`}>
                            <Icon className={`h-4 w-4 ${cfg.iconColor} min-[1600px]:h-6 min-[1600px]:w-6`} />
                        </span>

                        <div className="min-w-0 flex-1 pt-0.5">
                            {t.title && (
                                <p className={`text-sm font-bold ${cfg.title} min-[1600px]:text-xl`}>{t.title}</p>
                            )}
                            <p className={`ht-clamp text-sm leading-snug ${t.title ? 'text-[#c3d6d2]' : 'font-semibold text-[#e8f1ef]'} min-[1600px]:text-lg`}>
                                {text}
                            </p>
                            {t.action && (
                                <button
                                    type="button"
                                    onClick={() => { t.action?.onClick(); beginExit(t.id); }}
                                    className={`ht-focus mt-2 inline-flex items-center gap-1.5 rounded-lg border ${cfg.border} bg-white/5 px-3 py-1.5 text-xs font-bold ${cfg.title} transition-all duration-150 hover:bg-white/10 active:scale-95 min-[1600px]:text-base`}
                                >
                                    {t.action.label}
                                </button>
                            )}
                        </div>

                        <button
                            type="button"
                            aria-label="Dismiss notification"
                            onClick={() => beginExit(t.id)}
                            className="ht-focus inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#758f8a] transition-all duration-150 hover:bg-white/10 hover:text-white active:scale-90 min-[1600px]:h-10 min-[1600px]:w-10"
                        >
                            <X className="h-4 w-4 min-[1600px]:h-5 min-[1600px]:w-5" />
                        </button>

                        {life > 0 && (
                            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/8" aria-hidden="true">
                                <span
                                    className={`ht-drain block h-full ${cfg.bar}`}
                                    style={{
                                        animationDuration: `${life}ms`,
                                        animationPlayState: stopped || isLeaving ? 'paused' : 'running',
                                    }}
                                />
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
