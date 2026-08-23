from __future__ import annotations

import sys
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest

from sandman.models import InvestigationRequest, Lane, Revision, RuntimeName
from sandman.runtime import ModalSandboxRuntime


class FakeApp:
    @staticmethod
    def lookup(name: str, *, create_if_missing: bool) -> object:
        assert name == "sandman-test"
        assert create_if_missing is True
        return object()


class FakeImage:
    @classmethod
    def from_registry(cls, name: str) -> FakeImage:
        assert name == "python:3.12-slim"
        return cls()

    def apt_install(self, *packages: str) -> FakeImage:
        assert packages == ("git", "ca-certificates")
        return self


class FakeSandbox:
    object_id = "sb-test"

    def __init__(self) -> None:
        self.terminated = False
        self.detached = False

    def tunnels(self, *, timeout: int) -> dict[int, object]:
        assert timeout == 45
        raise RuntimeError("simulated startup failure")

    def terminate(self, *, wait: bool) -> None:
        assert wait is True
        self.terminated = True

    def detach(self) -> None:
        self.detached = True


class FakeSandboxFactory:
    created: ClassVar[FakeSandbox | None] = None
    arguments: ClassVar[tuple[str, ...]] = ()
    options: ClassVar[dict[str, Any]] = {}

    @classmethod
    def create(cls, *arguments: str, **options: Any) -> FakeSandbox:
        cls.arguments = arguments
        cls.options = options
        cls.created = FakeSandbox()
        return cls.created


def test_modal_runtime_caps_resources_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_modal = SimpleNamespace(App=FakeApp, Image=FakeImage, Sandbox=FakeSandboxFactory)
    monkeypatch.setitem(sys.modules, "modal", fake_modal)
    runtime = ModalSandboxRuntime("sandman-test", startup_timeout_seconds=45)
    request = modal_request()

    result = runtime.probe(request, request.revisions[0])

    assert result.observation.passed is False
    assert "simulated startup failure" in (result.observation.error or "")
    assert FakeSandboxFactory.options["cpu"] == (1.0, 2.0)
    assert FakeSandboxFactory.options["memory"] == (1_024, 2_048)
    assert FakeSandboxFactory.options["timeout"] == 45
    assert FakeSandboxFactory.options["tags"] == {"sandman_lane": "known_good"}
    assert FakeSandboxFactory.created is not None
    assert FakeSandboxFactory.created.terminated is True
    assert FakeSandboxFactory.created.detached is True


@pytest.mark.parametrize(
    ("options", "message"),
    (
        ({"cpu_request": 1.0, "cpu_limit": 0.5}, "CPU limit"),
        ({"memory_request_mib": 1_024, "memory_limit_mib": 512}, "memory limit"),
        ({"startup_timeout_seconds": 0}, "startup timeout"),
    ),
)
def test_modal_runtime_rejects_invalid_limits(options: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        ModalSandboxRuntime("sandman-test", **options)


def modal_request() -> InvestigationRequest:
    revisions = tuple(
        Revision(
            lane=lane,
            git_ref="main",
            commit_sha="a" * 40,
            label=lane.value,
        )
        for lane in Lane
    )
    return InvestigationRequest(
        repository_url="https://github.com/example/service",
        revisions=revisions,  # type: ignore[arg-type]
        runtime=RuntimeName.MODAL,
    )
