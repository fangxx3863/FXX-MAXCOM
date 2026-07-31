"""事件总线测试（T0-T04 DoD）。

断言单一原始流扇出：所有订阅者收到相同序列、慢消费者不阻塞生产端、退订生效。
"""

import queue
import threading
from contextlib import suppress

from core.pipeline.event_bus import BUFFER_LIMIT, EventBus


def drain(q: queue.Queue[bytes]) -> list[bytes]:
    items: list[bytes] = []
    while True:
        try:
            items.append(q.get_nowait())
        except queue.Empty:
            break
    return items


def test_single_producer_multiple_consumers() -> None:
    bus = EventBus()
    a = bus.subscribe("a")
    b = bus.subscribe("b")

    bus.publish_raw(b"hello")
    bus.publish_raw(b"world")

    assert drain(a) == [b"hello", b"world"]
    assert drain(b) == [b"hello", b"world"]


def test_consumers_receive_same_sequence() -> None:
    bus = EventBus()
    qs = [bus.subscribe(f"s{i}") for i in range(5)]

    for chunk in (b"one", b"two", b"three"):
        bus.publish_raw(chunk)

    for q in qs:
        assert drain(q) == [b"one", b"two", b"three"]


def test_unsubscribe() -> None:
    bus = EventBus()
    a = bus.subscribe("a")
    b = bus.subscribe("b")
    bus.unsubscribe("a")

    bus.publish_raw(b"x")

    assert drain(a) == []
    assert drain(b) == [b"x"]


def test_unsubscribe_idempotent() -> None:
    bus = EventBus()
    bus.subscribe("a")
    bus.unsubscribe("a")
    bus.unsubscribe("a")  # 不抛异常


def test_empty_publish_is_noop() -> None:
    bus = EventBus()
    q = bus.subscribe("a")
    bus.publish_raw(b"")
    assert drain(q) == []


def test_subscribe_after_publish_receives_subsequent_only() -> None:
    bus = EventBus()
    bus.publish_raw(b"old")
    q = bus.subscribe("late")
    bus.publish_raw(b"new")
    assert drain(q) == [b"new"]


def test_slow_consumer_does_not_block_producer() -> None:
    """队列满时丢最旧，publish 永不阻塞。"""
    bus = EventBus(buffer_limit=2)
    q = bus.subscribe("slow")

    # 消费者不取，连发 5 份；生产端（当前线程）不应卡死。
    for i in range(5):
        bus.publish_raw(b"chunk" + bytes([i]))

    # 队列有界（2），只保留最新 2 份：丢掉了最旧的 3 份。
    assert drain(q) == [b"chunk\x03", b"chunk\x04"]


def test_slow_consumer_async_producer_not_blocked() -> None:
    """慢消费者在后台线程，生产线程不因慢消费者阻塞。"""
    bus = EventBus(buffer_limit=4)
    q = bus.subscribe("slow")

    stop = threading.Event()
    produced: list[bool] = []

    def consumer() -> None:
        while not stop.is_set():
            with suppress(queue.Empty):
                q.get(timeout=0.05)

    def producer() -> None:
        for i in range(100):
            bus.publish_raw(b"d" + bytes([i % 256]))
        produced.append(True)

    t = threading.Thread(target=consumer, daemon=True)
    t.start()
    try:
        p = threading.Thread(target=producer, daemon=True)
        p.start()
        p.join(timeout=5.0)
        assert produced, "producer blocked by slow consumer"
    finally:
        stop.set()
        t.join(timeout=1.0)


def test_default_buffer_limit_positive() -> None:
    assert BUFFER_LIMIT > 0
