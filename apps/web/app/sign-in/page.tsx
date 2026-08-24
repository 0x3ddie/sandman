import Link from "next/link"

import { SignInForm } from "./sign-in-form"

export const metadata = {
  title: "Sign in · sandman",
}

const githubConfigured = Boolean(
  process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET,
)

const devLoginEnabled =
  process.env.SANDMAN_DEV_LOGIN === "1" && process.env.NODE_ENV !== "production"

export default function SignInPage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center px-5">
      <div className="sodium-glow" aria-hidden />
      <div className="instrument-grid pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative w-full max-w-[400px]">
        <Link
          href="/"
          className="mb-8 block text-center text-[17px] font-semibold tracking-[-0.02em] text-[var(--fg-primary)]"
        >
          sandman
        </Link>

        <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 shadow-[var(--elev-2)]">
          <h1 className="text-h3 mb-1 text-[var(--fg-primary)]">Sign in</h1>
          <p className="text-body-sm mb-7 text-[var(--fg-secondary)]">
            Connect the repository whose rollouts you want probed.
          </p>

          <SignInForm githubConfigured={githubConfigured} devLoginEnabled={devLoginEnabled} />
        </div>

        <p className="text-caption mt-6 text-center text-[var(--fg-tertiary)]">
          sandman pushes hotfix branches and opens pull requests. It never writes to your LKG
          branch without a passing re-probe.
        </p>
      </div>
    </main>
  )
}
