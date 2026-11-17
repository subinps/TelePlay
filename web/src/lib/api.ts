/**
Hearth — API layer  (README §4.6, §6.3, §6.4, §6.8, §7.2; fixes F7, F9, F10, F11, F16)
─────────────────────────────────────────────────────────────────────────────
KEPT (working logic)
axios instance + bearer header + single-flight refresh, React Query hooks,
every legacy export the existing screens import (useFiles, useFolders, useFolderTree,
useRecentFiles, useContinueWatching, useCreateFolder, useUpdateFile, useUpdateFolder,
useDeleteFile(s), useDeleteFolder(s), useMoveFiles, useMoveFolders, useFile,
useUpdateProgress, formatDuration, formatFileSize, TelegramFile, Folder, api).

FIXED
F16  every path resolves against the API origin (apiUrl / API_ORIGIN) — never the
   Pages origin, so thumbnails and streams stop 404ing on a split deployment.
F7   playback uses POST /playback/start → a short, per-file, per-device signed URL.
   No 7-day login JWT is ever placed in a media URL.
F10  thumbnails are fetched with the Authorization header and turned into blob URLs
   (LRU-cached, revoked on eviction) instead of leaking a token into <img src>.
F9   progress writes patch the query cache in place (no 10 s refetch storm) and let the
   server own the `completed` flag at 95 %.
F11  guests get clean 403s surfaced as readable messages, never silent failures.

ADDED
playback session hooks (start / heartbeat / stop / active / kick) with the 409
DEVICE_LIMIT payload typed, /auth/me role, /auth/bot-info, typed query-key factory,
readable error extraction, and route-drift tolerance during the phased rollout.

COMPATIBILITY
Mutation results expose `isPending` AND `isLoading` so screens written against either
React Query v4 or v5 behave identically. No v4/v5-only options are used.
─────────────────────────────────────────────────────────────────────────────
*/
import axios from "axios";
import type { AxiosError, AxiosRequestConfig } from "axios";
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getDeviceId, getDeviceLabel } from "./device";

/* ═══════════════════════════════ Origin & URLs ═══════════════════════════════ */

const ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env ?? {};

/** '/api' for same-origin deploys, or an absolute 'https://host/api' for split deploys. */
export const API_BASE: string = (ENV.VITE_API_URL || "/api").replace(
  /\/+$/,
  "",
);

export const API_ORIGIN: string = /^https?:\/\//i.test(API_BASE)
  ? new URL(API_BASE).origin
  : typeof window !== "undefined"
    ? window.location.origin
    : "";

/** F16: resolve an API path against the API origin, never the page origin. */
export function apiUrl(path: string): string {
  if (!path) return API_ORIGIN;
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  return API_ORIGIN ? `${API_ORIGIN}${clean}` : clean;
}

/** Backend returns paths that already include /api — never double the prefix. */
export function resolveBackendPath(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api/") || path === "/api") return apiUrl(path);
  const base = API_BASE.endsWith("/api") ? API_BASE : `${API_BASE}/api`;
  return apiUrl(`${base}${path.startsWith("/") ? path : `/${path}`}`);
}

/* ═══════════════════════════════ Tokens ═══════════════════════════════ */

export const ACCESS_KEY = "access_token";
export const REFRESH_KEY = "refresh_token";

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

const drop = (k: string) => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* noop */
  }
};

export const getAccessToken = () => read(ACCESS_KEY);
export const getRefreshToken = () => read(REFRESH_KEY);
export const isAuthenticated = () => !!getAccessToken();

export interface TokenPair {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
}

export function setTokens(tokens: TokenPair): void {
  if (tokens?.access_token) write(ACCESS_KEY, tokens.access_token);
  if (tokens?.refresh_token) write(REFRESH_KEY, tokens.refresh_token);
}

export function clearTokens(): void {
  drop(ACCESS_KEY);
  drop(REFRESH_KEY);
}

export const AUTH_EXPIRED_EVENT = "hearth:auth-expired";
export const AUTH_CHANGED_EVENT = "hearth:auth-changed";

function emit(name: string, detail?: unknown) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* noop */
  }
}

