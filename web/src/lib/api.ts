/**
 * Hearth — API layer (T8)
 * ─────────────────────────────────────────────────────────────────────────────
 * Flat-library only. Every folder / move / rename endpoint is gone.
 *
 * Contracts that MUST stay stable for the frozen MediaPlayer.tsx:
 *   TelegramFile, formatDuration, useUpdateProgress, useFile, api
 * `api` remains an axios instance (MediaPlayer calls api.post / api.get directly
 * and reads api.defaults.baseURL), so it is not replaced by a plain object.
 *
 * Security:
 *   · logout() signs out THIS device only (POST /auth/logout).
 *   · fetchMe()/useMe() fail closed: any failure → null user, role "unknown".
 *   · 429 → { error: "RATE_LIMITED", retry_after_seconds } (server value).
 *   · 409 on playback/start → { error: "DEVICE_LIMIT", message, active }.
 *   · Stream URLs carry a signed per-file/per-device token; login JWTs never do.
 * ─────────────────────────────────────────────────────────────────────────────
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

const RAW_BASE = (
  ENV.VITE_API_URL ||
  ENV.VITE_API_BASE_URL ||
  "/api"
).trim();

function normaliseBase(raw: string): string {
  if (!raw) return "/api";
  const trimmed = raw.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === "/") return `${url.origin}/api`;
    return trimmed;
  }
  return trimmed === "/api" || trimmed.endsWith("/api")
    ? trimmed
    : `${trimmed}/api`;
}

/** '/api' for same-origin deploys, or an absolute 'https://host/api' for split deploys. */
export const API_BASE: string = normaliseBase(RAW_BASE);

export const API_ORIGIN: string = /^https?:\/\//i.test(API_BASE)
  ? new URL(API_BASE).origin
  : typeof window !== "undefined"
    ? window.location.origin
    : "";

export function apiUrl(path: string): string {
  if (!path) return API_ORIGIN;
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  return API_ORIGIN ? `${API_ORIGIN}${clean}` : clean;
}

function resolveBackendPath(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api/") || path === "/api") return apiUrl(path);
  return apiUrl(`${API_BASE}${path.startsWith("/") ? path : `/${path}`}`);
}

/* ═══════════════════════════════ Types ═══════════════════════════════ */

export type UserRole = "admin" | "guest";
export type Role = UserRole | "unknown";
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
  /** @deprecated Backend no longer sends this; the player uses /playback/start. */
  stream_url?: string;
  folder_id?: number | null;
  message_id?: number | null;
  created_at?: string;
  updated_at?: string;
  last_pos?: number | null;
  completed?: boolean;
  subtitles?: SubtitleTrack[];
}

/** @deprecated Kept only so unretired screens still type-check during rollout. */
export interface Folder {
  id: number;
  name: string;
  parent_id?: number | null;
  file_count?: number;
  created_at?: string;
}

export interface FilesPage {
  files: TelegramFile[];
  total: number;
  page: number;
  per_page: number;
}

export interface User {
  id?: number;
  telegram_id?: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  role: UserRole;
  created_at?: string;
  last_active?: string;
}

/** Alias retained for existing imports. */
export type Me = User;

export interface BotInfo {
  bot_username: string;
  bot_link: string;
}

export interface ActiveDevice {
  device_id: string;
  label: string;
  file_id?: number | null;
  role?: UserRole | string;
  is_self?: boolean;
  started_at?: string;
  last_seen?: string;
}

export interface PlaybackStartSuccess {
  token: string;
  device_id: string;
  stream_url?: string;
  heartbeat_seconds: number;
  expires_in?: number;
}

export interface DeviceLimitError {
  error: "DEVICE_LIMIT";
  message: string;
  active: ActiveDevice[];
}

export type PlaybackStartResult = PlaybackStartSuccess | DeviceLimitError;

export interface RateLimited {
  error: "RATE_LIMITED";
  retry_after_seconds: number;
}

export interface AuthFailure {
  error: "AUTH_FAILED" | "NETWORK";
  message: string;
}

export interface AuthSuccess {
  access_token: string;
  refresh_token?: string | null;
  token_type?: string;
  user: User;
}

export type AuthResult = AuthSuccess | RateLimited | AuthFailure;

export interface TokenPair {
  access_token: string;
  refresh_token?: string | null;
  token_type?: string;
}

export interface ProgressPayload {
  fileId: number;
  position: number;
  duration?: number;
}

export interface ProgressResult {
  position: number;
  duration: number;
  completed: boolean;
}

export const isAuthSuccess = (r: AuthResult): r is AuthSuccess =>
  typeof (r as AuthSuccess).access_token === "string" &&
  (r as AuthSuccess).access_token.length > 0;

