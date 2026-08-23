"""cmem.ai persistent agent memory, mediated entirely by the control plane.

ARCHITECTURAL CONSTRAINT -- memory is ORCHESTRATOR-MEDIATED.
The claude-mem worker listens on ``127.0.0.1``. Modal sandboxes are remote
machines and cannot reach the control plane's loopback interface, so a sandboxed
agent can never talk to memory directly. Sandboxed agents return findings *to*
the control plane, and only the control plane reads and writes memory. A memory
URL or token is never handed to a sandbox, never placed in a variant's env, and
never embedded in a probe payload.

Memory is an *enhancement*, never a hard dependency. Every public method degrades
to an empty result when the worker is absent, unhealthy, or running a build that
does not expose an endpoint. A run must complete identically with the worker
switched off; the only difference is that findings arrive without the historical
context that would have told an operator "this exact failure was fixed last
Tuesday by widening a timeout".

Endpoint shapes were verified against a live worker (v13.15.3) and this module
adapts to what the worker actually accepts rather than assuming one build:

* Writes prefer ``POST /api/memory/save`` (``{text,title,project,metadata}`` ->
  ``{success,id,...}``), which is the only write that returns a durable id
  synchronously. ``POST /api/sessions/observations`` is the documented
  alternative and is used as a fallback; it answers ``{"status":"queued"}`` and
  routes the payload through asynchronous LLM compression, so it yields no id.
* ``POST /api/observations/batch`` is a *read-by-ids* endpoint on this build
  (``{ids:[...]}`` -> a JSON array of records). :meth:`MemoryClient.record_batch`
  probes the batch-write shape once, then falls back to bounded-concurrency
  single writes, and reuses ``batch`` for hydration where it is genuinely useful.
* Search endpoints answer in MCP envelope form -- ``{"content":[{"type":"text",
  "text":"<markdown table>"}]}`` -- which carries ids and titles but not bodies.
  Recall therefore extracts the ids and hydrates full records through the batch
  read. ``POST /api/context/semantic`` reads its query from ``q`` (not
  ``query``) and returns a prose blob, which is parsed back into sections.
* Search rejects an empty request with ``INVALID_SEARCH_REQUEST``; a query or a
  filter is always sent.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import re
import time
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from types import TracebackType
from typing import Any, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, get_settings
from .models import Finding, Variant

logger = logging.getLogger(__name__)

__all__ = [
    "MemoryClient",
    "MemoryScope",
    "MemoryUnavailable",
    "Recollection",
]


class MemoryUnavailable(RuntimeError):
    """The memory worker is absent, unhealthy, or disabled by configuration.

    Public methods never raise this: they degrade to an empty result. It exists
    for callers that deliberately opt into a hard failure (a backfill job, a
    diagnostic command) via :meth:`MemoryClient.require_available`.
    """


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# Applied to every string this module logs or embeds in an exception. The memory
# worker is local and unauthenticated, but findings, reproductions and error
# bodies are attacker-influenced text from a probed application, and a leaked
# token must not survive into a durable memory record or a log line.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9._\-]{16,}"),
    re.compile(r"\bak-[A-Za-z0-9._\-]{16,}"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\b(?:bearer|token|basic)\s+[A-Za-z0-9._\-+/=]{12,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|password|passwd|authorization)\b\s*[=:]\s*\S+"),
    re.compile(r"(?i)://[^/\s:@]+:[^/\s@]+@"),
)

_REDACTED = "[redacted]"


def redact(value: str) -> str:
    """Strip anything token-shaped. Used on every logged or persisted string."""
    out = value
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(_REDACTED, out)
    return out


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r"[^a-z0-9._-]+")
_TAG_LINE_PREFIX = "sandman-tags:"
_TAG_LINE_RE = re.compile(rf"{_TAG_LINE_PREFIX}\s*(?P<tags>[^\n\]]+)")

#: Narrative and evidence caps. The worker stores narratives verbatim and a
#: multi-megabyte probe log would both bloat the store and drown the embedding.
_MAX_NARRATIVE_CHARS = 8_000
_MAX_REPRO_CHARS = 900
_MAX_EVIDENCE_CHARS = 320
_MAX_TITLE_CHARS = 120

#: The worker clamps semantic limit to 1..20; clamping here keeps the request
#: honest instead of silently receiving fewer rows than asked for.
_SEMANTIC_LIMIT_MAX = 20


def _slug(value: str, *, max_len: int = 64) -> str:
    """Lowercase, punctuation-collapsed token safe to use inside a tag."""
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-.")
    return slug[:max_len] or "unknown"


class MemoryScope(BaseModel):
    """Where a recollection belongs, and which lane produced it.

    Scoping is what keeps baseline and hotfix recollections from
    cross-contaminating. A fix recorded against the hotfix lane must never be
    recalled as evidence about baseline behaviour: the two lanes are different
    revisions of the code, and conflating them would let the agent "remember" a
    fix for a bug that only ever existed in the other lane.
    """

    model_config = ConfigDict(frozen=True)

    project: str
    rollout_id: str
    variant: Variant | None = None
    region: str | None = None
    probe_id: str | None = None

    def tags(self) -> list[str]:
        """Stable, ordered scope tags.

        Order is deterministic so that two scopes with the same fields always
        produce a byte-identical tag line, which is what makes tag matching on
        recall reliable.
        """
        tags = [
            "sandman",
            f"sandman:project:{_slug(self.project)}",
            f"sandman:rollout:{_slug(self.rollout_id)}",
        ]
        if self.variant is not None:
            tags.append(f"sandman:variant:{self.variant.value}")
        if self.region:
            tags.append(f"sandman:region:{_slug(self.region)}")
        if self.probe_id:
            tags.append(f"sandman:probe:{_slug(self.probe_id)}")
        return tags

    def with_probe(self, probe_id: str) -> MemoryScope:
        return self.model_copy(update={"probe_id": probe_id})


def _tag_line(tags: Sequence[str]) -> str:
    """Machine-readable tag footer embedded in the narrative body.

    Required, not decorative: the worker stores ``metadata`` in a column that its
    list and search responses do not return, so tags written only to metadata are
    unreadable on recall. The narrative always survives the round trip.
    """
    return f"[{_TAG_LINE_PREFIX} {' '.join(tags)}]"


def _parse_tag_line(text: str) -> list[str]:
    match = _TAG_LINE_RE.search(text)
    if not match:
        return []
    return [tok for tok in match.group("tags").split() if tok.startswith("sandman")]


# ---------------------------------------------------------------------------
# Recollection
# ---------------------------------------------------------------------------


class Recollection(BaseModel):
    """One remembered observation, normalized across every recall endpoint."""

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    text: str
    created_at: datetime
    score: float | None = None
    """Backend relevance when the endpoint supplies one, otherwise a
    rank-derived value in ``(0, 1]`` so callers can always sort consistently."""

    tags: list[str] = Field(default_factory=list)

    @property
    def rollout_id(self) -> str | None:
        return self._tag_value("sandman:rollout:")

    @property
    def probe_id(self) -> str | None:
        return self._tag_value("sandman:probe:")

    def _tag_value(self, prefix: str) -> str | None:
        for tag in self.tags:
            if tag.startswith(prefix):
                return tag[len(prefix) :]
        return None


def _coerce_datetime(value: Any) -> datetime:
    """Best-effort timestamp from the several shapes the worker emits."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, (int, float)):
        # created_at_epoch is milliseconds; plain epoch seconds also appear.
        seconds = float(value) / 1000.0 if value > 1e11 else float(value)
        with contextlib.suppress(OverflowError, OSError, ValueError):
            return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(value, str) and value.strip():
        with contextlib.suppress(ValueError):
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return datetime.now(UTC)


