# Sandman

Sandman is a differential production debugger. It replays one production-derived probe
against three isolated revisions—known-good, current, and candidate—then reports whether
the candidate actually fixes the reproduced failure.

It is deliberately not a canary deployment. A canary exposes some live traffic to a new
release; Sandman produces pre-rollout evidence in isolated, production-fidelity replicas.

## Install and adopt

Sandman is currently a CLI-first tool with a GitHub Actions integration. It is not yet a
hosted GitHub App like Greptile. Install the pinned CLI with `uv`:

```bash
uv tool install \
  "git+https://github.com/0x3ddie/sandman.git@1395ec10aa3c2efa74f42bbda81c66fadbff2f62"
sandman --help
```

To adopt it in a repository:

1. Commit a `.sandman.toml` containing the service startup contract and sanitized probes.
2. Validate it with `sandman config` before enabling cloud execution.
3. Add the Sandman GitHub Actions workflow and pin the CLI source to a reviewed commit.
4. Configure `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and optionally `OPENAI_API_KEY` as GitHub
   Actions secrets.
5. Trigger it from a deployment event, monitoring webhook, manual workflow, or trusted
   `/sandman` pull-request comment.

The CLI owns configuration, orchestration, and evidence. GitHub is the normal user interface;
Modal provides ephemeral execution; Greptile reviews the verified draft PR. A future hosted
GitHub App can automate installation and webhook setup without changing that underlying model.

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
- Sanitized incident-to-hotfix generation with the local Codex CLI
- Explicit candidate-branch publication followed by three-lane verification
- Optional shared SQLite state for restart-safe investigations and hotfix artifacts

## Run locally

```bash
uv sync
uv run sandman serve
```

Open <http://127.0.0.1:8000> and run the preloaded safe demo.

## Run from the terminal

Commit a `.sandman.toml` file that defines the service startup contract and named,
sanitized probes. Validate it before spending cloud credits:

```bash
uv run sandman config
```

Run an exact three-revision comparison locally or in CI. Every revision uses `REF@SHA`
so the evidence cannot drift while the investigation is running:

```bash
uv run sandman investigate \
  --probe checkout \
  --known-good codex/modal-known-good@3a041eabae8651bc7ed60e4adaa7cf9f1605df02 \
  --current codex/modal-current@0c7a187e36da4e24dbad487fdde7ab2299d89063 \
  --candidate codex/modal-candidate@b218110c5e94fbe8a9c1413642bd85fffb810625
```

Use `--json` for GitHub Actions or another automation consumer. The command returns zero
only when the candidate is verified as safe to review, one for a completed but unsafe
verdict, and two for configuration or execution failure.

For a sanitized incident trace, the CLI can execute the full bounded workflow. Publication
is an explicit flag because it creates a remote branch:

```bash
uv run sandman remediate \
  --trace incident.json \
  --known-good production@<40-character-commit-sha> \
  --current main@<40-character-commit-sha> \
  --branch sandman/fix-checkout \
  --test "pytest tests/test_checkout.py" \
  --publish --github-check --create-pr
```

The trace uses the same redacted `IncidentTrace` schema as `POST /api/hotfixes`. Codex never
receives the GitHub or Modal credentials; Sandman publishes only after generation and any
Codex-reported tests succeed, then verifies the exact published commit before creating a PR.

The included `Sandman production verification` workflow accepts the same named probe and
three `REF@SHA` values through `workflow_dispatch` or `workflow_call`. Configure
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` as GitHub Actions secrets. The workflow posts a
GitHub Check on the candidate commit and creates a draft PR only for a verified candidate;
the evidence-rich PR body requests Greptile review automatically.

Trusted collaborators can run the complete remediation path from a failing pull request:

```text
/sandman probe=checkout known-good=production@<40-character-commit-sha>
```

Configure `OPENAI_API_KEY` in addition to the two Modal secrets. The comment workflow
resolves the pull request head to an exact commit, runs Codex without GitHub or Modal write
credentials, transfers only a bounded validated patch into a publication job, and then
executes the normal three-lane verification. It currently accepts same-repository pull
request branches; fork pull requests are rejected because a verified stacked PR cannot use
a fork branch as its base.

For a restart-safe local control plane, set
`SANDMAN_STATE_DATABASE=.sandman/state.db`. The API and CLI share the same SQLite record
format; `sandman investigate` also accepts `--state-database`. GitHub Actions can stay
ephemeral because the published Check and draft PR are the durable CI record.

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

## Codex remediation

The remediation flow turns sanitized incident evidence into a bounded candidate patch:

1. Submit the current revision, an exact 40-character commit SHA, a `sandman/` branch name,
   and a redacted trace to `POST /api/hotfixes`.
2. Sandman clones only that revision into a disposable workspace and runs `codex exec` in
   ephemeral, workspace-write mode without GitHub or Modal credentials.
3. Sandman rejects oversized patches and changes to protected files such as credentials,
   GitHub workflows, agent instructions, and its own control directory.
4. Publish the reviewed artifact explicitly with `POST /api/hotfixes/{id}/publish`.
5. Start a normal three-lane investigation with
   `POST /api/hotfixes/{id}/investigations`; the candidate commit must reproduce the fix
   before Sandman permits a draft pull request.

Generation and publication are deliberately separate. Codex cannot push a branch, and
the GitHub token is only provided to the narrowly scoped publication step. The dashboard
shows Codex's test report, changed files, and complete patch before enabling the explicit
publish and verification actions. Artifacts with a reported failing test cannot be published.

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
                 ▲                                      │
        explicit publish                                │
                 ▲                                      │
       bounded Codex patch                              │
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
