"""The live event bus behind the dashboard's streaming run view.

A fan-out run produces a lot of small state transitions: hundreds of sandboxes
each moving through QUEUED -> PROVISIONING -> RUNNING -> terminal, plus log
lines. Forwarding each one individually would melt the browser, so the bus
coalesces high-frequency updates into a periodic rollup.

Two channels exist per run:

* **Discrete events** (a run started, a finding appeared, a PR opened) are
  delivered immediately and never dropped.
* **Sandbox state** is folded into a dense array and flushed on a fixed
  interval, so 400 sandboxes changing state produce one message rather than 400.

Subscribers get a replay of recent history on connect, so a browser that
attaches mid-run renders a complete picture rather than an empty screen.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .models import RunState, SandboxState, Variant

#: How often coalesced sandbox-state rollups are emitted.
ROLLUP_INTERVAL_SECONDS = 0.25

#: Discrete events retained for replay to late subscribers.
REPLAY_BUFFER_SIZE = 500


class EventType(StrEnum):
    RUN_STATE = "run.state"
    RUN_PROGRESS = "run.progress"
    SANDBOX_ROLLUP = "sandbox.rollup"
    SANDBOX_LOG = "sandbox.log"
    PROBE_RESULT = "probe.result"
    VERDICT = "verdict"
    FINDING = "finding"
    HOTFIX = "hotfix"
    REVIEW = "review"
    PROMOTION = "promotion"
    BUDGET = "budget"
    ERROR = "error"
    HEARTBEAT = "heartbeat"


@dataclass(slots=True)
class Event:
    type: EventType
    data: dict[str, Any]
    run_id: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    ts: float = field(default_factory=time.time)

    def to_sse(self) -> dict[str, str]:
        """Shape expected by sse_starlette's EventSourceResponse."""
        return {
            "id": self.id,
            "event": self.type.value,
            "data": json.dumps({"ts": self.ts, "runId": self.run_id, **self.data}),
        }


@dataclass(slots=True)
class SandboxSnapshot:
    """Current state of one fan-out unit."""

    unit_id: str
    variant: Variant
    region: str | None
    unit_index: int
    state: SandboxState
    probe_id: str | None = None
    duration_ms: float | None = None
    exit_code: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "unitId": self.unit_id,
            "variant": self.variant.value,
            "region": self.region,
            "index": self.unit_index,
            "state": self.state.value,
            "probeId": self.probe_id,
            "durationMs": self.duration_ms,
            "exitCode": self.exit_code,
        }


class RunEventBus:
    """Per-run pub/sub with coalesced sandbox rollups."""

    def __init__(self, run_id: str, *, rollup_interval: float = ROLLUP_INTERVAL_SECONDS) -> None:
        self.run_id = run_id
        self._rollup_interval = rollup_interval
        self._subscribers: set[asyncio.Queue[Event]] = set()
        self._history: deque[Event] = deque(maxlen=REPLAY_BUFFER_SIZE)
        self._sandboxes: dict[str, SandboxSnapshot] = {}
        self._dirty = False
        self._closed = False
        self._rollup_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self.run_state: RunState = RunState.QUEUED

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._rollup_task is None and not self._closed:
            self._rollup_task = asyncio.create_task(self._rollup_loop())

    async def close(self) -> None:
        self._closed = True
        if self._rollup_task is not None:
            self._rollup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._rollup_task
            self._rollup_task = None
        await self._flush_rollup()
        # Wake every subscriber so their generators can exit. A subscriber that
        # is already backed up cannot accept the sentinel, and shutdown must not
        # depend on it: drain one slot and retry, then give up. Its generator
        # still exits on the next read because _closed is already set.
        sentinel = Event(type=EventType.HEARTBEAT, data={"closed": True}, run_id=self.run_id)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(sentinel)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(sentinel)

    # -- publishing -------------------------------------------------------

    def emit(self, event_type: EventType, **data: Any) -> Event:
        """Publish a discrete event immediately."""
        event = Event(type=event_type, data=data, run_id=self.run_id)
        self._history.append(event)
        for queue in list(self._subscribers):
            # A subscriber that cannot keep up loses this event rather than
            # stalling the run. Rollups will resynchronise its view.
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)
        return event

    def set_run_state(self, state: RunState, **data: Any) -> None:
        self.run_state = state
        self.emit(EventType.RUN_STATE, state=state.value, **data)

    def update_sandbox(self, snapshot: SandboxSnapshot) -> None:
        """Record a sandbox state change for the next rollup.

        Deliberately not emitted immediately: at fan-out width this is the
        highest-frequency event in the system.
        """
        self._sandboxes[snapshot.unit_id] = snapshot
        self._dirty = True

    def log(self, unit_id: str, line: str, *, stream: str = "stdout") -> None:
        self.emit(EventType.SANDBOX_LOG, unitId=unit_id, line=line, stream=stream)

    # -- rollups ----------------------------------------------------------

    async def _rollup_loop(self) -> None:
        while not self._closed:
            await asyncio.sleep(self._rollup_interval)
            await self._flush_rollup()

    async def _flush_rollup(self) -> None:
        async with self._lock:
            if not self._dirty:
                return
            self._dirty = False
            snapshots = [s.as_dict() for s in self._sandboxes.values()]
        self.emit(
            EventType.SANDBOX_ROLLUP,
            sandboxes=snapshots,
            summary=self.summary(),
        )

    def summary(self) -> dict[str, int]:
        """Counts by state, for the stat strip above the fan-out grid."""
        counts: dict[str, int] = {state.value: 0 for state in SandboxState}
        for snapshot in self._sandboxes.values():
            counts[snapshot.state.value] += 1
        counts["total"] = len(self._sandboxes)
        return counts

    # -- subscribing ------------------------------------------------------

    async def subscribe(self, *, replay: bool = True) -> AsyncIterator[Event]:
        """Yield events until the run closes.

        Replays recent history first so a browser attaching mid-run sees the
        whole picture instead of only what happens next.
        """
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=1000)
        self._subscribers.add(queue)
        try:
            if replay:
                for event in list(self._history):
                    yield event
                if self._sandboxes:
                    yield Event(
                        type=EventType.SANDBOX_ROLLUP,
                        data={
                            "sandboxes": [s.as_dict() for s in self._sandboxes.values()],
                            "summary": self.summary(),
                            "replay": True,
                        },
                        run_id=self.run_id,
                    )
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    # Keeps intermediary proxies from closing an idle stream.
                    yield Event(type=EventType.HEARTBEAT, data={}, run_id=self.run_id)
                    continue
                if event.type is EventType.HEARTBEAT and event.data.get("closed"):
                    return
                yield event
        finally:
            self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


class EventBusRegistry:
    """Process-wide registry of live run buses."""

    def __init__(self) -> None:
        self._buses: dict[str, RunEventBus] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, run_id: str) -> RunEventBus:
        async with self._lock:
            bus = self._buses.get(run_id)
            if bus is None:
                bus = RunEventBus(run_id)
                bus.start()
                self._buses[run_id] = bus
            return bus

    def get(self, run_id: str) -> RunEventBus | None:
        return self._buses.get(run_id)

    async def retire(self, run_id: str) -> None:
        async with self._lock:
            bus = self._buses.pop(run_id, None)
        if bus is not None:
            await bus.close()

    async def close_all(self) -> None:
        for run_id in list(self._buses):
            await self.retire(run_id)


registry = EventBusRegistry()
