from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Lane(StrEnum):
    KNOWN_GOOD = "known_good"
    CURRENT = "current"
    CANDIDATE = "candidate"


class RuntimeName(StrEnum):
    DEMO = "demo"
    MODAL = "modal"


class Revision(BaseModel):
    model_config = ConfigDict(frozen=True)

    lane: Lane
    git_ref: str = Field(min_length=1, max_length=200)
    commit_sha: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{7,40}$")
    label: str = Field(min_length=1, max_length=80)

    @field_validator("git_ref")
    @classmethod
    def validate_git_ref(cls, value: str) -> str:
        if value.startswith("-") or any(character.isspace() for character in value):
            raise ValueError("git_ref cannot start with '-' or contain whitespace")
        return value


class ProbeSpec(BaseModel):
    model_config = ConfigDict(frozen=True)

    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "GET"
    path: str = Field(default="/health", min_length=1, max_length=2_000)
    headers: dict[str, str] = Field(default_factory=dict)
    json_body: dict[str, Any] | None = None
    expected_status: int = Field(default=200, ge=100, le=599)
    expected_json: dict[str, Any] | None = None
    timeout_seconds: float = Field(default=10.0, gt=0, le=60)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        if not value.startswith("/") or value.startswith("//"):
            raise ValueError("path must be an absolute HTTP path")
        return value

    @field_validator("headers")
    @classmethod
    def reject_sensitive_headers(cls, value: dict[str, str]) -> dict[str, str]:
        sensitive = {"authorization", "cookie", "proxy-authorization", "x-api-key"}
        supplied = sensitive.intersection(name.lower() for name in value)
        if supplied:
            names = ", ".join(sorted(supplied))
            raise ValueError(f"sensitive probe headers are not accepted: {names}")
        return value


class InvestigationRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    repository_url: str
    revisions: tuple[Revision, Revision, Revision]
    startup_command: tuple[str, ...] = ("python", "-m", "http.server", "8000")
    service_port: int = Field(default=8000, ge=1, le=65_535)
    health_path: str = "/health"
    container_image: str = Field(default="python:3.12-slim", min_length=1, max_length=300)
    probe: ProbeSpec = Field(default_factory=ProbeSpec)
    runtime: RuntimeName = RuntimeName.DEMO

    @field_validator("repository_url")
    @classmethod
    def validate_repository_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
            raise ValueError("repository_url must be a credential-free HTTPS URL")
        return value.rstrip("/")

    @field_validator("startup_command")
    @classmethod
    def validate_startup_command(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if not value or any(not argument or "\x00" in argument for argument in value):
            raise ValueError("startup_command must contain non-empty arguments")
        return value

    @field_validator("health_path")
    @classmethod
    def validate_health_path(cls, value: str) -> str:
        if not value.startswith("/") or value.startswith("//"):
            raise ValueError("health_path must be an absolute HTTP path")
        return value

    @model_validator(mode="after")
    def validate_lanes(self) -> InvestigationRequest:
        lanes = {revision.lane for revision in self.revisions}
        if lanes != set(Lane):
            raise ValueError(
                "revisions must contain known_good, current, and candidate exactly once"
            )
        if self.runtime is RuntimeName.MODAL and any(
            revision.commit_sha is None for revision in self.revisions
        ):
            raise ValueError("Modal investigations require a commit SHA for every revision")
        return self


class Observation(BaseModel):
    model_config = ConfigDict(frozen=True)

    status_code: int | None = None
    body_json: Any | None = None
    body_text: str | None = None
    response_headers: dict[str, str] = Field(default_factory=dict)
    duration_ms: int = Field(ge=0)
    passed: bool
    mismatches: tuple[str, ...] = ()
    error: str | None = None


class LaneResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    lane: Lane
    revision: Revision
    sandbox_id: str
    observation: Observation


class VerdictKind(StrEnum):
    CANDIDATE_VERIFIED = "candidate_verified"
    CANDIDATE_IMPROVES_PREEXISTING = "candidate_improves_preexisting"
    REGRESSION_REPRODUCED_UNFIXED = "regression_reproduced_unfixed"
    CANDIDATE_REGRESSION = "candidate_regression"
    NO_REGRESSION_REPRODUCED = "no_regression_reproduced"
    UNRESOLVED = "unresolved"
    BASELINE_DRIFT = "baseline_drift"
    INCONCLUSIVE = "inconclusive"


class Verdict(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: VerdictKind
    headline: str
    detail: str
    safe_to_review: bool = False


class InvestigationReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    investigation_id: str
    request: InvestigationRequest
    started_at: datetime
    finished_at: datetime
    results: tuple[LaneResult, LaneResult, LaneResult]
    verdict: Verdict


class RunState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class InvestigationRecord(BaseModel):
    model_config = ConfigDict(frozen=True)

    investigation_id: str
    state: RunState
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    report: InvestigationReport | None = None
    error: str | None = None
