from __future__ import annotations

from collections.abc import Mapping
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


class SandmanCommentCommand(BaseModel):
    model_config = ConfigDict(frozen=True)

    probe: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")
    known_good_ref: str = Field(pattern=r"^[A-Za-z0-9._/-]{1,200}$")
    known_good_sha: str = Field(pattern=r"^[0-9a-fA-F]{40}$")

    @property
    def known_good(self) -> str:
        return f"{self.known_good_ref}@{self.known_good_sha.lower()}"


class GitHubCommentContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    probe: str
    known_good: str
    current: str
    current_sha: str
    current_ref: str
    pull_request_number: int = Field(ge=1)

    def github_outputs(self) -> str:
        return "\n".join(
            f"{name}={value}"
            for name, value in (
                ("probe", self.probe),
                ("known_good", self.known_good),
                ("current", self.current),
                ("current_sha", self.current_sha),
                ("current_ref", self.current_ref),
                ("pull_request_number", str(self.pull_request_number)),
            )
        )


def parse_sandman_comment(body: str) -> SandmanCommentCommand:
    tokens = body.strip().split()
    if not tokens or tokens[0] != "/sandman":
        raise ValueError("comment must start with /sandman")
    options: dict[str, str] = {}
    for token in tokens[1:]:
        if "=" not in token:
            raise ValueError("arguments must use name=value syntax")
        name, value = token.split("=", maxsplit=1)
        if name not in {"probe", "known-good"}:
            raise ValueError(f"unsupported /sandman argument: {name}")
        if name in options:
            raise ValueError(f"duplicate /sandman argument: {name}")
        options[name] = value
    if set(options) != {"probe", "known-good"}:
        raise ValueError("/sandman requires probe and known-good")
    try:
        known_good_ref, known_good_sha = options["known-good"].rsplit("@", maxsplit=1)
    except ValueError as error:
        raise ValueError("known-good must use REF@SHA format") from error
    return SandmanCommentCommand(
        probe=options["probe"],
        known_good_ref=known_good_ref,
        known_good_sha=known_good_sha,
    )


def resolve_sandman_comment(
    event: Mapping[str, Any],
    token: str,
    transport: httpx.BaseTransport | None = None,
) -> GitHubCommentContext:
    comment = _required_mapping(event, "comment")
    issue = _required_mapping(event, "issue")
    repository = _required_mapping(event, "repository")
    if "pull_request" not in issue:
        raise ValueError("/sandman can only run on a pull request comment")
    command = parse_sandman_comment(str(comment.get("body", "")))
    repository_name = str(repository.get("full_name", ""))
    try:
        pull_request_number = int(issue.get("number", 0))
    except (TypeError, ValueError) as error:
        raise ValueError("GitHub event has an invalid pull request number") from error
    if not repository_name or pull_request_number < 1:
        raise ValueError("GitHub event is missing repository or pull request context")
    url = f"https://api.github.com/repos/{repository_name}/pulls/{pull_request_number}"
    with httpx.Client(timeout=20, transport=transport) as client:
        response = client.get(url, headers=_github_headers(token))
    if response.status_code != 200:
        raise RuntimeError(f"could not load pull request: {_github_error(response)}")
    pull_request: dict[str, Any] = response.json()
    head = _required_mapping(pull_request, "head")
    head_repository = _required_mapping(head, "repo")
    if str(head_repository.get("full_name", "")) != repository_name:
        raise ValueError("/sandman currently requires a branch in the target repository")
    current_ref = str(head.get("ref", ""))
    current_sha = str(head.get("sha", "")).lower()
    if not current_ref or not _is_commit_sha(current_sha):
        raise ValueError("pull request head is missing an exact revision")
    return GitHubCommentContext(
        probe=command.probe,
        known_good=command.known_good,
        current=f"{current_ref}@{current_sha}",
        current_sha=current_sha,
        current_ref=current_ref,
        pull_request_number=pull_request_number,
    )


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


def _required_mapping(value: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    nested = value.get(key)
    if not isinstance(nested, dict):
        raise ValueError(f"GitHub event is missing {key}")
    return nested


def _is_commit_sha(value: str) -> bool:
    return len(value) == 40 and all(character in "0123456789abcdef" for character in value)
