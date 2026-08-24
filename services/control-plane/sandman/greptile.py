"""The autonomous review gate.

Greptile is the only reviewer between an agent-authored patch and a merge, so
this module is written to *fail closed*. Two rules follow from that:

* A missing binary, a missing API key, a timeout or an unparsable payload is
  never turned into a passing review. Each raises :class:`GreptileUnavailable`,
  and the promotion pipeline stalls for a human instead of merging unreviewed
  code.
* :meth:`ReviewResult.gates_merge` is the single place that decides whether a
  merge may proceed. Callers must not re-derive that from ``approved`` alone --
  an approving review that still carries a BLOCKING comment gates the merge.

What Greptile can and cannot do is a hard boundary, not a configuration choice.
It reviews committed code and may auto-approve within a risk ceiling. It cannot
create a branch, write code, commit, or merge -- no CLI, API or MCP surface
does. Every mutation in the hotfix loop is performed by git and the GitHub API
elsewhere in sandman. It also refuses to auto-approve any change touching auth,
secrets, billing, database migrations, infra/CI, or public API surface,
regardless of what ``.greptile/config.json`` says.

Two review transports are supported. The headless CLI (:meth:`review_local`)
reviews the *current local branch* against the repository default branch and
only sees **committed** changes -- callers must commit before invoking it. The
GitHub App (:meth:`poll_pr_review`) reviews a pull request and reports through a
status check and, optionally, an approving review.

The legacy REST surface at ``https://api.greptile.com/v2/`` -- which needs both
an ``Authorization`` bearer and an ``X-GitHub-Token`` header -- is absent from
the current documentation index and is deliberately not used here: an
undocumented endpoint is not something a merge gate should depend on.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import re
import shutil
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, get_settings

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_REVIEW_RULES",
    "GREPTILE_CLI_VERSION",
    "NEVER_AUTO_APPROVED",
    "GreptileError",
    "GreptileReviewer",
    "GreptileUnavailable",
    "ReviewComment",
    "ReviewResult",
    "ReviewSeverity",
]

#: Pinned so that a payload-shape change in a new major cannot silently alter
#: how the gate parses an approval.
GREPTILE_CLI_VERSION = "3.4.1"
GREPTILE_INSTALL_HINT = f"npm i -g greptile@{GREPTILE_CLI_VERSION}"

#: Surfaces Greptile refuses to auto-approve no matter how the repo is
#: configured. A patch reaching into one of these will always need a human, so
#: the hotfix generator is told to stay out of them.
NEVER_AUTO_APPROVED: tuple[str, ...] = (
    "authentication and authorization",
    "secrets and credential handling",
    "billing and payments",
    "database migrations",
    "infrastructure and CI configuration",
    "public API surface",
)

_GITHUB_API = "https://api.github.com"
_GITHUB_ACCEPT = "application/vnd.github+json"
_GITHUB_API_VERSION = "2022-11-28"

_MAX_HTTP_ATTEMPTS = 4
_BACKOFF_BASE_SECONDS = 0.5
_BACKOFF_CAP_SECONDS = 8.0
_RETRY_AFTER_CAP_SECONDS = 30.0
_PAGE_SIZE = 100
_MAX_PAGES = 5
_MAX_ANNOTATIONS = 50

#: The CLI can emit a large diff alongside the verdict; keep the retained tail
#: bounded so an error or a persisted ``raw`` payload cannot blow up a log line.
_MAX_STDERR_CHARS = 2_000


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class GreptileError(RuntimeError):
    """Greptile was reachable but the review could not be trusted or parsed."""


class GreptileUnavailable(GreptileError):
    """No usable review exists: tool missing, unauthenticated, or timed out.

    Always fatal for the promotion path. There is no degraded mode in which an
    absent reviewer counts as an approval.
    """


class _TransientGitHubError(GreptileError):
    """A GitHub read failed in a way worth retrying on the next poll tick."""


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# Applied to every string this module logs or embeds in an exception. Review
# output is influenced by repository content, and the GitHub token handed to
# :meth:`GreptileReviewer.poll_pr_review` is narrowly scoped but still a
# credential: neither may reach a log line.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9._\-]{16,}"),
    re.compile(r"\bak-[A-Za-z0-9._\-]{16,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\b(?:bearer|token|basic)\s+[A-Za-z0-9._\-+/=]{12,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|password|authorization)\b\s*[=:]\s*\S+"),
    re.compile(r"(?i)://[^/\s:@]+:[^/\s@]+@"),
)

_REDACTED = "[redacted]"


def redact(value: str, extra: Iterable[str] = ()) -> str:
    """Scrub token-shaped text and known literal credentials."""
    out = value
    for literal in extra:
        if literal and len(literal) >= 8:
            out = out.replace(literal, _REDACTED)
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(_REDACTED, out)
    return out


def _tail(value: str, limit: int = _MAX_STDERR_CHARS) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return "...(truncated)... " + text[-limit:]


# Credentials that have no business inside a third-party reviewer process. The
# CLI needs GREPTILE_API_KEY and git; it needs nothing that can push, spend, or
# provision.
_STRIPPED_CHILD_ENV: frozenset[str] = frozenset(
    {
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
        "GH_TOKEN",
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_TOKEN",
        "MODAL_TOKEN_ID",
        "MODAL_TOKEN_SECRET",
        "NPM_TOKEN",
        "OPENAI_API_KEY",
        "SANDMAN_KEK",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
    }
)


# ---------------------------------------------------------------------------
# Review model
# ---------------------------------------------------------------------------


class ReviewSeverity(StrEnum):
    """How much weight a single comment carries at the merge gate."""

    BLOCKING = "blocking"
    MAJOR = "major"
    MINOR = "minor"
    NIT = "nit"

    @property
    def blocks(self) -> bool:
        return self is ReviewSeverity.BLOCKING

    @property
    def rank(self) -> int:
        """Sort key; worst first."""
        return {"blocking": 0, "major": 1, "minor": 2, "nit": 3}[self.value]


#: Vocabularies seen across the CLI payload, PR comment bodies and check-run
#: annotation levels, mapped onto the four severities the gate understands.
_SEVERITY_ALIASES: dict[str, ReviewSeverity] = {
    "blocking": ReviewSeverity.BLOCKING,
    "blocker": ReviewSeverity.BLOCKING,
    "critical": ReviewSeverity.BLOCKING,
    "high": ReviewSeverity.BLOCKING,
    "error": ReviewSeverity.BLOCKING,
    "failure": ReviewSeverity.BLOCKING,
    "bug": ReviewSeverity.BLOCKING,
    "security": ReviewSeverity.BLOCKING,
    "major": ReviewSeverity.MAJOR,
    "medium": ReviewSeverity.MAJOR,
    "warning": ReviewSeverity.MAJOR,
    "logic": ReviewSeverity.MAJOR,
    "syntax": ReviewSeverity.MAJOR,
    "minor": ReviewSeverity.MINOR,
    "low": ReviewSeverity.MINOR,
    "notice": ReviewSeverity.MINOR,
    "style": ReviewSeverity.MINOR,
    "suggestion": ReviewSeverity.MINOR,
    "info": ReviewSeverity.NIT,
    "nit": ReviewSeverity.NIT,
    "nitpick": ReviewSeverity.NIT,
}

_SEVERITY_TAG_RE = re.compile(r"[\[(]?\s*(?P<word>[A-Za-z]+)\s*[\])]?\s*:", re.ASCII)


def parse_severity(value: object, default: ReviewSeverity = ReviewSeverity.MAJOR) -> ReviewSeverity:
    """Map an arbitrary severity token onto :class:`ReviewSeverity`.

    Defaults to MAJOR rather than NIT: an unrecognised severity is an unknown
    risk, and quietly downgrading it would weaken the gate.
    """
    if isinstance(value, ReviewSeverity):
        return value
    if not isinstance(value, str):
        return default
    return _SEVERITY_ALIASES.get(value.strip().lower(), default)


def _severity_from_body(
    body: str, default: ReviewSeverity = ReviewSeverity.MAJOR
) -> ReviewSeverity:
    """Recover a severity from a prose comment, e.g. ``[blocking] ...`` or ``nit: ...``."""
    head = body.lstrip()[:64]
    match = _SEVERITY_TAG_RE.match(head)
    if match:
        found = _SEVERITY_ALIASES.get(match.group("word").lower())
        if found is not None:
            return found
    lowered = head.lower()
    for token, severity in _SEVERITY_ALIASES.items():
        if severity.blocks and token in lowered:
            return severity
    return default


class ReviewComment(BaseModel):
    """One reviewer remark, anchored to a file and (usually) a line."""

    model_config = ConfigDict(frozen=True)

    path: str
    line: int | None = None
    severity: ReviewSeverity = ReviewSeverity.MAJOR
    body: str
    suggested_code: str | None = None

    def render(self) -> str:
        location = f"{self.path}:{self.line}" if self.line is not None else self.path
        return f"[{self.severity.value}] {location} — {self.body}"


class ReviewResult(BaseModel):
    """The outcome of one review, from either transport.

    ``approved`` is never inferred: a payload that does not explicitly say the
    change was approved yields ``False``.
    """

    approved: bool
    score: int | None = Field(default=None, ge=0, le=5)
    comments: list[ReviewComment] = Field(default_factory=list)
    risk: str | None = None
    summary: str
    source: str = Field(pattern="^(cli|github_app)$")
    raw: dict[str, Any] = Field(default_factory=dict)

    @property
    def blocking_comments(self) -> list[ReviewComment]:
        return [c for c in self.comments if c.severity.blocks]

    def gates_merge(self, require_approval: bool) -> bool:
        """True when the merge must NOT proceed.

        A blocking comment stops the merge even on an approving review: the two
        can disagree when auto-approval fires on a risk score while a rule-based
        check flags a specific line.
        """
        if self.blocking_comments:
            return True
        return require_approval and not self.approved

    @property
    def gate_reason(self) -> str | None:
        """Why the merge is blocked, for the dashboard. ``None`` when clear."""
        blocking = self.blocking_comments
        if blocking:
            first = blocking[0].render()
            extra = f" (+{len(blocking) - 1} more)" if len(blocking) > 1 else ""
            return f"{len(blocking)} blocking review comment(s): {first}{extra}"
        if not self.approved:
            return f"Greptile did not approve: {self.summary[:200]}"
        return None

    def sorted_comments(self) -> list[ReviewComment]:
        return sorted(self.comments, key=lambda c: (c.severity.rank, c.path, c.line or 0))


# ---------------------------------------------------------------------------
# Review rules
# ---------------------------------------------------------------------------

#: Written to ``.greptile/rules.md`` on every branch we ask Greptile to review.
#: These encode sandman's own safety invariants -- the reviewer is the last
#: automated check before an agent-authored patch reaches the LKG branch.
DEFAULT_REVIEW_RULES: list[str] = [
    "BLOCKING: Reject any change that grants push, write, or publish capability to a "
    "patch-generation agent. Patch generation runs in a workspace with no GitHub and no "
    "Modal credentials; publishing a branch is a separate, narrowly scoped call. A diff "
    "that adds a token, a remote, a `git push`, or a credential mount to that workspace is "
    "a privilege escalation, not a hotfix.",
    "BLOCKING: Reject any change that resolves a git revision from a moving ref. Every "
    "revision must be pinned as REF@SHA and the checked-out SHA must be verified after "
    "checkout. Dropping the verification, defaulting a SHA, or accepting a bare branch "
    "name lets evidence drift underneath a running investigation.",
    "BLOCKING: Reject any change that lets a failed, timed-out, partial, or skipped lane "
    "produce a verified verdict. Missing lane results must fail closed. Treating an absent "
    "or errored variant as a pass -- with a default, a `try/except` that swallows, or an "
    "`or True` -- silently converts an unknown into a green promotion.",
    "BLOCKING: Reject any change that logs, prints, serialises, or embeds a credential in "
    "an error, an event payload, a memory record, or a persisted artefact. Every error path "
    "that carries subprocess output, an HTTP body, or an exception string must pass through "
    "the module's redaction helper first.",
    "BLOCKING: Reject silent failure. Errors must raise the module's typed exceptions; a "
    "bare `except: pass`, a swallowed exception, or a placeholder return that fabricates a "
    "successful result is never acceptable in the promotion path.",
    "MAJOR: Network calls must use httpx.AsyncClient with explicit timeouts and bounded "
    "retries limited to 429 and 5xx, honouring Retry-After. An unbounded retry or a missing "
    "timeout can hang a run past its wall-clock budget.",
    "MAJOR: Subprocess and sandbox invocations must set an explicit timeout and must not "
    "pass credentials through argv, where they are visible in the process table.",
    "MAJOR: Public functions are fully type-annotated (mypy strict); no bare `Any` where a "
    "real type exists, and no stubs, TODOs, or placeholder returns.",
    "MINOR: Comments state constraints the code cannot express -- an API quirk, a limit, a "
    "safety rule. They do not narrate the next line.",
]


def render_rules(rules: Sequence[str]) -> str:
    """Render rules as the markdown document Greptile reads."""
    lines = [
        "# sandman review rules",
        "",
        "This branch is an autonomously generated hotfix. Review it as a merge gate:",
        "a BLOCKING finding stops promotion to the last-known-good branch.",
        "",
        "## Rules",
        "",
    ]
    lines += [f"{i}. {rule}" for i, rule in enumerate(rules, start=1)]
    lines += [
        "",
        "## Never auto-approve",
        "",
        "Do not auto-approve a change touching:",
        "",
    ]
    lines += [f"- {surface}" for surface in NEVER_AUTO_APPROVED]
    lines.append("")
    return "\n".join(lines)


#: strictness 2 = the strictest tier the CLI accepts; drafts and pushed updates
#: both retrigger, because a hotfix branch is force-updated as the loop iterates
#: and a stale review would gate the wrong commit.
_DEFAULT_CONFIG: dict[str, Any] = {
    "strictness": 2,
    "commentTypes": ["logic", "syntax", "style"],
    "triggerOnDrafts": True,
    "triggerOnUpdates": True,
}


# ---------------------------------------------------------------------------
# Reviewer
# ---------------------------------------------------------------------------


class GreptileReviewer:
    """Runs the review gate over a hotfix branch.

    One instance per run; it holds no connection state, so it is safe to share
    across lanes.
    """

    def __init__(self, settings: Settings | None = None, *, binary: str = "greptile") -> None:
        self.settings = settings if settings is not None else get_settings()
        self._binary = binary

    # -- helpers -----------------------------------------------------------

    def _scrub(self, value: object, extra: Iterable[str] = ()) -> str:
        literals = [self.settings.greptile_api_key or "", *extra]
        return redact(str(value), literals)

    def _api_key(self) -> str:
        key: str | None = self.settings.greptile_api_key
        if not key:
            raise GreptileUnavailable(
                "GREPTILE_API_KEY is not set; the review gate fails closed rather than "
                "merging an unreviewed patch"
            )
        return key

    def _child_env(self, api_key: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in _STRIPPED_CHILD_ENV}
        env["GREPTILE_API_KEY"] = api_key
        # Some npm CLIs colourise even when piped, which corrupts JSON parsing.
        env["NO_COLOR"] = "1"
        env["FORCE_COLOR"] = "0"
        return env

    def _resolve_binary(self) -> str:
        found = shutil.which(self._binary)
        if found is None:
            raise GreptileUnavailable(
                f"the Greptile CLI ({self._binary!r}) is not on PATH. Install it with "
                f"`{GREPTILE_INSTALL_HINT}`. A missing reviewer is never treated as an "
                "approval -- promotion stops here."
            )
        return found

    # -- CLI transport -----------------------------------------------------

    async def review_local(self, workdir: Path, timeout_s: int = 600) -> ReviewResult:
        """Review the branch currently checked out in ``workdir``.

        ``greptile review`` diffs the current local branch against the
        repository default branch and sees **committed changes only**; anything
        left in the working tree is invisible to it, so callers must commit
        before calling.
        """
        if timeout_s <= 0:
            raise GreptileError(f"timeout_s must be positive, got {timeout_s}")

        workdir = Path(workdir)
        if not workdir.is_dir():
            raise GreptileError(f"review workdir does not exist: {workdir}")
        if not (workdir / ".git").exists():
            raise GreptileError(
                f"{workdir} is not a git checkout; `greptile review` needs a branch to diff "
                "against the repository default branch"
            )

        api_key = self._api_key()
        binary = self._resolve_binary()
        await self._warn_if_dirty(workdir)

        try:
            proc = await asyncio.create_subprocess_exec(
                binary,
                "review",
                "--json",
                cwd=str(workdir),
                env=self._child_env(api_key),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise GreptileUnavailable(
                f"the Greptile CLI vanished between lookup and launch; install it with "
                f"`{GREPTILE_INSTALL_HINT}`"
            ) from exc
        except OSError as exc:
            raise GreptileError(f"could not launch the Greptile CLI: {self._scrub(exc)}") from exc

        try:
            raw_out, raw_err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except TimeoutError as exc:
            await self._terminate(proc)
            raise GreptileUnavailable(
                f"`greptile review` did not finish within {timeout_s}s; no verdict was "
                "produced, so the merge gate stays closed"
            ) from exc

        stdout = self._scrub(raw_out.decode("utf-8", "replace"))
        stderr = self._scrub(raw_err.decode("utf-8", "replace"))
        payload = _extract_json(stdout)

        if payload is None:
            if proc.returncode != 0:
                raise GreptileUnavailable(
                    f"`greptile review` exited {proc.returncode} without a JSON verdict: "
                    f"{_tail(stderr) or _tail(stdout) or '(no output)'}"
                )
            raise GreptileError(
                "`greptile review --json` produced no parsable JSON object; refusing to "
                f"guess a verdict. stdout tail: {_tail(stdout) or '(empty)'}"
            )

        result = _result_from_payload(payload, source="cli")
        logger.info(
            "greptile cli review: approved=%s score=%s blocking=%d risk=%s",
            result.approved,
            result.score,
            len(result.blocking_comments),
            result.risk,
        )
        return result

    async def _warn_if_dirty(self, workdir: Path) -> None:
        """Uncommitted work is invisible to the reviewer; say so loudly.

        Not fatal: untracked build artefacts are common. Tracked modifications
        mean the reviewed diff is not what is in the tree, which a caller needs
        to know before trusting the verdict.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                "git",
                "status",
                "--porcelain",
                "--untracked-files=no",
                cwd=str(workdir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        except (OSError, TimeoutError):
            return
        dirty = [line for line in out.decode("utf-8", "replace").splitlines() if line.strip()]
        if dirty:
            logger.warning(
                "greptile: %d tracked file(s) are modified but uncommitted in %s; "
                "`greptile review` compares committed changes only and will not see them",
                len(dirty),
                workdir,
            )

    @staticmethod
    async def _terminate(proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=10)

    # -- GitHub App transport ----------------------------------------------

    async def poll_pr_review(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        *,
        github_token: str,
        timeout_s: int = 900,
        interval_s: int = 15,
    ) -> ReviewResult:
        """Wait for the Greptile App to review a PR.

        Looks for either a review authored by a Greptile login or a completed
        Greptile check run on the PR head. Reviews typically land in about three
        minutes; the default deadline allows for a cold index. A deadline with
        nothing found raises :class:`GreptileUnavailable` -- silence is not
        consent.
        """
        if not github_token:
            raise GreptileUnavailable(
                "a GitHub token is required to read PR reviews; the review gate cannot "
                "confirm an approval without one"
            )
        if timeout_s <= 0 or interval_s <= 0:
            raise GreptileError("timeout_s and interval_s must both be positive")

        headers = {
            "Accept": _GITHUB_ACCEPT,
            "Authorization": f"Bearer {github_token}",
            "X-GitHub-Api-Version": _GITHUB_API_VERSION,
            "User-Agent": "sandman-review-gate",
        }
        prefix = f"/repos/{owner}/{repo}"
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        last_transient: str | None = None

        async with httpx.AsyncClient(
            base_url=_GITHUB_API,
            headers=headers,
            timeout=httpx.Timeout(20.0, connect=5.0),
            follow_redirects=True,
        ) as client:
            while True:
                try:
                    result = await self._look_for_review(
                        client, prefix, pr_number, token=github_token
                    )
                    if result is not None:
                        logger.info(
                            "greptile app review on %s/%s#%d: approved=%s blocking=%d",
                            owner,
                            repo,
                            pr_number,
                            result.approved,
                            len(result.blocking_comments),
                        )
                        return result
                except _TransientGitHubError as exc:
                    last_transient = str(exc)
                    logger.warning("greptile: GitHub read failed, retrying: %s", last_transient)

                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                await asyncio.sleep(min(interval_s + random.uniform(0, 2.0), remaining))

        detail = f" (last error: {last_transient})" if last_transient else ""
        raise GreptileUnavailable(
            f"no Greptile review or check run appeared on {owner}/{repo}#{pr_number} within "
            f"{timeout_s}s{detail}; the merge gate stays closed"
        )

    async def _look_for_review(
        self,
        client: httpx.AsyncClient,
        prefix: str,
        pr_number: int,
        *,
        token: str,
    ) -> ReviewResult | None:
        """One poll tick. ``None`` means nothing has landed yet."""
        reviews = await self._paged(client, f"{prefix}/pulls/{pr_number}/reviews", token=token)
        greptile_reviews = [r for r in reviews if _is_greptile_actor(r.get("user"))]
        if greptile_reviews:
            latest = greptile_reviews[-1]
            inline = await self._paged(client, f"{prefix}/pulls/{pr_number}/comments", token=token)
            comments = [
                _comment_from_pr_comment(c) for c in inline if _is_greptile_actor(c.get("user"))
            ]
            return _result_from_review(latest, comments)

        pr = await self._get_json(client, f"{prefix}/pulls/{pr_number}", token=token)
        head_sha = _dig_str(pr, "head", "sha") if isinstance(pr, dict) else None
        if not head_sha:
            raise _TransientGitHubError(f"pull request {pr_number} has no readable head sha")

        checks = await self._get_json(
            client,
            f"{prefix}/commits/{head_sha}/check-runs",
            token=token,
            params={"per_page": str(_PAGE_SIZE)},
        )
        runs = checks.get("check_runs") if isinstance(checks, dict) else None
        if not isinstance(runs, list):
            return None
        for run in runs:
            if not isinstance(run, dict) or not _is_greptile_check(run):
                continue
            if run.get("status") != "completed":
                continue
            annotations = await self._annotations(client, prefix, run, token=token)
            return _result_from_check_run(run, annotations)
        return None

    async def _annotations(
        self,
        client: httpx.AsyncClient,
        prefix: str,
        run: dict[str, Any],
        *,
        token: str,
    ) -> list[ReviewComment]:
        run_id = run.get("id")
        count = _dig_int(run, "output", "annotations_count") or 0
        if not isinstance(run_id, int) or count <= 0:
            return []
        rows = await self._get_json(
            client,
            f"{prefix}/check-runs/{run_id}/annotations",
            token=token,
            params={"per_page": str(min(count, _MAX_ANNOTATIONS))},
        )
        if not isinstance(rows, list):
            return []
        return [
            _comment_from_annotation(row)
            for row in rows[:_MAX_ANNOTATIONS]
            if isinstance(row, dict)
        ]

    # -- GitHub transport --------------------------------------------------

    async def _paged(
        self, client: httpx.AsyncClient, path: str, *, token: str
    ) -> list[dict[str, Any]]:
        """Read every page of a list endpoint, bounded by ``_MAX_PAGES``."""
        out: list[dict[str, Any]] = []
        for page in range(1, _MAX_PAGES + 1):
            body = await self._get_json(
                client,
                path,
                token=token,
                params={"per_page": str(_PAGE_SIZE), "page": str(page)},
            )
            if not isinstance(body, list):
                break
            out.extend(item for item in body if isinstance(item, dict))
            if len(body) < _PAGE_SIZE:
                break
        return out

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        path: str,
        *,
        token: str,
        params: dict[str, str] | None = None,
    ) -> Any:
        """GET with bounded retries on 429/5xx, honouring ``Retry-After``.

        A 4xx other than 429 is a configuration fault (bad token, wrong repo)
        and is raised immediately -- retrying it only burns the poll deadline.
        """
        last: str = "unknown"
        for attempt in range(1, _MAX_HTTP_ATTEMPTS + 1):
            try:
                response = await client.get(path, params=params)
            except httpx.HTTPError as exc:
                last = f"{type(exc).__name__}: {self._scrub(exc, [token])}"
                if attempt == _MAX_HTTP_ATTEMPTS:
                    break
                await asyncio.sleep(_backoff(attempt))
                continue

            status = response.status_code
            if status == 429 or status >= 500:
                last = f"HTTP {status}"
                if attempt == _MAX_HTTP_ATTEMPTS:
                    break
                await asyncio.sleep(_retry_delay(response, attempt))
                continue
            if status == 404:
                raise GreptileError(
                    f"GitHub returned 404 for {path}; check the repository, the PR number, "
                    "and that the token's installation covers this repository"
                )
            if status in (401, 403):
                raise GreptileUnavailable(
                    f"GitHub rejected the review-gate token for {path} (HTTP {status}); "
                    "the gate cannot confirm an approval"
                )
            if status >= 400:
                raise GreptileError(
                    f"GitHub returned HTTP {status} for {path}: "
                    f"{self._scrub(response.text[:300], [token])}"
                )
            try:
                return response.json()
            except ValueError as exc:
                raise _TransientGitHubError(f"non-JSON body from {path}") from exc

        raise _TransientGitHubError(
            f"GET {path} failed after {_MAX_HTTP_ATTEMPTS} attempts: {last}"
        )

    # -- branch configuration ----------------------------------------------

    async def ensure_config(self, workdir: Path, rules: list[str]) -> None:
        """Materialise ``.greptile/`` in ``workdir`` if it is not already there.

        An ephemeral hotfix branch inherits nothing: without this directory the
        review runs with Greptile's defaults instead of sandman's rules, and the
        gate would be checking the wrong thing. An existing config is preserved
        and only gap-filled, because a target repository's own settings are
        deliberate.
        """
        workdir = Path(workdir)
        if not workdir.is_dir():
            raise GreptileError(f"cannot write Greptile config: {workdir} is not a directory")
        effective = list(rules) if rules else DEFAULT_REVIEW_RULES
        await asyncio.to_thread(self._write_config, workdir, effective)

    def _write_config(self, workdir: Path, rules: list[str]) -> None:
        directory = workdir / ".greptile"
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise GreptileError(f"could not create {directory}: {self._scrub(exc)}") from exc

        config_path = directory / "config.json"
        merged: dict[str, Any] = dict(_DEFAULT_CONFIG)
        existing: dict[str, Any] = {}
        if config_path.is_file():
            try:
                loaded = json.loads(config_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                # Greptile ignores a malformed config and falls back to its
                # defaults, which would run the review without our rules.
                raise GreptileError(
                    f"{config_path} exists but is not valid JSON: {self._scrub(exc)}"
                ) from exc
            if not isinstance(loaded, dict):
                raise GreptileError(f"{config_path} must contain a JSON object")
            existing = loaded
            merged.update(existing)

        if merged != existing:
            _atomic_write(config_path, json.dumps(merged, indent=2) + "\n")

        rules_path = directory / "rules.md"
        if not rules_path.exists():
            _atomic_write(rules_path, render_rules(rules))


# ---------------------------------------------------------------------------
# Payload parsing
# ---------------------------------------------------------------------------


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise GreptileError(f"could not write {path}: {redact(str(exc))}") from exc


def _extract_json(text: str) -> dict[str, Any] | None:
    """Pull the verdict object out of CLI stdout.

    The CLI interleaves progress lines with the ``--json`` payload, so a plain
    ``json.loads`` of the whole stream is not enough.
    """
    stripped = text.strip()
    if not stripped:
        return None

    for candidate in (stripped, *reversed(stripped.splitlines())):
        parsed = _loads_object(candidate.strip())
        if parsed is not None:
            return parsed

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end > start:
        return _loads_object(stripped[start : end + 1])
    return None


def _loads_object(candidate: str) -> dict[str, Any] | None:
    if not candidate or candidate[0] not in "{[":
        return None
    try:
        value = json.loads(candidate)
    except ValueError:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        # A bare array is the comment list; wrap it so downstream sees one shape.
        return {"comments": [item for item in value if isinstance(item, dict)]}
    return None


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _dig_str(payload: Any, *path: str) -> str | None:
    value = payload
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value if isinstance(value, str) and value else None


def _dig_int(payload: Any, *path: str) -> int | None:
    value = payload
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _coerce_score(value: Any) -> int | None:
    """Clamp a reported score into 0-5, or drop it if it is not a number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, min(5, round(float(value))))


_APPROVED_WORDS = frozenset({"approved", "approve", "pass", "passed", "success", "ok"})


def _coerce_approved(payload: dict[str, Any]) -> bool:
    """Approval must be stated. Anything ambiguous is a non-approval."""
    for key in ("approved", "autoApproved", "auto_approved", "isApproved", "approval"):
        value = payload.get(key)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in _APPROVED_WORDS
    state = _first(payload, "state", "status", "verdict", "decision")
    if isinstance(state, str):
        return state.strip().lower() in _APPROVED_WORDS
    return False


def _comments_from_payload(payload: dict[str, Any]) -> list[ReviewComment]:
    raw = _first(payload, "comments", "issues", "findings", "violations")
    if raw is None:
        raw = _first(
            payload.get("review", {}) if isinstance(payload.get("review"), dict) else {},
            "comments",
            "issues",
        )
    if not isinstance(raw, list):
        return []

    out: list[ReviewComment] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        body = _first(item, "body", "message", "comment", "description", "text")
        if not isinstance(body, str) or not body.strip():
            continue
        path = _first(item, "path", "file", "filename", "filePath")
        line = _first(item, "line", "lineNumber", "start_line", "startLine", "line_number")
        severity_token = _first(item, "severity", "level", "type", "kind", "category")
        severity = (
            parse_severity(severity_token)
            if severity_token is not None
            else _severity_from_body(body)
        )
        suggestion = _first(item, "suggested_code", "suggestion", "suggestedCode", "fix", "patch")
        out.append(
            ReviewComment(
                path=str(path) if isinstance(path, str) and path else "<unknown>",
                line=line if isinstance(line, int) and not isinstance(line, bool) else None,
                severity=severity,
                body=redact(body.strip()),
                suggested_code=redact(suggestion) if isinstance(suggestion, str) else None,
            )
        )
    return out


def _result_from_payload(payload: dict[str, Any], *, source: str) -> ReviewResult:
    comments = _comments_from_payload(payload)
    summary = _first(payload, "summary", "message", "title", "body", "overview")
    risk = _first(payload, "risk", "riskLevel", "risk_level", "riskScore", "confidence")
    return ReviewResult(
        approved=_coerce_approved(payload),
        score=_coerce_score(_first(payload, "score", "rating", "quality")),
        comments=comments,
        risk=str(risk) if risk is not None else None,
        summary=redact(str(summary).strip()) if summary else _fallback_summary(comments),
        source=source,
        raw=payload,
    )


def _fallback_summary(comments: Sequence[ReviewComment]) -> str:
    blocking = sum(1 for c in comments if c.severity.blocks)
    return f"Greptile returned {len(comments)} comment(s), {blocking} blocking."


# -- GitHub shapes ----------------------------------------------------------


def _is_greptile_actor(user: Any) -> bool:
    """Match the App's review author, whose login is e.g. ``greptile-apps[bot]``."""
    login = _dig_str(user, "login") or ""
    return "greptile" in login.lower()


def _is_greptile_check(run: dict[str, Any]) -> bool:
    name = str(run.get("name", "")).lower()
    slug = (_dig_str(run, "app", "slug") or "").lower()
    app_name = (_dig_str(run, "app", "name") or "").lower()
    return "greptile" in name or "greptile" in slug or "greptile" in app_name


def _comment_from_pr_comment(item: dict[str, Any]) -> ReviewComment:
    body = str(item.get("body") or "").strip()
    line = item.get("line")
    if not isinstance(line, int) or isinstance(line, bool):
        original = item.get("original_line")
        line = original if isinstance(original, int) and not isinstance(original, bool) else None
    return ReviewComment(
        path=str(item.get("path") or "<unknown>"),
        line=line,
        severity=_severity_from_body(body),
        body=redact(body),
        suggested_code=_extract_suggestion(body),
    )


_SUGGESTION_RE = re.compile(r"```suggestion\s*\n(?P<code>.*?)```", re.DOTALL)


def _extract_suggestion(body: str) -> str | None:
    """GitHub suggested changes arrive as a ```suggestion fenced block."""
    match = _SUGGESTION_RE.search(body)
    return redact(match.group("code").rstrip()) if match else None


_ANNOTATION_LEVELS: dict[str, ReviewSeverity] = {
    "failure": ReviewSeverity.BLOCKING,
    "warning": ReviewSeverity.MAJOR,
    "notice": ReviewSeverity.MINOR,
}


def _comment_from_annotation(row: dict[str, Any]) -> ReviewComment:
    level = str(row.get("annotation_level") or "").lower()
    message = str(row.get("message") or row.get("title") or "").strip()
    line = row.get("start_line")
    return ReviewComment(
        path=str(row.get("path") or "<unknown>"),
        line=line if isinstance(line, int) and not isinstance(line, bool) else None,
        severity=_ANNOTATION_LEVELS.get(level, ReviewSeverity.MAJOR),
        body=redact(message) or "(no message)",
        suggested_code=None,
    )


def _result_from_review(review: dict[str, Any], comments: list[ReviewComment]) -> ReviewResult:
    state = str(review.get("state") or "").upper()
    body = str(review.get("body") or "").strip()
    # COMMENTED and CHANGES_REQUESTED are both non-approvals; only an explicit
    # APPROVED review clears the approval half of the gate.
    approved = state == "APPROVED"
    payload: dict[str, Any] = {
        "state": state,
        "html_url": review.get("html_url"),
        "submitted_at": review.get("submitted_at"),
        "author": _dig_str(review, "user", "login"),
        "body": redact(body),
    }
    return ReviewResult(
        approved=approved,
        score=None,
        comments=comments,
        risk=_risk_from_body(body),
        summary=redact(body) if body else f"Greptile review state: {state or 'UNKNOWN'}",
        source="github_app",
        raw=payload,
    )


def _result_from_check_run(run: dict[str, Any], comments: list[ReviewComment]) -> ReviewResult:
    conclusion = str(run.get("conclusion") or "").lower()
    # Only an outright success counts. neutral/skipped/cancelled mean the
    # reviewer declined to judge, which is not an approval.
    approved = conclusion == "success"
    summary = _dig_str(run, "output", "summary") or _dig_str(run, "output", "title") or ""
    payload: dict[str, Any] = {
        "name": run.get("name"),
        "conclusion": conclusion,
        "status": run.get("status"),
        "html_url": run.get("html_url"),
        "completed_at": run.get("completed_at"),
        "output_summary": redact(summary),
    }
    return ReviewResult(
        approved=approved,
        score=None,
        comments=comments,
        risk=_risk_from_body(summary),
        summary=(
            redact(summary)
            if summary
            else f"Greptile check run concluded {conclusion or 'unknown'}"
        ),
        source="github_app",
        raw=payload,
    )


_RISK_RE = re.compile(r"(?i)\brisk\b[^\w]{0,4}(?P<level>low|medium|moderate|high|critical)\b")


def _risk_from_body(body: str) -> str | None:
    match = _RISK_RE.search(body)
    return match.group("level").lower() if match else None


# -- retry timing -----------------------------------------------------------


def _backoff(attempt: int) -> float:
    """Exponential backoff with full jitter, capped."""
    ceiling = min(_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), _BACKOFF_CAP_SECONDS)
    return random.uniform(0.0, ceiling)


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    """Honour ``Retry-After`` (seconds or HTTP-date), else jittered backoff."""
    header = response.headers.get("retry-after")
    if header:
        raw = header.strip()
        with contextlib.suppress(ValueError):
            return max(0.0, min(float(raw), _RETRY_AFTER_CAP_SECONDS))
        with contextlib.suppress(TypeError, ValueError):
            when = parsedate_to_datetime(raw)
            if when.tzinfo is None:
                when = when.replace(tzinfo=UTC)
            return max(
                0.0, min((when - datetime.now(UTC)).total_seconds(), _RETRY_AFTER_CAP_SECONDS)
            )
    return _backoff(attempt)
