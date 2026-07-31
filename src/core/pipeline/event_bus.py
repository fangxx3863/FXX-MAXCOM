"""事件总线：单一原始流扇出（ADR-0015 / R9）。

每个消费引擎 subscribe 得到独占的有界队列；publish_raw 把同一份原始字节
逐份拷贝给所有订阅者。队列有界、满时丢最旧，publish 绝不阻塞 I/O 线程。
"""

from __future__ import annotations

import logging
import queue
import threading
from contextlib import suppress

logger = logging.getLogger(__name__)

# 每个订阅者队列的最大数据份数；消费慢的引擎在此截断而非拖死生产端。
BUFFER_LIMIT = 4096


class EventBus:
    """线程安全的发布-订阅总线，仅负责扇出原始流，不做任何解析/分包。"""

    def __init__(self, buffer_limit: int = BUFFER_LIMIT) -> None:
        self._lock = threading.RLock()
        self._queues: dict[str, queue.Queue[bytes]] = {}
        self._buffer_limit = buffer_limit

    def publish_raw(self, data: bytes) -> None:
        """把一份原始字节拷贝给所有订阅者。满队列丢最旧并计数，不阻塞。"""
        if not data:
            return
        with self._lock:
            for subscriber_queue in self._queues.values():
                try:
                    subscriber_queue.put_nowait(data)
                except queue.Full:
                    # 满队列：丢最旧，再放入新份，保证 publish 不阻塞 I/O 线程。
                    with suppress(queue.Empty):
                        subscriber_queue.get_nowait()
                    subscriber_queue.put_nowait(data)
                    logger.warning("event_bus: subscriber queue full, dropped oldest chunk")

    def subscribe(self, subscriber: str) -> queue.Queue[bytes]:
        """为该订阅者创建独占有界队列并返回；同一实例所有订阅者收到相同数据。"""
        with self._lock:
            q: queue.Queue[bytes] = queue.Queue(maxsize=self._buffer_limit)
            self._queues[subscriber] = q
            return q

    def unsubscribe(self, subscriber: str) -> None:
        """移除订阅者队列；幂等。"""
        with self._lock:
            self._queues.pop(subscriber, None)
