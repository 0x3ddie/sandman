"""The control-plane HTTP API.

The dashboard is a Next.js app; this is what it talks to. Two things shape the
design.

*Runs are long.* A fan-out investigation takes minutes to tens of minutes, so
starting one returns immediately with a run id and the work continues in a
background task. Progress is consumed over Server-Sent Events. Running locally,
this process is long-lived, so SSE is the right tool -- there is no serverless
request deadline to design around.

*Nothing sensitive is echoed.* Configuration comes back with secrets omitted, and
readiness reports which capabilities are unconfigured by naming the missing
environment variables rather than their values.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .config import ProjectConfig, Settings, get_settings
from .events import EventType
from .events import registry as bus_registry
from .models import RunState
from .orchestrator import Orchestrator, RunOutcome

log = logging.getLogger("sandman.api")

app = FastAPI(
    title="sandman control plane",
    version="0.1.0",
    description="Pen-tests a rollout before it ships.",
)

# The dashboard runs on a different port in development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#: Live runs, by id. A finished run stays here so its outcome remains fetchable.
_RUNS: dict[str, RunOutcome] = {}
_TASKS: dict[str, asyncio.Task[RunOutcome]] = {}
_CONFIGS: dict[str, ProjectConfig] = {}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class StartRunRequest(BaseModel):
    config: ProjectConfig
    run_id: str | None = None


class StartRunResponse(BaseModel):
    run_id: str
    state: str
    stream_url: str


class CapabilityStatus(BaseModel):
    name: str
    configured: bool
    missing: list[str] = Field(default_factory=list)


class ReadinessResponse(BaseModel):
    ok: bool
    version: str
    capabilities: list[CapabilityStatus]


# ---------------------------------------------------------------------------
# Health and readiness
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "sandman-control-plane"}


@app.get("/api/readiness", response_model=ReadinessResponse)
async def readiness(settings: Settings | None = None) -> ReadinessResponse:
    """Which capabilities are configured, and precisely what is missing.

    Naming the absent variables here is what keeps an unconfigured control plane
    from surfacing as an opaque failure several minutes into a run.
    """
    cfg = settings or get_settings()
    capabilities = [
        CapabilityStatus(
            name=name, configured=cfg.is_configured(name), missing=cfg.missing_for(name)
        )
        for name in ("modal", "codex", "greptile", "github", "stripe", "secrets")
    ]
    required = {"modal", "codex", "github"}
    ok = all(c.configured for c in capabilities if c.name in required)
    return ReadinessResponse(ok=ok, version=app.version, capabilities=capabilities)


@app.get("/api/presets")
async def presets() -> dict[str, Any]:
    """The bounded set of built-in probe suites."""
    from sandman_probes import describe_presets

    return {"presets": describe_presets()}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@app.post("/api/config/validate")
async def validate_config(config: ProjectConfig) -> dict[str, Any]:
    """Check a project config and report what it would cost before spending it."""
    from .budget import estimate_run_cost

    sample = next(iter(config.variants.values()))
    projected = estimate_run_cost(
        sandbox_count=sum(config.variants[v].replicas for v in config.active_variants),
        cpu=sample.cpu,
        memory_mb=sample.memory_mb,
        expected_seconds=sample.timeout_seconds,
    )
    return {
        "valid": True,
        "activeVariants": [v.value for v in config.active_variants],
        "probeCount": len(config.enabled_probes),
        "totalFanout": config.total_fanout(),
        "projectedWorstCaseUsd": round(projected, 4),
        "budgetUsd": config.budget.max_usd_per_run,
        "withinBudget": projected <= config.budget.max_usd_per_run,
    }


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@app.post("/api/runs", response_model=StartRunResponse, status_code=202)
async def start_run(request: StartRunRequest) -> StartRunResponse:
    """Queue an investigation and return immediately.

    A fan-out run outlives any sane request timeout, so the work happens in a
    background task and the caller follows along over SSE.
    """
    bus = await bus_registry.get_or_create(request.run_id or _new_run_id())
    orchestrator = Orchestrator(request.config, bus=bus, run_id=bus.run_id)
    _CONFIGS[bus.run_id] = request.config
    _RUNS[bus.run_id] = orchestrator.outcome

    async def drive() -> RunOutcome:
        outcome = await orchestrator.run()
        _RUNS[outcome.run_id] = outcome
        return outcome

    _TASKS[bus.run_id] = asyncio.create_task(drive())
    return StartRunResponse(
        run_id=bus.run_id,
        state=RunState.QUEUED.value,
        stream_url=f"/api/runs/{bus.run_id}/stream",
    )


@app.get("/api/runs")
async def list_runs() -> dict[str, Any]:
    return {
        "runs": [
            {
                "runId": run_id,
                "state": outcome.state.value,
                "findings": len(outcome.verdict.findings) if outcome.verdict else 0,
                "hotfixes": len(outcome.hotfixes),
                "usdSpent": outcome.budget.get("usd_spent", 0),
            }
            for run_id, outcome in sorted(_RUNS.items(), reverse=True)
        ]
    }


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict[str, Any]:
    outcome = _RUNS.get(run_id)
    if outcome is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")
    return outcome.summary()


@app.get("/api/runs/{run_id}/verdicts")
async def get_verdicts(run_id: str) -> dict[str, Any]:
    """The per-probe three-way comparison — the hero screen's data."""
    outcome = _RUNS.get(run_id)
    if outcome is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")

    verdict = outcome.verification_verdict or outcome.verdict
    if verdict is None:
        return {"verdicts": [], "findings": [], "counts": {}}

    return {
        "counts": verdict.counts(),
        "safeToPromote": verdict.safe_to_promote,
        "verdicts": [
            {
                "probeId": v.probe_id,
                "classification": v.classification.value,
                "severity": v.classification.severity,
                "baselinePassed": v.baseline_passed,
                "initialPassed": v.initial_passed,
                "hotfixPassed": v.hotfix_passed,
                "behaviourChanged": v.behaviour_changed,
                "flakeSuspected": v.flake_suspected,
                "sampleSize": {k.value: n for k, n in v.sample_size.items()},
                "signatures": {
                    k.value: s.model_dump() for k, s in v.signatures.items()
                },
                "detail": v.detail,
            }
            for v in sorted(verdict.verdicts, key=lambda v: v.classification.severity)
        ],
        "findings": [
            {
                "id": f.id,
                "probeId": f.probe_id,
                "classification": f.classification.value,
                "severity": f.severity.value,
                "title": f.title,
                "description": f.description,
                "reproduction": f.reproduction,
                "previouslyIgnored": f.previously_ignored,
                "evidence": {k.value: v for k, v in f.variant_evidence.items()},
            }
            for f in verdict.findings
        ],
    }


