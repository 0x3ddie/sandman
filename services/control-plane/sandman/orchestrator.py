"""The run lifecycle.

One investigation, end to end:

1. **Resolve revisions.** The current LKG is read from the configured branch; the
   baseline is the *previous* rollout, resolved as the second-newest merge on
   that branch unless the project pins one. Both are pinned to an exact commit
   before anything else happens.
2. **Probe.** BASELINE and INITIAL fan out concurrently and run every enabled
   probe. There is no hotfix lane yet -- there is no patch.
3. **Compare.** Lane results reduce to verdicts, then to findings. This is where
   a failure is classified as *new* or *pre-existing*, which decides whether it
   is this rollout's problem at all.
4. **Remediate.** Only findings this rollout caused get a patch. Codex authors it
   in a workspace with no credentials, the control plane publishes the branch,
   Greptile reviews, and GitHub merges into a standalone branch.
5. **Verify.** The merged branch becomes the HOTFIX lane and the *same* probes
   run again, now three-way. A hotfix that fixes its target while breaking
   something else shows up here as a REGRESSION and blocks promotion.
6. **Promote.** Only a clean three-way verdict opens the gate to LKG.

Ownership at step 4 is deliberate and worth stating plainly: **Codex authors,
Greptile gates, GitHub merges.** Greptile cannot create, write, or merge pull
requests -- nothing here asks it to.
"""

from __future__ import annotations

import contextlib
import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sandman_sdk import ProbeDefinition, discover, registry

from .budget import BudgetTracker
from .codex import CodexError, CodexRunner, PatchRejected, validate_patch
from .config import ProjectConfig, Settings, get_settings
from .events import EventType, RunEventBus
from .fanout import FanOutEngine, FanOutError, plan_variants, preflight
from .github import GitHubApp, GitHubClient, GitWorkspace, clone_workspace
from .greptile import GreptileReviewer, GreptileUnavailable, ReviewResult
from .memory import MemoryClient, MemoryScope
from .models import (
    BudgetExceeded,
    Finding,
    ProbeResult,
    Revision,
    RunState,
    Variant,
)
from .sandboxes import SandboxFactory
from .verdict import IncompleteInvestigation, RunVerdict, evaluate

log = logging.getLogger("sandman.orchestrator")


class OrchestratorError(RuntimeError):
    """The run could not proceed."""


@dataclass(slots=True)
class HotfixAttempt:
    """One patch, from authoring through to the promotion gate."""

    id: str
    finding: Finding
    state: str = "authoring"
    branch: str | None = None
    base_sha: str | None = None
    commit_sha: str | None = None
    root_cause: str | None = None
    fix_summary: str | None = None
    diff: str = ""
    files_changed: list[str] = field(default_factory=list)
    tests_passed: bool | None = None
    confidence: float | None = None
    rejection_reason: str | None = None
    pr_number: int | None = None
    pr_url: str | None = None
    review: ReviewResult | None = None
    merged_sha: str | None = None
    promoted: bool = False
    prior_fixes: list[str] = field(default_factory=list)

    @property
    def publishable(self) -> bool:
        return bool(self.diff.strip()) and self.rejection_reason is None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "probeId": self.finding.probe_id,
            "classification": self.finding.classification.value,
            "branch": self.branch,
            "commitSha": self.commit_sha,
            "rootCause": self.root_cause,
            "fixSummary": self.fix_summary,
            "filesChanged": list(self.files_changed),
            "testsPassed": self.tests_passed,
            "confidence": self.confidence,
            "rejectionReason": self.rejection_reason,
            "prNumber": self.pr_number,
            "prUrl": self.pr_url,
            "reviewApproved": self.review.approved if self.review else None,
            "reviewScore": self.review.score if self.review else None,
            "mergedSha": self.merged_sha,
            "promoted": self.promoted,
        }


