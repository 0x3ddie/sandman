from __future__ import annotations

from pathlib import Path

import pytest

from sandman.cli import main
from sandman.models import RuntimeName
from sandman.project import load_project_config
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


def _captured_stdout(capsys: pytest.CaptureFixture[str]) -> str:
    return capsys.readouterr().out


def _captured_stderr(capsys: pytest.CaptureFixture[str]) -> str:
    return capsys.readouterr().err