/* ═══════════════════════════════ Types ═══════════════════════════════ */

export type UserRole = "admin" | "guest";
export type FileKind = "video" | "audio" | "image" | "document" | string;

export interface SubtitleTrack {
  lang: string;
  label: string;
  url: string;
}

export interface TelegramFile {
  id: number;
  file_name: string;
  file_type: FileKind;
  file_size: number;
  mime_type?: string | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnail_url?: string | null;
  stream_url?: string; // Backend no longer sends this; player uses /playback/start
  folder_id?: number | null;
  message_id?: number | null;
  created_at?: string;
  updated_at?: string;
  /** Per-user progress (§6.4). */
  last_pos?: number | null;
  completed?: boolean;
  subtitles?: SubtitleTrack[];
}

export interface Folder {
  id: number;
  name: string;
  parent_id?: number | null;
  file_count: number;
  created_at?: string;
  children?: Folder[];
}

export interface FilesPage {
  files: TelegramFile[];
  total: number;
  page: number;
  per_page: number;
}

export interface Me {
  telegram_id?: number;
  username?: string | null;
  first_name?: string | null;
  role: UserRole;
}

export interface BotInfo {
  bot_username: string;
  bot_link: string;
}

export interface ActiveDevice {
  device_id: string;
  label: string;
  file_id?: number | null;
  role?: UserRole | string;
  started_at?: string;
  last_seen?: string;
}

export interface PlaybackStart {
  stream_url?: string; // Backend no longer sends this; player uses /playback/start
  token?: string;
  heartbeat_seconds: number;
  expires_in?: number;
}

export interface DeviceLimitDetail {
  code: "DEVICE_LIMIT";
  message?: string;
  active: ActiveDevice[];
}

export interface ProgressPayload {
  fileId: number;
  position: number;
  duration?: number;
}

/* ═══════════════════════════════ Errors ═══════════════════════════════ */

interface Shape {
  response?: { status?: number; data?: { detail?: unknown } };
  message?: string;
}

export const errorStatus = (e: unknown): number | undefined =>
  (e as Shape)?.response?.status;

export function errorDetail(e: unknown): unknown {
  return (e as Shape)?.response?.data?.detail;
}

export function errorMessage(
  e: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  const d = errorDetail(e);
  if (typeof d === "string" && d && d !== "Not Found") return d;
  if (d && typeof d === "object") {
    const m = (d as { message?: string }).message;
    if (typeof m === "string" && m) return m;
  }
  const s = errorStatus(e);
  if (s === 401) return "Your sign-in expired. Please sign in again.";
  if (s === 403) return "Only the family account can do that.";
  if (s === 404) return "That item is no longer in the library.";
  if (s === 409) return "That conflicts with something already there.";
  if (s === 422) return "That value was rejected. Check it and try again.";
  if (s === 429) return "Too many attempts. Wait a moment and try again.";
  if (s && s >= 500)
    return "The server had a problem. Nothing was changed — try again.";
  if (!s)
    return "Could not reach the server. Check the connection and try again.";
  return fallback;
}

/** True when the backend refused because two screens are already playing. */
export function isDeviceLimitError(e: unknown): boolean {
  const d = errorDetail(e);
  return (
    errorStatus(e) === 409 &&
    !!d &&
    typeof d === "object" &&
    (d as { code?: string }).code === "DEVICE_LIMIT"
  );
}

export function deviceLimitPayload(e: unknown): DeviceLimitDetail | null {
  if (!isDeviceLimitError(e)) return null;
  const d = errorDetail(e) as DeviceLimitDetail;
  return {
    code: "DEVICE_LIMIT",
    message: d.message,
    active: Array.isArray(d.active) ? d.active : [],
  };
}

/** Route missing (not deployed yet) vs. a real 404 for a record. */
function routeMissing(e: unknown): boolean {
  const s = errorStatus(e);
  if (s === 405 || s === 501) return true;
  if (s !== 404) return false;
  const d = errorDetail(e);
  return typeof d !== "string" || d === "Not Found" || d === "Not found";
}

