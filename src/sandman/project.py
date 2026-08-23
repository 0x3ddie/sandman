from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sandman.models import InvestigationRequest, ProbeSpec, Revision, RuntimeName


class ServiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    startup_command: tuple[str, ...]
    port: int = Field(ge=1, le=65_535)
    health_path: str = "/health"
    container_image: str = Field(default="python:3.12-slim", min_length=1, max_length=300)

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


class ProjectConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1] = 1
    repository_url: str
    runtime: RuntimeName = RuntimeName.DEMO
    modal_app_name: str = Field(default="sandman-production-probes", min_length=1, max_length=100)
    service: ServiceConfig
    probes: dict[str, ProbeSpec]

    @field_validator("repository_url")
    @classmethod
    def validate_repository_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
            raise ValueError("repository_url must be a credential-free HTTPS URL")
        return value.rstrip("/")

    @field_validator("probes")
    @classmethod
    def validate_probes(cls, value: dict[str, ProbeSpec]) -> dict[str, ProbeSpec]:
        if not value:
            raise ValueError("at least one named probe is required")
        for name in value:
            if (
                not name
                or len(name) > 80
                or not all(character.isalnum() or character in "._-" for character in name)
            ):
                raise ValueError(f"invalid probe name: {name}")
        return value

    def build_investigation(
        self,
        *,
        revisions: tuple[Revision, Revision, Revision],
        probe_name: str,
        runtime: RuntimeName | None = None,
    ) -> InvestigationRequest:
        try:
            probe = self.probes[probe_name]
        except KeyError as error:
            available = ", ".join(sorted(self.probes))
            raise ValueError(f"unknown probe '{probe_name}'; available: {available}") from error
        return InvestigationRequest(
            repository_url=self.repository_url,
            revisions=revisions,
            startup_command=self.service.startup_command,
            service_port=self.service.port,
            health_path=self.service.health_path,
            container_image=self.service.container_image,
            probe=probe,
            runtime=runtime or self.runtime,
        )


def load_project_config(path: Path) -> ProjectConfig:
    try:
        with path.open("rb") as config_file:
            payload = tomllib.load(config_file)
    except FileNotFoundError as error:
        raise ValueError(f"Sandman config not found: {path}") from error
    except tomllib.TOMLDecodeError as error:
        raise ValueError(f"invalid TOML in {path}: {error}") from error
    return ProjectConfig.model_validate(payload)
