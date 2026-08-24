"""The control-plane HTTP surface.

These exercise the API the dashboard actually calls, with the orchestrator
stubbed so nothing provisions a sandbox. What is under test is the contract:
status codes, response shapes, and the two behaviours that matter operationally
-- that readiness names what is missing rather than failing opaquely, and that
starting a run returns immediately instead of blocking for the length of a
fan-out.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sandman import api
from sandman.config import ProjectConfig
from sandman.models import Classification, ProbeVerdict, RunState, Variant
from sandman.orchestrator import RunOutcome
from sandman.verdict import RunVerdict, build_findings


@pytest.fixture
def client() -> TestClient:
    return TestClient(api.app)


@pytest.fixture(autouse=True)
def clean_registry():
    api._RUNS.clear()
    api._TASKS.clear()
    api._CONFIGS.clear()
    yield
    api._RUNS.clear()
    api._TASKS.clear()
    api._CONFIGS.clear()


def sample_config() -> dict:
    cfg = ProjectConfig(
        repository_url="https://github.com/acme/widgets",
        lkg_branch="main",
        probes=[{"id": "p", "preset": "api-fuzz-differential", "fanout": 2}],
    )
    return cfg.model_dump(mode="json")


def sample_verdict(classification: Classification) -> RunVerdict:
    pattern = {
        Classification.REGRESSION: (True, True, False),
        Classification.PRE_EXISTING: (False, False, False),
        Classification.RESTORED: (True, False, True),
    }[classification]
    verdict = ProbeVerdict(
        probe_id="p",
        classification=classification,
        baseline_passed=pattern[0],
        initial_passed=pattern[1],
        hotfix_passed=pattern[2],
        sample_size={Variant.BASELINE: 3, Variant.INITIAL: 3, Variant.HOTFIX: 3},
    )
    return RunVerdict(verdicts=[verdict], findings=build_findings("run_x", [verdict]))


class TestHealthAndReadiness:
    def test_health(self, client: TestClient) -> None:
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_readiness_lists_every_capability(self, client: TestClient) -> None:
        r = client.get("/api/readiness")
        assert r.status_code == 200
        body = r.json()
        names = {c["name"] for c in body["capabilities"]}
        assert names == {"modal", "codex", "greptile", "github", "stripe", "secrets"}

    def test_unconfigured_capability_names_the_variables(self, client: TestClient) -> None:
        """An unconfigured control plane must say exactly what is missing.

        Otherwise it surfaces minutes into a run as an opaque failure.
        """
        body = client.get("/api/readiness").json()
        for capability in body["capabilities"]:
            if not capability["configured"]:
                assert capability["missing"], f"{capability['name']} is unconfigured but names nothing"
                assert all(name.isupper() for name in capability["missing"])


class TestPresets:
    def test_returns_the_four_presets(self, client: TestClient) -> None:
        body = client.get("/api/presets").json()
        ids = {p["id"] for p in body["presets"]}
        assert ids == {
            "api-fuzz-differential",
            "load-chaos-fanout",
            "security-probe-suite",
            "latency-slo-guard",
        }
        assert all(p["description"] for p in body["presets"])


class TestConfigValidation:
    def test_reports_fanout_and_projected_cost(self, client: TestClient) -> None:
        r = client.post("/api/config/validate", json=sample_config())
        assert r.status_code == 200
        body = r.json()
        assert body["valid"] is True
        assert body["probeCount"] == 1
        assert body["totalFanout"] > 0
        assert body["projectedWorstCaseUsd"] >= 0
        assert isinstance(body["withinBudget"], bool)

    def test_rejects_a_credential_bearing_probe_header(self, client: TestClient) -> None:
        cfg = sample_config()
        cfg["probes"][0]["params"] = {"headers": {"Authorization": "Bearer x"}}
        r = client.post("/api/config/validate", json=cfg)
        assert r.status_code == 422

    def test_rejects_credentials_in_the_repository_url(self, client: TestClient) -> None:
        cfg = sample_config()
        cfg["repository_url"] = "https://user:token@github.com/acme/widgets"
        r = client.post("/api/config/validate", json=cfg)
        assert r.status_code == 422


class TestRuns:
    def test_start_returns_immediately_with_a_stream_url(
        self, client: TestClient, monkeypatch
    ) -> None:
        """A fan-out outlives any request deadline, so this must not block."""

        async def instant(self) -> RunOutcome:
            self.outcome.state = RunState.COMPLETED
            return self.outcome

        monkeypatch.setattr(api.Orchestrator, "run", instant)

        r = client.post("/api/runs", json={"config": sample_config()})
        assert r.status_code == 202
        body = r.json()
        assert body["run_id"].startswith("run_")
        assert body["stream_url"] == f"/api/runs/{body['run_id']}/stream"
        assert body["state"] == "queued"

    def test_unknown_run_is_404(self, client: TestClient) -> None:
        assert client.get("/api/runs/run_nope").status_code == 404
        assert client.get("/api/runs/run_nope/verdicts").status_code == 404
        assert client.get("/api/runs/run_nope/hotfixes").status_code == 404
        assert client.post("/api/runs/run_nope/abort").status_code == 404
        assert client.get("/api/runs/run_nope/stream").status_code == 404

    def test_list_runs_is_empty_initially(self, client: TestClient) -> None:
        assert client.get("/api/runs").json() == {"runs": []}


class TestVerdictsEndpoint:
    def _seed(self, classification: Classification) -> str:
        outcome = RunOutcome(run_id="run_seed", state=RunState.COMPLETED)
        outcome.verdict = sample_verdict(classification)
        api._RUNS["run_seed"] = outcome
        return "run_seed"

    def test_regression_sorts_first_and_is_blocking(self, client: TestClient) -> None:
        run_id = self._seed(Classification.REGRESSION)
        body = client.get(f"/api/runs/{run_id}/verdicts").json()
        assert body["verdicts"][0]["classification"] == "regression"
        assert body["verdicts"][0]["severity"] == 0
        assert body["safeToPromote"] is False
        assert body["counts"] == {"regression": 1}

    def test_pre_existing_is_reported_and_marked(self, client: TestClient) -> None:
        """The whole reason the baseline lane exists."""
        run_id = self._seed(Classification.PRE_EXISTING)
        body = client.get(f"/api/runs/{run_id}/verdicts").json()
        assert body["verdicts"][0]["classification"] == "pre_existing"
        finding = body["findings"][0]
        assert finding["previouslyIgnored"] is True
        # Not attributed to this rollout, so it must not block promotion.
        assert body["safeToPromote"] is True

    def test_restored_is_safe_to_promote(self, client: TestClient) -> None:
        run_id = self._seed(Classification.RESTORED)
        body = client.get(f"/api/runs/{run_id}/verdicts").json()
        assert body["safeToPromote"] is True

    def test_camel_case_keys_match_the_web_client(self, client: TestClient) -> None:
        run_id = self._seed(Classification.REGRESSION)
        v = client.get(f"/api/runs/{run_id}/verdicts").json()["verdicts"][0]
        for key in (
            "probeId",
            "baselinePassed",
            "initialPassed",
            "hotfixPassed",
            "behaviourChanged",
            "flakeSuspected",
            "sampleSize",
        ):
            assert key in v, f"{key} missing; the TypeScript client expects it"

    def test_run_with_no_verdict_returns_empty_rather_than_erroring(
        self, client: TestClient
    ) -> None:
        api._RUNS["run_bare"] = RunOutcome(run_id="run_bare", state=RunState.QUEUED)
        body = client.get("/api/runs/run_bare/verdicts").json()
        assert body == {"verdicts": [], "findings": [], "counts": {}}


class TestMemoryStatus:
    def test_reports_availability_without_raising(self, client: TestClient) -> None:
        """Memory is an enhancement; the endpoint must answer either way."""
        r = client.get("/api/memory/status")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"enabled", "available", "version", "baseUrl"}
        assert isinstance(body["available"], bool)
