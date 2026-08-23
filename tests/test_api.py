from __future__ import annotations

import asyncio
import time
from pathlib import Path

import httpx

from sandman.api import create_app
from sandman.config import Settings
from sandman.remediation import (
    BranchPublication,
    BranchPublisher,
    CodexRunSummary,
    CodexTestResult,
    HotfixAgent,
    HotfixArtifact,
    HotfixRequest,
)


class FakeHotfixAgent(HotfixAgent):
    def generate(self, request: HotfixRequest) -> HotfixArtifact:
        return HotfixArtifact(
            branch_name=request.branch_name,
            base_commit_sha=request.base_commit_sha,
            patch="diff --git a/app.py b/app.py\n",
            changed_files=("app.py", "tests/test_app.py"),
            summary=CodexRunSummary(
                summary="Added currency validation and a regression test",
                tests=(),
                notes=(),
            ),
        )


class FakeBranchPublisher(BranchPublisher):
    def publish(self, request: HotfixRequest, artifact: HotfixArtifact) -> BranchPublication:
        return BranchPublication(branch_name=request.branch_name, commit_sha="b" * 40)


class FailingTestHotfixAgent(HotfixAgent):
    def generate(self, request: HotfixRequest) -> HotfixArtifact:
        return (
            FakeHotfixAgent()
            .generate(request)
            .model_copy(
                update={
                    "summary": CodexRunSummary(
                        summary="Patch still fails its regression test",
                        tests=(
                            CodexTestResult(
                                command="pytest tests/test_checkout.py", outcome="failed"
                            ),
                        ),
                        notes=(),
                    )
                }
            )
        )


async def test_demo_investigation_completes() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/investigations",
            json={
                "repository_url": "https://example.com/repo.git",
                "revisions": [
                    {"lane": "known_good", "git_ref": "v1", "label": "Known good"},
                    {"lane": "current", "git_ref": "main", "label": "Current"},
                    {"lane": "candidate", "git_ref": "fix", "label": "Candidate"},
                ],
                "runtime": "demo",
                "probe": {"method": "POST", "path": "/quote", "expected_status": 200},
            },
        )
        assert response.status_code == 202
        investigation_id = response.json()["investigation_id"]

        deadline = time.monotonic() + 2
        record = None
        while time.monotonic() < deadline:
            status_response = await client.get(f"/api/investigations/{investigation_id}")
            record = status_response.json()
            if record["state"] == "completed":
                break
            await asyncio.sleep(0.02)

        assert record is not None
        assert record["state"] == "completed"
        assert record["report"]["verdict"]["kind"] == "candidate_verified"


async def test_investigation_survives_app_restart(tmp_path: Path) -> None:
    settings = Settings(state_database_path=tmp_path / "sandman.db")
    transport = httpx.ASGITransport(app=create_app(settings=settings))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/investigations",
            json={
                "repository_url": "https://example.com/repo.git",
                "revisions": [
                    {"lane": "known_good", "git_ref": "v1", "label": "Known good"},
                    {"lane": "current", "git_ref": "main", "label": "Current"},
                    {"lane": "candidate", "git_ref": "fix", "label": "Candidate"},
                ],
                "runtime": "demo",
                "probe": {"method": "GET", "path": "/health", "expected_status": 200},
            },
        )
        investigation_id = response.json()["investigation_id"]
        completed = await wait_until_complete(client, investigation_id)
        assert completed["state"] == "completed"

    restarted_transport = httpx.ASGITransport(app=create_app(settings=settings))
    async with httpx.AsyncClient(
        transport=restarted_transport, base_url="http://test"
    ) as restarted_client:
        restored = await restarted_client.get(f"/api/investigations/{investigation_id}")

    assert restored.status_code == 200
    assert restored.json()["report"]["verdict"]["kind"] == "candidate_verified"


async def test_pull_request_requires_configured_token() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/investigations",
            json={
                "repository_url": "https://github.com/example/service",
                "revisions": [
                    {"lane": "known_good", "git_ref": "v1", "label": "Known good"},
                    {"lane": "current", "git_ref": "main", "label": "Current"},
                    {"lane": "candidate", "git_ref": "fix", "label": "Candidate"},
                ],
                "runtime": "demo",
                "probe": {"method": "GET", "path": "/health", "expected_status": 200},
            },
        )
        investigation_id = response.json()["investigation_id"]
        record = await wait_until_complete(client, investigation_id)
        assert record["report"]["verdict"]["safe_to_review"] is True

        pull_request = await client.post(
            f"/api/investigations/{investigation_id}/pull-requests",
            json={
                "owner": "example",
                "repository": "service",
                "head": "fix",
                "base": "main",
                "title": "fix: checkout regression",
            },
        )

        assert pull_request.status_code == 503
        assert pull_request.json()["detail"] == "GITHUB_TOKEN is not configured"


