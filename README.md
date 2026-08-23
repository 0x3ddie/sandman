# Sandman

Sandman is a differential production debugger. It replays one production-derived probe
against three isolated revisions—known-good, current, and candidate—then reports whether
the candidate actually fixes the reproduced failure.

It is deliberately not a canary deployment. A canary exposes some live traffic to a new
release; Sandman produces pre-rollout evidence in isolated, production-fidelity replicas.

## What is implemented

- Parallel three-lane investigation orchestration
- Complete verdict matrix for all pass/fail combinations
- Recursive JSON response-contract matching
- Safe local demo runtime with no cloud side effects
- Modal Sandbox runtime for public HTTPS Git repositories
- Exact commit verification when a commit SHA is supplied
- Responsive incident dashboard
- Evidence-rich GitHub draft PR creation
- Greptile configuration and targeted review handoff
- Validation that rejects credentials in repository URLs and sensitive probe headers

## Run locally

```bash
uv sync
uv run sandman
```

Open <http://127.0.0.1:8000> and run the preloaded safe demo.

## Run the checks

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

## Modal mode

Modal execution is opt-in because it creates billable cloud resources. Authenticate the
Modal CLI, switch the dashboard runtime to **Modal**, and provide:

- A public, credential-free HTTPS Git URL
- Three refs with matching commit SHAs (required for Modal investigations)
- A Debian-compatible container image
- A startup command whose process listens on the configured service port
- A health path and an idempotent probe

Each lane creates its own Sandbox, resolves the requested Git ref, verifies the optional
commit SHA, starts the service, executes the probe through an encrypted tunnel, and
terminates the Sandbox in a `finally` block.

The browser demo defaults to `python -m http.server 8000`; replace that command when using
Modal against a real service. The control plane intentionally does not accept raw secrets,
authorization headers, cookies, private repository tokens, or production database access.

## Pull requests and Greptile

Set `GITHUB_TOKEN` in the control-plane environment to enable:

```text
POST /api/investigations/{id}/pull-requests
```

The endpoint only creates a PR when the comparison verdict marks the candidate safe for
review. The generated description contains the three-lane evidence table and tags
`@greptileai` with a targeted review request. Install the Greptile GitHub App on the target
repository; `.greptile/config.json` enables reviews on drafts and updated commits.

## Architecture

```text
Incident probe
      │
      ▼
Sandman control plane
      ├── known-good ref ── isolated sandbox ──┐
      ├── current ref ───── isolated sandbox ──┼── verdict engine
      └── candidate ref ─── isolated sandbox ──┘        │
                                                        ▼
                                            evidence-backed draft PR
                                                        │
                                                        ▼
                                                Greptile review
```

## Current safety boundary

Sandman clones code and configuration shape, not customer data. Production-derived probes
must be sanitized and idempotent. Payment, email, queue, and database side effects should
terminate in test doubles or dedicated sinks before a service is eligible for replay.