export const isDeviceLimit = (r: PlaybackStartResult): r is DeviceLimitError =>
  (r as DeviceLimitError).error === "DEVICE_LIMIT";

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

export const getAccessToken = (): string | null => read(ACCESS_KEY);
export const getRefreshToken = (): string | null => read(REFRESH_KEY);
export const isAuthenticated = (): boolean => !!getAccessToken();

export function setTokens(tokens: TokenPair): void {
  if (tokens?.access_token) write(ACCESS_KEY, tokens.access_token);
  if (tokens?.refresh_token) {
    write(REFRESH_KEY, tokens.refresh_token);
  } else if ("refresh_token" in tokens) {
    drop(REFRESH_KEY);
  }
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
  const s = errorStatus(e);
  if (
    s === 503 ||
    (d &&
      typeof d === "object" &&
      (d as { code?: unknown }).code === "SERVICE_UNAVAILABLE")
  ) {
    return "Server is waking up or temporarily down. Please try again in about 30 seconds.";
  }
  if (typeof d === "string" && d && d !== "Not Found") return d;
  if (d && typeof d === "object") {
    const m = (d as { message?: string }).message;
    if (typeof m === "string" && m) return m;
  }
  if (s === 401) return "Your sign-in expired. Please sign in again.";
  if (s === 403) return "Only the family account can do that.";
  if (s === 404) return "That item is no longer in the library.";
  if (s === 409) return "That conflicts with something already there.";
  if (s === 422) return "That value was rejected. Check it and try again.";
  if (s === 429) return "Too many attempts. Wait a moment and try again.";
  if (s && s >= 500)
    return "The server had a problem. Nothing was changed — try again.";
  if (!s) return "Could not reach the server. Check the connection and try again.";
  return fallback;
}

export function isDeviceLimitError(e: unknown): boolean {
  const d = errorDetail(e);
  return (
    errorStatus(e) === 409 &&
    !!d &&
    typeof d === "object" &&
    (d as { code?: string }).code === "DEVICE_LIMIT"
  );
}

