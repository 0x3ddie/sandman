from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import UTC, datetime
from uuid import uuid4

from sandman.comparison import classify
from sandman.models import (
    InvestigationRecord,
    InvestigationReport,
    InvestigationRequest,
    Lane,
    RunState,
    RuntimeName,
)
from sandman.runtime import SandboxRuntime


class InvestigationStore:
    def __init__(self) -> None:
        self._records: dict[str, InvestigationRecord] = {}

    def create(self) -> InvestigationRecord:
        investigation_id = uuid4().hex
        record = InvestigationRecord(investigation_id=investigation_id, state=RunState.QUEUED)
        self._records[investigation_id] = record
        return record

    def get(self, investigation_id: str) -> InvestigationRecord | None:
        return self._records.get(investigation_id)

    def update(self, record: InvestigationRecord) -> None:
        if record.investigation_id not in self._records:
            raise KeyError(record.investigation_id)
        self._records[record.investigation_id] = record


class InvestigationService:
    def __init__(
        self,
        runtimes: Mapping[RuntimeName, SandboxRuntime],
        store: InvestigationStore,
    ) -> None:
        self._runtimes = runtimes
        self._store = store

    def enqueue(self, request: InvestigationRequest) -> InvestigationRecord:
        record = self._store.create()
        self._store.update(record.model_copy(update={"state": RunState.RUNNING}))
        return record

    async def execute(self, investigation_id: str, request: InvestigationRequest) -> None:
        started_at = datetime.now(UTC)
        try:
            runtime = self._runtimes[request.runtime]
            unordered = await asyncio.gather(
                *(
                    asyncio.to_thread(runtime.probe, request, revision)
                    for revision in request.revisions
                )
            )
            by_lane = {result.lane: result for result in unordered}
            results = tuple(by_lane[lane] for lane in Lane)
            typed_results = (results[0], results[1], results[2])
            report = InvestigationReport(
                investigation_id=investigation_id,
                request=request,
                started_at=started_at,
                finished_at=datetime.now(UTC),
                results=typed_results,
                verdict=classify(typed_results),
            )
            current = self._required_record(investigation_id)
            self._store.update(
                current.model_copy(update={"state": RunState.COMPLETED, "report": report})
            )
        except (KeyError, RuntimeError, ValueError) as error:
            self._mark_failed(investigation_id, str(error))
        except Exception as error:
            self._mark_failed(investigation_id, f"investigation failed: {error}")

    def _mark_failed(self, investigation_id: str, message: str) -> None:
        current = self._required_record(investigation_id)
        self._store.update(
            current.model_copy(update={"state": RunState.FAILED, "error": message[:2_000]})
        )

    def _required_record(self, investigation_id: str) -> InvestigationRecord:
        record = self._store.get(investigation_id)
        if record is None:
            raise KeyError(f"unknown investigation: {investigation_id}")
        return record