async function withRouteFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (routeMissing(e)) return fallback();
    throw e;
  }
}

/* ═══════════════════════════════ axios instance ═══════════════════════════════ */

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  headers: { Accept: "application/json" },
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  const headers = (config.headers ?? {}) as Record<string, unknown>;
  if (token) headers.Authorization = `Bearer ${token}`;
  headers["X-Device-Id"] = getDeviceId();
  config.headers = headers as typeof config.headers;
  return config;
});

const AUTH_ROUTES = [
  "/auth/verify-code",
  "/auth/refresh",
  "/auth/guest/login",
  "/auth/logout-all",
  "/auth/login",
  "/auth/guest-login",
  "/auth/guest",
  "/auth/logout",
];

const isAuthRoute = (url?: string) =>
  !!url && AUTH_ROUTES.some((r) => url.includes(r));

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refresh = getRefreshToken();
  if (!refresh) throw new Error("no refresh token");

  // Plain axios: bypasses our interceptors so a 401 here cannot recurse.
  const { data } = await axios.post<TokenPair>(
    apiUrl(`${API_BASE}/auth/refresh`),
    { refresh_token: refresh },
    { headers: { "Content-Type": "application/json" }, timeout: 20000 },
  );

  if (!data?.access_token) throw new Error("refresh returned no token");
  setTokens(data);
  emit(AUTH_CHANGED_EVENT, { authenticated: true });
  return data.access_token;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as
      | (AxiosRequestConfig & { _retry?: boolean })
      | undefined;
    const status = error.response?.status;

    if (status !== 401 || !config || config._retry || isAuthRoute(config.url)) {
      return Promise.reject(error);
    }

    if (!getRefreshToken()) {
      clearTokens();
      emit(AUTH_EXPIRED_EVENT);
      return Promise.reject(error);
    }

    config._retry = true;

    try {
      refreshPromise =
        refreshPromise ??
        refreshAccessToken().finally(() => {
          refreshPromise = null;
        });

      const token = await refreshPromise;
      const headers = (config.headers ?? {}) as Record<string, unknown>;
      headers.Authorization = `Bearer ${token}`;
      config.headers = headers as typeof config.headers;
      return api.request(config);
    } catch (refreshError) {
      clearTokens();
      emit(AUTH_EXPIRED_EVENT);
      return Promise.reject(refreshError);
    }
  },
);

/* ═══════════════════════════════ Query keys ═══════════════════════════════ */

export const qk = {
  files: (
    folderId: number | null,
    fileType?: string,
    search?: string,
    page = 1,
    perPage = 24,
  ) =>
    [
      "files",
      folderId ?? "root",
      fileType ?? "all",
      search ?? "",
      page,
      perPage,
    ] as const,
  filesAll: () => ["files"] as const,
  file: (id: number) => ["file", id] as const,
  continue: (limit: number) => ["continue-watching", limit] as const,
  continueAll: () => ["continue-watching"] as const,
  recent: (limit: number) => ["recent", limit] as const,
  folders: () => ["folders"] as const,
  folderTree: () => ["folder-tree"] as const,
  me: () => ["me"] as const,
  botInfo: () => ["bot/info"] as const,
  activeDevices: () => ["playback", "active"] as const,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false, // TV: never refetch on remote-driven focus
      refetchOnReconnect: true,
    },
    mutations: { retry: 0 },
  },
});

/* ═══════════════════════════════ Normalisers ═══════════════════════════════ */

function asArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  const inner = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

function normalisePage(
  data: unknown,
  page: number,
  perPage: number,
): FilesPage {
  if (Array.isArray(data)) {
    const files = data as TelegramFile[];
    return {
      files,
      total: files.length,
      page: 1,
      per_page: perPage || files.length || 1,
    };
  }
  const d = (data ?? {}) as Partial<FilesPage> & { items?: TelegramFile[] };
  const files = (d.files ?? d.items ?? []) as TelegramFile[];
  return {
    files,
    total: typeof d.total === "number" ? d.total : files.length,
    page: typeof d.page === "number" ? d.page : page,
    per_page:
      typeof d.per_page === "number"
        ? d.per_page
        : perPage || files.length || 1,
  };
}

