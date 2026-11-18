/**
 * Hearth — app store (T8)
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal, flat-library state. The folder/breadcrumb/multi-select era is gone.
 *
 * Retained for the FROZEN MediaPlayer.tsx contract:
 *   previewFile / setPreviewFile, isPlayerMinimized / setPlayerMinimized
 * Retained as transient UI state for unretired overlays (T11 owns the rewrite):
 *   activeContextMenu / setActiveContextMenu
 *
 * Security: role starts as "unknown" and only becomes "admin" / "guest" after a
 * successful /auth/me response. Any failure puts it back to "unknown".
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { create } from "zustand";
import type { Role, TelegramFile, User } from "./api";
import {
  ACCESS_KEY,
  AUTH_CHANGED_EVENT,
  AUTH_EXPIRED_EVENT,
  REFRESH_KEY,
  clearTokens,
} from "./api";
import { getDeviceId } from "./device";

export { ACCESS_KEY, REFRESH_KEY };

/* ═══════════════════════════════ Types ═══════════════════════════════ */

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

export interface AuthState {
  user: User | null;
  role: Role;
}

export interface DeleteConfirmState {
  file: TelegramFile | null;
  isOpen: boolean;
}

/** File-only actions sheet. Folders no longer exist in the library. */
export interface ContextMenuState {
  type: "file";
  item: TelegramFile;
  x: number;
  y: number;
}

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  playbackRate: number;
}

export const PLAYER_PREFS_KEY = "hearth_player_prefs";
const TOAST_MS = 5000;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/* ═══════════════════════════════ Player prefs (raw key) ═══════════════════════════════ */

const DEFAULT_PREFS: PlayerPrefs = { volume: 1, muted: false, playbackRate: 1 };

