"""cmem.ai persistent agent memory, read and written only by the control plane.

ARCHITECTURAL CONSTRAINT -- memory is ORCHESTRATOR-MEDIATED.
The claude-mem worker listens on ``127.0.0.1``. Modal sandboxes are remote
machines and cannot reach the control plane's loopback interface, so a sandboxed
agent can never talk to memory directly, and giving one a memory URL or token
would be both useless and a credential leak. Sandboxed agents return findings
*to* the control plane; only the control plane reads and writes memory. Nothing
in this module is ever placed in a variant's env, a probe payload, or a patch
workspace.

Memory is an enhancement, never a hard dependency. Every public method degrades
to an empty result when the worker is absent, unhealthy, disabled by settings,
or running a build that does not expose an endpoint. A run must complete
identically with the worker switched off; the only thing lost is the historical
context that tells an operator "this exact failure was fixed last Tuesday by
widening a timeout".

Endpoint shapes were verified against a live worker (13.15.3), and this module
adapts to what a worker actually accepts rather than assuming one build:

* ``POST /api/memory/save`` (``{text,title,project,metadata}`` ->
  ``{success,id,...}``) is the only write that returns a durable id
  synchronously, so it is preferred. ``POST /api/sessions/observations`` is the
  documented alternative and is used as a fallback; it requires
  ``contentSessionId`` + ``tool_name``, answers ``{"status":"queued"}`` and
  routes the payload through asynchronous compression, so it yields no id.
* ``POST /api/observations/batch`` is a *read-by-ids* endpoint on this build
  (``{ids:[...]}`` -> a JSON array of full records). The batch *write* shape is
  probed once per client; when it is rejected, writes fall back to
  bounded-concurrency single saves, and the batch read is reused to hydrate
  recall results.
* Search (``/api/search``, ``/api/search/observations``, ``/api/timeline``) is
  POST on some builds and GET on this one; each call tries POST and falls back
  to GET on 404/405. Responses come back in MCP envelope form --
  ``{"content":[{"type":"text","text":"<markdown table>"}]}`` -- which carries
  ids but not bodies, so ids are extracted and hydrated through the batch read.
* An empty search request is rejected with ``INVALID_SEARCH_REQUEST``; a query
  or a filter is therefore always sent.
* Worker metadata is stored but not full-text indexed, so scope tags are also
  written as a trailing line of the narrative, which *is* indexed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from types import TracebackType
from typing import Any, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, get_settings
from .models import Finding, Variant

logger = logging.getLogger(__name__)

#: Health verdicts are cached this long. Long enough that a burst of recalls
#: costs one probe, short enough that a worker started mid-run is picked up.
_HEALTH_TTL_S = 30.0

_MAX_NARRATIVE_CHARS = 4000
_MAX_TITLE_CHARS = 120
_MAX_REPRO_CHARS = 800
_WRITE_CONCURRENCY = 4

_TAG_LINE_PREFIX = "sandman-tags:"


class MemoryUnavailable(RuntimeError):
    """Raised only by :meth:`MemoryClient.require_available`.

    The ordinary read/write methods never raise this: memory is an enhancement
    and a missing worker must not fail a run. Callers that genuinely cannot
    proceed without memory ask for it explicitly.
    """

    def __init__(self, base_url: str, reason: str = "worker did not answer /api/health") -> None:
        super().__init__(f"memory worker at {base_url} is unavailable: {reason}")
        self.base_url = base_url
        self.reason = reason


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# Anything matching these is replaced before it can reach a narrative, a log
# line, or an exception message. Memory records are long-lived and are re-read
# by later runs, so a credential written once leaks forever.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgh[opsu]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bxox[abpsr]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"),
    re.compile(r"(?i)\b(?:bearer|token|api[_-]?key|secret|password)\b\s*[:=]?\s*[^\s,;\"']{8,}"),
    re.compile(r"(?i)://[^/\s:@]+:[^/\s@]+@"),
)

_REDACTED = "[redacted]"


def redact(value: str) -> str:
    """Mask anything that looks like a credential."""
    out = value
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(_REDACTED, out)
    return out


def _redact_exc(exc: BaseException) -> str:
    return redact(f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r"[^a-z0-9._-]+")


def _slug(value: str, *, max_len: int = 64) -> str:
    return _SLUG_RE.sub("-", value.strip().lower()).strip("-")[:max_len] or "unknown"


class MemoryScope(BaseModel):
    """Where a recollection belongs.

    Scoping is what keeps a baseline lane's recollections from contaminating a
    hotfix lane's: the two variants deliberately run *different* code, so a fix
    recalled from the wrong variant is worse than no recollection at all.
    """

    model_config = ConfigDict(frozen=True)

    project: str
    rollout_id: str
    variant: Variant | None = None
    region: str | None = None
    probe_id: str | None = None

    def tags(self) -> list[str]:
        """Stable scope tags, coarsest first.

        Order is fixed rather than sorted so that a stored tag line renders the
        same way for every record and stays diff-friendly across runs.
        """
        tags = [
            "sandman",
            f"sandman:project:{_slug(self.project)}",
            f"sandman:rollout:{_slug(self.rollout_id)}",
        ]
        if self.variant is not None:
            tags.append(f"sandman:variant:{self.variant.value}")
        if self.region:
            tags.append(f"sandman:region:{_slug(self.region, max_len=32)}")
        if self.probe_id:
            tags.append(f"sandman:probe:{_slug(self.probe_id)}")
        return tags

    def with_probe(self, probe_id: str) -> MemoryScope:
        return self.model_copy(update={"probe_id": probe_id})

    def with_variant(self, variant: Variant) -> MemoryScope:
        return self.model_copy(update={"variant": variant})


def _tag_line(tags: Sequence[str]) -> str:
    return f"{_TAG_LINE_PREFIX} {' '.join(tags)}"


def _parse_tag_line(text: str) -> list[str]:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(_TAG_LINE_PREFIX):
            return [tag for tag in stripped[len(_TAG_LINE_PREFIX) :].split() if tag]
    return []


# ---------------------------------------------------------------------------
# Recollection
# ---------------------------------------------------------------------------


class Recollection(BaseModel):
    """One remembered record, normalised across the worker's response shapes."""

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    text: str
    created_at: datetime
    score: float | None = None
    tags: list[str] = Field(default_factory=list)

    @property
    def rollout_id(self) -> str | None:
        return self._tag_value("sandman:rollout:")

    @property
    def probe_id(self) -> str | None:
        return self._tag_value("sandman:probe:")

    @property
    def kind(self) -> str | None:
        """``finding`` or ``hotfix`` when the record carries a kind tag."""
        return self._tag_value("sandman:kind:")

    @property
    def verified(self) -> bool:
        return "sandman:verified:true" in self.tags

    def _tag_value(self, prefix: str) -> str | None:
        for tag in self.tags:
            if tag.startswith(prefix):
                return tag[len(prefix) :]
        return None


