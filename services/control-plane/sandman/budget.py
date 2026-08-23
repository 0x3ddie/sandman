"""Spend tracking and enforcement.

A fan-out run is the one operation in sandman that can run away: every extra
sub-sandbox costs Modal compute, and every probe that consults a model costs
tokens. Two ceilings are enforced independently because two different resources
are scarce.

*Sandbox concurrency* is bounded by the Modal container quota for the account.
*LLM concurrency* is bounded by the OpenAI rate limit, which is applied per
organisation — every sandbox shares one bucket through a single API key, so
fanning out wider does not buy more throughput, it just produces 429s.

Both are exposed as async semaphores acquired by the fan-out scheduler, plus a
running dollar tally that can abort the run.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from .models import BudgetCaps, BudgetExceeded, BudgetLedger

# Modal bills sandbox compute at roughly 3x the standard function rate. These are
# deliberately conservative: over-estimating spend aborts a run early, which is
# the safe failure direction.
USD_PER_CPU_SECOND = 0.000_15
USD_PER_GIB_SECOND = 0.000_02

# Per million tokens. Wide fan-out uses the cheap model; only hotfix authoring
# uses the expensive one.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-5.6-terra": (2.00, 12.00),
    "gpt-5.6-sol": (4.00, 20.00),
    "gpt-5.5": (5.00, 30.00),
}
DEFAULT_PRICING = (2.00, 12.00)


def sandbox_cost_usd(*, cpu: float, memory_mb: int, seconds: float) -> float:
    gib = memory_mb / 1024
    return seconds * (cpu * USD_PER_CPU_SECOND + gib * USD_PER_GIB_SECOND)


def token_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    in_rate, out_rate = MODEL_PRICING.get(model, DEFAULT_PRICING)
    return (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000


@dataclass(slots=True)
class BudgetTracker:
    """Enforces one run's ceilings.

    The tracker is the single place that decides a run has cost too much. It is
    safe to share across tasks: every mutation happens under a lock.
    """

    caps: BudgetCaps
    ledger: BudgetLedger = field(default_factory=BudgetLedger)
    started_at: float = field(default_factory=time.monotonic)
    warnings: list[str] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _sandbox_sem: asyncio.Semaphore | None = field(default=None, repr=False)
    _llm_sem: asyncio.Semaphore | None = field(default=None, repr=False)
    _aborted: bool = False

    def __post_init__(self) -> None:
        self._sandbox_sem = asyncio.Semaphore(self.caps.max_concurrent_sandboxes)
        self._llm_sem = asyncio.Semaphore(self.caps.max_concurrent_llm)

    # -- ceilings ---------------------------------------------------------

    @property
    def aborted(self) -> bool:
        return self._aborted

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started_at

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.caps.max_usd_per_run - self.ledger.usd_spent)

    @property
    def utilisation(self) -> float:
        if self.caps.max_usd_per_run <= 0:
            return 0.0
        return min(1.0, self.ledger.usd_spent / self.caps.max_usd_per_run)

    def _check_locked(self) -> None:
        """Caller must hold the lock."""
        if self.elapsed_seconds > self.caps.max_wall_clock_seconds:
            self._aborted = True
            raise BudgetExceeded(self.ledger.usd_spent, self.caps.max_usd_per_run)

        if self.ledger.usd_spent < self.caps.max_usd_per_run:
            return

        if self.caps.on_exceed == "hard_stop":
            self._aborted = True
            raise BudgetExceeded(self.ledger.usd_spent, self.caps.max_usd_per_run)

        message = (
            f"budget exceeded: ${self.ledger.usd_spent:.2f} of "
            f"${self.caps.max_usd_per_run:.2f}; continuing because on_exceed=warn"
        )
        if message not in self.warnings:
            self.warnings.append(message)

    async def ensure_within_budget(self) -> None:
        """Raise if the run has already blown its ceiling."""
        async with self._lock:
            self._check_locked()

    # -- accounting -------------------------------------------------------

    async def charge_sandbox(
        self, *, cpu: float, memory_mb: int, seconds: float, count: int = 1
    ) -> float:
        cost = sandbox_cost_usd(cpu=cpu, memory_mb=memory_mb, seconds=seconds) * count
        async with self._lock:
            self.ledger.sandbox_seconds += seconds * count
            self.ledger.sandboxes_created += count
            self.ledger.usd_spent += cost
            self._check_locked()
        return cost

    async def charge_tokens(self, *, model: str, input_tokens: int, output_tokens: int) -> float:
        cost = token_cost_usd(model, input_tokens, output_tokens)
        async with self._lock:
            self.ledger.llm_input_tokens += input_tokens
            self.ledger.llm_output_tokens += output_tokens
            self.ledger.usd_spent += cost
            self._check_locked()
        return cost

    def would_exceed(self, projected_usd: float) -> bool:
        """Whether spending this much more would cross the ceiling.

        Used to refuse a fan-out *before* provisioning rather than aborting
        halfway through and paying for sandboxes that produced nothing.
        """
        return (self.ledger.usd_spent + projected_usd) > self.caps.max_usd_per_run

    # -- concurrency gates -------------------------------------------------

    @asynccontextmanager
    async def sandbox_slot(self) -> AsyncGenerator[None, None]:
        """Bounded by the Modal container quota."""
        assert self._sandbox_sem is not None
        await self.ensure_within_budget()
        async with self._sandbox_sem:
            yield

    @asynccontextmanager
    async def llm_slot(self) -> AsyncGenerator[None, None]:
        """Bounded by the OpenAI organisation-level rate bucket.

        This is a separate gate from the sandbox slot on purpose: 25 sandboxes
        may run concurrently while only 8 of them talk to a model at once.
        """
        assert self._llm_sem is not None
        await self.ensure_within_budget()
        async with self._llm_sem:
            yield

    def snapshot(self) -> dict[str, float | int | bool | list[str]]:
        return {
            "usd_spent": round(self.ledger.usd_spent, 4),
            "usd_cap": self.caps.max_usd_per_run,
            "utilisation": round(self.utilisation, 4),
            "sandbox_seconds": round(self.ledger.sandbox_seconds, 2),
            "sandboxes_created": self.ledger.sandboxes_created,
            "llm_input_tokens": self.ledger.llm_input_tokens,
            "llm_output_tokens": self.ledger.llm_output_tokens,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "aborted": self._aborted,
            "warnings": list(self.warnings),
        }


def estimate_run_cost(
    *,
    sandbox_count: int,
    cpu: float,
    memory_mb: int,
    expected_seconds: float,
) -> float:
    """Estimate a full fan-out before committing to it."""
    return sandbox_cost_usd(cpu=cpu, memory_mb=memory_mb, seconds=expected_seconds) * sandbox_count
