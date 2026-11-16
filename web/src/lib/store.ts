/**
 * Hearth — app store  (README §7.2, §4.3, §4.4, §6.3, §6.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * SUPERSET, NOT A REWRITE. Every legacy field the existing screens read is still here
 * (auth, folders/breadcrumbs, selection, view mode, search, modals, context menu, toasts),
 * so App.tsx and any screen I have not touched keep compiling and running. The Hearth
 * additions sit alongside them.
 *
 * ADDED FOR HEARTH
 *   · role / me            Family vs Guest, so every mutating control can be gated (§4.4, F11)
 *   · manageMode           admin-only delete mode, shared by the grid and the rail (§8.4)
 *   · playerPrefs          volume / muted / rate / aspect / subtitleLang, persisted to the
 *                          RAW `hearth_player_prefs` key so MediaPlayer.tsx (which reads that
 *                          key directly) and the store never diverge (§7.2)
 *   · device identity      stable id + human label from lib/device (§4.5)
 *   · session expiry       listens for the api layer's auth-expired event: clears tokens,
 *                          closes the player, explains it in one toast — no hard redirect
 *   · richer toasts        addToast(message, type, { title, duration, action }) with dedupe,
 *                          a cap, and a safety timer so toasts can't pile up if <Toasts/>
 *                          is not mounted. Toasts.tsx owns the visible countdown.
 *
 * DELIBERATELY NOT PERSISTED: previewFile, isPlayerMinimized, selection, modal state —
 * a reload must never resurrect a dead <video> or a stale selection.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { TelegramFile, Folder, Me, UserRole } from './api';
import { AUTH_EXPIRED_EVENT, AUTH_CHANGED_EVENT, clearTokens, getAccessToken } from './api';
import { getDeviceId, getDeviceLabel, getDeviceKind, isTV } from './device';
import type { DeviceKind } from './device';

/* ═══════════════════════════════ Types ═══════════════════════════════ */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction { label: string; onClick: () => void }

export interface Toast {
    id: number;
    message: string;
    type: ToastType;
    title?: string;
    /** ms; 0 = sticky until dismissed. Undefined = the tone's default in Toasts.tsx. */
    duration?: number;
    action?: ToastAction;
}

export interface ToastOptions { title?: string; duration?: number; action?: ToastAction }

export type ViewMode = 'grid' | 'list';
/** Union keeps autocomplete; `(string & {})` tolerates sections older screens still use. */
export type Section = 'files' | 'all' | 'recent' | 'continue' | 'search' | (string & {});

export interface DeleteConfirmState {
    type: 'file' | 'folder' | 'multiple';
    items: (TelegramFile | Folder)[];
}

export interface ContextMenuState {
    type: 'file' | 'folder';
    item: TelegramFile | Folder;
    x: number;
    y: number;
}

export interface MoveItemsState { files: TelegramFile[]; folders: Folder[] }

export type AspectMode = 'fit' | 'fill' | 'stretch';

export interface PlayerPrefs {
    volume: number;
    muted: boolean;
    rate: number;
    aspect: AspectMode;
    subtitleLang: string;
}

/* ═══════════════════════════════ Player prefs (raw key) ═══════════════════════════════ */

