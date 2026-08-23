# sandman

**Pen-tests your rollout before it ships.**

A rollout deploys the LKG ("last known good") branch to production. sandman mirrors that exact code
path into disposable Modal sandboxes, fans probes out across many sub-sandboxes and regions, and
diffs the runtime behaviour of three revisions to answer the two questions that matter:

- **Did the fix actually work?**
- **Is this failure new, or have we been ignoring it for several rollouts?**

## The three variants

| | Variant | Revision | Answers |
|---|---|---|---|
| **B** | `BASELINE` | the *previous* LKG | what was already broken before this cut |
| **I** | `INITIAL` | the current LKG | what this rollout ships today |
| **H** | `HOTFIX` | current LKG + agent patch | whether the fix works and breaks nothing |

Every probe's three outcomes collapse into one of eight named classifications, so a three-way diff
becomes an answer rather than a table:

`RESTORED` · `FIXED` · `REGRESSION` · `HOTFIX-INDUCED` · `STILL BROKEN` · `PRE-EXISTING` ·
`SELF-HEALED` · `STABLE`

`PRE-EXISTING` is why the baseline lane exists: a failure present in the previous LKG is not what
this rollout broke, and sandman will report it without opening a hotfix for it.

## The remediation loop

```
probe fan-out → finding → Codex authors a patch (in a credential-free sandbox)
  → PR → Greptile reviews and gates → merge to a standalone branch
  → RE-PROBE that branch under full fan-out → promotion gate → LKG
```

Ownership is deliberate: **Codex authors, GitHub merges, Greptile gates.** Greptile reviews code and
can auto-approve within a risk ceiling; it cannot create, write, or merge pull requests, so nothing
in sandman asks it to.

## Safety invariants

1. **Codex never holds push capability.** Patch generation runs with no GitHub and no Modal
   credentials in its environment. Publishing a branch is a separate, narrowly-scoped step.
2. **Every revision is pinned `REF@SHA`** and verified after checkout, so evidence cannot drift
   while an investigation is running.
3. **A failed or incomplete lane can never produce a verified verdict.**
4. **Probes carry no credentials** — no auth headers, cookies, or production database access.

## Quick start

```bash
cp .env.example .env          # fill in Modal, OpenAI, Greptile, GitHub App
docker compose up -d          # Postgres on :5433
uv sync
uv run sandman serve          # control plane on :8000

cd apps/web && npm install && npm run dev    # dashboard on :3000
```

## Layout

```
services/control-plane/   FastAPI control plane: runs, fan-out, verdicts, remediation, SSE
packages/probes/          the four preset probe suites
packages/sdk/             harness for user-authored probes
apps/web/                 Next.js dashboard and marketing site
target-app/               demo service with seeded bugs
```

## Checks

```bash
uv run ruff check .
uv run mypy
uv run pytest
```
