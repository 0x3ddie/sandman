"use client"

import * as React from "react"
import { ArrowSquareOut, GithubLogo, Plugs } from "phosphor-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { connectRepository, saveRepoSettings } from "../_actions"
import { ActionForm, HiddenValue, SubmitButton, Toggle } from "../_controls"
import {
  Callout,
  Chip,
  Field,
  Mono,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Select,
  TextInput,
} from "../_ui"

export interface RepositoryOption {
  fullName: string
  defaultBranch: string
  private: boolean
}

export interface InstallationOption {
  id: number
  login: string
  accountType: string
  repositories: RepositoryOption[]
}

/* ---------------------------------------------------------------------------
 * Connection
 * ------------------------------------------------------------------------ */

export function ConnectRepository({
  installations,
  installUrl,
  connected,
  disabled,
}: {
  installations: InstallationOption[]
  installUrl: string
  connected: {
    projectId: string
    repositoryFullName: string
    installationId: number | null
    repositoryUrl: string
  } | null
  disabled: boolean
}) {
  const initialInstallation =
    installations.find((entry) => entry.id === connected?.installationId) ?? installations[0]

  const [installationId, setInstallationId] = React.useState<number | null>(
    initialInstallation?.id ?? null,
  )
  const [repository, setRepository] = React.useState<string>(() => {
    // Only pre-select the connected repository when it is actually one of this
    // installation's — otherwise the select would show a value it has no option
    // for, and submit an empty string.
    const known = initialInstallation?.repositories.some(
      (repo) => repo.fullName === connected?.repositoryFullName,
    )
    return known && connected
      ? connected.repositoryFullName
      : (initialInstallation?.repositories[0]?.fullName ?? "")
  })

  const installation = installations.find((entry) => entry.id === installationId) ?? installations[0]
  const options = installation?.repositories ?? []
  const selected = options.find((repo) => repo.fullName === repository) ?? options[0]

  if (installations.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {connected ? <ConnectedSummary connected={connected} /> : null}
        <div className="flex items-center justify-between gap-4 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-4 py-3.5">
          <div className="flex items-center gap-3">
            <GithubLogo size={16} weight="regular" color="var(--fg-tertiary)" aria-hidden />
            <div>
              <p className="text-label text-[var(--fg-primary)]">
                {connected ? "No live installation found" : "Install the sandman GitHub App"}
              </p>
              <p className="text-body-sm text-[var(--fg-tertiary)]">
                Installing also signs you in — the App requests user authorization during install,
                so one grant covers both.
              </p>
            </div>
          </div>
          <Button asChild variant="primary" size="md" className={disabled ? "pointer-events-none opacity-40" : undefined}>
            <a href={installUrl} rel="noreferrer">
              Install on GitHub
              <ArrowSquareOut size={16} weight="regular" aria-hidden />
            </a>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {connected ? <ConnectedSummary connected={connected} /> : null}

      <ActionForm action={connectRepository} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Installation" hint="Where the App is installed.">
            <Select
              name="installationAccount"
              value={String(installationId ?? "")}
              onChange={(event) => {
                const next = Number(event.target.value)
                setInstallationId(next)
                const first = installations.find((entry) => entry.id === next)?.repositories[0]
                setRepository(first?.fullName ?? "")
              }}
            >
              {installations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.login} · {entry.accountType.toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Repository"
            hint={
              options.length === 0
                ? "This installation has no repositories granted. Adjust the App's repository access on GitHub."
                : "Only repositories granted to the installation appear here."
            }
          >
            <Select
              name="repositoryFullName"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              disabled={options.length === 0}
            >
              {options.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                  {repo.private ? " · private" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <HiddenValue name="installationId" value={String(installationId ?? "")} />
        <HiddenValue name="defaultBranch" value={selected?.defaultBranch ?? "main"} />

        <div className="flex items-center justify-between gap-3">
          <p className="text-caption text-[var(--fg-tertiary)]">
            The repository&rsquo;s default branch becomes the initial LKG branch; change it below.
          </p>
          <SubmitButton pendingLabel="Connecting…">
            {connected ? "Change repository" : "Connect repository"}
          </SubmitButton>
        </div>
      </ActionForm>
    </div>
  )
}

function ConnectedSummary({
  connected,
}: {
  connected: { repositoryFullName: string; installationId: number | null; repositoryUrl: string }
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[8px] border border-[rgb(63_214_140_/_0.28)] bg-[var(--status-pass-wash)] px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Plugs size={16} weight="regular" color="var(--status-pass)" aria-hidden />
        <div className="min-w-0">
          <p className="text-caption text-[var(--fg-tertiary)]">Connected</p>
          <Mono className="block truncate text-[13px]">{connected.repositoryFullName}</Mono>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {connected.installationId ? (
          <Chip color="var(--status-pass)">installation {connected.installationId}</Chip>
        ) : null}
        <Button asChild variant="ghost" size="sm">
          <a href={connected.repositoryUrl} target="_blank" rel="noreferrer">
            Open
            <ArrowSquareOut size={16} weight="regular" aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Rollout definition
 * ------------------------------------------------------------------------ */

export function RolloutSettings({
  projectId,
  lkgBranch,
  branches,
  previousLkgMode,
  previousLkgRef,
  hotfixBranchPrefix,
  autoPromote,
}: {
  projectId: string
  lkgBranch: string
  branches: string[]
  previousLkgMode: "auto" | "pinned"
  previousLkgRef: string
  hotfixBranchPrefix: string
  autoPromote: boolean
}) {
  const [mode, setMode] = React.useState<"auto" | "pinned">(previousLkgMode)

  return (
    <ActionForm action={saveRepoSettings}>
      <HiddenValue name="projectId" value={projectId} />

      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">Rollout definition</span>}
          description="Which revision this rollout ships, and which one it is measured against."
        />
        <PanelBody>
          <Field
            label="LKG branch"
            htmlFor="lkgBranch"
            hint="The last-known-good branch. Its head is the INITIAL variant — the code this rollout ships."
          >
            {branches.length > 0 ? (
              <Select id="lkgBranch" name="lkgBranch" defaultValue={lkgBranch}>
                {(branches.includes(lkgBranch) ? branches : [lkgBranch, ...branches]).map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                id="lkgBranch"
                name="lkgBranch"
                defaultValue={lkgBranch}
                className="mono text-[12.5px]"
                spellCheck={false}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-label mb-1.5 text-[var(--fg-secondary)]">
              Previous LKG resolution
            </legend>
            <p className="text-caption -mt-1 mb-1 max-w-[64ch] text-[var(--fg-tertiary)]">
              The BASELINE variant. It exists so a failure that was already broken before this cut is
              reported as pre-existing rather than blamed on the rollout.
            </p>

            <RadioCard
              name="previousLkgMode"
              value="auto"
              checked={mode === "auto"}
              onSelect={() => setMode("auto")}
              title="Auto — second-newest merge on the LKG branch"
              description="Resolved at run time. Correct for a repository that merges rollouts one at a time."
            />
            <RadioCard
              name="previousLkgMode"
              value="pinned"
              checked={mode === "pinned"}
              onSelect={() => setMode("pinned")}
              title="Pin to a tag or sha"
              description="Unambiguous. Use it when several rollouts land together, or to re-run an old comparison."
            >
              <TextInput
                name="previousLkgRef"
                defaultValue={previousLkgRef}
                disabled={mode !== "pinned"}
                placeholder="demo/prev-lkg@7b2065b0f09f763171ce0665dbcc216f72880ca0"
                spellCheck={false}
                className="mono mt-2 text-[12.5px]"
                aria-label="Pinned previous LKG revision"
              />
            </RadioCard>
          </fieldset>

          <Field
            label="Hotfix branch prefix"
            htmlFor="hotfixBranchPrefix"
            hint="Agent-authored branches are created as <prefix>/<run-id>. Nothing is ever pushed to the LKG branch directly."
          >
            <TextInput
              id="hotfixBranchPrefix"
              name="hotfixBranchPrefix"
              defaultValue={hotfixBranchPrefix}
              className="mono text-[12.5px]"
              spellCheck={false}
            />
          </Field>

          <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] p-3.5">
            <Toggle
              name="greptileAutoApprove"
              defaultChecked={autoPromote}
              label="Let a clean Greptile review promote a hotfix automatically"
              description="With this off, a verified hotfix is prepared and waits for a human to turn the key on the final merge into LKG."
            />
            <Callout tone="caution" title="Greptile never auto-approves sensitive changes">
              Regardless of this setting, a patch touching authentication, secrets, billing, database
              migrations, infrastructure, or CI configuration is held for human review. Turning this
              on widens what ships unattended; it does not widen what Greptile is willing to approve.
            </Callout>
          </div>
        </PanelBody>
        <PanelFooter>
          <p className="text-caption text-[var(--fg-tertiary)]">
            Changes apply to the next run; runs already in flight keep the config they started with.
          </p>
          <SubmitButton />
        </PanelFooter>
      </Panel>
    </ActionForm>
  )
}

function RadioCard({
  name,
  value,
  checked,
  onSelect,
  title,
  description,
  children,
}: {
  name: string
  value: string
  checked: boolean
  onSelect: () => void
  title: string
  description: string
  children?: React.ReactNode
}) {
  const id = React.useId()
  return (
    <div
      className={cn(
        "rounded-[8px] border p-3 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        checked
          ? "border-[var(--accent-border)] bg-[var(--accent-wash)]"
          : "border-[var(--border-hairline)] bg-[var(--bg-raised)] hover:border-[var(--border-default)]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={onSelect}
          className={cn(
            "mt-[3px] h-3.5 w-3.5 shrink-0 appearance-none rounded-full border",
            "border-[var(--border-strong)] bg-[var(--bg-inset)]",
            "checked:border-[var(--accent-400)] checked:bg-[var(--accent-400)]",
            "checked:shadow-[inset_0_0_0_2.5px_var(--bg-base)]",
          )}
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="text-label block cursor-pointer text-[var(--fg-primary)]">
            {title}
          </label>
          <p className="text-body-sm mt-0.5 text-[var(--fg-tertiary)]">{description}</p>
          {children}
        </div>
      </div>
    </div>
  )
}
