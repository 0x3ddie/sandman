"""The sandman probe SDK.

A *probe* is an async function that exercises one behaviour of the service under
test and asserts what it expects. sandman runs the same probe against every
variant (BASELINE / INITIAL / HOTFIX) and across every fan-out replica, then
compares the results.

Writing one looks like this::

    from sandman_sdk import Target, expect, probe

    @probe(id="search-last-page", fanout=10, tags=["pagination"])
    async def search_last_page(t: Target) -> None:
        r = await t.get("/api/catalog/search", params={"limit": 20, "offset": 230})
        expect(r).status(200)
        expect(r).json_contains({"has_more": False})

Three rules the harness enforces so that results are comparable:

*Probes must be idempotent.* They run many times, concurrently, against many
replicas. A probe with side effects produces results that cannot be compared.

*Probes must not carry credentials.* :class:`Target` rejects auth headers and
cookies outright. Probes run against disposable replicas, not production.

*Assertion failures are data, not crashes.* ``expect`` raises
:class:`ProbeFailure`, which the harness records as a FAIL with a behavioural
signature. Any other exception is recorded as an ERROR, which explicitly does
*not* count as evidence about the code under test.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

__all__ = [
    "ProbeContext",
    "ProbeDefinition",
    "ProbeFailure",
    "Response",
    "Target",
    "discover",
    "expect",
    "probe",
    "registry",
]

# Headers a probe may never send. Probes exercise disposable replicas; accepting
# a credential here is how a pen-test harness becomes a credential leak.
FORBIDDEN_HEADERS = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "proxy-authorization",
        "x-api-key",
        "x-auth-token",
        "x-amz-security-token",
    }
)


class ProbeFailure(AssertionError):
    """An expectation did not hold.

    Distinct from every other exception on purpose: a failure is a statement
    about the code under test, while an unexpected exception is a statement
    about our harness and must not be treated as evidence.
    """

    def __init__(self, message: str, *, expected: Any = None, actual: Any = None) -> None:
        super().__init__(message)
        self.expected = expected
        self.actual = actual


class ProbeConfigurationError(ValueError):
    """The probe is defined in a way the harness cannot honour."""


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Response:
    """What a probe sees. A thin, comparable view over an HTTP response."""

    status_code: int
    headers: Mapping[str, str]
    text: str
    elapsed_ms: float
    url: str
    method: str

    _json: Any = field(default=None, repr=False)
    _json_parsed: bool = field(default=False, repr=False)

    @classmethod
    def from_httpx(cls, response: httpx.Response, elapsed_ms: float) -> Response:
        return cls(
            status_code=response.status_code,
            headers={k.lower(): v for k, v in response.headers.items()},
            text=response.text,
            elapsed_ms=elapsed_ms,
            url=str(response.request.url),
            method=response.request.method,
        )

    def json(self) -> Any:
        """Decoded body, or ``None`` when the body is not JSON."""
        if not self._json_parsed:
            self._json_parsed = True
            try:
                import json as _json

                self._json = _json.loads(self.text)
            except Exception:
                self._json = None
        return self._json

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300


# ---------------------------------------------------------------------------
# Expectations
# ---------------------------------------------------------------------------


def json_contains(actual: Any, expected: Any) -> bool:
    """Recursive containment: every key/value in ``expected`` appears in ``actual``.

    Containment rather than equality, because a probe should assert the part of
    the contract it cares about without breaking every time an unrelated field
    is added.
    """
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping):
            return False
        return all(k in actual and json_contains(actual[k], v) for k, v in expected.items())
    if isinstance(expected, (list, tuple)):
        if not isinstance(actual, (list, tuple)):
            return False
        return all(any(json_contains(a, e) for a in actual) for e in expected)
    return bool(actual == expected)


class Expectation:
    """Fluent assertions. Every method returns ``self`` so they chain."""

    def __init__(self, response: Response) -> None:
        self._r = response

    def _fail(self, message: str, expected: Any = None, actual: Any = None) -> None:
        raise ProbeFailure(
            f"{message} [{self._r.method} {self._r.url}]", expected=expected, actual=actual
        )

    def status(self, expected: int | Iterable[int]) -> Expectation:
        allowed = {expected} if isinstance(expected, int) else set(expected)
        if self._r.status_code not in allowed:
            self._fail(
                f"expected status {sorted(allowed)}, got {self._r.status_code}",
                expected=sorted(allowed),
                actual=self._r.status_code,
            )
        return self

    def ok(self) -> Expectation:
        if not self._r.ok:
            self._fail(f"expected a 2xx response, got {self._r.status_code}")
        return self

    def not_server_error(self) -> Expectation:
        """The weakest useful assertion: the service did not fall over.

        This is what the fuzzing preset relies on -- a 4xx for nonsense input is
        correct behaviour, a 5xx is a defect.
        """
        if self._r.status_code >= 500:
            self._fail(
                f"server error {self._r.status_code}: {self._r.text[:200]}",
                actual=self._r.status_code,
            )
        return self

    def json_contains(self, expected: Any) -> Expectation:
        body = self._r.json()
        if body is None:
            self._fail("expected a JSON body, got a non-JSON response", expected=expected)
        if not json_contains(body, expected):
            self._fail("JSON body did not contain the expected shape", expected=expected, actual=body)
        return self

    def json_path(self, path: str, expected: Any) -> Expectation:
        """Assert a dotted path, e.g. ``"page.total"``."""
        cursor: Any = self._r.json()
        for part in path.split("."):
            if isinstance(cursor, Mapping) and part in cursor:
                cursor = cursor[part]
            elif isinstance(cursor, Sequence) and not isinstance(cursor, str) and part.isdigit():
                idx = int(part)
                if idx >= len(cursor):
                    self._fail(f"path {path!r} index out of range", expected=expected)
                cursor = cursor[idx]
            else:
                self._fail(f"path {path!r} not present in body", expected=expected)
        if cursor != expected:
            self._fail(f"path {path!r} was {cursor!r}", expected=expected, actual=cursor)
        return self

    def header(self, name: str, expected: str | None = None) -> Expectation:
        value = self._r.headers.get(name.lower())
        if value is None:
            self._fail(f"expected header {name!r}")
        if expected is not None and value != expected:
            self._fail(f"header {name!r} was {value!r}", expected=expected, actual=value)
        return self

    def body_excludes(self, needle: str) -> Expectation:
        """Assert a string is absent. Used by the secret-leak checks."""
        if needle.lower() in self._r.text.lower():
            self._fail(f"response leaked {needle!r}")
        return self

    def faster_than(self, ms: float) -> Expectation:
        if self._r.elapsed_ms > ms:
            self._fail(
                f"took {self._r.elapsed_ms:.0f}ms, budget {ms:.0f}ms",
                expected=ms,
                actual=self._r.elapsed_ms,
            )
        return self


def expect(response: Response) -> Expectation:
    return Expectation(response)


# ---------------------------------------------------------------------------
# Target
# ---------------------------------------------------------------------------


class Target:
    """HTTP client bound to one sandbox replica.

    A probe never learns which variant it is running against. That is deliberate:
    a probe that could branch on the variant would stop being a fair comparison.
    """

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.AsyncClient,
        timeout: float = 20.0,
        default_headers: Mapping[str, str] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client
        self._timeout = timeout
        self._headers = dict(default_headers or {})
        _reject_forbidden_headers(self._headers)
        self.observations: list[Response] = []

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        headers: Mapping[str, str] | None = None,
        content: bytes | str | None = None,
        timeout: float | None = None,
    ) -> Response:
        merged = {**self._headers, **dict(headers or {})}
        _reject_forbidden_headers(merged)

        url = path if path.startswith("http") else f"{self.base_url}/{path.lstrip('/')}"
        started = time.perf_counter()
        response = await self._client.request(
            method,
            url,
            params=params,
            json=json,
            headers=merged,
            content=content,
            timeout=timeout or self._timeout,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        observed = Response.from_httpx(response, elapsed_ms)
        self.observations.append(observed)
        return observed

    async def get(self, path: str, **kw: Any) -> Response:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Response:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw: Any) -> Response:
        return await self.request("PUT", path, **kw)

    async def patch(self, path: str, **kw: Any) -> Response:
        return await self.request("PATCH", path, **kw)

    async def delete(self, path: str, **kw: Any) -> Response:
        return await self.request("DELETE", path, **kw)

    async def burst(
        self, method: str, path: str, *, count: int, concurrency: int = 10, **kw: Any
    ) -> list[Response]:
        """Fire ``count`` requests with bounded concurrency.

        The load preset uses this. Concurrency is bounded here as well as at the
        scheduler, because a single probe should not be able to saturate a
        replica on its own and skew every other probe's latency.
        """
        semaphore = asyncio.Semaphore(concurrency)

        async def one() -> Response:
            async with semaphore:
                return await self.request(method, path, **kw)

        settled = await asyncio.gather(*(one() for _ in range(count)), return_exceptions=True)
        out: list[Response] = []
        for item in settled:
            if isinstance(item, Response):
                out.append(item)
        return out


def _reject_forbidden_headers(headers: Mapping[str, str]) -> None:
    for key in headers:
        if key.lower() in FORBIDDEN_HEADERS:
            raise ProbeConfigurationError(
                f"probe header {key!r} is not allowed: probes must not carry credentials, "
                "cookies, or auth tokens"
            )


# ---------------------------------------------------------------------------
# Probe definitions
# ---------------------------------------------------------------------------

ProbeFn = Callable[..., Awaitable[None]]


@dataclass(slots=True)
class ProbeContext:
    """Read-only run context a probe may accept as a second argument."""

    probe_id: str
    unit_index: int
    replica_count: int
    params: dict[str, Any] = field(default_factory=dict)
    region: str | None = None


@dataclass(slots=True)
class ProbeDefinition:
    id: str
    fn: ProbeFn
    fanout: int = 1
    timeout_seconds: float = 60.0
    tags: tuple[str, ...] = ()
    description: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    wants_context: bool = False

    async def run(self, target: Target, context: ProbeContext) -> None:
        coro = self.fn(target, context) if self.wants_context else self.fn(target)
        await asyncio.wait_for(coro, timeout=self.timeout_seconds)


class ProbeRegistry:
    """Every probe the process knows about, preset or user-authored."""

    def __init__(self) -> None:
        self._probes: dict[str, ProbeDefinition] = {}

    def register(self, definition: ProbeDefinition) -> None:
        if definition.id in self._probes:
            raise ProbeConfigurationError(f"duplicate probe id {definition.id!r}")
        self._probes[definition.id] = definition

    def get(self, probe_id: str) -> ProbeDefinition:
        try:
            return self._probes[probe_id]
        except KeyError:
            available = ", ".join(sorted(self._probes)) or "none"
            raise KeyError(f"unknown probe {probe_id!r}; registered: {available}") from None

    def all(self) -> list[ProbeDefinition]:
        return [self._probes[k] for k in sorted(self._probes)]

    def by_tag(self, tag: str) -> list[ProbeDefinition]:
        return [p for p in self.all() if tag in p.tags]

    def clear(self) -> None:
        self._probes.clear()

    def __contains__(self, probe_id: object) -> bool:
        return probe_id in self._probes

    def __len__(self) -> int:
        return len(self._probes)


registry = ProbeRegistry()


def probe(
    *,
    id: str,
    fanout: int = 1,
    timeout_seconds: float = 60.0,
    tags: Sequence[str] = (),
    description: str = "",
    params: Mapping[str, Any] | None = None,
) -> Callable[[ProbeFn], ProbeFn]:
    """Register an async function as a probe.

    The function takes a :class:`Target` and may optionally take a
    :class:`ProbeContext` as a second parameter.
    """

    def decorator(fn: ProbeFn) -> ProbeFn:
        import inspect

        if not inspect.iscoroutinefunction(fn):
            raise ProbeConfigurationError(f"probe {id!r} must be an async function")

        arity = len(inspect.signature(fn).parameters)
        if arity not in (1, 2):
            raise ProbeConfigurationError(
                f"probe {id!r} must accept (target) or (target, context), got {arity} parameters"
            )

        registry.register(
            ProbeDefinition(
                id=id,
                fn=fn,
                fanout=fanout,
                timeout_seconds=timeout_seconds,
                tags=tuple(tags),
                description=description or (fn.__doc__ or "").strip().split("\n")[0],
                params=dict(params or {}),
                wants_context=arity == 2,
            )
        )
        return fn

    return decorator


def discover(paths: Sequence[str]) -> list[ProbeDefinition]:
    """Import user probe modules so their decorators register.

    Accepts importable module names and filesystem paths to .py files or
    directories.
    """
    import importlib
    import importlib.util
    import sys
    from pathlib import Path

    before = {p.id for p in registry.all()}

    for entry in paths:
        candidate = Path(entry)
        if candidate.is_dir():
            for file in sorted(candidate.rglob("*.py")):
                if file.name.startswith("_"):
                    continue
                _load_path(file)
        elif candidate.is_file() and candidate.suffix == ".py":
            _load_path(candidate)
        else:
            if str(candidate.parent) not in sys.path and candidate.parent.exists():
                sys.path.insert(0, str(candidate.parent))
            importlib.import_module(entry)

    return [p for p in registry.all() if p.id not in before]


def _load_path(file: Any) -> None:
    import importlib.util
    import sys

    spec = importlib.util.spec_from_file_location(f"sandman_probe_{file.stem}", file)
    if spec is None or spec.loader is None:
        raise ProbeConfigurationError(f"could not import probe module {file}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
