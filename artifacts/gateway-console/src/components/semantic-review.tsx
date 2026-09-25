import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getGetSemanticProviderQueryKey,
  getListSemanticProposalsQueryKey,
  useAnalyzeApiOperation,
  useConfirmSemanticAnalysis,
  usePrepareSemanticAnalysis,
  useDecideSemanticProposal,
  useGetSemanticProvider,
  useListSemanticProposals,
  usePreviewSemanticMcpPublication,
  usePublishSemanticMcpDescription,
  useRevokeSemanticMcpDescription,
  type ApiOperation,
  type SemanticAnalysisProposal,
  type SemanticAnalysisResult,
  type SemanticMcpPublicationPreview
} from "@workspace/api-client-react"
import { ArrowRight, Check, FileText, Info, RefreshCw, Sparkles, X, Radio, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"

type Props = {
  workspaceId: string
  apiId: string
  operation: ApiOperation
  canManage: boolean
}

export const SEMANTIC_REVIEW_PRIVACY_COPY =
  "The JSON below is the exact request body prepared by the server. It contains the operation and documentation fields shown here plus static questions and criteria; credentials and authorization headers are not part of this JSON. Automated scanning is a backstop, not a guarantee. As the workspace owner, review this exact payload and confirm it contains no sensitive, customer, or session data before dispatch."

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object") {
    const value = error as { status?: number; message?: string; data?: { error?: string } }
    if (value.status === 403) return "The server denied this action. Only workspace owners can manage semantic descriptions."
    if (value.status === 409) return value.data?.error || "This proposal is no longer pending or belongs to a previous specification. Refresh the review."
    return value.data?.error || value.message || fallback
  }
  return fallback
}

function dateLabel(value: string | null) {
  if (!value) return "Not decided"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function sourceText(operation: ApiOperation, field: string): string | null {
  if (field === "summary") return operation.summary
  if (field === "description") return operation.description
  const match = /^(parameter_description|response_description):([0-9]+)$/.exec(field)
  if (match) {
    const index = Number(match[2])
    if (!Number.isSafeInteger(index)) return null
    return match[1] === "parameter_description"
      ? operation.parameters[index]?.description ?? null
      : operation.responses[index]?.description ?? null
  }
  return null
}

function sourceContext(operation: ApiOperation, field: string): string | null {
  const match = /^(parameter_description|response_description):([0-9]+)$/.exec(field)
  if (!match) return null
  const index = Number(match[2])
  if (match[1] === "parameter_description") {
    const parameter = operation.parameters[index]
    return parameter ? `Parameter ${index} · ${parameter.location} · ${parameter.name}` : null
  }
  const response = operation.responses[index]
  return response ? `Response ${index} · status ${response.statusCode}` : null
}

const statusStyle: Record<SemanticAnalysisProposal["status"], string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  accepted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-border bg-muted text-muted-foreground",
  stale: "border-border bg-muted text-muted-foreground"
}

