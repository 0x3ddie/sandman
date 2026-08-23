from __future__ import annotations

import pytest
from pydantic import ValidationError

from sandman.models import InvestigationRequest, Lane, ProbeSpec, Revision, RuntimeName


def revisions() -> tuple[Revision, Revision, Revision]:
    return tuple(Revision(lane=lane, git_ref=lane.value, label=lane.value) for lane in Lane)  # type: ignore[return-value]


def test_rejects_credentials_in_repository_url() -> None:
    with pytest.raises(ValidationError, match="credential-free HTTPS"):
        InvestigationRequest(
            repository_url="https://token@example.com/repo.git",
            revisions=revisions(),
        )


def test_rejects_sensitive_probe_headers() -> None:
    with pytest.raises(ValidationError, match="sensitive probe headers"):
        ProbeSpec(headers={"Authorization": "Bearer secret"})


def test_requires_all_three_unique_lanes() -> None:
    duplicate = (
        Revision(lane=Lane.KNOWN_GOOD, git_ref="one", label="one"),
        Revision(lane=Lane.CURRENT, git_ref="two", label="two"),
        Revision(lane=Lane.CURRENT, git_ref="three", label="three"),
    )
    with pytest.raises(ValidationError, match="exactly once"):
        InvestigationRequest(repository_url="https://example.com/repo.git", revisions=duplicate)


def test_modal_runtime_requires_pinned_commits() -> None:
    with pytest.raises(ValidationError, match="commit SHA for every revision"):
        InvestigationRequest(
            repository_url="https://example.com/repo.git",
            revisions=revisions(),
            runtime=RuntimeName.MODAL,
        )
