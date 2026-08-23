from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx

from sandman.comparison import classify
from sandman.github import (
    GitHubCheckPublisher,
    GitHubRepository,
    build_pull_request_body,
    github_repository_from_url,
)
from sandman.models import (
    InvestigationReport,
    InvestigationRequest,
    Lane,
    LaneResult,
    Observation,
    Revision,
)


def test_pull_request_body_contains_evidence_and_greptile_handoff() -> None:
    report = investigation_report()

    body = build_pull_request_body(report)

    assert "Candidate fixes the reproduced regression" in body
    assert "@greptileai" in body
    assert "sandman-investigation:abc123" in body


def test_check_run_contains_candidate_evidence() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/example/service/check-runs"
        assert request.headers["Authorization"] == "Bearer test-token"
        payload = json.loads(request.content)
        assert payload["head_sha"] == "d" * 40
        assert payload["conclusion"] == "success"
        assert "Known Good" in payload["output"]["summary"]
        assert "@greptileai" not in payload["output"]["summary"]
        return httpx.Response(
            201,
            json={"id": 42, "html_url": "https://github.com/example/service/runs/42"},
        )

    publisher = GitHubCheckPublisher("test-token", transport=httpx.MockTransport(handler))

    result = publisher.create(
        GitHubRepository(owner="example", repository="service"),
        "d" * 40,
        investigation_report(),
    )

    assert result.check_run_id == 42
    assert result.conclusion == "success"


def test_github_repository_is_derived_from_https_url() -> None:
    repository = github_repository_from_url("https://github.com/0x3ddie/sandman.git")

    assert repository.owner == "0x3ddie"
    assert repository.repository == "sandman"


def investigation_report() -> InvestigationReport:
    revisions = tuple(
        Revision(lane=lane, git_ref=f"ref-{lane.value}", label=lane.value) for lane in Lane
    )
    request = InvestigationRequest(
        repository_url="https://example.com/repo.git",
        revisions=revisions,  # type: ignore[arg-type]
    )
    results = tuple(
        LaneResult(
            lane=revision.lane,
            revision=revision,
            sandbox_id=f"sb-{revision.lane.value}",
            observation=Observation(
                status_code=500 if revision.lane is Lane.CURRENT else 200,
                duration_ms=12,
                passed=revision.lane is not Lane.CURRENT,
            ),
        )
        for revision in revisions
    )
    typed_results = (results[0], results[1], results[2])
    return InvestigationReport(
        investigation_id="abc123",
        request=request,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        results=typed_results,
        verdict=classify(typed_results),
    )
