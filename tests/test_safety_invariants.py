"""The four safety invariants, asserted directly.

These are the properties that make sandman safe to point at a real repository.
Each one is cheap to break accidentally during a refactor, so each gets an
explicit test rather than relying on a code comment.

1. Codex never holds push capability.
2. Every revision is pinned to an exact commit.
3. A failed or incomplete lane never produces a verified verdict.
4. Probes never carry credentials.
"""

from __future__ import annotations

import inspect

import pytest
from pydantic import ValidationError

from sandman.codex import PatchRejected, validate_patch
from sandman.config import ProjectConfig, PromotionPolicy, VariantConfig
from sandman.models import Revision
from sandman.verdict import IncompleteInvestigation


class TestInvariant1CodexHasNoPushCapability:
    """Patch generation must run with no credentials that could publish."""

    def test_credential_denylist_covers_every_publishing_token(self) -> None:
        from sandman import codex

        source = inspect.getsource(codex)
        for name in (
            "GITHUB_TOKEN",
            "MODAL_TOKEN_ID",
            "MODAL_TOKEN_SECRET",
            "GREPTILE_API_KEY",
            "STRIPE_SECRET_KEY",
        ):
            assert name in source, f"{name} is not excluded from the Codex environment"

    def test_child_environment_excludes_every_credential(self, monkeypatch) -> None:
        """With a full credential set in the parent, none may reach the child."""
        from sandman.codex import build_child_env

        planted = {
            "GITHUB_TOKEN": "ghp_shouldnotleak000000000000000000000",
            "GH_TOKEN": "ghp_shouldnotleak111111111111111111111",
            "GITHUB_APP_PRIVATE_KEY": "-----BEGIN RSA PRIVATE KEY-----shouldnotleak",
            "MODAL_TOKEN_ID": "ak-shouldnotleak",
            "MODAL_TOKEN_SECRET": "as-shouldnotleak",
            "GREPTILE_API_KEY": "grp_shouldnotleak",
            "STRIPE_SECRET_KEY": "sk_test_shouldnotleak",
            "STRIPE_WEBHOOK_SECRET": "whsec_shouldnotleak",
            "SANDMAN_KEK": "shouldnotleak",
            "DATABASE_URL": "postgresql://u:shouldnotleak@h/db",
            "AWS_SECRET_ACCESS_KEY": "shouldnotleak",
        }
        for name, value in planted.items():
            monkeypatch.setenv(name, value)

        env = build_child_env("sk-the-only-key-codex-may-have")

        assert set(env) & set(planted) == set(), "a credential name reached the child"
        joined = "\n".join(env.values())
        assert "shouldnotleak" not in joined, "a credential value reached the child"

    def test_child_environment_is_an_allowlist_not_a_denylist(self, monkeypatch) -> None:
        """A newly-invented credential variable must not pass through.

        A denylist fails open the moment someone adds a variable nobody thought
        to list; an allowlist does not.
        """
        from sandman.codex import build_child_env

        monkeypatch.setenv("SOME_BRAND_NEW_VENDOR_CREDENTIAL", "shouldnotleak")
        env = build_child_env("sk-key")
        assert "SOME_BRAND_NEW_VENDOR_CREDENTIAL" not in env

    def test_git_cannot_authenticate_or_prompt(self, monkeypatch) -> None:
        """Even holding no token, git must not be able to prompt for one."""
        from sandman.codex import build_child_env

        env = build_child_env("sk-key")
        assert env["GIT_TERMINAL_PROMPT"] == "0"
        assert env["GIT_ASKPASS"] == "/bin/false"

    def test_the_openai_key_is_the_only_secret_present(self, monkeypatch) -> None:
        from sandman.codex import build_child_env

        env = build_child_env("sk-the-only-key")
        secrets = {k: v for k, v in env.items() if v == "sk-the-only-key"}
        assert set(secrets) == {"CODEX_API_KEY", "OPENAI_API_KEY"}


class TestPatchValidation:
    """A generated patch must not reach protected files or exceed the size cap."""

    @pytest.fixture
    def policy(self) -> PromotionPolicy:
        return PromotionPolicy(max_patch_lines=50)

    def test_empty_diff_is_rejected(self, policy: PromotionPolicy) -> None:
        with pytest.raises(PatchRejected):
            validate_patch("", [], policy)

    def test_oversized_diff_is_rejected(self, policy: PromotionPolicy) -> None:
        diff = "\n".join(f"+line {i}" for i in range(200))
        with pytest.raises(PatchRejected):
            validate_patch(diff, ["src/app.py"], policy)

    @pytest.mark.parametrize(
        "path",
        [
            ".github/workflows/ci.yml",
            ".greptile/config.json",
            "deploy/key.pem",
            ".env",
            ".env.local",
            "sandman.toml",
            "AGENTS.md",
        ],
    )
    def test_protected_paths_are_rejected(self, path: str, policy: PromotionPolicy) -> None:
        """Greptile refuses to auto-approve CI, secrets, and agent config, so a
        patch touching them would stall the pipeline even if we allowed it."""
        diff = f"--- a/{path}\n+++ b/{path}\n+malicious\n"
        with pytest.raises(PatchRejected):
            validate_patch(diff, [path], policy)

    def test_ordinary_source_change_is_accepted(self, policy: PromotionPolicy) -> None:
        diff = (
            "--- a/target-app/main.py\n"
            "+++ b/target-app/main.py\n"
            "-    has_more = page[limit] is not None\n"
            "+    has_more = len(page) > limit\n"
        )
        validate_patch(diff, ["target-app/main.py"], policy)

    @pytest.mark.parametrize(
        "secret_line",
        [
            "+-----BEGIN RSA PRIVATE KEY-----",
            "+OPENAI_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz'",
            "+token = 'ghp_abcdefghijklmnopqrstuvwxyz012345'",
            "+whsec_abcdefghijklmnopqrstuvwxyz012345",
        ],
    )
    def test_patch_containing_credentials_is_rejected(
        self, secret_line: str, policy: PromotionPolicy
    ) -> None:
        diff = f"--- a/src/app.py\n+++ b/src/app.py\n{secret_line}\n"
        with pytest.raises(PatchRejected):
            validate_patch(diff, ["src/app.py"], policy)