# ---------------------------------------------------------------------------
# Response plumbing
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Reply:
    """A completed HTTP exchange. ``payload`` is ``None`` for non-JSON bodies."""

    status: int
    payload: Any

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def missing_route(self) -> bool:
        return self.status in (404, 405, 501)


def _decode(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def _backoff(attempt: int) -> float:
    return min(4.0, 0.25 * 2.0 ** (attempt - 1)) + random.uniform(0.0, 0.15)


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    """Honour ``Retry-After`` in either of its two legal encodings."""
    header = response.headers.get("retry-after")
    if header:
        try:
            return max(0.0, min(30.0, float(header)))
        except ValueError:
            pass
        try:
            when = parsedate_to_datetime(header)
        except (TypeError, ValueError):
            when = None
        if when is not None:
            if when.tzinfo is None:
                when = when.replace(tzinfo=UTC)
            return max(0.0, min(30.0, (when - datetime.now(UTC)).total_seconds()))
    return _backoff(attempt)


def _trim(value: str, limit: int) -> str:
    value = value.strip()
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _coerce_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, (int, float)):
        # The worker stores epoch milliseconds; anything smaller is seconds.
        seconds = float(value) / 1000.0 if value > 1e11 else float(value)
        return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(UTC)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return datetime.now(UTC)


