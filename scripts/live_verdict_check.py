"""Live end-to-end: real Modal sandboxes, real presets, real verdicts.

The offline tests fake the sandbox layer and the live sandbox check fakes the
probes. This does neither. It builds snapshots from both pinned demo revisions,
fans out real replicas, runs the actual preset suites against them, and feeds the
results through the real verdict engine.

What it proves is the claim the whole product rests on: that the pagination
regression classifies as this rollout's fault and is eligible for a hotfix, while
the nondeterministic facet ordering -- present on both revisions -- classifies as
PRE-EXISTING and is deliberately not auto-patched.

Billable. Two variants, two replicas each, everything terminated in a finally.

    uv run python scripts/live_verdict_check.py
"""

from __future__ import annotations

import asyncio
import sys
import time

import httpx

from sandman.budget import BudgetTracker
from sandman.config import ProjectConfig, get_settings
from sandman.events import RunEventBus
from sandman.fanout import FanOutEngine, VariantPlan
from sandman.models import Classification, Revision, Variant
from sandman.sandboxes import SandboxFactory
from sandman.verdict import evaluate

REPO = "https://github.com/0x3ddie/sandman"
REPLICAS = 2


async def resolve_lkg() -> Revision:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            "https://api.github.com/repos/0x3ddie/sandman/git/ref/heads/demo/lkg"
        )
        r.raise_for_status()
        return Revision(ref="demo/lkg", sha=r.json()["object"]["sha"])


async def main() -> int:
    settings = get_settings()
    if settings.missing_for("modal"):
        print("modal unconfigured")
        return 2

    config = ProjectConfig.from_toml("sandman.toml")
    baseline = config.previous_lkg_revision()
    if baseline is None:
        print("sandman.toml does not pin previous_lkg")
        return 2
    initial = await resolve_lkg()

    # Two lanes only: there is no hotfix yet. Keep the fan-out small -- this is a
    # correctness check, not a scale demo.
    for variant in config.variants:
        config.variants[variant].replicas = REPLICAS
    config.variants[Variant.HOTFIX].enabled = False

    print(f"  B baseline  {baseline}")
    print(f"  I initial   {initial}")
    print(f"  replicas    {REPLICAS} per lane")
    print()

    bus = RunEventBus("live_verdict")
    budget = BudgetTracker(caps=config.budget)
    factory = SandboxFactory(settings, settings.sandman_modal_app_name)
    engine = FanOutEngine(factory=factory, budget=budget, bus=bus, repo_url=REPO)

    from sandman_probes import build_preset

    probes = []
    for spec in config.enabled_probes:
        if spec.preset:
            params = {**spec.params, "fanout": 1, "timeout_seconds": spec.timeout_seconds}
            probes.extend(build_preset(spec.preset, spec.id, params))
    print(f"  probes      {len(probes)} concrete probes from {len(config.enabled_probes)} suites")
    print()

    plans = [
        VariantPlan(variant=Variant.BASELINE, revision=baseline,
                    config=config.variants[Variant.BASELINE]),
        VariantPlan(variant=Variant.INITIAL, revision=initial,
                    config=config.variants[Variant.INITIAL]),
    ]

    started = time.monotonic()
    results = await engine.run_all(plans, probes)
    elapsed = time.monotonic() - started
    print(f"  {len(results)} probe executions in {elapsed:.0f}s")
    print()

    run = evaluate("live_verdict", results, require_hotfix=False, include_stable=True)

    print(f"{'probe':<46} {'B':>3} {'I':>3}  classification")
    print("-" * 82)
    for verdict in sorted(run.verdicts, key=lambda v: v.classification.severity):
        b = "ok" if verdict.baseline_passed else "FAIL"
        i = "ok" if verdict.initial_passed else "FAIL"
        print(
            f"{verdict.probe_id[:46]:<46} {b:>3} {i:>3}  "
            f"{verdict.classification.value.replace('_', ' ').upper()}"
        )

    print()
    print("counts:", run.counts())
    print(f"blocking findings:      {len(run.blocking)}")
    print(f"pre-existing findings:  {len(run.pre_existing)}")
    print(f"hotfix candidates:      {len(run.hotfix_candidates)}")
    print(f"spend: ${budget.ledger.usd_spent:.4f} of ${budget.caps.max_usd_per_run:.2f}")
    print()

    classifications = {v.classification for v in run.verdicts}

    # The regression must be attributed to this rollout and be fixable.
    caught_regression = Classification.STILL_BROKEN in classifications
    # Something must be recognised as pre-existing, or the baseline lane earned
    # nothing. (Which probe lands there depends on how the nondeterminism falls.)
    saw_stable = Classification.STABLE in classifications

    print("regression attributed to this rollout:", caught_regression)
    print("hotfix candidates are all rollout-caused:",
          all(f.classification.blames_rollout for f in run.hotfix_candidates))
    print("pre-existing findings excluded from hotfixes:",
          all(f.classification is not Classification.PRE_EXISTING
              for f in run.hotfix_candidates))
    print("some probes stable across both lanes:", saw_stable)

    ok = caught_regression and all(
        f.classification.blames_rollout for f in run.hotfix_candidates
    )
    print()
    print("live verdict check PASSED" if ok else "live verdict check FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
