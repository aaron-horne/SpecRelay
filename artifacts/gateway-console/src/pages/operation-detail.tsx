import { Link, useParams } from "wouter"
import { 
  useGetOperation, 
  useGetApi,
  useUpdateOperationState,
  useListCredentials,
  getGetOperationQueryKey,
  getGetWorkspaceOverviewQueryKey,
  getListOperationsQueryKey,
  type ApiSecurityScheme
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { 
  Shield, 
  Key, 
  Box, 
  Activity, 
  Lock,
  Unlock,
  AlertTriangle
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { 
  Breadcrumb, 
  BreadcrumbItem, 
  BreadcrumbLink, 
  BreadcrumbList, 
  BreadcrumbPage, 
  BreadcrumbSeparator 
} from "@/components/ui/breadcrumb"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SemanticReview } from "@/components/semantic-review"

const RISK_COLORS: Record<string, string> = {
  READ_LIKE: "text-blue-600 bg-blue-500/10",
  WRITE: "text-amber-600 bg-amber-500/10",
  DESTRUCTIVE: "text-red-600 bg-red-500/10",
  UNKNOWN: "text-gray-600 bg-gray-500/10"
}

function isSupportedScheme(scheme: ApiSecurityScheme) {
  return (scheme.type === "apiKey" && (scheme.location === "header" || scheme.location === "query")) ||
    (scheme.type === "http" && scheme.bearer && scheme.location === "header")
}

export default function OperationDetailPage() {
  const { workspaceId, apiId, operationId } = useParams()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data: api, isLoading: apiLoading } = useGetApi(workspaceId || "", apiId || "")
  const { data: op, isLoading: opLoading } = useGetOperation(workspaceId || "", apiId || "", operationId || "")
  const { data: credentials } = useListCredentials(workspaceId || "", apiId || "")
  const updateState = useUpdateOperationState()

  const handleToggleState = (enabled: boolean) => {
    if (!workspaceId || !apiId || !operationId) return
    updateState.mutate(
      { workspaceId, apiId, operationId, data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetOperationQueryKey(workspaceId, apiId, operationId) })
          queryClient.invalidateQueries({ queryKey: getListOperationsQueryKey(workspaceId, apiId) })
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceOverviewQueryKey(workspaceId) })
          toast({ 
            title: enabled ? "Operation enabled" : "Operation disabled",
            description: enabled
              ? "Catalog state updated. MCP execution is limited to explicitly approved HTTPS GET operations with no request body and a compatible API key or Bearer credential when required."
              : "Catalog state updated. This operation is not listed or callable through MCP."
          })
        },
        onError: (err) => {
          toast({ title: "Failed to update state", description: err.message || "Unknown error", variant: "destructive" })
        }
      }
    )
  }

  if (!workspaceId || !apiId || !operationId) return null

  if (apiLoading || opLoading) {
    return <div className="space-y-6"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>
  }

  if (!op || !api) {
    return <div className="text-destructive">Operation not found.</div>
  }

  const anonymous = op.securityGroups.some((group) => group.length === 0) || op.securityGroups.length === 0
  const supportedCredentialGroup = op.securityGroups.some((group) => group.length > 0 && group.every((requirement) => {
    const scheme = api.api.latestSpecification?.securitySchemes.find((item) => item.name === requirement.scheme)
    return Boolean(scheme && isSupportedScheme(scheme))
  }))
  const configuredCredentialGroup = op.securityGroups.some((group) => group.length > 0 && group.every((requirement) => {
    const scheme = api.api.latestSpecification?.securitySchemes.find((item) => item.name === requirement.scheme)
    return Boolean(scheme && isSupportedScheme(scheme) && credentials?.some((credential) => credential.schemeName === scheme.name && credential.status === "ACTIVE"))
  }))
  const credentialRequired = !anonymous && supportedCredentialGroup
  const unsupportedReasons = [
    op.method !== "GET" ? "Non-GET method" : null,
    !anonymous && !supportedCredentialGroup ? "Unsupported authentication" : null,
    op.requestBody ? "Request body declared" : null,
  ].filter((reason): reason is string => Boolean(reason))
  const executionSupported = unsupportedReasons.length === 0 && (anonymous || configuredCredentialGroup)
  const catalogStateDescription = !op.enabled
    ? "Disabled. Not listed or callable through MCP."
    : executionSupported
      ? `Enabled. ${credentialRequired ? "Credential-backed" : "Unauthenticated"} execution requires explicit approval and an HTTPS server.`
      : credentialRequired && !configuredCredentialGroup
        ? "Enabled in the catalog, but a compatible credential is missing or revoked."
        : `Enabled in the catalog, but unsupported for execution: ${unsupportedReasons.join(", ")}.`

  return (
    <div className="space-y-6 animate-in fade-in duration-300 pb-20">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link href="/">Workspaces</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/workspaces/${workspaceId}`} className="font-mono">...{workspaceId.slice(-8)}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/workspaces/${workspaceId}/apis/${apiId}`}>{api.api.name}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono text-xs">{op.method} {op.path}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="font-mono text-sm uppercase px-2 py-1">{op.method}</Badge>
            <h1 className="text-xl font-bold tracking-tight font-mono break-all">{op.path}</h1>
          </div>
          {op.summary && <p className="text-lg font-medium">{op.summary}</p>}
          {op.description && <p className="text-sm text-muted-foreground">{op.description}</p>}
          <div className="flex flex-wrap gap-2 pt-2">
            {op.tags.map(tag => (
              <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
            ))}
          </div>
        </div>

        <Card className={`w-full lg:w-80 shrink-0 border-2 shadow-md ${op.enabled ? "border-emerald-500/50 bg-emerald-500/5" : "border-muted bg-muted/20"}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wider flex items-center justify-between">
               Catalog state
              {op.enabled ? <Unlock className="w-4 h-4 text-emerald-600" /> : <Lock className="w-4 h-4 text-muted-foreground" />}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <span className={`text-2xl font-bold uppercase tracking-widest ${op.enabled ? "text-emerald-600" : "text-muted-foreground"}`}>
                 {op.enabled ? "Enabled" : "Disabled"}
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                {catalogStateDescription}
              </p>
            </div>
            {api.canManage ? (
              <Button
                className="w-full font-bold shadow-sm"
                variant={op.enabled ? "destructive" : "default"}
                onClick={() => handleToggleState(!op.enabled)}
                disabled={updateState.isPending}
              >
                {updateState.isPending
                  ? "Updating..."
                  : op.enabled ? "Disable operation" : "Enable operation"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Operation approval is managed by workspace owners.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <SemanticReview workspaceId={workspaceId} apiId={apiId} operation={op} canManage={api.canManage} />

      <div className="grid gap-6 md:grid-cols-4 mt-8">
        <Card className="col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs uppercase tracking-wider flex items-center text-muted-foreground">
              <Activity className="w-4 h-4 mr-2" /> Risk class
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className={`inline-flex px-3 py-1 text-sm font-bold font-mono rounded-md ${RISK_COLORS[op.risk]}`}>
              {op.risk}
            </span>
            {!executionSupported && (
              <div className="mt-4 text-xs flex text-amber-200 bg-amber-500/10 p-2 rounded border border-amber-500/30">
                <AlertTriangle className="w-3 h-3 mr-1 mt-0.5 shrink-0" />
                <span>Unsupported for execution: {unsupportedReasons.join(", ")}.</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1 md:col-span-3">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-xs uppercase tracking-wider flex items-center text-muted-foreground">
              <Shield className="w-4 h-4 mr-2" /> Credentials
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
             {anonymous ? (
              <div className="text-sm flex items-center text-emerald-300">
                 <Shield className="w-4 h-4 mr-2" /> Unauthenticated operation
              </div>
            ) : (
              <div className="space-y-3">
                 <p className={`text-sm ${credentialRequired && configuredCredentialGroup ? "text-emerald-300" : "text-amber-200"}`}>
                   {credentialRequired
                     ? configuredCredentialGroup ? "Credential configured for execution." : "Credential required before this operation can be exposed."
                     : "Authentication scheme is unsupported for execution."}
                 </p>
                <div className="flex flex-wrap gap-2">
                 {op.securityGroups.flatMap((group) => group).map((req, i) => (
                  <Badge key={i} variant="outline" className="font-mono text-xs py-1 border-primary/30 text-primary bg-primary/5">
                     <Key className="w-3 h-3 mr-1" /> {req.scheme}
                  </Badge>
                ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="parameters" className="mt-8">
        <TabsList className="grid w-full grid-cols-3 max-w-md bg-muted">
          <TabsTrigger value="parameters">Parameters ({op.parameters.length})</TabsTrigger>
          <TabsTrigger value="body">Request body</TabsTrigger>
          <TabsTrigger value="responses">Responses ({op.responses.length})</TabsTrigger>
        </TabsList>
        
        <TabsContent value="parameters" className="border rounded-md mt-4 bg-card">
          {!op.parameters.length ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No parameters defined.</div>
          ) : (
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead className="w-[100px]">Loc</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Schema</TableHead>
                  <TableHead className="w-[80px] text-center">Required</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {op.parameters.map((param, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px] uppercase">{param.location}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{param.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{param.schemaType || "any"}</TableCell>
                    <TableCell className="text-center">
                      {param.required && <span className="text-red-500 font-bold">*</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        
        <TabsContent value="body" className="border rounded-md mt-4 bg-card p-6">
          {!op.requestBody ? (
            <div className="text-center text-muted-foreground text-sm flex flex-col items-center">
              <Box className="w-8 h-8 mb-2 opacity-20" />
              No request body expected.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                <AlertTriangle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
                Request bodies are unsupported for execution in the current milestone.
              </div>
              <div className="flex items-center">
                <span className="font-bold text-sm mr-2">Required:</span>
                {op.requestBody.required ? <Badge variant="destructive">Yes</Badge> : <Badge variant="secondary">No</Badge>}
              </div>
              <div>
                <span className="font-bold text-sm block mb-2">Accepted Content Types:</span>
                <div className="flex flex-wrap gap-2">
                  {op.requestBody.contentTypes.map(ct => (
                    <Badge key={ct} variant="outline" className="font-mono">{ct}</Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="responses" className="border rounded-md mt-4 bg-card">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="w-[100px]">Code</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Content Types</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {op.responses.map((resp, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono font-bold text-xs">{resp.statusCode}</TableCell>
                  <TableCell className="text-sm">{resp.description || "-"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {resp.contentTypes.map(ct => (
                        <span key={ct} className="text-[10px] font-mono bg-muted px-1.5 rounded">{ct}</span>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </div>
  )
}
