"""The fan-out scheduler.

This is where a run actually spends money, so it is where the ceilings live.

The shape of a fan-out is two-dimensional and the two dimensions cost very
different amounts:

*Replicas* are sandboxes. Each one is a full copy of the service under test,
booted from a filesystem snapshot. They are the expensive axis, and they are
gated by :meth:`BudgetTracker.sandbox_slot`, which is sized to the Modal
container quota.

*Probe executions* are HTTP requests against an already-running replica. They are
nearly free, so a probe can fan out to a high count without provisioning
anything new; executions are distributed round-robin across the variant's
replicas so that a single slow replica does not dominate the sample.

Every variant is built from a snapshot taken once per revision. Building the base
sandbox is the slow part (clone, install, verify); after that, spawning replica
number fifty costs the same as spawning replica number one.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Sequence
from dataclasses import dataclass, field

import httpx

from .budget import BudgetTracker, estimate_run_cost
from .config import ProjectConfig, VariantConfig
from .events import EventType, RunEventBus, SandboxSnapshot
from .models import (
    BehavioralSignature,
    BudgetExceeded,
    ProbeOutcome,
    ProbeResult,
    Revision,
    SandboxState,
    Variant,
)
from .sandboxes import SandboxError, SandboxFactory, SandboxHandle

try:  # The SDK is a sibling package; probes are optional at import time.
    from sandman_sdk import ProbeContext, ProbeDefinition, ProbeFailure, Target, registry
except ImportError:  # pragma: no cover - exercised only in partial installs
    ProbeDefinition = None  # type: ignore[assignment,misc]
    ProbeFailure = AssertionError  # type: ignore[assignment,misc]
    ProbeContext = None  # type: ignore[assignment,misc]
    Target = None  # type: ignore[assignment,misc]
    registry = None  # type: ignore[assignment]


class FanOutError(RuntimeError):
    """The fan-out could not be scheduled at all."""


@dataclass(slots=True)
class ReplicaSet:
    """The live sandboxes backing one variant."""

    variant: Variant
    handles: list[SandboxHandle] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def healthy(self) -> bool:
        return bool(self.urls)

    def url_for(self, index: int) -> str:
        return self.urls[index % len(self.urls)]


@dataclass(slots=True)
class VariantPlan:
    """What one lane of the investigation will do."""

    variant: Variant
    revision: Revision
    config: VariantConfig
    image: str | None = None


class FanOutEngine:
    """Schedules replicas and probe executions under the run's ceilings."""

    def __init__(
        self,
        *,
        factory: SandboxFactory,
        budget: BudgetTracker,
        bus: RunEventBus,
        repo_url: str,
        http_timeout: float = 30.0,
    ) -> None:
        self._factory = factory
        self._budget = budget
        self._bus = bus
        self._repo_url = repo_url
        self._http_timeout = http_timeout

    # -- snapshots --------------------------------------------------------

    async def prepare(self, plan: VariantPlan) -> VariantPlan:
        """Build the base sandbox for a revision and snapshot it.

        Done once per lane. Every replica in that lane is then a clone of this
        snapshot, so all replicas start from a byte-identical state -- which is
        what makes a behavioural difference between replicas meaningful rather
        than an artefact of setup ordering.
        """
        self._bus.emit(
            EventType.RUN_PROGRESS,
            phase="snapshot",
            variant=plan.variant.value,
            revision=str(plan.revision),
        )
        async with self._budget.sandbox_slot():
            started = time.monotonic()
            try:
                image = await self._factory.build_base(
                    plan.config, self._repo_url, plan.revision, variant=plan.variant
                )
            except SandboxError as exc:
                raise FanOutError(
                    f"could not prepare {plan.variant.value} at {plan.revision}: {exc}"
                ) from exc
            await self._budget.charge_sandbox(
                cpu=plan.config.cpu,
                memory_mb=plan.config.memory_mb,
                seconds=time.monotonic() - started,
            )
        plan.image = image
        return plan

    # -- replicas ---------------------------------------------------------

    async def spawn_replicas(self, plan: VariantPlan) -> ReplicaSet:
        """Bring up every replica for a lane concurrently.

        Concurrency is bounded by the sandbox semaphore rather than by the
        replica count, so asking for 200 replicas on a 25-slot budget queues
        rather than failing.
        """
        if plan.image is None:
            raise FanOutError(f"variant {plan.variant.value} was never prepared")

        cfg = plan.config
        replicas = ReplicaSet(variant=plan.variant)
        regions = cfg.regions or [None]  # type: ignore[list-item]

        async def one(index: int) -> None:
            region = regions[index % len(regions)]
            unit_id = f"{plan.variant.value}-{index}"
            self._bus.update_sandbox(
                SandboxSnapshot(
                    unit_id=unit_id,
                    variant=plan.variant,
                    region=region,
                    unit_index=index,
                    state=SandboxState.QUEUED,
                )
            )
            handle: SandboxHandle | None = None
            started = time.monotonic()
            try:
                async with self._budget.sandbox_slot():
                    self._bus.update_sandbox(
                        SandboxSnapshot(
                            unit_id=unit_id,
                            variant=plan.variant,
                            region=region,
                            unit_index=index,
                            state=SandboxState.PROVISIONING,
                        )
                    )
                    handle = await self._factory.spawn(
                        plan.image, cfg, plan.variant, region=region, unit_index=index
                    )
                    await self._factory.wait_ready(handle, cfg, timeout_s=cfg.timeout_seconds)
                    url = await self._factory.tunnel_url(handle, cfg.port)

                replicas.handles.append(handle)
                replicas.urls.append(url)
                self._bus.update_sandbox(
                    SandboxSnapshot(
                        unit_id=unit_id,
                        variant=plan.variant,
                        region=region,
                        unit_index=index,
                        state=SandboxState.RUNNING,
                        duration_ms=(time.monotonic() - started) * 1000,
                    )
                )
            except BudgetExceeded:
                raise
            except Exception as exc:
                replicas.failures.append(f"replica {index}: {exc}")
                self._bus.update_sandbox(
                    SandboxSnapshot(
                        unit_id=unit_id,
                        variant=plan.variant,
                        region=region,
                        unit_index=index,
                        state=SandboxState.ERROR,
                    )
                )
                if handle is not None:
                    await self._factory.terminate(handle)

        await asyncio.gather(*(one(i) for i in range(cfg.replicas)), return_exceptions=False)
        return replicas

    async def release(self, replicas: ReplicaSet) -> None:
        await asyncio.gather(
            *(self._factory.terminate(h) for h in replicas.handles), return_exceptions=True
        )

    # -- probe execution --------------------------------------------------

    async def run_probes(
        self,
        variant: Variant,
        replicas: ReplicaSet,
        probes: Sequence[object],
    ) -> list[ProbeResult]:
        """Execute every probe across the lane's replicas."""
        if not replicas.healthy:
            # No replica came up. Invariant 3: this lane produced no evidence, so
            # it must not be recorded as failures -- it is recorded as errors,
            # which the verdict engine refuses to classify.
            return [
                _errored_result(
                    probe_id=getattr(p, "id", str(p)),
                    variant=variant,
                    message="; ".join(replicas.failures) or "no replica became ready",
                )
                for p in probes
            ]

        results: list[ProbeResult] = []
        async with httpx.AsyncClient(
            timeout=self._http_timeout, follow_redirects=True, verify=True
        ) as client:
            tasks: list[asyncio.Task[ProbeResult]] = []
            for definition in probes:
                fanout = int(getattr(definition, "fanout", 1) or 1)
                for execution in range(fanout):
                    url = replicas.url_for(execution)
                    tasks.append(
                        asyncio.create_task(
                            self._execute(
                                definition, variant, url, execution, fanout, client
                            )
                        )
                    )
            for settled in await asyncio.gather(*tasks, return_exceptions=True):
                if isinstance(settled, ProbeResult):
                    results.append(settled)
                elif isinstance(settled, BaseException):
                    results.append(
                        _errored_result(
                            probe_id="unknown",
                            variant=variant,
                            message=f"{type(settled).__name__}: {settled}",
                        )
                    )
        return results

    async def _execute(
        self,
        definition: object,
        variant: Variant,
        url: str,
        unit_index: int,
        replica_count: int,
        client: httpx.AsyncClient,
    ) -> ProbeResult:
        probe_id = getattr(definition, "id", str(definition))
        assert Target is not None and ProbeContext is not None

        target = Target(url, client=client)
        context = ProbeContext(
            probe_id=probe_id,
            unit_index=unit_index,
            replica_count=replica_count,
            params=dict(getattr(definition, "params", {}) or {}),
        )

        started = time.perf_counter()
        outcome: ProbeOutcome
        message: str | None = None
        error: BaseException | None = None

        try:
            await definition.run(target, context)  # type: ignore[attr-defined]
            outcome = ProbeOutcome.PASS
        except ProbeFailure as exc:  # an assertion about the code under test
            outcome = ProbeOutcome.FAIL
            message = str(exc)
            error = exc
        except TimeoutError as exc:
            outcome = ProbeOutcome.FAIL
            message = "probe timed out"
            error = exc
        except Exception as exc:  # a problem with our harness, not the target
            outcome = ProbeOutcome.ERROR
            message = f"{type(exc).__name__}: {exc}"
            error = exc

        elapsed_ms = (time.perf_counter() - started) * 1000
        signature = _signature_from(target, outcome, error, elapsed_ms)

        result = ProbeResult(
            probe_id=probe_id,
            variant=variant,
            unit_index=unit_index,
            outcome=outcome,
            signature=signature,
            message=message,
            latency_ms=elapsed_ms,
        )
        self._bus.emit(
            EventType.PROBE_RESULT,
            probeId=probe_id,
            variant=variant.value,
            unitIndex=unit_index,
            outcome=outcome.value,
            latencyMs=round(elapsed_ms, 2),
            message=message,
        )
        return result

    # -- whole-lane orchestration -----------------------------------------

    async def run_variant(
        self, plan: VariantPlan, probes: Sequence[object]
    ) -> list[ProbeResult]:
        """Prepare, spawn, probe, and always tear down."""
        if plan.image is None:
            await self.prepare(plan)

        replicas = await self.spawn_replicas(plan)
        try:
            return await self.run_probes(plan.variant, replicas, probes)
        finally:
            # Sandboxes bill for wall-clock time. Nothing may leak, even on abort.
            await self.release(replicas)

    async def run_all(
        self, plans: Sequence[VariantPlan], probes: Sequence[object]
    ) -> list[ProbeResult]:
        """Run every lane concurrently.

        Lanes are independent, so running them together roughly thirds the wall
        clock. The shared semaphores keep total concurrency inside the ceiling
        regardless of how many lanes are in flight.
        """
        gathered = await asyncio.gather(
            *(self.run_variant(plan, probes) for plan in plans), return_exceptions=True
        )
        results: list[ProbeResult] = []
        for plan, settled in zip(plans, gathered, strict=True):
            if isinstance(settled, list):
                results.extend(settled)
                continue
            if isinstance(settled, BudgetExceeded):
                raise settled
            results.extend(
                _errored_result(
                    probe_id=getattr(p, "id", str(p)),
                    variant=plan.variant,
                    message=f"lane failed: {settled}",
                )
                for p in probes
            )
        return results


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _signature_from(
    target: object,
    outcome: ProbeOutcome,
    error: BaseException | None,
    elapsed_ms: float,
) -> BehavioralSignature:
    """Fingerprint the probe's final observation.

    The last response a probe made is what its assertions were about, so it is
    the observation that characterises the behaviour.
    """
    observations = list(getattr(target, "observations", []) or [])
    if not observations:
        return BehavioralSignature.from_observation(
            error=error, latency_ms=elapsed_ms if outcome is not ProbeOutcome.ERROR else None
        )
    last = observations[-1]
    return BehavioralSignature.from_observation(
        status_code=getattr(last, "status_code", None),
        body=last.json() if hasattr(last, "json") else None,
        error=error,
        latency_ms=getattr(last, "elapsed_ms", elapsed_ms),
    )