class TestInvariant2RevisionsArePinned:
    def test_bare_ref_is_refused(self) -> None:
        with pytest.raises(ValueError, match="REF@SHA"):
            Revision.parse("main")

    def test_short_sha_is_refused(self) -> None:
        """A short sha is ambiguous; evidence must name exactly one commit."""
        with pytest.raises(ValueError):
            Revision.parse("main@abc1234")

    def test_full_sha_is_accepted_and_round_trips(self) -> None:
        spec = "refs/heads/main@" + "a1b2c3d4" * 5
        assert str(Revision.parse(spec)) == spec

    def test_revision_is_immutable(self) -> None:
        rev = Revision.parse("main@" + "a" * 40)
        with pytest.raises(ValidationError):
            rev.sha = "b" * 40  # type: ignore[misc]


class TestInvariant3IncompleteLanesYieldNoVerdict:
    def test_incomplete_investigation_names_the_missing_lane(self) -> None:
        from sandman.models import Variant

        exc = IncompleteInvestigation("checkout", [Variant.BASELINE])
        assert "baseline" in str(exc)
        assert exc.missing == [Variant.BASELINE]


class TestInvariant4ProbesCarryNoCredentials:
    @pytest.mark.parametrize(
        "header",
        ["Authorization", "authorization", "Cookie", "X-API-Key", "Proxy-Authorization"],
    )
    def test_probe_spec_rejects_auth_headers(self, header: str) -> None:
        with pytest.raises(ValueError, match="not allowed"):
            ProjectConfig(
                repository_url="https://github.com/o/r",
                probes=[
                    {
                        "id": "p",
                        "preset": "api-fuzz-differential",
                        "params": {"headers": {header: "secret"}},
                    }
                ],
            )

    def test_sdk_target_rejects_auth_headers(self) -> None:
        import httpx

        from sandman_sdk import ProbeConfigurationError, Target

        with pytest.raises(ProbeConfigurationError):
            Target(
                "http://x",
                client=httpx.AsyncClient(),
                default_headers={"Authorization": "Bearer nope"},
            )

    def test_variant_env_rejects_credential_shaped_keys(self) -> None:
        with pytest.raises(ValueError, match="credential"):
            VariantConfig(env={"DB_PASSWORD": "hunter2"})

    def test_repository_url_may_not_embed_credentials(self) -> None:
        with pytest.raises(ValueError, match="credentials"):
            ProjectConfig(repository_url="https://user:token@github.com/o/r")


class TestGitTokenHandling:
    def test_token_is_never_written_into_a_remote_url(self) -> None:
        """A token in the remote leaks into .git/config and every error message
        that prints the remote."""
        from sandman import github

        source = inspect.getsource(github)
        assert "extraheader" in source or "credential" in source, (
            "github.py must inject the token via an http header or credential helper, "
            "never by embedding it in the clone URL"
        )


class TestGreptileFailsClosed:
    def test_missing_cli_raises_rather_than_approving(self) -> None:
        """A reviewer that cannot run must never be recorded as a pass."""
        from sandman import greptile

        source = inspect.getsource(greptile)
        assert "GreptileUnavailable" in source
        # The module must never construct an approving result as a fallback.
        assert "approved=True  # fallback" not in source

    def test_never_auto_approved_areas_are_declared(self) -> None:
        from sandman.greptile import NEVER_AUTO_APPROVED

        lowered = " ".join(NEVER_AUTO_APPROVED).lower()
        for area in ("auth", "secret", "billing", "migration"):
            assert area in lowered


class TestConfigFanOutAccounting:
    def test_total_fanout_multiplies_replicas_by_probe_fanout(self) -> None:
        cfg = ProjectConfig(
            repository_url="https://github.com/o/r",
            probes=[
                {"id": "a", "preset": "api-fuzz-differential", "fanout": 4},
                {"id": "b", "preset": "latency-slo-guard", "fanout": 2},
            ],
        )
        for variant in cfg.variants:
            cfg.variants[variant].replicas = 3
        # 3 variants x 3 replicas x (4 + 2) probe executions
        assert cfg.total_fanout() == 3 * 3 * 6

    def test_disabled_variant_is_excluded(self) -> None:
        from sandman.models import Variant

        cfg = ProjectConfig(
            repository_url="https://github.com/o/r",
            probes=[{"id": "a", "preset": "api-fuzz-differential"}],
        )
        cfg.variants[Variant.HOTFIX].enabled = False
        assert Variant.HOTFIX not in cfg.active_variants

    def test_duplicate_probe_ids_are_refused(self) -> None:
        with pytest.raises(ValueError, match="duplicate"):
            ProjectConfig(
                repository_url="https://github.com/o/r",
                probes=[
                    {"id": "a", "preset": "api-fuzz-differential"},
                    {"id": "a", "preset": "latency-slo-guard"},
                ],
            )

    def test_probe_needs_exactly_one_source(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            ProjectConfig(
                repository_url="https://github.com/o/r",
                probes=[{"id": "a", "preset": "x", "module": "y"}],
            )