@dataclass(slots=True)
class RunOutcome:
    """Everything an investigation produced."""

    run_id: str
    state: RunState
    revisions: dict[Variant, Revision] = field(default_factory=dict)
    initial_results: list[ProbeResult] = field(default_factory=list)
    verification_results: list[ProbeResult] = field(default_factory=list)
    verdict: RunVerdict | None = None
    verification_verdict: RunVerdict | None = None
    hotfixes: list[HotfixAttempt] = field(default_factory=list)
    budget: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def promotable(self) -> list[HotfixAttempt]:
        """Hotfixes whose three-way verification came back clean."""
        if self.verification_verdict is None:
            return []
        if not self.verification_verdict.safe_to_promote:
            return []
        return [h for h in self.hotfixes if h.merged_sha]

    def summary(self) -> dict[str, Any]:
        verdict = self.verification_verdict or self.verdict
        return {
            "runId": self.run_id,
            "state": self.state.value,
            "revisions": {k.value: str(v) for k, v in self.revisions.items()},
            "counts": verdict.counts() if verdict else {},
            "findings": len(verdict.findings) if verdict else 0,
            "blocking": len(verdict.blocking) if verdict else 0,
            "preExisting": len(verdict.pre_existing) if verdict else 0,
            "hotfixes": [h.as_dict() for h in self.hotfixes],
            "safeToPromote": bool(verdict and verdict.safe_to_promote),
            "budget": self.budget,
            "error": self.error,
        }


