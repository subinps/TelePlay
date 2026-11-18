import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Delete,
  Loader2,
  RefreshCw,
  Shield,
  Users,
} from "lucide-react";
import {
  AUTH_CHANGED_EVENT,
  AUTH_EXPIRED_EVENT,
  api,
  errorMessage,
  fetchMe,
  getAccessToken,
  isAuthSuccess,
  loginWithCode,
  loginWithPin,
  deleteFiles,
} from "./lib/api";
import type { AuthResult, Role, User } from "./lib/api";
import { useAppStore, useRole, useUser } from "./lib/store";
import FileBrowser from "./components/FileBrowser";
import MediaPlayer from "./components/MediaPlayer";
import GlobalContextMenu from "./components/GlobalContextMenu";
import DeleteConfirmModal from "./components/DeleteConfirmModal";

type BootState = "loading" | "login" | "ready" | "error";
type LoginMode = "family" | "guest";

const CODE_LENGTH: Record<LoginMode, number> = { family: 8, guest: 6 };

function humanizeRetry(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds));
  if (total < 60) return `${total} ${total === 1 ? "second" : "seconds"}`;
  if (total < 3600) {
    const minutes = Math.ceil(total / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.ceil((total % 3600) / 60);
  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return minutes
    ? `${hourText} ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
    : hourText;
}

function roleFromResponse(data: unknown): Role {
  const value = data as { role?: unknown; user?: { role?: unknown } } | null;
  const role = value?.user?.role ?? value?.role;
  return role === "admin" || role === "guest" ? role : "unknown";
}

function clearCodeFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  window.history.replaceState(
    window.history.state,
    document.title,
    `${url.pathname}${url.search}${url.hash}`,
  );
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Hearth crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#070b0b] p-6 text-[#e8f1ef]">
        <section className="max-w-md rounded-2xl border border-[#1a2524] bg-[#0e1514] p-6">
          <AlertTriangle className="mb-4 h-8 w-8 text-amber-400" />
          <h1 className="text-xl font-bold">This screen hit a problem</h1>
          <p className="mt-2 text-sm text-[#9db6b1]">
            Your library is safe. Reload Hearth to try again.
          </p>
          <button
            className="mt-5 rounded-xl bg-[#2dd4bf] px-5 py-3 font-bold text-[#04110f]"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </section>
      </main>
    );
  }
}

function LoginScreen({
  onSignedIn,
  initialError,
  initialCooldownSeconds = 0,
}: {
  onSignedIn: () => Promise<void>;
  initialError: string | null;
  initialCooldownSeconds?: number;
}) {
  const [mode, setMode] = useState<LoginMode>("family");
  const [digits, setDigits] = useState("");
  const [message, setMessage] = useState<string | null>(initialError);
  const [cooldownUntil, setCooldownUntil] = useState(() =>
    initialCooldownSeconds > 0
      ? Date.now() + initialCooldownSeconds * 1000
      : 0,
  );
  const [now, setNow] = useState(Date.now());
  const keys = useRef<(HTMLButtonElement | null)[]>([]);
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digitsRef = useRef(digits);
  const busyRef = useRef(false);
  const queryClient = useQueryClient();
  const loginMutation = useMutation<AuthResult, Error, { mode: LoginMode; value: string }>({
    mutationFn: ({ mode: selectedMode, value }) =>
      selectedMode === "family" ? loginWithCode(value) : loginWithPin(value),
    retry: false,
  });
  const length = CODE_LENGTH[mode];
  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const busy = loginMutation.isPending;
  digitsRef.current = digits;

  const submit = useCallback(
    async (value: string) => {
      if (busyRef.current || cooldownUntil > Date.now()) return;
      if (value.length !== CODE_LENGTH[mode]) {
        setMessage(`Enter all ${CODE_LENGTH[mode]} digits to continue.`);
        return;
      }

      busyRef.current = true;
      setMessage(null);
      try {
        const result = await loginMutation.mutateAsync({ mode, value });
        if (!isAuthSuccess(result)) {
          if (result.error === "RATE_LIMITED") {
            const seconds = Math.max(1, Math.ceil(result.retry_after_seconds));
            setCooldownUntil(Date.now() + seconds * 1000);
            setMessage(
              `Too many attempts. Try again in ${humanizeRetry(seconds)}.`,
            );
            setDigits("");
            return;
          }
          const crossMode =
            mode === "family"
              ? "That code is invalid or expired. A 6-digit PIN is for Guest login."
              : "That PIN is invalid or expired. An 8-digit code is for Family login.";
          setMessage(result.error === "AUTH_FAILED" ? crossMode : result.message);
          setDigits("");
          requestAnimationFrame(() => keys.current[0]?.focus());
          return;
        }

        await onSignedIn();
        await queryClient.invalidateQueries();
      } catch (error) {
        setMessage(errorMessage(error, "Sign-in failed. Please try again."));
        setDigits("");
        requestAnimationFrame(() => keys.current[0]?.focus());
      } finally {
        busyRef.current = false;
      }
    },
    [cooldownUntil, loginMutation, mode, onSignedIn, queryClient],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const appendDigit = useCallback(
    (digit: string) => {
      if (busyRef.current || remaining > 0) return;
      setMessage(null);
      setDigits((current) => {
        if (current.length >= length) return current;
        const next = current + digit;
        if (next.length === length) {
          if (submitTimer.current) clearTimeout(submitTimer.current);
          submitTimer.current = setTimeout(() => {
            submitTimer.current = null;
            void submitRef.current(next);
          }, 0);
        }
        return next;
      });
    },
    [length, remaining],
  );

  const removeLastDigit = useCallback(() => {
    if (busyRef.current || remaining > 0) return;
    if (submitTimer.current) clearTimeout(submitTimer.current);
    setDigits((current) => current.slice(0, -1));
    setMessage(null);
  }, [remaining]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => keys.current[0]?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (submitTimer.current) clearTimeout(submitTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => {
    if (remaining === 0 && cooldownUntil) {
      setCooldownUntil(0);
      setMessage(null);
    }
  }, [cooldownUntil, remaining]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const activeIndex = keys.current.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        appendDigit(event.key);
        return;
      }
      if (event.key === "Backspace" || event.keyCode === 461 || event.keyCode === 10009) {
        event.preventDefault();
        removeLastDigit();
        return;
      }
      if (event.key === "Enter") {
        if (activeIndex >= 0) return;
        event.preventDefault();
        void submitRef.current(digitsRef.current);
        return;
      }
      const offsets: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -3,
        ArrowDown: 3,
      };
      const offset = offsets[event.key];
      if (offset !== undefined) {
        event.preventDefault();
        const next = activeIndex < 0 ? 0 : activeIndex + offset;
        if (next >= 0 && next < 12) keys.current[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appendDigit, removeLastDigit]);

  const switchMode = (nextMode: LoginMode) => {
    if (busy || remaining > 0) return;
    if (submitTimer.current) clearTimeout(submitTimer.current);
    setMode(nextMode);
    setDigits("");
    setMessage(null);
  };

  const keypad = [
    "1", "2", "3",
    "4", "5", "6",
    "7", "8", "9",
    "clear", "0", "back",
  ];
  const disabled = busy || remaining > 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#070b0b] px-4 py-8 text-[#e8f1ef]">
      <section className="w-full max-w-md rounded-2xl border border-[#1a2524] bg-[#0e1514] p-5 shadow-2xl sm:p-8">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-black tracking-tight">Hearth</h1>
          <p className="mt-2 text-sm text-[#9db6b1]">
            Your family’s films, on every screen
          </p>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-[#141d1c] p-1.5">
          {(["family", "guest"] as const).map((loginMode) => {
            const selected = mode === loginMode;
            const Icon = loginMode === "family" ? Users : Shield;
            return (
              <button
                key={loginMode}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => switchMode(loginMode)}
                className={`flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5eead4] ${
                  selected ? "bg-[#2dd4bf] text-[#04110f]" : "text-[#9db6b1]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {loginMode === "family" ? "Family" : "Guest"}
              </button>
            );
          })}
        </div>

        <h2 className="mb-4 text-center text-lg font-semibold">
          {mode === "family"
            ? "Enter 8-digit Family code"
            : "Enter 6-digit Guest PIN"}
        </h2>
        <div
          className="mb-5 flex justify-center gap-2"
          role="status"
          aria-label={`${digits.length} of ${length} digits entered`}
        >
          {Array.from({ length }).map((_, index) => (
            <span
              key={index}
              className={`flex h-12 min-w-0 flex-1 items-center justify-center rounded-lg border font-mono text-2xl ${
                index < digits.length
                  ? "border-[#2dd4bf]/60 bg-[#2dd4bf]/10 text-[#5eead4]"
                  : "border-[#1a2524] bg-[#141d1c] text-[#526763]"
              }`}
            >
              {index < digits.length ? "•" : "·"}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2" aria-label="Numeric keypad">
          {keypad.map((key, index) => (
            <button
              key={key}
              ref={(node) => { keys.current[index] = node; }}
              type="button"
              disabled={disabled}
              aria-label={key === "clear" ? "Clear code" : key === "back" ? "Delete last digit" : key}
              onClick={() => {
                if (key === "clear") {
                  if (submitTimer.current) clearTimeout(submitTimer.current);
                  setDigits("");
                  setMessage(null);
                }
                else if (key === "back") removeLastDigit();
                else appendDigit(key);
              }}
              className="flex h-14 items-center justify-center rounded-xl border border-[#263431] bg-[#141d1c] text-xl font-bold hover:border-[#2dd4bf]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5eead4] disabled:opacity-40"
            >
              {key === "clear" ? <ArrowLeft className="h-5 w-5" /> : key === "back" ? <Delete className="h-5 w-5" /> : key}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={disabled || digits.length !== length}
          onClick={() => void submit(digits)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 font-bold text-[#04110f] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {(message || remaining > 0) && (
          <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-center text-sm text-rose-200" role="alert">
            {remaining > 0
              ? `Too many attempts. Try again in ${humanizeRetry(remaining)}.`
              : message}
          </p>
        )}
        {remaining > 0 && (
          <p className="mt-2 text-center text-xs text-[#9db6b1]">
            Keypad disabled until the server cooldown expires.
          </p>
        )}
      </section>
    </main>
  );
}

function HearthApp() {
  const queryClient = useQueryClient();
  const role = useRole();
  const user = useUser();
  const {
    setUser,
    setRole,
    clearAuth,
    addToast,
    deleteConfirm,
    closeDeleteConfirm,
  } = useAppStore();
  const [boot, setBoot] = useState<BootState>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginCooldown, setLoginCooldown] = useState(0);
  const deepLinkLogin = useMutation<AuthResult, Error, string>({
    mutationFn: loginWithCode,
    retry: false,
  });
  const { mutateAsync: mutateDeepLink } = deepLinkLogin;
  const deleteFilesMutation = useMutation({
    mutationFn: (ids: number[]) => deleteFiles(ids),
  });
  const [deleting, setDeleting] = useState(false);

  const hydrateAfterLogin = useCallback(async () => {
    const me = await fetchMe();
    if (!me || (me.role !== "admin" && me.role !== "guest")) {
      clearAuth();
      throw new Error("Could not verify your account. Please sign in again.");
    }
    setUser(me);
    setRole(me.role);
    setLoginError(null);
    setBootError(null);
    setBoot("ready");
  }, [clearAuth, setRole, setUser]);

  const checkSession = useCallback(async () => {
    setBoot("loading");
    setBootError(null);
    if (!getAccessToken()) {
      clearAuth();
      setBoot("login");
      return;
    }
    try {
      const { data } = await api.get("/auth/me");
      const actualRole = roleFromResponse(data);
      if (actualRole === "unknown") {
        clearAuth();
        setBoot("login");
        return;
      }
      const source = data as { user?: User } & User;
      const identity = source.user ?? source;
      if (!identity) {
        clearAuth();
        setBoot("login");
        return;
      }
      setUser({ ...identity, role: actualRole });
      setRole(actualRole);
      setBoot("ready");
    } catch (error) {
      if ((error as { response?: { status?: number } })?.response?.status === 401) {
        clearAuth();
        setBoot("login");
      } else {
        setBootError(errorMessage(error, "Could not reach the server."));
        setBoot("error");
      }
    }
  }, [clearAuth, setRole, setUser]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code === null) {
      void checkSession();
      return;
    }

    clearCodeFromUrl();
    setBoot("loading");
    void mutateDeepLink(code)
      .then(async (result) => {
        if (!isAuthSuccess(result)) {
          if (result.error === "RATE_LIMITED") {
            setLoginCooldown(Math.max(1, Math.ceil(result.retry_after_seconds)));
            setLoginError(
              `Too many attempts. Try again in ${humanizeRetry(result.retry_after_seconds)}.`,
            );
          } else {
            setLoginError("Code expired. Please request a new one from the bot.");
          }
          setBoot("login");
          return;
        }
        try {
          await hydrateAfterLogin();
          await queryClient.invalidateQueries();
        } catch (error) {
          setLoginError(errorMessage(error, "Could not verify your session."));
          setBoot("login");
        }
      })
      .catch(() => {
        clearAuth();
        setLoginError("Code expired. Please request a new one from the bot.");
        setBoot("login");
      });
  }, [checkSession, clearAuth, mutateDeepLink, hydrateAfterLogin, queryClient]);

  useEffect(() => {
    const onAuthExpired = () => {
      clearAuth();
      setBoot("login");
      setLoginError(null);
    };
    const onAuthChanged = (event: Event) => {
      const authenticated = (
        event as CustomEvent<{ authenticated?: boolean }>
      ).detail?.authenticated;
      if (!authenticated) {
        setBoot("login");
        setLoginError(null);
      }
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
      window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    };
  }, [clearAuth]);

  const confirmFile = deleteConfirm.file;
  const deleteSelected = useCallback(async () => {
    if (!confirmFile || deleting) return;
    setDeleting(true);
    try {
      await deleteFilesMutation.mutateAsync([confirmFile.id]);
      await queryClient.invalidateQueries();
      window.dispatchEvent(
        new CustomEvent("hearth:file-deleted", {
          detail: { fileId: confirmFile.id },
        }),
      );
      addToast("Deleted — removed from Telegram too", "success");
      closeDeleteConfirm();
    } finally {
      setDeleting(false);
    }
  }, [addToast, closeDeleteConfirm, confirmFile, deleteFilesMutation, deleting, queryClient]);

  if (boot === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#070b0b] text-[#9db6b1]">
        <Loader2 className="mr-3 h-6 w-6 animate-spin text-[#2dd4bf]" />
        Checking your Hearth session…
      </main>
    );
  }
  if (boot === "error") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#070b0b] p-6 text-center text-[#e8f1ef]">
        <AlertTriangle className="h-9 w-9 text-amber-400" />
        <h1 className="text-2xl font-bold">Hearth could not connect</h1>
        <p className="max-w-md text-[#9db6b1]">{bootError}</p>
        <button
          type="button"
          onClick={() => void checkSession()}
          className="flex items-center gap-2 rounded-xl bg-[#2dd4bf] px-5 py-3 font-bold text-[#04110f]"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      </main>
    );
  }
  if (boot === "login") {
    return (
      <LoginScreen
        initialError={loginError}
        initialCooldownSeconds={loginCooldown}
        onSignedIn={hydrateAfterLogin}
      />
    );
  }

  return (
    <div data-hearth-app data-role={role} className="relative min-h-screen bg-[#070b0b] text-[#e8f1ef]">
      <FileBrowser />
      <MediaPlayer />
      <GlobalContextMenu />
      {deleteConfirm.isOpen && confirmFile && (
        <DeleteConfirmModal
          type="file"
          name={confirmFile.file_name}
          count={1}
          busy={deleting}
          onConfirm={deleteSelected}
          onClose={closeDeleteConfirm}
        />
      )}
      <div className="sr-only" aria-live="polite">
        {user?.first_name ? `Signed in as ${user.first_name}` : ""}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <HearthApp />
    </ErrorBoundary>
  );
}
