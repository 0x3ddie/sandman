"""Load and chaos preset.

Single-request probes miss a whole class of defect: anything that only appears
when requests overlap. This preset fires concurrent bursts and asserts two
things that matter more than raw throughput.

*Correctness under contention.* Every response in the burst must still be a
non-error. A service that answers correctly once and 500s at concurrency 20 has
a real defect.

*Response consistency.* Repeated identical requests must return identical
normalized bodies. This is what catches the demo's seeded nondeterministic facet
ordering -- one request looks fine, twenty reveal that the shape is unstable.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from functools import partial
from typing import Any

from sandman_sdk import ProbeContext, ProbeDefinition, ProbeFailure, Target


def build(probe_id: str, params: Mapping[str, Any]) -> list[ProbeDefinition]:
    endpoints: Sequence[str] = _endpoints(params)
    burst = int(params.get("burst", 20))
    concurrency = int(params.get("concurrency", 10))
    tolerated_error_rate = float(params.get("tolerated_error_rate", 0.0))
    fanout = int(params.get("fanout", 1) or 1)
    timeout = float(params.get("timeout_seconds", 120))

    definitions: list[ProbeDefinition] = []

    for endpoint in endpoints:
        slug = _slug(endpoint)
        request_params = _request_params(params, endpoint)

        async def under_load(
            t: Target,
            ctx: ProbeContext,
            _ep: str = endpoint,
            _rp: dict[str, Any] | None = None,
        ) -> None:
            """A concurrent burst must not push the service into server errors."""
            responses = await t.burst(
                "GET", _ep, count=burst, concurrency=concurrency, params=_rp or None
            )
            if not responses:
                raise ProbeFailure(f"no responses returned from a burst of {burst} at {_ep}")

            server_errors = [r for r in responses if r.status_code >= 500]
            observed_rate = len(server_errors) / len(responses)
            if observed_rate > tolerated_error_rate:
                sample = server_errors[0]
                raise ProbeFailure(
                    f"{len(server_errors)}/{len(responses)} requests to {_ep} returned a server "
                    f"error under concurrency {concurrency} "
                    f"(first: {sample.status_code} {sample.text[:160]})",
                    expected=tolerated_error_rate,
                    actual=observed_rate,
                )

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:burst:{slug}",
                fn=partial(under_load, _rp=request_params) if request_params else under_load,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("load", "chaos"),
                description=f"Concurrent burst of {burst} against {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

        async def consistency(
            t: Target,
            ctx: ProbeContext,
            _ep: str = endpoint,
            _rp: dict[str, Any] | None = None,
        ) -> None:
            """Identical requests must produce identical normalized bodies.

            Ordering that varies between calls is a contract defect even when
            every individual response is a 200.
            """
            responses = await t.burst(
                "GET", _ep, count=min(burst, 12), concurrency=4, params=_rp or None
            )
            successful = [r for r in responses if r.ok]
            if len(successful) < 2:
                return

            digests: dict[str, int] = {}
            for response in successful:
                body = response.json()
                if body is None:
                    continue
                canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
                digest = hashlib.sha256(canonical.encode()).hexdigest()[:16]
                digests[digest] = digests.get(digest, 0) + 1

            if len(digests) > 1:
                raise ProbeFailure(
                    f"{_ep} returned {len(digests)} distinct response shapes across "
                    f"{len(successful)} identical requests; the response is not deterministic",
                    expected=1,
                    actual=len(digests),
                )

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:consistency:{slug}",
                fn=partial(consistency, _rp=request_params) if request_params else consistency,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("load", "determinism"),
                description=f"Response determinism across repeated calls to {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

    async def sustained_health(t: Target, ctx: ProbeContext) -> None:
        """The health endpoint must stay up while the service is under load."""
        health_path = str(params.get("health_path", "/health"))
        responses = await t.burst("GET", health_path, count=burst, concurrency=concurrency)
        failures = [r for r in responses if not r.ok]
        if failures:
            raise ProbeFailure(
                f"health check failed {len(failures)}/{len(responses)} times under load",
                actual=failures[0].status_code,
            )

    definitions.append(
        ProbeDefinition(
            id=f"{probe_id}:health-under-load",
            fn=sustained_health,
            fanout=fanout,
            timeout_seconds=timeout,
            tags=("load", "chaos"),
            description="Health endpoint stability under concurrent load",
            params=dict(params),
            wants_context=True,
        )
    )

    return definitions


def _request_params(params: Mapping[str, Any], endpoint: str) -> dict[str, Any]:
    """Query parameters to send, so a burst can target a specific code path.

    Either a flat mapping applied to every endpoint, or a mapping keyed by
    endpoint for per-route control.
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
