"""
backend/app/ratelimit.py — login brute-force protection (device + IP).

Why this exists
---------------
SlowAPI throttled by IP only. Behind Caddy every request can appear to come
from the proxy, and a household shares one public IP, so IP-only limiting
either locks out the whole family or lets an attacker rotate identities.

This module enforces TWO independent sliding windows per login scope:

  * per DEVICE  (X-Device-Id header, sent by web/src/lib/api.ts)
        -> settings.login_attempt_limit           (default 5 / hour)
  * per IP      (real client IP, proxy-aware)
        -> max(device_limit * 4, 20)              (default 20 / hour)

The device window gives the user their "5 codes per hour" rule.
The IP window stops an attacker who simply invents a new device id per request.

Success resets the bucket
-------------------------
A successful login clears the device+IP buckets for that scope. Normal family
usage therefore never locks itself out; only repeated FAILURES burn attempts.

Scopes are separate
-------------------
`family` (8-digit code) and `guest` (6-digit PIN) have independent buckets, so a
guest fumbling their PIN cannot lock the owner out of their own TV.

Constraints
-----------
State is process-local and intentional: run uvicorn with --workers 1.
All functions are synchronous, so they are atomic inside the asyncio event loop.
Memory is bounded (MAX_TRACKED_KEYS) so a flood cannot exhaust a 512 MB VPS.
"""

from __future__ import annotations

import ipaddress
import math
import re
import time
from collections import OrderedDict, deque
from dataclasses import dataclass

from fastapi import HTTPException, Request

from .config import get_settings

settings = get_settings()

__all__ = [
    "SCOPE_FAMILY",
    "SCOPE_GUEST",
    "RateLimitDecision",
    "consume",
    "enforce",
    "reset",
    "reset_all",
    "humanize_retry",
    "stats",
]

# Login scopes — kept separate so guest mistakes never lock out the owner.
SCOPE_FAMILY = "family"
SCOPE_GUEST = "guest"

# A device id must look like the UUID/random string the web client generates.
_DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

# Hard memory ceiling: oldest buckets are evicted beyond this many keys.
MAX_TRACKED_KEYS = 5000
_SWEEP_EVERY = 256

# key -> timestamps of attempts inside the current window (oldest first)
_buckets: OrderedDict[str, deque[float]] = OrderedDict()
_ops_since_sweep = 0


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _now() -> float:
    """Monotonic clock: immune to system time changes / NTP jumps."""
    return time.monotonic()


def _window() -> int:
    return int(settings.login_attempt_window_seconds)


def _device_limit() -> int:
    return int(settings.login_attempt_limit)


def _ip_limit() -> int:
    """A household behind one NAT IP may have several devices."""
    return max(_device_limit() * 4, 20)


