import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getGetSemanticProviderQueryKey,
  getListSemanticProposalsQueryKey,
  useAnalyzeApiOperation,
  useDecideSemanticProposal,
  useGetSemanticProvider,
  useListSemanticProposals,
  type ApiOperation,
  type SemanticAnalysisProposal,
  type SemanticAnalysisResult
} from "@workspace/api-client-react"
import { ArrowRight, Check, FileText, Info, RefreshCw, Sparkles, X } from "lucide-react"
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

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object") {
    const value = error as { status?: number; message?: string; data?: { error?: string } }
    if (value.status === 403) return "The server denied this action. Only workspace owners can review semantic proposals."
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

function sourceText(operation: ApiOperation, field: string) {
  if (field === "summary" || field.endsWith(".summary")) return operation.summary
  if (field === "description" || field.endsWith(".description")) return operation.description
  return null
}

const statusStyle: Record<SemanticAnalysisProposal["status"], string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  accepted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-border bg-muted text-muted-foreground",
  stale: "border-border bg-muted text-muted-foreground"
}

export function SemanticReview({ workspaceId, apiId, operation, canManage }: Props) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [result, setResult] = useState<SemanticAnalysisResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [failedAction, setFailedAction] = useState<"analyze" | "decision" | null>(null)
  const providerQuery = useGetSemanticProvider(workspaceId, {
    query: { enabled: canManage, queryKey: getGetSemanticProviderQueryKey(workspaceId) }
  })
  const proposalsQuery = useListSemanticProposals(workspaceId, apiId, operation.id, {
    query: { enabled: canManage, queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, operation.id) }
  })
  const analyze = useAnalyzeApiOperation()
  const decide = useDecideSemanticProposal()

  const proposals = [...(proposalsQuery.data || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const current = proposals.filter((item) =>
    item.specificationId === operation.specificationId && item.operationId === operation.id
  )
  const selected = proposals.find((item) => item.id === selectedId) ??
    current.find((item) => item.status === "pending") ??
    current[0] ?? proposals[0]
  const accepted = current.filter((item) => item.status === "accepted")
    .sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""))[0]
  const ready = Boolean(providerQuery.data?.enabled && providerQuery.data?.rolloutEnabled && providerQuery.data?.credentialUsable)
  const canDecide = canManage && selected?.status === "pending" &&
    selected.specificationId === operation.specificationId && selected.operationId === operation.id

  function refresh() {
    return queryClient.invalidateQueries({
      queryKey: getListSemanticProposalsQueryKey(workspaceId, apiId, operation.id)
    })
  }

  function handleAnalyze() {
    if (!canManage || !ready || analyze.isPending) return
    setActionError(null)
    setFailedAction(null)
    setResult(null)
    analyze.mutate({ workspaceId, apiId, operationId: operation.id }, {
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
        setActionError(errorMessage(error, "Analysis could not be completed."))
      }
    })
  }

  function handleDecision(proposal: SemanticAnalysisProposal, decision: "accepted" | "rejected") {
    if (!canManage || proposal.status !== "pending" || proposal.specificationId !== operation.specificationId || decide.isPending) return
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
                <Button onClick={handleAnalyze} disabled={!ready || providerQuery.isLoading || providerQuery.isError || analyze.isPending} data-testid="button-analyze-operation">
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
                  {analyze.isPending ? "Analyzing operation..." : "Analyze this operation"}
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
                  <p className="text-xs text-muted-foreground">Accepted {dateLabel(accepted.decidedAt)} · Displayed in this console only.</p>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-accepted-description-empty">No accepted description for this specification. The imported source remains the only description.</p>
              )}
              <p className="border-t border-border/70 pt-3 text-xs text-muted-foreground">Acceptance does not edit the OpenAPI document or change MCP tool descriptions or execution.</p>
            </div>
          </div>

          {analyze.isPending && <div className="space-y-2" aria-label="Analysis in progress"><Skeleton className="h-4 w-44" /><Skeleton className="h-16 w-full" /></div>}
          {actionError && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="status-semantic-action-error">
              <span>{actionError}</span>
              {failedAction === "analyze" && ready && canManage && <Button size="sm" variant="outline" onClick={handleAnalyze} disabled={analyze.isPending} data-testid="button-retry-semantic-analysis">Retry analysis</Button>}
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
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground" data-testid="text-proposal-source-value">
                          {selected.specificationId !== operation.specificationId
                            ? "This belongs to an earlier specification. Its original source text is not available in the current operation."
                            : sourceText(operation, selected.sourceField) || "No source text is available for this field in the current operation."}
                        </p>
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
                          <Button onClick={() => setConfirmId(selected.id)} disabled={decide.isPending} data-testid={`button-accept-proposal-${selected.id}`}>
                            <Check className="mr-2 h-4 w-4" aria-hidden="true" /> Accept for console
                          </Button>
                        </div>
                      )}
                      {selected.status === "stale" && <p className="text-xs text-muted-foreground">Stale proposals cannot be decided. Request a new analysis for the current specification.</p>}
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
            <Button onClick={() => { const item = proposals.find((proposal) => proposal.id === confirmId); if (item) handleDecision(item, "accepted") }} disabled={decide.isPending} data-testid="button-confirm-accept-proposal">
              {decide.isPending ? "Saving decision..." : "Accept for console"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}