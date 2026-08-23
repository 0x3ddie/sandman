"""Security probe preset.

Four families of check, all read-only and all safe to run against a disposable
replica:

*Injection.* SQL, NoSQL, template, and command payloads. The assertion is not
"the payload was rejected" -- many services legitimately accept odd strings as
search terms -- but that the service neither crashes nor echoes evidence of
having interpreted the payload.

*Path traversal.* Classic and encoded ``../`` sequences must not return file
contents.

*Secret leakage.* Error responses must not contain environment variables, key
material, or stack traces that name internal paths.

*Oversized input.* A large body must be rejected with a client error rather than
consuming the process.

Nothing here attempts to exploit anything or persist state. The probes assert
absence of a bad outcome; they do not attempt to gain access.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from sandman_sdk import ProbeContext, ProbeDefinition, ProbeFailure, Target, expect

INJECTION_PAYLOADS: tuple[str, ...] = (
    "' OR '1'='1",
    "'; DROP TABLE items; --",
    '{"$ne": null}',
    "{{7*7}}",
    "${7*7}",
    "<%= 7*7 %>",
    "; ls -la",
    "| whoami",
    "$(id)",
    "`id`",
    "<script>alert(1)</script>",
    "\x00truncated",
)

TRAVERSAL_PAYLOADS: tuple[str, ...] = (
    "../../etc/passwd",
    "....//....//etc/passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..\\..\\windows\\win.ini",
    "/etc/passwd",
    "file:///etc/passwd",
)

# Template payloads paired with the value they produce if a template engine
# evaluates them. The operands are chosen so the product is a long, arbitrary
# number that will not occur naturally in a response -- checking for "49" from
# 7*7 produces a false positive against any body containing a price or a count.
TEMPLATE_PROBES: tuple[tuple[str, str], ...] = (
    ("{{91193*81131}}", str(91193 * 81131)),
    ("${91193*81131}", str(91193 * 81131)),
    ("<%= 91193*81131 %>", str(91193 * 81131)),
)

LEAK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("unix passwd file", re.compile(r"root:.*?:0:0:")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("openai key", re.compile(r"\bsk-[A-Za-z0-9]{16,}")),
    ("github token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}")),
    ("stripe key", re.compile(r"\b[sr]k_(live|test)_[A-Za-z0-9]{16,}")),
    ("stripe webhook secret", re.compile(r"\bwhsec_[A-Za-z0-9]{16,}")),
    ("aws access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("modal token", re.compile(r"\bak-[A-Za-z0-9]{16,}")),
    ("env dump", re.compile(r"\b(AWS_SECRET_ACCESS_KEY|DATABASE_URL|OPENAI_API_KEY)\s*[=:]")),
)


def build(probe_id: str, params: Mapping[str, Any]) -> list[ProbeDefinition]:
    endpoints: Sequence[str] = _endpoints(params)
    param_name = str(params.get("param", "q"))
    fanout = int(params.get("fanout", 1) or 1)
    timeout = float(params.get("timeout_seconds", 90))

    definitions: list[ProbeDefinition] = []

    for endpoint in endpoints:
        slug = _slug(endpoint)

        async def injection(t: Target, ctx: ProbeContext, _ep: str = endpoint) -> None:
            """Hostile strings must be treated as data, not executed."""
            for payload in INJECTION_PAYLOADS:
                response = await t.get(_ep, params={param_name: payload})
                expect(response).not_server_error()
                _assert_no_leak(response.text, _ep, payload)

            # Template evaluation is checked differentially: the marker only
            # counts if it appears in the payload response and NOT in a control
            # response to the same endpoint. Without the control, any body that
            # happens to contain the digits reads as a false positive.
            control = await t.get(_ep)
            for payload, marker in TEMPLATE_PROBES:
                response = await t.get(_ep, params={param_name: payload})
                expect(response).not_server_error()
                if marker in response.text and marker not in control.text:
                    raise ProbeFailure(
                        f"{_ep} evaluated the template payload {payload!r}: the response "
                        f"contains {marker}, which the control response does not",
                        expected="payload treated as literal data",
                        actual=marker,
                    )

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:injection:{slug}",
                fn=injection,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("security", "injection"),
                description=f"Injection payloads against {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

        async def traversal(t: Target, ctx: ProbeContext, _ep: str = endpoint) -> None:
            """Traversal sequences must not return file contents."""
            for payload in TRAVERSAL_PAYLOADS:
                response = await t.get(_ep, params={param_name: payload})
                expect(response).not_server_error()
                _assert_no_leak(response.text, _ep, payload)

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:traversal:{slug}",
                fn=traversal,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("security", "traversal"),
                description=f"Path traversal against {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

        async def oversized(t: Target, ctx: ProbeContext, _ep: str = endpoint) -> None:
            """A very large parameter must be refused, not crash the process."""
            response = await t.get(_ep, params={param_name: "A" * 64_000})
            expect(response).not_server_error()

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:oversized:{slug}",
                fn=oversized,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("security", "limits"),
                description=f"Oversized input against {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

    async def error_hygiene(t: Target, ctx: ProbeContext) -> None:
        """Error pages must not leak internals.

        Deliberately requests paths that should not exist, then inspects the
        response for credentials, key material, and internal filesystem paths.
        """
        for path in ("/__sandman_missing__", "/../../etc/passwd", "/admin", "/.env", "/.git/config"):
            response = await t.get(path)
            _assert_no_leak(response.text, path, "not-found probe")
            if "/Users/" in response.text or "/home/" in response.text:
                raise ProbeFailure(
                    f"{path} leaked an absolute filesystem path in its error response"
                )

    definitions.append(
        ProbeDefinition(
            id=f"{probe_id}:error-hygiene",
            fn=error_hygiene,
            fanout=fanout,
            timeout_seconds=timeout,
            tags=("security", "disclosure"),
            description="Error responses do not disclose secrets or internal paths",
            params=dict(params),
            wants_context=True,
        )
    )

    return definitions


def _assert_no_leak(body: str, endpoint: str, payload: str) -> None:
    for label, pattern in LEAK_PATTERNS:
        if pattern.search(body):
            raise ProbeFailure(
                f"{endpoint} leaked what looks like a {label} in response to {payload!r}"
            )


def _endpoints(params: Mapping[str, Any]) -> Sequence[str]:
    endpoints = params.get("endpoints")
    if isinstance(endpoints, (list, tuple)) and endpoints:
        return [str(e) for e in endpoints]
    return ["/health"]


def _slug(endpoint: str) -> str:
    return endpoint.strip("/").replace("/", ".") or "root"
