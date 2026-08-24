"""The live event bus.

The bus exists to solve one problem: a wide fan-out produces far more state
transitions than a browser can absorb. Sandbox state is therefore coalesced into
periodic rollups while discrete events (a finding, a merged hotfix) go straight
through. These tests pin that distinction, because collapsing it would either
melt the tab or lose the events that matter.
"""

from __future__ import annotations

import asyncio

from sandman.events import (
    Event,
    EventBusRegistry,
    EventType,
    RunEventBus,
    SandboxSnapshot,
)
from sandman.models import RunState, SandboxState, Variant


def snapshot(index: int, state: SandboxState, variant: Variant = Variant.INITIAL) -> SandboxSnapshot:
    return SandboxSnapshot(
        unit_id=f"{variant.value}-{index}",
        variant=variant,
        region=None,
        unit_index=index,
        state=state,
    )


class TestDiscreteEvents:
    async def test_emit_reaches_a_subscriber(self) -> None:
        bus = RunEventBus("run_1")
        received: list[Event] = []

        async def listen() -> None:
            async for event in bus.subscribe(replay=False):
                received.append(event)
                if event.type is EventType.FINDING:
                    return

        task = asyncio.create_task(listen())
        await asyncio.sleep(0.01)
        bus.emit(EventType.FINDING, probeId="p", classification="regression")
        await asyncio.wait_for(task, timeout=2)

        assert received[-1].type is EventType.FINDING
        assert received[-1].data["classification"] == "regression"
        await bus.close()

    async def test_history_replays_to_a_late_subscriber(self) -> None:
        """A browser attaching mid-run must see the whole picture."""
        bus = RunEventBus("run_2")
        bus.emit(EventType.FINDING, probeId="early")
        bus.set_run_state(RunState.PROBING)

        seen: list[EventType] = []

        async def listen() -> None:
            async for event in bus.subscribe(replay=True):
                seen.append(event.type)
                if len(seen) >= 2:
                    return

        await asyncio.wait_for(asyncio.create_task(listen()), timeout=2)
        assert EventType.FINDING in seen
        await bus.close()

    def test_run_state_is_recorded_on_the_bus(self) -> None:
        bus = RunEventBus("run_3")
        bus.set_run_state(RunState.COMPARING)
        assert bus.run_state is RunState.COMPARING

    def test_sse_payload_shape(self) -> None:
        bus = RunEventBus("run_4")
        event = bus.emit(EventType.VERDICT, counts={"regression": 1})
        sse = event.to_sse()
        assert set(sse) == {"id", "event", "data"}
        assert sse["event"] == "verdict"
        assert '"runId": "run_4"' in sse["data"] or '"runId":"run_4"' in sse["data"]


class TestRollups:
    def test_sandbox_updates_do_not_emit_immediately(self) -> None:
        """At fan-out width this is the highest-frequency event in the system."""
        bus = RunEventBus("run_5")
        before = len(bus._history)
        for i in range(50):
            bus.update_sandbox(snapshot(i, SandboxState.RUNNING))
        assert len(bus._history) == before, "sandbox updates must be coalesced, not emitted"

    async def test_rollup_emits_one_event_for_many_updates(self) -> None:
        bus = RunEventBus("run_6", rollup_interval=0.02)
        bus.start()
        for i in range(100):
            bus.update_sandbox(snapshot(i, SandboxState.RUNNING))
        await asyncio.sleep(0.06)

        rollups = [e for e in bus._history if e.type is EventType.SANDBOX_ROLLUP]
        assert len(rollups) >= 1
        assert len(rollups) < 100, "100 updates must not produce 100 events"
        assert len(rollups[-1].data["sandboxes"]) == 100
        await bus.close()

    async def test_rollup_carries_a_state_summary(self) -> None:
        bus = RunEventBus("run_7", rollup_interval=0.02)
        bus.start()
        for i in range(5):
            bus.update_sandbox(snapshot(i, SandboxState.PASSED))
        for i in range(5, 8):
            bus.update_sandbox(snapshot(i, SandboxState.FAILED))
        await asyncio.sleep(0.06)

        summary = bus.summary()
        assert summary["passed"] == 5
        assert summary["failed"] == 3
        assert summary["total"] == 8
        await bus.close()

    async def test_clean_bus_does_not_emit_empty_rollups(self) -> None:
        bus = RunEventBus("run_8", rollup_interval=0.02)
        bus.start()
        await asyncio.sleep(0.08)
        assert [e for e in bus._history if e.type is EventType.SANDBOX_ROLLUP] == []
        await bus.close()

    def test_latest_state_wins_per_unit(self) -> None:
        bus = RunEventBus("run_9")
        bus.update_sandbox(snapshot(0, SandboxState.QUEUED))
        bus.update_sandbox(snapshot(0, SandboxState.PROVISIONING))
        bus.update_sandbox(snapshot(0, SandboxState.RUNNING))
        assert bus.summary()["running"] == 1
        assert bus.summary()["total"] == 1


class TestProvisioningIsDistinct:
    def test_provisioning_is_not_collapsed_into_running(self) -> None:
        """Modal cold starts take seconds.

        Without a distinct PROVISIONING state the opening moments of every run
        look like a hung UI.
        """
        assert SandboxState.PROVISIONING is not SandboxState.RUNNING
        assert SandboxState.PROVISIONING.terminal is False
        bus = RunEventBus("run_10")
        bus.update_sandbox(snapshot(0, SandboxState.PROVISIONING))
        assert bus.summary()["provisioning"] == 1


class TestRegistry:
    async def test_get_or_create_is_idempotent(self) -> None:
        registry = EventBusRegistry()
        a = await registry.get_or_create("run_x")
        b = await registry.get_or_create("run_x")
        assert a is b
        await registry.close_all()

    async def test_retire_closes_and_forgets(self) -> None:
        registry = EventBusRegistry()
        await registry.get_or_create("run_y")
        await registry.retire("run_y")
        assert registry.get("run_y") is None

    def test_unknown_run_is_none(self) -> None:
        assert EventBusRegistry().get("nope") is None


class TestSubscriberIsolation:
    async def test_a_slow_subscriber_does_not_stall_the_run(self) -> None:
        """A subscriber that cannot keep up loses events rather than blocking.

        Rollups resynchronise its view, so the cost of dropping is bounded.
        """
        bus = RunEventBus("run_11")
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=1)
        bus._subscribers.add(queue)

        for i in range(100):
            bus.emit(EventType.PROBE_RESULT, probeId=f"p{i}")

        assert queue.qsize() == 1
        await bus.close()