function McpPublication({ workspaceId, apiId, proposal, displayedProposalId, canManage }: {
  workspaceId: string
  apiId: string
  proposal: SemanticAnalysisProposal
  displayedProposalId: string
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [preview, setPreview] = useState<SemanticMcpPublicationPreview | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewRequest = usePreviewSemanticMcpPublication()
  const publish = usePublishSemanticMcpDescription()
  const revoke = useRevokeSemanticMcpDescription()
  const busy = previewRequest.isPending || publish.isPending || revoke.isPending

  function handlePreview() {
    if (!canManage || proposal.status !== "accepted" || proposal.mcpPublishedAt || busy) return
    setPreview(null)
    setError(null)
    previewRequest.mutate({ workspaceId, apiId, proposalId: proposal.id }, {
      onSuccess: (response) => setPreview(response),
      onError: (cause) => setError(errorMessage(cause, "The MCP publication preview could not be prepared. Nothing was published."))
    })
  }

  function handlePublish() {
    if (!canManage || proposal.status !== "accepted" || proposal.mcpPublishedAt || !preview || busy) return
    setError(null)
    publish.mutate({ workspaceId, apiId, proposalId: proposal.id, data: { previewToken: preview.previewToken } }, {
      onSuccess: () => {
        setPreview(null)
        void queryClient.invalidateQueries({ queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, proposal.operationId) })
        toast({ title: "Description published to MCP", description: "The accepted description is now used in MCP tools/list. The imported specification remains unchanged." })
      },
      onError: (cause) => {
        setPreview(null)
        void queryClient.invalidateQueries({ queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, proposal.operationId) })
        setError(errorMessage(cause, "Publication could not be completed. Request a fresh preview before trying again."))
      }
    })
  }

  function handleRevoke() {
    if (!canManage || proposal.status !== "accepted" || !proposal.mcpPublishedAt || busy) return
    setError(null)
    revoke.mutate({ workspaceId, apiId, proposalId: proposal.id }, {
      onSuccess: () => {
        setRevokeOpen(false)
        void queryClient.invalidateQueries({ queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, proposal.operationId) })
        toast({ title: "MCP publication revoked", description: "MCP tools/list no longer uses this accepted description. Console acceptance remains unchanged." })
      },
      onError: (cause) => {
        setRevokeOpen(false)
        void queryClient.invalidateQueries({ queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, proposal.operationId) })
        setError(errorMessage(cause, "The MCP publication could not be revoked. Refresh proposals before trying again."))
      }
    })
  }

  return (
    <div className="space-y-3 border-t border-border/70 pt-4" data-testid="section-semantic-mcp-publication">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
            <Radio className="h-4 w-4" aria-hidden="true" /> MCP publication
          </p>
          <p className="text-xs text-muted-foreground" data-testid="status-semantic-mcp-publication">
            {proposal.mcpPublishedAt ? `Published ${dateLabel(proposal.mcpPublishedAt)} · MCP tools/list uses this description.` : "Not published · MCP tools/list continues to use the imported description."}
          </p>
          {proposal.mcpPublishedAt && proposal.id !== displayedProposalId && (
            <div className="space-y-1 rounded-md border border-primary/25 bg-background/40 p-3">
              <p className="text-xs text-muted-foreground">A different accepted proposal is published to MCP. Revoke it here before publishing the accepted console description above.</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="text-published-mcp-proposal">{proposal.proposalText}</p>
            </div>
          )}
        </div>
        {canManage && (proposal.mcpPublishedAt ? (
          <Button size="sm" variant="outline" onClick={() => setRevokeOpen(true)} disabled={busy} data-testid="button-revoke-semantic-mcp-description">
            <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Revoke MCP publication
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={handlePreview} disabled={busy} data-testid="button-preview-semantic-mcp-publication">
            <Radio className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {previewRequest.isPending ? "Preparing MCP preview..." : "Publish this accepted description to MCP"}
          </Button>
        ))}
      </div>
      {previewRequest.isPending && <div aria-label="Preparing MCP publication preview" className="space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-12 w-full" /></div>}
      {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" data-testid="status-semantic-mcp-error">{error}</div>}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open && !publish.isPending) setPreview(null) }}>
        <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden" data-testid="dialog-semantic-mcp-preview">
          <DialogHeader>
            <DialogTitle>Publish this description to MCP?</DialogTitle>
            <DialogDescription>Review the exact imported description, accepted proposal, and resulting MCP tool description. Publishing is separate from console acceptance and does not edit the imported specification.</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="min-h-0 space-y-4 overflow-y-auto">
              {([
                ["Imported description", preview.importedDescription, "text-mcp-imported-description"],
                ["Accepted proposal", preview.proposalText, "text-mcp-proposal-description"],
                ["MCP tool description after publication", preview.toolDescription, "text-mcp-tool-description"]
              ] as const).map(([label, value, testId]) => (
                <div key={testId} className="space-y-2 rounded-md border border-border bg-background/50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed" data-testid={testId}>{value}</pre>
                </div>
              ))}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPreview(null)} disabled={publish.isPending} data-testid="button-cancel-semantic-mcp-publication">Cancel</Button>
            <Button onClick={handlePublish} disabled={!preview || !canManage || busy} data-testid="button-confirm-semantic-mcp-publication">
              {publish.isPending ? "Publishing..." : "Confirm publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={revokeOpen} onOpenChange={(open) => { if (!revoke.isPending) setRevokeOpen(open) }}>
        <DialogContent data-testid="dialog-revoke-semantic-mcp-description">
          <DialogHeader>
            <DialogTitle>Revoke this MCP publication?</DialogTitle>
            <DialogDescription>MCP tools/list will return to the imported description. This does not remove the accepted console description or change the imported specification.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRevokeOpen(false)} disabled={revoke.isPending} data-testid="button-cancel-revoke-semantic-mcp-description">Cancel</Button>
            <Button onClick={handleRevoke} disabled={!canManage || !proposal.mcpPublishedAt || busy} data-testid="button-confirm-revoke-semantic-mcp-description">
              {revoke.isPending ? "Revoking..." : "Confirm revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function SemanticReview({ workspaceId, apiId, operation, canManage }: Props) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [result, setResult] = useState<SemanticAnalysisResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<{
    preflightHandle: string
    expiresAt: string
    payload: object
    workspaceId: string
    apiId: string
    operationId: string
    specificationId: string
  } | null>(null)
  const [confirmedNoSensitiveData, setConfirmedNoSensitiveData] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [actionError, setActionError] = useState<string | null>(null)
  const [failedAction, setFailedAction] = useState<"preflight" | "confirmation" | "analyze" | "decision" | null>(null)
  const currentTarget = useRef({
    workspaceId,
    apiId,
    operationId: operation.id,
    specificationId: operation.specificationId
  })
  const providerQuery = useGetSemanticProvider(workspaceId, {
    query: { enabled: canManage, queryKey: getGetSemanticProviderQueryKey(workspaceId) }
  })
  const proposalsQuery = useListSemanticProposals(workspaceId, apiId, operation.id, {
    query: { enabled: canManage, queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, operation.id) }
  })
  const prepare = usePrepareSemanticAnalysis()
  const confirm = useConfirmSemanticAnalysis()
  const analyze = useAnalyzeApiOperation()
  const decide = useDecideSemanticProposal()

  useEffect(() => {
    currentTarget.current = {
      workspaceId,
      apiId,
      operationId: operation.id,
      specificationId: operation.specificationId
    }
  }, [workspaceId, apiId, operation.id, operation.specificationId])

  useEffect(() => {
    if (!preflight) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [preflight])

  useEffect(() => {
    setPreflight(null)
    setConfirmedNoSensitiveData(false)
  }, [workspaceId, apiId, operation.id, operation.specificationId])

  const proposals = [...(proposalsQuery.data || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const current = proposals.filter((item) =>
    item.specificationId === operation.specificationId && item.operationId === operation.id
  )
  const selected = proposals.find((item) => item.id === selectedId) ??
    current.find((item) => item.status === "pending") ??
    current[0] ?? proposals[0]
  const accepted = current.filter((item) => item.status === "accepted")
    .sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""))[0]
  // A publication may belong to an older accepted proposal, not the one shown in the console.
  // Keep its revoke action reachable; do not offer another publication until it is revoked.
  const published = current.find((item) => item.status === "accepted" && item.mcpPublishedAt)
  const publicationProposal = published ?? accepted
  const ready = Boolean(providerQuery.data?.enabled && providerQuery.data?.rolloutEnabled && providerQuery.data?.credentialUsable)
  const canDecide = canManage && selected?.status === "pending" &&
    selected.specificationId === operation.specificationId && selected.operationId === operation.id
  const selectedSource = selected && selected.specificationId === operation.specificationId && selected.operationId === operation.id
    ? sourceText(operation, selected.sourceField) : null
  const sourceUnusable = canDecide && selectedSource === null
  const preflightExpired = !preflight || !Number.isFinite(Date.parse(preflight.expiresAt)) || now >= Date.parse(preflight.expiresAt)
  const preflightMatchesOperation = preflight?.workspaceId === workspaceId &&
    preflight?.apiId === apiId &&
    preflight?.operationId === operation.id &&
    preflight?.specificationId === operation.specificationId

  useEffect(() => {
    if (preflight && preflightExpired) {
      setPreflight(null)
      setConfirmedNoSensitiveData(false)
    }
  }, [preflight, preflightExpired])

  function discardPreflight() {
    setPreflight(null)
    setConfirmedNoSensitiveData(false)
  }

  function refresh() {
    return queryClient.invalidateQueries({
      queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, operation.id)
    })
  }

  function handlePrepare() {
    if (!canManage || !ready || prepare.isPending || confirm.isPending || analyze.isPending || preflight) return
    setActionError(null)
    setFailedAction(null)
    setResult(null)
    setConfirmedNoSensitiveData(false)
    prepare.mutate({ workspaceId, apiId, operationId: operation.id }, {
      onSuccess: (response) => {
        setNow(Date.now())
        setConfirmedNoSensitiveData(false)
        setPreflight({
          ...response,
          workspaceId,
          apiId,
          operationId: operation.id,
          specificationId: operation.specificationId
        })
      },
      onError: (error) => {
        setFailedAction("preflight")
        setActionError(errorMessage(error, "The review payload could not be prepared. No analysis was sent."))
      }
    })
  }

  function handleConfirmAndSend() {
    if (!canManage || !ready || !preflight || !confirmedNoSensitiveData || preflightExpired ||
      !preflightMatchesOperation || confirm.isPending || analyze.isPending) return
    const target = {
      workspaceId,
      apiId,
      operationId: operation.id,
      specificationId: operation.specificationId
    }
    const handle = preflight.preflightHandle
    discardPreflight()
    setActionError(null)
    setFailedAction(null)
    confirm.mutate({
      workspaceId,
      apiId,
      operationId: operation.id,
      data: { preflightHandle: handle, confirmedNoSensitiveData: true as const }
    }, {
      onSuccess: (authorization) => {
        const latest = currentTarget.current
        const stillTargetsSameOperation = latest.workspaceId === target.workspaceId &&
          latest.apiId === target.apiId &&
          latest.operationId === target.operationId &&
          latest.specificationId === target.specificationId
        const expiresAt = Date.parse(authorization.expiresAt)
        if (!stillTargetsSameOperation || !Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
          setActionError("The dispatch authorization expired or the operation changed before it could be used. No analysis was sent. Prepare a new review.")
          setFailedAction("confirmation")
          return
        }
        analyze.mutate({
          workspaceId: target.workspaceId,
          apiId: target.apiId,
          operationId: target.operationId,
          data: { dispatchToken: authorization.dispatchToken }
        }, {
          onSuccess: (response) => {
            setResult(response)
            if (response.proposal) setSelectedId(response.proposal.id)
            void refresh()
            toast({
              title: response.outcome === "abstained" ? "Analysis abstained" : "Proposal ready for review",
              description: response.outcome === "abstained"
                ? "No source-grounded description was proposed. The imported text is unchanged."
                : "Compare the source and proposal before making a decision."
            })
          },
          onError: (error) => {
            setFailedAction("analyze")
            setActionError(`${errorMessage(error, "Analysis could not be completed.")} No automatic retry was made. Prepare a new review payload to try again.`)
          }
        })
      },
      onError: (error) => {
        setFailedAction("confirmation")
        setActionError(`${errorMessage(error, "The dispatch authorization could not be issued.")} No analysis was sent. Prepare a new review payload to try again.`)
      }
    })
  }

  function handleDecision(proposal: SemanticAnalysisProposal, decision: "accepted" | "rejected") {
    if (!canManage || proposal.status !== "pending" || proposal.specificationId !== operation.specificationId || proposal.operationId !== operation.id || decide.isPending) return
    if (decision === "accepted" && sourceText(operation, proposal.sourceField) === null) {
      setConfirmId(null)
      setFailedAction("decision")
      setActionError("This proposal's original source cannot be resolved. Acceptance is unavailable; refresh proposals.")
      return
    }
    setActionError(null)
    setFailedAction(null)
    decide.mutate({ workspaceId, apiId, proposalId: proposal.id, data: { decision } }, {
      onSuccess: () => {
        setConfirmId(null)
        void refresh()
        toast({
          title: decision === "accepted" ? "Description accepted" : "Proposal rejected",
          description: decision === "accepted"
            ? "The accepted description is displayed in this console only. The imported specification and MCP behavior are unchanged."
            : "The imported description remains unchanged."
        })
      },
      onError: (error) => {
        setConfirmId(null)
        void refresh()
        setFailedAction("decision")
        setActionError(errorMessage(error, "The decision could not be saved."))
      }
    })
  }

  return (
    <section aria-labelledby="semantic-review-heading" className="space-y-4" data-testid="section-semantic-review">
      <Card className="overflow-hidden border-primary/25 bg-card">
        <div className="h-1 bg-primary/70" />
        <CardHeader className="gap-4 border-b border-border/70 pb-5 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span className="font-mono text-[11px] uppercase tracking-[0.18em]">Manual review / Phase 2</span>
            </div>
            <CardTitle id="semantic-review-heading" className="text-xl tracking-tight">Semantic description review</CardTitle>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              A workspace owner may request a source-grounded description. Review it against the imported operation before accepting or rejecting. Nothing runs automatically when the provider is Ready.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
            {canManage ? (
              <>
                <Badge variant="outline" className={ready ? "border-emerald-500/40 text-emerald-300" : "text-muted-foreground"} data-testid="status-semantic-provider">
                  {providerQuery.isLoading ? "Checking provider" : providerQuery.isError ? "Provider status unavailable" : ready ? "Provider Ready" : "Provider not Ready"}
                </Badge>
                  <Button onClick={handlePrepare} disabled={!ready || providerQuery.isLoading || providerQuery.isError || prepare.isPending || confirm.isPending || analyze.isPending || Boolean(preflight)} data-testid="button-analyze-operation">
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
                    {prepare.isPending ? "Preparing review..." : confirm.isPending ? "Confirming review..." : analyze.isPending ? "Analyzing operation..." : "Review analysis payload"}
                </Button>
                {!ready && !providerQuery.isLoading && !providerQuery.isError && (
                  <span className="max-w-60 text-xs text-muted-foreground md:text-right">Configure, test, and mark the provider Ready in workspace settings first.</span>
                )}
                {providerQuery.isError && (
                  <Button variant="ghost" size="sm" onClick={() => void providerQuery.refetch()} data-testid="button-retry-semantic-provider">Retry provider status</Button>
                )}
              </>
            ) : (
              <span className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Owner action required to analyze or decide</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-2">
            <div className="space-y-3 bg-background/50 p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <FileText className="h-4 w-4" aria-hidden="true" /> Imported source · unchanged
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">summary</p>
                <p className="whitespace-pre-wrap break-words text-sm" data-testid="text-original-summary">{operation.summary || <span className="italic text-muted-foreground">Not provided in the specification</span>}</p>
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">description</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="text-original-description">{operation.description || <span className="italic text-muted-foreground">Not provided in the specification</span>}</p>
              </div>
            </div>
            <div className="space-y-3 bg-primary/[0.035] p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
                <ArrowRight className="h-4 w-4" aria-hidden="true" /> Accepted console display
              </div>
              {accepted ? (
                <>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="text-accepted-description">{accepted.proposalText}</p>
                  <p className="text-xs text-muted-foreground">Accepted {dateLabel(accepted.decidedAt)} · {accepted.mcpPublishedAt ? "Also published to MCP tools/list." : "Displayed in this console only."}</p>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-accepted-description-empty">No accepted description for this specification. The imported source remains the only description.</p>
              )}
              <p className="border-t border-border/70 pt-3 text-xs text-muted-foreground">Acceptance alone does not edit the OpenAPI document or change MCP tool descriptions or execution. MCP publication requires a separate owner confirmation.</p>
              {publicationProposal && <McpPublication key={`${workspaceId}:${apiId}:${operation.id}:${operation.specificationId}:${publicationProposal.id}`} workspaceId={workspaceId} apiId={apiId} proposal={publicationProposal} displayedProposalId={accepted?.id ?? publicationProposal.id} canManage={canManage} />}
            </div>
          </div>

          {(prepare.isPending || confirm.isPending || analyze.isPending) && <div className="space-y-2" aria-label={prepare.isPending ? "Preparing review payload" : confirm.isPending ? "Confirming reviewed payload" : "Analysis in progress"}><Skeleton className="h-4 w-44" /><Skeleton className="h-16 w-full" /></div>}
          {actionError && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="status-semantic-action-error">
              <span>{actionError}</span>
              {(failedAction === "preflight" || failedAction === "confirmation" || failedAction === "analyze") && ready && canManage && <Button size="sm" variant="outline" onClick={handlePrepare} disabled={prepare.isPending || confirm.isPending || analyze.isPending} data-testid="button-retry-semantic-analysis">Prepare a new review</Button>}
              {failedAction === "decision" && <Button size="sm" variant="outline" onClick={() => void proposalsQuery.refetch()} data-testid="button-refresh-semantic-decision">Refresh proposals</Button>}
            </div>
          )}
          {result?.outcome === "abstained" && (
            <div role="status" className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100" data-testid="status-semantic-abstained">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div><strong>Analysis abstained.</strong> There was not enough grounded source evidence to propose a description. No review decision is needed; the imported text remains unchanged.</div>
            </div>
          )}

          <div className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Proposal record</h3>
                <p className="text-xs text-muted-foreground">Version-bound decisions, including earlier rejected and stale proposals.</p>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">{proposals.length} {proposals.length === 1 ? "record" : "records"}</span>
            </div>
            {proposalsQuery.isLoading ? (
              <div className="space-y-3"><Skeleton className="h-11 w-full" /><Skeleton className="h-40 w-full" /></div>
            ) : proposalsQuery.isError ? (
              <div role="alert" className="rounded-md border border-destructive/30 p-5 text-sm">
                <p>Proposal history could not be loaded. Decisions are unavailable until it is refreshed.</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => void proposalsQuery.refetch()} data-testid="button-retry-proposals"><RefreshCw className="mr-2 h-3 w-3" /> Retry</Button>
              </div>
            ) : !proposals.length ? (
              <div className="rounded-md border border-dashed border-border bg-muted/20 px-5 py-8 text-center">
                <FileText className="mx-auto mb-3 h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
                <p className="text-sm font-medium">No proposals yet</p>
                <p className="mt-1 text-xs text-muted-foreground">An owner can request one explicitly when the provider is Ready.</p>
              </div>
            ) : (
              <>
                <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Select proposal">
                  {proposals.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-pressed={selected?.id === item.id}
                      data-testid={`button-select-proposal-${item.id}`}
                      className={`shrink-0 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === item.id ? "border-primary/70 bg-primary/10" : "border-border bg-muted/20"}`}
                    >
                      <span className="block font-mono text-[11px] uppercase">{item.status}</span>
                      <span className="block text-[11px] text-muted-foreground">{dateLabel(item.createdAt)}</span>
                    </button>
                  ))}
                </div>
                {selected && (
                  <div className="rounded-lg border border-border bg-muted/10 p-4 md:p-5" data-testid={`card-proposal-${selected.id}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-4">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`capitalize ${statusStyle[selected.status]}`} data-testid="status-selected-proposal">{selected.status}</Badge>
                        <span className="font-mono text-[11px] text-muted-foreground">Specification {selected.specificationId.slice(0, 12)}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">Created {dateLabel(selected.createdAt)}</span>
                    </div>
                    <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Selected source field</p>
                        <code className="inline-block rounded border border-border bg-background px-2 py-1 text-xs text-primary" data-testid="text-proposal-source-field">{selected.sourceField}</code>
                         {selected.specificationId === operation.specificationId && sourceContext(operation, selected.sourceField) && (
                           <p className="text-xs text-muted-foreground" data-testid="text-proposal-source-context">{sourceContext(operation, selected.sourceField)}</p>
                         )}
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground" data-testid="text-proposal-source-value">
                           {selected.specificationId !== operation.specificationId || selected.operationId !== operation.id
                            ? "This belongs to an earlier specification. Its original source text is not available in the current operation."
                             : selectedSource === null ? "Original source field cannot be resolved in this operation." : selectedSource || "(Empty in the imported specification)"}
                        </p>
                         {sourceUnusable && (
                           <p role="alert" className="text-xs text-amber-200" data-testid="status-proposal-source-unusable">
                             Unusable / stale source reference. Acceptance is disabled until the proposal is refreshed.
                           </p>
                         )}
                      </div>
                      <div className="space-y-2 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-5 md:pt-0">
                        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Proposed description</p>
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="text-proposed-description">{selected.proposalText}</p>
                      </div>
                    </div>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted-foreground">
                        <span data-testid="text-proposal-confidence">Confidence {(selected.confidence * 100).toFixed(0)}%</span>
                        <span data-testid="text-proposal-uncertainty">Uncertainty {(selected.uncertainty * 100).toFixed(0)}%</span>
                        {selected.decidedAt && <span>Decided {dateLabel(selected.decidedAt)}</span>}
                      </div>
                      {canDecide && (
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" onClick={() => handleDecision(selected, "rejected")} disabled={decide.isPending} data-testid={`button-reject-proposal-${selected.id}`}>
                            <X className="mr-2 h-4 w-4" aria-hidden="true" /> Reject
                          </Button>
                           <Button onClick={() => setConfirmId(selected.id)} disabled={decide.isPending || sourceUnusable} data-testid={`button-accept-proposal-${selected.id}`}>
                            <Check className="mr-2 h-4 w-4" aria-hidden="true" /> Accept for console
                          </Button>
                        </div>
                      )}
                      {selected.status === "stale" && <p className="text-xs text-muted-foreground">Stale proposals cannot be decided. Request a new analysis for the current specification.</p>}
                       {sourceUnusable && <Button size="sm" variant="outline" onClick={() => void proposalsQuery.refetch()} disabled={proposalsQuery.isFetching} data-testid="button-refresh-stale-proposal"><RefreshCw className="mr-2 h-3 w-3" aria-hidden="true" /> Refresh proposals</Button>}
                      {selected.specificationId !== operation.specificationId && selected.status !== "stale" && <p className="text-xs text-muted-foreground">Earlier specification: view-only.</p>}
                      {!canManage && selected.status === "pending" && <p className="text-xs text-muted-foreground">Only a workspace owner can decide this proposal.</p>}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
        <Dialog open={Boolean(preflight)} onOpenChange={(open) => { if (!open && !confirm.isPending && !analyze.isPending) discardPreflight() }}>
         <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden" data-testid="dialog-semantic-preflight">
           <DialogHeader>
             <DialogTitle>Review what will be sent to Jev</DialogTitle>
             <DialogDescription>
                {SEMANTIC_REVIEW_PRIVACY_COPY}
             </DialogDescription>
           </DialogHeader>
           {preflight && (
             <>
               <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                 <span data-testid="text-preflight-expiry">Confirmation expires {dateLabel(preflight.expiresAt)}</span>
                 {preflightExpired || !preflightMatchesOperation ? (
                   <Badge variant="outline" className="border-amber-500/40 text-amber-200" data-testid="status-preflight-expired">Expired or operation changed — prepare again</Badge>
                 ) : (
                   <Badge variant="outline" className="border-primary/40 text-primary" data-testid="status-preflight-ready">Awaiting your confirmation</Badge>
                 )}
               </div>
               <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background/50 p-4" aria-label="Exact JSON body sent to Jev">
                 <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed" data-testid="text-semantic-preflight-payload">{JSON.stringify(preflight.payload, null, 2)}</pre>
               </div>
                <label className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3 text-sm leading-relaxed">
                  <input
                    type="checkbox"
                    checked={confirmedNoSensitiveData}
                    onChange={(event) => setConfirmedNoSensitiveData(event.target.checked)}
                    disabled={preflightExpired || !preflightMatchesOperation || confirm.isPending || analyze.isPending}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    data-testid="checkbox-confirm-no-sensitive-data"
                  />
                  <span>I reviewed the exact JSON payload above and confirm it contains no sensitive, customer, or session data.</span>
                </label>
             </>
           )}
           <DialogFooter className="gap-2">
              <Button variant="outline" onClick={discardPreflight} disabled={confirm.isPending || analyze.isPending} data-testid="button-cancel-semantic-preflight">Cancel</Button>
             {preflightExpired || !preflightMatchesOperation ? (
                <Button onClick={discardPreflight} data-testid="button-discard-expired-preflight">Discard and prepare again</Button>
             ) : (
                <Button onClick={handleConfirmAndSend} disabled={!ready || !canManage || !confirmedNoSensitiveData || confirm.isPending || analyze.isPending} data-testid="button-confirm-send-semantic-analysis">
                 Confirm and send to Jev
               </Button>
             )}
           </DialogFooter>
         </DialogContent>
       </Dialog>
      <Dialog open={Boolean(confirmId)} onOpenChange={(open) => { if (!open) setConfirmId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept this description?</DialogTitle>
            <DialogDescription>
              This will display the proposed description in the SpecRelay console for the current imported specification. The OpenAPI source and MCP behavior will not change.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmId(null)} data-testid="button-cancel-accept-proposal">Cancel</Button>
             <Button onClick={() => { const item = proposals.find((proposal) => proposal.id === confirmId); if (item) handleDecision(item, "accepted") }} disabled={decide.isPending || !proposals.some((proposal) => proposal.id === confirmId && proposal.status === "pending" && proposal.specificationId === operation.specificationId && proposal.operationId === operation.id && sourceText(operation, proposal.sourceField) !== null)} data-testid="button-confirm-accept-proposal">
              {decide.isPending ? "Saving decision..." : "Accept for console"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}