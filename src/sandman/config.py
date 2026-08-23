from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Settings:
    default_runtime: str = "demo"
    modal_app_name: str = "sandman-production-probes"
    github_token: str | None = None

    @classmethod
    def from_environment(cls) -> Settings:
        return cls(
            default_runtime=os.getenv("SANDMAN_DEFAULT_RUNTIME", "demo"),
            modal_app_name=os.getenv("SANDMAN_MODAL_APP_NAME", "sandman-production-probes"),
            github_token=os.getenv("GITHUB_TOKEN") or None,
        )
