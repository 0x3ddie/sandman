from __future__ import annotations

import pytest

from sandman.models import RuntimeName
from sandman.pipeline import RemediationPipeline
from sandman.remediation import (
    BranchPublication,
    BranchPublisher,
    CodexRunSummary,
    CodexTestResult,
    HotfixAgent,
    HotfixArtifact,
    HotfixRequest,
    HotfixStore,
    HotfixVerificationRequest,
    IncidentTrace,
    TraceResponse,
)
from sandman.runtime import DemoSandboxRuntime
from sandman.service import InvestigationService, InvestigationStore


class FailingTestAgent(HotfixAgent):
    def generate(self, request: HotfixRequest) -> HotfixArtifact:
        return HotfixArtifact(
            branch_name=request.branch_name,
            base_commit_sha=request.base_commit_sha,
            patch="diff --git a/app.py b/app.py\n",
            changed_files=("app.py",),
            summary=CodexRunSummary(
                summary="Attempted checkout fix",
                tests=(CodexTestResult(command="pytest", outcome="failed"),),
            ),
        )


class UnexpectedPublisher(BranchPublisher):
    def publish(self, request: HotfixRequest, artifact: HotfixArtifact) -> BranchPublication:
        raise AssertionError("a failing candidate must not be published")


async def test_pipeline_does_not_publish_when_codex_reports_failing_test() -> None:
    investigation_store = InvestigationStore()
    pipeline = RemediationPipeline(
        FailingTestAgent(),
        UnexpectedPublisher(),
        HotfixStore(),
        InvestigationService({RuntimeName.DEMO: DemoSandboxRuntime()}, investigation_store),
        investigation_store,
    )

    with pytest.raises(RuntimeError, match="Codex reported a failing test"):
        await pipeline.run(hotfix_request(), verification_request())


def hotfix_request() -> HotfixRequest:
    return HotfixRequest(
        repository_url="https://github.com/example/service",
        base_ref="main",
        base_commit_sha="a" * 40,
        branch_name="sandman/fix-checkout",
        trace=IncidentTrace(
            trace_id="checkout-500",
            redacted=True,
            method="POST",
            path="/api/checkout/quote",
            observed=TraceResponse(status_code=500),
            expected_status=200,
        ),
    )


def verification_request() -> HotfixVerificationRequest:
    return HotfixVerificationRequest(
        known_good_ref="v1.0.0",
        known_good_commit_sha="b" * 40,
        startup_command=("python", "app.py"),
        service_port=8000,
        runtime=RuntimeName.DEMO,
    )
