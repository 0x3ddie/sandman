"""Tests for the three-way comparison engine."""

from __future__ import annotations

import pytest

from sandman.models import (
    BehavioralSignature,
    Classification,
    ProbeOutcome,
    ProbeResult,
    Variant,
)
from sandman.verdict import (
    DEFAULT_AGREEMENT_THRESHOLD,
    IncompleteInvestigation,
    compare_probe,
    evaluate,
    summarize,
)


def result(
    variant: Variant,
    *,
    probe_id: str = "checkout",
    passed: bool = True,
    status: int = 200,
    body: object | None = None,
    latency_ms: float = 40.0,
    outcome: ProbeOutcome | None = None,
    unit_index: int = 0,
) -> ProbeResult:
    if outcome is None:
        outcome = ProbeOutcome.PASS if passed else ProbeOutcome.FAIL
    return ProbeResult(
        probe_id=probe_id,
        variant=variant,
        unit_index=unit_index,
        outcome=outcome,
        signature=BehavioralSignature.from_observation(
            status_code=status,
            body=body if body is not None else {"ok": passed},
            latency_ms=latency_ms,
        ),
        latency_ms=latency_ms,
    )


def lanes_for(baseline: bool, initial: bool, hotfix: bool | None, n: int = 5) -> list[ProbeResult]:
    out: list[ProbeResult] = []
    for i in range(n):
        out.append(result(Variant.BASELINE, passed=baseline, unit_index=i))
        out.append(result(Variant.INITIAL, passed=initial, unit_index=i))
        if hotfix is not None:
            out.append(result(Variant.HOTFIX, passed=hotfix, unit_index=i))
    return out


class TestClassificationMatrix:
    @pytest.mark.parametrize(
        ("baseline", "initial", "hotfix", "expected"),
        [
            (True, False, True, Classification.RESTORED),
            (False, False, True, Classification.FIXED),
            (True, True, False, Classification.REGRESSION),
            (False, True, False, Classification.HOTFIX_INDUCED),
            (True, False, False, Classification.STILL_BROKEN),
            (False, False, False, Classification.PRE_EXISTING),
            (False, True, True, Classification.SELF_HEALED),
            (True, True, True, Classification.STABLE),
        ],
    )
    def test_all_eight_combinations(
        self, baseline: bool, initial: bool, hotfix: bool, expected: Classification
    ) -> None:
        grouped = summarize(lanes_for(baseline, initial, hotfix))
        verdict = compare_probe("checkout", grouped["checkout"], require_hotfix=True)
        assert verdict.classification is expected

    def test_regression_sorts_first(self) -> None:
        assert Classification.REGRESSION.severity == 0

    def test_pre_existing_does_not_blame_the_rollout(self) -> None:
        """The entire reason the baseline lane exists."""
        assert Classification.PRE_EXISTING.blames_rollout is False
        assert Classification.PRE_EXISTING.is_actionable is False

    def test_regression_blocks_promotion(self) -> None:
        assert Classification.REGRESSION.is_actionable is True


class TestIncompleteLanes:
    def test_missing_baseline_refuses_to_classify(self) -> None:
        """Invariant 3: a missing lane is not evidence."""
        results = [result(Variant.INITIAL), result(Variant.HOTFIX)]
        grouped = summarize(results)
        with pytest.raises(IncompleteInvestigation) as exc:
            compare_probe("checkout", grouped["checkout"], require_hotfix=True)
        assert Variant.BASELINE in exc.value.missing

    def test_all_errored_lane_is_not_a_failure(self) -> None:
        """An errored unit describes our infrastructure, not the code under test."""
        results = [
            result(Variant.BASELINE, outcome=ProbeOutcome.ERROR),
            result(Variant.INITIAL, passed=True),
        ]
        grouped = summarize(results)
        with pytest.raises(IncompleteInvestigation):
            compare_probe("checkout", grouped["checkout"])

    def test_hotfix_optional_when_not_required(self) -> None:
        grouped = summarize(lanes_for(True, False, None))
        verdict = compare_probe("checkout", grouped["checkout"], require_hotfix=False)
        assert verdict.hotfix_passed is None
        assert verdict.classification is Classification.STILL_BROKEN


