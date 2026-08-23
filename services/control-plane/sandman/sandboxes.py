"""The Modal sandbox layer.

Every variant lane in an investigation runs inside a disposable Modal sandbox.
This module owns the whole lifecycle: building a pinned base image once per
variant, spawning fan-out units from that snapshot, waiting for the service to
answer a health check over an encrypted tunnel, running commands, and tearing
everything down.

Three constraints shape the code and are not negotiable:

* A revision is ``REF@SHA`` and the SHA is re-read from the checkout with
  ``git rev-parse HEAD`` before the image is snapshotted. A ref can move between
  the moment a run is planned and the moment a sandbox clones it; a lane built
  from a moved ref would produce evidence about code nobody asked about.
* Sandboxes carry *no* control-plane credentials. The only thing that crosses
  the boundary is the repository URL, the revision, and the project's own
  declared environment. Modal, GitHub, OpenAI and Stripe keys stay in the
  control plane.
* Nothing that reaches a log line or an exception message is trusted to be
  credential-free. Every string that leaves this module goes through
  :func:`redact` first.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shlex
import time
from collections.abc import AsyncIterable, AsyncIterator, Callable, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx
import modal
import modal.exception

from .config import Settings, VariantConfig, get_settings
from .models import Revision, SandboxState, Variant

logger = logging.getLogger(__name__)

#: Where every variant's checkout lives inside a sandbox. Probes, setup commands
#: and the startup command all run with this as their working directory.
REPO_DIR = "/workspace/repo"

#: Floor for the build sandbox's own timeout. Cloning a large repository and
#: running setup commands routinely outlasts a probe timeout, and Modal kills the
#: sandbox at ``timeout`` with no diagnostic beyond a vanished container.
_BUILD_TIMEOUT_FLOOR_S = 1800

#: `snapshot_filesystem` blocks server-side; 55s is the SDK's own ceiling.
_SNAPSHOT_TIMEOUT_S = 55

_TUNNEL_TIMEOUT_S = 60
_HEALTH_POLL_INTERVAL_S = 1.0
_HEALTH_POLL_MAX_INTERVAL_S = 8.0
_HEALTH_MAX_ATTEMPTS = 240

#: Grace period added to our own wall-clock guard on top of the deadline handed
#: to Modal, so the remote kill is what normally ends a runaway command.
_EXEC_GUARD_GRACE_S = 15

#: Modal reports an exec whose deadline expired as return code -1 rather than
#: raising, so -1 has to be interpreted here (modal/container_process.py).
_MODAL_DEADLINE_RETURNCODE = -1

_GIT_ENV: dict[str, str | None] = {
    # A private repo must fail fast instead of blocking on a credential prompt
    # that no one is there to answer.
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "/bin/true",
    "GCM_INTERACTIVE": "never",
}


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SandboxError(RuntimeError):
    """Any failure in provisioning, driving, or tearing down a sandbox."""


class SnapshotError(SandboxError):
    """The base image for a variant could not be built or snapshotted."""


class ExecTimeout(SandboxError):
    """A command exceeded its deadline.

    Carries whatever output was captured before the kill so a timed-out probe
    still has evidence attached to it.
    """

    def __init__(self, command: str, timeout_s: int, stdout: str, stderr: str) -> None:
        super().__init__(f"command timed out after {timeout_s}s: {command}")
        self.command = command
        self.timeout_s = timeout_s
        self.stdout = stdout
        self.stderr = stderr


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

_CREDENTIAL_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # userinfo in a URL: https://user:token@host/...
    (re.compile(r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s@]+@"), r"\g<scheme><redacted>@"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"), "<redacted>"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "<redacted>"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b"), "<redacted>"),
    (re.compile(r"\bak-[A-Za-z0-9_\-]{16,}\b"), "<redacted>"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}\b"), "<redacted>"),
    (re.compile(r"\b-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
     "<redacted-private-key>"),
    (re.compile(r"(?i)\b(authorization|bearer|token)\b\s*[:=]?\s*[A-Za-z0-9._\-]{12,}"),
     r"\1 <redacted>"),
)

#: Settings fields whose literal values must never appear in a log or an error.
_SECRET_SETTING_FIELDS: tuple[str, ...] = (
    "modal_token_id",
    "modal_token_secret",
    "openai_api_key",
    "codex_api_key",
    "greptile_api_key",
    "github_app_client_secret",
    "github_app_private_key",
    "sandman_kek",
    "stripe_secret_key",
    "stripe_webhook_secret",
)


def secret_values(settings: Settings) -> tuple[str, ...]:
    """Literal credential values held by the process, for exact-match scrubbing.

    Short values are skipped: scrubbing a three-character string would mangle
    unrelated output without protecting anything meaningful.
    """
    values: list[str] = []
    for name in _SECRET_SETTING_FIELDS:
        value = getattr(settings, name, None)
        if isinstance(value, str) and len(value) >= 8:
            values.append(value)
    pem = settings.github_private_key_pem()
    if pem:
        values.append(pem)
    return tuple(values)


def redact(text: str, extra: Iterable[str] = ()) -> str:
    """Scrub credentials from text before it is logged or raised."""
    out = text
    for value in extra:
        if value:
            out = out.replace(value, "<redacted>")
    for pattern, replacement in _CREDENTIAL_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def _tail(text: str, limit: int = 2000) -> str:
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    return "...(truncated)... " + stripped[-limit:]


# ---------------------------------------------------------------------------
# Handles and results
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ExecResult:
    """The complete outcome of one command run inside a sandbox."""

    exit_code: int
    stdout: str
    stderr: str
    duration_ms: float

    @property
    def ok(self) -> bool:
        return self.exit_code == 0


StateListener = Callable[["SandboxHandle"], None]
"""Called on every state transition so the dashboard can render cold starts."""


@dataclass(slots=True)
class SandboxHandle:
    """A live Modal sandbox plus the run-level identity of the unit inside it."""

    sandbox_id: str
    variant: Variant
    region: str | None
    unit_index: int
    state: SandboxState
    created_at: datetime
    sandbox: modal.Sandbox | None = None
    terminated_at: datetime | None = None
    tunnels: dict[int, str] = field(default_factory=dict)

    def live(self) -> modal.Sandbox:
        """The underlying sandbox, or an error if this handle never got one."""
        if self.sandbox is None:
            raise SandboxError(
                f"{self.variant.glyph}#{self.unit_index}: handle has no live sandbox"
            )
        return self.sandbox

    @property
    def label(self) -> str:
        region = f"@{self.region}" if self.region else ""
        return f"{self.variant.glyph}#{self.unit_index}{region}({self.sandbox_id or 'pending'})"

    def transition(self, state: SandboxState, listener: StateListener | None = None) -> None:
        if self.state is state:
            return
        self.state = state
        if listener is not None:
            listener(self)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


class SandboxFactory:
    """Creates, drives and destroys the sandboxes for one run.

    A single instance is shared by all three variant lanes so that the Modal
    client and the app lookup happen once.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        app_name: str | None = None,
        *,
        on_state: StateListener | None = None,
    ) -> None:
        self.settings = settings if settings is not None else get_settings()
        self.app_name = app_name or self.settings.sandman_modal_app_name
        self._on_state = on_state
        self._secrets = secret_values(self.settings)
        self._client: modal.Client | None = None
        self._app: modal.App | None = None
        self._init_lock = asyncio.Lock()

    # -- infrastructure ----------------------------------------------------

    async def _connect(self) -> tuple[modal.Client | None, modal.App]:
        """Resolve the Modal client and app, once, under a lock."""
        async with self._init_lock:
            if self._app is not None:
                return self._client, self._app
            token_id = self.settings.modal_token_id
            token_secret = self.settings.modal_token_secret
            try:
                if token_id and token_secret:
                    self._client = await modal.Client.from_credentials.aio(
                        token_id, token_secret
                    )
                # With no explicit tokens Modal falls back to the ambient
                # profile (~/.modal.toml or MODAL_* in the environment).
                self._app = await modal.App.lookup.aio(
                    self.app_name, client=self._client, create_if_missing=True
                )
            except modal.exception.Error as exc:
                raise SandboxError(
                    f"could not reach Modal app {self.app_name!r}: {self._scrub(exc)}"
                ) from exc
            return self._client, self._app

    def _scrub(self, value: object) -> str:
        return redact(str(value), self._secrets)

    def mark(self, handle: SandboxHandle, state: SandboxState) -> None:
        """Record a state transition and fan it out to the listener."""
        handle.transition(state, self._on_state)

    def _sandbox_env(self, cfg: VariantConfig) -> dict[str, str | None]:
        """Environment for a sandbox.

        Only the project's own declared variables cross the boundary. No control
        plane credential is ever forwarded: a probe sandbox that held a Modal or
        GitHub token could spawn infrastructure or push code.
        """
        env: dict[str, str | None] = {}
        for key, value in cfg.env.items():
            env[key] = value
        return env

    # -- base image --------------------------------------------------------

    async def build_base(
        self,
        cfg: VariantConfig,
        repo_url: str,
        revision: Revision,
        *,
        variant: Variant = Variant.INITIAL,
    ) -> str:
        """Build and snapshot the filesystem image for one variant.

        Clones ``repo_url`` at ``revision.ref``, detaches onto
        ``revision.sha``, re-reads ``git rev-parse HEAD`` and refuses to
        continue unless it matches, runs the variant's setup commands, then
        snapshots. Returns the snapshot image id, which
        :meth:`spawn` turns back into an image.
        """
        client, app = await self._connect()
        image = modal.Image.from_registry(cfg.image).apt_install("git", "curl", "ca-certificates")
        timeout_s = max(cfg.timeout_seconds, _BUILD_TIMEOUT_FLOOR_S)

        try:
            sandbox = await modal.Sandbox.create.aio(
                app=app,
                image=image,
                timeout=timeout_s,
                cpu=cfg.cpu,
                memory=cfg.memory_mb,
                client=client,
                tags={"sandman-role": "builder", "sandman-variant": variant.value},
            )
        except modal.exception.Error as exc:
            raise SnapshotError(
                f"could not start builder sandbox from image {cfg.image!r}: {self._scrub(exc)}"
            ) from exc

        handle = SandboxHandle(
            sandbox_id=sandbox.object_id,
            variant=variant,
            region=None,
            unit_index=-1,
            state=SandboxState.PROVISIONING,
            created_at=datetime.now(UTC),
            sandbox=sandbox,
        )

        try:
            await self._checkout(handle, repo_url, revision)
            await self._run_setup(handle, cfg)
            try:
                snapshot = await sandbox.snapshot_filesystem.aio(
                    _SNAPSHOT_TIMEOUT_S, ttl=None
                )
            except modal.exception.Error as exc:
                raise SnapshotError(
                    f"filesystem snapshot failed for {revision}: {self._scrub(exc)}"
                ) from exc
            image_id = snapshot.object_id
            if not image_id:
                raise SnapshotError(f"snapshot for {revision} returned an unhydrated image")
            logger.info(
                "built base image %s for %s (%s)", image_id, revision.short_sha, cfg.image
            )
            return image_id
        finally:
            # ttl=None above: the default 30-day TTL garbage-collects the
            # snapshot, and a re-run days later would silently rebuild from a
            # ref that has since moved.
            await self.terminate(handle)

    async def _checkout(
        self, handle: SandboxHandle, repo_url: str, revision: Revision
    ) -> None:
        quoted_url = shlex.quote(repo_url)
        quoted_ref = shlex.quote(revision.ref)
        quoted_sha = shlex.quote(revision.sha)
        quoted_dir = shlex.quote(REPO_DIR)

        script = (
            f"set -euo pipefail; "
            f"git init -q {quoted_dir}; "
            f"git -C {quoted_dir} remote add origin {quoted_url}; "
            f"git -C {quoted_dir} fetch --no-tags --filter=blob:none origin {quoted_ref}; "
            # A force-push can leave the pinned commit unreachable from the ref;
            # GitHub allows fetching an exact object, so try that before failing.
            f"git -C {quoted_dir} checkout -q --detach {quoted_sha} || "
            f"{{ git -C {quoted_dir} fetch --no-tags --filter=blob:none origin {quoted_sha} && "
            f"git -C {quoted_dir} checkout -q --detach {quoted_sha}; }}"
        )
        result = await self.exec(
            handle, "bash", "-lc", script, timeout=900, env=dict(_GIT_ENV)
        )
        if not result.ok:
            raise SnapshotError(
                f"checkout of {revision} failed with exit code {result.exit_code}: "
                f"{self._scrub(_tail(result.stderr or result.stdout))}"
            )

        verify = await self.exec(
            handle,
            "git",
            "-C",
            REPO_DIR,
            "rev-parse",
            "HEAD",
            timeout=60,
            env=dict(_GIT_ENV),
        )
        if not verify.ok:
            raise SnapshotError(
                f"could not verify HEAD after checking out {revision}: "
                f"{self._scrub(_tail(verify.stderr))}"
            )
        actual = verify.stdout.strip().lower()
        if actual != revision.sha:
            raise SnapshotError(
                f"revision pin violated: {revision.ref} was expected at {revision.sha} "
                f"but the checkout resolved to {actual or '<empty>'}; refusing to build "
                "evidence from a moved ref"
            )

    async def _run_setup(self, handle: SandboxHandle, cfg: VariantConfig) -> None:
        env = self._sandbox_env(cfg)
        for command in cfg.setup_commands:
            result = await self.exec(
                handle,
                "bash",
                "-lc",
                command,
                timeout=cfg.timeout_seconds,
                workdir=REPO_DIR,
                env=env,
            )
            if not result.ok:
                raise SnapshotError(
                    f"setup command exited {result.exit_code}: "
                    f"{self._scrub(shlex.quote(command))} -> "
                    f"{self._scrub(_tail(result.stderr or result.stdout))}"
                )

    # -- fan-out -----------------------------------------------------------

    async def spawn(
        self,
        image: str | modal.Image,
        cfg: VariantConfig,
        variant: Variant,
        region: str | None = None,
        unit_index: int = 0,
    ) -> SandboxHandle:
        """Start one fan-out unit from a snapshot image."""
        client, app = await self._connect()
        base = (
            await modal.Image.from_id.aio(image, client=client)
            if isinstance(image, str)
            else image
        )

        handle = SandboxHandle(
            sandbox_id="",
            variant=variant,
            region=region,
            unit_index=unit_index,
            state=SandboxState.QUEUED,
            created_at=datetime.now(UTC),
        )
        self.mark(handle, SandboxState.PROVISIONING)

        args: Sequence[str] = tuple(cfg.startup_command)
        try:
            sandbox = await modal.Sandbox.create.aio(
                *args,
                app=app,
                image=base,
                # Modal's default sandbox timeout is 5 minutes; a longer probe
                # would otherwise be killed mid-run with no diagnostic.
                timeout=cfg.timeout_seconds,
                cpu=cfg.cpu,
                memory=cfg.memory_mb,
                region=region,
                workdir=REPO_DIR,
                env=self._sandbox_env(cfg),
                encrypted_ports=[cfg.port],
                client=client,
                tags={
                    "sandman-variant": variant.value,
                    "sandman-unit": str(unit_index),
                },
            )
        except modal.exception.Error as exc:
            self.mark(handle, SandboxState.ERROR)
            raise SandboxError(
                f"could not spawn {variant.value} unit {unit_index}"
                f"{f' in {region}' if region else ''}: {self._scrub(exc)}"
            ) from exc

        handle.sandbox = sandbox
        handle.sandbox_id = sandbox.object_id
        self.mark(handle, SandboxState.RUNNING)
        logger.debug("spawned %s", handle.label)
        return handle

    async def wait_ready(
        self, handle: SandboxHandle, cfg: VariantConfig, timeout_s: float = 180.0
    ) -> None:
        """Poll the health path over the encrypted tunnel until it answers.

        A lane whose service never came up must not produce a verdict, so this
        raises rather than letting probes run against a dead port.
        """
        url = await self.tunnel_url(handle, cfg.port)
        target = f"{url.rstrip('/')}/{cfg.health_path.lstrip('/')}"
        deadline = time.monotonic() + timeout_s
        delay = _HEALTH_POLL_INTERVAL_S
        last_error = "no response"

        timeout = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            for _ in range(_HEALTH_MAX_ATTEMPTS):
                exit_code = await self._poll_exit(handle)
                if exit_code is not None:
                    self.mark(handle, SandboxState.ERROR)
                    raise SandboxError(
                        f"{handle.label}: sandbox exited with code {exit_code} while "
                        f"waiting for {cfg.health_path}"
                    )

                retry_after: float | None = None
                try:
                    response = await client.get(target)
                except httpx.HTTPError as exc:
                    last_error = f"{type(exc).__name__}: {self._scrub(exc)}"
                else:
                    if response.status_code < 500 and response.status_code != 429:
                        logger.debug(
                            "%s healthy after %.1fs (%s)",
                            handle.label,
                            timeout_s - (deadline - time.monotonic()),
                            response.status_code,
                        )
                        return
                    last_error = f"HTTP {response.status_code}"
                    retry_after = _retry_after_seconds(response)

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                sleep_for = retry_after if retry_after is not None else delay
                await asyncio.sleep(max(0.0, min(sleep_for, remaining)))
                delay = min(delay * 1.5, _HEALTH_POLL_MAX_INTERVAL_S)

        self.mark(handle, SandboxState.TIMED_OUT)
        raise SandboxError(
            f"{handle.label}: {target} did not become healthy within {timeout_s:.0f}s "
            f"(last: {last_error})"
        )

    async def _poll_exit(self, handle: SandboxHandle) -> int | None:
        try:
            return await handle.live().poll.aio()
        except modal.exception.Error as exc:
            raise SandboxError(
                f"{handle.label}: could not poll sandbox: {self._scrub(exc)}"
            ) from exc

    # -- driving -----------------------------------------------------------

    async def exec(
        self,
        handle: SandboxHandle,
        *cmd: str,
        timeout: int | None = None,
        workdir: str | None = None,
        env: dict[str, str | None] | None = None,
    ) -> ExecResult:
        """Run a command inside the sandbox, streaming stdout and stderr."""
        if not cmd:
            raise SandboxError("exec requires at least one command argument")
        sandbox = handle.live()
        printable = shlex.join(cmd)
        started = time.perf_counter()

        try:
            process = await sandbox.exec.aio(
                *cmd, timeout=timeout, workdir=workdir, env=env, text=True
            )
        except modal.exception.Error as exc:
            raise SandboxError(
                f"{handle.label}: could not start {self._scrub(printable)}: {self._scrub(exc)}"
            ) from exc

        stdout: list[str] = []
        stderr: list[str] = []
        guard = None if timeout is None else timeout + _EXEC_GUARD_GRACE_S

        async def drain(stream: AsyncIterable[str], sink: list[str]) -> None:
            async for chunk in stream:
                sink.append(chunk)

        try:
            async with asyncio.timeout(guard):
                await asyncio.gather(
                    drain(process.stdout, stdout), drain(process.stderr, stderr)
                )
                exit_code = await process.wait.aio()
        except TimeoutError as exc:
            # modal's StreamReader.aclose has no annotated return type in the
            # shipped stubs, hence the ignores.
            with contextlib.suppress(Exception):
                await process.stdout.aclose()  # type: ignore[no-untyped-call]
            with contextlib.suppress(Exception):
                await process.stderr.aclose()  # type: ignore[no-untyped-call]
            raise ExecTimeout(
                self._scrub(printable),
                timeout or 0,
                self._scrub("".join(stdout)),
                self._scrub("".join(stderr)),
            ) from exc
        except modal.exception.Error as exc:
            raise SandboxError(
                f"{handle.label}: {self._scrub(printable)} failed: {self._scrub(exc)}"
            ) from exc

        duration_ms = (time.perf_counter() - started) * 1000.0
        if exit_code == _MODAL_DEADLINE_RETURNCODE and timeout is not None:
            raise ExecTimeout(
                self._scrub(printable),
                timeout,
                self._scrub("".join(stdout)),
                self._scrub("".join(stderr)),
            )
        return ExecResult(
            exit_code=exit_code,
            stdout=self._scrub("".join(stdout)),
            stderr=self._scrub("".join(stderr)),
            duration_ms=duration_ms,
        )

    async def tunnel_url(self, handle: SandboxHandle, port: int) -> str:
        """The public HTTPS tunnel for a port declared at spawn time."""
        cached = handle.tunnels.get(port)
        if cached is not None:
            return cached
        try:
            tunnels = await handle.live().tunnels.aio(timeout=_TUNNEL_TIMEOUT_S)
        except modal.exception.Error as exc:
            raise SandboxError(
                f"{handle.label}: tunnel metadata unavailable: {self._scrub(exc)}"
            ) from exc
        tunnel = tunnels.get(port)
        if tunnel is None:
            raise SandboxError(
                f"{handle.label}: port {port} has no tunnel; it must be listed in "
                f"encrypted_ports at spawn time (open: {sorted(tunnels)})"
            )
        url = tunnel.url
        handle.tunnels[port] = url
        return url

    async def terminate(self, handle: SandboxHandle) -> None:
        """Tear a sandbox down. Idempotent, and never raises."""
        await _terminate_handle(handle, self._secrets)


