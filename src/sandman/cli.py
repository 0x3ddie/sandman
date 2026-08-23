from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO

import uvicorn
from pydantic import ValidationError

from sandman.github import (
    GitHubCheckPublisher,
    GitHubPullRequestPublisher,
    PullRequestRequest,
    github_repository_from_url,
)
from sandman.models import InvestigationReport, Lane, Revision, RuntimeName
from sandman.project import load_project_config
from sandman.runtime import DemoSandboxRuntime, ModalSandboxRuntime
from sandman.service import InvestigationService, InvestigationStore


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if arguments.command is None:
        parser.print_help()
        return 0
    if arguments.command == "serve":
        uvicorn.run(
            "sandman.api:app",
            host=arguments.host,
            port=arguments.port,
            reload=False,
        )
        return 0
    if arguments.command == "config":
        return _validate_config(arguments.config, sys.stdout, sys.stderr)
    if arguments.command == "investigate":
        return _investigate(arguments, sys.stdout, sys.stderr)
    parser.error(f"unknown command: {arguments.command}")
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sandman",
        description="Prove production fixes across isolated revisions.",
    )
    commands = parser.add_subparsers(dest="command")

    serve = commands.add_parser("serve", help="run the local API and evidence viewer")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)

    config = commands.add_parser("config", help="validate repository configuration")
    config.add_argument("--config", type=Path, default=Path(".sandman.toml"))

    investigate = commands.add_parser("investigate", help="run the three revision lanes")
    investigate.add_argument("--config", type=Path, default=Path(".sandman.toml"))
    investigate.add_argument("--probe", required=True, help="named probe from .sandman.toml")
    investigate.add_argument(
        "--known-good", required=True, metavar="REF@SHA", help="deployed known-good revision"
    )
    investigate.add_argument(
        "--current", required=True, metavar="REF@SHA", help="current failing revision"
    )
    investigate.add_argument(
        "--candidate", required=True, metavar="REF@SHA", help="candidate hotfix revision"
    )
    investigate.add_argument("--runtime", choices=tuple(RuntimeName), default=None)
    investigate.add_argument("--json", action="store_true", dest="json_output")
    investigate.add_argument(
        "--github-check", action="store_true", help="publish the verdict as a GitHub Check"
    )
    investigate.add_argument(
        "--create-pr",
        action="store_true",
        help="create a verified draft PR and request Greptile review",
    )
    investigate.add_argument("--pr-base", help="PR base branch; defaults to the current ref")
    investigate.add_argument("--pr-title", help="draft PR title")
    return parser


def _validate_config(path: Path, stdout: TextIO, stderr: TextIO) -> int:
    try:
        config = load_project_config(path)
    except (OSError, ValueError, ValidationError) as error:
        print(f"sandman: {error}", file=stderr)
        return 2
    probe_names = ", ".join(sorted(config.probes))
    print(f"Valid Sandman config · probes: {probe_names}", file=stdout)
    return 0


def _investigate(arguments: argparse.Namespace, stdout: TextIO, stderr: TextIO) -> int:
    try:
        config = load_project_config(arguments.config)
        revisions = (
            _parse_revision(Lane.KNOWN_GOOD, arguments.known_good, "Known good"),
            _parse_revision(Lane.CURRENT, arguments.current, "Current"),
            _parse_revision(Lane.CANDIDATE, arguments.candidate, "Candidate"),
        )
        runtime = RuntimeName(arguments.runtime) if arguments.runtime else config.runtime
        request = config.build_investigation(
            revisions=revisions,
            probe_name=arguments.probe,
            runtime=runtime,
        )
    except (OSError, ValueError, ValidationError) as error:
        print(f"sandman: {error}", file=stderr)
        return 2

    store = InvestigationStore()
    sandbox_runtime = (
        DemoSandboxRuntime()
        if runtime is RuntimeName.DEMO
        else ModalSandboxRuntime(config.modal_app_name)
    )
    service = InvestigationService({runtime: sandbox_runtime}, store)
    record = service.enqueue(request)
    asyncio.run(service.execute(record.investigation_id, request))
    completed = store.get(record.investigation_id)
    if completed is None or completed.report is None:
        message = completed.error if completed is not None else "investigation disappeared"
        print(f"sandman: {message or 'investigation failed'}", file=stderr)
        return 2
    if arguments.json_output:
        print(completed.model_dump_json(indent=2), file=stdout)
    else:
        _print_report(completed.report, stdout)
    try:
        _publish_github_outputs(arguments, completed.report, stdout)
    except (RuntimeError, ValueError) as error:
        print(f"sandman: {error}", file=stderr)
        return 2
    return 0 if completed.report.verdict.safe_to_review else 1


def _parse_revision(lane: Lane, value: str, label: str) -> Revision:
    try:
        git_ref, commit_sha = value.rsplit("@", maxsplit=1)
    except ValueError as error:
        raise ValueError(f"{lane.value} must use REF@SHA format") from error
    if not git_ref or len(commit_sha) != 40:
        raise ValueError(f"{lane.value} must include a full 40-character commit SHA")
    return Revision(lane=lane, git_ref=git_ref, commit_sha=commit_sha, label=label)


def _print_report(report: InvestigationReport, stdout: TextIO) -> None:
    print(f"Sandman · {report.verdict.headline}", file=stdout)
    for result in report.results:
        observation = result.observation
        marker = "PASS" if observation.passed else "FAIL"
        status = observation.status_code if observation.status_code is not None else "ERR"
        print(
            f"  {marker:4}  {result.lane.value:10}  HTTP {status}  "
            f"{observation.duration_ms} ms  {result.revision.git_ref}",
            file=stdout,
        )
    print(f"Verdict: {report.verdict.kind.value}", file=stdout)
    print(report.verdict.detail, file=stdout)


def _publish_github_outputs(
    arguments: argparse.Namespace,
    report: InvestigationReport,
    stdout: TextIO,
) -> None:
    if not arguments.github_check and not arguments.create_pr:
        return
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required for GitHub reporting")
    repository = github_repository_from_url(report.request.repository_url)
    candidate = next(
        revision for revision in report.request.revisions if revision.lane is Lane.CANDIDATE
    )
    current = next(
        revision for revision in report.request.revisions if revision.lane is Lane.CURRENT
    )
    if candidate.commit_sha is None:
        raise RuntimeError("candidate commit SHA is required for GitHub reporting")
    if arguments.github_check:
        check = GitHubCheckPublisher(token).create(repository, candidate.commit_sha, report)
        print(f"GitHub Check: {check.url}", file=stdout)
    if not arguments.create_pr:
        return
    if not report.verdict.safe_to_review:
        print("Draft PR skipped: candidate is not verified", file=stdout)
        return
    pull_request = GitHubPullRequestPublisher(token).create(
        PullRequestRequest(
            owner=repository.owner,
            repository=repository.repository,
            head=candidate.git_ref,
            base=arguments.pr_base or current.git_ref,
            title=arguments.pr_title or f"fix: {report.verdict.headline.lower()}",
            draft=True,
        ),
        report,
    )
    print(f"Draft PR: {pull_request.url}", file=stdout)
