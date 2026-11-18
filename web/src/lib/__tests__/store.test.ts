// @vitest-environment jsdom

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getDeviceId } from "../device";
import {
  ACCESS_KEY,
  REFRESH_KEY,
  useAppStore,
  loadPlayerPrefs,
  PLAYER_PREFS_KEY,
} from "../store";

const DEFAULT_STATE = {
  auth: { user: null, role: "unknown" as const },
  previewFile: null,
  isPlayerMinimized: false,
  toasts: [],
  deleteConfirm: { file: null, isOpen: false },
  playerPrefs: { volume: 1, muted: false, playbackRate: 1 },
  activeContextMenu: null,
};

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

vi.stubGlobal("localStorage", new MemoryStorage());

function resetStore() {
  useAppStore.getState().clearToasts();
  useAppStore.setState({
    ...DEFAULT_STATE,
    playerPrefs: { ...DEFAULT_STATE.playerPrefs },
    deleteConfirm: { ...DEFAULT_STATE.deleteConfirm },
  });
}

describe("store state (T8)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults the role to 'unknown', never 'admin'", () => {
    expect(useAppStore.getState().auth.role).toBe("unknown");
    expect(useAppStore.getState().auth.user).toBeNull();
  });

  it("setUser derives the role from the server user object", () => {
    useAppStore.getState().setUser({ id: 1, role: "admin" });
    expect(useAppStore.getState().auth.role).toBe("admin");

    useAppStore.getState().setUser({ id: 2, role: "guest" });
    expect(useAppStore.getState().auth.role).toBe("guest");
  });

  it("clearAuth resets the role to 'unknown' and drops tokens", () => {
    localStorage.setItem(ACCESS_KEY, "a");
    localStorage.setItem(REFRESH_KEY, "r");
    useAppStore.getState().setUser({ id: 1, role: "admin" });

    useAppStore.getState().clearAuth();

    expect(useAppStore.getState().auth.user).toBeNull();
    expect(useAppStore.getState().auth.role).toBe("unknown");
    expect(localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("auto-dismisses a toast after five seconds", () => {
    vi.useFakeTimers();
    const id = useAppStore.getState().addToast("Saved", "success");
    expect(useAppStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(4999);
    expect(useAppStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(useAppStore.getState().toasts).toHaveLength(0);
    expect(id).toBeTruthy();
  });

  it("persists player prefs across store reinitialisation", () => {
    useAppStore.getState().setPlayerPrefs({
      volume: 0.4,
      muted: true,
      playbackRate: 1.5,
    });

    const raw = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) ?? "{}");
    expect(raw).toMatchObject({
      volume: 0.4,
      muted: true,
      playbackRate: 1.5,
      rate: 1.5,
    });

    // Simulate a fresh boot reading the persisted key.
    useAppStore.setState({ playerPrefs: loadPlayerPrefs() });
    expect(useAppStore.getState().playerPrefs).toEqual({
      volume: 0.4,
      muted: true,
      playbackRate: 1.5,
    });
  });

  it("keeps one stable device id across repeated reads", () => {
    localStorage.setItem("hearth_device_id", "device-stable-123");
    const first = getDeviceId();
    const second = getDeviceId();

    expect(first).toBe("device-stable-123");
    expect(second).toBe(first);
    expect(typeof useAppStore.getState().deviceId).toBe("string");
  });

  it("openDeleteConfirm / closeDeleteConfirm manage a single file", () => {
    const file = {
      id: 9,
      file_name: "clip.mp4",
      file_type: "video",
      file_size: 10,
    };
    useAppStore.getState().openDeleteConfirm(file);
    expect(useAppStore.getState().deleteConfirm).toEqual({
      file,
      isOpen: true,
    });

    useAppStore.getState().closeDeleteConfirm();
    expect(useAppStore.getState().deleteConfirm).toEqual({
      file: null,
      isOpen: false,
    });
  });
});