class TestFanOutAggregation:
    def test_unanimous_fanout_is_conclusive(self) -> None:
        grouped = summarize(lanes_for(True, False, True, n=25))
        verdict = compare_probe("checkout", grouped["checkout"], require_hotfix=True)
        assert verdict.classification is Classification.RESTORED
        assert verdict.sample_size[Variant.INITIAL] == 25
        assert verdict.flake_suspected is False

    def test_split_fanout_is_flagged_flaky(self) -> None:
        """Half the units passing is disagreement, not a pass."""
        results: list[ProbeResult] = []
        for i in range(10):
            results.append(result(Variant.BASELINE, passed=True, unit_index=i))
            results.append(result(Variant.INITIAL, passed=i % 2 == 0, unit_index=i))
            results.append(result(Variant.HOTFIX, passed=True, unit_index=i))
        grouped = summarize(results)
        verdict = compare_probe("checkout", grouped["checkout"], require_hotfix=True)
        assert verdict.flake_suspected is True

    def test_threshold_boundary(self) -> None:
        """At exactly the agreement threshold the lane counts as passing."""
        results: list[ProbeResult] = []
        for i in range(10):
            passed = i < int(DEFAULT_AGREEMENT_THRESHOLD * 10)
            results.append(result(Variant.BASELINE, passed=True, unit_index=i))
            results.append(result(Variant.INITIAL, passed=passed, unit_index=i))
        grouped = summarize(results)
        verdict = compare_probe("checkout", grouped["checkout"])
        assert verdict.initial_passed is True


class TestBehaviourChange:
    def test_same_data_different_ids_is_not_a_change(self) -> None:
        """Timestamps and request ids must not read as a behaviour change."""
        results = [
            result(
                Variant.BASELINE,
                body={"id": "550e8400-e29b-41d4-a716-446655440000", "total": 10},
                latency_ms=40,
            ),
            result(
                Variant.INITIAL,
                body={"id": "11111111-2222-3333-4444-555555555555", "total": 10},
                latency_ms=44,
            ),
        ]
        grouped = summarize(results)
        verdict = compare_probe("checkout", grouped["checkout"])
        assert verdict.behaviour_changed is False

    def test_real_payload_change_is_detected(self) -> None:
        results = [
            result(Variant.BASELINE, body={"total": 10}),
            result(Variant.INITIAL, body={"total": 99}),
        ]
        grouped = summarize(results)
        verdict = compare_probe("checkout", grouped["checkout"])
        assert verdict.behaviour_changed is True

    def test_key_order_is_irrelevant(self) -> None:
        results = [
            result(Variant.BASELINE, body={"a": 1, "b": 2}),
            result(Variant.INITIAL, body={"b": 2, "a": 1}),
        ]
        grouped = summarize(results)
        verdict = compare_probe("checkout", grouped["checkout"])
        assert verdict.behaviour_changed is False


class TestFindings:
    def test_stable_probes_are_omitted(self) -> None:
        run = evaluate("run_1", lanes_for(True, True, True), require_hotfix=True)
        assert run.findings == []
        assert run.safe_to_promote is True

    def test_regression_blocks_promotion(self) -> None:
        run = evaluate("run_1", lanes_for(True, True, False), require_hotfix=True)
        assert run.safe_to_promote is False
        assert len(run.blocking) == 1
        assert run.blocking[0].severity.value == "critical"

    def test_pre_existing_is_reported_but_not_hotfixed(self) -> None:
        run = evaluate("run_1", lanes_for(False, False, False), require_hotfix=True)
        assert len(run.pre_existing) == 1
        assert run.pre_existing[0].previously_ignored is True
        assert run.hotfix_candidates == []
        assert run.safe_to_promote is True

    def test_still_broken_is_a_hotfix_candidate(self) -> None:
        run = evaluate("run_1", lanes_for(True, False, False), require_hotfix=True)
        assert len(run.hotfix_candidates) == 1
        assert run.hotfix_candidates[0].classification is Classification.STILL_BROKEN

    def test_findings_sort_worst_first(self) -> None:
        results = [
            *lanes_for(True, True, False),  # regression
            *[
                result(v, probe_id="other", passed=p)
                for v, p in (
                    (Variant.BASELINE, False),
                    (Variant.INITIAL, False),
                    (Variant.HOTFIX, False),
                )
            ],
        ]
        run = evaluate("run_1", results, require_hotfix=True)
        assert run.findings[0].classification is Classification.REGRESSION

    def test_counts(self) -> None:
        run = evaluate("run_1", lanes_for(True, False, True), require_hotfix=True)
        assert run.counts() == {"restored": 1}
