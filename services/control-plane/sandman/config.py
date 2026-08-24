"""Configuration: process-level settings and the per-project sandman config.

Two distinct things live here.

``Settings`` is process-level: credentials and ceilings that come from the
environment. It is read once at startup.

``ProjectConfig`` is per-target-repository: which repo, which branches, how each
of the three variants is built, which probes run, and what the budget is. It is
what a user edits in the dashboard (or commits as ``sandman.toml``).
"""

from __future__ import annotations

import tomllib
from functools import lru_cache
from pathlib import Path
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .models import BudgetCaps, Revision, Variant

# ---------------------------------------------------------------------------
# Process settings
# ---------------------------------------------------------------------------


class Settings(BaseSettings):
    """Environment-derived configuration for the control plane."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", env_prefix=""
    )

    # Modal
    modal_token_id: str | None = None
    modal_token_secret: str | None = None
    sandman_modal_app_name: str = "sandman-probes"

    # OpenAI / Codex
    openai_api_key: str | None = None
    codex_api_key: str | None = None
    sandman_model_breadth: str = "gpt-5.6-luna"
    sandman_model_hotfix: str = "gpt-5.6-terra"

    # Greptile
    greptile_api_key: str | None = None

    # GitHub
    #
    # An App is the right answer: its installation tokens are repo-scoped,
    # expire in an hour, are revocable by an org admin, and attribute commits to
    # sandman[bot]. GITHUB_TOKEN is a fallback for running against a repository
    # you already have push rights to -- it cannot be narrowed per call and
    # carries its owner's access everywhere they can reach.
    github_token: str | None = None
    github_app_id: str | None = None
    github_app_client_id: str | None = None
    github_app_client_secret: str | None = None
    github_app_private_key: str | None = None
    github_app_private_key_path: str | None = None

    # Storage
    database_url: str = "postgresql://sandman:sandman@localhost:5433/sandman"
    sandman_kek: str | None = None

    # Memory
    claude_mem_worker_port: int = 37702
    sandman_memory_enabled: bool = True

    # Stripe
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None

    # URLs
    sandman_control_plane_url: str = "http://127.0.0.1:8000"
    app_url: str = "http://localhost:3000"

    # Default ceilings
    sandman_max_concurrent_sandboxes: int = 25
    sandman_max_concurrent_llm: int = 8
    sandman_max_usd_per_run: float = 5.0

    @property
    def default_budget(self) -> BudgetCaps:
        return BudgetCaps(
            max_concurrent_sandboxes=self.sandman_max_concurrent_sandboxes,
            max_concurrent_llm=self.sandman_max_concurrent_llm,
            max_usd_per_run=self.sandman_max_usd_per_run,
        )

    @property
    def memory_base_url(self) -> str:
        return f"http://127.0.0.1:{self.claude_mem_worker_port}"

    @property
    def codex_key(self) -> str | None:
        """Codex reads its own variable but falls back to the OpenAI key."""
        return self.codex_api_key or self.openai_api_key

    @property
    def github_auth_mode(self) -> str:
        """Which GitHub credential the control plane will use."""
        if self.github_app_id and self.github_private_key_pem():
            return "app"
        if self.github_token:
            return "token"
        return "none"

    def github_private_key_pem(self) -> str | None:
        """Return the App private key, from the inline var or the file path."""
        if self.github_app_private_key:
            return self.github_app_private_key.replace("\\n", "\n")
        if self.github_app_private_key_path:
            path = Path(self.github_app_private_key_path).expanduser()
            if path.is_file():
                return path.read_text()
        return None

    def missing_for(self, capability: str) -> list[str]:
        """Which environment variables block a given capability.

        Used by the dashboard to show precisely what is unconfigured instead of
        failing at run time with an opaque error.
        """
        required: dict[str, dict[str, Any]] = {
            "modal": {
                "MODAL_TOKEN_ID": self.modal_token_id,
                "MODAL_TOKEN_SECRET": self.modal_token_secret,
            },
            "codex": {"OPENAI_API_KEY": self.codex_key},
            "greptile": {"GREPTILE_API_KEY": self.greptile_api_key},
            # Satisfied by either path. GITHUB_TOKEN is named here because it
            # is the single variable that unblocks a run; a GitHub App is the
            # better credential and is documented in SETUP.md.
            "github": {"GITHUB_TOKEN": self.github_app_id and self.github_private_key_pem()
                       or self.github_token},
            "stripe": {
                "STRIPE_SECRET_KEY": self.stripe_secret_key,
                "STRIPE_WEBHOOK_SECRET": self.stripe_webhook_secret,
            },
            "secrets": {"SANDMAN_KEK": self.sandman_kek},
        }
        if capability not in required:
            raise KeyError(f"unknown capability {capability!r}")
        return [name for name, value in required[capability].items() if not value]

    def is_configured(self, capability: str) -> bool:
        return not self.missing_for(capability)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# ---------------------------------------------------------------------------
# Project config
# ---------------------------------------------------------------------------

_FORBIDDEN_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
}


class ProbeSpec(BaseModel):
    """One probe's configuration.

    ``preset`` names a built-in suite; ``module`` names a user-authored probe
    discovered through the SDK. Exactly one must be set.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    preset: str | None = None
    module: str | None = None
    enabled: bool = True
    params: dict[str, Any] = Field(default_factory=dict)
    fanout: int = Field(default=1, ge=1, le=4000)
    """How many sub-sandboxes this probe fans out to, per variant."""

    regions: list[str] = Field(default_factory=list)
    timeout_seconds: int = Field(default=120, ge=1, le=86_400)

    @model_validator(mode="after")
    def _exactly_one_source(self) -> Self:
        if bool(self.preset) == bool(self.module):
            raise ValueError(
                f"probe {self.id!r} must set exactly one of 'preset' or 'module'"
            )
        return self

    @field_validator("params")
    @classmethod
    def _no_credentials(cls, v: dict[str, Any]) -> dict[str, Any]:
        """Reject credentials in probe parameters.

        Probes run inside disposable sandboxes against replicas. Accepting an
        auth header here is how a pen-test tool turns into a credential leak.
        """
        headers = v.get("headers")
        if isinstance(headers, dict):
            for key in headers:
                if str(key).lower() in _FORBIDDEN_HEADERS:
                    raise ValueError(
                        f"probe header {key!r} is not allowed: sandman probes must not "
                        "carry credentials, cookies, or auth tokens"
                    )
        return v


