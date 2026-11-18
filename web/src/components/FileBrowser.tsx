/**
 * Hearth — FileBrowser (Home)  ·  TV-first private library
 * ─────────────────────────────────────────────────────────────────────────────
 * UI/UX polish pass: refined cards, badges, header (with role pill), sections,
 * empty / loading states. Data, hooks, and navigation logic are unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Film,
  Loader2,
  LogOut,
  Music,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  TelegramFile,
  formatDuration,
  useFiles,
  useContinueWatching,
  useDeleteFiles,
  logout,
  api,
} from "../lib/api";
import { useAppStore, useRole } from "../lib/store";
import { prewarmPlayback } from "./MediaPlayer";
import Toasts from "./Toasts";

/* ═══════════════════════════ Types & constants ═══════════════════════════ */

type HubFile = TelegramFile & {
  mime_type?: string | null;
  completed?: boolean;
  file_size?: number;
  width?: number | null;
  height?: number | null;
  created_at?: string;
  updated_at?: string;
};
type ConfirmState =
  | { kind: "delete"; file: HubFile }
  | { kind: "logout" }
  | null;
type MutableRef<T> = { current: T | null };

const VIDEO_EXTS = [
  "MP4",
  "MKV",
  "WEBM",
  "MOV",
  "AVI",
  "M4V",
  "TS",
  "WMV",
  "FLV",
  "3GP",
];
const RISKY_EXTS = ["MKV", "AVI", "WMV", "FLV", "TS"];

const BTN_PRIMARY =
  "hb-focus inline-flex items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 text-sm font-bold text-[#04110f] " +
  "shadow-[0_8px_30px_-6px_rgba(45,212,191,0.55)] transition-all duration-150 hover:bg-[#5eead4] active:scale-[0.98] " +
  "min-[1600px]:px-7 min-[1600px]:py-4 min-[1600px]:text-lg";
const BTN_GHOST =
  "hb-focus inline-flex items-center justify-center gap-2 rounded-xl border border-[#2b3a38] bg-[#1a2524] px-5 py-3 " +
  "text-sm font-semibold text-[#e8f1ef] transition-all duration-150 hover:border-[#2dd4bf]/60 hover:bg-[#22302e] active:scale-[0.98] " +
  "min-[1600px]:px-7 min-[1600px]:py-4 min-[1600px]:text-lg";
const BTN_DANGER =
  "hb-focus inline-flex items-center justify-center gap-2 rounded-xl bg-[#f43f5e] px-5 py-3 text-sm font-bold text-white " +
  "shadow-[0_8px_30px_-6px_rgba(244,63,94,0.55)] transition-all duration-150 hover:bg-[#fb7185] active:scale-[0.98] " +
  "disabled:opacity-60 min-[1600px]:px-7 min-[1600px]:py-4 min-[1600px]:text-lg";

const HB_CSS = `
[data-hb-root]{-webkit-tap-highlight-color:transparent;}
[data-hb-root] .hb-focus:focus{outline:4px solid #5eead4;outline-offset:3px;border-radius:14px;}
[data-hb-root] .hb-card{will-change:transform;}
[data-hb-root] .hb-card:focus{outline:none;transform:scale(1.06);z-index:6;border-color:rgba(94,234,212,.9);
  box-shadow:0 0 0 4px #5eead4,0 22px 48px -14px rgba(20,184,166,.5);}
.hb-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.hb-scroll{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.hb-scroll::-webkit-scrollbar{width:10px;}
.hb-scroll::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hb-scroll::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;border:2px solid #0e1514;}
.hb-scroll::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
.hb-scroll-x{scrollbar-width:thin;scrollbar-color:#115e59 #0e1514;}
.hb-scroll-x::-webkit-scrollbar{height:8px;}
.hb-scroll-x::-webkit-scrollbar-track{background:#0e1514;border-radius:8px;}
.hb-scroll-x::-webkit-scrollbar-thumb{background:#115e59;border-radius:8px;}
.hb-scroll-x::-webkit-scrollbar-thumb:hover{background:#14b8a6;}
@keyframes hbFadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes hbScaleIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@keyframes hbSlideIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes hbDrift{0%{transform:translate3d(-3%,-2%,0) scale(1)}50%{transform:translate3d(3%,2%,0) scale(1.06)}100%{transform:translate3d(-3%,-2%,0) scale(1)}}
@keyframes hbEmber{0%,100%{opacity:.75}50%{opacity:1}}
.hb-fade-up{animation:hbFadeUp .2s ease-out both}
.hb-scale-in{animation:hbScaleIn .16s ease-out both}
.hb-slide-in{animation:hbSlideIn .2s ease-out both}
.hb-drift{animation:hbDrift 60s ease-in-out infinite}
.hb-ember{animation:hbEmber 3.2s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.hb-fade-up,.hb-scale-in,.hb-slide-in,.hb-drift,.hb-ember{animation:none}}
`;

