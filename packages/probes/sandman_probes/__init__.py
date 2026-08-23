"""The bundled probe presets.

A preset is a *builder*, not a fixed probe: it reads parameters from the project
config and produces concrete :class:`ProbeDefinition` objects for the endpoints
the user actually has. That is why these are functions rather than modules full
of ``@probe`` decorators -- a decorator would hard-code one service's routes.

Four presets ship:

``api-fuzz-differential``  malformed and boundary inputs; asserts the service
                           degrades with a 4xx rather than a 5xx.
``load-chaos-fanout``      concurrent bursts; asserts the service stays correct
                           under load rather than only under a single request.
``security-probe-suite``   injection, traversal, and secret-leak checks.
``latency-slo-guard``      p95 latency against a declared budget.

All four are deliberately read-only and idempotent. A probe runs many times
against many replicas; one with side effects produces results that cannot be
compared across variants.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from sandman_sdk import ProbeDefinition

from .fuzz import build as build_fuzz
from .load import build as build_load
from .security import build as build_security
from .slo import build as build_slo

__all__ = ["PRESETS", "build_preset", "describe_presets", "preset_ids"]

PresetBuilder = Callable[[str, Mapping[str, Any]], list[ProbeDefinition]]

PRESETS: dict[str, PresetBuilder] = {
    "api-fuzz-differential": build_fuzz,
    "load-chaos-fanout": build_load,
    "security-probe-suite": build_security,
    "latency-slo-guard": build_slo,
}

PRESET_DESCRIPTIONS: dict[str, str] = {
    "api-fuzz-differential": (
        "Throws malformed, boundary, and type-confused inputs at each endpoint and asserts the "
        "service answers with a client error rather than falling over. Differences in the "
        "normalized response across variants surface as behaviour changes."
    ),
    "load-chaos-fanout": (
        "Fires concurrent bursts at each endpoint and asserts correctness holds under "
        "contention, catching defects that only appear when requests overlap."
    ),
    "security-probe-suite": (
        "Injection, path traversal, oversized payload, and secret-leak checks. Asserts the "
        "service neither executes nor echoes hostile input."
    ),
    "latency-slo-guard": (
        "Measures p95 latency against a declared budget so a rollout that is correct but "
        "materially slower is still caught."
    ),
}


def preset_ids() -> list[str]:
    return sorted(PRESETS)


def describe_presets() -> list[dict[str, str]]:
    return [
        {"id": pid, "description": PRESET_DESCRIPTIONS[pid]} for pid in preset_ids()
    ]


def build_preset(
    preset_id: str, probe_id: str, params: Mapping[str, Any] | None = None
) -> list[ProbeDefinition]:
    """Instantiate a preset for one configured probe entry."""
    try:
        builder = PRESETS[preset_id]
    except KeyError:
        raise KeyError(
            f"unknown preset {preset_id!r}; available: {', '.join(preset_ids())}"
        ) from None
    return builder(probe_id, params or {})


def default_endpoints(params: Mapping[str, Any]) -> Sequence[str]:
    """Endpoints to exercise, from config, defaulting to the health check."""
    endpoints = params.get("endpoints")
    if isinstance(endpoints, (list, tuple)) and endpoints:
        return [str(e) for e in endpoints]
    return ["/health"]
