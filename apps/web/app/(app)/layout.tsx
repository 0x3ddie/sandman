import { AppShell } from "./_shell"

/**
 * The dashboard shell.
 *
 * Only the chrome is a client component — the sidebar needs the pathname for
 * active state and local state for the collapse. `children` is passed straight
 * through, so every page underneath stays a Server Component.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1600px] px-5 py-6 xl:px-8">{children}</div>
    </AppShell>
  )
}
