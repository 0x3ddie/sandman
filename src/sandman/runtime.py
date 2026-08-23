from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from typing import Any
from uuid import uuid4

import httpx

from sandman.comparison import json_contains
from sandman.models import InvestigationRequest, Lane, LaneResult, Observation, Revision


class SandboxRuntime(ABC):
    @abstractmethod
    def probe(self, request: InvestigationRequest, revision: Revision) -> LaneResult:
        """Start one isolated revision and execute the requested probe."""


def evaluate_response(
    *,
    status_code: int,
    body_json: Any | None,
    body_text: str | None,
    duration_ms: int,
    expected_status: int,
    expected_json: dict[str, Any] | None,
    response_headers: dict[str, str] | None = None,
) -> Observation:
    mismatches: list[str] = []
    if status_code != expected_status:
        mismatches.append(f"expected HTTP {expected_status}, received {status_code}")
    if expected_json is not None and not json_contains(body_json, expected_json):
        mismatches.append("response JSON did not contain the expected contract")
    return Observation(
        status_code=status_code,
        body_json=body_json,
        body_text=body_text,
        response_headers=response_headers or {},
        duration_ms=duration_ms,
        passed=not mismatches,
        mismatches=tuple(mismatches),
    )


class DemoSandboxRuntime(SandboxRuntime):
    """Deterministic runtime used to demonstrate the full control-plane flow safely."""

    def probe(self, request: InvestigationRequest, revision: Revision) -> LaneResult:
        delays = {Lane.KNOWN_GOOD: 0.18, Lane.CURRENT: 0.28, Lane.CANDIDATE: 0.22}
        time.sleep(delays[revision.lane])
        is_current = revision.lane is Lane.CURRENT
        status_code = 500 if is_current else 200
        body_json: dict[str, Any] = (
            {
                "error": "currency code is required",
                "request_id": f"req_{uuid4().hex[:10]}",
            }
            if is_current
            else {
                "quote_id": f"quote_{uuid4().hex[:10]}",
                "currency": "USD",
                "total": 4200,
            }
        )
        observation = evaluate_response(
            status_code=status_code,
            body_json=body_json,
            body_text=json.dumps(body_json),
            duration_ms=int(delays[revision.lane] * 1_000),
            expected_status=request.probe.expected_status,
            expected_json=request.probe.expected_json,
            response_headers={"content-type": "application/json"},
        )
        return LaneResult(
            lane=revision.lane,
            revision=revision,
            sandbox_id=f"demo-{revision.lane.value}-{uuid4().hex[:6]}",
            observation=observation,
        )


class ModalSandboxRuntime(SandboxRuntime):
    def __init__(
        self,
        app_name: str,
        startup_timeout_seconds: int = 120,
        cpu_request: float = 0.5,
        cpu_limit: float = 1.0,
        memory_request_mib: int = 512,
        memory_limit_mib: int = 1_024,
    ) -> None:
        if startup_timeout_seconds <= 0:
            raise ValueError("startup timeout must be greater than zero")
        if cpu_request <= 0 or cpu_limit < cpu_request:
            raise ValueError("CPU limit must be greater than or equal to the request")
        if memory_request_mib <= 0 or memory_limit_mib < memory_request_mib:
            raise ValueError("memory limit must be greater than or equal to the request")
        self._app_name = app_name
        self._startup_timeout_seconds = startup_timeout_seconds
        self._cpu = (cpu_request, cpu_limit)
        self._memory = (memory_request_mib, memory_limit_mib)

    def probe(self, request: InvestigationRequest, revision: Revision) -> LaneResult:
        try:
            return self._probe(request, revision)
        except (httpx.HTTPError, RuntimeError, TimeoutError) as error:
            return self._error_result(revision, str(error))
        except Exception as error:  # Modal exposes runtime-specific exception subclasses.
            return self._error_result(revision, f"sandbox startup failed: {error}")

    def _probe(self, request: InvestigationRequest, revision: Revision) -> LaneResult:
        import modal

        app = modal.App.lookup(self._app_name, create_if_missing=True)
        image = modal.Image.from_registry(request.container_image).apt_install(
            "git", "ca-certificates"
        )
        bootstrap = """
set -euo pipefail
repo_url="$1"
git_ref="$2"
expected_sha="$3"
shift 3
git init -q /workspace
cd /workspace
git remote add origin "$repo_url"
git fetch -q --depth=1 origin "$git_ref"
git checkout -q --detach FETCH_HEAD
actual_sha="$(git rev-parse HEAD)"
if [[ -n "$expected_sha" && "$actual_sha" != "$expected_sha"* ]]; then
  echo "resolved commit $actual_sha does not match expected $expected_sha" >&2
  exit 42
fi
exec "$@"
""".strip()
        sandbox = modal.Sandbox.create(
            "bash",
            "-lc",
            bootstrap,
            "sandman-bootstrap",
            request.repository_url,
            revision.git_ref,
            revision.commit_sha or "",
            *request.startup_command,
            app=app,
            image=image,
            encrypted_ports=[request.service_port],
            timeout=self._startup_timeout_seconds,
            cpu=self._cpu,
            memory=self._memory,
            tags={"sandman_lane": revision.lane.value},
        )
        sandbox_id = sandbox.object_id
        try:
            tunnel = sandbox.tunnels(timeout=self._startup_timeout_seconds)[request.service_port]
            base_url = tunnel.url.rstrip("/")
            self._wait_until_healthy(base_url + request.health_path, request.probe.timeout_seconds)
            started = time.perf_counter()
            with httpx.Client(timeout=request.probe.timeout_seconds) as client:
                response = client.request(
                    request.probe.method,
                    base_url + request.probe.path,
                    headers=request.probe.headers,
                    json=request.probe.json_body,
                )
            duration_ms = int((time.perf_counter() - started) * 1_000)
            try:
                body_json = response.json()
            except ValueError:
                body_json = None
            selected_headers = {
                name.lower(): value
                for name, value in response.headers.items()
                if name.lower() in {"content-type", "content-length", "x-request-id"}
            }
            observation = evaluate_response(
                status_code=response.status_code,
                body_json=body_json,
                body_text=response.text[:10_000],
                duration_ms=duration_ms,
                expected_status=request.probe.expected_status,
                expected_json=request.probe.expected_json,
                response_headers=selected_headers,
            )
            return LaneResult(
                lane=revision.lane,
                revision=revision,
                sandbox_id=sandbox_id,
                observation=observation,
            )
        finally:
            try:
                sandbox.terminate(wait=True)
            finally:
                sandbox.detach()

    @staticmethod
    def _wait_until_healthy(url: str, timeout_seconds: float) -> None:
        deadline = time.monotonic() + max(timeout_seconds, 30)
        last_error = "service did not answer"
        with httpx.Client(timeout=2) as client:
            while time.monotonic() < deadline:
                try:
                    response = client.get(url)
                    if response.status_code < 500:
                        return
                    last_error = f"health endpoint returned HTTP {response.status_code}"
                except httpx.HTTPError as error:
                    last_error = str(error)
                time.sleep(0.5)
        raise TimeoutError(f"service failed its startup check: {last_error}")

    @staticmethod
    def _error_result(revision: Revision, message: str) -> LaneResult:
        return LaneResult(
            lane=revision.lane,
            revision=revision,
            sandbox_id="unavailable",
            observation=Observation(
                duration_ms=0,
                passed=False,
                error=message[:2_000],
            ),
        )