export function retryAfterSeconds(e: unknown): number {
  const d = errorDetail(e);
  if (d && typeof d === "object") {
    const n = Number((d as { retry_after_seconds?: unknown }).retry_after_seconds);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const headers = (e as { response?: { headers?: Record<string, unknown> } })
    ?.response?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
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
  "/auth/logout",
];

const isAuthRoute = (url?: string) =>
  !!url && AUTH_ROUTES.some((r) => url.includes(r));

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refresh = getRefreshToken();
  if (!refresh) throw new Error("no refresh token");

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

/* ═══════════════════════════════ Query keys & client ═══════════════════════════════ */

export const qk = {
  files: (
    _folderId: number | null,
    fileType?: string,
    search?: string,
    page = 1,
    perPage = 24,
  ) =>
    ["files", "all", fileType ?? "all", search ?? "", page, perPage] as const,
  filesAll: () => ["files"] as const,
  file: (id: number) => ["file", id] as const,
  continue: (limit: number) => ["continue-watching", limit] as const,
  continueAll: () => ["continue-watching"] as const,
  recent: (limit: number) => ["recent", limit] as const,
  me: () => ["me"] as const,
  botInfo: () => ["bot/info"] as const,
  activeDevices: () => ["playback", "active"] as const,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
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

function normalisePage(data: unknown, page: number, perPage: number): FilesPage {
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

function normaliseRole(value: unknown): Role {
  const r = (value as { role?: unknown } | null)?.role;
  return r === "admin" || r === "guest" ? r : "unknown";
}

function normaliseUser(data: unknown): User | null {
  const d = (data ?? {}) as { user?: User } & User;
  const src = (d.user ?? d) as User;
  const role = normaliseRole(src);
  if (role === "unknown") return null;
  return { ...src, role };
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
  return asArray<ActiveDevice>(data, "active").filter(
    (d) => !!d && typeof d.device_id === "string",
  );
}

/* ═══════════════════════════════ Auth API ═══════════════════════════════ */

function authFailure(e: unknown): AuthResult {
  if (errorStatus(e) === 429) {
    return { error: "RATE_LIMITED", retry_after_seconds: retryAfterSeconds(e) };
  }
  return {
    error: errorStatus(e) ? "AUTH_FAILED" : "NETWORK",
    message: errorMessage(e, "Could not sign in. Check the code and try again."),
  };
}

async function loginRequest(
  path: string,
  body: Record<string, string>,
): Promise<AuthResult> {
  try {
    const { data } = await api.post<AuthSuccess>(path, body);
    if (!isAuthSuccess(data)) {
      return { error: "AUTH_FAILED", message: "The server did not return a session." };
    }
    setTokens(data);
    emit(AUTH_CHANGED_EVENT, { authenticated: true });
    return data;
  } catch (e) {
    return authFailure(e);
  }
}

/** Family sign-in: POST /auth/verify-code with an 8-digit code. */
export function loginWithCode(code: string): Promise<AuthResult> {
  return loginRequest("/auth/verify-code", { code: code.trim() });
}

/** Guest sign-in: POST /auth/guest/login with a 6-digit PIN. */
export function loginWithPin(pin: string): Promise<AuthResult> {
  return loginRequest("/auth/guest/login", { pin: pin.trim() });
}

export const login = loginWithCode;
export const guestLogin = loginWithPin;

/**
 * GET /auth/me — FAIL CLOSED.
 * A 401, timeout, network error or an unrecognised role returns null.
 * It must never be possible for a failed lookup to grant admin.
 */
export async function fetchMe(): Promise<User | null> {
  try {
    const { data } = await api.get("/auth/me");
    return normaliseUser(data);
  } catch {
    return null;
  }
}

export async function fetchBotInfo(): Promise<BotInfo> {
  try {
    const { data } = await api.get("/auth/bot/info");
    return normaliseBotInfo(data);
  } catch {
    return { bot_username: "", bot_link: "" };
  }
}

/**
 * Sign out THIS device only.
 * Hits /auth/logout (never /auth/logout-all), stops this screen's playback slot,
 * and clears every auth artifact locally. The stable device id is intentionally
 * kept so this physical screen keeps the same identity on the next sign-in.
 * Returns void; the caller decides where to navigate.
 */
export async function logout(): Promise<void> {
  try {
    await api.post("/auth/logout", {});
  } catch {
    /* best effort: local sign-out must still happen */
  }
  stopPlaybackBeacon();
  clearTokens();
  emit(AUTH_CHANGED_EVENT, { authenticated: false });
}

/* ═══════════════════════════════ Playback ═══════════════════════════════ */

/** Signed per-file/per-device stream URL. Never contains a login JWT. */
export function streamFile(fileId: number, token: string): string {
  return `${API_ORIGIN || ""}/api/stream/${fileId}?t=${encodeURIComponent(token)}`;
}

function tokenFromStreamUrl(url?: string): string {
  if (!url) return "";
  const m = /[?&]t=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : "";
}

/**
 * POST /playback/start.
 * Success → signed stream token; 409 → typed DEVICE_LIMIT for the popup.
 */
export async function startPlayback(
  fileId: number,
  label?: string,
): Promise<PlaybackStartResult> {
  const deviceId = getDeviceId();
  try {
    const { data } = await api.post<{
      stream_url?: string;
      token?: string;
      heartbeat_seconds?: number;
      expires_in?: number;
    }>("/playback/start", {
      file_id: fileId,
      device_id: deviceId,
      device_label: label || getDeviceLabel(),
    });

    const token = data.token || tokenFromStreamUrl(data.stream_url);
    return {
      token,
      device_id: deviceId,
      stream_url: resolveBackendPath(data.stream_url),
      heartbeat_seconds: Math.min(
        60,
        Math.max(5, Number(data.heartbeat_seconds) || 20),
      ),
      expires_in: data.expires_in,
    };
  } catch (e) {
    if (isDeviceLimitError(e)) {
      const d = errorDetail(e) as {
        message?: string;
        active?: ActiveDevice[];
      };
      return {
        error: "DEVICE_LIMIT",
        message:
          d?.message ||
          "Two screens are already playing. Stop one to start here.",
        active: Array.isArray(d?.active) ? d.active : [],
      };
    }
    throw e;
  }
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

/* ═══════════════════════════════ Flat library ═══════════════════════════════ */

export interface FilesQuery {
  page?: number;
  perPage?: number;
}

export async function fetchFiles(q: FilesQuery = {}): Promise<FilesPage> {
  const page = q.page ?? 1;
  const perPage = q.perPage ?? 24;
  const { data } = await api.get("/files", {
    params: { page, per_page: perPage },
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
  const { data } = await api.get("/files/continue-watching", {
    params: { limit },
  });
  return { files: asArray<TelegramFile>(data, "files") };
}

export async function deleteFile(id: number): Promise<void> {
  await api.delete(`/files/${id}`);
}

export async function deleteFiles(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await api.post("/files/batch-delete", ids);
}

/** POST /files/{id}/progress — the server owns the 95% completed rule. */
export async function postProgress(p: ProgressPayload): Promise<ProgressResult> {
  const body = {
    position: Math.max(0, Math.floor(p.position)),
    duration: Math.max(0, Math.floor(p.duration ?? 0)),
  };
  const { data } = await api.post<ProgressResult>(
    `/files/${p.fileId}/progress`,
    body,
  );
  return {
    position: Number(data?.position) || body.position,
    duration: Number(data?.duration) || body.duration,
    completed: !!data?.completed,
  };
}

/* ═══════════════════════════════ Thumbnails ═══════════════════════════════ */

const THUMB_LIMIT = 128;
const thumbCache = new Map<number, string>();
const thumbPending = new Map<number, Promise<string | null>>();

function rememberThumb(id: number, url: string) {
  const existing = thumbCache.get(id);
  if (existing) URL.revokeObjectURL(existing);
  thumbCache.set(id, url);
  while (thumbCache.size > THUMB_LIMIT) {
    const oldest = thumbCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    const dead = thumbCache.get(oldest);
    if (dead) URL.revokeObjectURL(dead);
    thumbCache.delete(oldest);
  }
}

export const cachedThumbnail = (id: number): string | null =>
  thumbCache.get(id) ?? null;

export function revokeThumbnail(id: number): void {
  const url = thumbCache.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbCache.delete(id);
}

/** Revoke every blob URL. Safe to call on unmount / page teardown. */
export function clearThumbnailCache(): void {
  for (const url of thumbCache.values()) URL.revokeObjectURL(url);
  thumbCache.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", clearThumbnailCache);
  window.addEventListener("beforeunload", clearThumbnailCache);
}

/** Authorised thumbnail as a blob URL. Tokens never enter <img src>. */
export async function getThumbnailUrl(fileId: number): Promise<string | null> {
  const hit = thumbCache.get(fileId);
  if (hit) return hit;
  const pending = thumbPending.get(fileId);
  if (pending) return pending;

  const job = api
    .get(`/files/${fileId}/thumbnail`, {
      responseType: "blob",
      timeout: 20000,
    })
    .then(({ data }) => {
      const url = URL.createObjectURL(data as Blob);
      rememberThumb(fileId, url);
      return url;
    })
    .catch(() => null)
    .finally(() => {
      thumbPending.delete(fileId);
    });

  thumbPending.set(fileId, job);
  return job;
}

export function useThumbnail(
  fileId?: number | null,
  enabled = true,
): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    fileId != null ? cachedThumbnail(fileId) : null,
  );

  useEffect(() => {
    if (fileId == null || !enabled) {
      setUrl(null);
      return;
    }
    const hit = cachedThumbnail(fileId);
    if (hit) {
      setUrl(hit);
      return;
    }
    let live = true;
    void getThumbnailUrl(fileId).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [fileId, enabled]);

  return url;
}

/* ═══════════════════════════════ React Query hooks ═══════════════════════════════ */

type AnyMutation = UseMutationResult<unknown, unknown, unknown, unknown>;

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

/** Flat library, newest first. `_folderId` is accepted only for call-site compatibility. */
export function useFiles(
  _folderId: number | null = null,
  fileType?: string,
  search?: string,
  page = 1,
  perPage = 24,
  enabled = true,
): UseQueryResult<FilesPage> {
  return useQuery({
    queryKey: qk.files(null, fileType, search, page, perPage),
    queryFn: () => fetchFiles({ page, perPage }),
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

export type MeQueryResult = UseQueryResult<User | null> & {
  me: User | null;
  user: User | null;
  role: Role;
};

/**
 * FAIL-CLOSED session lookup.
 * While loading, on a 401, on a network failure or on an unknown role the
 * result is null and the role is "unknown" — never "admin".
 */
export function useMe(): MeQueryResult {
  const q = useQuery({
    queryKey: qk.me(),
    queryFn: fetchMe,
    staleTime: 5 * 60_000,
    retry: false,
    enabled: isAuthenticated(),
  });
  const user = q.data ?? null;
  const role: Role =
    user?.role === "admin" ? "admin" : user?.role === "guest" ? "guest" : "unknown";
  return Object.assign({}, q, { me: user, user, role }) as MeQueryResult;
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

/* ── Progress: patch caches in place so playback never triggers a refetch storm ── */

function patchProgressCaches(
  qc: ReturnType<typeof useQueryClient>,
  p: ProgressPayload,
) {
  const dur = p.duration && p.duration > 0 ? p.duration : undefined;
  const patch = (f: TelegramFile): TelegramFile => ({
    ...f,
    last_pos: p.position,
    ...(dur ? { duration: dur } : {}),
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
  return useCompatMutation<ProgressResult, ProgressPayload>({
    mutationFn: postProgress,
    onMutate: async (payload) => {
      patchProgressCaches(qc, payload);
    },
    onError: () => {
      /* Progress is best-effort: never interrupt playback. */
    },
  });
}

/* ── Playback hooks ──────────────────────────────────────────────────────── */

export function usePlaybackStart() {
  return useCompatMutation<PlaybackStartResult, number>({
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

export default api;
