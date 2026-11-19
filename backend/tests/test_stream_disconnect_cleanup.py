import asyncio
import warnings

import pytest

from app import streaming


class BlockingStreamClient:
    def __init__(self):
        self.started = asyncio.Event()
        self.block_forever = asyncio.Event()
        self.closed = asyncio.Event()

    def stream_media(self, message, offset):
        async def chunks():
            self.started.set()
            try:
                yield b"x" * streaming.CHUNK_SIZE
                await self.block_forever.wait()
            finally:
                self.closed.set()

        return chunks()


def _track_producer_tasks(monkeypatch):
    tasks = []
    create_task = asyncio.create_task

    def track(coro, *args, **kwargs):
        task = create_task(coro, *args, **kwargs)
        if getattr(coro, "__name__", "") == "produce":
            tasks.append(task)
        return task

    monkeypatch.setattr(streaming.asyncio, "create_task", track)
    return tasks


def _assert_producer_cleaned_up(tasks):
    assert len(tasks) == 1
    assert tasks[0].done()
    assert tasks[0].cancelled()
    current = asyncio.current_task()
    assert not [
        task
        for task in asyncio.all_tasks()
        if task is not current and not task.done()
    ]


def test_stream_generator_aclose_cancels_producer_without_generatorexit_warning(
    monkeypatch, caplog
):
    client = BlockingStreamClient()
    tasks = _track_producer_tasks(monkeypatch)
    ctx = [(0, client, object())]

    async def close_after_first_chunk():
        stream = streaming.stream_file(ctx, 0, streaming.CHUNK_SIZE * 2 - 1)
        first_chunk = await stream.__anext__()
        assert len(first_chunk) == streaming.CHUNK_SIZE
        await client.started.wait()
        await stream.aclose()
        assert client.closed.is_set()
        _assert_producer_cleaned_up(tasks)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        asyncio.run(close_after_first_chunk())

    assert not any("GeneratorExit" in str(warning.message) for warning in caught)
    assert not any("GeneratorExit" in record.getMessage() for record in caplog.records)
    assert not any(
        "Task was destroyed but it is pending" in record.getMessage()
        for record in caplog.records
    )


def test_stream_consumer_disconnect_closes_generator_and_producer(monkeypatch):
    client = BlockingStreamClient()
    tasks = _track_producer_tasks(monkeypatch)
    ctx = [(0, client, object())]

    async def disconnect_after_first_chunk():
        stream = streaming.stream_file(ctx, 0, streaming.CHUNK_SIZE * 2 - 1)
        first_chunk_received = asyncio.Event()

        async def consume_until_disconnected():
            try:
                chunk = await stream.__anext__()
                assert len(chunk) == streaming.CHUNK_SIZE
                first_chunk_received.set()
                await asyncio.Event().wait()
            finally:
                await stream.aclose()

        consumer = asyncio.create_task(consume_until_disconnected())
        await first_chunk_received.wait()
        assert client.started.is_set()
        consumer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await consumer
        assert client.closed.is_set()
        _assert_producer_cleaned_up(tasks)

    asyncio.run(disconnect_after_first_chunk())
