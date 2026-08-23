from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlsplit

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


class GitHubRepository(BaseModel):
    model_config = ConfigDict(frozen=True)

    owner: str = Field(pattern=r"^[A-Za-z0-9_.-]+$")
    repository: str = Field(pattern=r"^[A-Za-z0-9_.-]+$")


class CheckRunResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    check_run_id: int
    url: str
    conclusion: Literal["success", "failure"]


def github_repository_from_url(repository_url: str) -> GitHubRepository:
    parts = urlsplit(repository_url)
    path_parts = [part for part in parts.path.removesuffix(".git").split("/") if part]
    if parts.scheme != "https" or parts.hostname != "github.com" or len(path_parts) != 2:
        raise ValueError("GitHub reporting requires a github.com HTTPS repository URL")
    return GitHubRepository(owner=path_parts[0], repository=path_parts[1])


def build_pull_request_body(report: InvestigationReport) -> str:
    return "\n".join(
        [
            *_evidence_lines(report),
            "",
            "@greptileai Review whether this change addresses the reproduced failure "
            "without weakening validation or introducing adjacent regressions.",
            "",
            f"<!-- sandman-investigation:{report.investigation_id} -->",
        ]
    )


def build_check_summary(report: InvestigationReport) -> str:
    return "\n".join(_evidence_lines(report))


def _evidence_lines(report: InvestigationReport) -> list[str]:
    rows: list[str] = []
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
    return [
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
    ]


class GitHubCheckPublisher:
    def __init__(self, token: str, transport: httpx.BaseTransport | None = None) -> None:
        self._token = token
        self._transport = transport

    def create(
        self,
        repository: GitHubRepository,
        head_sha: str,
        report: InvestigationReport,
    ) -> CheckRunResult:
        conclusion: Literal["success", "failure"] = (
            "success" if report.verdict.safe_to_review else "failure"
        )
        url = f"https://api.github.com/repos/{repository.owner}/{repository.repository}/check-runs"
        payload = {
            "name": "Sandman production verification",
            "head_sha": head_sha,
            "status": "completed",
            "conclusion": conclusion,
            "output": {
                "title": report.verdict.headline,
                "summary": build_check_summary(report),
            },
        }
        with httpx.Client(timeout=20, transport=self._transport) as client:
            response = client.post(url, headers=_github_headers(self._token), json=payload)
        if response.status_code != 201:
            detail = _github_error(response)
            raise RuntimeError(f"GitHub rejected the check run: {detail}")
        data: dict[str, Any] = response.json()
        return CheckRunResult(
            check_run_id=int(data["id"]),
            url=str(data["html_url"]),
            conclusion=conclusion,
        )


class GitHubPullRequestPublisher:
    def __init__(self, token: str) -> None:
        self._token = token

    def create(self, request: PullRequestRequest, report: InvestigationReport) -> PullRequestResult:
        url = f"https://api.github.com/repos/{request.owner}/{request.repository}/pulls"
        payload = {
            "title": request.title,
            "head": request.head,
            "base": request.base,
            "body": build_pull_request_body(report),
            "draft": request.draft,
        }
        with httpx.Client(timeout=20) as client:
            response = client.post(url, headers=_github_headers(self._token), json=payload)
        if response.status_code != 201:
            detail = _github_error(response)
            raise RuntimeError(f"GitHub rejected the pull request: {detail}")
        data: dict[str, Any] = response.json()
        return PullRequestResult(number=int(data["number"]), url=str(data["html_url"]))


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _github_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    message = payload.get("message") if isinstance(payload, dict) else None
    return str(message or f"HTTP {response.status_code}")[:500]
