import logging
import socket
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import DBAPIError, OperationalError

from app import auth
from app.auth import create_access_token
from app.database import get_db
from app.main import app


class FakeResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class FakeDatabase:
    def __init__(self, user):
        self.user = user

    async def execute(self, statement):
        return FakeResult(self.user)


@pytest.fixture
def authenticated_client(monkeypatch):
    now = datetime.now(timezone.utc)
    user = SimpleNamespace(
        id=1,
        telegram_id=123456789,
        username=None,
        first_name=None,
        last_name=None,
        auth_version=0,
        role="guest",
        created_at=now,
        last_active=now,
    )

    async def override_get_db():
        yield FakeDatabase(user)

    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    client = TestClient(app)
    yield client, user
    client.close()


@pytest.mark.parametrize(
    "failure",
    [
        socket.gaierror(11001, "getaddrinfo failed"),
        OperationalError("SELECT 1", {}, OSError("connection failed")),
        DBAPIError("SELECT 1", {}, RuntimeError("database unavailable")),
        ConnectionError("connection failed"),
        OSError("connection failed"),
    ],
)
def test_authenticated_route_returns_503_for_connection_failures_and_recovers(
    authenticated_client, monkeypatch, caplog, failure
):
    client, user = authenticated_client

    async def fail_get_guest_state():
        raise failure

    monkeypatch.setattr(auth, "get_guest_state", fail_get_guest_state)
    token = create_access_token(
        user.telegram_id,
        role="guest",
        version=user.auth_version,
        extra_claims={"gv": 0},
    )

    with caplog.at_level(logging.WARNING, logger="app.main"):
        unavailable = client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert unavailable.status_code == 503
    assert unavailable.json() == {
        "code": "SERVICE_UNAVAILABLE",
        "message": "Service is temporarily unavailable. Please try again in a moment.",
    }
    assert type(failure).__name__ in caplog.text
    assert str(failure) not in caplog.text

    async def available_guest_state():
        return SimpleNamespace(version=0, enabled=True)

    monkeypatch.setattr(auth, "get_guest_state", available_guest_state)
    normal = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert normal.status_code == 200
    assert normal.json()["role"] == "guest"
