"""
backend/app/playback.py — concurrent-playback limiter with ownership + revocation.

What this enforces
------------------
1. CONCURRENCY: at most `settings.max_playback_devices` distinct devices play at
   once. A device is a stable client-generated id (localStorage UUID), so a
   refresh, a new tab or the next episode never consumes a second slot.

2. OWNERSHIP: every session records the owning User.id. Heartbeat/stop can be
   scoped to the caller so one account cannot manipulate another's device.

3. REVOCATION: `kick()` sets a per-device wall-clock floor. A signed stream
   token whose `iat` predates that floor is refused, so a kicked device cannot
   re-register with its still-cryptographically-valid 12-hour URL. A NEW
   authenticated `/playback/start` (reactivate=True) is always allowed and
   mints a token with a newer `iat` — kicking frees a slot, it does not ban the
   hardware forever.

Three distinct lifecycle events (do not conflate them)
------------------------------------------------------
  stop()      normal end of playback / logout  -> slot freed, device may return
  TTL expiry  device went silent               -> slot freed, silent re-register
  kick()      deliberate admin revocation      -> slot freed + old tokens dead

Entry points
------------
  start(..., reactivate=True)   authenticated POST /playback/start (chat #7)
  start(..., issued_at=iat)     media path re-register from a signed token (#8)
  start(...)                    neither -> conservative: honours any revocation

Process model
-------------
State is in-process by design (Telegram clients, byte cache and login limiter
are too). Run uvicorn with --workers 1. A restart clears sessions, which is
safe: it frees slots, and revocation floors are re-established by the durable
guest-credential version and by re-issuing tokens. Memory is bounded.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from .config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

__all__ = ["PlaybackSession", "PlaybackLimiter", "limiter"]

# Wall-clock revocation floors older than the longest possible stream-token
# lifetime are useless (every such token has expired) and are pruned.
_REVOCATION_KEEP_SECONDS = max(1, int(settings.stream_token_hours)) * 3600 + 3600
_MAX_REVOCATION_ENTRIES = 1000


@dataclass
class PlaybackSession:
    device_id: str
    label: str
    role: str                       # "admin" | "guest"
    file_id: int
    owner_id: Optional[int] = None  # User.id of the account that started it
    last_seen: float = field(default_factory=time.monotonic)
    started_at: float = field(default_factory=time.monotonic)
    # Wall-clock token generation accepted when this session was created.
    # Compared against per-device revocation floors on heartbeat so a fresh
    # post-kick session is never killed by the floor it was born under.
    issued_at: float = 0.0


class PlaybackLimiter:
    """In-memory device slots + per-device token revocation floors."""

    def __init__(
        self,
        max_devices: int = 2,
        ttl: float = 75.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_devices = max(1, int(max_devices))
        self.ttl = max(1.0, float(ttl))
        self.clock = clock
        self._sessions: dict[str, PlaybackSession] = {}
        # device_id -> wall-clock instant; tokens issued before this are dead.
        self._revoked_before: dict[str, float] = {}

    # ── internal maintenance ────────────────────────────────────────────────

    def _purge(self) -> None:
        """Drop sessions that stopped heartbeating."""
        now = self.clock()
        for key in [k for k, s in self._sessions.items() if now - s.last_seen > self.ttl]:
            del self._sessions[key]

    def _prune_revocations(self) -> None:
        """Bound memory: forget floors whose tokens have all expired by now."""
        if not self._revoked_before:
            return
        cutoff = time.time() - _REVOCATION_KEEP_SECONDS
        for key in [k for k, v in self._revoked_before.items() if v < cutoff]:
            del self._revoked_before[key]
        while len(self._revoked_before) > _MAX_REVOCATION_ENTRIES:
            oldest = min(self._revoked_before, key=self._revoked_before.get)
            del self._revoked_before[oldest]

    # ── revocation ──────────────────────────────────────────────────────────

    def is_revoked(self, device_id: str, issued_at: float | None = None) -> bool:
        """
        True when this device's token is revoked.

        issued_at=None  -> conservative: any active floor counts as revoked.
        issued_at=<iat> -> revoked only if the token predates the floor.
        """
        self._prune_revocations()
        floor = self._revoked_before.get(device_id)
        if floor is None:
            return False
        if issued_at is None:
            return True
        try:
            return float(issued_at) < floor
        except (TypeError, ValueError):
            return True

    def kick(self, device_id: str) -> None:
        """Admin revocation: free the slot AND kill every already-issued token."""
        # Floor at INTEGER-second granularity on purpose: auth.py mints token
        # `iat` with int(time.time()). A float floor would falsely revoke a
        # token minted in the same second as the kick, breaking "kick then
        # immediately replay". Trade-off: a token minted in that same whole
        # second survives for at most the remainder of that second.
        self._revoked_before[device_id] = float(int(time.time()))
        self._sessions.pop(device_id, None)
        self._prune_revocations()
        logger.info("Playback device kicked and revoked: %s", device_id)

    def clear_revocation(self, device_id: str) -> None:
        """Admin escape hatch (rarely needed; a fresh start already works)."""
        self._revoked_before.pop(device_id, None)

    # ── queries ─────────────────────────────────────────────────────────────

    def active(self) -> list[PlaybackSession]:
        self._purge()
        return list(self._sessions.values())

    def active_for(self, owner_id: int | None) -> list[PlaybackSession]:
        """Sessions belonging to one account (used to scope /playback/active)."""
        return [s for s in self.active() if s.owner_id == owner_id]

    def get(self, device_id: str) -> PlaybackSession | None:
        self._purge()
        return self._sessions.get(device_id)

    def is_active(self, device_id: str) -> bool:
        self._purge()
        return device_id in self._sessions

    def owns(self, device_id: str, owner_id: int | None) -> bool:
        """True only when the session exists AND belongs to this account."""
        session = self.get(device_id)
        return session is not None and session.owner_id == owner_id

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(
        self,
        device_id: str,
        label: str,
        role: str,
        file_id: int,
        *,
        owner_id: int | None = None,
        issued_at: float | None = None,
        reactivate: bool = False,
    ) -> tuple[bool, list[PlaybackSession]]:
        """
        Acquire or refresh a slot. Returns (ok, active_sessions).

        reactivate=True  -> authenticated /playback/start; ignores the floor
                            (the caller proved identity with a bearer token).
        issued_at=<iat>  -> media path; refused if the token predates a kick.
        neither          -> conservative; refused while any floor exists.

        Re-starting the SAME device never consumes a second slot.
        """
        self._purge()

        if not reactivate and self.is_revoked(device_id, issued_at):
            logger.info("Refused revoked device %s", device_id)
            return False, list(self._sessions.values())

        if device_id not in self._sessions and len(self._sessions) >= self.max_devices:
            return False, list(self._sessions.values())

        # Accepted wall-clock token generation for this session. Never
        # downgrade an existing session's generation when re-starting.
        if reactivate:
            # Authenticated start: a NEW token is minted right after, whose
            # iat >= this integer-second generation.
            generation = float(int(time.time()))
        elif issued_at is not None:
            generation = float(issued_at)
        else:
            generation = float(int(time.time()))

        now = self.clock()
        existing = self._sessions.get(device_id)
        self._sessions[device_id] = PlaybackSession(
            device_id=device_id,
            label=(label or "Device")[:40],
            role="admin" if role == "admin" else "guest",
            file_id=int(file_id),
            owner_id=owner_id if owner_id is not None else (existing.owner_id if existing else None),
            last_seen=now,
            started_at=existing.started_at if existing else now,
            issued_at=(
                max(existing.issued_at, generation) if existing else generation
            ),
        )
        return True, list(self._sessions.values())

    def heartbeat(
        self,
        device_id: str,
        file_id: int | None = None,
        *,
        owner_id: int | None = None,
        issued_at: float | None = None,
    ) -> bool:
        """
        Keep a session alive. False => expired, kicked or not yours.

        owner_id=None keeps backwards compatibility with older callers; the
        playback router (chat #7) always passes it.

        issued_at: the token's wall-clock generation. Defaults to the
        generation accepted when this session started, so a session that was
        legitimately (re)created AFTER a kick is never killed by that kick's
        floor. T6 will pass the live stream token's iat here later.
        """
        self._purge()
        session = self._sessions.get(device_id)
        if session is None:
            return False
        if owner_id is not None and session.owner_id != owner_id:
            logger.warning("Heartbeat owner mismatch for device %s", device_id)
            return False
        effective = issued_at if issued_at is not None else session.issued_at
        if self.is_revoked(device_id, effective):
            self._sessions.pop(device_id, None)
            return False
        session.last_seen = self.clock()
        if file_id is not None:
            session.file_id = int(file_id)
        return True

    def stop(self, device_id: str, *, owner_id: int | None = None) -> bool:
        """
        Normal end of playback (player closed, logout, next file).

        Frees the slot WITHOUT revoking — the device may start again freely.
        Returns False when the session is not yours.
        """
        session = self._sessions.get(device_id)
        if session is None:
            return True
        if owner_id is not None and session.owner_id != owner_id:
            logger.warning("Stop owner mismatch for device %s", device_id)
            return False
        self._sessions.pop(device_id, None)
        return True

    def stop_role(self, role: str) -> None:
        """Drop every session of a role (guest PIN rotated / disabled)."""
        for key in [k for k, s in self._sessions.items() if s.role == role]:
            del self._sessions[key]

    def stop_owner(self, owner_id: int) -> None:
        """
        Drop every session belonging to one account (logout-all).

        Does NOT revoke: no floor is set, so the account's devices may start
        again freely once they obtain fresh tokens. All guests share one
        User.id, so stop_owner(guest_id) ends every guest session — that is
        the intended shared-guest design.
        """
        for key in [k for k, s in self._sessions.items() if s.owner_id == owner_id]:
            del self._sessions[key]

    # ── diagnostics ─────────────────────────────────────────────────────────

    def stats(self) -> dict[str, int]:
        """Non-sensitive counters for admin/health output."""
        self._purge()
        self._prune_revocations()
        return {
            "active_devices": len(self._sessions),
            "max_devices": self.max_devices,
            "ttl_seconds": int(self.ttl),
            "heartbeat_seconds": int(settings.playback_heartbeat_seconds),
            "revoked_devices": len(self._revoked_before),
        }


# Single process-wide instance, wired to validated settings.
limiter = PlaybackLimiter(
    max_devices=settings.max_playback_devices,
    ttl=settings.playback_session_ttl_seconds,
)