@app.get("/api/runs/{run_id}/hotfixes")
async def get_hotfixes(run_id: str) -> dict[str, Any]:
    outcome = _RUNS.get(run_id)
    if outcome is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")
    return {
        "hotfixes": [
            {**h.as_dict(), "diff": h.diff, "priorFixes": h.prior_fixes}
            for h in outcome.hotfixes
        ]
    }


@app.post("/api/runs/{run_id}/abort", status_code=202)
async def abort_run(run_id: str) -> dict[str, str]:
    task = _TASKS.get(run_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")
    task.cancel()
    bus = bus_registry.get(run_id)
    if bus is not None:
        bus.emit(EventType.ERROR, reason="aborted", detail="aborted by operator")
    return {"runId": run_id, "state": "aborting"}


@app.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str, request: Request) -> EventSourceResponse:
    """Live run events.

    Recent history replays on connect so a browser attaching mid-run renders the
    whole picture rather than only what happens next.
    """
    bus = bus_registry.get(run_id)
    if bus is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")

    async def publisher() -> AsyncGenerator[dict[str, str], None]:
        async for event in bus.subscribe(replay=True):
            if await request.is_disconnected():
                break
            yield event.to_sse()

    return EventSourceResponse(publisher())


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------


@app.get("/api/memory/status")
async def memory_status() -> dict[str, Any]:
    """Whether persistent memory is reachable.

    Sandboxes cannot reach the local worker, so only the control plane talks to
    it; this endpoint is how the dashboard shows that link is healthy.
    """
    from .memory import MemoryClient

    settings = get_settings()
    client = MemoryClient(settings)
    try:
        available = await client.available()
        version = await client.version() if available else None
        return {
            "enabled": settings.sandman_memory_enabled,
            "available": available,
            "version": version,
            "baseUrl": settings.memory_base_url,
        }
    finally:
        with contextlib.suppress(Exception):
            await client.aclose()


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


@app.exception_handler(ValueError)
async def value_error_handler(_request: Request, exc: ValueError) -> JSONResponse:
    """Validation failures are the user's problem to fix, so say what is wrong."""
    return JSONResponse(status_code=400, content={"error": "invalid_request", "detail": str(exc)})


def _new_run_id() -> str:
    import uuid

    return f"run_{uuid.uuid4().hex[:12]}"


@app.on_event("shutdown")
async def _shutdown() -> None:
    for task in _TASKS.values():
        task.cancel()
    await bus_registry.close_all()
