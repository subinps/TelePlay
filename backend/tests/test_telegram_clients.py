"""T4 — Telegram Client Safety.

SYNC tests only (no asyncio_mode config): async calls go through asyncio.run(...)
inside sync tests, same pattern as test_playback.py / test_schema_migration.py.
No network, no real Telegram, no DB: every test uses fake client objects and
monkeypatches app.telegram module globals, restoring them afterwards.
"""
import asyncio
from types import SimpleNamespace

import pytest

from app import telegram

class FakeMessage:
    def __init__(self, msg_id=1, user_id=2, forward_result=None, forward_exc=None):
        self.id = msg_id
        self.from_user = SimpleNamespace(id=user_id)
        self._forward_result = forward_result
        self._forward_exc = forward_exc

    async def forward(self, chat_id=None):
        if self._forward_exc is not None:
            raise self._forward_exc
        return self._forward_result


class FakeFloodWait(Exception):
    def __init__(self, value):
        self.value = value


class FakeClient:
    def __init__(self, name="fake", start_ok=True, stop_raises=False, delete_result=True, delete_exc=None, forward_result=None, forward_exc=None):
        self.name = name
        self._start_ok = start_ok
        self._stop_raises = stop_raises
        self._delete_result = delete_result
        self._delete_exc = delete_exc
        self._forward_result = forward_result
        self._forward_exc = forward_exc
        self.started = False
        self.stopped = False
        self.pool_index = None

    async def start(self):
        if not self._start_ok:
            raise RuntimeError("boom")
        self.started = True
        return True

    async def get_me(self):
        return SimpleNamespace(username="u", id=1)

    async def stop(self):
        if self._stop_raises:
            raise RuntimeError("stop boom")
        self.stopped = True

    async def delete_messages(self, chat_id, ids):
        if self._delete_exc is not None:
            raise self._delete_exc
        return self._delete_result

    async def forward(self, chat_id=None):
        if self._forward_exc is not None:
            raise self._forward_exc
        return self._forward_result

    async def get_messages(self, chat_id, message_id):
        return None


def _patch(monkeypatch, main, helpers, clients_list):
    monkeypatch.setattr(telegram, "tg_client", main)
    monkeypatch.setattr(telegram, "_helper_clients", helpers)
    monkeypatch.setattr(telegram, "clients", clients_list)
    monkeypatch.setattr(telegram, "_started_clients", set())
    monkeypatch.setattr(telegram, "FloodWait", FakeFloodWait)


def test_main_client_start_failure_raises(monkeypatch):
    main = FakeClient("main", start_ok=False)
    helpers = []
    clients_list = [main]
    _patch(monkeypatch, main, helpers, clients_list)

    async def go():
        await telegram.start_all_clients()

    with pytest.raises(RuntimeError):
        asyncio.run(go())


def test_helper_start_failure_removed_and_clients_same_object(monkeypatch):
    main = FakeClient("main", start_ok=True)
    helper = FakeClient("helper", start_ok=False)
    helpers = [helper]
    clients_list = [main, helper]
    original = clients_list
    _patch(monkeypatch, main, helpers, clients_list)

    async def go():
        await telegram.start_all_clients()

    asyncio.run(go())
    assert telegram.clients is original
    assert helper not in telegram.clients
    assert main in telegram.clients


def test_helper_returning_false_removed(monkeypatch):
    main = FakeClient("main", start_ok=True)

    class FalseStartClient(FakeClient):
        async def start(self):
            self.started = False
            return False

    helper = FalseStartClient("helper", start_ok=True)
    helpers = [helper]
    clients_list = [main, helper]
    _patch(monkeypatch, main, helpers, clients_list)

    async def go():
        await telegram.start_all_clients()

    asyncio.run(go())
    assert helper not in telegram.clients
    assert main in telegram.clients


def test_all_helpers_healthy_keeps_all_in_order(monkeypatch):
    main = FakeClient("main", start_ok=True)
    h1 = FakeClient("h1", start_ok=True)
    h2 = FakeClient("h2", start_ok=True)
    helpers = [h1, h2]
    clients_list = [main, h1, h2]
    _patch(monkeypatch, main, helpers, clients_list)

    async def go():
        await telegram.start_all_clients()

    asyncio.run(go())
    assert telegram.clients == [main, h1, h2]


def test_pool_index_set_after_pruning(monkeypatch):
    main = FakeClient("main", start_ok=True)
    helper = FakeClient("helper", start_ok=False)
    helpers = [helper]
    clients_list = [main, helper]
    _patch(monkeypatch, main, helpers, clients_list)

    async def go():
        await telegram.start_all_clients()

    asyncio.run(go())
    for i, c in enumerate(telegram.clients):
        assert c.pool_index == i


def test_stop_all_clients_only_started_and_never_raises(monkeypatch):
    main = FakeClient("main", start_ok=True, stop_raises=True)
    helper = FakeClient("helper", start_ok=True, stop_raises=False)
    helpers = [helper]
    clients_list = [main, helper]
    _patch(monkeypatch, main, helpers, clients_list)

    async def start():
        await telegram.start_all_clients()

    asyncio.run(start())

    # add an unstarted client to clients list to ensure it's not stopped
    unstarted = FakeClient("unstarted", start_ok=True)
    telegram.clients.append(unstarted)

    async def stop():
        await telegram.stop_all_clients()

    asyncio.run(stop())  # should not raise
    assert helper.stopped is True
    assert unstarted.stopped is False


def test_delete_success(monkeypatch):
    main = FakeClient("main", delete_result=True)
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.delete_from_storage_channel(123)

    assert asyncio.run(go()) is True


def test_delete_floodwait_small_retries_then_succeeds(monkeypatch):
    calls = []

    async def fake_sleep(seconds):
        calls.append(seconds)

    monkeypatch.setattr(telegram.asyncio, "sleep", fake_sleep)

    class FlakyClient(FakeClient):
        def __init__(self):
            super().__init__("main", delete_result=True)
            self._calls = 0

        async def delete_messages(self, chat_id, ids):
            self._calls += 1
            if self._calls == 1:
                raise FakeFloodWait(5)
            return True

    main = FlakyClient()
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.delete_from_storage_channel(123)

    assert asyncio.run(go()) is True
    assert calls == [5]


def test_delete_floodwait_huge_returns_false_without_sleeping(monkeypatch):
    calls = []

    async def fake_sleep(seconds):
        calls.append(seconds)

    monkeypatch.setattr(telegram.asyncio, "sleep", fake_sleep)

    main = FakeClient("main", delete_exc=FakeFloodWait(100))
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.delete_from_storage_channel(123)

    assert asyncio.run(go()) is False
    assert calls == []


def test_delete_generic_exception_returns_false(monkeypatch):
    main = FakeClient("main", delete_exc=RuntimeError("boom"))
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.delete_from_storage_channel(123)

    assert asyncio.run(go()) is False


def test_delete_falsy_result_returns_false(monkeypatch):
    main = FakeClient("main", delete_result=False)
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.delete_from_storage_channel(123)

    assert asyncio.run(go()) is False


def test_forward_success_returns_message(monkeypatch):
    forwarded = SimpleNamespace(id=99)
    msg = FakeMessage(forward_result=forwarded)
    main = FakeClient("main")
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.forward_to_storage_channel(msg)

    assert asyncio.run(go()) is forwarded


def test_forward_failure_returns_none(monkeypatch):
    msg = FakeMessage(forward_exc=RuntimeError("boom"))
    main = FakeClient("main")
    _patch(monkeypatch, main, [], [main])

    async def go():
        return await telegram.forward_to_storage_channel(msg)

    assert asyncio.run(go()) is None
