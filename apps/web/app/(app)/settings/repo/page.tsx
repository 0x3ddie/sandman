/**
 * Repository settings — what sandman probes, and which two revisions define
 * "before" and "after".
 */

import * as React from "react"

import {
  appInstallUrl,
  githubConfigured,
  githubMissingEnv,
  listAppInstallations,
  listBranches,
  listInstallationRepositories,
} from "@/lib/github"
import { Callout, PageHeader, Panel, PanelBody, PanelHeader } from "../_ui"
import { currentProject, materializeConfig, organizationContext, repoParts } from "../_data"
import { ConnectRepository, RolloutSettings, type InstallationOption } from "./_client"

// GitHub state is read live: a repository revoked in GitHub's UI must stop
// appearing here on the next load, not on the next deploy.
export const dynamic = "force-dynamic"

interface GitHubState {
  installations: InstallationOption[]
  branches: string[]
  error: string | null
}

async function loadGitHub(
  installationId: number | null,
  repositoryFullName: string | null,
): Promise<GitHubState> {
  if (!githubConfigured()) return { installations: [], branches: [], error: null }

  try {
    // Capped: an App installed on dozens of accounts would otherwise make this
    // page wait on dozens of sequential round trips.
    const installations = (await listAppInstallations()).filter((entry) => !entry.suspended).slice(0, 8)

    const options: InstallationOption[] = await Promise.all(
      installations.map(async (installation) => ({
        id: installation.id,
        login: installation.accountLogin,
        accountType: installation.accountType,
        repositories: (await listInstallationRepositories(installation.id)).map((repo) => ({
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          private: repo.private,
        })),
      })),
    )

    let branches: string[] = []
    const parts = repositoryFullName ? repoParts(repositoryFullName) : null
    if (installationId && parts) {
      branches = (await listBranches(installationId, parts.owner, parts.repo)).map((b) => b.name)
    }

    return { installations: options, branches, error: null }
  } catch (cause) {
    return {
      installations: [],
      branches: [],
      error: cause instanceof Error ? cause.message : "GitHub could not be reached.",
    }
  }
}

export default async function RepositorySettingsPage() {
  const { organization } = await organizationContext()
  const project = await currentProject()
  const config = project ? materializeConfig(project) : null
  const missing = githubMissingEnv()

  const github = await loadGitHub(project?.installationId ?? null, project?.repositoryFullName ?? null)

  return (
    <div className="flex max-w-[880px] flex-col gap-5">
      <PageHeader
        title="Repository"
        description="One GitHub App signs you in and holds the repository permissions sandman needs. Installing it is the whole connection step — there is no second OAuth app and no deploy key."
      />

      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">GitHub App</span>}
          description="Installed per account or organisation, scoped to the repositories you choose."
        />
        <PanelBody>
          {missing.length > 0 ? (
            <Callout tone="caution" title="The App is not configured on this deployment">
              Set {missing.map((name, index) => (
                <React.Fragment key={name}>
                  {index > 0 ? ", " : ""}
                  <code className="mono text-[12px] text-[var(--fg-primary)]">{name}</code>
                </React.Fragment>
              ))}{" "}
              from the App&rsquo;s settings page, then reload. Everything below stays inactive until
              then.
            </Callout>
          ) : null}

          {github.error ? (
            <Callout tone="danger" title="GitHub returned an error">
              {github.error}
            </Callout>
          ) : null}

          <ConnectRepository
            installations={github.installations}
            installUrl={appInstallUrl(organization.id)}
            connected={
              project
                ? {
                    projectId: project.id,
                    repositoryFullName: project.repositoryFullName,
                    installationId: project.installationId,
                    repositoryUrl: project.repositoryUrl,
                  }
                : null
            }
            disabled={missing.length > 0}
          />
        </PanelBody>
      </Panel>

      {project && config ? (
        <RolloutSettings
          projectId={project.id}
          lkgBranch={project.lkgBranch}
          branches={github.branches}
          previousLkgMode={project.previousLkgMode === "pinned" ? "pinned" : "auto"}
          previousLkgRef={project.previousLkgRef ?? ""}
          hotfixBranchPrefix={project.hotfixBranchPrefix}
          autoPromote={config.promotion.auto_promote}
        />
      ) : null}
    </div>
  )
}
