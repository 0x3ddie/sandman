"""Live check: the publication half of the remediation loop.

Exercises exactly what the orchestrator does once Codex hands back a patch:
clone the pinned revision, apply the change, commit, push a branch, open a pull
request, and merge it into a standalone branch. Greptile is not involved -- this
is the mechanism, not the gate.

It drives the real adapter rather than reimplementing git, which is the point:
an earlier version of this script hand-rolled the push with an
``Authorization: Bearer`` header and failed, while the adapter (which uses a git
credential helper) was correct all along. A self-check that does not exercise the
shipping code path can only test itself.

Everything it creates is deleted at the end.

    uv run python scripts/live_github_check.py
"""

from __future__ import annotations

import asyncio
import sys
import uuid

from sandman.config import ProjectConfig, get_settings
from sandman.github import GitHubApp, GitHubClient, GitHubError, clone_workspace
from sandman.models import Revision

FIX_BEFORE = "    has_more = page[limit] is not None"
FIX_AFTER = "    has_more = len(page) > limit"


async def main() -> int:
    settings = get_settings()
    print(f"github auth mode: {settings.github_auth_mode}")
    if settings.github_auth_mode == "none":
        print("no GitHub credential; set GITHUB_TOKEN or configure an App")
        return 2

    config = ProjectConfig.from_toml("sandman.toml")
    owner, repo = "0x3ddie", "sandman"
    suffix = uuid.uuid4().hex[:8]
    hotfix_branch = f"{config.hotfix_branch_prefix}-selfcheck-{suffix}"
    standalone = f"sandman/verify-selfcheck-{suffix}"

    app = GitHubApp(settings)
    token = await app.token_for(owner, repo)
    client = GitHubClient(token.token)
    created: list[str] = []
    pr_number: int | None = None

    try:
        base_sha = await client.get_branch_sha(owner, repo, config.lkg_branch)
        print(f"base {config.lkg_branch}@{base_sha[:12]}")

        # The standalone branch is the merge target. LKG is never touched here: a
        # hotfix reaches it only after the merged branch re-probes clean.
        await client.create_branch(owner, repo, standalone, base_sha)
        created.append(standalone)
        print(f"created standalone branch {standalone}")

        revision = Revision(ref=config.lkg_branch, sha=base_sha)
        async with clone_workspace(
            config.repository_url, revision, token=token.token
        ) as workspace:
            target = workspace.path / "target-app" / "main.py"
            source = target.read_text()
            if FIX_BEFORE not in source:
                print(f"expected line not present in {config.lkg_branch}")
                return 2
            target.write_text(source.replace(FIX_BEFORE, FIX_AFTER))

            await workspace.create_branch(hotfix_branch)
            head_sha = await workspace.commit_all(
                "fix: guard the pagination look-ahead\n\n"
                "Self-check of the sandman publication path.",
                "sandman[bot]",
                "sandman[bot]@users.noreply.github.com",
            )
            await workspace.push(hotfix_branch, token.token)
            created.append(hotfix_branch)
            print(f"pushed {hotfix_branch}@{head_sha[:12]}")

        pr = await client.create_pull_request(
            owner,
            repo,
            head=hotfix_branch,
            base=standalone,
            title="sandman self-check: publication path",
            body=(
                "Automated self-check of the sandman publication path.\n\n"
                "The patch was authored in a separate step by an agent holding no "
                "repository credentials; the control plane published it here as a "
                "narrowly scoped action. Merged into a standalone branch, never "
                "into LKG, and cleaned up automatically."
            ),
            draft=False,
        )
        pr_number = pr.number
        print(f"opened PR #{pr.number} -> {pr.html_url}")

        merged = await client.merge_pull_request(
            owner,
            repo,
            pr.number,
            method="squash",
            commit_title=f"sandman self-check {suffix}",
        )
        pr_number = None  # merging closes it
        print(f"merged into {standalone} as {merged[:12]}")

        lkg_after = await client.get_branch_sha(owner, repo, config.lkg_branch)
        print(f"standalone now {(await client.get_branch_sha(owner, repo, standalone))[:12]}")
        print(f"LKG {config.lkg_branch} still {lkg_after[:12]} (untouched)")
        if lkg_after != base_sha:
            print("FAILED: the LKG branch moved; it must not be touched by this path")
            return 1

        print()
        print("live github check PASSED: clone, commit, push, PR, and merge all work")
        return 0

    except GitHubError as exc:
        print(f"FAILED: {exc}")
        return 1
    finally:
        if pr_number is not None:
            print(f"note: PR #{pr_number} is still open; close it manually")
        for branch in reversed(created):
            try:
                await client.delete_branch(owner, repo, branch)
                print(f"cleaned up {branch}")
            except Exception as exc:
                print(f"could not delete {branch}: {exc}")
        await client.aclose()
        await app.aclose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