class Orchestrator:
    """Drives one investigation."""

    def __init__(
        self,
        config: ProjectConfig,
        *,
        settings: Settings | None = None,
        bus: RunEventBus | None = None,
        run_id: str | None = None,
        factory: SandboxFactory | None = None,
        memory: MemoryClient | None = None,
    ) -> None:
        self.config = config
        self.settings = settings or get_settings()
        self.run_id = run_id or f"run_{uuid.uuid4().hex[:12]}"
        self.bus = bus or RunEventBus(self.run_id)
        self.budget = BudgetTracker(caps=config.budget)
        self.factory = factory or SandboxFactory(
            self.settings, self.settings.sandman_modal_app_name, on_state=None
        )
        self.memory = memory or MemoryClient(self.settings)
        self.outcome = RunOutcome(run_id=self.run_id, state=RunState.QUEUED)

    # -- probes -----------------------------------------------------------

    def build_probes(self) -> list[ProbeDefinition]:
        """Instantiate every enabled probe: presets plus user-authored ones."""
        from sandman_probes import build_preset

        definitions: list[ProbeDefinition] = []
        for spec in self.config.enabled_probes:
            if spec.preset:
                params = {**spec.params, "fanout": spec.fanout,
                          "timeout_seconds": spec.timeout_seconds}
                definitions.extend(build_preset(spec.preset, spec.id, params))
            else:
                assert spec.module is not None
                discover([spec.module])
                definitions.append(registry.get(spec.id))

        if self.config.custom_probe_paths:
            with contextlib.suppress(Exception):
                definitions.extend(discover(self.config.custom_probe_paths))

        if not definitions:
            raise OrchestratorError("no probes resolved; nothing to investigate")
        return definitions

    # -- revisions --------------------------------------------------------

    async def resolve_revisions(self, owner: str, repo: str) -> dict[Variant, Revision]:
        """Pin the baseline and the current LKG to exact commits.

        Both must be pinned before any sandbox is built: an unpinned ref can move
        mid-run and silently invalidate every verdict derived from it.
        """
        app = GitHubApp(self.settings)
        token = await app.token_for(owner, repo)
        client = GitHubClient(token.token)
        try:
            lkg_sha = await client.get_branch_sha(owner, repo, self.config.lkg_branch)
            initial = Revision(ref=self.config.lkg_branch, sha=lkg_sha)

            baseline = self.config.previous_lkg_revision()
            if baseline is None:
                baseline = await client.resolve_previous_lkg(
                    owner, repo, self.config.lkg_branch
                )
            if baseline is None:
                raise OrchestratorError(
                    f"could not resolve a previous rollout on {self.config.lkg_branch!r}; "
                    "pin one with previous_lkg so the baseline lane has a reference"
                )
            return {Variant.BASELINE: baseline, Variant.INITIAL: initial}
        finally:
            await client.aclose()
            await app.aclose()

    # -- phases -----------------------------------------------------------

    async def probe_phase(
        self, revisions: dict[Variant, Revision], probes: Sequence[ProbeDefinition]
    ) -> list[ProbeResult]:
        """Fan out BASELINE and INITIAL and collect every result."""
        self.bus.set_run_state(RunState.PROVISIONING)
        plans = plan_variants(self.config, revisions)
        if not plans:
            raise OrchestratorError("no variants enabled")

        engine = FanOutEngine(
            factory=self.factory,
            budget=self.budget,
            bus=self.bus,
            repo_url=self.config.repository_url,
        )
        self.bus.set_run_state(RunState.PROBING)
        results: list[ProbeResult] = await engine.run_all(plans, probes)
        self.bus.emit(EventType.BUDGET, **self.budget.snapshot())
        return results

    def compare_phase(
        self, results: Sequence[ProbeResult], *, require_hotfix: bool
    ) -> RunVerdict:
        self.bus.set_run_state(RunState.COMPARING)
        try:
            verdict = evaluate(
                self.run_id, results, require_hotfix=require_hotfix, include_stable=False
            )
        except IncompleteInvestigation as exc:
            # Invariant 3: refuse to publish a verdict built on a lane that never ran.
            raise OrchestratorError(str(exc)) from exc

        for finding in verdict.findings:
            self.bus.emit(
                EventType.FINDING,
                findingId=finding.id,
                probeId=finding.probe_id,
                classification=finding.classification.value,
                severity=finding.severity.value,
                title=finding.title,
                previouslyIgnored=finding.previously_ignored,
            )
        self.bus.emit(EventType.VERDICT, counts=verdict.counts())
        return verdict

    async def annotate_with_memory(self, verdict: RunVerdict, scope: MemoryScope) -> None:
        """Mark findings earlier runs already surfaced, and record this run's.

        Memory is orchestrator-mediated: sandboxes cannot reach the local worker,
        so only this process reads or writes it.
        """
        if not self.settings.sandman_memory_enabled:
            return
        if not await self.memory.available():
            return

        for finding in verdict.pre_existing:
            prior = await self.memory.recall_persistent_failures(
                project=scope.project, probe_id=finding.probe_id, limit=3
            )
            if prior:
                finding.previously_ignored = True
                finding.first_seen_run_id = prior[-1].rollout_id or None

        with contextlib.suppress(Exception):
            await self.memory.record_batch(verdict.findings, scope)

    async def remediate_phase(
        self, verdict: RunVerdict, revisions: dict[Variant, Revision], scope: MemoryScope
    ) -> list[HotfixAttempt]:
        """Author, review, and merge a patch for each finding this rollout caused.

        Pre-existing failures are deliberately excluded: they are not what this
        rollout broke, and folding them into a hotfix would smuggle unrelated
        change into a PR that is supposed to be reviewable at a glance.
        """
        candidates = verdict.hotfix_candidates
        if not candidates:
            return []

        self.bus.set_run_state(RunState.REMEDIATING)
        owner, repo = _split_repo(self.config.repository_url)
        attempts: list[HotfixAttempt] = []

        for finding in candidates:
            attempt = HotfixAttempt(
                id=f"hfx_{uuid.uuid4().hex[:10]}", finding=finding
            )
            attempts.append(attempt)
            try:
                await self._author_and_publish(
                    attempt, revisions[Variant.INITIAL], owner, repo, scope
                )
            except BudgetExceeded:
                raise
            except (CodexError, PatchRejected, GreptileUnavailable) as exc:
                attempt.state = "failed"
                attempt.rejection_reason = str(exc)
                self.bus.emit(EventType.HOTFIX, **attempt.as_dict())
            except Exception as exc:
                attempt.state = "failed"
                attempt.rejection_reason = f"{type(exc).__name__}: {exc}"
                log.exception("hotfix %s failed", attempt.id)
                self.bus.emit(EventType.HOTFIX, **attempt.as_dict())
        return attempts

    async def _author_and_publish(
        self,
        attempt: HotfixAttempt,
        revision: Revision,
        owner: str,
        repo: str,
        scope: MemoryScope,
    ) -> None:
        finding = attempt.finding

        # Recall how an equivalent failure was fixed before. This is the payoff
        # of persistent memory: the second occurrence starts from the answer.
        if self.settings.sandman_memory_enabled and await self.memory.available():
            recollections = await self.memory.recall_prior_fixes(
                probe_id=finding.probe_id,
                error_class=None,
                project=scope.project,
                limit=3,
            )
            attempt.prior_fixes = [r.text for r in recollections]

        app = GitHubApp(self.settings)
        token = await app.token_for(owner, repo)
        try:
            async with clone_workspace(
                self.config.repository_url, revision, token=token.token
            ) as workspace:
                attempt.base_sha = revision.sha
                await self._run_codex(attempt, workspace)

                if not attempt.publishable:
                    attempt.state = "rejected"
                    self.bus.emit(EventType.HOTFIX, **attempt.as_dict())
                    return

                validate_patch(attempt.diff, attempt.files_changed, self.config.promotion)

                branch = f"{self.config.hotfix_branch_prefix}-{attempt.id}"
                attempt.branch = branch
                await workspace.create_branch(branch)
                attempt.commit_sha = await workspace.commit_all(
                    _commit_message(attempt),
                    "sandman[bot]",
                    "sandman[bot]@users.noreply.github.com",
                )
                # Publication is a separate, narrowly-scoped step: the patch
                # author never held this token.
                await workspace.push(branch, token.token)
                attempt.state = "published"
                self.bus.emit(EventType.HOTFIX, **attempt.as_dict())

                await self._review_and_merge(attempt, owner, repo, token.token)
        finally:
            await app.aclose()

    async def _run_codex(self, attempt: HotfixAttempt, workspace: GitWorkspace) -> None:
        runner = CodexRunner(self.settings)
        async with self.budget.llm_slot():
            result = await runner.author_patch(
                workdir=workspace.path,
                prompt=_hotfix_prompt(attempt.finding),
                model=self.settings.sandman_model_hotfix,
                prior_fixes=attempt.prior_fixes or None,
            )
        attempt.diff = result.diff
        attempt.files_changed = list(result.files_changed)
        if result.verdict is not None:
            attempt.root_cause = result.verdict.root_cause
            attempt.fix_summary = result.verdict.fix_summary
            attempt.tests_passed = result.verdict.tests_passed
            attempt.confidence = result.verdict.confidence

        usage_in, usage_out = _token_usage(result)
        if usage_in or usage_out:
            await self.budget.charge_tokens(
                model=self.settings.sandman_model_hotfix,
                input_tokens=usage_in,
                output_tokens=usage_out,
            )

        if attempt.tests_passed is False:
            # A patch whose own tests fail is not a candidate for review.
            attempt.rejection_reason = "codex reported its own tests failing"

    async def _review_and_merge(
        self, attempt: HotfixAttempt, owner: str, repo: str, token: str
    ) -> None:
        assert attempt.branch is not None
        self.bus.set_run_state(RunState.REVIEWING)

        client = GitHubClient(token)
        try:
            pr = await client.create_pull_request(
                owner,
                repo,
                head=attempt.branch,
                base=self.config.lkg_branch,
                title=f"sandman: fix {attempt.finding.probe_id}",
                body=_pr_body(attempt),
                draft=False,
            )
            attempt.pr_number = pr.number
            attempt.pr_url = pr.html_url
            attempt.state = "in_review"
            self.bus.emit(EventType.HOTFIX, **attempt.as_dict())

            reviewer = GreptileReviewer(self.settings)
            review = await reviewer.poll_pr_review(
                owner, repo, pr.number, github_token=token
            )
            attempt.review = review
            self.bus.emit(
                EventType.REVIEW,
                hotfixId=attempt.id,
                approved=review.approved,
                score=review.score,
                summary=review.summary,
                blocking=len(review.blocking_comments),
            )

            if review.gates_merge(self.config.promotion.require_greptile_approval):
                attempt.state = "blocked"
                attempt.rejection_reason = review.gate_reason or "review did not approve"
                self.bus.emit(EventType.HOTFIX, **attempt.as_dict())
                return

            # Greptile is the gate; GitHub performs the merge. The target is the
            # standalone branch, never LKG directly -- LKG is reached only after
            # the merged branch re-probes clean.
            attempt.merged_sha = await client.merge_pull_request(
                owner, repo, pr.number, method="squash"
            )
            attempt.state = "merged"
            self.bus.emit(EventType.HOTFIX, **attempt.as_dict())
        finally:
            await client.aclose()

    async def verify_phase(
        self,
        attempts: Sequence[HotfixAttempt],
        revisions: dict[Variant, Revision],
        probes: Sequence[ProbeDefinition],
    ) -> tuple[list[ProbeResult], RunVerdict | None]:
        """Re-probe the merged hotfix branch, three-way this time.

        This is the step that makes the promise real: a patch that fixes its
        target while breaking something else is caught here, not in production.
        """
        merged = [a for a in attempts if a.merged_sha]
        if not merged or not self.config.promotion.require_reprobe:
            return [], None

        self.bus.set_run_state(RunState.VERIFYING)
        winner = merged[-1]
        assert winner.merged_sha is not None and winner.branch is not None

        three_way = dict(revisions)
        three_way[Variant.HOTFIX] = Revision(ref=winner.branch, sha=winner.merged_sha)

        plans = plan_variants(self.config, three_way)
        engine = FanOutEngine(
            factory=self.factory,
            budget=self.budget,
            bus=self.bus,
            repo_url=self.config.repository_url,
        )
        results = await engine.run_all(plans, probes)
        verdict = self.compare_phase(results, require_hotfix=True)
        self.outcome.revisions = three_way
        return results, verdict

    async def promote_phase(
        self, attempts: Sequence[HotfixAttempt], verdict: RunVerdict | None
    ) -> None:
        """Open (or refuse) the gate to LKG."""
        policy = self.config.promotion
        if verdict is None:
            return

        blocked = policy.block_on_regression and not verdict.safe_to_promote
        for attempt in attempts:
            if not attempt.merged_sha:
                continue
            if blocked:
                attempt.state = "verification_failed"
                attempt.rejection_reason = (
                    f"re-probe found {len(verdict.blocking)} blocking finding(s)"
                )
            elif policy.auto_promote:
                attempt.state = "promoted"
                attempt.promoted = True
            else:
                # The gate is open but a human still turns the key.
                attempt.state = "awaiting_promotion"
            self.bus.emit(EventType.PROMOTION, **attempt.as_dict())

    # -- entry point ------------------------------------------------------

    async def run(self) -> RunOutcome:
        self.bus.start()
        owner_repo = "/".join(_split_repo(self.config.repository_url))
        scope = MemoryScope(
            project=owner_repo,
            rollout_id=self.run_id,
            variant=None,
            region=None,
            probe_id=None,
        )
        try:
            probes = self.build_probes()
            preflight(self.config, self.budget)

            owner, repo = _split_repo(self.config.repository_url)
            revisions = await self.resolve_revisions(owner, repo)
            self.outcome.revisions = dict(revisions)
            self.bus.emit(
                EventType.RUN_PROGRESS,
                phase="revisions",
                revisions={k.value: str(v) for k, v in revisions.items()},
            )

            results = await self.probe_phase(revisions, probes)
            self.outcome.initial_results = results

            verdict = self.compare_phase(results, require_hotfix=False)
            self.outcome.verdict = verdict
            await self.annotate_with_memory(verdict, scope)

            attempts = await self.remediate_phase(verdict, revisions, scope)
            self.outcome.hotfixes = attempts

            verify_results, verify_verdict = await self.verify_phase(
                attempts, revisions, probes
            )
            self.outcome.verification_results = verify_results
            self.outcome.verification_verdict = verify_verdict

            await self.promote_phase(attempts, verify_verdict)
            await self._record_hotfix_memory(attempts, scope, verify_verdict)

            self.outcome.state = RunState.COMPLETED
        except BudgetExceeded as exc:
            self.outcome.state = RunState.ABORTED
            self.outcome.error = str(exc)
            self.bus.emit(EventType.ERROR, reason="budget", detail=str(exc))
        except (OrchestratorError, FanOutError) as exc:
            self.outcome.state = RunState.FAILED
            self.outcome.error = str(exc)
            self.bus.emit(EventType.ERROR, reason="orchestration", detail=str(exc))
        except Exception as exc:
            self.outcome.state = RunState.FAILED
            self.outcome.error = f"{type(exc).__name__}: {exc}"
            log.exception("run %s failed", self.run_id)
            self.bus.emit(EventType.ERROR, reason="unexpected", detail=self.outcome.error)
        finally:
            self.outcome.budget = self.budget.snapshot()
            # summary() carries its own "state" key, which would collide with the
            # positional argument.
            payload = {k: v for k, v in self.outcome.summary().items() if k != "state"}
            self.bus.set_run_state(self.outcome.state, **payload)
            with contextlib.suppress(Exception):
                await self.memory.aclose()
            await self.bus.close()
        return self.outcome

    async def _record_hotfix_memory(
        self,
        attempts: Sequence[HotfixAttempt],
        scope: MemoryScope,
        verdict: RunVerdict | None,
    ) -> None:
        if not self.settings.sandman_memory_enabled:
            return
        if not await self.memory.available():
            return
        import hashlib

        verified = bool(verdict and verdict.safe_to_promote)
        for attempt in attempts:
            if not attempt.diff:
                continue
            with contextlib.suppress(Exception):
                await self.memory.record_hotfix(
                    scope=scope,
                    probe_id=attempt.finding.probe_id,
                    root_cause=attempt.root_cause or attempt.finding.title,
                    fix_summary=attempt.fix_summary or "",
                    diff_digest=hashlib.sha256(attempt.diff.encode()).hexdigest()[:16],
                    pr_url=attempt.pr_url,
                    verified=verified and attempt.state in {"merged", "promoted",
                                                            "awaiting_promotion"},
                )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _split_repo(url: str) -> tuple[str, str]:
    trimmed = url.rstrip("/").removesuffix(".git")
    if trimmed.startswith("git@"):
        trimmed = trimmed.split(":", 1)[-1]
    parts = [p for p in trimmed.split("/") if p]
    if len(parts) < 2:
        raise OrchestratorError(f"cannot derive owner/repo from {url!r}")
    return parts[-2], parts[-1]


