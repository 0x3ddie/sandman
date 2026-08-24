# Running sandman locally

Everything below runs on your machine. Nothing is deployed.

## 1. Prerequisites

Already present on this machine and verified: `python3` 3.13, `uv`, `node` 23, `modal` 1.5.0
(authenticated), `codex` 0.147.0 (authenticated), `gh` 2.54, Homebrew `postgresql@14`.

Two things are worth knowing:

- **Node 23 is not an LTS release** and Next 16 asks for 20, 22, or 24. It installs and typechecks,
  but if the dev server misbehaves, `nvm install 22 && nvm use 22` is the fix.
- **Greptile's CLI is not installed.** `npm i -g greptile@3.4.1` when you want headless local
  reviews. Without it the reviewer fails closed — it will never silently report an approval.

## 2. Database

Postgres is already running as a Homebrew service with the `sandman` role and database, and the
schema is applied. To recreate it from scratch:

```bash
brew services start postgresql@14
psql -h 127.0.0.1 -p 5432 -d postgres -c "CREATE ROLE sandman LOGIN PASSWORD 'sandman';"
psql -h 127.0.0.1 -p 5432 -d postgres -c "CREATE DATABASE sandman OWNER sandman;"
cd apps/web && npx drizzle-kit push --force
```

`docker-compose.yml` is the alternative if you would rather run Postgres in Docker; it maps 5433 so
the two cannot collide. Point `DATABASE_URL` at whichever you use.

## 3. GitHub

### The quick path: the token you already have

If `gh` is authenticated with `repo` scope on the target repository, that is enough. sandman
reads `GITHUB_TOKEN` and uses it directly:

```bash
echo "GITHUB_TOKEN=$(gh auth token)" >> .env
uv run sandman check          # the github row turns "ready"
uv run python scripts/live_github_check.py   # proves clone -> push -> PR -> merge
```

This is already configured on this machine and verified end to end.

### The better path: a GitHub App

A personal token works, but it is the weaker credential: it cannot be narrowed per call, does not
expire on its own, carries its owner's access to every repository they can reach, and attributes
hotfix commits to a person. An App installation token is scoped to one installation, expires in an
hour, is revocable by an org admin, and commits as `sandman[bot]`.

Worth doing before pointing sandman at anything you care about. Not required to run it.

1. Go to <https://github.com/settings/apps/new>.
2. **GitHub App name**: anything unique, e.g. `sandman-probe`.
3. **Homepage URL**: `http://localhost:3000`
4. **Callback URL**: `http://localhost:3000/api/auth/callback/github`
5. Tick **Request user authorization (OAuth) during installation.** This is what lets one App serve
   as both the login provider and the source of repository write access, so you never need a second
   OAuth app.
6. Untick **Webhook → Active** (nothing local needs to receive one).
7. **Repository permissions**:
   - Contents: **Read and write** (push the hotfix branch)
   - Pull requests: **Read and write** (open and merge the PR)
   - Checks: **Read and write** (post the verdict as a check)
   - Metadata: Read-only (implied)
8. Create the app, then **Generate a private key** and download the `.pem`.
9. **Install** the app on `0x3ddie/sandman`.

Then add to `.env` at the repo root:

```bash
GITHUB_APP_ID=<the numeric App ID>
GITHUB_APP_CLIENT_ID=<Iv1....>
GITHUB_APP_CLIENT_SECRET=<generated on the app page>
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/the-downloaded-key.pem
```

Confirm it took:

```bash
uv run sandman check      # github: ready, and `github_auth_mode` becomes "app"
```

When both are present the App wins; `GITHUB_TOKEN` is only the fallback.

## 4. Greptile

Install the [Greptile GitHub App](https://github.com/apps/greptile-apps) on the same repository.
`GREPTILE_API_KEY` is already in `.env`.

`.greptile/config.json` and `.greptile/rules.md` are written onto every hotfix branch automatically
— an ephemeral branch has to carry its own config or the review runs with defaults instead of
sandman's rules.

Worth knowing before you pick a demo bug: **Greptile never auto-approves changes touching auth,
secrets, billing, database migrations, infrastructure, or CI**, whatever the config says. The seeded
demo defect lives in catalog pagination precisely so it stays approvable.

## 5. Stripe (optional)

Billing is written and inactive. It turns on when these exist:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...        # from `stripe listen --forward-to localhost:3000/api/billing/webhook`
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

Test mode costs nothing and `4242 4242 4242 4242` works. The "$500 credit" is a processing-fee
waiver on live volume — it is irrelevant to a test-mode demo, which is free regardless.

## 6. Run it

Two processes:

```bash
uv run sandman serve                 # control plane on :8000
cd apps/web && npm run dev           # dashboard on :3000
```

The dashboard proxies `/cp/*` to the control plane, so a long fan-out streams over SSE without a
request deadline in the way.

## 7. Verify

```bash
uv run ruff check . && uv run mypy && uv run pytest    # 109 tests
uv run sandman check --config sandman.toml            # config + capabilities
uv run python scripts/live_sandbox_check.py           # REAL Modal sandboxes, costs a few cents
uv run sandman investigate --config sandman.toml      # the full loop (needs the GitHub App)
```

`live_sandbox_check.py` is the one that proves the hard part: it builds snapshots from both pinned
demo revisions, boots them, and shows the regression reproducing — baseline 200 everywhere, LKG 500
on the last page and on an empty result.

`investigate` exits 0 when the rollout is safe, 1 when it ran and found something blocking, and 2
when it could not run at all. That third code matters: a configuration error must never be mistaken
for a clean rollout.

## What a run costs

Defaults are deliberately conservative — 25 concurrent sandboxes, 8 concurrent model calls, $5 per
run, all overridable in `sandman.toml`. Two independent ceilings, because two different resources
are scarce: Modal's container quota, and OpenAI's rate limit, which is per *organisation* — every
sandbox shares one bucket through a single key, so fanning out wider buys 429s, not throughput.

`uv run sandman check --config sandman.toml` prints the projected worst case before you spend it.
