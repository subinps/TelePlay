"""
backend/app/playback.py — 2-device concurrent-playback limiter.
In-memory implementation (single process, no DB overhead).
"""
import time
from dataclasses import dataclass, field
from typing import Callable, List

@dataclass
class PlaybackSession:
    device_id: str
    label: str
    role: str            # "admin" | "guest"
    file_id: int
    last_seen: float = field(default_factory=time.monotonic)

class PlaybackLimiter:
    def __init__(self, max_devices: int = 2, ttl: float = 75.0, clock: Callable[[], float] = time.monotonic):
        self.max_devices = max_devices
        self.ttl = ttl
        self.clock = clock
        self._sessions: dict[str, PlaybackSession] = {}

    def _purge(self):
        """Remove sessions that haven't sent a heartbeat in a while."""
        now = self.clock()
        for k in [k for k, v in self._sessions.items() if now - v.last_seen > self.ttl]:
            del self._sessions[k]

    def active(self) -> List[PlaybackSession]:
        """Get list of currently active sessions."""
        self._purge()
        return list(self._sessions.values())

    def start(self, device_id: str, label: str, role: str, file_id: int) -> tuple[bool, List[PlaybackSession]]:
        """
        Attempt to start a stream.
        Returns (ok, active_sessions).
        Same device re-starting (refresh, next video) never counts twice.
        """
        self._purge()
        if device_id not in self._sessions and len(self._sessions) >= self.max_devices:
            return False, list(self._sessions.values())
            
        self._sessions[device_id] = PlaybackSession(
            device_id=device_id,
            label=label,
            role=role,
            file_id=file_id,
            last_seen=self.clock()
        )
        return True, list(self._sessions.values())

    def heartbeat(self, device_id: str, file_id: int | None = None) -> bool:
        """Update the last_seen time for a device. Returns False if session expired/kicked."""
        self._purge()
        s = self._sessions.get(device_id)
        if not s:
            return False
        s.last_seen = self.clock()
        if file_id is not None:
            s.file_id = file_id
        return True

    def is_active(self, device_id: str) -> bool:
        """Check if a device is currently active."""
        self._purge()
        return device_id in self._sessions

    def stop(self, device_id: str):
        """Stop a specific device."""
        self._sessions.pop(device_id, None)

    def stop_role(self, role: str):
        """Stop all sessions with a specific role (e.g. when rotating guest PIN)."""
        for k in [k for k, v in self._sessions.items() if v.role == role]:
            del self._sessions[k]

# Instantiate the global limiter for the app
limiter = PlaybackLimiter()
