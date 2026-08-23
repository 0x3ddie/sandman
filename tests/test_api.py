from __future__ import annotations

import asyncio
import time

import httpx

from sandman.api import create_app


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
