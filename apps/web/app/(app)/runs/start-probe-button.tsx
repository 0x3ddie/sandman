"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Play } from "phosphor-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { startProbeRun } from "./_actions"

export function StartProbeButton({
  projectId,
  disabled,
  disabledReason,
}: {
  projectId: string | null
  disabled?: boolean
  disabledReason?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()

  const blocked = disabled || !projectId

  function launch() {
    if (!projectId) return
    startTransition(async () => {
      const result = await startProbeRun(projectId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("Probe queued", { description: result.runId })
      // No router.refresh(): the action called revalidatePath, so Next already
      // re-rendered the route and shipped the RSC payload in the same response.
      router.push(`/runs/${result.runId}`)
    })
  }

  return (
    <Button
      variant="primary"
      size="md"
      onClick={launch}
      disabled={blocked || pending}
      title={blocked ? disabledReason : undefined}
    >
      <Play size={16} weight="regular" />
      {pending ? "Queueing…" : "Run probe"}
    </Button>
  )
}
