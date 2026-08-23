"""Core domain contracts for sandman.

Everything else in the system is written against the types in this module. The
two load-bearing ideas:

* A :class:`Revision` is always a ref *pinned to an exact commit*. Evidence that
  is not pinned can drift while an investigation is running, which would let a
  verdict describe code that no longer exists.
* A :class:`BehavioralSignature` is the normalized fingerprint of what a probe
  actually observed at runtime. Verdicts are computed by comparing signatures
  across variants, never by comparing raw responses -- raw responses contain
  timestamps and ids that differ on every request.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# Variants
# ---------------------------------------------------------------------------


class Variant(str, Enum):
    """The three code revisions every investigation compares.

    Order is significant and fixed everywhere it is displayed: B -> I -> H.
    """

    BASELINE = "baseline"
    """The *previous* LKG. Establishes what was already broken before this cut."""

    INITIAL = "initial"
    """The current LKG, unmodified. The thing being rolled out."""

    HOTFIX = "hotfix"
    """The current LKG plus an agent-authored patch."""

    @property
    def glyph(self) -> str:
        """Single-letter marker. Variants are never encoded by colour alone."""
        return {"baseline": "B", "initial": "I", "hotfix": "H"}[self.value]

    @property
    def order(self) -> int:
        return {"baseline": 0, "initial": 1, "hotfix": 2}[self.value]


VARIANT_ORDER: tuple[Variant, ...] = (Variant.BASELINE, Variant.INITIAL, Variant.HOTFIX)


# ---------------------------------------------------------------------------
# Execution states
# ---------------------------------------------------------------------------


class SandboxState(str, Enum):
    """Lifecycle of a single sandbox.

    ``PROVISIONING`` is deliberately distinct from ``RUNNING``: Modal cold starts
    take several seconds, and collapsing the two makes the opening moments of
    every run look like a hung UI.
    """

    QUEUED = "queued"
    PROVISIONING = "provisioning"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    FLAKY = "flaky"
    SKIPPED = "skipped"
    ERROR = "error"
    TIMED_OUT = "timed_out"

    @property
    def terminal(self) -> bool:
        return self in {
            SandboxState.PASSED,
            SandboxState.FAILED,
            SandboxState.FLAKY,
            SandboxState.SKIPPED,
            SandboxState.ERROR,
            SandboxState.TIMED_OUT,
        }

    @property
    def successful(self) -> bool:
        return self is SandboxState.PASSED


class RunState(str, Enum):
    """Lifecycle of a whole investigation."""

    QUEUED = "queued"
    PROVISIONING = "provisioning"
    PROBING = "probing"
    COMPARING = "comparing"
    REMEDIATING = "remediating"
    REVIEWING = "reviewing"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"

    @property
    def terminal(self) -> bool:
        return self in {RunState.COMPLETED, RunState.FAILED, RunState.ABORTED}


# ---------------------------------------------------------------------------
# Revisions
# ---------------------------------------------------------------------------

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_REF_RE = re.compile(r"^[A-Za-z0-9._/\-]{1,255}$")


class Revision(BaseModel):
    """A git ref pinned to an exact commit.

    Rendered and parsed as ``REF@SHA``. The SHA is mandatory: an unpinned ref can
    move underneath a running investigation, which would silently invalidate
    every verdict derived from it.
    """

    model_config = ConfigDict(frozen=True)

    ref: str
    sha: str

    @field_validator("ref")
    @classmethod
    def _check_ref(cls, v: str) -> str:
        if not _REF_RE.match(v):
            raise ValueError(f"invalid git ref: {v!r}")
        return v

    @field_validator("sha")
    @classmethod
    def _check_sha(cls, v: str) -> str:
        v = v.lower().strip()
        if not _SHA_RE.match(v):
            raise ValueError(
                f"revision must pin a full 40-character commit sha, got {v!r}"
            )
        return v

    @classmethod
    def parse(cls, spec: str) -> Self:
        """Parse ``REF@SHA``."""
        if "@" not in spec:
            raise ValueError(
                f"revision {spec!r} must be REF@SHA so evidence cannot drift mid-run"
            )
        ref, _, sha = spec.rpartition("@")
        return cls(ref=ref, sha=sha)

    def __str__(self) -> str:
        return f"{self.ref}@{self.sha}"

    @property
    def short_sha(self) -> str:
        return self.sha[:7]


# ---------------------------------------------------------------------------
# Behavioural signatures
# ---------------------------------------------------------------------------

# Substrings that differ on every request and would otherwise make every
# comparison report a spurious difference.
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_ISO_TS_RE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b"
)
_EPOCH_RE = re.compile(r"\b1[6-9]\d{8}(?:\d{3})?\b")
_HEXBLOB_RE = re.compile(r"\b[0-9a-f]{16,}\b")
_ADDR_RE = re.compile(r"\b0x[0-9a-fA-F]{6,}\b")
_DURATION_RE = re.compile(r"\b\d+(?:\.\d+)?\s?(?:ms|s|us|µs|ns)\b")

_NORMALIZERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (_UUID_RE, "<uuid>"),
    (_ISO_TS_RE, "<ts>"),
    (_EPOCH_RE, "<epoch>"),
    (_ADDR_RE, "<addr>"),
    (_HEXBLOB_RE, "<hex>"),
    (_DURATION_RE, "<dur>"),
)


def normalize_text(value: str) -> str:
    """Strip request-to-request noise so two equivalent responses hash alike.

    Without this every diff is dominated by timestamps and request ids, and the
    verdict engine reports a difference for every single probe.
    """
    out = value
    for pattern, replacement in _NORMALIZERS:
        out = pattern.sub(replacement, out)
    return out.strip()


def normalize_payload(value: Any) -> Any:
    """Recursively normalize a decoded JSON body.

    Mappings are key-sorted so that key ordering never affects the hash. Lists of
    scalars are sorted too, because many APIs do not guarantee element order;
    lists containing structures keep their order, where order usually is
    meaningful.
    """
    if isinstance(value, dict):
        return {k: normalize_payload(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        items = [normalize_payload(v) for v in value]
        if all(isinstance(v, (str, int, float, bool)) or v is None for v in items):
            return sorted(items, key=lambda v: json.dumps(v, sort_keys=True))
        return items
    if isinstance(value, str):
        return normalize_text(value)
    return value


def latency_bucket(ms: float) -> str:
    """Bucket a latency so ordinary jitter does not read as a behaviour change.

    Buckets are roughly logarithmic; a probe only counts as having changed
    latency behaviour if it crosses a bucket boundary.
    """
    for edge, label in (
        (10, "<10ms"),
        (25, "10-25ms"),
        (50, "25-50ms"),
        (100, "50-100ms"),
        (250, "100-250ms"),
        (500, "250-500ms"),
        (1000, "0.5-1s"),
        (2500, "1-2.5s"),
        (5000, "2.5-5s"),
        (10000, "5-10s"),
    ):
        if ms < edge:
            return label
    return ">10s"


class BehavioralSignature(BaseModel):
    """Normalized fingerprint of one probe execution.

    Two executions are considered behaviourally identical when their
    :attr:`digest` matches. Latency is bucketed rather than exact so that noise
    does not masquerade as a regression.
    """

    model_config = ConfigDict(frozen=True)

    status_code: int | None = None
    body_hash: str | None = None
    error_class: str | None = None
    exit_code: int | None = None
    latency_bucket: str | None = None
    stderr_fingerprint: str | None = None

    @classmethod
    def from_observation(
        cls,
        *,
        status_code: int | None = None,
        body: Any = None,
        error: BaseException | str | None = None,
        exit_code: int | None = None,
        latency_ms: float | None = None,
        stderr: str | None = None,
    ) -> Self:
        body_hash: str | None = None
        if body is not None:
            canonical = json.dumps(
                normalize_payload(body), sort_keys=True, separators=(",", ":"), default=str
            )
            body_hash = hashlib.sha256(canonical.encode()).hexdigest()[:32]

        error_class: str | None = None
        if error is not None:
            error_class = (
                type(error).__name__ if isinstance(error, BaseException) else str(error)[:120]
            )

        stderr_fp: str | None = None
        if stderr:
            stderr_fp = hashlib.sha256(normalize_text(stderr).encode()).hexdigest()[:16]

        return cls(
            status_code=status_code,
            body_hash=body_hash,
            error_class=error_class,
            exit_code=exit_code,
            latency_bucket=latency_bucket(latency_ms) if latency_ms is not None else None,
            stderr_fingerprint=stderr_fp,
        )

    @property
    def digest(self) -> str:
        canonical = json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()[:32]

    def differs_from(self, other: BehavioralSignature) -> bool:
        return self.digest != other.digest


# ---------------------------------------------------------------------------
# Probe results
# ---------------------------------------------------------------------------


class ProbeOutcome(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"
    SKIPPED = "skipped"

    @property
    def ok(self) -> bool:
        return self is ProbeOutcome.PASS


class ProbeResult(BaseModel):
    """The outcome of one probe inside one fan-out unit."""

    probe_id: str
    variant: Variant
    region: str | None = None
    unit_index: int = 0
    outcome: ProbeOutcome
    signature: BehavioralSignature
    message: str | None = None
    latency_ms: float | None = None
    started_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    logs: list[str] = Field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.outcome.ok


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------


class Classification(str, Enum):
    """The eight ways three pass/fail booleans can combine.

    Naming every combination is what turns a three-way diff from a table the
    user has to interpret into an answer the product states.
    """

    RESTORED = "restored"
    """B pass, I fail, H pass -- the happy path."""

    FIXED = "fixed"
    """B fail, I fail, H pass -- a long-standing failure finally resolved."""

    REGRESSION = "regression"
    """B pass, I pass, H fail -- the hotfix broke it. Highest severity."""

    HOTFIX_INDUCED = "hotfix_induced"
    """B fail, I pass, H fail -- the hotfix reintroduced an old failure."""

    STILL_BROKEN = "still_broken"
    """B pass, I fail, H fail -- the rollout broke it and the fix did not work."""

    PRE_EXISTING = "pre_existing"
    """B fail, I fail, H fail -- broken before this cut. Not this rollout's bug."""

    SELF_HEALED = "self_healed"
    """B fail, I pass, H pass -- suspicious; most likely a flake."""

    STABLE = "stable"
    """All three pass. Collapsed in the UI."""

    @property
    def severity(self) -> int:
        """Sort key. Lower sorts first; the worst news is always on top."""
        return {
            "regression": 0,
            "hotfix_induced": 1,
            "still_broken": 2,
            "pre_existing": 3,
            "self_healed": 4,
            "restored": 5,
            "fixed": 6,
            "stable": 7,
        }[self.value]

    @property
    def is_actionable(self) -> bool:
        """Whether this classification should block promotion to LKG."""
        return self in {
            Classification.REGRESSION,
            Classification.HOTFIX_INDUCED,
            Classification.STILL_BROKEN,
        }

    @property
    def blames_rollout(self) -> bool:
        """Whether the *current* rollout introduced this failure.

        ``PRE_EXISTING`` deliberately returns False: that is the entire reason
        the baseline variant exists.
        """
        return self in {
            Classification.RESTORED,
            Classification.REGRESSION,
            Classification.STILL_BROKEN,
        }


