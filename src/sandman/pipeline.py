from __future__ import annotations

import asyncio
from dataclasses import dataclass

from sandman.models import InvestigationRecord
from sandman.remediation import (
    BranchPublisher,
    HotfixAgent,
    HotfixRecord,
    HotfixRecordState,
    HotfixRequest,
    HotfixService,
    HotfixStore,
    HotfixVerificationRequest,
)
from sandman.service import InvestigationService, InvestigationStore


@dataclass(frozen=True, slots=True)
class RemediationResult:
    hotfix: HotfixRecord
    investigation: InvestigationRecord


class RemediationPipeline:
    def __init__(
        self,
        agent: HotfixAgent,
        branch_publisher: BranchPublisher,
        hotfix_store: HotfixStore,
        investigation_service: InvestigationService,
        investigation_store: InvestigationStore,
    ) -> None:
        self._hotfix_service = HotfixService(agent, hotfix_store)
        self._branch_publisher = branch_publisher
        self._hotfix_store = hotfix_store
        self._investigation_service = investigation_service
        self._investigation_store = investigation_store

    async def run(
        self,
        request: HotfixRequest,
        verification: HotfixVerificationRequest,
    ) -> RemediationResult:
        queued = self._hotfix_service.enqueue(request)
        await self._hotfix_service.execute(queued.hotfix_id, request)
        generated = self._required_hotfix(queued.hotfix_id)
        if generated.state is not HotfixRecordState.COMPLETED or generated.artifact is None:
            raise RuntimeError(generated.error or "Codex hotfix generation failed")
        if any(test.outcome == "failed" for test in generated.artifact.summary.tests):
            raise RuntimeError("Codex reported a failing test")
        publication = await asyncio.to_thread(
            self._branch_publisher.publish,
            generated.request,
            generated.artifact,
        )
        published = self._hotfix_service.record_publication(generated.hotfix_id, publication)
        investigation_request = verification.build_investigation(published)
        investigation = self._investigation_service.enqueue(investigation_request)
        await self._investigation_service.execute(
            investigation.investigation_id,
            investigation_request,
        )
        completed = self._investigation_store.get(investigation.investigation_id)
        if completed is None or completed.report is None:
            detail = completed.error if completed is not None else "investigation disappeared"
            raise RuntimeError(detail or "candidate verification failed")
        return RemediationResult(hotfix=published, investigation=completed)

    def _required_hotfix(self, hotfix_id: str) -> HotfixRecord:
        record = self._hotfix_store.get(hotfix_id)
        if record is None:
            raise RuntimeError("hotfix disappeared")
        return record