/* ═══════════════════════════════ Utilities ═══════════════════════════════ */

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
const fmtTime = (s: number) =>
  formatDuration(Number.isFinite(s) && s > 0 ? Math.floor(s) : 0);
const fmtBytes = (b?: number) => {
  if (!b || b <= 0) return "";
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(b / 1024)} KB`;
};
const containerOf = (f: HubFile) => {
  const m = /\.([a-z0-9]{2,4})$/i.exec(f.file_name || "");
  if (m) return m[1].toUpperCase();
  const mime = f.mime_type ?? "";
  if (mime.includes("matroska")) return "MKV";
  if (mime.startsWith("video/")) return mime.slice(6).toUpperCase();
  if (mime.startsWith("audio/")) return mime.slice(6).toUpperCase();
  return "FILE";
};
const isVideoFile = (f: HubFile) =>
  f.file_type === "video" ||
  (f.mime_type ?? "").startsWith("video/") ||
  VIDEO_EXTS.includes(containerOf(f));
const isAudioFile = (f: HubFile) =>
  f.file_type === "audio" || (f.mime_type ?? "").startsWith("audio/");
const isPlayable = (f: HubFile) => isVideoFile(f) || isAudioFile(f);
const isRisky = (f: HubFile) =>
  RISKY_EXTS.includes(containerOf(f)) ||
  (f.mime_type ?? "").includes("matroska");
const isWatched = (f: HubFile) => {
  const pos = f.last_pos ?? 0,
    dur = f.duration ?? 0;
  return !!f.completed || (dur > 0 && pos >= dur * 0.95);
};
const remainingLabel = (f: HubFile) => {
  const pos = f.last_pos ?? 0,
    dur = f.duration ?? 0;
  if (dur <= 0 || pos <= 0) return "";
  const left = Math.max(0, dur - pos);
  if (left >= 3600)
    return `${Math.floor(left / 3600)}h ${Math.round((left % 3600) / 60)}m left`;
  if (left >= 60) return `${Math.round(left / 60)} min left`;
  return `${Math.floor(left)}s left`;
};

const resolveApiUrl = (path: string): string => {
  if (/^https?:\/\//i.test(path)) return path;
  const base = api.defaults.baseURL ?? "/api";
  const origin = /^https?:\/\//i.test(base)
    ? new URL(base).origin
    : window.location.origin;
  return new URL(path, origin).href;
};
const axStatus = (e: unknown) =>
  (e as { response?: { status?: number } })?.response?.status;

function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return "Samsung TV";
  if (/Web0S|webOS/i.test(ua)) return "LG TV";
  if (/Android.*TV|AFT|BRAVIA|SMART-TV/i.test(ua)) return "TV";
  if (/iPhone|Android.*Mobile/i.test(ua)) return "Phone";
  if (/iPad|Tablet/i.test(ua)) return "Tablet";
  return "Computer";
}
void getDeviceLabel;

let botCache: string | null = null;
let botPromise: Promise<string> | null = null;
function fetchBotUsername(): Promise<string> {
  if (botCache !== null) return Promise.resolve(botCache);
  if (!botPromise) {
    botPromise = api
      .get("/auth/bot/info")
      .then(({ data }) => {
        const d = data as {
          bot_username?: string;
          username?: string;
          bot?: { username?: string };
        };
        botCache = (
          d?.bot_username ??
          d?.username ??
          d?.bot?.username ??
          ""
        ).replace(/^@/, "");
        return botCache;
      })
      .catch(() => {
        botCache = "";
        return botCache;
      });
  }
  return botPromise;
}

const thumbCache = new Map<number, string>();
const thumbOrder: number[] = [];
function useThumbnail(fileId: number, url?: string | null): string | null {
  const [src, setSrc] = useState<string | null>(
    () => thumbCache.get(fileId) ?? null,
  );
  useEffect(() => {
    let live = true;
    const cached = thumbCache.get(fileId);
    if (cached) {
      setSrc(cached);
      return;
    }
    if (!url) {
      setSrc(null);
      return;
    }
    api
      .get(resolveApiUrl(url), { responseType: "blob" })
      .then(({ data }) => {
        if (!live) return;
        const u = URL.createObjectURL(data as Blob);
        thumbCache.set(fileId, u);
        thumbOrder.push(fileId);
        if (thumbOrder.length > 48) {
          const old = thumbOrder.shift();
          if (old !== undefined) {
            const ou = thumbCache.get(old);
            if (ou) URL.revokeObjectURL(ou);
            thumbCache.delete(old);
          }
        }
        setSrc(u);
      })
      .catch(() => {
        if (live) setSrc(null);
      });
    return () => {
      live = false;
    };
  }, [fileId, url]);
  return src;
}

/* ═══════════════════════════════ UI atoms ═══════════════════════════════ */

function SharedDefs() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hb-logo-teal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
        <radialGradient id="hb-logo-ember" cx="0.5" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.55" stopColor="#f59e0b" />
          <stop offset="1" stopColor="#e11d48" />
        </radialGradient>
      </defs>
    </svg>
  );
}

function HearthLogo({ size = 38 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      className="hb-ember shrink-0 drop-shadow-[0_4px_14px_rgba(45,212,191,0.35)]"
    >
      <rect
        x="3"
        y="3"
        width="42"
        height="42"
        rx="14"
        fill="url(#hb-logo-teal)"
      />
      <path
        d="M24 11.5c5.2 5.2 9.2 8.8 9.2 14.4a9.2 9.2 0 0 1-18.4 0c0-3.1 1.2-5.6 3.3-8 .6 2.1 1.8 3.3 3.4 3.9-.6-3.6.9-7 2.5-10.3z"
        fill="url(#hb-logo-ember)"
      />
      <circle cx="24" cy="27.6" r="3.1" fill="#04110f" opacity="0.85" />
    </svg>
  );
}

function RolePill({ role }: { role: string }) {
  const admin = role === "admin";
  const Icon = admin ? Users : Shield;
  return (
    <span
      className={`hidden items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold tracking-wide sm:inline-flex min-[1600px]:px-4 min-[1600px]:py-1.5 min-[1600px]:text-base ${
        admin
          ? "border-[#2dd4bf]/35 bg-[#2dd4bf]/10 text-[#5eead4]"
          : "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#fbbf24]"
      }`}
    >
      <Icon className="h-3.5 w-3.5 min-[1600px]:h-5 min-[1600px]:w-5" />
      {admin ? "Family" : "Guest"}
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  children,
  active = false,
  spin = false,
  className = "",
}: {
  label: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  active?: boolean;
  spin?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-hb-focus
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`hb-focus relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-transparent transition-all duration-150 active:scale-90 min-[1600px]:h-14 min-[1600px]:w-14 ${
        active
          ? "bg-[#2dd4bf]/20 text-[#5eead4]"
          : "text-[#e8f1ef]/85 hover:border-[#1a2524] hover:bg-white/10 hover:text-white"
      } ${className}`}
    >
      <span className={`inline-flex ${spin ? "animate-spin" : ""}`}>
        {children}
      </span>
    </button>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  count,
  accent,
}: {
  icon: typeof Play;
  title: string;
  count?: number;
  accent?: string;
}) {
  return (
    <div className="relative z-10 mb-5 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#1a2524] bg-[#0e1514] min-[1600px]:h-12 min-[1600px]:w-12">
          <Icon
            className={`h-5 w-5 min-[1600px]:h-6 min-[1600px]:w-6 ${accent ?? "text-[#2dd4bf]"}`}
          />
        </span>
        <h2 className="text-lg font-bold tracking-tight text-[#e8f1ef] md:text-xl min-[1600px]:text-3xl">
          {title}
        </h2>
        {typeof count === "number" && (
          <span className="rounded-full border border-[#1a2524] bg-[#0e1514] px-2.5 py-0.5 font-mono text-xs font-bold text-[#9db6b1] min-[1600px]:text-base">
            {count}
          </span>
        )}
      </div>
      <div className="hidden h-px flex-1 bg-gradient-to-r from-[#2dd4bf]/35 via-[#1a2524] to-transparent sm:block" />
    </div>
  );
}

/* ═══════════════════════════════ Video card ═══════════════════════════════ */

function FallbackArt({ file }: { file: HubFile }) {
  const Icon = isVideoFile(file) ? Film : isAudioFile(file) ? Music : FileText;
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{
        background:
          "radial-gradient(80% 90% at 20% 15%, rgba(45,212,191,0.28), transparent 60%)," +
          "radial-gradient(70% 80% at 85% 85%, rgba(245,158,11,0.20), transparent 60%)," +
          "linear-gradient(135deg, #0f766e 0%, #134e4a 38%, #1e3a5f 72%, #7c2d12 100%)",
      }}
    >
      <Icon className="h-12 w-12 text-white/30 min-[1600px]:h-20 min-[1600px]:w-20" />
    </div>
  );
}

interface VideoCardProps {
  file: HubFile;
  variant: "grid" | "resume";
  manage: boolean;
  canManage: boolean;
  onPlay: (f: HubFile) => void;
  onDelete: (f: HubFile) => void;
  onLongManage: (id: number) => void;
}

function VideoCard({
  file,
  variant,
  manage,
  canManage,
  onPlay,
  onDelete,
  onLongManage,
}: VideoCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const thumb = useThumbnail(file.id, file.thumbnail_url);

  const cont = containerOf(file);
  const risky = isRisky(file);
  const playable = isPlayable(file);
  const watched = isWatched(file);
  const pos = file.last_pos ?? 0,
    dur = file.duration ?? 0;
  const pct = dur > 0 ? clamp(pos / dur, 0, 1) : 0;
  const sizeLabel = fmtBytes(file.file_size);
  const leftLabel = remainingLabel(file);

  const focusDelete = () => {
    cardRef.current
      ?.querySelector<HTMLButtonElement>("[data-hb-delete]")
      ?.focus();
  };
  const activate = () => {
    if (manage && canManage) focusDelete();
    else onPlay(file);
  };

  const warm = () => {
    if (playable && !manage) prewarmPlayback(file);
  };

  const startPress = () => {
    if (!canManage) return;
    longFired.current = false;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      onLongManage(file.id);
    }, 550);
  };
  const endPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  useEffect(() => () => endPress(), []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    if (manage && canManage) {
      focusDelete();
      return;
    }
    startPress();
    if (!canManage) {
      activate();
    }
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const wasLong = longFired.current;
    endPress();
    if (!wasLong && !(manage && canManage)) activate();
    longFired.current = false;
  };
  const onClick = () => {
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    activate();
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    warm();
    if (e.pointerType !== "mouse") startPress();
  };

  return (
    <div
      ref={cardRef}
      data-hb-focus
      data-hb-id={file.id}
      role="button"
      tabIndex={0}
      aria-label={
        manage && canManage
          ? `Manage ${file.file_name} — press OK to focus Delete`
          : `Play ${file.file_name}`
      }
      className={`hb-card group relative cursor-pointer select-none rounded-2xl border bg-[#0e1514] p-2.5 shadow-[0_10px_30px_-18px_rgba(0,0,0,0.9)] transition-[transform,border-color,box-shadow] duration-200 min-[1600px]:p-3.5 ${
        variant === "resume" ? "border-[#2dd4bf]/30" : "border-[#1a2524]"
      } hover:border-[#2dd4bf]/45`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={warm}
      onMouseEnter={warm}
      onPointerDown={onPointerDown}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onContextMenu={(e) => {
        e.preventDefault();
        if (canManage) onLongManage(file.id);
      }}
    >
      {/* 16:9 media frame */}
      <div className="relative w-full overflow-hidden rounded-xl bg-[#141d1c] pt-[56.25%]">
        <div className="absolute inset-0">
          {thumb ? (
            <img
              src={thumb}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <FallbackArt file={file} />
          )}
          <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />

          {/* Format tag */}
          <span
            className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm min-[1600px]:left-3 min-[1600px]:top-3 min-[1600px]:px-2.5 min-[1600px]:py-1 min-[1600px]:text-sm ${
              risky
                ? "border border-[#fbbf24]/45 bg-[#1f1604]/80 text-[#fbbf24]"
                : "border border-[#2dd4bf]/30 bg-[#042f2e]/75 text-[#5eead4]"
            }`}
          >
            {risky && <AlertTriangle className="h-3 w-3" />}
            {cont}
          </span>

          {/* Watched badge */}
          {watched && !(manage && canManage) && (
            <span
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-[#4ade80]/35 bg-[#052e16]/80 px-1.5 py-0.5 text-[10px] font-bold text-[#4ade80] backdrop-blur-sm min-[1600px]:right-3 min-[1600px]:top-3 min-[1600px]:px-2.5 min-[1600px]:py-1 min-[1600px]:text-sm"
              title="Watched"
            >
              <CheckCircle2 className="h-3 w-3 min-[1600px]:h-4 min-[1600px]:w-4" />
              Watched
            </span>
          )}

          {/* Play affordance */}
          {playable && (
            <span className="absolute bottom-2.5 left-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-[#2dd4bf] text-[#04110f] shadow-[0_4px_16px_-2px_rgba(45,212,191,0.7)] transition-transform duration-150 group-hover:scale-105 group-focus:scale-110 min-[1600px]:bottom-3.5 min-[1600px]:left-3.5 min-[1600px]:h-11 min-[1600px]:w-11">
              <Play className="ml-0.5 h-4 w-4 fill-current min-[1600px]:h-5 min-[1600px]:w-5" />
            </span>
          )}

          {/* Duration stamp */}
          {dur > 0 && (
            <span className="absolute bottom-2.5 right-2.5 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-white backdrop-blur-sm min-[1600px]:bottom-3.5 min-[1600px]:right-3.5 min-[1600px]:px-2 min-[1600px]:text-sm">
              {fmtTime(dur)}
            </span>
          )}

          {/* Progress */}
          {pct > 0 && !watched && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20 min-[1600px]:h-1.5">
              <div
                className="h-full rounded-r-full bg-gradient-to-r from-[#0d9488] via-[#2dd4bf] to-[#38bdf8]"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="px-1 pb-0.5 pt-3 min-[1600px]:pt-4">
        <p className="hb-clamp2 text-sm font-semibold leading-snug text-[#e8f1ef] min-[1600px]:text-2xl">
          {file.file_name}
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#9db6b1] min-[1600px]:mt-2 min-[1600px]:text-base">
          {variant === "resume" && pos > 0 && !watched ? (
            <span className="inline-flex items-center gap-1 font-semibold text-[#5eead4]">
              <Clock className="h-3.5 w-3.5" /> {fmtTime(pos)}
              {leftLabel ? ` · ${leftLabel}` : ""}
            </span>
          ) : (
            <span>{sizeLabel || (playable ? cont : "Document")}</span>
          )}
          {risky && (
            <span className="text-[#fbbf24]/90">may not play on all TVs</span>
          )}
          {!playable && (
            <span className="text-[#758f8a]">not playable in browser</span>
          )}
        </p>
      </div>

      {manage && canManage && (
        <button
          type="button"
          data-hb-delete
          data-hb-focus
          aria-label={`Delete ${file.file_name}`}
          title="Delete (removes from Telegram too)"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(file);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          className="hb-focus absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#f43f5e]/50 bg-[#2a1215]/95 text-[#fda4af] shadow-lg transition-all duration-150 hover:bg-[#f43f5e] hover:text-white active:scale-90 min-[1600px]:h-14 min-[1600px]:w-14"
        >
          <Trash2 className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════ Dialogs & sheets ═══════════════════════════ */

function ConfirmDialog({
  dialogRef,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  dialogRef: MutableRef<HTMLDivElement>;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={busy ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="hb-scale-in relative w-full max-w-md rounded-2xl border border-[#1a2524] bg-[#0e1514] p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_50px_-18px_rgba(45,212,191,0.3)] min-[1600px]:max-w-xl min-[1600px]:p-8"
      >
        <div className="mb-4 flex items-center gap-3">
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${
              danger
                ? "border-[#f43f5e]/35 bg-[#f43f5e]/10"
                : "border-[#fbbf24]/35 bg-[#fbbf24]/10"
            }`}
          >
            {danger ? (
              <Trash2 className="h-6 w-6 text-[#f43f5e]" />
            ) : (
              <LogOut className="h-6 w-6 text-[#fbbf24]" />
            )}
          </span>
          <h2 className="text-lg font-bold text-[#e8f1ef] min-[1600px]:text-2xl">
            {title}
          </h2>
        </div>
        <div className="mb-6 text-sm leading-relaxed text-[#c3d6d2] min-[1600px]:text-lg">
          {body}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            data-hb-autofocus
            onClick={onClose}
            disabled={busy}
            className={`${BTN_GHOST} flex-1`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`${danger ? BTN_DANGER : BTN_PRIMARY} flex-1`}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : danger ? (
              <Trash2 className="h-4 w-4" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddSheet({
  sheetRef,
  bot,
  onClose,
}: {
  sheetRef: MutableRef<HTMLDivElement>;
  bot: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add videos"
        className="hb-slide-in absolute inset-y-0 right-0 flex w-[min(420px,94vw)] flex-col border-l border-[#1a2524] bg-[#0e1514] shadow-[-30px_0_60px_rgba(0,0,0,0.55)] min-[1600px]:w-[520px]"
      >
        <div className="flex items-center justify-between border-b border-[#1a2524] px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-bold text-[#e8f1ef] min-[1600px]:text-2xl">
            <Plus className="h-5 w-5 text-[#2dd4bf]" /> Add videos
          </h2>
          <IconBtn label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </IconBtn>
        </div>
        <div className="px-5 py-5">
          <p className="rounded-xl border border-[#1a2524] bg-[#141d1c] px-4 py-3 text-sm leading-relaxed text-[#c3d6d2] min-[1600px]:text-lg">
            Forward a video to{" "}
            <span className="font-mono font-bold text-[#5eead4]">
              @{bot || "YourBotName"}
            </span>{" "}
            to add it to your library.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════ States ═══════════════════════════ */

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-[#1a2524] bg-[#0e1514] p-2.5 min-[1600px]:p-3.5">
      <div className="w-full animate-pulse rounded-xl bg-[#141d1c] pt-[56.25%]" />
      <div className="mt-3 h-4 w-4/5 animate-pulse rounded bg-[#141d1c]" />
      <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-[#141d1c]" />
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div
      className="hb-fade-up space-y-10"
      role="status"
      aria-label="Loading your library"
    >
      <div>
        <div className="mb-5 flex items-center gap-3">
          <div className="h-9 w-9 animate-pulse rounded-xl bg-[#141d1c]" />
          <div className="h-7 w-48 animate-pulse rounded-lg bg-[#141d1c]" />
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ bot }: { bot: string }) {
  const botUsername = bot || "bot";
  return (
    <div className="hb-fade-up flex min-h-[55vh] flex-col items-center justify-center px-6 text-center">
      <span className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-[#2dd4bf]/25 bg-[#2dd4bf]/10 shadow-[0_0_60px_-15px_rgba(45,212,191,0.5)] min-[1600px]:h-28 min-[1600px]:w-28">
        <Film className="h-9 w-9 text-[#2dd4bf] min-[1600px]:h-12 min-[1600px]:w-12" />
      </span>
      <h2 className="text-2xl font-bold tracking-tight text-[#e8f1ef] min-[1600px]:text-4xl">
        Your library is empty
      </h2>
      <p className="mt-3 max-w-md text-base leading-relaxed text-[#9db6b1] min-[1600px]:max-w-2xl min-[1600px]:text-2xl">
        Forward any video file to{" "}
        <span className="font-mono font-bold text-[#5eead4]">
          @{botUsername}
        </span>{" "}
        on Telegram. It will automatically appear here.
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="hb-fade-up flex flex-col items-center py-16 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-[#fbbf24]/35 bg-[#fbbf24]/10">
        <AlertTriangle className="h-8 w-8 text-[#fbbf24]" />
      </span>
      <h2 className="mt-4 text-xl font-bold text-[#e8f1ef] min-[1600px]:text-3xl">
        Couldn’t reach your library
      </h2>
      <p className="mt-2 max-w-sm text-sm text-[#9db6b1] min-[1600px]:text-lg">
        The server may be waking up or the network dropped. Nothing was lost —
        try again.
      </p>
      <button
        type="button"
        data-hb-focus
        onClick={onRetry}
        className={`${BTN_PRIMARY} mt-6`}
      >
        <RefreshCw className="h-4 w-4" /> Try again
      </button>
    </div>
  );
}

/* ═══════════════════════════════ FileBrowser (Home) ═══════════════════════════════ */

export default function FileBrowser() {
  const { setPreviewFile, addToast } = useAppStore();
  const role = useRole();

  /* ── Data (flat library, sorted newest first) ── */
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [allFiles, setAllFiles] = useState<HubFile[]>([]);
  const {
    data: filesList,
    isLoading: filesLoading,
    isFetching: filesFetching,
    isError: filesError,
    refetch: refetchFiles,
  } = useFiles(null, undefined, undefined, page);
  const { data: cwData, refetch: refetchCW } = useContinueWatching(50);
  const deleteFiles = useDeleteFiles();

  useEffect(() => {
    if (!filesList) return;
    setAllFiles((prev) => {
      const seen = new Set(prev.map((f) => f.id));
      const next = (filesList.files as HubFile[]).filter(
        (f) => !seen.has(f.id),
      );
      return next.length ? [...prev, ...next] : prev;
    });
    setHasMore(filesList.page * filesList.per_page < filesList.total);
  }, [filesList]);

  const [bot, setBot] = useState<string>("");
  const [manage, setManage] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState(false);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastPlayedRef = useRef<number | null>(null);

  const canManage = role === "admin";
  const refreshing = filesFetching;

  const continueWatching = useMemo(() => {
    const list = (cwData?.files as HubFile[] | undefined) ?? [];
    return list.filter(
      (f) => !deletedIds.has(f.id) && !isWatched(f) && (f.last_pos ?? 0) > 3,
    );
  }, [cwData, deletedIds]);

  const videos = useMemo(() => {
    const list = allFiles.filter((f) => !deletedIds.has(f.id));
    return [...list].sort((a, b) => {
      const ta = a.created_at ?? "",
        tb = b.created_at ?? "";
      if (ta && tb && ta !== tb) return tb.localeCompare(ta);
      return b.id - a.id;
    });
  }, [allFiles, deletedIds]);

  const totalCount = filesList?.total ?? videos.length;
  const initialLoading = filesLoading && allFiles.length === 0;
  const isEmpty =
    !initialLoading &&
    !filesError &&
    videos.length === 0 &&
    continueWatching.length === 0;

  useEffect(() => {
    let live = true;
    void fetchBotUsername().then((b) => {
      if (live) setBot(b);
    });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(() => {
    void refetchFiles();
    void refetchCW();
  }, [refetchFiles, refetchCW]);

  const play = useCallback(
    (f: HubFile) => {
      if (!isPlayable(f)) {
        addToast("Only videos and audio can play in the browser", "info");
        return;
      }
      lastPlayedRef.current = f.id;
      setPreviewFile(f);
    },
    [addToast, setPreviewFile],
  );

  const longManage = useCallback(
    (id: number) => {
      if (!canManage) return;
      setManage(true);
      requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector<HTMLButtonElement>(
            `[data-hb-id="${id}"] [data-hb-delete]`,
          )
          ?.focus();
      });
    },
    [canManage],
  );

  const askDelete = useCallback((f: HubFile) => {
    setAddOpen(false);
    setConfirm({ kind: "delete", file: f });
  }, []);

  const doDelete = async (f: HubFile) => {
    setBusy(true);
    setDeletedIds((prev) => new Set(prev).add(f.id));
    setConfirm(null);
    try {
      await deleteFiles.mutateAsync([f.id]);
      addToast(
        `Deleted “${f.file_name}” — removed from Telegram too`,
        "success",
      );
      void refetchCW();
      void refetchFiles();
    } catch (err) {
      setDeletedIds((prev) => {
        const n = new Set(prev);
        n.delete(f.id);
        return n;
      });
      addToast(
        axStatus(err) === 403
          ? "Only the family account can delete"
          : "Delete failed — the file is still there",
        "error",
      );
    } finally {
      setBusy(false);
      setManage(false);
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector<HTMLElement>("[data-hb-focus]")
          ?.focus();
      });
    }
  };

  const doLogout = async () => {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || initialLoading) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !filesFetching) setPage((p) => p + 1);
      },
      { root: scrollRef.current, rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, initialLoading, filesFetching]);

  return (
    <div
      ref={rootRef}
      data-hb-root
      className="relative flex h-screen flex-col overflow-hidden bg-[#070b0b] font-sans text-[#e8f1ef]"
    >
      <style>{HB_CSS}</style>
      <SharedDefs />

      {/* Ambient glow (decorative) */}
      <div
        aria-hidden="true"
        className="hb-drift pointer-events-none absolute inset-0 z-0 opacity-70"
        style={{
          background:
            "radial-gradient(50% 40% at 12% 0%, rgba(45,212,191,0.10), transparent 70%)," +
            "radial-gradient(40% 35% at 95% 100%, rgba(245,158,11,0.07), transparent 70%)",
        }}
      />

      {/* Fixed header */}
      <header
        className="relative z-[45] shrink-0 border-b border-[#1a2524] bg-[#070b0b]/90 px-4 backdrop-blur-md sm:px-8"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex h-16 items-center justify-between gap-3 md:h-20 min-[1600px]:h-24">
          <div className="flex min-w-0 items-center gap-3 min-[1600px]:gap-4">
            <HearthLogo size={38} />
            <span className="block text-xl font-black tracking-tight text-white min-[1600px]:text-3xl">
              Hearth
            </span>
            <RolePill role={role} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {canManage && (
              <>
                <IconBtn
                  label="Refresh library"
                  onClick={refresh}
                  spin={refreshing}
                >
                  <RefreshCw className="h-5 w-5" />
                </IconBtn>
              <button
                type="button"
                data-hb-focus
                onClick={() => setAddOpen(true)}
                className={BTN_GHOST}
              >
                <Plus className="h-4 w-4 text-[#2dd4bf]" /> Add
              </button>
              </>
            )}
            <IconBtn
              label="Sign out"
              onClick={() => setConfirm({ kind: "logout" })}
            >
              <LogOut className="h-5 w-5" />
            </IconBtn>
          </div>
        </div>
      </header>

      <main
        ref={scrollRef}
        className="hb-scroll relative z-10 flex-1 overflow-y-auto px-4 pb-16 pt-7 sm:px-8 min-[1600px]:pt-10"
      >
        {initialLoading ? (
          <SkeletonGrid />
        ) : filesError && videos.length === 0 ? (
          <ErrorState onRetry={refresh} />
        ) : isEmpty ? (
          <EmptyState bot={bot} />
        ) : (
          <div className="space-y-12 min-[1600px]:space-y-16">
            {continueWatching.length > 0 && (
              <section aria-label="Continue watching">
                <SectionHeader
                  icon={Play}
                  title="Continue watching"
                  count={continueWatching.length}
                />
                {/* Padding gives the focus ring + 1.06 scale room inside the scroller */}
                <div className="hb-scroll-x -mx-3 flex snap-x gap-4 overflow-x-auto px-3 pb-5 pt-3 min-[1600px]:gap-6">
                  {continueWatching.map((f) => (
                    <div
                      key={f.id}
                      className="w-[260px] shrink-0 snap-start sm:w-[320px] min-[1600px]:w-[440px]"
                    >
                      <VideoCard
                        file={f}
                        variant="resume"
                        manage={manage}
                        canManage={canManage}
                        onPlay={play}
                        onDelete={askDelete}
                        onLongManage={longManage}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section aria-label="All videos">
              <SectionHeader
                icon={Film}
                title="All videos"
                count={totalCount}
                accent="text-[#38bdf8]"
              />
              <div className="grid grid-cols-2 gap-4 p-1 md:grid-cols-3 md:gap-6 min-[1600px]:gap-8">
                {videos.map((f) => (
                  <VideoCard
                    key={f.id}
                    file={f}
                    variant="grid"
                    manage={manage}
                    canManage={canManage}
                    onPlay={play}
                    onDelete={askDelete}
                    onLongManage={longManage}
                  />
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title="Delete this video?"
          body={
            <>
              “{confirm.file.file_name}” will be removed from your library and
              Telegram.
            </>
          }
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void doDelete(confirm.file)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "logout" && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title="Sign out?"
          body={<>You will need your PIN or login code to return.</>}
          confirmLabel="Sign out"
          busy={busy}
          onConfirm={() => void doLogout()}
          onClose={() => setConfirm(null)}
        />
      )}
      {addOpen && !confirm && (
        <AddSheet
          sheetRef={dialogRef}
          bot={bot}
          onClose={() => setAddOpen(false)}
        />
      )}

      <Toasts />
    </div>
  );
}