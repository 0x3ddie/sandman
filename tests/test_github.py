from __future__ import annotations

from datetime import UTC, datetime

from sandman.comparison import classify
from sandman.github import build_pull_request_body
from sandman.models import (
    InvestigationReport,
    InvestigationRequest,
    Lane,
    LaneResult,
    Observation,
    Revision,
)


def test_pull_request_body_contains_evidence_and_greptile_handoff() -> None:
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
    report = InvestigationReport(
        investigation_id="abc123",
        request=request,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        results=typed_results,
        verdict=classify(typed_results),
    )

    body = build_pull_request_body(report)

    assert "Candidate fixes the reproduced regression" in body
    assert "@greptileai" in body
    assert "sandman-investigation:abc123" in body
