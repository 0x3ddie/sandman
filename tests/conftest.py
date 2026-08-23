from __future__ import annotations

from collections.abc import Callable

import pytest

from sandman.models import Lane, LaneResult, Observation, Revision


@pytest.fixture
def lane_result() -> Callable[[Lane, bool, str | None], LaneResult]:
    def factory(lane: Lane, passed: bool, error: str | None = None) -> LaneResult:
        return LaneResult(
            lane=lane,
            revision=Revision(lane=lane, git_ref=lane.value, label=lane.value),
            sandbox_id=f"sb-{lane.value}",
            observation=Observation(
                status_code=None if error else (200 if passed else 500),
                duration_ms=10,
                passed=passed,
                error=error,
            ),
        )

    return factory