def _first_str(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _record_to_recollection(
    record: dict[str, Any], *, fallback_score: float
) -> Recollection | None:
    """Map a worker observation record onto a :class:`Recollection`."""
    raw_id = record.get("id")
    if raw_id is None:
        return None
    text = _first_str(record, "narrative", "text", "content", "body", "summary") or ""
    title = _first_str(record, "title", "subtitle") or text[:_MAX_TITLE_CHARS] or f"#{raw_id}"

    raw_score = record.get("score", record.get("relevance", record.get("distance")))
    score = float(raw_score) if isinstance(raw_score, (int, float)) else fallback_score

    tags = _parse_tag_line(text)
    if not tags:
        tags = _tags_from_metadata(record.get("metadata"))

    return Recollection(
        id=str(raw_id),
        title=redact(title.strip())[:_MAX_TITLE_CHARS],
        text=redact(text.strip()),
        created_at=_coerce_datetime(record.get("created_at_epoch") or record.get("created_at")),
        score=score,
        tags=tags,
    )


def _tags_from_metadata(metadata: Any) -> list[str]:
    """Metadata arrives as either a dict or a JSON-encoded string column."""
    if isinstance(metadata, str):
        with contextlib.suppress(json.JSONDecodeError, ValueError):
            metadata = json.loads(metadata)
    if not isinstance(metadata, dict):
        return []
    raw = metadata.get("tags")
    if isinstance(raw, list):
        return [str(tag) for tag in raw if isinstance(tag, (str, int))]
    if isinstance(raw, str):
        return [tok for tok in raw.split() if tok]
    return []


# ---------------------------------------------------------------------------
# Response envelope handling
# ---------------------------------------------------------------------------

_MCP_ID_ROW_RE = re.compile(r"^\|\s*#(\d+)\s*\|", re.MULTILINE)
_MCP_ID_ANY_RE = re.compile(r"#(\d+)\b")
_SEMANTIC_SECTION_RE = re.compile(
    r"^###\s+(?P<title>.+?)(?:\s+\((?P<date>[\d-]{8,10})\))?\s*$", re.MULTILINE
)
_RESULT_KEYS: tuple[str, ...] = ("results", "observations", "items", "matches", "data", "hits")


def _mcp_text(payload: Any) -> str | None:
    """Extract the text of an MCP-style ``{"content":[{"type":"text",...}]}``."""
    if not isinstance(payload, dict):
        return None
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    if payload.get("isError"):
        return None
    parts = [
        block["text"]
        for block in content
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ]
    return "\n".join(parts) if parts else None


def _structured_records(payload: Any) -> list[dict[str, Any]] | None:
    """Pull a list of records out of whichever envelope the build uses."""
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return None
    for key in _RESULT_KEYS:
        value = payload.get(key)
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
    return None


def _ids_from_mcp_text(text: str, limit: int) -> list[int]:
    """Ids in the order the search ranked them, de-duplicated."""
    matches = _MCP_ID_ROW_RE.findall(text) or _MCP_ID_ANY_RE.findall(text)
    seen: list[int] = []
    for raw in matches:
        value = int(raw)
        if value not in seen:
            seen.append(value)
        if len(seen) >= limit:
            break
    return seen


def _rank_score(index: int, total: int) -> float:
    """Monotonic decreasing score derived from rank position.

    Used only when the backend returns no numeric relevance; it preserves the
    backend's ordering without inventing a similarity number that looks measured.
    """
    if total <= 0:
        return 0.0
    return round(1.0 - (index / (total + 1)), 4)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

_HEALTH_TTL_SECONDS = 30.0
_MAX_ATTEMPTS = 3
_BACKOFF_BASE_SECONDS = 0.25
_BACKOFF_CAP_SECONDS = 4.0
_RETRY_AFTER_CAP_SECONDS = 10.0
_WRITE_CONCURRENCY = 4


class MemoryClient:
    """Async client for the local claude-mem worker.

    Never constructed inside a sandbox. The base URL is loopback-only and the
    client is owned by the control plane process.
    """

    def __init__(self, settings: Settings, timeout_s: float = 5.0) -> None:
        self._settings = settings
        self._base_url = settings.memory_base_url.rstrip("/")
        self._timeout = httpx.Timeout(timeout_s, connect=min(timeout_s, 2.0))
        self._client: httpx.AsyncClient | None = None
        self._client_lock = asyncio.Lock()

        self._health_lock = asyncio.Lock()
        self._healthy: bool = False
        self._health_checked_at: float = float("-inf")

        # Endpoints this build does not expose; probed once, then skipped.
        self._absent: set[str] = set()
        # None until the batch-write shape has been probed on this worker.
        self._batch_write_supported: bool | None = None
        self._logged: set[str] = set()

    @classmethod
    def from_env(cls, timeout_s: float = 5.0) -> Self:
        return cls(get_settings(), timeout_s=timeout_s)

    # -- lifecycle ---------------------------------------------------------

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        async with self._client_lock:
            if self._client is not None:
                await self._client.aclose()
                self._client = None

    async def _http(self) -> httpx.AsyncClient:
        async with self._client_lock:
            if self._client is None:
                self._client = httpx.AsyncClient(
                    base_url=self._base_url,
                    timeout=self._timeout,
                    headers={"content-type": "application/json"},
                    follow_redirects=False,
                )
            return self._client

    # -- logging -----------------------------------------------------------

    def _log_once(self, key: str, message: str, *args: object) -> None:
        """Degradation is expected and must not spam the run log."""
        if key in self._logged:
            return
        self._logged.add(key)
        logger.debug(message, *args)

    # -- transport ---------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str | int] | None = None,
    ) -> Any | None:
        """One bounded-retry request. Returns decoded JSON, or None on any failure.

        Retries only 429 and 5xx, honouring ``Retry-After``. A 4xx other than 429
        is a contract mismatch (wrong shape, unknown endpoint) and retrying it
        would only burn wall-clock inside a run's budget.
        """
        if path in self._absent:
            return None

        client = await self._http()
        last_reason = "unknown"

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                response = await client.request(method, path, json=json_body, params=params)
            except httpx.HTTPError as exc:
                last_reason = f"{type(exc).__name__}: {redact(str(exc))}"
                if attempt == _MAX_ATTEMPTS:
                    break
                await asyncio.sleep(_backoff(attempt))
                continue

            status = response.status_code

            if status in (404, 405, 501):
                self._absent.add(path)
                self._log_once(f"absent:{path}", "memory: %s not exposed by worker", path)
                return None

            if status == 429 or status >= 500:
                last_reason = f"HTTP {status}"
                if attempt == _MAX_ATTEMPTS:
                    break
                await asyncio.sleep(_retry_delay(response, attempt))
                continue

            if status >= 400:
                self._log_once(
                    f"reject:{path}:{status}",
                    "memory: %s rejected request (HTTP %s): %s",
                    path,
                    status,
                    redact(response.text[:200]),
                )
                return None

            return _decode(response)

        self._log_once(f"fail:{path}", "memory: %s unreachable (%s)", path, last_reason)
        return None

    # -- health ------------------------------------------------------------

    async def available(self) -> bool:
        """Whether the worker is reachable and initialized. Cached for 30s."""
        if not self._settings.sandman_memory_enabled:
            return False

        async with self._health_lock:
            now = time.monotonic()
            if now - self._health_checked_at < _HEALTH_TTL_SECONDS:
                return self._healthy

            payload = await self._request("GET", "/api/health")
            healthy = False
            if isinstance(payload, dict):
                status = payload.get("status")
                healthy = (
                    status in (None, "ok", "healthy") and payload.get("initialized") is not False
                )

            self._healthy = healthy
            self._health_checked_at = time.monotonic()
            if not healthy:
                self._log_once("unhealthy", "memory: worker at %s unhealthy", self._base_url)
            else:
                # A worker that came back may expose endpoints an older one did not.
                self._absent.clear()
                self._batch_write_supported = None
            return healthy

    async def require_available(self) -> None:
        """Hard-fail variant for callers that genuinely cannot proceed."""
        if not await self.available():
            raise MemoryUnavailable(f"claude-mem worker unavailable at {self._base_url}")

    async def version(self) -> str | None:
        payload = await self._request("GET", "/api/version")
        if isinstance(payload, dict):
            value = payload.get("version")
            if isinstance(value, str):
                return value
        return None

    # -- writes ------------------------------------------------------------

    async def record_finding(self, finding: Finding, scope: MemoryScope) -> str | None:
        """Persist one finding as a narrative observation. Returns its id."""
        if not await self.available():
            return None
        text, title = _finding_narrative(finding, scope)
        return await self._write(text=text, title=title, scope=scope.with_probe(finding.probe_id))

    async def record_batch(self, findings: Sequence[Finding], scope: MemoryScope) -> int:
        """Persist many findings. Returns how many were durably written."""
        if not findings or not await self.available():
            return 0

        payloads = [_finding_narrative(f, scope) for f in findings]

        if self._batch_write_supported is not False:
            written = await self._try_batch_write(payloads, findings, scope)
            if written is not None:
                return written

        semaphore = asyncio.Semaphore(_WRITE_CONCURRENCY)

        async def one(index: int) -> str | None:
            text, title = payloads[index]
            async with semaphore:
                return await self._write(
                    text=text, title=title, scope=scope.with_probe(findings[index].probe_id)
                )

        results = await asyncio.gather(*(one(i) for i in range(len(findings))))
        return sum(1 for result in results if result)

    async def _try_batch_write(
        self,
        payloads: Sequence[tuple[str, str]],
        findings: Sequence[Finding],
        scope: MemoryScope,
    ) -> int | None:
        """Probe the batch-write shape once.

        On the verified build ``/api/observations/batch`` is a read-by-ids
        endpoint and rejects this body, which is indistinguishable from a build
        that simply lacks batch writes -- both mean "fall back to single writes".
        Returns None when the shape is unsupported.
        """
        body: dict[str, Any] = {
            "observations": [
                {
                    "text": text,
                    "title": title,
                    "project": scope.project,
                    "metadata": _metadata(scope.with_probe(finding.probe_id)),
                }
                for (text, title), finding in zip(payloads, findings, strict=True)
            ]
        }
        payload = await self._request("POST", "/api/observations/batch", json_body=body)

        records = _structured_records(payload)
        if records is None:
            self._batch_write_supported = False
            self._log_once(
                "batch-write",
                "memory: batch write unsupported on this worker; using single writes",
            )
            return None

        written = sum(1 for record in records if record.get("id") is not None)
        if written == 0:
            self._batch_write_supported = False
            return None

        self._batch_write_supported = True
        return written

    async def record_hotfix(
        self,
        *,
        scope: MemoryScope,
        probe_id: str,
        root_cause: str,
        fix_summary: str,
        diff_digest: str,
        pr_url: str | None,
        verified: bool,
    ) -> str | None:
        """Persist how a failure was fixed.

        This is the payoff for the whole module: a later run that hits an
        equivalent failure recalls the root cause and the shape of the fix
        instead of rediscovering both.

        ``diff_digest`` is a digest, never the patch text -- a diff can carry a
        rotated credential or customer data out of the repository and into a
        durable store that outlives the run.

        ``verified`` is recorded verbatim and prominently. An unverified fix must
        never be recalled as a proven remedy; a later run that reapplies a patch
        which never passed its re-probe is worse than having no memory at all.
        """
        if not await self.available():
            return None

        hotfix_scope = scope.with_probe(probe_id)
        status = "VERIFIED" if verified else "UNVERIFIED"
        lines = [
            f"[sandman] {status} hotfix for probe {probe_id} "
            f"(rollout {hotfix_scope.rollout_id}, project {hotfix_scope.project}).",
            "",
            f"Root cause: {_trim(root_cause, _MAX_REPRO_CHARS)}",
            f"Fix: {_trim(fix_summary, _MAX_REPRO_CHARS)}",
            f"Diff digest: {_trim(diff_digest, 200)}",
        ]
        if pr_url:
            lines.append(f"PR: {_trim(pr_url, 300)}")
        if not verified:
            lines.append(
                "NOT VERIFIED: this patch did not complete a passing re-probe. "
                "Treat as a lead, not as a proven remedy."
            )

        tags = [*hotfix_scope.tags(), "sandman:kind:hotfix"]
        tags.append("sandman:verified:true" if verified else "sandman:verified:false")
        lines.extend(["", _tag_line(tags)])

        title = f"Hotfix {probe_id} ({status.lower()}): {_trim(fix_summary, 60)}"
        return await self._write(
            text="\n".join(lines), title=title, scope=hotfix_scope, extra_tags=tags
        )

    async def _write(
        self,
        *,
        text: str,
        title: str,
        scope: MemoryScope,
        extra_tags: Sequence[str] | None = None,
    ) -> str | None:
        """Write one observation, preferring the endpoint that returns an id."""
        tags = list(extra_tags) if extra_tags else scope.tags()
        body: dict[str, Any] = {
            "text": _trim(redact(text), _MAX_NARRATIVE_CHARS),
            "title": _trim(redact(title), _MAX_TITLE_CHARS),
            "project": scope.project,
            "metadata": _metadata(scope, tags),
        }

        payload = await self._request("POST", "/api/memory/save", json_body=body)
        if isinstance(payload, dict) and payload.get("id") is not None:
            return str(payload["id"])

        return await self._write_via_session(body, scope)

    async def _write_via_session(self, body: dict[str, Any], scope: MemoryScope) -> str | None:
        """Fallback write through the session-observation ingest.

        This path is asynchronous on the worker (it answers ``{"status":
        "queued"}`` and compresses the payload with an LLM afterwards), so there
        is no observation id to return. The session handle is returned instead so
        a caller still has something to correlate against.
        """
        session_id = f"sandman-{_slug(scope.project)}-{_slug(scope.rollout_id)}"
        payload = await self._request(
            "POST",
            "/api/sessions/observations",
            json_body={
                "contentSessionId": session_id,
                "tool_name": "SandmanObservation",
                "tool_input": {"title": body["title"], "project": body["project"]},
                "tool_response": {"narrative": body["text"], "metadata": body["metadata"]},
                "project": body["project"],
            },
        )
        if not isinstance(payload, dict):
            return None
        raw_id = payload.get("id") or payload.get("observationId")
        if raw_id is not None:
            return str(raw_id)
        if payload.get("status") in ("queued", "ok", "accepted"):
            return session_id
        return None

    # -- recall ------------------------------------------------------------

    async def recall_prior_fixes(
        self,
        *,
        probe_id: str,
        error_class: str | None,
        project: str,
        limit: int = 5,
    ) -> list[Recollection]:
        """Recall how an equivalent failure was fixed in earlier runs.

        Results are ranked by the backend, then re-ranked locally so that
        verified fixes for this exact probe outrank loose textual matches.
        """
        if limit <= 0 or not await self.available():
            return []

        terms = ["sandman", "hotfix", probe_id]
        if error_class:
            terms.append(error_class)
        query = " ".join(dict.fromkeys(terms))

        found = await self._search("/api/search", query=query, project=project, limit=limit * 3)
        if not found:
            found = await self._recent_for_project(project, limit=limit * 6)

        probe_tag = f"sandman:probe:{_slug(probe_id)}"
        candidates = [
            item
            for item in found
            if "sandman:kind:hotfix" in item.tags or "hotfix" in item.title.lower()
        ]
        if not candidates:
            candidates = found

        def rank(item: Recollection) -> tuple[int, int, float, float]:
            return (
                0 if probe_tag in item.tags or probe_id in item.text else 1,
                0 if "sandman:verified:true" in item.tags else 1,
                -(item.score or 0.0),
                -item.created_at.timestamp(),
            )

        return sorted(candidates, key=rank)[:limit]

    async def recall_persistent_failures(
        self, *, project: str, probe_id: str, limit: int = 10
    ) -> list[Recollection]:
        """Recall earlier runs that already surfaced this failure.

        Feeds :attr:`Finding.previously_ignored`: a PRE_EXISTING failure that
        several past runs also reported is a failure the team has decided to live
        with, and presenting it as news buries the finding that is actually new.
        """
        if limit <= 0 or not await self.available():
            return []

        query = f"sandman {probe_id} pre_existing still_broken failure"
        found = await self._search(
            "/api/search/observations", query=query, project=project, limit=limit * 3
        )
        if not found:
            found = await self._search("/api/search", query=query, project=project, limit=limit * 3)
        if not found:
            found = await self._recent_for_project(project, limit=limit * 6)

        probe_tag = f"sandman:probe:{_slug(probe_id)}"
        matches = [item for item in found if probe_tag in item.tags or probe_id in item.text]
        matches.sort(key=lambda item: item.created_at, reverse=True)
        return matches[:limit]

    async def semantic_context(
        self, query: str, *, project: str, limit: int = 8
    ) -> list[Recollection]:
        """Free-text semantic recall, used to brief the hotfix agent."""
        if not query.strip() or limit <= 0 or not await self.available():
            return []

        capped = min(limit, _SEMANTIC_LIMIT_MAX)
        payload = await self._request(
            "POST",
            "/api/context/semantic",
            # The worker reads `q`; `query` is sent alongside for builds that
            # renamed it. Sending both is cheaper than version-sniffing.
            json_body={"q": query, "query": query, "project": project, "limit": capped},
        )
        if payload is None:
            return []

        records = _structured_records(payload)
        if records:
            return _to_recollections(records)[:capped]

        if isinstance(payload, dict):
            context = payload.get("context")
            if isinstance(context, str) and context.strip():
                return _parse_semantic_context(context)[:capped]

        return []

    # -- recall plumbing ---------------------------------------------------

    async def _search(
        self, path: str, *, query: str, project: str | None, limit: int
    ) -> list[Recollection]:
        """POST-first search with a GET fallback, normalized to records.

        A query is always sent: the worker rejects a filterless, queryless search
        with ``INVALID_SEARCH_REQUEST``.
        """
        body: dict[str, Any] = {"query": query, "q": query, "limit": limit}
        if project:
            body["project"] = project

        payload = await self._request("POST", path, json_body=body)
        if payload is None:
            params: dict[str, str | int] = {"query": query, "q": query, "limit": limit}
            if project:
                params["project"] = project
            payload = await self._request("GET", path, params=params)
        if payload is None:
            return []

        records = _structured_records(payload)
        if records:
            return _to_recollections(records)

        text = _mcp_text(payload)
        if text:
            ids = _ids_from_mcp_text(text, limit)
            if ids:
                return await self._hydrate(ids)
        return []

    async def _hydrate(self, ids: Sequence[int]) -> list[Recollection]:
        """Turn ranked ids into full records.

        Search answers with a markdown table carrying ids and titles but no
        bodies; the batch read is what makes those hits usable.
        """
        payload = await self._request(
            "POST", "/api/observations/batch", json_body={"ids": list(ids)}
        )
        records = _structured_records(payload)
        if not records:
            return []

        by_id = {str(record.get("id")): record for record in records}
        ordered = [by_id[str(i)] for i in ids if str(i) in by_id]
        return _to_recollections(ordered)

    async def _recent_for_project(self, project: str, *, limit: int) -> list[Recollection]:
        """Last-resort recall for builds whose search endpoints are absent.

        The listing endpoint is plain SQL paging, so it always works when the
        worker is up at all; relevance is then decided by the caller's filters.
        """
        params: dict[str, str | int] = {"limit": max(1, min(limit, 200))}
        if project:
            params["project"] = project
        payload = await self._request("GET", "/api/observations", params=params)
        records = _structured_records(payload)
        return _to_recollections(records) if records else []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decode(response: httpx.Response) -> Any | None:
    """Decode a body, tolerating the empty and HTML replies this worker emits."""
    if not response.content or not response.content.strip():
        return None
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type.lower() and response.text.lstrip().startswith("<"):
        return None
    try:
        return response.json()
    except ValueError:
        return None


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
            delta = (when - datetime.now(UTC)).total_seconds()
            return max(0.0, min(delta, _RETRY_AFTER_CAP_SECONDS))
    return _backoff(attempt)


