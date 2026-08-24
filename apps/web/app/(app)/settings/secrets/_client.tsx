"use client"

import * as React from "react"
import { Key } from "phosphor-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { revokeSecret, saveSecret } from "../_actions"
import { ActionForm, Drawer, HiddenValue, SubmitButton } from "../_controls"
import {
  Chip,
  Field,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  TextInput,
} from "../_ui"

export interface SecretRow {
  id: string
  name: string
  /** Already masked server-side. The plaintext never leaves the database. */
  masked: string
  keyVersion: number
  lastUsedRelative: string | null
  lastUsedAbsolute: string | null
  lastUsedIso: string | null
  updatedRelative: string
  updatedAbsolute: string
}

/* ---------------------------------------------------------------------------
 * Create
 * ------------------------------------------------------------------------ */

export function AddSecret({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  return (
    <ActionForm action={saveSecret}>
      <HiddenValue name="projectId" value={projectId} />
      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">Add a secret</span>}
          description="Injected into every variant's sandbox as an environment variable. Probes themselves can never carry credentials — the SDK rejects auth headers outright."
        />
        <PanelBody>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,260px)_1fr]">
            <Field label="Name" htmlFor="secret-name" hint="SCREAMING_SNAKE_CASE.">
              <TextInput
                id="secret-name"
                name="name"
                placeholder="DATABASE_URL"
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                className="mono text-[12.5px]"
              />
            </Field>
            <Field
              label="Value"
              htmlFor="secret-value"
              hint="Sealed on submit. It is never sent back to a browser, including yours."
            >
              <TextInput
                id="secret-value"
                name="value"
                type="password"
                placeholder="••••••••••••••••"
                spellCheck={false}
                // Both attributes: without them a password manager offers to
                // save the value, which puts a project credential in someone's
                // personal vault.
                autoComplete="new-password"
                data-1p-ignore
                disabled={disabled}
                className="mono text-[12.5px]"
              />
            </Field>
          </div>
        </PanelBody>
        <PanelFooter>
          <span className="text-caption text-[var(--fg-tertiary)]">
            Saving a name that already exists rotates it.
          </span>
          <SubmitButton pendingLabel="Sealing…">Store secret</SubmitButton>
        </PanelFooter>
      </Panel>
    </ActionForm>
  )
}

/* ---------------------------------------------------------------------------
 * List
 * ------------------------------------------------------------------------ */