def _hotfix_prompt(finding: Finding) -> str:
    return (
        f"A production-rollout probe found a regression.\n\n"
        f"Probe: {finding.probe_id}\n"
        f"Classification: {finding.classification.value}\n"
        f"Title: {finding.title}\n\n"
        f"{finding.description}\n\n"
        f"Evidence per revision:\n"
        + "\n".join(f"  {k.glyph} {k.value}: {v}" for k, v in finding.variant_evidence.items())
        + (f"\n\nReproduction: {finding.reproduction}" if finding.reproduction else "")
        + "\n\nFix the root cause with the smallest correct change. Do not modify CI "
        "configuration, credentials, or agent instructions. Run the project's tests and "
        "report whether they pass."
    )


def _commit_message(attempt: HotfixAttempt) -> str:
    title = attempt.fix_summary or attempt.finding.title
    body = attempt.root_cause or attempt.finding.description
    return f"fix: {title}\n\n{body}\n\nFound by sandman probe {attempt.finding.probe_id}."


def _pr_body(attempt: HotfixAttempt) -> str:
    finding = attempt.finding
    evidence = "\n".join(
        f"| {v.glyph} {v.value} | `{detail}` |" for v, detail in finding.variant_evidence.items()
    )
    return f"""## What sandman found

**{finding.title}**

{finding.description}

| Revision | Observed |
| --- | --- |
{evidence}

## Root cause

{attempt.root_cause or "_not reported_"}

## Fix

{attempt.fix_summary or "_not reported_"}

Files changed: {", ".join(f"`{f}`" for f in attempt.files_changed) or "_none_"}
Tests reported passing: {attempt.tests_passed}

---

This patch was authored by Codex in a sandbox holding no repository credentials.
It was published by the sandman control plane as a separate, narrowly-scoped step.
Merging is gated on review.

@greptileai please review.
"""


def _token_usage(result: Any) -> tuple[int, int]:
    """Best-effort token accounting from the Codex event stream."""
    total_in = total_out = 0
    for event in getattr(result, "events", []) or []:
        usage = getattr(event, "usage", None)
        if isinstance(usage, dict):
            total_in += int(usage.get("input_tokens") or 0)
            total_out += int(usage.get("output_tokens") or 0)
    return total_in, total_out


async def run_investigation(
    config: ProjectConfig,
    *,
    settings: Settings | None = None,
    bus: RunEventBus | None = None,
    run_id: str | None = None,
) -> RunOutcome:
    """Convenience entry point."""
    orchestrator = Orchestrator(config, settings=settings, bus=bus, run_id=run_id)
    return await orchestrator.run()
