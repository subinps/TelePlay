import asyncio
from types import SimpleNamespace

from sqlalchemy import select


class FakeScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class FakeSyncDb:
    def __init__(self, rows):
        self.rows = rows
        self.deleted = []
        self.committed = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, statement):
        return FakeScalarResult(self.rows)

    async def delete(self, row):
        self.deleted.append(row)

    async def commit(self):
        self.committed += 1


class FakeAsyncSessionFactory:
    def __init__(self, db):
        self.db = db

    def __call__(self):
        return self.db


def _run_sync_guard(monkeypatch, bot, rows, alive_ids):
    db = FakeSyncDb(rows)
    monkeypatch.setattr(bot, "async_session", FakeAsyncSessionFactory(db))

    async def get_messages(channel_id, message_ids):
        return [SimpleNamespace(id=message_id) for message_id in message_ids if message_id in alive_ids]

    monkeypatch.setattr(bot.tg_client, "get_messages", get_messages)

    invalidated = []
    import app.routers.streaming as streaming

    monkeypatch.setattr(streaming, "invalidate_meta", lambda file_id, message_id: invalidated.append((file_id, message_id)))
    result = asyncio.run(bot.sync_with_channel())
    return result, db, invalidated


def test_sync_startup_disabled_creates_no_sync_task(monkeypatch):
    import app.main as main
    import app.bot as bot

    async def no_op():
        return None

    calls = []

    async def fake_sync():
        calls.append("sync")
        return 0

    monkeypatch.setattr(main, "init_db", no_op)
    monkeypatch.setattr(main, "start_all_clients", no_op)
    monkeypatch.setattr(main, "stop_all_clients", no_op)
    monkeypatch.setattr(main, "engine", SimpleNamespace(dispose=no_op))
    monkeypatch.setattr(main, "_supervised_sync", fake_sync)
    monkeypatch.setattr(main.settings, "sync_on_startup", False)
    monkeypatch.setattr(bot, "sync_with_channel", fake_sync)
    main._sync_task = None

    async def run():
        async with main.lifespan(main.app):
            await asyncio.sleep(0)
            assert main._sync_task is None

    asyncio.run(run())
    assert calls == []


def test_sync_startup_enabled_runs_sync(monkeypatch):
    import app.main as main
    import app.bot as bot

    async def no_op():
        return None

    calls = []

    async def fake_sync():
        calls.append("sync")
        return 0

    monkeypatch.setattr(main, "init_db", no_op)
    monkeypatch.setattr(main, "start_all_clients", no_op)
    monkeypatch.setattr(main, "stop_all_clients", no_op)
    monkeypatch.setattr(main, "engine", SimpleNamespace(dispose=no_op))
    monkeypatch.setattr(main, "_supervised_sync", fake_sync)
    monkeypatch.setattr(main.settings, "sync_on_startup", True)
    monkeypatch.setattr(bot, "sync_with_channel", fake_sync)
    main._sync_task = None

    async def run():
        async with main.lifespan(main.app):
            await asyncio.sleep(0)

    asyncio.run(run())
    assert calls == ["sync"]


def test_sync_guard_aborts_when_all_messages_are_gone(monkeypatch):
    import app.bot as bot

    rows = [
        SimpleNamespace(id=1, channel_message_id=101),
        SimpleNamespace(id=2, channel_message_id=102),
    ]
    result, db, invalidated = _run_sync_guard(monkeypatch, bot, rows, alive_ids=set())
    assert result == 0
    assert db.deleted == []
    assert db.committed == 0
    assert invalidated == []


def test_sync_guard_aborts_when_more_than_thirty_percent_are_gone(monkeypatch):
    import app.bot as bot

    rows = [
        SimpleNamespace(id=1, channel_message_id=101),
        SimpleNamespace(id=2, channel_message_id=102),
        SimpleNamespace(id=3, channel_message_id=103),
        SimpleNamespace(id=4, channel_message_id=104),
    ]
    result, db, invalidated = _run_sync_guard(monkeypatch, bot, rows, alive_ids={101, 102})
    assert result == 0
    assert db.deleted == []
    assert db.committed == 0
    assert invalidated == []


def test_sync_normal_cleanup_deletes_only_gone_rows(monkeypatch):
    import app.bot as bot

    rows = [
        SimpleNamespace(id=1, channel_message_id=101),
        SimpleNamespace(id=2, channel_message_id=102),
        SimpleNamespace(id=3, channel_message_id=103),
        SimpleNamespace(id=4, channel_message_id=104),
        SimpleNamespace(id=5, channel_message_id=105),
        SimpleNamespace(id=6, channel_message_id=106),
        SimpleNamespace(id=7, channel_message_id=107),
        SimpleNamespace(id=8, channel_message_id=108),
        SimpleNamespace(id=9, channel_message_id=109),
        SimpleNamespace(id=10, channel_message_id=110),
    ]
    alive_ids = {101, 102, 103, 104, 105, 106, 107, 108, 110}
    result, db, invalidated = _run_sync_guard(monkeypatch, bot, rows, alive_ids=alive_ids)
    assert result == 1
    assert db.deleted == [rows[8]]
    assert db.committed == 1
    assert invalidated == [(9, 109)]


class FakeHelpMessage:
    def __init__(self):
        self.replies = []

    async def reply(self, text, **kwargs):
        self.replies.append((text, kwargs))


def test_help_lists_every_command_and_expiry_facts():
    import app.bot as bot

    message = FakeHelpMessage()
    asyncio.run(bot.help_command(None, message))
    text = message.replies[0][0]

    for command in (
        "/start",
        "/help",
        "/web",
        "/login",
        "/logout_all",
        "/sync",
        "/myfiles",
        "/file",
        "/users",
        "/user_add",
        "/user_remove",
        "/sessions",
        "/kick",
        "/guest",
    ):
        assert command in text
    assert "/guest status" in text
    assert "/guest off" in text
    assert "8 digits" in text
    assert "ONE-TIME" in text
    assert "5 minutes" in text
    assert "6 digits" in text
    assert "24 hours" in text
