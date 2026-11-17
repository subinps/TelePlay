import pytest
from pydantic import ValidationError

from app.config import Settings


def _base(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "unit-test-secret-" + "x" * 40)
    monkeypatch.setenv("AUTH_USERS", "123456789")


def test_short_jwt_secret_rejected(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setenv("JWT_SECRET", "too-short")
    with pytest.raises(ValidationError):
        Settings()


def test_placeholder_jwt_secret_rejected(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setenv("JWT_SECRET", "your-super-secret-key-change-in-production")
    with pytest.raises(ValidationError):
        Settings()


def test_empty_auth_users_rejected(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setenv("AUTH_USERS", "")
    with pytest.raises(ValidationError):
        Settings()


def test_malformed_auth_users_rejected(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setenv("AUTH_USERS", "abc,def")
    with pytest.raises(ValidationError):
        Settings()


def test_valid_settings_ok(monkeypatch):
    _base(monkeypatch)
    s = Settings()
    assert s.auth_users == [123456789]