#: (baseline_passed, initial_passed, hotfix_passed) -> Classification
CLASSIFICATION_MATRIX: dict[tuple[bool, bool, bool], Classification] = {
    (True, False, True): Classification.RESTORED,
    (False, False, True): Classification.FIXED,
    (True, True, False): Classification.REGRESSION,
    (False, True, False): Classification.HOTFIX_INDUCED,
    (True, False, False): Classification.STILL_BROKEN,
    (False, False, False): Classification.PRE_EXISTING,
    (False, True, True): Classification.SELF_HEALED,
    (True, True, True): Classification.STABLE,
}


def classify(baseline: bool, initial: bool, hotfix: bool) -> Classification:
    """Map three pass/fail booleans onto a named classification."""
    return CLASSIFICATION_MATRIX[(baseline, initial, hotfix)]


class ProbeVerdict(BaseModel):
    """The three-way comparison for a single probe."""

    probe_id: str
    classification: Classification
    baseline_passed: bool
    initial_passed: bool
    hotfix_passed: bool | None = None
    """``None`` when no hotfix lane ran (a two-lane investigation)."""

    signatures: dict[Variant, BehavioralSignature] = Field(default_factory=dict)
    behaviour_changed: bool = False
    """True when signatures differ across variants even though pass/fail agrees."""

    sample_size: dict[Variant, int] = Field(default_factory=dict)
    flake_suspected: bool = False
    detail: str | None = None

    @model_validator(mode="after")
    def _consistency(self) -> Self:
        if self.hotfix_passed is not None:
            expected = classify(self.baseline_passed, self.initial_passed, self.hotfix_passed)
            if expected is not self.classification:
                raise ValueError(
                    f"classification {self.classification} contradicts "
                    f"({self.baseline_passed}, {self.initial_passed}, {self.hotfix_passed}); "
                    f"expected {expected}"
                )
        return self


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class Finding(BaseModel):
    """Something worth a human's attention, derived from a verdict."""

    id: str
    run_id: str
    probe_id: str
    classification: Classification
    severity: Severity
    title: str
    description: str
    variant_evidence: dict[Variant, str] = Field(default_factory=dict)
    reproduction: str | None = None
    first_seen_run_id: str | None = None
    """Set when memory recall shows this failure in an earlier run."""

    previously_ignored: bool = False
    """True for a PRE_EXISTING failure that earlier runs also surfaced."""

    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def eligible_for_hotfix(self) -> bool:
        """Only failures this rollout is responsible for get an automated fix.

        Pre-existing failures are reported, never auto-patched: they are not
        what the rollout broke, and fixing them silently would smuggle unrelated
        change into a hotfix PR.
        """
        return self.classification.blames_rollout and self.classification.is_actionable


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