class VariantConfig(BaseModel):
    """How one of the three sandbox variants is built and fanned out."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    image: str = "python:3.12-slim"
    setup_commands: list[str] = Field(default_factory=list)
    startup_command: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    port: int = Field(default=8000, ge=1, le=65535)
    health_path: str = "/health"
    regions: list[str] = Field(default_factory=list)
    replicas: int = Field(default=1, ge=1, le=4000)
    """Fan-out width for this variant."""

    cpu: float = Field(default=1.0, gt=0, le=64)
    memory_mb: int = Field(default=1024, ge=128, le=131_072)
    timeout_seconds: int = Field(default=600, ge=30, le=86_400)
    """Explicitly set, always. Modal's default sandbox timeout is 5 minutes and
    a longer probe would otherwise be killed with no diagnostic."""

    @field_validator("env")
    @classmethod
    def _no_secrets_in_env(cls, v: dict[str, str]) -> dict[str, str]:
        for key in v:
            lowered = key.lower()
            if any(tok in lowered for tok in ("secret", "password", "token", "api_key")):
                raise ValueError(
                    f"variant env {key!r} looks like a credential; attach secrets through "
                    "the encrypted secret store instead of the project config"
                )
        return v


class PromotionPolicy(BaseModel):
    """When a verified hotfix may be promoted to the LKG branch."""

    model_config = ConfigDict(extra="forbid")

    require_greptile_approval: bool = True
    review_timeout_seconds: int = Field(default=300, ge=30, le=3600)
    """How long to wait for a Greptile review before failing closed.

    Reviews normally land in about three minutes. The old 15-minute default
    meant a repository without the Greptile App installed stalled every hotfix
    for a quarter of an hour before reporting anything."""
    require_reprobe: bool = True
    """Re-run the full fan-out against the merged standalone branch before LKG."""

    block_on_regression: bool = True
    block_on_new_findings: bool = True
    auto_promote: bool = False
    """When False the LKG merge is prepared and gated on an explicit human action."""

    max_patch_lines: int = Field(default=400, ge=1)
    protected_paths: list[str] = Field(
        default_factory=lambda: [
            ".github/**",
            ".greptile/**",
            "**/*.pem",
            "**/*.key",
            ".env*",
            "sandman.toml",
            "AGENTS.md",
            "CLAUDE.md",
        ]
    )
    """Paths a generated patch may never touch. Greptile also refuses to
    auto-approve changes to auth, secrets, billing, migrations, infra, and CI, so
    a patch reaching into these would stall the pipeline anyway."""


class ProjectConfig(BaseModel):
    """Everything sandman needs to investigate one repository."""

    model_config = ConfigDict(extra="forbid")

    version: int = 1
    repository_url: str
    lkg_branch: str = "main"
    hotfix_branch_prefix: str = "sandman/hotfix"
    previous_lkg: str | None = None
    """``REF@SHA`` for the baseline lane. When omitted it is resolved as the
    second-newest merge on the LKG branch."""

    variants: dict[Variant, VariantConfig] = Field(default_factory=dict)
    probes: list[ProbeSpec] = Field(default_factory=list)
    budget: BudgetCaps = Field(default_factory=BudgetCaps)
    promotion: PromotionPolicy = Field(default_factory=PromotionPolicy)
    custom_probe_paths: list[str] = Field(default_factory=lambda: ["sandman_probes"])

    @field_validator("repository_url")
    @classmethod
    def _credential_free_url(cls, v: str) -> str:
        """Reject credentials embedded in the clone URL."""
        if "@" in v.split("//", 1)[-1].split("/", 1)[0]:
            raise ValueError(
                "repository_url must not embed credentials; use the GitHub App installation"
            )
        if not v.startswith(("https://", "git@")):
            raise ValueError("repository_url must be an https:// or git@ URL")
        return v

    @model_validator(mode="after")
    def _defaults_and_uniqueness(self) -> Self:
        for variant in Variant:
            self.variants.setdefault(variant, VariantConfig())
        seen: set[str] = set()
        for probe in self.probes:
            if probe.id in seen:
                raise ValueError(f"duplicate probe id {probe.id!r}")
            seen.add(probe.id)
        return self

    @property
    def enabled_probes(self) -> list[ProbeSpec]:
        return [p for p in self.probes if p.enabled]

    @property
    def active_variants(self) -> list[Variant]:
        from .models import VARIANT_ORDER

        return [v for v in VARIANT_ORDER if self.variants[v].enabled]

    def total_fanout(self) -> int:
        """Worst-case sandbox count for a full run.

        Used to warn before a run starts rather than discovering the ceiling
        halfway through.
        """
        return sum(
            self.variants[variant].replicas * probe.fanout
            for variant in self.active_variants
            for probe in self.enabled_probes
        )

    def previous_lkg_revision(self) -> Revision | None:
        return Revision.parse(self.previous_lkg) if self.previous_lkg else None

    @classmethod
    def from_toml(cls, path: str | Path) -> Self:
        raw = tomllib.loads(Path(path).read_text())
        return cls.model_validate(_normalize_toml(raw))


def _normalize_toml(raw: dict[str, Any]) -> dict[str, Any]:
    """Accept the friendlier TOML shape and map it onto the model.

    TOML expresses probes as a table keyed by id; the model wants a list.
    """
    data = dict(raw)
    probes = data.get("probes")
    if isinstance(probes, dict):
        data["probes"] = [{"id": pid, **spec} for pid, spec in probes.items()]
    variants = data.get("variants")
    if isinstance(variants, dict):
        data["variants"] = {Variant(k): v for k, v in variants.items()}
    return data