def _is_trusted_proxy(host: str) -> bool:
    """Only trust forwarded headers when the peer is loopback/private (Caddy)."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def client_ip(request: Request) -> str:
    """
    Real client IP.

    Uvicorn (--proxy-headers) usually already resolves this. We additionally
    honour X-Forwarded-For / X-Real-IP ONLY when the immediate peer is a trusted
    local proxy, so a public client cannot spoof its own IP.
    """
    peer = request.client.host if getattr(request, "client", None) else ""
    peer = peer or "unknown"

    if _is_trusted_proxy(peer):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
        xreal = request.headers.get("x-real-ip")
        if xreal and xreal.strip():
            return xreal.strip()

    return peer


def device_id(request: Request) -> str | None:
    """Validated X-Device-Id, or None when absent/malformed."""
    raw = (request.headers.get("x-device-id") or "").strip()
    return raw if _DEVICE_RE.match(raw) else None


def humanize_retry(seconds: int) -> str:
    """'1 hour', '59 minutes', '45 seconds' — used in the user-facing message."""
    seconds = max(1, int(seconds))
    if seconds >= 3600:
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        out = f"{hours} hour{'s' if hours != 1 else ''}"
        if minutes:
            out += f" {minutes} minute{'s' if minutes != 1 else ''}"
        return out
    if seconds >= 60:
        minutes = math.ceil(seconds / 60)
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    return f"{seconds} second{'s' if seconds != 1 else ''}"


# ─────────────────────────────────────────────────────────────────────────────
# Bucket mechanics
# ─────────────────────────────────────────────────────────────────────────────

def _prune(key: str, window: int) -> None:
    """Drop attempts that slid out of the window; delete the key when empty."""
    dq = _buckets.get(key)
    if not dq:
        return
    cutoff = _now() - window
    while dq and dq[0] <= cutoff:
        dq.popleft()
    if not dq:
        _buckets.pop(key, None)


def _sweep() -> None:
    """Periodic cleanup + LRU eviction so memory stays bounded."""
    global _ops_since_sweep
    _ops_since_sweep = 0
    window = _window()
    for key in list(_buckets.keys()):
        _prune(key, window)
    while len(_buckets) > MAX_TRACKED_KEYS:
        _buckets.popitem(last=False)


def _maybe_sweep() -> None:
    global _ops_since_sweep
    _ops_since_sweep += 1
    if _ops_since_sweep >= _SWEEP_EVERY or len(_buckets) > MAX_TRACKED_KEYS:
        _sweep()


def _record(key: str) -> None:
    dq = _buckets.get(key)
    if dq is None:
        dq = deque()
        _buckets[key] = dq
    dq.append(_now())
    _buckets.move_to_end(key)


def _retry_after(key: str, limit: int, window: int) -> int:
    """Seconds until the OLDEST attempt leaves the window (0 if not blocked)."""
    dq = _buckets.get(key)
    if not dq or len(dq) < limit:
        return 0
    return max(1, math.ceil(window - (_now() - dq[0])))


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    remaining: int              # attempts left in the tightest bucket
    retry_after_seconds: int    # 0 when allowed
    scope: str


def _keys(scope: str, request: Request) -> list[tuple[str, int]]:
    window = _window()
    keys: list[tuple[str, int]] = []
    dev = device_id(request)
    if dev:
        keys.append((f"{scope}|d:{dev}", _device_limit()))
    # IP bucket always applies — even when the device header is missing/spoofed.
    keys.append((f"{scope}|ip:{client_ip(request)}", _ip_limit()))
    for key, _ in keys:
        _prune(key, window)
    return keys


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def consume(scope: str, request: Request) -> RateLimitDecision:
    """
    Register one login attempt and report whether it is permitted.

    Call this BEFORE validating the code/PIN. On a successful login call
    `reset(scope, request)` so honest users are never locked out.
    """
    _maybe_sweep()
    window = _window()
    keys = _keys(scope, request)

    blocked_for = 0
    for key, limit in keys:
        blocked_for = max(blocked_for, _retry_after(key, limit, window))

    if blocked_for:
        return RateLimitDecision(False, 0, blocked_for, scope)

    for key, _ in keys:
        _record(key)

    remaining = min(
        max(0, limit - len(_buckets.get(key, ())))
        for key, limit in keys
    )
    return RateLimitDecision(True, remaining, 0, scope)


def enforce(scope: str, request: Request) -> RateLimitDecision:
    """
    Same as `consume`, but raises HTTP 429 with a Retry-After header and a
    structured detail the web client can render directly.
    """
    decision = consume(scope, request)
    if not decision.allowed:
        wait = humanize_retry(decision.retry_after_seconds)
        raise HTTPException(
            status_code=429,
            detail={
                "code": "RATE_LIMITED",
                "message": f"Too many attempts. Please try again in {wait}.",
                "retry_after_seconds": decision.retry_after_seconds,
            },
            headers={"Retry-After": str(decision.retry_after_seconds)},
        )
    return decision


def reset(scope: str, request: Request) -> None:
    """Clear this device+IP's buckets for a scope (call after a SUCCESS)."""
    dev = device_id(request)
    if dev:
        _buckets.pop(f"{scope}|d:{dev}", None)
    _buckets.pop(f"{scope}|ip:{client_ip(request)}", None)


def reset_all() -> None:
    """Test/maintenance helper: forget every bucket."""
    _buckets.clear()


def stats() -> dict[str, int]:
    """Non-sensitive counters for admin diagnostics."""
    return {
        "tracked_keys": len(_buckets),
        "device_limit": _device_limit(),
        "ip_limit": _ip_limit(),
        "window_seconds": _window(),
    }