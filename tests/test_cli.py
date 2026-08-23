from __future__ import annotations

import json
from pathlib import Path

import pytest

from sandman.cli import main
from sandman.models import RuntimeName
from sandman.project import load_project_config
from sandman.remediation import (
    BranchPublication,
    CodexCliHotfixAgent,
    GitHubBranchPublisher,
    HotfixArtifact,
    HotfixRequest,
)
from sandman.service import InvestigationStore
from sandman.state import StateDatabase

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40


def test_load_project_config() -> None:
    config = load_project_config(Path(".sandman.toml"))

    assert config.runtime is RuntimeName.MODAL
    assert config.service.port == 8000
    assert config.probes["checkout"].expected_json == {"currency": "USD"}


def test_config_command_validates_repository_config(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(["config", "--config", ".sandman.toml"])

    assert exit_code == 0
    assert "probes: checkout" in _captured_stdout(capsys)


def test_config_command_requires_requested_probe(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = tmp_path / ".sandman.toml"
    config_path.write_text(demo_config(), encoding="utf-8")

    exit_code = main(["config", "--config", str(config_path), "--probe", "missing-probe"])

    assert exit_code == 2
    assert "unknown probe: missing-probe" in _captured_stderr(capsys)


def test_investigate_runs_existing_engine_in_demo_mode(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = tmp_path / ".sandman.toml"
    config_path.write_text(demo_config(), encoding="utf-8")

    exit_code = main(
        [
            "investigate",
            "--config",
            str(config_path),
            "--probe",
            "checkout",
            "--known-good",
            f"v1.0.0@{SHA_A}",
            "--current",
            f"main@{SHA_B}",
            "--candidate",
            f"sandman/fix@{SHA_C}",
        ]
    )

    output = _captured_stdout(capsys)
    assert exit_code == 0
    assert "candidate_verified" in output
    assert "PASS  known_good" in output
    assert "FAIL  current" in output


def test_investigate_persists_completed_record(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = tmp_path / ".sandman.toml"
    database_path = tmp_path / "state.db"
    config_path.write_text(demo_config(), encoding="utf-8")

    exit_code = main(
        [
            "investigate",
            "--config",
            str(config_path),
            "--probe",
            "checkout",
            "--known-good",
            f"v1.0.0@{SHA_A}",
            "--current",
            f"main@{SHA_B}",
            "--candidate",
            f"sandman/fix@{SHA_C}",
            "--state-database",
            str(database_path),
        ]
    )

    output = _captured_stdout(capsys)
    investigation_id = next(
        line.removeprefix("Run: ") for line in output.splitlines() if line.startswith("Run: ")
    )
    restored = InvestigationStore(StateDatabase(database_path)).get(investigation_id)

    assert exit_code == 0
    assert restored is not None
    assert restored.report is not None
    assert restored.report.verdict.safe_to_review is True


def test_investigate_rejects_unpinned_revision(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = tmp_path / ".sandman.toml"
    config_path.write_text(demo_config(), encoding="utf-8")

    exit_code = main(
        [
            "investigate",
            "--config",
            str(config_path),
            "--probe",
            "checkout",
            "--known-good",
            "v1.0.0",
            "--current",
            f"main@{SHA_B}",
            "--candidate",
            f"sandman/fix@{SHA_C}",
        ]
    )

    assert exit_code == 2
    assert "REF@SHA" in _captured_stderr(capsys)


def test_github_reporting_requires_token(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    config_path = tmp_path / ".sandman.toml"
    config_path.write_text(demo_config(), encoding="utf-8")

    exit_code = main(
        [
            "investigate",
            "--config",
            str(config_path),
            "--probe",
            "checkout",
            "--known-good",
            f"v1.0.0@{SHA_A}",
            "--current",
            f"main@{SHA_B}",
            "--candidate",
            f"sandman/fix@{SHA_C}",
            "--github-check",
        ]
    )

    assert exit_code == 2
    assert "GITHUB_TOKEN is required" in _captured_stderr(capsys)


def test_remediate_generates_publishes_and_verifies_candidate(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / ".sandman.toml"
    trace_path = tmp_path / "incident.json"
    config_path.write_text(demo_config(), encoding="utf-8")
    trace_path.write_text(json.dumps(incident_trace()), encoding="utf-8")
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")

    def generate(_agent: CodexCliHotfixAgent, request: HotfixRequest) -> HotfixArtifact:
        return HotfixArtifact(
            branch_name=request.branch_name,
            base_commit_sha=request.base_commit_sha,
            patch="diff --git a/app.py b/app.py\n",
            changed_files=("app.py",),
            summary={"summary": "Fixed checkout", "tests": [], "notes": []},
        )

    def publish(
        _publisher: GitHubBranchPublisher,
        request: HotfixRequest,
        artifact: HotfixArtifact,
    ) -> BranchPublication:
        assert artifact.branch_name == "sandman/fix-checkout"
        return BranchPublication(branch_name=request.branch_name, commit_sha=SHA_C)

    monkeypatch.setattr(CodexCliHotfixAgent, "generate", generate)
    monkeypatch.setattr(GitHubBranchPublisher, "publish", publish)

    exit_code = main(
        [
            "remediate",
            "--config",
            str(config_path),
            "--trace",
            str(trace_path),
            "--known-good",
            f"v1.0.0@{SHA_A}",
            "--current",
            f"main@{SHA_B}",
            "--branch",
            "sandman/fix-checkout",
            "--publish",
        ]
    )

    assert exit_code == 0
    assert "candidate_verified" in _captured_stdout(capsys)


def test_remediate_requires_explicit_publication_confirmation(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(
        [
            "remediate",
            "--trace",
            "incident.json",
            "--known-good",
            f"v1.0.0@{SHA_A}",
            "--current",
            f"main@{SHA_B}",
            "--branch",
            "sandman/fix",
        ]
    )

    assert exit_code == 2
    assert "pass --publish" in _captured_stderr(capsys)


def demo_config() -> str:
    return """\
version = 1
repository_url = "https://github.com/example/service"
runtime = "demo"

[service]
startup_command = ["python", "app.py"]
port = 8000

[probes.checkout]
method = "POST"
path = "/api/checkout/quote"
expected_status = 200
"""


def incident_trace() -> dict[str, object]:
    return {
        "trace_id": "checkout-500",
        "redacted": True,
        "method": "POST",
        "path": "/api/checkout/quote",
        "json_body": {"currency": "USD"},
        "observed": {"status_code": 500, "json_body": {"error": "currency required"}},
        "expected_status": 200,
        "expected_json": {"currency": "USD"},
        "logs": ["ValueError: currency required"],
    }


def _captured_stdout(capsys: pytest.CaptureFixture[str]) -> str:
    return capsys.readouterr().out


def _captured_stderr(capsys: pytest.CaptureFixture[str]) -> str:
    return capsys.readouterr().err
