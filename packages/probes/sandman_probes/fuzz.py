"""Differential fuzzing preset.

The assertion is deliberately weak: a 4xx for nonsense input is *correct*
behaviour, so this preset does not demand a specific status. It demands that the
service does not fall over -- a 5xx means an unhandled exception reached the
edge, which is a defect regardless of how strange the input was.

That weakness is what makes the preset portable across services, and it is what
makes it catch the demo's seeded off-by-one: an out-of-range index surfaces as a
500 no matter what the endpoint was supposed to return.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from sandman_sdk import ProbeContext, ProbeDefinition, Target, expect

# Values chosen to hit the boundaries real handlers get wrong: empty and huge
# strings, numbers that overflow a page window, wrong types, and unicode that
# breaks naive encoders.
EDGE_VALUES: tuple[Any, ...] = (
    "",
    " ",
    "0",
    "-1",
    "999999999",
    "1e309",
    "null",
    "true",
    "[]",
    "{}",
    "a" * 2048,
    "../../etc/passwd",
    "\x00",
    "😀🔥",
    "%00",
    "NaN",
)

# Pagination windows. The last-page case is the one that finds off-by-one
# errors, because it is where an over-fetching slice runs out of elements.
PAGINATION_CASES: tuple[dict[str, Any], ...] = (
    {"limit": 1, "offset": 0},
    {"limit": 20, "offset": 0},
    {"limit": 100, "offset": 0},
    {"limit": 20, "offset": 220},
    {"limit": 50, "offset": 200},
    {"limit": 1, "offset": 239},
)


def build(probe_id: str, params: Mapping[str, Any]) -> list[ProbeDefinition]:
    endpoints: Sequence[str] = _endpoints(params)
    fanout = int(params.get("fanout", 1) or 1)
    timeout = float(params.get("timeout_seconds", 60))
    include_pagination = bool(params.get("pagination", True))

    definitions: list[ProbeDefinition] = []

    for endpoint in endpoints:
        slug = _slug(endpoint)

        async def edge_cases(t: Target, ctx: ProbeContext, _ep: str = endpoint) -> None:
            """Malformed query values must not produce a server error."""
            param_name = str(params.get("param", "q"))
            for value in EDGE_VALUES:
                response = await t.get(_ep, params={param_name: value})
                expect(response).not_server_error()

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:edge:{slug}",
                fn=edge_cases,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("fuzz", "differential"),
                description=f"Edge-case inputs against {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

        if include_pagination:

            async def pagination(t: Target, ctx: ProbeContext, _ep: str = endpoint) -> None:
                """Every page window must return a well-formed response.

                Includes windows that land exactly on the end of the result set,
                which is where over-fetching slices raise IndexError.
                """
                for case in PAGINATION_CASES:
                    response = await t.get(_ep, params=case)
                    expect(response).not_server_error()
                    if response.ok:
                        body = response.json()
                        if isinstance(body, Mapping) and "items" in body:
                            items = body.get("items")
                            assert isinstance(items, list), "items must be a list"
                            expect(response).json_contains({"limit": case["limit"]})

            definitions.append(
                ProbeDefinition(
                    id=f"{probe_id}:pagination:{slug}",
                    fn=pagination,
                    fanout=fanout,
                    timeout_seconds=timeout,
                    tags=("fuzz", "pagination", "differential"),
                    description=f"Pagination windows against {endpoint}",
                    params=dict(params),
                    wants_context=True,
                )
            )

        async def empty_result(t: Target, ctx: ProbeContext, _ep: str = endpoint) -> None:
            """A query matching nothing is an empty result, not an error."""
            param_name = str(params.get("param", "q"))
            response = await t.get(_ep, params={param_name: "zzzz-no-such-thing-zzzz"})
            expect(response).not_server_error()

        definitions.append(
            ProbeDefinition(
                id=f"{probe_id}:empty:{slug}",
                fn=empty_result,
                fanout=fanout,
                timeout_seconds=timeout,
                tags=("fuzz", "differential"),
                description=f"Empty result set against {endpoint}",
                params=dict(params),
                wants_context=True,
            )
        )

    return definitions


def _endpoints(params: Mapping[str, Any]) -> Sequence[str]:
    endpoints = params.get("endpoints")
    if isinstance(endpoints, (list, tuple)) and endpoints:
        return [str(e) for e in endpoints]
    return ["/health"]


def _slug(endpoint: str) -> str:
    return endpoint.strip("/").replace("/", ".") or "root"
