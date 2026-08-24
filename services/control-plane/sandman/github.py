"""GitHub App integration: installation tokens, branches, PRs, checks, merges, clones.

AUTH MODEL -- GitHub App only, never a user PAT.
The control plane signs a short-lived RS256 JWT with the App private key, then
exchanges it for an *installation access token*: repo-scoped, permission-scoped,
one hour, revocable, and attributed to ``sandman[bot]``. A PAT would be none of
those things, and would attribute every automated commit to a human.

SAFETY INVARIANTS enforced here:

1. Codex never holds push capability. Patch generation runs inside a
   :class:`GitWorkspace` cloned with *no* credential material of any kind
   (``token=None``); publishing that work is a separate :meth:`GitWorkspace.push`
   call which receives a narrowly scoped token at the moment it is needed.
2. Every checkout is verified. :func:`clone_workspace` compares ``rev-parse HEAD``
   against the pinned :class:`~.models.Revision` sha and refuses the workspace on
   mismatch -- a ref that moved between resolution and clone must never be
   mistaken for the revision under investigation.
4. Credentials never reach a log, an error, a URL, or ``.git/config``. Git auth is
   injected through an ephemeral ``credential.helper`` that reads the token from
   the child process environment, passed with ``-c`` so it is never persisted and
   never appears in ``argv``. Every response body and every git stderr stream is
   passed through :func:`redact` before it is embedded in an exception.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import random
import re
import shutil
import tempfile
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Self

import httpx
import jwt
from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

from .config import Settings, get_settings
from .models import Revision

__all__ = [
    "GitError",
    "GitHubApp",
    "GitHubAuthError",
    "GitHubClient",
    "GitHubError",
    "GitWorkspace",
    "InstallationToken",
    "MergeBlocked",
    "PullRequest",
    "RevisionMismatch",
    "clone_workspace",
    "redact",
]

API_BASE = "https://api.github.com"

#: GitHub pins its REST contract to a dated version; sending it explicitly stops a
#: future default from silently changing response shapes underneath a run.
_API_VERSION = "2022-11-28"
_ACCEPT = "application/vnd.github+json"
_USER_AGENT = "sandman-control-plane"

#: GitHub rejects an App JWT whose lifetime exceeds 10 minutes, and rejects one
#: whose ``iat`` is in the future by even a second, so it is back-dated to absorb
#: clock skew between this host and github.com.
_JWT_TTL_SECONDS = 540
_JWT_BACKDATE_SECONDS = 60

_MAX_ATTEMPTS = 4
_BACKOFF_BASE_SECONDS = 0.5
_BACKOFF_CAP_SECONDS = 8.0
_RETRY_AFTER_CAP_SECONDS = 60.0

_MAX_PAGES = 20
_PER_PAGE = 100

#: Commits scanned when resolving the previous rollout. Two pages is generous:
#: an LKG branch with no merge in its last 200 commits is not merge-based.
_LKG_SCAN_PAGES = 2

_MERGE_METHODS = frozenset({"merge", "squash", "rebase"})
_CHECK_CONCLUSIONS = frozenset(
    {"success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"}
)

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_BRANCH_RE = re.compile(r"^(?!-)[A-Za-z0-9._/\-]{1,255}$")

_GIT_TOKEN_ENV = "SANDMAN_GIT_TOKEN"

#: Git invokes a ``!``-prefixed helper through ``sh -c``. The token is read from
#: the environment inside the child, so it is absent from argv (world-readable on
#: Linux via /proc) and from every git config file.
_CREDENTIAL_HELPER = (
    f'!f() {{ echo username=x-access-token; echo "password=${_GIT_TOKEN_ENV}"; }}; f'
)

_CLONE_TIMEOUT_SECONDS = 600.0
_GIT_TIMEOUT_SECONDS = 120.0


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# Applied to every string this module puts into an exception or a log line. The
# strings involved -- API error bodies, git stderr -- are the exact places a
# token would surface if any of the injection paths above were ever weakened.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\b(?:bearer|basic|token)\s+[A-Za-z0-9._\-+/=]{12,}"),
    re.compile(r"(?i)-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|password|authorization)\b\s*[=:]\s*\S+"),
    re.compile(r"(?i)://[^/\s:@]+:[^/\s@]+@"),
)

_REDACTED = "[redacted]"


def redact(value: str) -> str:
    """Strip anything credential-shaped from text that is about to escape."""
    out = value
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(_REDACTED, out)
    return out


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class GitHubError(RuntimeError):
    """Any failure talking to GitHub, over REST or over git.

    ``body`` is always redacted before it is stored: error payloads are the most
    common accidental carrier of a token.
    """

    def __init__(self, message: str, *, status: int | None = None, body: str | None = None) -> None:
        self.status = status
        self.body = redact(body) if body else None
        detail = f" (HTTP {status})" if status is not None else ""
        suffix = f": {self.body}" if self.body else ""
        super().__init__(f"{redact(message)}{detail}{suffix}")


class GitHubAuthError(GitHubError):
    """The App credentials are missing, malformed, or rejected."""


class MergeBlocked(GitHubError):
    """GitHub refused the merge: not mergeable, conflicted, or head moved."""


class GitError(GitHubError):
    """A local git command failed."""

    def __init__(self, message: str, *, command: Sequence[str] = (), stderr: str = "") -> None:
        self.command = tuple(command)
        super().__init__(message, body=stderr or None)


class RevisionMismatch(GitError):
    """The checked-out HEAD is not the pinned sha (invariant 2)."""

    def __init__(self, expected: str, actual: str) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"checkout verification failed: expected HEAD {expected}, got {actual}; "
            "the ref moved or the remote served a different object"
        )


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


class InstallationToken(BaseModel):
    """A minted installation access token and its hard expiry.

    The token field is excluded from ``repr`` and redacted on serialisation: this
    object is routinely carried inside run state that gets logged or persisted,
    and a model dump is the easiest way to leak an hour of push capability.
    """

    model_config = ConfigDict(frozen=True)

    token: str = Field(repr=False)
    expires_at: datetime
    permissions: dict[str, str] = Field(default_factory=dict, repr=False)

    @field_validator("expires_at")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        return v.replace(tzinfo=UTC) if v.tzinfo is None else v.astimezone(UTC)

    @field_serializer("token")
    def _hide_token(self, value: str) -> str:
        return _REDACTED

    @property
    def expired(self) -> bool:
        """True within 60s of expiry, so a request cannot start on a live token
        and finish on a dead one."""
        return datetime.now(UTC) >= self.expires_at - timedelta(seconds=60)


class PullRequest(BaseModel):
    """The subset of a pull request the promotion pipeline reasons about."""

    model_config = ConfigDict(frozen=True)

    number: int
    url: str
    html_url: str
    head_sha: str
    draft: bool = False
    mergeable_state: str | None = None
    """``clean``, ``blocked``, ``dirty``, ``unstable``... GitHub computes it
    asynchronously and omits it on freshly created PRs, hence optional."""

    @classmethod
    def from_api(cls, payload: Mapping[str, Any]) -> Self:
        head = payload.get("head")
        head_sha = head.get("sha", "") if isinstance(head, Mapping) else ""
        if not isinstance(head_sha, str) or not _SHA_RE.match(head_sha):
            raise GitHubError(f"pull request payload carries no head sha: {head_sha!r}")
        return cls(
            number=int(payload["number"]),
            url=str(payload.get("url", "")),
            html_url=str(payload.get("html_url", "")),
            head_sha=head_sha,
            draft=bool(payload.get("draft", False)),
            mergeable_state=_opt_str(payload.get("mergeable_state")),
        )


# ---------------------------------------------------------------------------
# HTTP transport
# ---------------------------------------------------------------------------


class _GitHubHTTP:
    """Shared REST transport: bounded retries, redacted errors, pagination."""

    def __init__(self, *, base_url: str = API_BASE, timeout_s: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = httpx.Timeout(timeout_s, connect=10.0, pool=10.0)
        self._client: httpx.AsyncClient | None = None
        self._client_lock = asyncio.Lock()

    async def _authorization(self) -> str:
        raise NotImplementedError

    async def _http(self) -> httpx.AsyncClient:
        async with self._client_lock:
            if self._client is None:
                self._client = httpx.AsyncClient(
                    base_url=self._base_url,
                    timeout=self._timeout,
                    follow_redirects=False,
                    headers={
                        "accept": _ACCEPT,
                        "x-github-api-version": _API_VERSION,
                        "user-agent": _USER_AGENT,
                    },
                )
            return self._client

    async def aclose(self) -> None:
        async with self._client_lock:
            if self._client is not None:
                await self._client.aclose()
                self._client = None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        params: Mapping[str, str | int] | None = None,
        allow: Iterable[int] = (),
    ) -> httpx.Response:
        """One REST call with bounded retries.

        Retries 429, 5xx, and the 403 form GitHub uses for secondary rate limits,
        honouring ``Retry-After``. Any other non-2xx raises immediately: retrying
        a 404 or a validation error only burns a run's wall-clock budget.
        """
        allowed = set(allow)
        client = await self._http()
        # httpx resolves an absolute URL against base_url as a replacement, so
        # paginated follow-up URLs work through the same call path.
        url = path
        last_error: str = "unknown"

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            headers = {"authorization": await self._authorization()}
            try:
                response = await client.request(
                    method, url, json=json_body, params=params, headers=headers
                )
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {redact(str(exc))}"
                if attempt == _MAX_ATTEMPTS:
                    raise GitHubError(f"{method} {url} failed: {last_error}") from exc
                await asyncio.sleep(_backoff(attempt))
                continue

            status = response.status_code
            if status in allowed or 200 <= status < 300:
                return response

            if _is_retryable(response):
                last_error = f"HTTP {status}"
                if attempt == _MAX_ATTEMPTS:
                    break
                await asyncio.sleep(_retry_delay(response, attempt))
                continue

            raise _error_for(method, url, response)

        raise GitHubError(f"{method} {url} exhausted retries ({last_error})")

    async def _paginate(
        self,
        path: str,
        *,
        params: Mapping[str, str | int] | None = None,
        key: str | None = None,
    ) -> list[dict[str, Any]]:
        """Follow ``Link: rel=next`` up to :data:`_MAX_PAGES`."""
        query: dict[str, str | int] = {"per_page": _PER_PAGE, **(params or {})}
        url = path
        out: list[dict[str, Any]] = []

        for _ in range(_MAX_PAGES):
            response = await self._request("GET", url, params=query)
            payload = _decode(response)
            rows = payload.get(key) if key and isinstance(payload, dict) else payload
            if not isinstance(rows, list):
                raise GitHubError(f"GET {url} returned {type(rows).__name__}, expected a list")
            out.extend(row for row in rows if isinstance(row, dict))

            nxt = response.links.get("next", {}).get("url")
            if not nxt:
                break
            url = str(nxt)
            # The next URL already carries its own cursor and per_page.
            query = {}

        return out


class GitHubApp:
    """App-level authentication: JWTs in, installation tokens out."""

    def __init__(self, settings: Settings | None = None, *, base_url: str = API_BASE) -> None:
        self._settings = settings or get_settings()
        self._base_url = base_url.rstrip("/")
        self._installations: dict[tuple[str, str], int] = {}
        self._tokens: dict[tuple[str, str, str], InstallationToken] = {}
        self._lock = asyncio.Lock()
        self._api = _AppHTTP(self, base_url=base_url)

    def __repr__(self) -> str:
        return f"GitHubApp(app_id={self._settings.github_app_id!r})"

    async def aclose(self) -> None:
        await self._api.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    # -- JWT ---------------------------------------------------------------

    def app_jwt(self) -> str:
        """Sign a short-lived RS256 assertion for the App itself."""
        app_id = self._settings.github_app_id
        pem = self._settings.github_private_key_pem()
        if not app_id or not pem:
            missing = ", ".join(self._settings.missing_for("github"))
            raise GitHubAuthError(f"GitHub App is not configured; missing: {missing}")

        now = int(datetime.now(UTC).timestamp())
        try:
            return jwt.encode(
                {
                    "iat": now - _JWT_BACKDATE_SECONDS,
                    "exp": now + _JWT_TTL_SECONDS,
                    "iss": app_id,
                },
                pem,
                algorithm="RS256",
            )
        except Exception as exc:
            # Never surface the exception text: cryptography's key-parsing errors
            # can quote the malformed PEM back at you.
            raise GitHubAuthError(
                f"could not sign App JWT with the configured private key "
                f"({type(exc).__name__}); expected an RSA PEM"
            ) from None

    # -- installations -----------------------------------------------------

    async def installation_id(self, owner: str, repo: str) -> int:
        """Resolve which installation covers a repository."""
        key = (owner.lower(), repo.lower())
        cached = self._installations.get(key)
        if cached is not None:
            return cached

        response = await self._api._request("GET", f"/repos/{owner}/{repo}/installation")
        payload = _object(response)
        raw = payload.get("id")
        if not isinstance(raw, int):
            raise GitHubError(f"installation lookup for {owner}/{repo} returned no id")
        self._installations[key] = raw
        return raw

    async def token_for(
        self,
        owner: str,
        repo: str,
        *,
        permissions: dict[str, str] | None = None,
    ) -> InstallationToken:
        """Mint (or reuse) an installation token scoped to one repository.

        The cache key includes the requested permission set, not just the repo: a
        token narrowed to ``contents:read`` must never be handed back to a caller
        that asked for ``pull_requests:write``, and -- more importantly -- a
        broadly scoped token must never be handed to a caller that deliberately
        asked to be narrowed.
        """
        key = (owner.lower(), repo.lower(), _permission_signature(permissions))
        async with self._lock:
            cached = self._tokens.get(key)
            if cached is not None and not cached.expired:
                return cached

            installation = await self.installation_id(owner, repo)
            body: dict[str, Any] = {"repositories": [repo]}
            if permissions:
                body["permissions"] = permissions

            response = await self._api._request(
                "POST", f"/app/installations/{installation}/access_tokens", json_body=body
            )
            payload = _object(response)
            token = payload.get("token")
            expires_at = payload.get("expires_at")
            if not isinstance(token, str) or not token or not isinstance(expires_at, str):
                raise GitHubAuthError(
                    f"installation {installation} returned a malformed token response"
                )

            granted = payload.get("permissions")
            minted = InstallationToken(
                token=token,
                expires_at=_parse_timestamp(expires_at),
                permissions=(
                    {str(k): str(v) for k, v in granted.items()}
                    if isinstance(granted, dict)
                    else {}
                ),
            )
            self._tokens[key] = minted
            return minted

    async def client_for(
        self,
        owner: str,
        repo: str,
        *,
        permissions: dict[str, str] | None = None,
    ) -> GitHubClient:
        """A REST client bound to a freshly minted installation token."""
        token = await self.token_for(owner, repo, permissions=permissions)
        return GitHubClient(token.token, base_url=self._base_url)


class _AppHTTP(_GitHubHTTP):
    """Transport that authenticates as the App (JWT), not an installation."""

    def __init__(self, app: GitHubApp, *, base_url: str = API_BASE) -> None:
        super().__init__(base_url=base_url)
        self._app = app

    async def _authorization(self) -> str:
        # Re-signed per attempt so a retry after a long Retry-After cannot present
        # an assertion that expired while waiting.
        return f"Bearer {self._app.app_jwt()}"


# ---------------------------------------------------------------------------
# Repository operations
# ---------------------------------------------------------------------------


class GitHubClient(_GitHubHTTP):
    """Repository REST operations, authenticated by an installation token."""

    def __init__(self, token: str, *, base_url: str = API_BASE, timeout_s: float = 30.0) -> None:
        super().__init__(base_url=base_url, timeout_s=timeout_s)
        if not token:
            raise GitHubAuthError("GitHubClient requires an installation token")
        self._token = token

    def __repr__(self) -> str:
        # The default repr would print the token.
        return f"GitHubClient(base_url={self._base_url!r})"

    async def _authorization(self) -> str:
        return f"Bearer {self._token}"

    # -- refs --------------------------------------------------------------

    async def get_branch_sha(self, owner: str, repo: str, branch: str) -> str:
        """Resolve a branch to its current commit sha."""
        _check_branch(branch)
        response = await self._request("GET", f"/repos/{owner}/{repo}/git/ref/heads/{branch}")
        payload = _object(response)
        obj = payload.get("object")
        sha = obj.get("sha") if isinstance(obj, Mapping) else None
        if not isinstance(sha, str) or not _SHA_RE.match(sha):
            raise GitHubError(f"ref heads/{branch} resolved to no commit sha")
        return sha

    async def create_branch(self, owner: str, repo: str, branch: str, from_sha: str) -> None:
        """Create ``refs/heads/{branch}`` at ``from_sha``.

        Idempotent: GitHub answers 422 "Reference already exists" when the branch
        is already there, which is the desired end state for a retried run.
        """
        _check_branch(branch)
        _check_sha(from_sha)
        response = await self._request(
            "POST",
            f"/repos/{owner}/{repo}/git/refs",
            json_body={"ref": f"refs/heads/{branch}", "sha": from_sha},
            allow=(422,),
        )
        if response.status_code == 422:
            if "already exists" in _message_of(response).lower():
                return
            raise _error_for("POST", f"/repos/{owner}/{repo}/git/refs", response)

    # -- pull requests -----------------------------------------------------

    async def create_pull_request(
        self,
        owner: str,
        repo: str,
        *,
        head: str,
        base: str,
        title: str,
        body: str,
        draft: bool = False,
    ) -> PullRequest:
        """Open a pull request, reusing the open one when it already exists."""
        response = await self._request(
            "POST",
            f"/repos/{owner}/{repo}/pulls",
            json_body={
                "head": head,
                "base": base,
                "title": title,
                "body": body,
                "draft": draft,
            },
            allow=(422,),
        )
        if response.status_code == 422:
            message = _message_of(response).lower()
            if "already exists" not in message:
                raise _error_for("POST", f"/repos/{owner}/{repo}/pulls", response)
            existing = await self._find_open_pull_request(owner, repo, head=head, base=base)
            if existing is None:
                raise _error_for("POST", f"/repos/{owner}/{repo}/pulls", response)
            return existing
        return PullRequest.from_api(_object(response))

    async def _find_open_pull_request(
        self, owner: str, repo: str, *, head: str, base: str
    ) -> PullRequest | None:
        qualified = head if ":" in head else f"{owner}:{head}"
        rows = await self._paginate(
            f"/repos/{owner}/{repo}/pulls",
            params={"state": "open", "head": qualified, "base": base},
        )
        return PullRequest.from_api(rows[0]) if rows else None

    async def get_pull_request(self, owner: str, repo: str, pr_number: int) -> PullRequest:
        response = await self._request("GET", f"/repos/{owner}/{repo}/pulls/{pr_number}")
        return PullRequest.from_api(_object(response))

    async def list_reviews(self, owner: str, repo: str, pr_number: int) -> list[dict[str, Any]]:
        """Every review on a PR, oldest first (GitHub's own order)."""
        return await self._paginate(f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews")

    async def merge_pull_request(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        *,
        method: str = "squash",
        commit_title: str | None = None,
    ) -> str:
        """Merge a PR and return the merge commit sha.

        Raises :class:`MergeBlocked` for the two refusals a promotion pipeline
        must distinguish from a transport failure: 405 (not mergeable -- failing
        checks, missing review, conflict) and 409 (head moved since it was read).
        """
        if method not in _MERGE_METHODS:
            raise GitHubError(f"unknown merge method {method!r}; expected one of {_MERGE_METHODS}")

        body: dict[str, Any] = {"merge_method": method}
        if commit_title:
            body["commit_title"] = commit_title

        path = f"/repos/{owner}/{repo}/pulls/{pr_number}/merge"
        response = await self._request("PUT", path, json_body=body, allow=(405, 409))
        if response.status_code in (405, 409):
            raise MergeBlocked(
                f"GitHub refused to merge {owner}/{repo}#{pr_number}: {_message_of(response)}",
                status=response.status_code,
                body=response.text[:500],
            )

        payload = _object(response)
        sha = payload.get("sha")
        if not payload.get("merged") or not isinstance(sha, str) or not _SHA_RE.match(sha):
            raise MergeBlocked(
                f"merge of {owner}/{repo}#{pr_number} did not complete: "
                f"{_opt_str(payload.get('message')) or 'no merge sha returned'}",
                status=response.status_code,
            )
        return sha

    # -- checks ------------------------------------------------------------

    async def list_check_runs(self, owner: str, repo: str, ref: str) -> list[dict[str, Any]]:
        """Check runs for a ref. ``ref`` may be a sha, branch, or tag."""
        return await self._paginate(
            f"/repos/{owner}/{repo}/commits/{ref}/check-runs", key="check_runs"
        )

    async def create_check_run(
        self,
        owner: str,
        repo: str,
        *,
        name: str,
        head_sha: str,
        conclusion: str,
        title: str,
        summary: str,
        details_url: str | None = None,
    ) -> None:
        """Publish a completed check run -- how a sandman verdict lands on a PR."""
        _check_sha(head_sha)
        if conclusion not in _CHECK_CONCLUSIONS:
            raise GitHubError(
                f"invalid check conclusion {conclusion!r}; expected one of {_CHECK_CONCLUSIONS}"
            )

        body: dict[str, Any] = {
            "name": name,
            "head_sha": head_sha,
            "status": "completed",
            "conclusion": conclusion,
            "completed_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            # GitHub truncates output.summary at 65535 characters and 422s past it.
            "output": {"title": title[:255], "summary": summary[:65_000]},
        }
        if details_url:
            body["details_url"] = details_url

        await self._request("POST", f"/repos/{owner}/{repo}/check-runs", json_body=body)

    # -- history -----------------------------------------------------------

    async def compare(self, owner: str, repo: str, base: str, head: str) -> dict[str, Any]:
        """Two-dot-dot-dot comparison: ahead/behind counts, commits, and files."""
        response = await self._request("GET", f"/repos/{owner}/{repo}/compare/{base}...{head}")
        return _object(response)

    async def resolve_previous_lkg(
        self, owner: str, repo: str, branch: str
    ) -> Revision | None:
        """The rollout *before* the current one, for the baseline lane.

        On a squash- or merge-based trunk each rollout is one merge commit, so the
        second-newest merge is the code that was live before this cut. A branch
        with no merges (rebase or straight-to-trunk workflow) falls back to the
        second-newest commit, which is the same idea one commit at a time.

        Returns ``None`` only when the branch has no prior state at all -- a repo
        with a single commit -- in which case there is no baseline to run.
        """
        _check_branch(branch)
        commits: list[dict[str, Any]] = []
        url: str | None = f"/repos/{owner}/{repo}/commits"
        query: dict[str, str | int] = {"sha": branch, "per_page": _PER_PAGE}

        for _ in range(_LKG_SCAN_PAGES):
            if url is None:
                break
            response = await self._request("GET", url, params=query)
            page = _array(response)
            commits.extend(page)
            nxt = response.links.get("next", {}).get("url")
            url = str(nxt) if nxt else None
            query = {}

        merges = [c for c in commits if len(_parents(c)) > 1]
        candidates = merges if len(merges) > 1 else commits
        if len(candidates) < 2:
            return None

        sha = candidates[1].get("sha")
        if not isinstance(sha, str) or not _SHA_RE.match(sha):
            return None
        return Revision(ref=branch, sha=sha)


# ---------------------------------------------------------------------------
# Workspaces
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class GitWorkspace:
    """A verified checkout on local disk.

    Constructed only by :func:`clone_workspace`, which guarantees HEAD equals
    ``revision.sha``. Holds no credential: patch generation runs against this
    object with nothing that could push, and :meth:`push` takes the token it
    needs as an argument at the moment of publication (invariant 1).
    """

    path: Path
    revision: Revision
    repo_url: str = field(repr=False)

    async def _run(
        self, *args: str, token: str | None = None, timeout_s: float = _GIT_TIMEOUT_SECONDS
    ) -> str:
        return await _git(*args, cwd=self.path, token=token, timeout_s=timeout_s)

    async def head_sha(self) -> str:
        return (await self._run("rev-parse", "HEAD")).strip()

    async def create_branch(self, name: str) -> None:
        """Create and switch to a local branch at the current HEAD."""
        _check_branch(name)
        await self._run("checkout", "-b", name)

    async def diff(self) -> str:
        """The working-tree patch against HEAD, including untracked files.

        ``--intent-to-add`` is what makes new files appear in the diff at all;
        without it a hotfix that adds a module produces an empty patch.
        """
        await self._run("add", "-A", "--intent-to-add")
        return await self._run("diff", "HEAD", "--no-color")

    async def commit_all(self, message: str, author_name: str, author_email: str) -> str:
        """Stage everything and commit. Returns the new commit sha.

        Identity is passed with ``-c`` rather than written to the repo config, and
        hooks are skipped: a cloned target repository can point ``core.hooksPath``
        at code we have no reason to execute inside the control plane.
        """
        await self._run("add", "-A")
        staged = await _git_status(self.path)
        if not staged:
            raise GitError("nothing to commit: the patch produced no working-tree change")

        await self._run(
            "-c",
            f"user.name={author_name}",
            "-c",
            f"user.email={author_email}",
            "commit",
            "--no-verify",
            "-m",
            message,
        )
        return await self.head_sha()

    async def push(self, branch: str, token: str) -> None:
        """Publish the current HEAD to ``refs/heads/{branch}``.

        Never force-pushes: if the remote branch has diverged this fails loudly
        rather than discarding somebody else's commit. The token is injected via
        the ephemeral credential helper and is gone the moment git exits.
        """
        _check_branch(branch)
        if not token:
            raise GitHubAuthError("push requires an installation token")
        await self._run(
            "push",
            "origin",
            f"HEAD:refs/heads/{branch}",
            token=token,
            timeout_s=_CLONE_TIMEOUT_SECONDS,
        )


@asynccontextmanager
async def clone_workspace(
    repo_url: str,
    revision: Revision,
    *,
    token: str | None = None,
    depth: int | None = None,
) -> AsyncIterator[GitWorkspace]:
    """Clone into a temporary directory at an exact commit, then verify it.

    ``token`` is optional *by design*: the patch-generation workspace is cloned
    with ``token=None`` from a public URL or with a read-only token, so the agent
    working in it has no capability to publish anything (invariant 1).

    The pinned sha is re-read with ``rev-parse`` after checkout and compared, so a
    ref that moved between resolution and clone raises :class:`RevisionMismatch`
    instead of quietly seeding an investigation with the wrong code (invariant 2).
    """
    if "@" in repo_url.split("//", 1)[-1].split("/", 1)[0]:
        raise GitHubError("repo_url must not embed credentials; pass a token instead")

    root = Path(tempfile.mkdtemp(prefix="sandman-ws-"))
    try:
        await _git("init", "--quiet", cwd=root)
        await _git("remote", "add", "origin", repo_url, cwd=root)

        depth_args = ["--depth", str(depth)] if depth and depth > 0 else []
        target = "refs/sandman/target"
        fetched = False
        errors: list[str] = []

        # Fetching the sha directly is exact but needs the server to allow it;
        # fetching the ref is universally supported but can race a moving branch,
        # which the post-checkout verification below catches.
        for spec in (revision.sha, f"+{revision.ref}:{target}", f"+refs/heads/*:{target}/*"):
            try:
                await _git(
                    "fetch",
                    "--no-tags",
                    *depth_args,
                    "origin",
                    spec,
                    cwd=root,
                    token=token,
                    timeout_s=_CLONE_TIMEOUT_SECONDS,
                )
            except GitError as exc:
                errors.append(str(exc))
                continue
            fetched = True
            break

        if not fetched:
            raise GitError(
                f"could not fetch {revision} from the remote", stderr=" | ".join(errors[-2:])
            )

        try:
            await _git("checkout", "--force", "--detach", revision.sha, cwd=root)
        except GitError:
            # A shallow fetch of a ref may not contain the pinned commit; deepen
            # once rather than failing a run over a branch that moved.
            await _git(
                "fetch",
                "--no-tags",
                "--unshallow" if depth_args else "--all",
                "origin",
                cwd=root,
                token=token,
                timeout_s=_CLONE_TIMEOUT_SECONDS,
            )
            await _git("checkout", "--force", "--detach", revision.sha, cwd=root)

        actual = (await _git("rev-parse", "HEAD", cwd=root)).strip()
        if actual != revision.sha:
            raise RevisionMismatch(revision.sha, actual)

        yield GitWorkspace(path=root, revision=revision, repo_url=repo_url)
    finally:
        _remove_tree(root)


# ---------------------------------------------------------------------------
# git subprocess plumbing
# ---------------------------------------------------------------------------


async def _git(
    *args: str,
    cwd: Path,
    token: str | None = None,
    timeout_s: float = _GIT_TIMEOUT_SECONDS,
) -> str:
    """Run one git command, returning stdout.

    When a token is supplied it travels in the child's environment and is read by
    an ephemeral credential helper. It is never written into the remote URL, never
    written to ``.git/config``, and never placed in argv (invariant 4).
    """
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ADVICE"] = "0"

    prefix: list[str] = []
    if token:
        env[_GIT_TOKEN_ENV] = token
        # The empty assignment clears any inherited helper (macOS keychain,
        # gh-cli) so only ours can answer for this invocation.
        prefix = ["-c", "credential.helper=", "-c", f"credential.helper={_CREDENTIAL_HELPER}"]

    command = ["git", *prefix, *args]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(cwd),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise GitError(f"could not execute git: {exc}", command=_safe_command(command)) from exc

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
    except TimeoutError:
        process.kill()
        with contextlib.suppress(ProcessLookupError, asyncio.CancelledError):
            await process.wait()
        raise GitError(
            f"git {args[0] if args else ''} timed out after {timeout_s:.0f}s",
            command=_safe_command(command),
        ) from None

    if process.returncode != 0:
        raise GitError(
            f"git {' '.join(_safe_command(command)[1:])} failed with exit {process.returncode}",
            command=_safe_command(command),
            stderr=stderr.decode("utf-8", "replace")[-2000:],
        )
    return stdout.decode("utf-8", "replace")


async def _git_status(cwd: Path) -> bool:
    """True when the index holds a change worth committing."""
    return bool((await _git("status", "--porcelain", cwd=cwd)).strip())


def _safe_command(command: Sequence[str]) -> list[str]:
    """argv with the credential-helper config elided from any error text."""
    return [_REDACTED if _GIT_TOKEN_ENV in part or part.startswith("!f()") else part
            for part in command]


def _remove_tree(path: Path) -> None:
    """Delete a workspace, defeating read-only files git leaves in the object db."""
    try:
        shutil.rmtree(path)
    except OSError:
        for child in path.rglob("*"):
            with contextlib.suppress(OSError):
                child.chmod(0o700)
        shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _check_sha(value: str) -> str:
    if not _SHA_RE.match(value):
        raise GitHubError(f"expected a full 40-character commit sha, got {value!r}")
    return value


def _check_branch(value: str) -> str:
    if not _BRANCH_RE.match(value) or ".." in value or value.endswith((".lock", "/")):
        raise GitHubError(f"invalid branch name {value!r}")
    return value


def _permission_signature(permissions: Mapping[str, str] | None) -> str:
    if not permissions:
        return "*"
    return ",".join(f"{k}={permissions[k]}" for k in sorted(permissions))


def _decode(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError as exc:
        raise GitHubError(
            f"{response.request.method} {response.request.url.path} returned non-JSON",
            status=response.status_code,
            body=response.text[:300],
        ) from exc


def _object(response: httpx.Response) -> dict[str, Any]:
    payload = _decode(response)
    if not isinstance(payload, dict):
        raise GitHubError(
            f"expected a JSON object, got {type(payload).__name__}",
            status=response.status_code,
        )
    return payload


def _array(response: httpx.Response) -> list[dict[str, Any]]:
    payload = _decode(response)
    if not isinstance(payload, list):
        raise GitHubError(
            f"expected a JSON array, got {type(payload).__name__}",
            status=response.status_code,
        )
    return [row for row in payload if isinstance(row, dict)]


def _parents(commit: Mapping[str, Any]) -> list[Any]:
    parents = commit.get("parents")
    return parents if isinstance(parents, list) else []


def _parse_timestamp(value: str) -> datetime:
    """GitHub stamps expiry as RFC 3339 with a literal ``Z``."""
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GitHubAuthError(f"unparseable token expiry {value!r}") from exc


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _message_of(response: httpx.Response) -> str:
    """GitHub's human-readable error message, plus any validation errors."""
    try:
        payload = response.json()
    except ValueError:
        return redact(response.text[:300])
    if not isinstance(payload, dict):
        return redact(str(payload)[:300])

    message = str(payload.get("message", "")).strip()
    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        details = "; ".join(
            str(e.get("message") or e.get("code") or e) for e in errors if isinstance(e, dict)
        )
        if details:
            message = f"{message}: {details}" if message else details
    return redact(message or f"HTTP {response.status_code}")


def _error_for(method: str, url: str, response: httpx.Response) -> GitHubError:
    status = response.status_code
    message = f"{method} {url} -> {_message_of(response)}"
    if status in (401, 403) and "rate limit" not in message.lower():
        return GitHubAuthError(message, status=status)
    return GitHubError(message, status=status)


def _is_retryable(response: httpx.Response) -> bool:
    """429, 5xx, and the 403 GitHub uses for the secondary rate limiter."""
    status = response.status_code
    if status == 429 or status >= 500:
        return True
    if status != 403:
        return False
    if response.headers.get("retry-after"):
        return True
    if response.headers.get("x-ratelimit-remaining") == "0":
        return True
    return "rate limit" in response.text.lower()


def _backoff(attempt: int) -> float:
    ceiling = min(_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), _BACKOFF_CAP_SECONDS)
    return random.uniform(0.0, ceiling)


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    """Honour ``Retry-After`` (seconds or HTTP-date), else jittered backoff.

    GitHub also answers a primary rate-limit 403 with ``x-ratelimit-reset`` as an
    epoch and no ``Retry-After``.
    """
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

    reset = response.headers.get("x-ratelimit-reset")
    if reset and response.headers.get("x-ratelimit-remaining") == "0":
        with contextlib.suppress(ValueError):
            delta = float(reset) - datetime.now(UTC).timestamp()
            return max(0.0, min(delta, _RETRY_AFTER_CAP_SECONDS))

    return _backoff(attempt)