def _first_str(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _tags_from_metadata(metadata: Any) -> list[str]:
    """Metadata comes back as a JSON *string* from SQLite-backed builds."""
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except ValueError:
            return []
    if isinstance(metadata, dict):
        raw = metadata.get("tags")
        if isinstance(raw, list):
            return [str(tag) for tag in raw]
        if isinstance(raw, str):
            return [tag for tag in raw.split() if tag]
    return []


def _record_to_recollection(record: dict[str, Any], score: float | None) -> Recollection | None:
    raw_id = record.get("id")
    if raw_id is None:
        return None
    text = _first_str(record, "narrative", "text", "content", "summary", "subtitle") or ""
    tags = _tags_from_metadata(record.get("metadata")) or _parse_tag_line(text)
    created = record.get("created_at") or record.get("created_at_epoch") or record.get("createdAt")
    return Recollection(
        id=str(raw_id),
        title=_first_str(record, "title", "subtitle") or f"observation #{raw_id}",
        text=text,
        created_at=_coerce_datetime(created),
        score=score,
        tags=tags,
    )


_MCP_ID_RE = re.compile(r"\|\s*#(\d+)\s*\|")
_LOOSE_ID_RE = re.compile(r"#(\d+)")
_SEMANTIC_SECTION_RE = re.compile(r"^###\s+(?P<title>.*?)(?:\s+\((?P<date>[^)]+)\))?$")


def _mcp_text(payload: Any) -> str | None:
    """Pull the markdown blob out of an MCP ``{"content":[...]}`` envelope."""
    if not isinstance(payload, dict):
        return None
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    chunks = [
        part["text"]
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    return "\n".join(chunks) if chunks else None


def _structured_records(payload: Any) -> list[dict[str, Any]] | None:
    """Some builds answer search with real records instead of an MCP envelope."""
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("items", "results", "observations", "records", "matches"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return None


def _ids_from_text(text: str, limit: int) -> list[int]:
    found = _MCP_ID_RE.findall(text) or _LOOSE_ID_RE.findall(text)
    ordered: list[int] = []
    for raw in found:
        value = int(raw)
        if value not in ordered:
            ordered.append(value)
        if len(ordered) >= limit:
            break
    return ordered


def _rank_score(index: int, total: int) -> float:
    """Positional relevance.

    The worker returns matches in relevance order but does not expose a numeric
    score, so rank is turned into one monotonically. Scores are comparable
    within a single call only.
    """
    if total <= 1:
        return 1.0
    return round(1.0 - (index / total) * 0.6, 4)


def _parse_semantic_context(context: str) -> list[Recollection]:
    """``/api/context/semantic`` answers with prose, not records."""
    sections: list[tuple[str, str | None, list[str]]] = []
    title: str | None = None
    date: str | None = None
    body: list[str] = []
    for line in context.splitlines():
        match = _SEMANTIC_SECTION_RE.match(line.strip())
        if match:
            if title is not None:
                sections.append((title, date, body))
            title = match.group("title").strip()
            date = match.group("date")
            body = []
        elif title is not None:
            body.append(line)
    if title is not None:
        sections.append((title, date, body))

    total = len(sections)
    out: list[Recollection] = []
    for index, (sect_title, sect_date, sect_body) in enumerate(sections):
        text = "\n".join(sect_body).strip()
        out.append(
            Recollection(
                id=f"semantic:{index}",
                title=sect_title,
                text=text,
                created_at=_coerce_datetime(sect_date) if sect_date else datetime.now(UTC),
                score=_rank_score(index, total),
                tags=_parse_tag_line(text),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Narratives
# ---------------------------------------------------------------------------


def _render_evidence(evidence: dict[Variant, str]) -> list[str]:
    return [
        f"  {variant.glyph} {variant.value}: {_trim(redact(evidence[variant]), 240)}"
        for variant in sorted(evidence, key=lambda v: v.order)
    ]


def _finding_narrative(finding: Finding, scope: MemoryScope) -> tuple[str, str]:
    tags = [
        *scope.with_probe(finding.probe_id).tags(),
        "sandman:kind:finding",
        f"sandman:classification:{finding.classification.value}",
        f"sandman:severity:{finding.severity.value}",
    ]
    lines = [
        f"sandman finding in run {finding.run_id}",
        f"probe: {finding.probe_id}",
        f"classification: {finding.classification.value} (severity {finding.severity.value})",
        f"rollout: {scope.rollout_id}",
        "",
        _trim(redact(finding.description), 1200),
    ]
    if finding.variant_evidence:
        lines += ["", "variant evidence:", *_render_evidence(finding.variant_evidence)]
    if finding.reproduction:
        lines += ["", "reproduction:", _trim(redact(finding.reproduction), _MAX_REPRO_CHARS)]
    lines += ["", _tag_line(tags)]

    title = _trim(redact(f"[{finding.classification.value}] {finding.title}"), _MAX_TITLE_CHARS)
    return title, _trim("\n".join(lines), _MAX_NARRATIVE_CHARS)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class MemoryClient:
    """Async client for the local claude-mem worker.

    Every method is safe to call when the worker is missing: transport errors
    are swallowed, logged once at debug, and reported as an empty result.
    """

    def __init__(self, settings: Settings, timeout_s: float = 5.0) -> None:
        self._settings = settings
        self._base_url: str = str(settings.memory_base_url).rstrip("/")
        self._enabled = settings.sandman_memory_enabled
        self._timeout = httpx.Timeout(timeout_s, connect=min(2.0, timeout_s))
        self._client: httpx.AsyncClient | None = None
        self._client_lock = asyncio.Lock()
        self._health_lock = asyncio.Lock()
        self._healthy: bool | None = None
        self._health_checked_at = 0.0
        self._batch_write_ok: bool | None = None
        self._logged: set[str] = set()

    @classmethod
    def from_env(cls, timeout_s: float = 5.0) -> Self:
        return cls(get_settings(), timeout_s=timeout_s)

    @property
    def base_url(self) -> str:
        return self._base_url

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

    # -- transport ---------------------------------------------------------

    async def _http(self) -> httpx.AsyncClient:
        async with self._client_lock:
            if self._client is None:
                self._client = httpx.AsyncClient(
                    base_url=self._base_url,
                    timeout=self._timeout,
                    limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
                    headers={"user-agent": "sandman-control-plane", "accept": "application/json"},
                    follow_redirects=False,
                )
            return self._client

    def _log_once(self, key: str, message: str, *args: object) -> None:
        """Debug-log a degradation once per client.

        A worker that is down is down for the whole run; logging every call
        would bury the run's real output in identical lines.
        """
        if key in self._logged:
            return
        self._logged.add(key)
        logger.debug(message, *args)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str | int] | None = None,
        attempts: int = 3,
    ) -> _Reply | None:
        """One bounded-retry exchange. ``None`` means the transport gave up."""
        client = await self._http()
        for attempt in range(1, attempts + 1):
            try:
                response = await client.request(method, path, json=json_body, params=params)
            except httpx.HTTPError as exc:
                if attempt == attempts:
                    self._log_once(
                        f"transport:{path}",
                        "memory %s %s unreachable: %s",
                        method,
                        path,
                        _redact_exc(exc),
                    )
                    return None
                await asyncio.sleep(_backoff(attempt))
                continue

            if response.status_code == 429 or 500 <= response.status_code < 600:
                if attempt == attempts:
                    self._log_once(
                        f"status:{path}",
                        "memory %s %s returned %s after %d attempts",
                        method,
                        path,
                        response.status_code,
                        attempts,
                    )
                    return _Reply(response.status_code, _decode(response))
                await asyncio.sleep(_retry_delay(response, attempt))
                continue

            return _Reply(response.status_code, _decode(response))
        return None

    async def _post_or_get(
        self,
        path: str,
        *,
        body: dict[str, Any],
        params: dict[str, str | int],
    ) -> _Reply | None:
        """Try the documented POST shape, fall back to the GET shape.

        Search moved between verbs across worker builds; probing rather than
        pinning one keeps recall working on both.
        """
        reply = await self._request("POST", path, json_body=body)
        if reply is not None and reply.missing_route:
            reply = await self._request("GET", path, params=params)
        return reply

    # -- health ------------------------------------------------------------

    async def available(self) -> bool:
        """Whether the worker is reachable. Cached for 30 seconds."""
        if not self._enabled:
            return False
        now = time.monotonic()
        async with self._health_lock:
            if self._healthy is not None and now - self._health_checked_at < _HEALTH_TTL_S:
                return self._healthy
            reply = await self._request("GET", "/api/health", attempts=2)
            healthy = reply is not None and reply.ok
            if reply is not None and healthy and isinstance(reply.payload, dict):
                status = reply.payload.get("status")
                healthy = status is None or str(status).lower() in {"ok", "healthy", "ready"}
            if not healthy:
                self._log_once("health", "memory worker at %s is unavailable", self._base_url)
            self._healthy = healthy
            self._health_checked_at = now
            return healthy

    async def require_available(self) -> None:
        """Assert availability. Only for callers that cannot degrade."""
        if not self._enabled:
            raise MemoryUnavailable(self._base_url, "disabled by SANDMAN_MEMORY_ENABLED=false")
        if not await self.available():
            raise MemoryUnavailable(self._base_url)

    async def version(self) -> str | None:
        if not await self.available():
            return None
        reply = await self._request("GET", "/api/version", attempts=2)
        if reply is None or not reply.ok or not isinstance(reply.payload, dict):
            return None
        version = reply.payload.get("version")
        return str(version) if version is not None else None

    # -- writes ------------------------------------------------------------

    async def record_finding(self, finding: Finding, scope: MemoryScope) -> str | None:
        """Persist one finding. Returns the record id when the build exposes one."""
        if not await self.available():
            return None
        title, narrative = _finding_narrative(finding, scope)
        tags = _parse_tag_line(narrative)
        _, record_id = await self._write(
            title=title, text=narrative, project=scope.project, scope=scope, tags=tags
        )
        return record_id

    async def record_batch(self, findings: Sequence[Finding], scope: MemoryScope) -> int:
        """Persist many findings. Returns how many were accepted."""
        if not findings or not await self.available():
            return 0

        payloads = [_finding_narrative(finding, scope) for finding in findings]
        if self._batch_write_ok is not False:
            written = await self._try_batch_write(payloads, scope)
            if written is not None:
                return written

        semaphore = asyncio.Semaphore(_WRITE_CONCURRENCY)

        async def one(title: str, text: str) -> bool:
            async with semaphore:
                ok, _ = await self._write(
                    title=title,
                    text=text,
                    project=scope.project,
                    scope=scope,
                    tags=_parse_tag_line(text),
                )
                return ok

        results = await asyncio.gather(*(one(title, text) for title, text in payloads))
        return sum(1 for ok in results if ok)

    async def _try_batch_write(
        self, payloads: Sequence[tuple[str, str]], scope: MemoryScope
    ) -> int | None:
        """Probe the batch-write shape once. ``None`` means it is unsupported.

        On builds where ``/api/observations/batch`` is a read-by-ids endpoint
        this returns None on the first call and is never retried.
        """
        body = {
            "project": scope.project,
            "observations": [
                {
                    "title": title,
                    "text": text,
                    "narrative": text,
                    "project": scope.project,
                    "metadata": _metadata(scope, _parse_tag_line(text)),
                }
                for title, text in payloads
            ],
        }
        reply = await self._request("POST", "/api/observations/batch", json_body=body)
        if reply is None or not reply.ok:
            self._batch_write_ok = False
            self._log_once(
                "batch-write",
                "memory batch write unsupported (status %s); using single writes",
                reply.status if reply else "unreachable",
            )
            return None
        # A read-by-ids build answers 200 with a (here empty) array of records;
        # that is not an acknowledgement of a write.
        if isinstance(reply.payload, list) and len(reply.payload) != len(payloads):
            self._batch_write_ok = False
            return None
        self._batch_write_ok = True
        return len(payloads)

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

        This is the record a later run recalls when it hits an equivalent
        failure. ``verified`` is written as a tag and stated in the narrative:
        an unverified fix must never be recalled as if it had passed a lane.
        """
        if not await self.available():
            return None

        probe_scope = scope.with_probe(probe_id)
        tags = [
            *probe_scope.tags(),
            "sandman:kind:hotfix",
            f"sandman:verified:{'true' if verified else 'false'}",
        ]
        lines = [
            f"sandman hotfix for probe {probe_id} in rollout {scope.rollout_id}",
            f"verified: {'yes -- reprobed and passed' if verified else 'no -- NOT confirmed'}",
            "",
            "root cause:",
            _trim(redact(root_cause), 1200),
            "",
            "fix:",
            _trim(redact(fix_summary), 1200),
            "",
            f"diff digest: {_trim(redact(diff_digest), 200)}",
        ]
        if pr_url:
            lines.append(f"pull request: {_trim(redact(pr_url), 300)}")
        lines += ["", _tag_line(tags)]

        state = "verified" if verified else "unverified"
        title = _trim(redact(f"hotfix ({state}): {probe_id} — {fix_summary}"), _MAX_TITLE_CHARS)
        _, record_id = await self._write(
            title=title,
            text=_trim("\n".join(lines), _MAX_NARRATIVE_CHARS),
            project=scope.project,
            scope=probe_scope,
            tags=tags,
        )
        return record_id

    async def _write(
        self,
        *,
        title: str,
        text: str,
        project: str,
        scope: MemoryScope,
        tags: Sequence[str],
    ) -> tuple[bool, str | None]:
        """Save one record. Returns (accepted, id-if-the-build-returns-one)."""
        body: dict[str, Any] = {
            "text": text,
            "title": title,
            "project": project,
            "metadata": _metadata(scope, tags),
        }
        reply = await self._request("POST", "/api/memory/save", json_body=body)
        if reply is not None and reply.ok:
            if isinstance(reply.payload, dict):
                record_id = reply.payload.get("id")
                if record_id is not None:
                    return True, str(record_id)
            return True, None
        if reply is not None and not reply.missing_route:
            self._log_once(
                "save", "memory save rejected with status %s; trying session write", reply.status
            )
        return await self._write_via_session(body, scope)

    async def _write_via_session(
        self, body: dict[str, Any], scope: MemoryScope
    ) -> tuple[bool, str | None]:
        """Documented fallback write.

        ``/api/sessions/observations`` ingests a tool event and answers
        ``{"status":"queued"}``: the record is compressed asynchronously, so no
        id exists to return.
        """
        session_id = f"sandman-{_slug(scope.project)}-{_slug(scope.rollout_id)}"
        payload: dict[str, Any] = {
            "contentSessionId": session_id,
            "tool_name": "sandman",
            "project": body["project"],
            "tool_input": {"title": body["title"], "tags": _metadata(scope, [])["tags"]},
            "tool_response": {"text": body["text"]},
            "text": body["text"],
            "title": body["title"],
            "metadata": body["metadata"],
        }
        reply = await self._request("POST", "/api/sessions/observations", json_body=payload)
        if reply is None or not reply.ok:
            self._log_once(
                "session-write",
                "memory write failed (status %s); finding kept in the run report only",
                reply.status if reply else "unreachable",
            )
            return False, None
        return True, None

    # -- recall ------------------------------------------------------------

    async def recall_prior_fixes(
        self,
        *,
        probe_id: str,
        error_class: str | None,
        project: str,
        limit: int = 5,
    ) -> list[Recollection]:
        """Recall how an equivalent failure was fixed before, best first."""
        if limit <= 0 or not await self.available():
            return []
        terms = ["sandman", "hotfix", probe_id]
        if error_class:
            terms.append(error_class)
        found = await self._search(
            "/api/search", query=" ".join(terms), project=project, limit=limit * 4
        )
        ranked = _rerank(
            found,
            probe_id=probe_id,
            kind="hotfix",
            boost_terms=[t for t in (error_class, "hotfix") if t],
        )
        # A fix that was never verified is still worth recalling, but it must
        # never outrank one that passed a reprobe.
        ranked.sort(key=lambda r: (not r.verified, -(r.score or 0.0)))
        return ranked[:limit]

    async def recall_persistent_failures(
        self,
        *,
        project: str,
        probe_id: str,
        limit: int = 10,
    ) -> list[Recollection]:
        """Earlier runs that already surfaced this probe's failure.

        A non-empty result is what lets a PRE_EXISTING finding be marked
        ``previously_ignored`` instead of being reported as news.
        """
        if limit <= 0 or not await self.available():
            return []
        found = await self._search(
            "/api/search/observations",
            query=f"sandman finding {probe_id}",
            project=project,
            limit=limit * 4,
        )
        if not found:
            found = await self._search(
                "/api/search", query=f"sandman {probe_id}", project=project, limit=limit * 4
            )
        ranked = _rerank(
            found,
            probe_id=probe_id,
            kind="finding",
            boost_terms=["pre_existing", "still_broken"],
        )
        ranked.sort(key=lambda r: r.created_at, reverse=True)
        return ranked[:limit]

    async def semantic_context(
        self, query: str, *, project: str, limit: int = 8
    ) -> list[Recollection]:
        """Free-text semantic recall, used to brief the patch agent."""
        if not query.strip() or limit <= 0 or not await self.available():
            return []
        # This build reads the query from `q`; older ones read `query`. Sending
        # both is accepted by each.
        body: dict[str, Any] = {
            "q": query,
            "query": query,
            "project": project,
            "limit": limit,
        }
        reply = await self._request("POST", "/api/context/semantic", json_body=body)
        if reply is None or not reply.ok:
            self._log_once(
                "semantic",
                "memory semantic context unavailable (status %s)",
                reply.status if reply else "unreachable",
            )
            return []

        records = _structured_records(reply.payload)
        if records:
            return [
                rec
                for rec in (
                    _record_to_recollection(record, _rank_score(index, len(records)))
                    for index, record in enumerate(records)
                )
                if rec is not None
            ][:limit]

        if isinstance(reply.payload, dict):
            context = reply.payload.get("context")
            if isinstance(context, str) and context.strip():
                return _parse_semantic_context(context)[:limit]
        return []

    async def _search(
        self, path: str, *, query: str, project: str, limit: int
    ) -> list[Recollection]:
        """Run one search and return hydrated records.

        The worker rejects an empty search, so a query is always sent. MCP
        envelope responses carry ids but not bodies, hence the hydration step.
        """
        body: dict[str, Any] = {"query": query, "project": project, "limit": limit}
        params: dict[str, str | int] = {"query": query, "project": project, "limit": limit}
        reply = await self._post_or_get(path, body=body, params=params)
        if reply is None or not reply.ok:
            self._log_once(
                f"search:{path}",
                "memory search %s unavailable (status %s)",
                path,
                reply.status if reply else "unreachable",
            )
            return []

        records = _structured_records(reply.payload)
        if records:
            hydrated = [
                rec
                for rec in (
                    _record_to_recollection(record, _rank_score(index, len(records)))
                    for index, record in enumerate(records)
                )
                if rec is not None
            ]
            return _only_project(hydrated, records, project)

        text = _mcp_text(reply.payload)
        if not text:
            return []
        ids = _ids_from_text(text, limit)
        return await self._hydrate(ids, project=project) if ids else []

    async def _hydrate(self, ids: Sequence[int], *, project: str) -> list[Recollection]:
        """Fetch full records for search hits, preserving search rank order."""
        reply = await self._request("POST", "/api/observations/batch", json_body={"ids": list(ids)})
        records = _structured_records(reply.payload) if reply is not None and reply.ok else None
        if not records:
            records = await self._hydrate_one_by_one(ids)
        by_id = {str(record.get("id")): record for record in records}

        out: list[Recollection] = []
        for index, raw_id in enumerate(ids):
            record = by_id.get(str(raw_id))
            if record is None:
                continue
            record_project = record.get("project")
            if isinstance(record_project, str) and record_project != project:
                continue
            recollection = _record_to_recollection(record, _rank_score(index, len(ids)))
            if recollection is not None:
                out.append(recollection)
        return out

    async def _hydrate_one_by_one(self, ids: Sequence[int]) -> list[dict[str, Any]]:
        semaphore = asyncio.Semaphore(_WRITE_CONCURRENCY)

        async def fetch(raw_id: int) -> dict[str, Any] | None:
            async with semaphore:
                reply = await self._request("GET", f"/api/observation/{raw_id}", attempts=2)
            if reply is None or not reply.ok:
                return None
            if isinstance(reply.payload, dict):
                inner = reply.payload.get("observation")
                return inner if isinstance(inner, dict) else reply.payload
            return None

        fetched = await asyncio.gather(*(fetch(raw_id) for raw_id in ids))
        return [record for record in fetched if record is not None]


# ---------------------------------------------------------------------------
# Ranking helpers
# ---------------------------------------------------------------------------


def _metadata(scope: MemoryScope, tags: Sequence[str]) -> dict[str, Any]:
    """Structured metadata mirroring the tag line embedded in the narrative."""
    merged = list(tags) or scope.tags()
    payload: dict[str, Any] = {
        "source": "sandman",
        "tags": merged,
        "project": scope.project,
        "rollout_id": scope.rollout_id,
    }
    if scope.variant is not None:
        payload["variant"] = scope.variant.value
    if scope.region:
        payload["region"] = scope.region
    if scope.probe_id:
        payload["probe_id"] = scope.probe_id
    return payload


def _only_project(
    recollections: Sequence[Recollection], records: Sequence[dict[str, Any]], project: str
) -> list[Recollection]:
    keep: list[Recollection] = []
    for recollection, record in zip(recollections, records, strict=False):
        record_project = record.get("project")
        if isinstance(record_project, str) and record_project != project:
            continue
        keep.append(recollection)
    return keep


def _rerank(
    recollections: Sequence[Recollection],
    *,
    probe_id: str,
    kind: str,
    boost_terms: Sequence[str],
) -> list[Recollection]:
    """Re-score search hits against the scope we actually asked about.

    The worker ranks on lexical match alone, which happily returns another
    probe's record when the two share vocabulary. A record whose own tags say it
    belongs to a different probe, or is a different kind of record, is dropped
    rather than down-weighted: recalling a *finding* as though it were a fix
    would tell the patch agent a bug was already solved when it was not.
    """
    probe_slug = _slug(probe_id)
    probe_tag = f"sandman:probe:{probe_slug}"
    kind_tag = f"sandman:kind:{kind}"
    scored: list[Recollection] = []
    for recollection in recollections:
        tagged_probe = recollection.probe_id
        if tagged_probe is not None and tagged_probe != probe_slug:
            continue
        if recollection.kind is not None and recollection.kind != kind:
            continue
        score = recollection.score or 0.5
        if probe_tag in recollection.tags:
            score += 0.35
        if kind_tag in recollection.tags:
            score += 0.25
        haystack = f"{recollection.title}\n{recollection.text}".lower()
        for term in boost_terms:
            if term.lower() in haystack:
                score += 0.1
        scored.append(recollection.model_copy(update={"score": round(min(score, 2.0), 4)}))
    scored.sort(key=lambda r: r.score or 0.0, reverse=True)
    return scored