class BudgetCaps(BaseModel):
    """Hard ceilings for one run.

    Two separate limits, because there are two independent scarce resources: the
    Modal container quota, and the OpenAI org-level rate bucket that every
    sandbox shares through a single API key.
    """

    max_concurrent_sandboxes: int = Field(default=25, ge=1, le=4000)
    max_concurrent_llm: int = Field(default=8, ge=1, le=256)
    max_usd_per_run: float = Field(default=5.0, gt=0)
    max_wall_clock_seconds: int = Field(default=3600, ge=30)
    on_exceed: str = Field(default="hard_stop", pattern="^(warn|hard_stop)$")


class BudgetLedger(BaseModel):
    """Running tally of what a run has spent."""

    sandbox_seconds: float = 0.0
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    usd_spent: float = 0.0
    sandboxes_created: int = 0

    def merge(self, other: BudgetLedger) -> BudgetLedger:
        return BudgetLedger(
            sandbox_seconds=self.sandbox_seconds + other.sandbox_seconds,
            llm_input_tokens=self.llm_input_tokens + other.llm_input_tokens,
            llm_output_tokens=self.llm_output_tokens + other.llm_output_tokens,
            usd_spent=self.usd_spent + other.usd_spent,
            sandboxes_created=self.sandboxes_created + other.sandboxes_created,
        )


class BudgetExceeded(RuntimeError):
    """Raised when a run crosses its spend ceiling and ``on_exceed`` is hard_stop."""

    def __init__(self, spent: float, cap: float) -> None:
        super().__init__(f"run exceeded budget: ${spent:.2f} spent against a ${cap:.2f} cap")
        self.spent = spent
        self.cap = cap
