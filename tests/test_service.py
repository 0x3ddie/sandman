from __future__ import annotations

import time

from sandman.models import InvestigationRequest, Lane, Revision, RunState, RuntimeName
from sandman.runtime import DemoSandboxRuntime
from sandman.service import InvestigationService, InvestigationStore


def request() -> InvestigationRequest:
    revisions = tuple(Revision(lane=lane, git_ref=lane.value, label=lane.value) for lane in Lane)
    return InvestigationRequest(
        repository_url="https://example.com/repo.git",
        revisions=revisions,  # type: ignore[arg-type]
    )


async def test_executes_lanes_concurrently() -> None:
    store = InvestigationStore()
    service = InvestigationService({RuntimeName.DEMO: DemoSandboxRuntime()}, store)
    probe_request = request()
    record = service.enqueue(probe_request)

    started = time.perf_counter()
    await service.execute(record.investigation_id, probe_request)
    elapsed = time.perf_counter() - started

    completed = store.get(record.investigation_id)
    assert completed is not None
    assert completed.state is RunState.COMPLETED
    assert completed.report is not None
    assert completed.report.verdict.safe_to_review
    assert elapsed < 0.5