# ---------------------------------------------------------------------------
# Teardown helpers
# ---------------------------------------------------------------------------


async def _terminate_handle(
    handle: SandboxHandle, secrets: Iterable[str] = ()
) -> None:
    if handle.terminated_at is not None or handle.sandbox is None:
        handle.terminated_at = handle.terminated_at or datetime.now(UTC)
        return
    try:
        await handle.sandbox.terminate.aio()
    except Exception as exc:
        # Teardown runs in a finally block; raising here would mask the failure
        # that is actually worth reporting.
        logger.warning(
            "could not terminate %s: %s", handle.label, redact(str(exc), secrets)
        )
    finally:
        handle.terminated_at = datetime.now(UTC)


async def terminate_all(handles: Iterable[SandboxHandle]) -> None:
    """Terminate every handle concurrently, suppressing individual failures.

    Leaked sandboxes bill until their timeout, so a failure to tear one down
    must never stop the others from being torn down.
    """
    targets = list(handles)
    if not targets:
        return
    await asyncio.gather(
        *(_terminate_handle(handle) for handle in targets), return_exceptions=True
    )


@asynccontextmanager
async def sandbox_session(
    factory: SandboxFactory,
    image: str | modal.Image,
    cfg: VariantConfig,
    variant: Variant,
    region: str | None = None,
    unit_index: int = 0,
    *,
    wait_for_health: bool | None = None,
    ready_timeout_s: float = 180.0,
) -> AsyncIterator[SandboxHandle]:
    """Spawn a unit, hand it to the caller, and always tear it down.

    ``wait_for_health`` defaults to waiting whenever the variant declares a
    startup command, because that is exactly the case where probes would
    otherwise race the service's boot.
    """
    handle = await factory.spawn(image, cfg, variant, region, unit_index)
    should_wait = bool(cfg.startup_command) if wait_for_health is None else wait_for_health
    try:
        if should_wait:
            await factory.wait_ready(handle, cfg, ready_timeout_s)
        yield handle
    except BaseException:
        # An aborted lane must never be readable as a completed one.
        if not handle.state.terminal:
            factory.mark(handle, SandboxState.ERROR)
        raise
    finally:
        await factory.terminate(handle)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _retry_after_seconds(response: httpx.Response) -> float | None:
    """Parse ``Retry-After``, which is either a delay in seconds or a date."""
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    raw = raw.strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())
