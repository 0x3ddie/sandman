"""The three-way comparison engine.

This is the part of sandman that no external tool provides. Greptile reviews
diffs statically and never executes code, so deciding whether a hotfix actually
changed runtime behaviour is entirely ours.

The engine takes the raw :class:`ProbeResult` objects produced by every fan-out
unit, aggregates them per (probe, variant), and reduces each probe to a single
:class:`ProbeVerdict` carrying one of eight named classifications.

Two decisions drive everything here:

*Aggregation before classification.* A probe that fans out to 25 sandboxes
produces 25 results per variant. A variant "passes" only when its results agree;
disagreement means flakiness, and a flaky lane must not be silently rounded to
pass or fail (invariant 3: a failed or incomplete lane never yields a verified
verdict).

*Signatures, not payloads.* Two runs that return identical data still differ in
timestamps and request ids. Comparison happens on normalized
:class:`BehavioralSignature` digests so that ordinary noise does not read as a
behaviour change.
"""

from __future__ import annotations

import uuid
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from .models import (
    BehavioralSignature,
    Classification,
    Finding,
    ProbeOutcome,
    ProbeResult,
    ProbeVerdict,
    Severity,
    Variant,
)

# A variant is only credited with a pass when at least this share of its
# fan-out units agree. Below it, the lane is inconclusive rather than passing.
DEFAULT_AGREEMENT_THRESHOLD = 0.8


class IncompleteInvestigation(RuntimeError):
    """Raised when a verdict is requested but a required lane produced nothing.

    Invariant 3: a lane that failed to execute is not evidence of anything, and
    must never be collapsed into a pass or a fail.
    """

    def __init__(self, probe_id: str, missing: Iterable[Variant]) -> None:
        names = ", ".join(v.value for v in missing)
        super().__init__(
            f"probe {probe_id!r} cannot be classified: no results for lane(s) {names}"
        )
        self.probe_id = probe_id
        self.missing = list(missing)


@dataclass(slots=True)
class LaneSummary:
    """Aggregate of every fan-out unit for one (probe, variant) pair."""

    variant: Variant
    total: int = 0
    passed: int = 0
    failed: int = 0
    errored: int = 0
    skipped: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    signatures: Counter[str] = field(default_factory=Counter)
    signature_by_digest: dict[str, BehavioralSignature] = field(default_factory=dict)
    messages: list[str] = field(default_factory=list)

    @property
    def executed(self) -> int:
        """Units that actually produced a pass/fail. Errors are not evidence."""
        return self.passed + self.failed

    @property
    def pass_rate(self) -> float:
        return self.passed / self.executed if self.executed else 0.0

    @property
    def conclusive(self) -> bool:
        """Whether this lane ran enough units to support a verdict."""
        return self.executed > 0

    @property
    def agreed(self) -> bool:
        """Whether the units agree strongly enough to call the lane."""
        if not self.conclusive:
            return False
        rate = self.pass_rate
        return rate >= DEFAULT_AGREEMENT_THRESHOLD or rate <= (1 - DEFAULT_AGREEMENT_THRESHOLD)

    @property
    def verdict_passed(self) -> bool:
        return self.pass_rate >= DEFAULT_AGREEMENT_THRESHOLD

    @property
    def flaky(self) -> bool:
        return self.conclusive and not self.agreed

    @property
    def dominant_signature(self) -> BehavioralSignature | None:
        if not self.signatures:
            return None
        digest, _ = self.signatures.most_common(1)[0]
        return self.signature_by_digest.get(digest)

    @property
    def p95_latency_ms(self) -> float | None:
        if not self.latencies_ms:
            return None
        ordered = sorted(self.latencies_ms)
        idx = min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))
        return ordered[idx]

    def add(self, result: ProbeResult) -> None:
        self.total += 1
        match result.outcome:
            case ProbeOutcome.PASS:
                self.passed += 1
            case ProbeOutcome.FAIL:
                self.failed += 1
            case ProbeOutcome.ERROR:
                self.errored += 1
            case ProbeOutcome.SKIPPED:
                self.skipped += 1

        if result.latency_ms is not None:
            self.latencies_ms.append(result.latency_ms)

        # Only executed units contribute a behavioural signature. An errored unit
        # describes our infrastructure, not the code under test.
        if result.outcome in (ProbeOutcome.PASS, ProbeOutcome.FAIL):
            digest = result.signature.digest
            self.signatures[digest] += 1
            self.signature_by_digest.setdefault(digest, result.signature)

        if result.message and len(self.messages) < 5:
            self.messages.append(result.message)