async def test_pull_request_rejects_unverified_candidate_before_token_check() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/investigations",
            json={
                "repository_url": "https://github.com/example/service",
                "revisions": [
                    {"lane": "known_good", "git_ref": "v1", "label": "Known good"},
                    {"lane": "current", "git_ref": "main", "label": "Current"},
                    {"lane": "candidate", "git_ref": "fix", "label": "Candidate"},
                ],
                "runtime": "demo",
                "probe": {"method": "GET", "path": "/health", "expected_status": 201},
            },
        )
        investigation_id = response.json()["investigation_id"]
        await wait_until_complete(client, investigation_id)

        pull_request = await client.post(
            f"/api/investigations/{investigation_id}/pull-requests",
            json={
                "owner": "example",
                "repository": "service",
                "head": "fix",
                "base": "main",
                "title": "fix: unverified change",
            },
        )

        assert pull_request.status_code == 409
        assert pull_request.json()["detail"] == "Candidate has not been verified"


async def test_hotfix_generation_publication_and_verification_flow() -> None:
    app = create_app(
        hotfix_agent_override=FakeHotfixAgent(),
        branch_publisher_override=FakeBranchPublisher(),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/hotfixes", json=hotfix_payload())
        assert response.status_code == 202
        hotfix_id = response.json()["hotfix_id"]
        hotfix = await wait_until_hotfix_complete(client, hotfix_id)
        assert hotfix["artifact"]["changed_files"] == ["app.py", "tests/test_app.py"]

        publication = await client.post(f"/api/hotfixes/{hotfix_id}/publish")
        assert publication.status_code == 200
        assert publication.json()["artifact"]["published_commit_sha"] == "b" * 40

        verification = await client.post(
            f"/api/hotfixes/{hotfix_id}/investigations",
            json={
                "known_good_ref": "v1.0.0",
                "known_good_commit_sha": "c" * 40,
                "startup_command": ["python", "app.py"],
                "service_port": 8000,
                "health_path": "/health",
                "runtime": "demo",
            },
        )
        assert verification.status_code == 202
        investigation_id = verification.json()["investigation_id"]
        investigation = await wait_until_complete(client, investigation_id)
        assert investigation["report"]["verdict"]["kind"] == "candidate_verified"


async def test_hotfix_publication_requires_configured_token() -> None:
    app = create_app(hotfix_agent_override=FakeHotfixAgent())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/hotfixes", json=hotfix_payload())
        hotfix_id = response.json()["hotfix_id"]
        await wait_until_hotfix_complete(client, hotfix_id)

        publication = await client.post(f"/api/hotfixes/{hotfix_id}/publish")

        assert publication.status_code == 503
        assert publication.json()["detail"] == "GITHUB_TOKEN is not configured"


async def test_hotfix_publication_rejects_reported_test_failure() -> None:
    app = create_app(
        hotfix_agent_override=FailingTestHotfixAgent(),
        branch_publisher_override=FakeBranchPublisher(),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/hotfixes", json=hotfix_payload())
        hotfix_id = response.json()["hotfix_id"]
        await wait_until_hotfix_complete(client, hotfix_id)

        publication = await client.post(f"/api/hotfixes/{hotfix_id}/publish")

        assert publication.status_code == 409
        assert publication.json()["detail"] == "Codex reported a failing test"


def hotfix_payload() -> dict[str, object]:
    return {
        "repository_url": "https://github.com/example/service",
        "base_ref": "main",
        "base_commit_sha": "a" * 40,
        "branch_name": "sandman/fix-checkout",
        "trace": {
            "trace_id": "checkout-500",
            "redacted": True,
            "method": "POST",
            "path": "/api/checkout/quote",
            "json_body": {"currency": "USD"},
            "observed": {
                "status_code": 500,
                "json_body": {"error": "currency required"},
            },
            "expected_status": 200,
            "expected_json": {"currency": "USD"},
            "logs": ["ValueError: currency required"],
        },
        "test_guidance": ["pytest tests/test_checkout.py"],
    }


async def wait_until_complete(
    client: httpx.AsyncClient, investigation_id: str
) -> dict[str, object]:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        response = await client.get(f"/api/investigations/{investigation_id}")
        record: dict[str, object] = response.json()
        if record["state"] == "completed":
            return record
        await asyncio.sleep(0.02)
    raise AssertionError("investigation did not complete")


async def wait_until_hotfix_complete(
    client: httpx.AsyncClient, hotfix_id: str
) -> dict[str, object]:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        response = await client.get(f"/api/hotfixes/{hotfix_id}")
        record: dict[str, object] = response.json()
        if record["state"] == "completed":
            return record
        await asyncio.sleep(0.02)
    raise AssertionError("hotfix generation did not complete")
