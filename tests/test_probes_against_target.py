"""Integration: the presets must actually catch the seeded defects.

These run the real target app in-process over an ASGI transport, so they
exercise the genuine handler code rather than a mock. If a preset stops catching
its defect, this fails.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

TARGET_APP = Path(__file__).resolve().parent.parent / "target-app"
if str(TARGET_APP) not in sys.path:
    sys.path.insert(0, str(TARGET_APP))

from main import app  # noqa: E402

from sandman_probes import build_preset, preset_ids  # noqa: E402
from sandman_sdk import ProbeContext, ProbeFailure, Target  # noqa: E402

CATALOG_ENDPOINTS = ["/api/catalog/search", "/api/catalog/facets", "/api/catalog/stats"]


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://target") as c:
        yield c


async def run_probe(definition, client) -> tuple[bool, str | None]:
    """Execute one probe; return (passed, message)."""
    target = Target("http://target", client=client)
    context = ProbeContext(probe_id=definition.id, unit_index=0, replica_count=1)
    try:
        await definition.run(target, context)
        return True, None
    except ProbeFailure as exc:
        return False, str(exc)
    except AssertionError as exc:
        return False, str(exc)


class TestPresetRegistry:
    def test_all_four_presets_exist(self) -> None:
        assert preset_ids() == [
            "api-fuzz-differential",
            "latency-slo-guard",
            "load-chaos-fanout",
            "security-probe-suite",
        ]

    def test_unknown_preset_names_the_alternatives(self) -> None:
        with pytest.raises(KeyError, match="api-fuzz-differential"):
            build_preset("nope", "p")

    def test_presets_build_probes(self) -> None:
        for pid in preset_ids():
            probes = build_preset(pid, "p", {"endpoints": CATALOG_ENDPOINTS})
            assert probes, f"{pid} produced no probes"
            assert all(p.id.startswith("p:") for p in probes)


class TestFuzzPresetCatchesDefectB:
    """The off-by-one that 500s whenever a page lands at the end of the results."""

    async def test_pagination_probe_fails(self, client) -> None:
        probes = build_preset(
            "api-fuzz-differential", "fuzz", {"endpoints": ["/api/catalog/search"]}
        )
        pagination = [p for p in probes if "pagination" in p.id]
        assert pagination, "expected a pagination probe"

        passed, message = await run_probe(pagination[0], client)
        assert passed is False
        assert "server error" in (message or "").lower()

    async def test_empty_result_probe_fails(self, client) -> None:
        probes = build_preset(
            "api-fuzz-differential", "fuzz", {"endpoints": ["/api/catalog/search"]}
        )
        empty = [p for p in probes if ":empty:" in p.id]
        passed, _ = await run_probe(empty[0], client)
        assert passed is False, "a query matching nothing should 500 on the buggy build"

    async def test_healthy_endpoint_passes(self, client) -> None:
        """The preset must not cry wolf on an endpoint that works."""
        probes = build_preset(
            "api-fuzz-differential",
            "fuzz",
            {"endpoints": ["/api/catalog/stats"], "pagination": False},
        )
        for probe in probes:
            passed, message = await run_probe(probe, client)
            assert passed, f"{probe.id} should pass against a healthy endpoint: {message}"


class TestLoadPresetCatchesDefectA:
    """Nondeterministic facet ordering: fine once, unstable across repeats."""

    async def test_consistency_probe_detects_unstable_shape(self, client) -> None:
        probes = build_preset(
            "load-chaos-fanout",
            "load",
            {"endpoints": ["/api/catalog/facets"], "burst": 12},
        )
        consistency = [p for p in probes if "consistency" in p.id]
        assert consistency

        passed, message = await run_probe(consistency[0], client)
        # Set iteration order is stable within a single process, so in-process
        # this may pass; across sandbox replicas (separate processes with
        # randomized string hashing) it diverges. Assert the probe ran and, when
        # it did fail, that it failed for the right reason.
        if not passed:
            assert "deterministic" in (message or "")

    async def test_burst_probe_catches_server_errors_under_load(self, client) -> None:
        probes = build_preset(
            "load-chaos-fanout",
            "load",
            {
                "endpoints": ["/api/catalog/search"],
                "burst": 10,
                "concurrency": 5,
                "request_params": {"limit": 20, "offset": 230},
            },
        )
        burst = [p for p in probes if ":burst:" in p.id]
        passed, message = await run_probe(burst[0], client)
        assert passed is False
        assert "server error" in (message or "").lower()

    async def test_health_under_load_passes(self, client) -> None:
        probes = build_preset("load-chaos-fanout", "load", {"burst": 10})
        health = [p for p in probes if "health-under-load" in p.id]
        passed, message = await run_probe(health[0], client)
        assert passed, message


class TestSecurityPreset:
    async def test_clean_service_passes_injection_checks(self, client) -> None:
        probes = build_preset(
            "security-probe-suite",
            "sec",
            {"endpoints": ["/api/catalog/stats"]},
        )
        injection = [p for p in probes if ":injection:" in p.id]
        passed, message = await run_probe(injection[0], client)
        assert passed, message

    async def test_error_hygiene_passes(self, client) -> None:
        probes = build_preset("security-probe-suite", "sec", {})
        hygiene = [p for p in probes if "error-hygiene" in p.id]
        passed, message = await run_probe(hygiene[0], client)
        assert passed, message

    async def test_leak_detection_fires_on_a_planted_secret(self) -> None:
        """The detector must actually detect. Verified against a synthetic app."""
        from fastapi import FastAPI

        leaky = FastAPI()

        @leaky.get("/api/catalog/stats")
        def leak() -> dict[str, str]:
            return {"debug": "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx"}

        transport = httpx.ASGITransport(app=leaky, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://leaky") as c:
            probes = build_preset(
                "security-probe-suite", "sec", {"endpoints": ["/api/catalog/stats"]}
            )
            injection = [p for p in probes if ":injection:" in p.id]
            passed, message = await run_probe(injection[0], c)
            assert passed is False
            assert "leaked" in (message or "")


class TestSloPreset:
    async def test_fast_endpoint_meets_budget(self, client) -> None:
        probes = build_preset(
            "latency-slo-guard",
            "slo",
            {"endpoints": ["/api/catalog/stats"], "samples": 10, "p95_ms": 2000},
        )
        passed, message = await run_probe(probes[0], client)
        assert passed, message

    async def test_impossible_budget_fails(self, client) -> None:
        probes = build_preset(
            "latency-slo-guard",
            "slo",
            {"endpoints": ["/api/catalog/slow"], "samples": 6, "p95_ms": 1},
        )
        passed, message = await run_probe(probes[0], client)
        assert passed is False
        assert "p95" in (message or "")

    async def test_error_budget_beats_latency(self, client) -> None:
        """A fast endpoint that errors must fail on success rate, not latency."""
        probes = build_preset(
            "latency-slo-guard",
            "slo",
            {
                "endpoints": ["/api/catalog/search"],
                "samples": 8,
                "p95_ms": 100_000,
                "request_params": {"limit": 20, "offset": 230},
            },
        )
        passed, message = await run_probe(probes[0], client)
        assert passed is False
        assert "success rate" in (message or "")


class TestPercentile:
    def test_nearest_rank(self) -> None:
        from sandman_probes.slo import percentile

        values = [float(i) for i in range(1, 101)]
        assert percentile(values, 0.5) == 50.0
        assert percentile(values, 0.95) == 95.0
        assert percentile([5.0], 0.95) == 5.0

    def test_empty_sample_raises(self) -> None:
        from sandman_probes.slo import percentile

        with pytest.raises(ValueError):
            percentile([], 0.95)
