"""End-to-end orchestrator logic, with the external services faked.

Modal, GitHub, Greptile, and Codex are all replaced by in-memory fakes so the
whole lifecycle -- resolve, probe, compare, remediate, verify, promote -- runs
deterministically and offline. What is exercised for real is the part that is
genuinely ours: the sequencing, the new-vs-pre-existing classification, the
decision about which findings get a hotfix, and the promotion gate.
"""

from __future__ import annotations

import httpx
import pytest

# ---------------------------------------------------------------------------
# A tiny in-process service under test, with a fault we can toggle per variant.
# ---------------------------------------------------------------------------
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from sandman.config import ProjectConfig
from sandman.events import RunEventBus
from sandman.models import BudgetCaps, Classification, ProbeResult, Revision, RunState, Variant
from sandman.orchestrator import HotfixAttempt, Orchestrator, _split_repo


def make_app(*, buggy: bool) -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/items")
    def items(limit: int = Query(20), offset: int = Query(0)) -> JSONResponse:
        data = list(range(200))
        if buggy:
            window = data[offset : offset + limit + 1]
            _ = window[limit]  # 500s at the tail
        page = data[offset : offset + limit]
        return JSONResponse({"items": page, "limit": limit, "offset": offset})

    @app.exception_handler(Exception)
    async def unhandled(_req: object, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"error": type(exc).__name__})

    return app


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeEngine:
    """Replaces FanOutEngine: runs probes against in-process apps.

    `fault_map` decides which variants serve the buggy build. This is the whole
    point of the test -- it lets us stage a NEW regression (only INITIAL buggy)
    versus a PRE-EXISTING failure (baseline buggy too) and assert the
    orchestrator treats them differently.
    """

    def __init__(self, fault_map: dict[Variant, bool]) -> None:
        self._apps = {v: make_app(buggy=b) for v, b in fault_map.items()}
        self.runs: list[list[Variant]] = []

    async def run_all(self, plans, probes) -> list[ProbeResult]:
        from sandman.fanout import _signature_from
        from sandman.models import ProbeOutcome
        from sandman_sdk import ProbeContext, ProbeFailure, Target

        self.runs.append([p.variant for p in plans])
        results: list[ProbeResult] = []
        for plan in plans:
            app = self._apps.get(plan.variant) or make_app(buggy=False)
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
            async with httpx.AsyncClient(
                transport=transport, base_url=f"http://{plan.variant.value}"
            ) as client:
                for definition in probes:
                    for unit in range(max(1, definition.fanout)):
                        target = Target(f"http://{plan.variant.value}", client=client)
                        ctx = ProbeContext(
                            probe_id=definition.id, unit_index=unit, replica_count=1
                        )
                        outcome = ProbeOutcome.PASS
                        message = None
                        error: BaseException | None = None
                        try:
                            await definition.run(target, ctx)
                        except ProbeFailure as exc:
                            outcome = ProbeOutcome.FAIL
                            message = str(exc)
                            error = exc
                        except Exception as exc:
                            outcome = ProbeOutcome.ERROR
                            message = str(exc)
                            error = exc
                        results.append(
                            ProbeResult(
                                probe_id=definition.id,
                                variant=plan.variant,
                                unit_index=unit,
                                outcome=outcome,
                                signature=_signature_from(target, outcome, error, 1.0),
                                message=message,
                                latency_ms=1.0,
                            )
                        )
        return results


def probe_config() -> ProjectConfig:
    cfg = ProjectConfig(
        repository_url="https://github.com/acme/widgets",
        lkg_branch="main",
        probes=[
            {
                "id": "items",
                "preset": "api-fuzz-differential",
                "params": {"endpoints": ["/api/items"], "pagination": True},
                "fanout": 3,
            }
        ],
    )
    for variant in cfg.variants:
        cfg.variants[variant].replicas = 1
    cfg.budget = BudgetCaps(max_usd_per_run=100.0)
    cfg.custom_probe_paths = []
    return cfg


def make_orchestrator(fault_map: dict[Variant, bool], monkeypatch) -> tuple[Orchestrator, FakeEngine]:
    cfg = probe_config()
    orch = Orchestrator(cfg, bus=RunEventBus("run_test"), run_id="run_test")
    engine = FakeEngine(fault_map)

    import sandman.orchestrator as orch_mod

    monkeypatch.setattr(orch_mod, "FanOutEngine", lambda **kw: engine)
    monkeypatch.setattr(orch_mod, "preflight", lambda *a, **k: None)

    async def fake_resolve(owner: str, repo: str) -> dict[Variant, Revision]:
        return {
            Variant.BASELINE: Revision(ref="main", sha="b" * 40),
            Variant.INITIAL: Revision(ref="main", sha="c" * 40),
        }

    monkeypatch.setattr(orch, "resolve_revisions", fake_resolve)

    # Memory off for the deterministic path.
    orch.settings.sandman_memory_enabled = False
    return orch, engine


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSplitRepo:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://github.com/acme/widgets", ("acme", "widgets")),
            ("https://github.com/acme/widgets.git", ("acme", "widgets")),
            ("git@github.com:acme/widgets.git", ("acme", "widgets")),
            ("https://github.com/acme/widgets/", ("acme", "widgets")),
        ],
    )
    def test_variants(self, url: str, expected: tuple[str, str]) -> None:
        assert _split_repo(url) == expected