def summarize(results: Iterable[ProbeResult]) -> dict[str, dict[Variant, LaneSummary]]:
    """Group raw results into per-probe, per-variant lane summaries."""
    grouped: dict[str, dict[Variant, LaneSummary]] = defaultdict(dict)
    for result in results:
        lanes = grouped[result.probe_id]
        lane = lanes.get(result.variant)
        if lane is None:
            lane = LaneSummary(variant=result.variant)
            lanes[result.variant] = lane
        lane.add(result)
    return dict(grouped)


def compare_probe(
    probe_id: str,
    lanes: dict[Variant, LaneSummary],
    *,
    require_hotfix: bool = False,
) -> ProbeVerdict:
    """Reduce one probe's lanes to a single classified verdict.

    ``require_hotfix`` distinguishes the two shapes of investigation: the first
    pass runs BASELINE and INITIAL only (there is no patch yet), while the
    verification pass after a hotfix runs all three.
    """
    baseline = lanes.get(Variant.BASELINE)
    initial = lanes.get(Variant.INITIAL)
    hotfix = lanes.get(Variant.HOTFIX)

    missing = [
        variant
        for variant, lane in ((Variant.BASELINE, baseline), (Variant.INITIAL, initial))
        if lane is None or not lane.conclusive
    ]
    if require_hotfix and (hotfix is None or not hotfix.conclusive):
        missing.append(Variant.HOTFIX)
    if missing:
        raise IncompleteInvestigation(probe_id, missing)

    assert baseline is not None and initial is not None  # narrowed by the check above

    baseline_passed = baseline.verdict_passed
    initial_passed = initial.verdict_passed
    hotfix_passed: bool | None = None
    if hotfix is not None and hotfix.conclusive:
        hotfix_passed = hotfix.verdict_passed

    signatures: dict[Variant, BehavioralSignature] = {}
    sample_size: dict[Variant, int] = {}
    for variant, lane in lanes.items():
        sample_size[variant] = lane.total
        dominant = lane.dominant_signature
        if dominant is not None:
            signatures[variant] = dominant

    if hotfix_passed is None:
        # Two-lane investigation: classify BASELINE vs INITIAL only. Reusing the
        # eight-way taxonomy would imply a hotfix result we do not have, so the
        # hotfix slot mirrors INITIAL and the classification is left provisional.
        classification = _two_lane_classification(baseline_passed, initial_passed)
    else:
        classification = Classification(
            _CLASSIFY[(baseline_passed, initial_passed, hotfix_passed)]
        )

    behaviour_changed = _signatures_diverge(signatures)
    flake_suspected = any(lane.flaky for lane in lanes.values()) or (
        classification is Classification.SELF_HEALED
    )

    return ProbeVerdict(
        probe_id=probe_id,
        classification=classification,
        baseline_passed=baseline_passed,
        initial_passed=initial_passed,
        hotfix_passed=hotfix_passed,
        signatures=signatures,
        behaviour_changed=behaviour_changed,
        sample_size=sample_size,
        flake_suspected=flake_suspected,
        detail=_detail(lanes, classification),
    )