export const PLAYER_PREFS_KEY = 'hearth_player_prefs';
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const ASPECTS: AspectMode[] = ['fit', 'fill', 'stretch'];
const DEFAULT_PREFS: PlayerPrefs = { volume: 1, muted: false, rate: 1, aspect: 'fit', subtitleLang: 'off' };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function loadPlayerPrefs(): PlayerPrefs {
    try {
        const raw = localStorage.getItem(PLAYER_PREFS_KEY);
        if (!raw) return { ...DEFAULT_PREFS };
        const p = JSON.parse(raw) as Partial<PlayerPrefs>;
        const vol = Number(p.volume);
        const rate = Number(p.rate);
        return {
            volume: Number.isFinite(vol) ? clamp01(vol) : 1,
            muted: !!p.muted,
            rate: SPEEDS.includes(rate) ? rate : 1,
            aspect: ASPECTS.includes(p.aspect as AspectMode) ? (p.aspect as AspectMode) : 'fit',
            subtitleLang: typeof p.subtitleLang === 'string' ? p.subtitleLang : 'off',
        };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

function savePlayerPrefs(prefs: PlayerPrefs): void {
    try { localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/* ═══════════════════════════════ Store shape ═══════════════════════════════ */

export interface AppState {
    /* ── auth & identity ── */
    isAuthenticated: boolean;
    setIsAuthenticated: (v: boolean) => void;
    setAuthenticated: (v: boolean) => void;
    me: Me | null;
    setMe: (me: Me | null) => void;
    role: UserRole;
    setRole: (role: UserRole) => void;
    isAdmin: () => boolean;
    logout: () => void;

    deviceId: string;
    deviceLabel: string;
    deviceKind: DeviceKind;
    isTvDevice: boolean;

    /* ── navigation (legacy, kept for unseen screens) ── */
    currentFolderId: number | null;
    setCurrentFolderId: (id: number | null) => void;
    breadcrumbs: Folder[];
    setBreadcrumbs: (crumbs: Folder[]) => void;
    pushBreadcrumb: (folder: Folder) => void;
    popBreadcrumb: () => void;
    navigateToFolder: (folder: Folder | null) => void;
    activeSection: Section;
    setActiveSection: (section: Section) => void;
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    toggleSidebar: () => void;
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    searchQuery: string;
    setSearchQuery: (q: string) => void;

    /* ── selection (legacy; the flat home does not use it) ── */
    selectedFileIds: number[];
    selectedFiles: TelegramFile[];
    toggleFileSelection: (file: TelegramFile, multi?: boolean) => void;
    setSelectedFiles: (files: TelegramFile[]) => void;
    selectAll: (files: TelegramFile[]) => void;
    clearSelection: () => void;
    isFileSelected: (id: number) => boolean;

    /* ── modals & sheets (legacy contracts preserved) ── */
    renameFile: TelegramFile | null;
    setRenameFile: (file: TelegramFile | null) => void;
    renameFolder: Folder | null;
    setRenameFolder: (folder: Folder | null) => void;
    moveItems: MoveItemsState | null;
    setMoveItems: (items: MoveItemsState | null) => void;
    /** undefined = closed, null = create at top level. */
    newFolderParentId: number | null | undefined;
    setNewFolderParentId: (id: number | null | undefined) => void;
    deleteConfirm: DeleteConfirmState | null;
    setDeleteConfirm: (state: DeleteConfirmState | null) => void;
    activeContextMenu: ContextMenuState | null;
    setActiveContextMenu: (state: ContextMenuState | null) => void;
    closeAllOverlays: () => void;

    /* ── Hearth manage mode (§8.4) ── */
    manageMode: boolean;
    setManageMode: (on: boolean) => void;
    toggleManageMode: () => void;

    /* ── player ── */
    previewFile: TelegramFile | null;
    setPreviewFile: (file: TelegramFile | null) => void;
    isPlayerMinimized: boolean;
    setPlayerMinimized: (minimized: boolean) => void;
    playerPrefs: PlayerPrefs;
    setPlayerPrefs: (patch: Partial<PlayerPrefs>) => void;
    resetPlayerPrefs: () => void;

    /* ── toasts ── */
    toasts: Toast[];
    addToast: (message: string, type?: ToastType, options?: ToastOptions) => number;
    removeToast: (id: number) => void;
    clearToasts: () => void;
}

/* ═══════════════════════════════ Toast bookkeeping ═══════════════════════════════ */

let toastSeq = 0;
const toastSafety = new Map<number, ReturnType<typeof setTimeout>>();
const TOAST_CAP = 5;
const DEFAULT_LIFE: Record<ToastType, number> = { success: 3800, error: 6500, warning: 5500, info: 4200 };

function clearSafety(id: number) {
    const t = toastSafety.get(id);
    if (t) { clearTimeout(t); toastSafety.delete(id); }
}

/* ═══════════════════════════════ Store ═══════════════════════════════ */

export const useAppStore = create<AppState>()(
    persist(
        (set, get) => ({
            /* ── auth & identity ── */
            isAuthenticated: !!getAccessToken(),
            setIsAuthenticated: (v) => set({ isAuthenticated: v }),
            setAuthenticated: (v) => set({ isAuthenticated: v }),
            me: null,
            setMe: (me) => set({ me, role: me?.role ?? get().role, isAuthenticated: me ? true : get().isAuthenticated }),
            role: 'admin',
            setRole: (role) => set({ role, manageMode: role === 'admin' ? get().manageMode : false }),
            isAdmin: () => get().role === 'admin',
            logout: () => {
                clearTokens();
                set({
                    isAuthenticated: false,
                    me: null,
                    role: 'admin',
                    manageMode: false,
                    previewFile: null,
                    isPlayerMinimized: false,
                    selectedFileIds: [],
                    selectedFiles: [],
                    activeContextMenu: null,
                    deleteConfirm: null,
                    moveItems: null,
                    renameFile: null,
                    renameFolder: null,
                    newFolderParentId: undefined,
                    currentFolderId: null,
                    breadcrumbs: [],
                    searchQuery: '',
                });
            },

            deviceId: getDeviceId(),
            deviceLabel: getDeviceLabel(),
            deviceKind: getDeviceKind(),
            isTvDevice: isTV(),

            /* ── navigation ── */
            currentFolderId: null,
            setCurrentFolderId: (id) => set({ currentFolderId: id, selectedFileIds: [], selectedFiles: [] }),
            breadcrumbs: [],
            setBreadcrumbs: (crumbs) => set({ breadcrumbs: crumbs }),
            pushBreadcrumb: (folder) => set({ breadcrumbs: [...get().breadcrumbs, folder] }),
            popBreadcrumb: () => {
                const crumbs = get().breadcrumbs.slice(0, -1);
                set({
                    breadcrumbs: crumbs,
                    currentFolderId: crumbs.length ? crumbs[crumbs.length - 1].id : null,
                    selectedFileIds: [],
                    selectedFiles: [],
                });
            },
            navigateToFolder: (folder) => set({
                currentFolderId: folder?.id ?? null,
                breadcrumbs: folder ? [...get().breadcrumbs, folder] : [],
                selectedFileIds: [],
                selectedFiles: [],
                activeSection: 'files',
                searchQuery: '',
            }),
            activeSection: 'files',
            setActiveSection: (section) => set({ activeSection: section, selectedFileIds: [], selectedFiles: [] }),
            sidebarOpen: false,
            setSidebarOpen: (open) => set({ sidebarOpen: open }),
            toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
            viewMode: 'grid',
            setViewMode: (mode) => set({ viewMode: mode }),
            searchQuery: '',
            setSearchQuery: (q) => set({ searchQuery: q }),

            /* ── selection ── */
            selectedFileIds: [],
            selectedFiles: [],
            toggleFileSelection: (file, multi = false) => {
                const current = get().selectedFiles;
                const exists = current.some(f => f.id === file.id);
                let next: TelegramFile[];
                if (!multi) next = exists && current.length === 1 ? [] : [file];
                else next = exists ? current.filter(f => f.id !== file.id) : [...current, file];
                set({ selectedFiles: next, selectedFileIds: next.map(f => f.id) });
            },
            setSelectedFiles: (files) => set({ selectedFiles: files, selectedFileIds: files.map(f => f.id) }),
            selectAll: (files) => set({ selectedFiles: files, selectedFileIds: files.map(f => f.id) }),
            clearSelection: () => set({ selectedFileIds: [], selectedFiles: [] }),
            isFileSelected: (id) => get().selectedFileIds.includes(id),

            /* ── modals & sheets ── */
            renameFile: null,
            setRenameFile: (file) => set({ renameFile: file }),
            renameFolder: null,
            setRenameFolder: (folder) => set({ renameFolder: folder }),
            moveItems: null,
            setMoveItems: (items) => set({ moveItems: items }),
            newFolderParentId: undefined,
            setNewFolderParentId: (id) => set({ newFolderParentId: id }),
            deleteConfirm: null,
            setDeleteConfirm: (state) => set({ deleteConfirm: state }),
            activeContextMenu: null,
            setActiveContextMenu: (state) => set({ activeContextMenu: state }),
            closeAllOverlays: () => set({
                activeContextMenu: null,
                deleteConfirm: null,
                moveItems: null,
                renameFile: null,
                renameFolder: null,
                newFolderParentId: undefined,
                sidebarOpen: false,
            }),

            /* ── manage mode ── */
            manageMode: false,
            setManageMode: (on) => set({ manageMode: on && get().role === 'admin' }),
            toggleManageMode: () => {
                if (get().role !== 'admin') return;
                set({ manageMode: !get().manageMode });
            },

            /* ── player ── */
            previewFile: null,
            setPreviewFile: (file) => set({
                previewFile: file,
                // Opening something new always expands; closing resets the bar.
                isPlayerMinimized: file ? false : false,
                activeContextMenu: null,
            }),
            isPlayerMinimized: false,
            setPlayerMinimized: (minimized) => set({ isPlayerMinimized: minimized }),
            playerPrefs: loadPlayerPrefs(),
            setPlayerPrefs: (patch) => {
                const merged: PlayerPrefs = { ...get().playerPrefs, ...patch };
                const safe: PlayerPrefs = {
                    volume: clamp01(Number.isFinite(merged.volume) ? merged.volume : 1),
                    muted: !!merged.muted,
                    rate: SPEEDS.includes(merged.rate) ? merged.rate : 1,
                    aspect: ASPECTS.includes(merged.aspect) ? merged.aspect : 'fit',
                    subtitleLang: merged.subtitleLang || 'off',
                };
                savePlayerPrefs(safe);
                set({ playerPrefs: safe });
            },
            resetPlayerPrefs: () => {
                savePlayerPrefs(DEFAULT_PREFS);
                set({ playerPrefs: { ...DEFAULT_PREFS } });
            },

            /* ── toasts ── */
            toasts: [],
            addToast: (message, type = 'info', options) => {
                const id = ++toastSeq;
                const toast: Toast = {
                    id,
                    message,
                    type,
                    title: options?.title,
                    duration: options?.duration,
                    action: options?.action,
                };

                // Replace an identical live toast instead of stacking duplicates.
                const previous = get().toasts.filter(t => t.message === message && t.type === type);
                previous.forEach(t => clearSafety(t.id));

                const kept = get().toasts.filter(t => !(t.message === message && t.type === type));
                const next = [...kept, toast].slice(-TOAST_CAP);
                const dropped = [...kept, toast].slice(0, Math.max(0, kept.length + 1 - TOAST_CAP));
                dropped.forEach(t => clearSafety(t.id));
                set({ toasts: next });

                // Safety net: if <Toasts/> is not mounted, nothing lingers forever.
                const life = options?.duration ?? DEFAULT_LIFE[type];
                if (life > 0) {
                    toastSafety.set(id, setTimeout(() => {
                        toastSafety.delete(id);
                        const still = get().toasts.some(t => t.id === id);
                        if (still) set({ toasts: get().toasts.filter(t => t.id !== id) });
                    }, life + 2500));
                }
                return id;
            },
            removeToast: (id) => {
                clearSafety(id);
                set({ toasts: get().toasts.filter(t => t.id !== id) });
            },
            clearToasts: () => {
                toastSafety.forEach((_, id) => clearSafety(id));
                set({ toasts: [] });
            },
        }),
        {
            name: 'hearth_ui',
            version: 1,
            storage: createJSONStorage(() => localStorage),
            // Only harmless UI preference survives a reload. Never player/selection/modal state.
            partialize: (state) => ({ viewMode: state.viewMode }),
        },
    ),
);

/* ═══════════════════════════════ Session lifecycle ═══════════════════════════════ */

if (typeof window !== 'undefined') {
    window.addEventListener(AUTH_EXPIRED_EVENT, () => {
        const s = useAppStore.getState();
        if (!s.isAuthenticated) return;
        s.logout();
        s.addToast('Your sign-in expired — please sign in again', 'warning', { title: 'Session ended' });
    });

    window.addEventListener(AUTH_CHANGED_EVENT, (event) => {
        const authenticated = !!(event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated;
        useAppStore.setState({ isAuthenticated: authenticated });
        if (!authenticated) useAppStore.getState().logout();
    });

    // Keep auth state honest across tabs (a sign-out elsewhere signs this tab out too).
    window.addEventListener('storage', (event) => {
        if (event.key === 'access_token') {
            useAppStore.setState({ isAuthenticated: !!event.newValue });
        }
        if (event.key === PLAYER_PREFS_KEY) {
            useAppStore.setState({ playerPrefs: loadPlayerPrefs() });
        }
    });
}

/* ═══════════════════════════════ Convenience selectors ═══════════════════════════════ */

export const useToasts = () => useAppStore(s => s.toasts);
export const useRole = () => useAppStore(s => s.role);
export const useIsAdmin = () => useAppStore(s => s.role === 'admin');
export const useManageMode = () => useAppStore(s => s.manageMode);
export const usePreviewFile = () => useAppStore(s => s.previewFile);
export const usePlayerPrefs = () => useAppStore(s => s.playerPrefs);
export const useDevice = () => useAppStore(s => ({
    id: s.deviceId, label: s.deviceLabel, kind: s.deviceKind, isTv: s.isTvDevice,
}));

export default useAppStore;