def _errored_result(*, probe_id: str, variant: Variant, message: str) -> ProbeResult:
    return ProbeResult(
        probe_id=probe_id,
        variant=variant,
        outcome=ProbeOutcome.ERROR,
        signature=BehavioralSignature.from_observation(error=message),
        message=message,
    )


def plan_variants(
    config: ProjectConfig, revisions: dict[Variant, Revision]
) -> list[VariantPlan]:
    """Build the lane plans for the variants that are both enabled and supplied."""
    plans: list[VariantPlan] = []
    for variant in config.active_variants:
        revision = revisions.get(variant)
        if revision is None:
            continue
        plans.append(
            VariantPlan(variant=variant, revision=revision, config=config.variants[variant])
        )
    return plans


def preflight(config: ProjectConfig, budget: BudgetTracker) -> None:
    """Refuse a fan-out that cannot possibly fit the budget.

    Checked before provisioning anything: discovering the ceiling halfway
    through means paying for sandboxes whose results are discarded.
    """
    total = config.total_fanout()
    if total == 0:
        raise FanOutError("no probes enabled; nothing to run")

    sample = next(iter(config.variants.values()))
    projected = estimate_run_cost(
        sandbox_count=sum(config.variants[v].replicas for v in config.active_variants),
        cpu=sample.cpu,
        memory_mb=sample.memory_mb,
        expected_seconds=sample.timeout_seconds,
    )
    if budget.would_exceed(projected):
        raise FanOutError(
            f"projected worst-case cost ${projected:.2f} exceeds the ${budget.caps.max_usd_per_run:.2f} "
            f"cap; reduce replicas (currently {total} probe executions) or raise the cap"
        )


@contextlib.asynccontextmanager
async def engine_for(
    *,
    factory: SandboxFactory,
    budget: BudgetTracker,
    bus: RunEventBus,
    repo_url: str,
):
    """Engine bound to a run, guaranteeing the bus closes."""
    engine = FanOutEngine(factory=factory, budget=budget, bus=bus, repo_url=repo_url)
    try:
        yield engine
    finally:
        bus.emit(EventType.BUDGET, **budget.snapshot())