_CLASSIFY: dict[tuple[bool, bool, bool], str] = {
    (True, False, True): "restored",
    (False, False, True): "fixed",
    (True, True, False): "regression",
    (False, True, False): "hotfix_induced",
    (True, False, False): "still_broken",
    (False, False, False): "pre_existing",
    (False, True, True): "self_healed",
    (True, True, True): "stable",
}


def _two_lane_classification(baseline_passed: bool, initial_passed: bool) -> Classification:
    """Classify before any hotfix exists.

    Only the four combinations reachable without a hotfix lane are used, and the
    verdict is expressed in terms the taxonomy already defines so the UI does not
    need a second vocabulary.
    """
    if baseline_passed and not initial_passed:
        return Classification.STILL_BROKEN  # this rollout broke it; no fix attempted yet
    if not baseline_passed and not initial_passed:
        return Classification.PRE_EXISTING
    if not baseline_passed and initial_passed:
        return Classification.SELF_HEALED
    return Classification.STABLE


def _signatures_diverge(signatures: dict[Variant, BehavioralSignature]) -> bool:
    """True when variants behaved differently even if they agreed on pass/fail.

    A probe can pass everywhere while the response body changes shape. That is
    still a behaviour change worth surfacing.
    """
    digests = {sig.digest for sig in signatures.values()}
    return len(digests) > 1


def _detail(lanes: dict[Variant, LaneSummary], classification: Classification) -> str:
    parts: list[str] = []
    for variant in (Variant.BASELINE, Variant.INITIAL, Variant.HOTFIX):
        lane = lanes.get(variant)
        if lane is None:
            continue
        fragment = f"{variant.glyph} {lane.passed}/{lane.executed}"
        if lane.errored:
            fragment += f" ({lane.errored} errored)"
        if lane.flaky:
            fragment += " flaky"
        parts.append(fragment)
    summary = " · ".join(parts)
    if classification is Classification.PRE_EXISTING:
        return f"{summary} — failing before this cut; not attributed to this rollout"
    return summary


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

_SEVERITY_BY_CLASSIFICATION: dict[Classification, Severity] = {
    Classification.REGRESSION: Severity.CRITICAL,
    Classification.HOTFIX_INDUCED: Severity.CRITICAL,
    Classification.STILL_BROKEN: Severity.HIGH,
    Classification.PRE_EXISTING: Severity.MEDIUM,
    Classification.SELF_HEALED: Severity.LOW,
    Classification.RESTORED: Severity.INFO,
    Classification.FIXED: Severity.INFO,
    Classification.STABLE: Severity.INFO,
}

_TITLE_BY_CLASSIFICATION: dict[Classification, str] = {
    Classification.REGRESSION: "Hotfix introduced a regression in {probe}",
    Classification.HOTFIX_INDUCED: "Hotfix reintroduced a previously fixed failure in {probe}",
    Classification.STILL_BROKEN: "{probe} is broken by this rollout",
    Classification.PRE_EXISTING: "{probe} was already failing before this rollout",
    Classification.SELF_HEALED: "{probe} recovered without a fix — suspected flake",
    Classification.RESTORED: "{probe} restored by the hotfix",
    Classification.FIXED: "{probe} fixed a long-standing failure",
    Classification.STABLE: "{probe} stable across all variants",
}

_DESCRIPTION_BY_CLASSIFICATION: dict[Classification, str] = {
    Classification.REGRESSION: (
        "This probe passed on both the previous LKG and the current LKG, but fails with the "
        "hotfix applied. The patch is the cause. Promotion must be blocked."
    ),
    Classification.HOTFIX_INDUCED: (
        "This probe was failing on the previous LKG, was fixed in the current LKG, and fails "
        "again with the hotfix applied. The patch reverted an earlier fix."
    ),
    Classification.STILL_BROKEN: (
        "This probe passed on the previous LKG and fails on the current LKG. The rollout "
        "introduced the failure, and the hotfix did not resolve it."
    ),
    Classification.PRE_EXISTING: (
        "This probe fails on the previous LKG as well as the current one. It is not a "
        "regression from this rollout and will not be auto-patched; it is reported so a "
        "long-ignored failure stops being invisible."
    ),
    Classification.SELF_HEALED: (
        "This probe failed on the previous LKG but passes on the current one with no fix "
        "attributable to this rollout. Most likely a flake; re-run before trusting it."
    ),
    Classification.RESTORED: (
        "This probe passed on the previous LKG, broke on the current LKG, and passes again "
        "with the hotfix applied. The fix is verified."
    ),
    Classification.FIXED: (
        "This probe was failing on both the previous and current LKG and now passes with the "
        "hotfix applied."
    ),
    Classification.STABLE: "This probe passed on every variant.",
}


