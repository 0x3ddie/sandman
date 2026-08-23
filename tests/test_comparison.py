from __future__ import annotations

from collections.abc import Callable

import pytest

from sandman.comparison import classify, json_contains
from sandman.models import Lane, LaneResult, VerdictKind


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        ((True, False, True), VerdictKind.CANDIDATE_VERIFIED),
        ((False, False, True), VerdictKind.CANDIDATE_IMPROVES_PREEXISTING),
        ((True, False, False), VerdictKind.REGRESSION_REPRODUCED_UNFIXED),
        ((True, True, False), VerdictKind.CANDIDATE_REGRESSION),
        ((False, True, False), VerdictKind.CANDIDATE_REGRESSION),
        ((True, True, True), VerdictKind.NO_REGRESSION_REPRODUCED),
        ((False, False, False), VerdictKind.UNRESOLVED),
        ((False, True, True), VerdictKind.BASELINE_DRIFT),
    ],
)
def test_classifies_every_probe_pattern(
    pattern: tuple[bool, bool, bool],
    expected: VerdictKind,
    lane_result: Callable[[Lane, bool, str | None], LaneResult],
) -> None:
    results = tuple(lane_result(lane, passed) for lane, passed in zip(Lane, pattern, strict=True))
    typed_results = (results[0], results[1], results[2])

    assert classify(typed_results).kind is expected


def test_infrastructure_error_is_inconclusive(
    lane_result: Callable[[Lane, bool, str | None], LaneResult],
) -> None:
    results = (
        lane_result(Lane.KNOWN_GOOD, True),
        lane_result(Lane.CURRENT, False, "sandbox timeout"),
        lane_result(Lane.CANDIDATE, True),
    )

    verdict = classify(results)

    assert verdict.kind is VerdictKind.INCONCLUSIVE
    assert verdict.safe_to_review is False


def test_json_contract_is_recursive_and_allows_extra_fields() -> None:
    actual = {"quote": {"currency": "USD", "total": 42}, "request_id": "volatile"}

    assert json_contains(actual, {"quote": {"currency": "USD"}})
    assert not json_contains(actual, {"quote": {"currency": "EUR"}})