function normaliseRole(value: unknown): UserRole {
  const r = (value as { role?: string; user?: { role?: string } } | null)?.role
    ?? (value as { user?: { role?: string } } | null)?.user?.role;
  // Fail closed: default to least privilege (guest) until explicitly confirmed as admin
  return r === "admin" ? "admin" : "guest";
}

function normaliseMe(data: unknown): Me {
  const d = (data ?? {}) as Me & { user?: Me };
  const src = d.user ?? d;
  return {
    telegram_id: src.telegram_id,
    username: src.username ?? null,
    first_name: src.first_name ?? null,
    role: normaliseRole(data),
  };
}

function normaliseBotInfo(data: unknown): BotInfo {
  const d = (data ?? {}) as {
    bot_username?: string;
    username?: string;
    bot?: { username?: string };
  };
  const name = (d.bot_username ?? d.username ?? d.bot?.username ?? "").replace(
    /^@/,
    "",
  );
  return { bot_username: name, bot_link: name ? `https://t.me/${name}` : "" };
}

function normaliseDevices(data: unknown): ActiveDevice[] {
  const list = asArray<ActiveDevice>(data, "active");
  return list.filter((d) => !!d && typeof d.device_id === "string");
}

/* ═══════════════════════════════ Auth API ═══════════════════════════════ */

export async function loginWithCode(code: string): Promise<TokenPair> {
  // Backend route is /auth/verify-code
  const { data } = await api.post<TokenPair>("/auth/verify-code", {
    code: code.trim(),
  });
  setTokens(data);
  emit(AUTH_CHANGED_EVENT, { authenticated: true });
  return data;
}

export async function loginWithPin(pin: string): Promise<TokenPair> {
  // Backend route is /auth/guest/login
  const body = { pin: pin.trim() };
  const { data } = await api.post<TokenPair>("/auth/guest/login", body);
  setTokens(data);
  emit(AUTH_CHANGED_EVENT, { authenticated: true });
  return data;
}

export const login = loginWithCode;
export const guestLogin = loginWithPin;

export async function fetchMe(): Promise<Me> {
  const { data } = await api.get("/auth/me");
  return normaliseMe(data);
}

export async function fetchBotInfo(): Promise<BotInfo> {
  try {
    const { data } = await api.get("/auth/bot/info");
    return normaliseBotInfo(data);
  } catch {
    return { bot_username: "", bot_link: "" };
  }
}

/** Revokes the refresh token, releases this screen's playback slot, clears local tokens. */
export async function logout(): Promise<void> {
  // Backend route is /auth/logout-all (takes empty body, relies on Bearer token)
  try {
    await api.post("/auth/logout-all", {});
  } catch {
    /* best effort */
  }
  stopPlaybackBeacon();
  clearTokens();
  emit(AUTH_CHANGED_EVENT, { authenticated: false });
}

/* ═══════════════════════════════ Playback (§4.6 / §6.3) ═══════════════════════════════ */

export async function startPlayback(fileId: number): Promise<PlaybackStart> {
  const { data } = await api.post<PlaybackStart>("/playback/start", {
    file_id: fileId,
    device_id: getDeviceId(),
    device_label: getDeviceLabel(),
  });

  return {
    stream_url: resolveBackendPath(data.stream_url),
    token: data.token,
    heartbeat_seconds: Math.min(
      60,
      Math.max(5, Number(data.heartbeat_seconds) || 20),
    ),
    expires_in: data.expires_in,
  };
}

export async function sendHeartbeat(fileId?: number): Promise<void> {
  await api.post("/playback/heartbeat", {
    device_id: getDeviceId(),
    file_id: fileId,
  });
}

export async function stopPlayback(
  deviceId: string = getDeviceId(),
): Promise<void> {
  await api.post("/playback/stop", { device_id: deviceId });
}

/** Survives page teardown — used on unmount, pagehide and sign-out. */
export function stopPlaybackBeacon(deviceId: string = getDeviceId()): void {
  try {
    const token = getAccessToken();
    void fetch(apiUrl(`${API_BASE}/playback/stop`), {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ device_id: deviceId }),
    }).catch(() => {
      /* best effort */
    });
  } catch {
    /* best effort */
  }
}

