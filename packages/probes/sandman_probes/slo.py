"""Latency / SLO preset.

A rollout can be perfectly correct and still be a bad rollout. This preset
measures the tail rather than the mean, because the mean hides exactly the
regressions users notice.

Two assertions:

*Absolute budget.* p95 must sit under a declared threshold.

*Error budget.* The success rate across the sample must clear a floor, so a fast
service that fails a tenth of the time does not pass on latency alone.

The verdict engine additionally buckets latency into a
:class:`BehavioralSignature`, so a rollout that stays under budget but moves from
the 25-50ms bucket to the 250-500ms bucket still registers as a behaviour change
across variants even when this probe passes on every lane.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from functools import partial
from typing import Any

from sandman_sdk import ProbeContext, ProbeDefinition, ProbeFailure, Target


def percentile(values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile: the smallest value at or below which q of the
    sample falls.

    Uses ``ceil(q * n)`` on a 1-indexed ordering, which is the standard
    definition and, unlike interpolation, always returns a value that was
    actually observed. That matters here because a latency budget should be
    compared against a real measurement, not a synthetic midpoint.
    """
    if not values:
        raise ValueError("percentile of an empty sample")
    ordered = sorted(values)
    rank = math.ceil(q * len(ordered))
    idx = min(len(ordered) - 1, max(0, rank - 1))
    return ordered[idx]


def build(probe_id: str, params: Mapping[str, Any]) -> list[ProbeDefinition]:
    endpoints: Sequence[str] = _endpoints(params)
    samples = int(params.get("samples", 20))
    concurrency = int(params.get("concurrency", 4))
    p95_budget_ms = float(params.get("p95_ms", 500))
    min_success_rate = float(params.get("min_success_rate", 0.99))
    fanout = int(params.get("fanout", 1) or 1)
    timeout = float(params.get("timeout_seconds", 120))

    # Per-endpoint overrides, e.g. {"/api/catalog/slow": 2000}
    budgets: Mapping[str, Any] = params.get("p95_ms_by_endpoint", {}) or {}

    definitions: list[ProbeDefinition] = []

    for endpoint in endpoints:
        slug = _slug(endpoint)
        budget_ms = float(budgets.get(endpoint, p95_budget_ms))
        request_params = _request_params(params, endpoint)

        async def latency(
            t: Target,
            ctx: ProbeContext,
            _ep: str = endpoint,
            _budget: float = budget_ms,
            _rp: dict[str, Any] | None = None,
        ) -> None:
            """p95 latency and success rate against the declared budget."""
            responses = await t.burst(
                "GET", _ep, count=samples, concurrency=concurrency, params=_rp or None
            )
            if not responses:
                raise ProbeFailure(f"no responses collected from {_ep}")

            successes = [r for r in responses if r.ok]
            success_rate = len(successes) / len(responses)
            if success_rate < min_success_rate:
                raise ProbeFailure(
                    f"{_ep} success rate {success_rate:.1%} is below the "
                    f"{min_success_rate:.1%} floor over {len(responses)} samples",
                    expected=min_success_rate,
                    actual=success_rate,
                )

            # Latency is measured over successful responses only: a fast 500 is
            # not evidence of good latency.
            latencies = [r.elapsed_ms for r in successes]
            observed_p95 = percentile(latencies, 0.95)
            if observed_p95 > _budget:
                p50 = percentile(latencies, 0.50)
                raise ProbeFailure(
                    f"{_ep} p95 {observed_p95:.0f}ms exceeds the {_budget:.0f}ms budget "
                    f"(p50 {p50:.0f}ms over {len(latencies)} samples)",
                    expected=_budget,
                    actual=observed_p95,
                )

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:p95:{slug}",
                fn=partial(latency, _rp=request_params) if request_params else latency,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("slo", "latency"),
                description=f"p95 under {budget_ms:.0f}ms at {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

    return definitions


def _request_params(params: Mapping[str, Any], endpoint: str) -> dict[str, Any]:
    """Query parameters to send, so a probe can target a specific code path.

    Accepts either a flat mapping applied to every endpoint, or a mapping keyed
    by endpoint for per-route control.
    """
    configured = params.get("request_params") or {}
    if not isinstance(configured, Mapping):
        return {}
    per_endpoint = configured.get(endpoint)
    if isinstance(per_endpoint, Mapping):
        return dict(per_endpoint)
    if any(isinstance(v, Mapping) for v in configured.values()):
        return {}
    return dict(configured)


def _endpoints(params: Mapping[str, Any]) -> Sequence[str]:
    endpoints = params.get("endpoints")
    if isinstance(endpoints, (list, tuple)) and endpoints:
        return [str(e) for e in endpoints]
    return ["/health"]


def _slug(endpoint: str) -> str:
    return endpoint.strip("/").replace("/", ".") or "root"
