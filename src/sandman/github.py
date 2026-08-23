from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from sandman.models import InvestigationReport, Lane


class PullRequestRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    owner: str = Field(pattern=r"^[A-Za-z0-9_.-]+$")
    repository: str = Field(pattern=r"^[A-Za-z0-9_.-]+$")
    head: str = Field(min_length=1, max_length=200)
    base: str = Field(default="main", min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=256)
    draft: bool = True

    @field_validator("head", "base")
    @classmethod
    def reject_whitespace(cls, value: str) -> str:
        if any(character.isspace() for character in value):
            raise ValueError("branch names cannot contain whitespace")
        return value


class PullRequestResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    number: int
    url: str


def build_pull_request_body(report: InvestigationReport) -> str:
    rows = []
    for result in report.results:
        observation = result.observation
        outcome = "PASS" if observation.passed else "FAIL"
        status = observation.status_code if observation.status_code is not None else "—"
        rows.append(
            f"| {result.lane.value.replace('_', ' ').title()} | "
            f"`{result.revision.git_ref}` | {outcome} | {status} | "
            f"{observation.duration_ms} ms |"
        )
    probe = report.request.probe
    candidate = next(result for result in report.results if result.lane is Lane.CANDIDATE)
    return "\n".join(
        [
            "## Sandman verification",
            "",
            report.verdict.headline,
            "",
            f"**Probe:** `{probe.method} {probe.path}`  ",
            f"**Expected status:** `{probe.expected_status}`  ",
            f"**Candidate sandbox:** `{candidate.sandbox_id}`",
            "",
            "| Lane | Revision | Result | HTTP | Latency |",
            "| --- | --- | --- | ---: | ---: |",
            *rows,
            "",
            f"> {report.verdict.detail}",
            "",
            "@greptileai Review whether this change addresses the reproduced failure "
            "without weakening validation or introducing adjacent regressions.",
            "",
            f"<!-- sandman-investigation:{report.investigation_id} -->",
        ]
    )


class GitHubPullRequestPublisher:
    def __init__(self, token: str) -> None:
        self._token = token

    def create(self, request: PullRequestRequest, report: InvestigationReport) -> PullRequestResult:
        url = f"https://api.github.com/repos/{request.owner}/{request.repository}/pulls"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self._token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        payload = {
            "title": request.title,
            "head": request.head,
            "base": request.base,
            "body": build_pull_request_body(report),
            "draft": request.draft,
        }
        with httpx.Client(timeout=20) as client:
            response = client.post(url, headers=headers, json=payload)
        if response.status_code != 201:
            detail = _github_error(response)
            raise RuntimeError(f"GitHub rejected the pull request: {detail}")
        data: dict[str, Any] = response.json()
        return PullRequestResult(number=int(data["number"]), url=str(data["html_url"]))


def _github_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    message = payload.get("message") if isinstance(payload, dict) else None
    return str(message or f"HTTP {response.status_code}")[:500]