export async function fetchActiveDevices(): Promise<ActiveDevice[]> {
  const { data } = await api.get("/playback/active");
  return normaliseDevices(data);
}

export async function kickDevice(deviceId: string): Promise<void> {
  await api.delete(`/playback/${encodeURIComponent(deviceId)}`);
}

/** Signed stream URL for a <video src>. Never contains the login JWT. */
export const streamUrl = (path: string) => resolveBackendPath(path);

/* ═══════════════════════════════ Files & folders ═══════════════════════════════ */

export interface FilesQuery {
  folderId?: number | null;
  fileType?: string;
  search?: string;
  page?: number;
  perPage?: number;
}

export async function fetchFiles(q: FilesQuery = {}): Promise<FilesPage> {
  const page = q.page ?? 1;
  const perPage = q.perPage ?? 24;
  const { data } = await api.get("/files", {
    params: {
      folder_id: q.folderId ?? undefined,
      file_type: q.fileType || undefined,
      search: q.search || undefined,
      page,
      per_page: perPage,
    },
  });
  return normalisePage(data, page, perPage);
}

export async function fetchFile(id: number): Promise<TelegramFile> {
  const { data } = await api.get(`/files/${id}`);
  return data as TelegramFile;
}

export async function fetchContinueWatching(
  limit = 20,
): Promise<{ files: TelegramFile[] }> {
  const data = await withRouteFallback(
    async () =>
      (await api.get("/files/continue-watching", { params: { limit } })).data,
    async () => (await api.get("/files/continue", { params: { limit } })).data,
  );
  return { files: asArray<TelegramFile>(data, "files") };
}

export async function fetchRecentFiles(
  limit = 20,
): Promise<{ files: TelegramFile[] }> {
  // Backend route is /tv/recent
  const { data } = await api.get("/tv/recent", { params: { limit } });
  return { files: asArray<TelegramFile>(data, "files") };
}

export async function fetchFolders(): Promise<Folder[]> {
  const { data } = await api.get("/folders");
  return asArray<Folder>(data, "folders");
}

export async function fetchFolderTree(): Promise<Folder[]> {
  const data = await withRouteFallback(
    async () => (await api.get("/folders/tree")).data,
    async () => (await api.get("/folders")).data,
  );
  return asArray<Folder>(data, "folders");
}

export async function createFolder(input: {
  name: string;
  parent_id?: number | null;
}): Promise<Folder> {
  const { data } = await api.post("/folders", {
    name: input.name,
    parent_id: input.parent_id ?? null,
  });
  return data as Folder;
}

export async function renameFolder(id: number, name: string): Promise<Folder> {
  const { data } = await api.patch(`/folders/${id}`, { name });
  return data as Folder;
}

export async function renameFile(
  id: number,
  name: string,
): Promise<TelegramFile> {
  const { data } = await api.patch(`/files/${id}`, { file_name: name });
  return data as TelegramFile;
}

export async function deleteFile(id: number): Promise<void> {
  await api.delete(`/files/${id}`);
}

export async function deleteFiles(ids: number[]): Promise<void> {
  if (!ids.length) return;
  try {
    await api.post("/files/batch-delete", ids);
  } catch (e) {
    if (!routeMissing(e)) throw e;
    try {
      await api.post("/files/delete", { file_ids: ids });
    } catch (e2) {
      if (!routeMissing(e2)) throw e2;
      for (const id of ids) await deleteFile(id); // last resort: one at a time
    }
  }
}

export async function deleteFolder(id: number): Promise<void> {
  await api.delete(`/folders/${id}`);
}

export async function deleteFolders(ids: number[]): Promise<void> {
  for (const id of ids) await deleteFolder(id);
}

export async function moveFiles(input: {
  ids: number[];
  folderId: number | null;
}): Promise<void> {
  if (!input.ids.length) return;
  // Backend route is /files/batch-move with payload { ids, folder_id }
  await api.post("/files/batch-move", {
    ids: input.ids,
    folder_id: input.folderId,
  });
}

