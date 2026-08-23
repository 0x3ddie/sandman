from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _positive_environment_integer(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    default_runtime: str = "demo"
    modal_app_name: str = "sandman-production-probes"
    github_token: str | None = None
    codex_executable: str = "codex"
    codex_timeout_seconds: int = 900
    state_database_path: Path | None = None

    @classmethod
    def from_environment(cls) -> Settings:
        return cls(
            default_runtime=os.getenv("SANDMAN_DEFAULT_RUNTIME", "demo"),
            modal_app_name=os.getenv("SANDMAN_MODAL_APP_NAME", "sandman-production-probes"),
            github_token=os.getenv("GITHUB_TOKEN") or None,
            codex_executable=os.getenv("SANDMAN_CODEX_EXECUTABLE", "codex"),
            codex_timeout_seconds=_positive_environment_integer(
                "SANDMAN_CODEX_TIMEOUT_SECONDS", 900
            ),
            state_database_path=(
                Path(database_path)
                if (database_path := os.getenv("SANDMAN_STATE_DATABASE"))
                else None
            ),
        )