def _trim(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _metadata(scope: MemoryScope, tags: Sequence[str] | None = None) -> dict[str, Any]:
    """Structured sidecar. Duplicated into the narrative tag line, which is the
    only copy guaranteed to survive a read on every worker build."""
    payload: dict[str, Any] = {
        "source": "sandman",
        "project": scope.project,
        "rollout_id": scope.rollout_id,
        "tags": list(tags) if tags is not None else scope.tags(),
    }
    if scope.variant is not None:
        payload["variant"] = scope.variant.value
    if scope.region:
        payload["region"] = scope.region
    if scope.probe_id:
        payload["probe_id"] = scope.probe_id
    return payload


def _finding_narrative(finding: Finding, scope: MemoryScope) -> tuple[str, str]:
    """Render a finding as (narrative, title).

    The narrative leads with classification and probe id because those are what a
    later run matches on, and carries a short reproduction so a recollection is
    actionable without re-reading the original run.
    """
    probe_scope = scope.with_probe(finding.probe_id)
    tags = [
        *probe_scope.tags(),
        "sandman:kind:finding",
        f"sandman:classification:{finding.classification.value}",
        f"sandman:severity:{finding.severity.value}",
    ]
    if finding.previously_ignored:
        tags.append("sandman:previously-ignored:true")

    lines = [
        f"[sandman] {finding.classification.value} on probe {finding.probe_id} "
        f"(severity {finding.severity.value}, run {finding.run_id}).",
        "",
        _trim(finding.title, _MAX_TITLE_CHARS),
        "",
        _trim(finding.description, 2_000),
    ]

    if finding.reproduction:
        lines += ["", f"Reproduction: {_trim(finding.reproduction, _MAX_REPRO_CHARS)}"]

    evidence = _render_evidence(finding.variant_evidence)
    if evidence:
        lines += ["", "Evidence:", *evidence]

    if finding.first_seen_run_id:
        lines += ["", f"First seen in run {finding.first_seen_run_id}."]

    lines += ["", _tag_line(tags)]

    title = f"{finding.classification.value}/{finding.probe_id}: {_trim(finding.title, 60)}"
    return "\n".join(lines), title


def _render_evidence(evidence: dict[Variant, str]) -> list[str]:
    from .models import VARIANT_ORDER

    return [
        f"  {variant.glyph} {variant.value}: {_trim(evidence[variant], _MAX_EVIDENCE_CHARS)}"
        for variant in VARIANT_ORDER
        if evidence.get(variant)
    ]


def _to_recollections(records: Iterable[dict[str, Any]]) -> list[Recollection]:
    rows = list(records)
    out: list[Recollection] = []
    for index, record in enumerate(rows):
        item = _record_to_recollection(record, fallback_score=_rank_score(index, len(rows)))
        if item is not None:
            out.append(item)
    return out


def _parse_semantic_context(context: str) -> list[Recollection]:
    """Split the semantic endpoint's prose blob into per-observation sections.

    The endpoint returns rendered markdown (``### <title> (<date>)`` followed by
    the narrative) rather than records, so the sections are recovered by header.
    Ids are not present in this format; a stable synthetic id keyed to the header
    position is used so callers can de-duplicate within one response.
    """
    matches = list(_SEMANTIC_SECTION_RE.finditer(context))
    if not matches:
        body = context.strip()
        if not body:
            return []
        return [
            Recollection(
                id="semantic:0",
                title=_trim(body.splitlines()[0], _MAX_TITLE_CHARS),
                text=redact(body),
                created_at=datetime.now(UTC),
                score=1.0,
                tags=_parse_tag_line(body),
            )
        ]

    out: list[Recollection] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(context)
        body = context[start:end].strip()
        if not body:
            continue
        out.append(
            Recollection(
                id=f"semantic:{index}",
                title=_trim(match.group("title"), _MAX_TITLE_CHARS),
                text=redact(body),
                created_at=_coerce_datetime(match.group("date")),
                score=_rank_score(index, len(matches)),
                tags=_parse_tag_line(body),
            )
        )
    return out
