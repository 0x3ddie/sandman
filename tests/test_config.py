from __future__ import annotations

from pathlib import Path

import pytest

from sandman.config import Settings


def test_settings_reject_non_positive_codex_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SANDMAN_CODEX_TIMEOUT_SECONDS", "0")

    with pytest.raises(ValueError, match="must be greater than zero"):
        Settings.from_environment()


def test_settings_reject_non_numeric_codex_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SANDMAN_CODEX_TIMEOUT_SECONDS", "eventually")

    with pytest.raises(ValueError, match="must be an integer"):
        Settings.from_environment()


def test_settings_load_state_database_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SANDMAN_STATE_DATABASE", ".sandman/state.db")

    settings = Settings.from_environment()

    assert settings.state_database_path == Path(".sandman/state.db")