def build_findings(
    run_id: str,
    verdicts: Sequence[ProbeVerdict],
    *,
    include_stable: bool = False,
) -> list[Finding]:
    """Turn verdicts into findings, worst news first.

    ``STABLE`` probes are excluded by default: they are the overwhelming majority
    and carry no signal.
    """
    findings: list[Finding] = []
    for verdict in sorted(verdicts, key=lambda v: v.classification.severity):
        if verdict.classification is Classification.STABLE and not include_stable:
            continue

        classification = verdict.classification
        evidence: dict[Variant, str] = {}
        for variant, signature in verdict.signatures.items():
            bits = [f"status={signature.status_code}" if signature.status_code else ""]
            if signature.error_class:
                bits.append(f"error={signature.error_class}")
            if signature.latency_bucket:
                bits.append(f"latency={signature.latency_bucket}")
            if signature.exit_code is not None:
                bits.append(f"exit={signature.exit_code}")
            evidence[variant] = " ".join(b for b in bits if b) or signature.digest[:12]

        description = _DESCRIPTION_BY_CLASSIFICATION[classification]
        if verdict.behaviour_changed and classification is Classification.STABLE:
            description += (
                " Response signatures differ across variants even though every lane passed."
            )
        if verdict.flake_suspected:
            description += " Fan-out units disagreed, so this result may be unstable."

        findings.append(
            Finding(
                id=f"fnd_{uuid.uuid4().hex[:12]}",
                run_id=run_id,
                probe_id=verdict.probe_id,
                classification=classification,
                severity=_SEVERITY_BY_CLASSIFICATION[classification],
                title=_TITLE_BY_CLASSIFICATION[classification].format(probe=verdict.probe_id),
                description=description,
                variant_evidence=evidence,
                reproduction=verdict.detail,
                previously_ignored=classification is Classification.PRE_EXISTING,
            )
        )
    return findings


@dataclass(slots=True)
class RunVerdict:
    """The whole-run answer."""

    verdicts: list[ProbeVerdict]
    findings: list[Finding]

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.classification.is_actionable]

    @property
    def hotfix_candidates(self) -> list[Finding]:
        """Findings this rollout caused and that a patch should target."""
        return [f for f in self.findings if f.eligible_for_hotfix]

    @property
    def pre_existing(self) -> list[Finding]:
        return [
            f for f in self.findings if f.classification is Classification.PRE_EXISTING
        ]

    @property
    def safe_to_promote(self) -> bool:
        """Whether a hotfix may advance toward the LKG branch."""
        return not self.blocking

    def counts(self) -> dict[str, int]:
        tally: Counter[str] = Counter(v.classification.value for v in self.verdicts)
        return dict(tally)


def evaluate(
    run_id: str,
    results: Iterable[ProbeResult],
    *,
    require_hotfix: bool = False,
    include_stable: bool = False,
) -> RunVerdict:
    """Full pipeline: raw results -> lane summaries -> verdicts -> findings."""
    grouped = summarize(results)
    verdicts = [
        compare_probe(probe_id, lanes, require_hotfix=require_hotfix)
        for probe_id, lanes in sorted(grouped.items())
    ]
    findings = build_findings(run_id, verdicts, include_stable=include_stable)
    return RunVerdict(verdicts=verdicts, findings=findings)