export function SecretList({
  projectId,
  secrets,
  disabled,
}: {
  projectId: string
  secrets: SecretRow[]
  disabled: boolean
}) {
  return (
    <Panel>
      <PanelHeader
        title={<span className="text-h4 text-[var(--fg-primary)]">Stored secrets</span>}
        description="Values are shown masked. There is no reveal — the server cannot render one without decrypting it, and decryption happens only inside a sandbox."
      />
      {secrets.length === 0 ? (
        <EmptyState
          icon={Key}
          size="sm"
          title="No secrets yet"
          description="Add one above if the service under test needs a credential to boot."
        />
      ) : (
        <Table surface="surface">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Rotate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.map((secret) => (
              <TableRow key={secret.id}>
                <TableCell className="mono text-[12.5px] text-[var(--fg-primary)]">
                  {secret.name}
                </TableCell>
                <TableCell className="mono text-[12.5px] text-[var(--fg-tertiary)]">
                  {secret.masked}
                  {secret.keyVersion > 1 ? (
                    <Chip className="ml-2">key v{secret.keyVersion}</Chip>
                  ) : null}
                </TableCell>
                <TableCell>
                  {secret.lastUsedRelative ? (
                    <time dateTime={secret.lastUsedIso ?? undefined} title={secret.lastUsedAbsolute ?? undefined}>
                      {secret.lastUsedRelative}
                    </time>
                  ) : (
                    <span className="text-[var(--fg-quaternary)]">never</span>
                  )}
                </TableCell>
                <TableCell title={secret.updatedAbsolute}>{secret.updatedRelative}</TableCell>
                <TableCell className="text-right">
                  <RotateSecret projectId={projectId} name={secret.name} disabled={disabled} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

function RotateSecret({
  projectId,
  name,
  disabled,
}: {
  projectId: string
  name: string
  disabled: boolean
}) {
  return (
    <Drawer
      trigger={
        <Button variant="secondary" size="sm" disabled={disabled}>
          Rotate
        </Button>
      }
      title={`Rotate ${name}`}
      description="The new value replaces the old one immediately. Runs already in flight keep the value they started with."
    >
      <ActionForm action={saveSecret} className="flex flex-col gap-4">
        <HiddenValue name="projectId" value={projectId} />
        <HiddenValue name="name" value={name} />
        <Field
          label="New value"
          htmlFor={`rotate-${name}`}
          hint="The previous value is overwritten and cannot be recovered."
        >
          <TextInput
            id={`rotate-${name}`}
            name="value"
            type="password"
            placeholder="••••••••••••••••"
            spellCheck={false}
            autoComplete="new-password"
            data-1p-ignore
            className="mono text-[12.5px]"
          />
        </Field>
        <div className="flex justify-end pt-1">
          <SubmitButton pendingLabel="Sealing…">Rotate secret</SubmitButton>
        </div>
      </ActionForm>
    </Drawer>
  )
}

/* ---------------------------------------------------------------------------
 * Danger zone
 * ------------------------------------------------------------------------ */

/**
 * Revocation lives apart from rotation on purpose.
 *
 * Rotation is routine and reversible in practice — you set a new value. Revoking
 * deletes the sealed material, and the next run that needs it fails to boot. A
 * destructive action sitting in the same row as a routine one is how it gets
 * clicked by accident.
 */
export function SecretsDangerZone({
  projectId,
  secrets,
}: {
  projectId: string
  secrets: SecretRow[]
}) {
  return (
    <section
      className="rounded-[10px] border bg-[var(--bg-surface)]"
      style={{ borderColor: "rgb(255 95 109 / 0.32)" }}
    >
      <div
        className="px-5 py-4"
        style={{ borderBottom: "1px solid rgb(255 95 109 / 0.20)" }}
      >
        <h3 className="text-h4" style={{ color: "var(--status-fail)" }}>
          Danger zone
        </h3>
        <p className="text-body-sm mt-1 max-w-[62ch] text-[var(--fg-tertiary)]">
          Revoking destroys the sealed value. Any variant that expects the variable will fail its
          health check on the next run, and the failure will be classified as a regression until the
          secret is restored.
        </p>
      </div>
      <div className="flex flex-col">
        {secrets.map((secret, index) => (
          <div
            key={secret.id}
            className={index === 0 ? "px-5 py-3" : "border-t border-[var(--border-hairline)] px-5 py-3"}
          >
            <RevokeRow projectId={projectId} secret={secret} />
          </div>
        ))}
      </div>
    </section>
  )
}

function RevokeRow({ projectId, secret }: { projectId: string; secret: SecretRow }) {
  const [confirming, setConfirming] = React.useState(false)

  return (
    <ActionForm action={revokeSecret} className="flex items-center justify-between gap-4">
      <HiddenValue name="projectId" value={projectId} />
      <HiddenValue name="secretId" value={secret.id} />
      <div className="min-w-0">
        <span className="mono text-[12.5px] text-[var(--fg-primary)]">{secret.name}</span>
        <span className="mono ml-2 text-[12.5px] text-[var(--fg-quaternary)]">{secret.masked}</span>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <SubmitButton variant="danger" size="sm" pendingLabel="Revoking…">
            Revoke {secret.name}
          </SubmitButton>
        </div>
      ) : (
        <Button
          type="button"
          variant="danger"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
      )}
    </ActionForm>
  )
}