export function loadPlayerPrefs(): PlayerPrefs {
  try {
    const raw = localStorage.getItem(PLAYER_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<PlayerPrefs> & { rate?: number };
    const vol = Number(p.volume);
    const rate = Number(p.playbackRate ?? p.rate);
    return {
      volume: Number.isFinite(vol) ? clamp01(vol) : 1,
      muted: !!p.muted,
      playbackRate: SPEEDS.includes(rate) ? rate : 1,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePlayerPrefs(prefs: PlayerPrefs): void {
  try {
    const raw = localStorage.getItem(PLAYER_PREFS_KEY);
    const previous = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    // MediaPlayer.tsx (frozen) reads `rate`, `aspect` and `subtitleLang` from
    // this same key, so keep those fields intact while writing our own.
    localStorage.setItem(
      PLAYER_PREFS_KEY,
      JSON.stringify({
        ...previous,
        volume: prefs.volume,
        muted: prefs.muted,
        playbackRate: prefs.playbackRate,
        rate: prefs.playbackRate,
      }),
    );
  } catch {
    /* private mode */
  }
}

/* ═══════════════════════════════ Toast timers ═══════════════════════════════ */

let toastSeq = 0;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearToastTimer(id: string) {
  const t = toastTimers.get(id);
  if (t) {
    clearTimeout(t);
    toastTimers.delete(id);
  }
}

/* ═══════════════════════════════ Store shape ═══════════════════════════════ */

export interface AppState {
  auth: AuthState;
  previewFile: TelegramFile | null;
  isPlayerMinimized: boolean;
  toasts: Toast[];
  deleteConfirm: DeleteConfirmState;
  playerPrefs: PlayerPrefs;
  activeContextMenu: ContextMenuState | null;
  deviceId: string;

  setUser: (user: User | null) => void;
  clearAuth: () => void;
  setRole: (role: Role) => void;
  /** @deprecated alias for setUser (retired App.tsx callers). */
  setMe: (user: User | null) => void;
  /** @deprecated alias kept for the current sign-in screen. */
  setIsAuthenticated: (value: boolean) => void;

  setPreviewFile: (file: TelegramFile | null) => void;
  setPlayerMinimized: (minimized: boolean) => void;

  addToast: (message: string, type?: ToastType) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;

  openDeleteConfirm: (file: TelegramFile) => void;
  closeDeleteConfirm: () => void;

  setPlayerPrefs: (patch: Partial<PlayerPrefs>) => void;
  resetPlayerPrefs: () => void;

  setActiveContextMenu: (state: ContextMenuState | null) => void;
}

/* ═══════════════════════════════ Store ═══════════════════════════════ */

export const useAppStore = create<AppState>((set, get) => ({
  auth: { user: null, role: "unknown" },
  previewFile: null,
  isPlayerMinimized: false,
  toasts: [],
  deleteConfirm: { file: null, isOpen: false },
  playerPrefs: loadPlayerPrefs(),
  activeContextMenu: null,
  deviceId: getDeviceId(),

  setUser: (user) =>
    set({
      auth: {
        user,
        role:
          user?.role === "admin"
            ? "admin"
            : user?.role === "guest"
              ? "guest"
              : "unknown",
      },
    }),

  clearAuth: () => {
    clearTokens();
    set({ auth: { user: null, role: "unknown" } });
  },

  setRole: (role) => set({ auth: { ...get().auth, role } }),

  setMe: (user) => get().setUser(user),

  setIsAuthenticated: (value) => {
    if (!value) get().clearAuth();
  },

  setPreviewFile: (file) =>
    set({ previewFile: file, activeContextMenu: null }),

  setPlayerMinimized: (minimized) => set({ isPlayerMinimized: minimized }),

  addToast: (message, type = "info") => {
    const id = `t${++toastSeq}`;
    clearToastTimer(id);
    set({ toasts: [...get().toasts, { id, message, type }] });
    toastTimers.set(
      id,
      setTimeout(() => {
        toastTimers.delete(id);
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      }, TOAST_MS),
    );
    return id;
  },

  removeToast: (id) => {
    clearToastTimer(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  clearToasts: () => {
    for (const id of Array.from(toastTimers.keys())) clearToastTimer(id);
    set({ toasts: [] });
  },

  openDeleteConfirm: (file) => set({ deleteConfirm: { file, isOpen: true } }),

  closeDeleteConfirm: () =>
    set({ deleteConfirm: { file: null, isOpen: false } }),

  setPlayerPrefs: (patch) => {
    const merged = { ...get().playerPrefs, ...patch };
    const safe: PlayerPrefs = {
      volume: clamp01(Number.isFinite(merged.volume) ? merged.volume : 1),
      muted: !!merged.muted,
      playbackRate: SPEEDS.includes(merged.playbackRate)
        ? merged.playbackRate
        : 1,
    };
    savePlayerPrefs(safe);
    set({ playerPrefs: safe });
  },

  resetPlayerPrefs: () => {
    savePlayerPrefs(DEFAULT_PREFS);
    set({ playerPrefs: { ...DEFAULT_PREFS } });
  },

  setActiveContextMenu: (state) => set({ activeContextMenu: state }),
}));

/* ═══════════════════════════════ Session lifecycle ═══════════════════════════════ */

if (typeof window !== "undefined") {
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    useAppStore.getState().clearAuth();
  });

  window.addEventListener(AUTH_CHANGED_EVENT, (event) => {
    const authenticated = !!(event as CustomEvent<{ authenticated?: boolean }>)
      .detail?.authenticated;
    if (!authenticated) useAppStore.getState().clearAuth();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === PLAYER_PREFS_KEY) {
      useAppStore.setState({ playerPrefs: loadPlayerPrefs() });
    }
    if (event.key === "access_token" && !event.newValue) {
      useAppStore.getState().clearAuth();
    }
  });

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      for (const id of Array.from(toastTimers.keys())) clearToastTimer(id);
    });
  }
}

/* ═══════════════════════════════ Convenience selectors ═══════════════════════════════ */

export const useUser = () => useAppStore((s) => s.auth.user);
export const useRole = () => useAppStore((s) => s.auth.role);
export const useIsAdmin = () => useAppStore((s) => s.auth.role === "admin");
export const useIsGuest = () => useAppStore((s) => s.auth.role === "guest");
export const usePreviewFile = () => useAppStore((s) => s.previewFile);
export const useToasts = () => useAppStore((s) => s.toasts);
export const useDeleteConfirm = () => useAppStore((s) => s.deleteConfirm);
export const usePlayerPrefs = () => useAppStore((s) => s.playerPrefs);
export const useSetPlayerPrefs = () => useAppStore((s) => s.setPlayerPrefs);
/** Stable primitive — no fresh object per call, so no re-render storms. */
export const useDevice = () => useAppStore((s) => s.deviceId);

export default useAppStore;
