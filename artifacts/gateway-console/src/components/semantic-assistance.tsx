import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetSemanticProvider,
  useSaveSemanticProviderKey,
  useDeleteSemanticProviderKey,
  useSetSemanticProviderReady,
  useTestSemanticProvider,
  getGetSemanticProviderQueryKey
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDistanceToNow } from "date-fns"
import { BrainCircuit, CheckCircle2, AlertTriangle, Clock, Trash2, Play } from "lucide-react"

function isServiceUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 503
}

export function SemanticAssistance({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const { data: provider, isLoading } = useGetSemanticProvider(workspaceId)

  const saveKey = useSaveSemanticProviderKey()
  const deleteKey = useDeleteSemanticProviderKey()
  const setReady = useSetSemanticProviderReady()
  const testProvider = useTestSemanticProvider()

  const [secret, setSecret] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!provider?.lastTestedAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [provider?.lastTestedAt])

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />
  }

  if (!provider) {
    return null
  }

  const isTestSuccess = provider.lastTestOutcome === 'success'
  const isCurrentRevisionTested = provider.testedRevision !== null && provider.testedRevision === provider.credentialRevision
  const canBeReady = provider.rolloutEnabled && provider.configured && isTestSuccess && isCurrentRevisionTested
  const lastTestedTime = provider.lastTestedAt ? new Date(provider.lastTestedAt).getTime() : NaN
  const cooldownSeconds = Number.isFinite(lastTestedTime)
    ? Math.max(0, Math.ceil((lastTestedTime + 30_000 - now) / 1000))
    : 0

  const handleSave = () => {
    if (!secret.trim()) return
    saveKey.mutate({ workspaceId, data: { secret } }, {
      onSuccess: () => {
        setSecret("")
        toast({ title: "Credential saved", description: "Semantic provider key has been updated." })
        queryClient.invalidateQueries({ queryKey: getGetSemanticProviderQueryKey(workspaceId) })
      },
      onError: (err: unknown) => {
        toast({
          title: "Failed to save",
          description: isServiceUnavailable(err) ? "Service unavailable." : "An error occurred while saving.",
          variant: "destructive"
        })
      }
    })
  }

  const handleDelete = () => {
    deleteKey.mutate({ workspaceId }, {
      onSuccess: () => {
        setDeleteOpen(false)
        toast({ title: "Credential deleted", description: "Semantic provider key has been removed." })
        queryClient.invalidateQueries({ queryKey: getGetSemanticProviderQueryKey(workspaceId) })
      },
      onError: () => {
        toast({
          title: "Failed to delete",
          description: "An error occurred while deleting.",
          variant: "destructive"
        })
      }
    })
  }

  const handleTest = () => {
    testProvider.mutate({ workspaceId }, {
      onSuccess: (result) => {
        toast({
          title: result.outcome === "success" ? "Connection verified" : "Connection not verified",
          description: result.outcome === "rejected" ? "Jev rejected this key." :
            result.outcome === "inconclusive" ? "Jev was unavailable or rate-limited. Try again later." :
            result.outcome === "integration_error" ? "The Jev test could not be completed." :
            "Jev accepted the key for the synthetic connection test."
        })
        queryClient.invalidateQueries({ queryKey: getGetSemanticProviderQueryKey(workspaceId) })
      },
      onError: (err: unknown) => {
        toast({
          title: "Test failed",
          description: isServiceUnavailable(err) ? "Connection tests are not available yet." : "Could not complete the test.",
          variant: "destructive"
        })
      }
    })
  }

  const handleToggleReady = (enabled: boolean) => {
    setReady.mutate({ workspaceId, data: { enabled } }, {
      onSuccess: () => {
        toast({ title: enabled ? "Provider ready" : "Provider disabled", description: "State updated successfully." })
        queryClient.invalidateQueries({ queryKey: getGetSemanticProviderQueryKey(workspaceId) })
      },
      onError: () => {
        toast({
          title: "Update failed",
          description: "An error occurred while updating provider state.",
          variant: "destructive"
        })
      }
    })
  }

  let statusLabel = "Not configured"
  let badgeVariant: "default" | "secondary" | "outline" | "destructive" = "outline"

  if (provider.enabled && provider.rolloutEnabled) {
    statusLabel = "Ready"
    badgeVariant = "default"
  } else if (provider.configured) {
    statusLabel = "Configured"
    badgeVariant = "secondary"
  }

  return (
    <Card className="border-t-4 border-t-indigo-500">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-indigo-500" />
              Semantic Assistance
            </CardTitle>
            <CardDescription className="mt-1 max-w-2xl text-balance">
              Configure a Jev key for future semantic assistance. No semantic analysis is active yet, even when the key is Ready.
            </CardDescription>
            {!provider.rolloutEnabled && (
              <p className="mt-2 text-xs text-muted-foreground">
                Connection tests and Ready are available only when this workspace is included in the operator rollout.
              </p>
            )}
          </div>
          <Badge variant={badgeVariant} className="text-xs uppercase tracking-wider">{statusLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <label htmlFor="semantic-secret-input" className="text-sm font-medium text-foreground">API Credential</label>
          <div className="flex gap-2 max-w-lg">
            <Input
              id="semantic-secret-input"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={provider.configured ? "Replace existing credential..." : "Enter Jev API key..."}
              autoComplete="new-password"
              data-testid="input-semantic-secret"
            />
            <Button onClick={handleSave} disabled={!secret.trim() || saveKey.isPending} data-testid="button-save-semantic">
              {saveKey.isPending ? "Saving..." : provider.configured ? "Replace" : "Save"}
            </Button>
            {provider.configured && (
              <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="text-destructive shrink-0" data-testid="button-delete-semantic-trigger" aria-label="Delete credential">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete Credential</DialogTitle>
                    <DialogDescription>
                      Are you sure you want to remove the Jev key? This removes its Ready state. Semantic analysis is not active.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeleteOpen(false)} data-testid="button-cancel-delete-semantic">Cancel</Button>
                    <Button variant="destructive" onClick={handleDelete} disabled={deleteKey.isPending} data-testid="button-confirm-delete-semantic">
                      {deleteKey.isPending ? "Deleting..." : "Delete"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

        {provider.configured && (
          <div className="rounded-md border p-4 bg-muted/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium flex items-center gap-2">
                Connection Status
                {provider.lastTestedAt ? (
                  provider.lastTestOutcome === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground" />
                )}
              </p>
              <div className="text-xs text-muted-foreground">
                {provider.lastTestedAt ? (
                  <>
                    Last tested {formatDistanceToNow(new Date(provider.lastTestedAt))} ago
                    <span className="mx-2 text-border">•</span>
                    Outcome: <span className="font-mono">{provider.lastTestOutcome}</span>
                    {(!isCurrentRevisionTested) && (
                      <span className="block mt-1 text-amber-600 dark:text-amber-400">
                        Credential has changed since last test. Please re-test.
                      </span>
                    )}
                  </>
                ) : (
                  "Never tested"
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button onClick={handleTest} disabled={testProvider.isPending || cooldownSeconds > 0 || !provider.rolloutEnabled} variant="outline" size="sm" data-testid="button-test-semantic">
                <Play className="h-3 w-3 mr-2" />
                {testProvider.isPending ? "Testing..." : cooldownSeconds > 0 ? `Wait ${cooldownSeconds}s` : "Test Connection"}
              </Button>

              <Button
                onClick={() => handleToggleReady(!provider.enabled)}
                disabled={(!provider.enabled && !canBeReady) || setReady.isPending}
                variant={provider.enabled ? "secondary" : "default"}
                size="sm"
                data-testid="button-toggle-semantic"
              >
                {setReady.isPending ? "Updating..." : provider.enabled ? "Disable" : "Set Ready"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}