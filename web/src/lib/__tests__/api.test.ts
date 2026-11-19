// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_KEY,
  REFRESH_KEY,
  api,
  errorMessage,
  fetchMe,
  loginWithCode,
  logout,
  startPlayback,
  streamFile,
} from "../api";

const DEVICE_KEY = "hearth_device_id";

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

describe("api contracts (T8)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("logout clears auth tokens and keeps the stable device id", async () => {
    localStorage.setItem(ACCESS_KEY, "access-token-value");
    localStorage.setItem(REFRESH_KEY, "refresh-token-value");
    localStorage.setItem(DEVICE_KEY, "device-12345678");
    vi.spyOn(api, "post").mockResolvedValue({ data: null } as never);

    await logout();

    expect(localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    // A screen keeps its identity so the 2-stream limit stays honest.
    expect(localStorage.getItem(DEVICE_KEY)).toBe("device-12345678");
    expect(api.post).toHaveBeenCalledWith("/auth/logout", {});
  });

  it("fetchMe returns null on 401 and never coerces to admin", async () => {
    vi.spyOn(api, "get").mockRejectedValue({
      response: { status: 401, data: { detail: "Not authenticated" } },
    });

    await expect(fetchMe()).resolves.toBeNull();
  });

  it("fetchMe returns null for an unrecognised role", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: { id: 1, role: "superuser" },
    } as never);

    await expect(fetchMe()).resolves.toBeNull();
  });

  it("maps SERVICE_UNAVAILABLE responses to database wake-up guidance", () => {
    const guidance =
      "Server is waking up or temporarily down. Please try again in about 30 seconds.";

    expect(
      errorMessage({
        response: {
          status: 503,
          data: { code: "SERVICE_UNAVAILABLE", message: "Unavailable" },
        },
      }),
    ).toBe(guidance);
    expect(
      errorMessage({
        response: {
          status: 500,
          data: { detail: { code: "SERVICE_UNAVAILABLE" } },
        },
      }),
    ).toBe(guidance);
  });

  it("parses retry_after_seconds from a 429 login response", async () => {
    vi.spyOn(api, "post").mockRejectedValue({
      response: {
        status: 429,
        data: {
          detail: {
            code: "RATE_LIMITED",
            message: "Too many attempts.",
            retry_after_seconds: 120,
          },
        },
      },
    });

    await expect(loginWithCode("12345678")).resolves.toEqual({
      error: "RATE_LIMITED",
      retry_after_seconds: 120,
    });
  });

  it("parses the DEVICE_LIMIT message from a 409 playback start", async () => {
    localStorage.setItem(DEVICE_KEY, "device-12345678");
    vi.spyOn(api, "post").mockRejectedValue({
      response: {
        status: 409,
        data: {
          detail: {
            code: "DEVICE_LIMIT",
            message: "Maximum concurrent playback devices reached",
            active: [
              { device_id: "tv-1", label: "Samsung TV", file_id: 3, role: "admin" },
            ],
          },
        },
      },
    });

    const result = await startPlayback(3);

    expect(result).toMatchObject({
      error: "DEVICE_LIMIT",
      message: "Maximum concurrent playback devices reached",
    });
    expect("active" in result && result.active).toHaveLength(1);
  });

  it("builds a signed per-file stream URL with the token encoded", () => {
    expect(streamFile(42, "signed token/+")).toContain(
      "/api/stream/42?t=signed%20token%2F%2B",
    );
  });
});
