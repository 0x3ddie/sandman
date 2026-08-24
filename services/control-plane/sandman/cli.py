"""The sandman command line.

Three things you can do without a browser:

``sandman serve``       run the control plane
``sandman check``       validate config and report what is unconfigured
``sandman investigate`` run one investigation to completion and print the verdict

``investigate`` returns a meaningful exit code so it can gate a pipeline:
0 when the rollout is safe, 1 when the investigation completed but found
something blocking, 2 when it could not run at all. That distinction matters --
a configuration error must not look like a clean rollout.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from .config import ProjectConfig, get_settings
from .models import Classification, Variant

app = typer.Typer(
    name="sandman",
    help="Pen-tests your rollout before it ships.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()

EXIT_OK = 0
EXIT_UNSAFE = 1
EXIT_ERROR = 2

#: The colours the dashboard uses, so terminal and browser agree.
VARIANT_STYLE = {
    Variant.BASELINE: "grey62",
    Variant.INITIAL: "cornflower_blue",
    Variant.HOTFIX: "orange1",
}

CLASSIFICATION_STYLE = {
    Classification.REGRESSION: "bold red",
    Classification.HOTFIX_INDUCED: "bold red",
    Classification.STILL_BROKEN: "red",
    Classification.PRE_EXISTING: "grey62",
    Classification.SELF_HEALED: "magenta",
    Classification.RESTORED: "green",
    Classification.FIXED: "green",
    Classification.STABLE: "grey42",
}


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Bind address.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port.")] = 8000,
    reload: Annotated[bool, typer.Option(help="Reload on source changes.")] = False,
) -> None:
    """Run the control plane."""
    import uvicorn

    console.print(f"[bold]sandman[/bold] control plane on http://{host}:{port}")
    uvicorn.run("sandman.api:app", host=host, port=port, reload=reload, log_level="info")


@app.command()
def check(
    config: Annotated[
        Path | None, typer.Option("--config", "-c", help="Path to sandman.toml.")
    ] = None,
) -> None:
    """Report which capabilities are configured, and validate a config if given."""
    settings = get_settings()

    table = Table(title="Capabilities", show_header=True, header_style="bold")
    table.add_column("Capability")
    table.add_column("Status")
    table.add_column("Missing")

    required = {"modal", "codex", "github"}
    blocking = 0
    for name in ("modal", "codex", "greptile", "github", "stripe", "secrets"):
        missing = settings.missing_for(name)
        ok = not missing
        if not ok and name in required:
            blocking += 1
        table.add_row(
            name,
            "[green]ready[/green]" if ok else "[yellow]unconfigured[/yellow]",
            ", ".join(missing) or "-",
        )
    console.print(table)

    if config is not None:
        try:
            project = ProjectConfig.from_toml(config)
        except Exception as exc:
            console.print(f"[red]config invalid:[/red] {exc}")
            raise typer.Exit(EXIT_ERROR) from exc

        console.print()
        console.print(f"[bold]{config}[/bold]")
        console.print(f"  repository     {project.repository_url}")
        console.print(f"  LKG branch     {project.lkg_branch}")
        console.print(
            f"  variants       {', '.join(v.value for v in project.active_variants)}"
        )
        console.print(f"  probes         {len(project.enabled_probes)}")
        console.print(f"  total fan-out  {project.total_fanout()} probe executions")
        console.print(f"  budget         ${project.budget.max_usd_per_run:.2f} per run")

    if blocking:
        console.print(
            f"\n[yellow]{blocking} required capability/capabilities unconfigured.[/yellow]"
        )
        raise typer.Exit(EXIT_ERROR)


@app.command()
def presets() -> None:
    """List the built-in probe suites."""
    from sandman_probes import describe_presets

    table = Table(show_header=True, header_style="bold")
    table.add_column("Preset", style="orange1")
    table.add_column("What it does")
    for entry in describe_presets():
        table.add_row(entry["id"], entry["description"])
    console.print(table)


@app.command()
def investigate(
    config: Annotated[Path, typer.Option("--config", "-c", help="Path to sandman.toml.")],
    as_json: Annotated[bool, typer.Option("--json", help="Machine-readable output.")] = False,
) -> None:
    """Run one investigation to completion.

    Exit code 0 when safe to promote, 1 when blocking findings remain, 2 when the
    investigation could not run.
    """
    try:
        project = ProjectConfig.from_toml(config)
    except Exception as exc:
        _fail(f"config invalid: {exc}", as_json)
        raise typer.Exit(EXIT_ERROR) from exc

    from .orchestrator import run_investigation

    try:
        outcome = asyncio.run(run_investigation(project))
    except KeyboardInterrupt:
        _fail("interrupted", as_json)
        raise typer.Exit(EXIT_ERROR) from None
    except Exception as exc:
        _fail(f"{type(exc).__name__}: {exc}", as_json)
        raise typer.Exit(EXIT_ERROR) from exc

    if as_json:
        console.print_json(json.dumps(outcome.summary()))
    else:
        _render(outcome)

    if outcome.error:
        raise typer.Exit(EXIT_ERROR)

    verdict = outcome.verification_verdict or outcome.verdict
    if verdict is None or not verdict.safe_to_promote:
        raise typer.Exit(EXIT_UNSAFE)
    raise typer.Exit(EXIT_OK)


def _render(outcome) -> None:
    console.print()
    console.rule(f"[bold]{outcome.run_id}[/bold]  ·  {outcome.state.value}")

    if outcome.revisions:
        for variant in (Variant.BASELINE, Variant.INITIAL, Variant.HOTFIX):
            revision = outcome.revisions.get(variant)
            if revision is None:
                continue
            style = VARIANT_STYLE[variant]
            console.print(
                f"  [{style}]{variant.glyph}[/{style}] {variant.value:<9} "
                f"{revision.ref}@{revision.short_sha}"
            )

    verdict = outcome.verification_verdict or outcome.verdict
    if verdict is None:
        console.print("\n[red]no verdict produced[/red]")
        if outcome.error:
            console.print(f"  {outcome.error}")
        return

    console.print()
    table = Table(show_header=True, header_style="bold", title="Verdicts")
    table.add_column("Probe")
    table.add_column("B", justify="center")
    table.add_column("I", justify="center")
    table.add_column("H", justify="center")
    table.add_column("Classification")

    for item in sorted(verdict.verdicts, key=lambda v: v.classification.severity):
        style = CLASSIFICATION_STYLE.get(item.classification, "white")
        table.add_row(
            item.probe_id,
            _mark(item.baseline_passed),
            _mark(item.initial_passed),
            _mark(item.hotfix_passed),
            f"[{style}]{item.classification.value.replace('_', ' ').upper()}[/{style}]",
        )
    console.print(table)

    if verdict.pre_existing:
        console.print(
            f"\n[grey62]{len(verdict.pre_existing)} pre-existing failure(s) carried over "
            f"from the previous rollout — reported, not auto-patched.[/grey62]"
        )

    for attempt in outcome.hotfixes:
        console.print()
        console.print(f"[bold]hotfix {attempt.id}[/bold]  {attempt.state}")
        if attempt.fix_summary:
            console.print(f"  {attempt.fix_summary}")
        if attempt.pr_url:
            console.print(f"  {attempt.pr_url}")
        if attempt.rejection_reason:
            console.print(f"  [yellow]{attempt.rejection_reason}[/yellow]")

    budget = outcome.budget or {}
    console.print()
    console.print(
        f"[grey62]spent ${budget.get('usd_spent', 0):.4f} of "
        f"${budget.get('usd_cap', 0):.2f} · "
        f"{budget.get('sandboxes_created', 0)} sandboxes · "
        f"{budget.get('elapsed_seconds', 0):.0f}s[/grey62]"
    )

    if verdict.safe_to_promote:
        console.print("\n[green]safe to promote[/green]")
    else:
        console.print(f"\n[red]{len(verdict.blocking)} blocking finding(s)[/red]")


def _mark(value: bool | None) -> str:
    if value is None:
        return "[grey42]-[/grey42]"
    return "[green]✓[/green]" if value else "[red]✗[/red]"


def _fail(message: str, as_json: bool) -> None:
    if as_json:
        json.dump({"error": message}, sys.stdout)
        sys.stdout.write("\n")
    else:
        console.print(f"[red]{message}[/red]")


if __name__ == "__main__":
    app()