class TestNewRegression:
    """Only INITIAL is buggy: a regression this rollout introduced."""

    async def test_initial_probe_finds_a_still_broken_finding(self, monkeypatch) -> None:
        orch, _engine = make_orchestrator(
            {Variant.BASELINE: False, Variant.INITIAL: True}, monkeypatch
        )
        # Stop after comparison: remediation needs the real GitHub/Codex path.
        monkeypatch.setattr(orch, "remediate_phase", _no_remediation)
        monkeypatch.setattr(orch, "verify_phase", _no_verification)

        outcome = await orch.run()

        assert outcome.state is RunState.COMPLETED
        assert outcome.verdict is not None
        classifications = {v.classification for v in outcome.verdict.verdicts}
        assert Classification.STILL_BROKEN in classifications
        # A failure this rollout caused is eligible for a hotfix.
        assert outcome.verdict.hotfix_candidates


class TestPreExistingFailure:
    """Both baseline and initial are buggy: not this rollout's fault."""

    async def test_pre_existing_is_not_a_hotfix_candidate(self, monkeypatch) -> None:
        orch, _engine = make_orchestrator(
            {Variant.BASELINE: True, Variant.INITIAL: True}, monkeypatch
        )
        monkeypatch.setattr(orch, "remediate_phase", _no_remediation)
        monkeypatch.setattr(orch, "verify_phase", _no_verification)

        outcome = await orch.run()

        assert outcome.state is RunState.COMPLETED
        assert outcome.verdict is not None
        classifications = {v.classification for v in outcome.verdict.verdicts}
        assert Classification.PRE_EXISTING in classifications
        # The entire point: a pre-existing failure is reported, never auto-patched.
        assert outcome.verdict.hotfix_candidates == []
        assert outcome.verdict.pre_existing


class TestCleanRollout:
    """Neither variant is buggy: nothing to do."""

    async def test_no_findings_and_promotable(self, monkeypatch) -> None:
        orch, _engine = make_orchestrator(
            {Variant.BASELINE: False, Variant.INITIAL: False}, monkeypatch
        )
        monkeypatch.setattr(orch, "remediate_phase", _no_remediation)
        monkeypatch.setattr(orch, "verify_phase", _no_verification)

        outcome = await orch.run()

        assert outcome.state is RunState.COMPLETED
        assert outcome.verdict is not None
        assert outcome.verdict.findings == []
        assert outcome.verdict.safe_to_promote


class TestVerificationGate:
    """The three-way verification decides promotion."""

    async def test_regression_in_verification_blocks_promotion(self, monkeypatch) -> None:
        orch, _ = make_orchestrator(
            {Variant.BASELINE: False, Variant.INITIAL: True}, monkeypatch
        )

        finding = _fake_finding(Classification.STILL_BROKEN)
        attempt = HotfixAttempt(id="hfx_1", finding=finding, merged_sha="d" * 40, branch="sandman/hotfix-1")

        # Stage a verification whose HOTFIX lane regressed a previously-stable probe.
        from sandman.verdict import evaluate

        results = _staged_results(baseline=True, initial=True, hotfix=False)
        verdict = evaluate("run_test", results, require_hotfix=True)
        assert not verdict.safe_to_promote

        await orch.promote_phase([attempt], verdict)
        assert attempt.state == "verification_failed"
        assert attempt.promoted is False

    async def test_clean_verification_opens_the_gate(self, monkeypatch) -> None:
        orch, _ = make_orchestrator(
            {Variant.BASELINE: False, Variant.INITIAL: True}, monkeypatch
        )
        orch.config.promotion.auto_promote = False

        finding = _fake_finding(Classification.STILL_BROKEN)
        attempt = HotfixAttempt(id="hfx_1", finding=finding, merged_sha="d" * 40, branch="sandman/hotfix-1")

        from sandman.verdict import evaluate

        results = _staged_results(baseline=True, initial=False, hotfix=True)  # RESTORED
        verdict = evaluate("run_test", results, require_hotfix=True)
        assert verdict.safe_to_promote

        await orch.promote_phase([attempt], verdict)
        # Gate open, but a human still turns the key when auto_promote is off.
        assert attempt.state == "awaiting_promotion"

    async def test_auto_promote_promotes(self, monkeypatch) -> None:
        orch, _ = make_orchestrator(
            {Variant.BASELINE: False, Variant.INITIAL: True}, monkeypatch
        )
        orch.config.promotion.auto_promote = True

        finding = _fake_finding(Classification.STILL_BROKEN)
        attempt = HotfixAttempt(id="hfx_1", finding=finding, merged_sha="d" * 40)

        from sandman.verdict import evaluate

        results = _staged_results(baseline=True, initial=False, hotfix=True)
        verdict = evaluate("run_test", results, require_hotfix=True)

        await orch.promote_phase([attempt], verdict)
        assert attempt.promoted is True
        assert attempt.state == "promoted"


