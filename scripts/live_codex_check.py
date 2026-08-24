"""Live check: can Codex actually author the hotfix?

Clones the real demo/lkg revision into a disposable workspace, hands Codex the
finding the probes produced, and inspects what comes back. Nothing is pushed --
this stops at the patch, which is exactly where the safety boundary sits: the
patch author runs with no GitHub and no Modal credentials, and publishing is a
separate step that never happens here.

What it proves:
  * the child environment really is credential-free
  * codex exec produces a non-empty diff against a real repository
  * the diff survives patch validation (size cap, protected paths, no secrets)
  * the fix is correct -- the patched file is executed and the regression is gone

    uv run python scripts/live_codex_check.py
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path

from sandman.codex import CodexRunner, PatchRejected, build_child_env, validate_patch
from sandman.config import ProjectConfig, get_settings

FINDING = """A production-rollout probe found a regression in the catalog service.

Probe: catalog-fuzz:pagination:api.catalog.search
Classification: still_broken

GET /api/catalog/search returns HTTP 500 with an IndexError whenever the
requested page reaches the end of the result set. Reproduces with
`?limit=20&offset=230` (240 items total) and with any query matching fewer
results than `limit`, including a query matching nothing at all.

The previous rollout answered 200 for all of those, so this cut introduced it.

Fix the root cause in target-app/main.py with the smallest correct change.
Do not modify CI configuration, credentials, or agent instructions.
"""


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)


async def main() -> int:
    settings = get_settings()
    if not settings.codex_key and not (Path.home() / ".codex" / "auth.json").is_file():
        print("codex unconfigured")
        return 2

    # Invariant 1, asserted before anything runs.
    env = build_child_env(settings.codex_key or "sk-placeholder")
    leaked = [
        k for k in env
        if k in {"GITHUB_TOKEN", "GH_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET",
                 "GREPTILE_API_KEY", "STRIPE_SECRET_KEY", "SANDMAN_KEK", "DATABASE_URL"}
    ]
    print(f"child env keys: {sorted(env)}")
    print(f"credentials leaked into it: {leaked or 'none'}")
    if leaked:
        print("FAILED: the patch author would hold publishing capability")
        return 1
    print()

    config = ProjectConfig.from_toml("sandman.toml")

    with tempfile.TemporaryDirectory(prefix="sandman-codex-") as tmp:
        workspace = Path(tmp) / "repo"
        print("cloning demo/lkg ...")
        clone = run(
            ["git", "clone", "--depth", "1", "--branch", "demo/lkg",
             config.repository_url, str(workspace)],
            Path(tmp),
        )
        if clone.returncode != 0:
            print("clone failed:", clone.stderr[-400:])
            return 2

        target = workspace / "target-app" / "main.py"
        before = target.read_text()
        print(f"cloned at {run(['git', 'rev-parse', 'HEAD'], workspace).stdout.strip()[:12]}")
        print()

        print("running codex exec (this authors a real patch) ...")
        runner = CodexRunner(settings)
        result = await runner.author_patch(
            workdir=workspace,
            prompt=FINDING,
            model=settings.sandman_model_hotfix,
            timeout_s=600,
        )

        print(f"exit code:      {result.exit_code}")
        print(f"duration:       {result.duration_ms / 1000:.0f}s")
        print(f"files changed:  {result.files_changed}")
        if result.verdict is not None:
            print(f"root cause:     {result.verdict.root_cause[:160]}")
            print(f"fix summary:    {result.verdict.fix_summary[:160]}")
            print(f"tests passed:   {result.verdict.tests_passed}")
            print(f"confidence:     {result.verdict.confidence}")
        print()

        if not result.diff.strip():
            print("FAILED: codex produced no diff")
            return 1

        print("--- diff ---")
        print("\n".join(result.diff.splitlines()[:60]))
        print()

        try:
            validate_patch(result.diff, result.files_changed, config.promotion)
            print("patch validation: accepted")
        except PatchRejected as exc:
            print(f"patch validation: REJECTED -- {exc}")
            return 1

        after = target.read_text()
        if after == before:
            print("FAILED: target file is unchanged on disk")
            return 1

        # The claim that matters is behavioural, not textual: execute the patched
        # file and confirm the regression is actually gone.
        print()
        print("executing the patched service ...")
        check = run(
            [sys.executable, "-c", (
                "import sys; sys.path.insert(0, 'target-app');"
                "from fastapi.testclient import TestClient;"
                "from main import app;"
                "c = TestClient(app, raise_server_exceptions=False);"
                "cases = {"
                "  'last page': c.get('/api/catalog/search', params={'limit':20,'offset':230}).status_code,"
                "  'no match': c.get('/api/catalog/search', params={'q':'zzzz'}).status_code,"
                "  'page 1': c.get('/api/catalog/search', params={'limit':20,'offset':0}).status_code,"
                "  'mid page': c.get('/api/catalog/search', params={'limit':20,'offset':100}).status_code,"
                "};"
                "print(cases);"
                "sys.exit(0 if all(v == 200 for v in cases.values()) else 1)"
            )],
            workspace,
        )
        print(check.stdout.strip() or check.stderr.strip()[-400:])

        if check.returncode != 0:
            print()
            print("FAILED: the patch did not resolve the regression")
            return 1

    print()
    print("live codex check PASSED: credential-free author produced a verified fix")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
