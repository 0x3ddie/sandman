"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { GithubLogo, Warning } from "phosphor-react"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

const DEV_EMAIL = "dev@sandman.local"
const DEV_PASSWORD = "sandman-local-dev"
const DEV_NAME = "Local Developer"

export function SignInForm({
  githubConfigured,
  devLoginEnabled,
}: {
  githubConfigured: boolean
  devLoginEnabled: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState<"github" | "dev" | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function signInWithGitHub() {
    setPending("github")
    setError(null)
    try {
      await authClient.signIn.social({ provider: "github", callbackURL: "/dashboard" })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub sign-in failed.")
      setPending(null)
    }
  }

  /**
   * Signs in the local development account, creating it on first use. This uses
   * better-auth's real password flow rather than a forged cookie, so the session
   * behaves exactly like a GitHub one.
   */
  async function signInAsDeveloper() {
    setPending("dev")
    setError(null)
    try {
      const attempt = await authClient.signIn.email({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
      })
      if (attempt.error) {
        const created = await authClient.signUp.email({
          email: DEV_EMAIL,
          password: DEV_PASSWORD,
          name: DEV_NAME,
        })
        if (created.error) {
          throw new Error(created.error.message ?? "Could not create the local account.")
        }
      }
      router.push("/dashboard")
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Local sign-in failed.")
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={signInWithGitHub}
        disabled={!githubConfigured || pending !== null}
      >
        <GithubLogo size={16} weight="regular" />
        {pending === "github" ? "Redirecting…" : "Continue with GitHub"}
      </Button>

      {!githubConfigured && (
        <p className="text-caption flex items-start gap-2 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2.5 text-[var(--fg-tertiary)]">
          <Warning size={14} weight="regular" className="mt-px shrink-0" />
          <span>
            GitHub sign-in needs <span className="mono">GITHUB_APP_CLIENT_ID</span> and{" "}
            <span className="mono">GITHUB_APP_CLIENT_SECRET</span>. See{" "}
            <span className="mono">SETUP.md</span>.
          </span>
        </p>
      )}

      {devLoginEnabled && (
        <>
          <div className="my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-[var(--border-subtle)]" />
            <span className="text-eyebrow text-[var(--fg-quaternary)]">local only</span>
            <span className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>

          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            onClick={signInAsDeveloper}
            disabled={pending !== null}
          >
            {pending === "dev" ? "Signing in…" : "Continue as local developer"}
          </Button>
          <p className="text-caption text-center text-[var(--fg-quaternary)]">
            Enabled by <span className="mono">SANDMAN_DEV_LOGIN=1</span>; refused in production
            builds.
          </p>
        </>
      )}

      {error && (
        <p className="text-caption rounded-[6px] border border-[color-mix(in_srgb,var(--status-fail)_26%,transparent)] bg-[var(--status-fail-wash)] px-3 py-2.5 text-[var(--status-fail)]">
          {error}
        </p>
      )}
    </div>
  )
}