class TestBudgetAbort:
    async def test_run_aborts_when_preflight_exceeds_budget(self, monkeypatch) -> None:
        cfg = probe_config()
        cfg.budget = BudgetCaps(max_usd_per_run=0.0001)
        for v in cfg.variants:
            cfg.variants[v].replicas = 400
        orch = Orchestrator(cfg, bus=RunEventBus("run_budget"), run_id="run_budget")
        orch.settings.sandman_memory_enabled = False

        async def fake_resolve(owner: str, repo: str) -> dict[Variant, Revision]:
            return {
                Variant.BASELINE: Revision(ref="main", sha="b" * 40),
                Variant.INITIAL: Revision(ref="main", sha="c" * 40),
            }

        monkeypatch.setattr(orch, "resolve_revisions", fake_resolve)
        outcome = await orch.run()
        assert outcome.state is RunState.FAILED
        assert "cost" in (outcome.error or "").lower() or "cap" in (outcome.error or "").lower()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _no_remediation(*args, **kwargs) -> list:
    return []


async def _no_verification(*args, **kwargs) -> tuple[list, None]:
    return [], None


def _fake_finding(classification: Classification):
    from sandman.models import Finding, Severity

    return Finding(
        id="fnd_1",
        run_id="run_test",
        probe_id="items",
        classification=classification,
        severity=Severity.HIGH,
        title="x",
        description="y",
    )


def _staged_results(*, baseline: bool, initial: bool, hotfix: bool) -> list[ProbeResult]:
    from sandman.models import BehavioralSignature, ProbeOutcome

    out: list[ProbeResult] = []
    for variant, passed in (
        (Variant.BASELINE, baseline),
        (Variant.INITIAL, initial),
        (Variant.HOTFIX, hotfix),
    ):
        for i in range(3):
            out.append(
                ProbeResult(
                    probe_id="items",
                    variant=variant,
                    unit_index=i,
                    outcome=ProbeOutcome.PASS if passed else ProbeOutcome.FAIL,
                    signature=BehavioralSignature.from_observation(
                        status_code=200 if passed else 500, body={"ok": passed}
                    ),
                )
            )
    return out


class TestHotfixNeverTargetsLkg:
    """A hotfix pull request must never be opened against the LKG branch.

    LKG is the branch this product exists to protect. A patch reaches it only
    after being merged to a standalone branch and re-probed three-way, so
    opening the PR against LKG directly would put an unverified change one
    click from production. This was a real defect: the code targeted
    `config.lkg_branch` while the comment beside it claimed otherwise, and a
    live run opened exactly such a pull request.
    """

    def test_pr_base_is_a_standalone_branch(self) -> None:
        import inspect

        from sandman import orchestrator

        source = inspect.getsource(orchestrator.Orchestrator._review_and_merge)
        assert "base=verify_branch" in source, "the PR must target the standalone branch"
        assert "base=self.config.lkg_branch" not in source, (
            "a hotfix PR must never be opened against the LKG branch"
        )

    def test_verify_branch_is_namespaced_and_distinct(self) -> None:
        from sandman.config import ProjectConfig

        cfg = ProjectConfig(
            repository_url="https://github.com/acme/widgets",
            lkg_branch="main",
            probes=[{"id": "p", "preset": "api-fuzz-differential"}],
        )
        finding = _fake_finding(Classification.STILL_BROKEN)
        attempt = HotfixAttempt(id="hfx_abc", finding=finding)
        verify = f"{cfg.hotfix_branch_prefix}-verify-{attempt.id}"
        hotfix = f"{cfg.hotfix_branch_prefix}-{attempt.id}"

        assert verify != hotfix, "head and base must differ or the PR is empty"
        assert verify.startswith("sandman/"), "cleanup only deletes sandman/* branches"
        assert verify != cfg.lkg_branch

    def test_review_timeout_is_bounded(self) -> None:
        """A missing Greptile App must not stall a hotfix for a quarter hour."""
        from sandman.config import PromotionPolicy

        assert PromotionPolicy().review_timeout_seconds <= 600


class TestHotfixAttemptCap:
    def test_default_cap_is_small(self) -> None:
        from sandman.config import PromotionPolicy

        assert PromotionPolicy().max_hotfix_attempts <= 5

    def test_capped_and_worst_first(self) -> None:
        """One bug seen by five probes is five findings, not five bugs."""
        from sandman.config import PromotionPolicy

        policy = PromotionPolicy(max_hotfix_attempts=2)
        findings = [
            _fake_finding(Classification.STILL_BROKEN),
            _fake_finding(Classification.REGRESSION),
            _fake_finding(Classification.HOTFIX_INDUCED),
        ]
        ordered = sorted(findings, key=lambda f: f.classification.severity)
        chosen = ordered[: policy.max_hotfix_attempts]

        assert len(chosen) == 2
        assert chosen[0].classification is Classification.REGRESSION
        assert Classification.STILL_BROKEN not in {f.classification for f in chosen}
