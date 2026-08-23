from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from sandman.config import Settings
from sandman.github import GitHubPullRequestPublisher, PullRequestRequest, PullRequestResult
from sandman.models import InvestigationRecord, InvestigationRequest, RuntimeName
from sandman.runtime import DemoSandboxRuntime, ModalSandboxRuntime, SandboxRuntime
from sandman.service import InvestigationService, InvestigationStore


def create_app(
    settings: Settings | None = None,
    runtime_overrides: dict[RuntimeName, SandboxRuntime] | None = None,
) -> FastAPI:
    active_settings = settings or Settings.from_environment()
    store = InvestigationStore()
    runtimes: dict[RuntimeName, SandboxRuntime] = {
        RuntimeName.DEMO: DemoSandboxRuntime(),
        RuntimeName.MODAL: ModalSandboxRuntime(active_settings.modal_app_name),
    }
    if runtime_overrides:
        runtimes.update(runtime_overrides)
    service = InvestigationService(runtimes, store)
    tasks: set[asyncio.Task[None]] = set()

    app = FastAPI(
        title="Sandman",
        version="0.1.0",
        description="Differential production debugging across isolated revisions.",
    )
    app.state.store = store
    app.state.service = service
    app.state.tasks = tasks

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "default_runtime": active_settings.default_runtime}

    @app.post(
        "/api/investigations",
        response_model=InvestigationRecord,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_investigation(request: InvestigationRequest) -> InvestigationRecord:
        record = service.enqueue(request)
        task = asyncio.create_task(service.execute(record.investigation_id, request))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return store.get(record.investigation_id) or record

    @app.get("/api/investigations/{investigation_id}", response_model=InvestigationRecord)
    def get_investigation(investigation_id: str) -> InvestigationRecord:
        record = store.get(investigation_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Investigation not found")
        return record

    @app.post(
        "/api/investigations/{investigation_id}/pull-requests",
        response_model=PullRequestResult,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_pull_request(
        investigation_id: str, pull_request: PullRequestRequest
    ) -> PullRequestResult:
        record = store.get(investigation_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Investigation not found")
        if record.report is None:
            raise HTTPException(status_code=409, detail="Investigation is not complete")
        if not record.report.verdict.safe_to_review:
            raise HTTPException(status_code=409, detail="Candidate has not been verified")
        if active_settings.github_token is None:
            raise HTTPException(status_code=503, detail="GITHUB_TOKEN is not configured")
        publisher = GitHubPullRequestPublisher(active_settings.github_token)
        try:
            return await asyncio.to_thread(publisher.create, pull_request, record.report)
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.head("/", include_in_schema=False)
    def head() -> Response:
        return Response(status_code=200)

    return app


app = create_app()
