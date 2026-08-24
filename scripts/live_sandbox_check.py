"""Live check: build, snapshot, clone, and probe two real Modal sandboxes.

This exercises the one part of sandman that cannot be tested offline -- the
Modal sandbox layer -- against the two real demo branches. It deliberately does
not touch GitHub, Codex, or Greptile: the point is to prove that a snapshot
built from a pinned revision boots, serves, and answers probes differently on
each branch.

It creates billable cloud resources, so it stays small: one replica per variant,
short timeouts, everything terminated in a finally block.

    uv run python scripts/live_sandbox_check.py
"""

from __future__ import annotations

import asyncio
import sys
import time

from sandman.config import ProjectConfig, VariantConfig, get_settings
from sandman.models import Revision, Variant
from sandman.sandboxes import SandboxFactory, terminate_all

REPO = "https://github.com/0x3ddie/sandman"


def variant_config() -> VariantConfig:
    return VariantConfig(
        image="python:3.12-slim",
        setup_commands=["pip install --no-cache-dir -r requirements.txt"],
        startup_command=["python", "target-app/main.py"],
        port=8000,
        health_path="/health",
        replicas=1,
        cpu=1.0,
        memory_mb=1024,
        timeout_seconds=600,
    )


async def main() -> int:
    settings = get_settings()
    missing = settings.missing_for("modal")
    if missing:
        print(f"modal unconfigured, missing: {', '.join(missing)}")
        return 2

    config = ProjectConfig.from_toml("sandman.toml")
    baseline = config.previous_lkg_revision()
    if baseline is None:
        print("sandman.toml does not pin previous_lkg")
        return 2

    import httpx

    # The repo is public, so an unauthenticated read is enough to pin the LKG.
    async with httpx.AsyncClient(timeout=20) as probe_client:
        resp = await probe_client.get(
            "https://api.github.com/repos/0x3ddie/sandman/git/ref/heads/demo/lkg"
        )
        resp.raise_for_status()
        lkg_sha = resp.json()["object"]["sha"]

    initial = Revision(ref="demo/lkg", sha=lkg_sha)
    revisions = {Variant.BASELINE: baseline, Variant.INITIAL: initial}

    print(f"  B baseline  {baseline}")
    print(f"  I initial   {initial}")
    print()

    factory = SandboxFactory(settings, settings.sandman_modal_app_name)
    cfg = variant_config()
    handles = []
    results: dict[Variant, dict[str, int]] = {}

    try:
        for variant, revision in revisions.items():
            started = time.monotonic()
            print(f"[{variant.glyph}] building snapshot for {revision.ref}@{revision.short_sha} ...")
            image = await factory.build_base(cfg, REPO, revision, variant=variant)
            print(f"[{variant.glyph}] snapshot ready in {time.monotonic() - started:.0f}s")

            handle = await factory.spawn(image, cfg, variant, region=None, unit_index=0)
            handles.append(handle)
            await factory.wait_ready(handle, cfg, timeout_s=240)
            url = await factory.tunnel_url(handle, cfg.port)
            print(f"[{variant.glyph}] serving at {url}")

            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                observed: dict[str, int] = {}
                for name, params in (
                    ("page 1", {"limit": 20, "offset": 0}),
                    ("mid page", {"limit": 20, "offset": 100}),
                    ("last page", {"limit": 20, "offset": 230}),
                    ("no match", {"q": "zzzz-no-such-thing"}),
                ):
                    r = await client.get(f"{url}/api/catalog/search", params=params)
                    observed[name] = r.status_code
                results[variant] = observed
            print(f"[{variant.glyph}] {observed}")
            print()
    finally:
        print("terminating sandboxes ...")
        await terminate_all(handles)

    print()
    print(f"{'case':<12} {'B baseline':>11} {'I initial':>10}   verdict")
    ok = True
    for case in ("page 1", "mid page", "last page", "no match"):
        b = results.get(Variant.BASELINE, {}).get(case)
        i = results.get(Variant.INITIAL, {}).get(case)
        if case in ("last page", "no match"):
            good = b == 200 and i == 500
            verdict = "REGRESSION FOUND" if good else "unexpected"
        else:
            good = b == 200 and i == 200
            verdict = "stable" if good else "unexpected"
        ok = ok and good
        print(f"{case:<12} {b!s:>11} {i!s:>10}   {verdict}")

    print()
    if ok:
        print("live check passed: the regression reproduces in real Modal sandboxes")
        return 0
    print("live check FAILED: observed statuses did not match the expected pattern")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