export async function moveFolders(input: {
  ids: number[];
  folderId: number | null;
}): Promise<void> {
  if (!input.ids.length) return;
  // Backend route is /folders/batch-move with payload { ids, parent_id }
  await api.post("/folders/batch-move", {
    ids: input.ids,
    parent_id: input.folderId,
  });
}

export async function postProgress(p: ProgressPayload): Promise<void> {
  const body = {
    position: Math.max(0, Math.floor(p.position)),
    duration: Math.max(0, Math.floor(p.duration ?? 0)),
  };
  await withRouteFallback(
    async () => {
      await api.post(`/files/${p.fileId}/progress`, body);
    },
    async () => {
      await api.post(`/progress/${p.fileId}`, body);
    },
  );
}

/* ═══════════════════════════════ Thumbnails (F7 / F10 / F16) ═══════════════════════════════ */

const THUMB_LIMIT = 64;
const thumbCache = new Map<number, string>();
const thumbOrder: number[] = [];
const thumbPending = new Map<number, Promise<string>>();

function rememberThumb(id: number, url: string) {
  // Revoke existing URL for this ID if it exists (prevents leaks on re-fetch)
  const existing = thumbCache.get(id);
  if (existing) URL.revokeObjectURL(existing);
  thumbCache.set(id, url);
  thumbOrder.push(id);
  while (thumbOrder.length > THUMB_LIMIT) {
    const old = thumbOrder.shift();
    if (old === undefined || old === id) continue;
    const ou = thumbCache.get(old);
    if (ou) URL.revokeObjectURL(ou);
    thumbCache.delete(old);
  }
}

export const cachedThumbnail = (id: number): string | null =>
  thumbCache.get(id) ?? null;

export function revokeThumbnail(id: number): void {
  const url = thumbCache.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbCache.delete(id);
  const i = thumbOrder.indexOf(id);
  if (i >= 0) thumbOrder.splice(i, 1);
}

export async function fetchThumbnailBlob(
  fileId: number,
  path: string,
): Promise<string> {
  const hit = thumbCache.get(fileId);
  if (hit) return hit;
  const pending = thumbPending.get(fileId);
  if (pending) return pending;

  const job = api
    .get(resolveBackendPath(path), { responseType: "blob", timeout: 20000 })
    .then(({ data }) => {
      const url = URL.createObjectURL(data as Blob);
      rememberThumb(fileId, url);
      return url;
    })
    .finally(() => {
      thumbPending.delete(fileId);
    });

  thumbPending.set(fileId, job);
  return job;
}

/** Authorised blob thumbnail. Returns null while loading or when the file has no poster. */
export function useThumbnailUrl(
  fileId?: number | null,
  path?: string | null,
  enabled = true,
): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    fileId != null ? cachedThumbnail(fileId) : null,
  );

  useEffect(() => {
    if (fileId == null || !path || !enabled) {
      setUrl(null);
      return;
    }
    const hit = cachedThumbnail(fileId);
    if (hit) {
      setUrl(hit);
      return;
    }
    let live = true;
    fetchThumbnailBlob(fileId, path)
      .then((u) => {
        if (live) setUrl(u);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
    };
  }, [fileId, path, enabled]);

  return url;
}

/* ═══════════════════════════════ React Query hooks ═══════════════════════════════ */

type AnyMutation = UseMutationResult<unknown, unknown, unknown, unknown>;

/** v4 calls it isLoading, v5 calls it isPending — expose both so screens never break. */
function compat<T extends object>(
  m: T,
): T & { isPending: boolean; isLoading: boolean } {
  const x = m as T & { isPending?: boolean; isLoading?: boolean };
  const pending = x.isPending ?? x.isLoading ?? false;
  return Object.assign({}, x, { isPending: pending, isLoading: pending });
}

