from __future__ import annotations

from typing import Any

from sandman.models import Lane, LaneResult, Verdict, VerdictKind


def json_contains(actual: Any, expected: Any) -> bool:
    """Return whether actual recursively contains the expected JSON contract."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and json_contains(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                json_contains(item, wanted) for item, wanted in zip(actual, expected, strict=True)
            )
        )
    return bool(actual == expected)


def classify(results: tuple[LaneResult, LaneResult, LaneResult]) -> Verdict:
    by_lane = {result.lane: result.observation for result in results}
    if set(by_lane) != set(Lane):
        return Verdict(
            kind=VerdictKind.INCONCLUSIVE,
            headline="The comparison is incomplete",
            detail="One or more required revision lanes did not return a result.",
        )

    if any(observation.error for observation in by_lane.values()):
        failed_lanes = ", ".join(
            lane.value for lane, observation in by_lane.items() if observation.error
        )
        return Verdict(
            kind=VerdictKind.INCONCLUSIVE,
            headline="Infrastructure prevented a reliable comparison",
            detail=f"The following lanes could not be probed: {failed_lanes}.",
        )

    pattern = (
        by_lane[Lane.KNOWN_GOOD].passed,
        by_lane[Lane.CURRENT].passed,
        by_lane[Lane.CANDIDATE].passed,
    )
    verdicts: dict[tuple[bool, bool, bool], Verdict] = {
        (True, False, True): Verdict(
            kind=VerdictKind.CANDIDATE_VERIFIED,
            headline="Candidate fixes the reproduced regression",
            detail="Known-good and candidate satisfy the probe; current does not.",
            safe_to_review=True,
        ),
        (False, False, True): Verdict(
            kind=VerdictKind.CANDIDATE_IMPROVES_PREEXISTING,
            headline="Candidate fixes a pre-existing failure",
            detail="The probe fails on both baselines and succeeds only on the candidate.",
            safe_to_review=True,
        ),
        (True, False, False): Verdict(
            kind=VerdictKind.REGRESSION_REPRODUCED_UNFIXED,
            headline="Regression reproduced, but the candidate does not fix it",
            detail="Only the known-good revision satisfies the probe.",
        ),
        (True, True, False): Verdict(
            kind=VerdictKind.CANDIDATE_REGRESSION,
            headline="Candidate introduces a regression",
            detail="Both baselines satisfy the probe, while the candidate fails.",
        ),
        (False, True, False): Verdict(
            kind=VerdictKind.CANDIDATE_REGRESSION,
            headline="Candidate regresses behavior present on current",
            detail="Current is the only revision that satisfies the probe.",
        ),
        (True, True, True): Verdict(
            kind=VerdictKind.NO_REGRESSION_REPRODUCED,
            headline="The probe passes on every revision",
            detail="No differential failure was reproduced with this probe.",
        ),
        (False, False, False): Verdict(
            kind=VerdictKind.UNRESOLVED,
            headline="The failure remains unresolved",
            detail="The probe fails on known-good, current, and candidate.",
        ),
        (False, True, True): Verdict(
            kind=VerdictKind.BASELINE_DRIFT,
            headline="The known-good baseline no longer satisfies the probe",
            detail="Current and candidate pass; verify the baseline fixture and environment.",
        ),
    }
    return verdicts[pattern]