function useCompatMutation<TData, TVars, TContext = unknown>(
  options: Parameters<typeof useMutation<TData, unknown, TVars, TContext>>[0],
) {
  const m = useMutation<TData, unknown, TVars, TContext>(options);
  return compat(m as unknown as AnyMutation) as unknown as UseMutationResult<
    TData,
    unknown,
    TVars,
    TContext
  > & { isPending: boolean; isLoading: boolean };
}

export function useFiles(
  folderId: number | null = null,
  fileType?: string,
  search?: string,
  page = 1,
  perPage = 24,
  enabled = true,
): UseQueryResult<FilesPage> {
  return useQuery({
    queryKey: qk.files(folderId, fileType, search, page, perPage),
    queryFn: () => fetchFiles({ folderId, fileType, search, page, perPage }),
    enabled,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useFile(id?: number | null): UseQueryResult<TelegramFile> {
  return useQuery({
    queryKey: qk.file(id ?? -1),
    queryFn: () => fetchFile(id as number),
    enabled: typeof id === "number" && id > 0,
    staleTime: 15_000,
    retry: 1,
  });
}

export function useContinueWatching(
  limit = 20,
): UseQueryResult<{ files: TelegramFile[] }> {
  return useQuery({
    queryKey: qk.continue(limit),
    queryFn: () => fetchContinueWatching(limit),
    staleTime: 15_000,
    retry: 1,
  });
}

export function useRecentFiles(
  limit = 20,
): UseQueryResult<{ files: TelegramFile[] }> {
  return useQuery({
    queryKey: qk.recent(limit),
    queryFn: () => fetchRecentFiles(limit),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useFolders(): UseQueryResult<Folder[]> {
  return useQuery({
    queryKey: qk.folders(),
    queryFn: fetchFolders,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useFolderTree(): UseQueryResult<Folder[]> {
  return useQuery({
    queryKey: qk.folderTree(),
    queryFn: fetchFolderTree,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useMe(): UseQueryResult<Me> & { role: UserRole } {
  const q = useQuery({
    queryKey: qk.me(),
    queryFn: fetchMe,
    staleTime: 5 * 60_000,
    retry: false,
    enabled: isAuthenticated(),
  });
  return Object.assign({}, q, {
    role: q.data?.role ?? "admin",
  }) as UseQueryResult<Me> & { role: UserRole };
}

export function useBotInfo(): UseQueryResult<BotInfo> {
  return useQuery({
    queryKey: qk.botInfo(),
    queryFn: fetchBotInfo,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

export function useActiveDevices(
  enabled = true,
  intervalMs = 15_000,
): UseQueryResult<ActiveDevice[]> {
  return useQuery({
    queryKey: qk.activeDevices(),
    queryFn: fetchActiveDevices,
    enabled,
    refetchInterval: enabled ? intervalMs : false,
    staleTime: 5_000,
    retry: false,
  });
}

/* ── Library mutations ───────────────────────────────────────────────────── */

function useLibraryInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.filesAll() });
    void qc.invalidateQueries({ queryKey: qk.continueAll() });
    void qc.invalidateQueries({ queryKey: ["recent"] });
    void qc.invalidateQueries({ queryKey: ["file"] });
    void qc.invalidateQueries({ queryKey: qk.folders() });
    void qc.invalidateQueries({ queryKey: qk.folderTree() });
  };
}

export function useDeleteFile() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<void, number>({
    mutationFn: (id) => deleteFile(id),
    onSuccess: invalidate,
  });
}

export function useDeleteFiles() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<void, number[]>({
    mutationFn: (ids) => deleteFiles(ids),
    onSuccess: invalidate,
  });
}

export function useDeleteFolder() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<void, number>({
    mutationFn: (id) => deleteFolder(id),
    onSuccess: invalidate,
  });
}

export function useDeleteFolders() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<void, number[]>({
    mutationFn: (ids) => deleteFolders(ids),
    onSuccess: invalidate,
  });
}

export function useMoveFiles() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<void, { ids: number[]; folderId: number | null }>({
    mutationFn: moveFiles,
    onSuccess: invalidate,
  });
}

export function useMoveFolders() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<void, { ids: number[]; folderId: number | null }>({
    mutationFn: moveFolders,
    onSuccess: invalidate,
  });
}

export function useCreateFolder() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<Folder, { name: string; parent_id?: number | null }>(
    {
      mutationFn: createFolder,
      onSuccess: invalidate,
    },
  );
}

export function useUpdateFile() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<TelegramFile, { id: number; name: string }>({
    mutationFn: ({ id, name }) => renameFile(id, name),
    onSuccess: invalidate,
  });
}

export function useUpdateFolder() {
  const invalidate = useLibraryInvalidation();
  return useCompatMutation<Folder, { id: number; name: string }>({
    mutationFn: ({ id, name }) => renameFolder(id, name),
    onSuccess: invalidate,
  });
}

/* ── Progress (F9): patch caches in place, never refetch on a 10 s timer ──── */

function patchProgressCaches(
  qc: ReturnType<typeof useQueryClient>,
  p: ProgressPayload,
) {
  const dur = p.duration && p.duration > 0 ? p.duration : undefined;
  const completed = dur ? p.position >= dur * 0.95 : undefined;
  const patch = (f: TelegramFile): TelegramFile => ({
    ...f,
    last_pos: p.position,
    ...(dur ? { duration: dur } : {}),
    ...(completed !== undefined ? { completed } : {}),
  });

  const single = qc.getQueryData<TelegramFile>(qk.file(p.fileId));
  if (single) qc.setQueryData(qk.file(p.fileId), patch(single));

  const lists = qc.getQueryCache().findAll({
    predicate: (q) =>
      q.queryKey[0] === "files" ||
      q.queryKey[0] === "continue-watching" ||
      q.queryKey[0] === "recent",
  });

  for (const entry of lists) {
    const data = entry.state.data as { files?: TelegramFile[] } | undefined;
    if (!data?.files?.length) continue;
    let touched = false;
    const files = data.files.map((f) => {
      if (f.id !== p.fileId) return f;
      touched = true;
      return patch(f);
    });
    if (touched) qc.setQueryData(entry.queryKey, { ...data, files });
  }
}

export function useUpdateProgress() {
  const qc = useQueryClient();
  return useCompatMutation<void, ProgressPayload>({
    mutationFn: postProgress,
    onMutate: async (payload) => {
      patchProgressCaches(qc, payload);
    },
    // Progress is best-effort: a failed write must never interrupt playback or spam toasts.
    onError: () => {
      /* swallowed on purpose */
    },
  });
}

/* ── Playback hooks ──────────────────────────────────────────────────────── */

export function usePlaybackStart() {
  return useCompatMutation<PlaybackStart, number>({
    mutationFn: (fileId) => startPlayback(fileId),
  });
}

export function useHeartbeat() {
  return useCompatMutation<void, number | undefined>({
    mutationFn: (fileId) => sendHeartbeat(fileId),
  });
}

export function useStopPlayback() {
  const qc = useQueryClient();
  return useCompatMutation<void, string | undefined>({
    mutationFn: (deviceId) => stopPlayback(deviceId ?? getDeviceId()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.activeDevices() });
    },
  });
}

export function useKickDevice() {
  const qc = useQueryClient();
  return useCompatMutation<void, string>({
    mutationFn: kickDevice,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.activeDevices() });
    },
  });
}

/* ═══════════════════════════════ Formatters ═══════════════════════════════ */

export function formatDuration(seconds?: number | null): string {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "0:00";
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function formatFileSize(bytes?: number | null): string {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2)
    return `${(b / 1024 ** 2).toFixed(b >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function formatResumeLabel(
  pos?: number | null,
  duration?: number | null,
): string {
  const p = Number(pos) || 0;
  const d = Number(duration) || 0;
  if (p <= 0) return "";
  if (d <= 0) return `Resume ${formatDuration(p)}`;
  const left = Math.max(0, d - p);
  if (left >= 3600)
    return `${formatDuration(p)} · ${Math.floor(left / 3600)}h ${Math.round((left % 3600) / 60)}m left`;
  if (left >= 60)
    return `${formatDuration(p)} · ${Math.round(left / 60)} min left`;
  return `${formatDuration(p)} · ${Math.floor(left)}s left`;
}

export default api;